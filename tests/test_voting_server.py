"""真实 TCP/WebSocket、十端并发、重连与持久化边界；不模拟物理无线。"""
import asyncio
import csv
import io
import json
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from aiohttp import ClientSession, TCPConnector, WSMsgType, web

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "host"))
from server import DEFAULT_DEVICE_LIMIT, MAX_BATCH_POLLS, MAX_DEADLINE_MS, MAX_DEVICE_LIMIT, Store, VotingService, clock_ms


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "votes.sqlite3"
        self.store = Store(self.path)

    def tearDown(self):
        self.store.db.close()
        self.tmp.cleanup()

    def test_device_limit_persists_and_protects_registrations(self):
        self.assertEqual(self.store.device_limit(), DEFAULT_DEVICE_LIMIT)
        first, second, third = ("aabbcc000001", "aabbcc000002", "aabbcc000003")
        self.store.register(first)
        self.store.set_device_limit(1)
        with self.assertRaisesRegex(ValueError, "设备已满"):
            self.store.register(second)
        self.store.register(first)
        self.store.set_device_limit(2)
        self.store.register(second)
        for invalid in (None, True, "2", 1.5, 0, MAX_DEVICE_LIMIT + 1):
            with self.assertRaisesRegex(ValueError, "整数"):
                self.store.set_device_limit(invalid)
        with self.assertRaisesRegex(ValueError, "2 台设备登记"):
            self.store.set_device_limit(1)
        code = self.store.join_code
        self.store.db.close()
        self.store = Store(self.path)
        self.assertEqual((self.store.device_limit(), self.store.join_code), (2, code))
        self.store.register(second)
        with self.assertRaisesRegex(ValueError, "设备已满"):
            self.store.register(third)

    def test_library_revisions_and_saved_vote_content(self):
        question = dict(id="a000000000000020", title="哪一项是水果", options=["苹果", "白菜"], mode="quiz", correct_choice=0)
        self.assertEqual(self.store.library_questions(), [])
        self.store.save_library_question(question)
        self.store.save_library_question(question)
        [original] = self.store.library_questions()
        self.assertEqual(original["revision"], 1)
        self.store.create(original)
        poll = self.store.current()["id"]
        self.store.vote("a", poll, 0)
        self.store.transition(poll, "published")
        edited = {**original, "title": "哪一项是蔬菜", "correct_choice": 1}
        self.store.save_library_question(edited)
        self.store.save_library_question(edited)
        with self.assertRaisesRegex(ValueError, "新版本"):
            self.store.save_library_question({**original, "title": "其他问题"})
        with self.assertRaisesRegex(ValueError, "有效"):
            self.store.save_library_question({**edited, "correct_choice": 2})
        self.store.db.close()
        self.store = Store(self.path)
        self.assertEqual(self.store.library_questions(), [{**edited, "revision": 2}])
        [result] = self.store.report(poll)["questions"]
        self.assertEqual((result["title"], result["correct_choice"], result["counts"]), (original["title"], 0, [1, 0]))

    def test_persistence_and_first_vote(self):
        self.store.register("aabbcc000001")
        self.store.create(dict(title="周末去哪里？", options=["公园", "博物馆"]))
        poll_id = self.store.current()["id"]
        self.store.vote("aabbcc000001", poll_id, 1)
        self.store.vote("aabbcc000001", poll_id, 1)
        with self.assertRaises(ValueError): self.store.vote("aabbcc000001", poll_id, 0)
        self.assertNotIn("counts", self.store.snapshot("aabbcc000001")["poll"])
        self.store.db.close(); self.store = Store(self.path)
        self.assertEqual(self.store.snapshot("aabbcc000001")["poll"]["my_choice"], 1)
        self.store.transition(poll_id, "closed")
        self.store.vote("aabbcc000001", poll_id, 1)
        with self.assertRaises(ValueError): self.store.vote("aabbcc000002", poll_id, 0)
        self.store.transition(poll_id, "published")
        self.assertEqual(self.store.snapshot("aabbcc000001")["poll"]["counts"], [0, 1])
        self.store.create(dict(title="下一题", options=["是", "否"]))
        with self.assertRaises(ValueError): self.store.vote("aabbcc000001", poll_id, 0)
        self.assertEqual(self.store.snapshot()["poll"]["total"], 0)

    def test_bad_inputs_and_zero_results(self):
        for data in [dict(title="😀", options=["a", "b"]), dict(title="题", options=["a"]),
                     dict(title="题", options=["a", "a"]), dict(title="题"*61, options=["a", "b"]),
                     dict(title="题", options=["a"*25, "b"]), dict(title="\x00", options=["a", "b"])]:
            with self.assertRaises(ValueError): self.store.create(data)
        self.store.create(dict(title="题", options=["a", "b"]))
        poll = self.store.current()["id"]
        for choice in [True, 0.5, -1, 2, "0", None]:
            with self.assertRaises(ValueError): self.store.vote("aabbcc000001", poll, choice)
        with self.assertRaises(ValueError): self.store.create(dict(title="题2", options=["a", "b"]))
        with self.assertRaises(ValueError): self.store.transition("old", "closed")
        self.store.transition(poll, "published")
        self.assertEqual(self.store.snapshot()["poll"]["counts"], [0,0])

    @patch("server.clock_ms")
    def test_exact_deadline_late_retry_and_private_results(self, clock):
        clock.return_value = 1_800_000_000_000
        self.store.create(dict(title="截止测试", options=["是", "否"], duration_seconds=30))
        first = self.store.snapshot("a")["poll"]
        poll_id, deadline = first["id"], first["deadline_at_ms"]
        self.assertEqual(first["remaining_ms"], 30000)
        self.assertEqual(deadline, clock.return_value + 30000)
        clock.return_value = deadline - 1
        self.store.vote("a", poll_id, 1)
        self.assertEqual(self.store.snapshot("a")["poll"]["remaining_ms"], 1)
        clock.return_value = deadline
        with self.assertRaisesRegex(ValueError, "截止"):
            self.store.vote("b", poll_id, 0)
        # 迟到请求自己触发落库，之后即使电脑时钟向后调整也不能重开。
        self.assertEqual(self.store.db.execute("SELECT phase FROM polls").fetchone()[0], "closed")
        clock.return_value -= 1000
        self.store.vote("a", poll_id, 1)
        with self.assertRaisesRegex(ValueError, "锁定"):
            self.store.vote("a", poll_id, 0)
        with self.assertRaisesRegex(ValueError, "截止"):
            self.store.change_deadline(dict(poll_id=poll_id, duration_seconds=60))
        closed = self.store.snapshot("a")["poll"]
        self.assertEqual((closed["phase"], closed["my_choice"]), ("closed", 1))
        for key in ("remaining_ms", "counts", "total"):
            self.assertNotIn(key, closed)
        self.store.transition(poll_id, "published")
        self.assertEqual(self.store.snapshot("a")["poll"]["counts"], [0, 1])

    @patch("server.clock_ms", return_value=1_800_000_000_000)
    def test_reports_cover_every_end_and_survive_restart(self, clock):
        body = dict(title="活动", options=["赞成", "反对"])
        self.store.create_batch(dict(questions=[body, dict(title="日期", options=["周六","周日"])]))
        first, second = [p["id"] for p in self.store.snapshot()["batch"]["polls"]]
        self.store.vote("甲", first, 1)
        self.store.vote("乙", first, 0)
        self.store.vote("甲", second, 1)
        self.assertEqual(self.store.history()["reports"], [])
        clock.return_value += 1200
        self.store.db.execute("CREATE TRIGGER fail_report BEFORE INSERT ON poll_reports BEGIN SELECT RAISE(ABORT,'测试失败'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.store.transition(first, "closed")
        self.assertEqual(self.store.current()["phase"], "open")
        self.store.db.execute("DROP TRIGGER fail_report")
        self.store.transition(first, "closed")
        saved = self.store.report(first)
        self.assertEqual((saved["participants"], saved["total_votes"], saved["ended_at_ms"]), (2, 3, clock.return_value))
        self.assertEqual([q["counts"] for q in saved["questions"]], [[1,1], [0,1]])
        self.assertNotIn("counts", self.store.snapshot("甲")["poll"])
        self.store.vote("甲", first, 1)
        clock.return_value += 8000
        self.store.transition(first, "published")
        self.store.transition(first, "published")
        self.assertEqual(self.store.report(first), saved)
        self.store.create(dict(**body, duration_seconds=3))
        timed = self.store.current()
        clock.return_value += 15000
        self.store.db.close()
        self.store = Store(self.path)
        self.assertEqual(self.store.current()["phase"], "closed")
        self.assertEqual(self.store.report(timed["id"])["ended_at_ms"], timed["deadline_at_ms"])
        self.assertEqual(self.store.report(timed["id"])["total_votes"], 0)
        self.store.transition(timed["id"], "published")
        self.store.create(body)
        direct = self.store.current()["id"]
        self.store.transition(direct, "published")
        self.assertEqual(self.store.report(direct)["ended_at_ms"], clock.return_value)
        self.assertEqual([r["id"] for r in self.store.history()["reports"]], [direct, timed["id"], first])
        self.assertEqual(self.store.report(first), saved)

    def test_backfill_and_history_pagination(self):
        for i in range(22):
            self.store.create(dict(title=f"旧题{i}", options=["甲", "乙"]))
            self.store.transition(self.store.current()["id"], "published")
        self.store.create(dict(title="仍在收票", options=["甲", "乙"]))
        self.store.db.execute("DROP TABLE poll_reports")
        for _ in range(2):
            self.store.db.close()
            self.store = Store(self.path)
            recent = self.store.history()
            self.assertEqual([r["title"] for r in recent["reports"]], [f"旧题{i}" for i in range(21,1,-1)])
            older = self.store.history(recent["next_before"])
            self.assertEqual([r["title"] for r in older["reports"]], ["旧题1", "旧题0"])
            self.assertIsNone(older["next_before"])
            self.assertIsNone(recent["reports"][0]["ended_at_ms"])
            self.assertIsNone(self.store.report(self.store.current()["id"]))

    def test_deleted_reports_stay_deleted_after_restart(self):
        self.store.create(dict(title="保留记录", options=["是", "否"]))
        kept = self.store.current()["id"]
        self.store.transition(kept, "published")
        self.store.create(dict(title="删除归档测试", options=["甲", "乙"]))
        current = self.store.current()["id"]
        self.store.vote("a", current, 1)
        with self.assertRaisesRegex(ValueError, "找不到"):
            self.store.delete_report(current)
        self.store.transition(current, "closed")
        self.store.delete_report(current)
        self.store.delete_report(current)
        self.assertIsNone(self.store.report(current))
        self.assertEqual(self.store.current()["phase"], "closed")
        self.store.transition(current, "published")
        self.assertEqual(self.store.snapshot("a")["poll"]["counts"], [0, 1])
        self.store.db.close()
        self.store = Store(self.path)
        self.assertIsNone(self.store.report(current))
        self.assertEqual([report["id"] for report in self.store.history()["reports"]], [kept])
        self.assertEqual(self.store.current()["id"], current)
        self.assertEqual(self.store.snapshot("a")["poll"]["my_choice"], 1)

    @patch("server.clock_ms", return_value=1_800_000_000_000)
    def test_append_limit_retry_deadline_and_closed_history(self, clock):
        original = dict(title="原题", options=["甲", "乙"])
        self.store.create_batch(dict(questions=[original] * (MAX_BATCH_POLLS - 1), duration_seconds=10))
        batch = self.store.current()
        added = dict(batch_id=batch["id"], question_id="a000000000000001", title="临时题", options=["是", "否"])
        for invalid in (dict(question_id=None), dict(title="😀"), dict(options=["是","是"]), dict(batch_id="其他场次")):
            with self.assertRaises(ValueError):
                self.store.append_question({**added, **invalid})
        self.store.append_question(added)
        self.store.append_question(added)
        polls = self.store.snapshot()["batch"]["polls"]
        self.assertEqual(len(polls), MAX_BATCH_POLLS)
        self.assertEqual((polls[-1]["id"], polls[-1]["deadline_at_ms"]), (added["question_id"], batch["deadline_at_ms"]))
        other = {**added, "question_id": "a000000000000002"}
        with self.assertRaisesRegex(ValueError, "上限"):
            self.store.append_question(other)
        with self.assertRaisesRegex(ValueError, "题号"):
            self.store.append_question({**added, "title":"另一个题目"})
        clock.return_value = batch["deadline_at_ms"]
        with self.assertRaisesRegex(ValueError, "结束"):
            self.store.append_question(other)
        report = self.store.report(batch["id"])
        self.assertEqual((report["question_count"], report["ended_at_ms"]), (MAX_BATCH_POLLS, clock.return_value))
        self.store.append_question(added)
        self.store.transition(batch["id"], "published")
        with self.assertRaisesRegex(ValueError, "结束"):
            self.store.append_question(other)
        self.store.create(original)
        with self.assertRaisesRegex(ValueError, "场次"):
            self.store.append_question(added)
        self.assertEqual(self.store.report(batch["id"]), report)

    @patch("server.clock_ms", return_value=1_800_000_000_000)
    def test_edit_cancel_manual_and_invalid_deadlines(self, clock):
        now = clock.return_value
        data = dict(title="选时间", options=["是", "否"])
        for fields in [dict(deadline_at_ms=v) for v in (True, "12", now, now-1, now+0.5, MAX_DEADLINE_MS+1)] + [
                dict(duration_seconds=v) for v in (None, False, 0, -3, "30", 0.5, MAX_DEADLINE_MS)] + [
                dict(duration_seconds=5, deadline_at_ms=None)]:
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                self.store.create({**data, **fields})
        self.store.create(data)
        poll = self.store.snapshot()["poll"]
        poll_id = poll["id"]
        self.assertNotIn("deadline_at_ms", poll)
        self.store.change_deadline(dict(poll_id=poll_id, deadline_at_ms=now+2000))
        with self.assertRaises(ValueError):
            self.store.change_deadline(dict(poll_id="old", deadline_at_ms=None))
        with self.assertRaises(ValueError):
            self.store.change_deadline(dict(poll_id=poll_id))
        self.store.change_deadline(dict(poll_id=poll_id, duration_seconds=90))
        clock.return_value += 3000
        self.assertEqual(self.store.snapshot()["poll"]["remaining_ms"], 87000)
        self.store.change_deadline(dict(poll_id=poll_id, deadline_at_ms=None))
        clock.return_value += 100000
        self.store.vote("a", poll_id, 0)
        self.assertNotIn("remaining_ms", self.store.snapshot("a")["poll"])
        self.store.change_deadline(dict(poll_id=poll_id, duration_seconds=30))
        self.store.transition(poll_id, "closed")
        self.assertEqual(self.store.snapshot()["poll"]["phase"], "closed")

    def test_migrate_existing_database(self):
        path = self.path.with_name("existing.sqlite3")
        db = sqlite3.connect(path)
        db.executescript("""
            CREATE TABLE polls (id TEXT PRIMARY KEY, title TEXT NOT NULL, options TEXT NOT NULL,
                                phase TEXT NOT NULL, created REAL NOT NULL);
            CREATE TABLE votes (poll_id TEXT NOT NULL, device_id TEXT NOT NULL, choice INTEGER NOT NULL,
                                created REAL NOT NULL, PRIMARY KEY (poll_id, device_id));
            CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO polls VALUES ('0123456789abcdef', '旧题', '["是","否"]', 'open', 1);
            INSERT INTO votes VALUES ('0123456789abcdef', 'a', 0, 2);
            INSERT INTO settings VALUES ('join_code', '001234'), ('host_id', '0123456789abcdef');
        """)
        db.close()
        for _ in range(2):
            store = Store(path)
            try:
                poll = store.snapshot("a")["poll"]
                self.assertEqual((poll["title"], poll["phase"], poll["my_choice"]), ("旧题", "open", 0))
                self.assertNotIn("deadline_at_ms", poll)
                migrated = store.snapshot()["poll"]
                self.assertEqual((migrated["mode"], migrated["correct_choice"], migrated["counts"]), ("single", None, [1, 0]))
                self.assertEqual((store.join_code, store.host_id), ("001234", "0123456789abcdef"))
            finally:
                store.db.close()

    def test_mode_validation_and_abstentions(self):
        quiz = dict(title="哪项正确", options=["甲", "乙"], mode="quiz")
        for invalid in (dict(mode="unknown"), dict(mode=[]), dict(), dict(correct_choice=True),
                        dict(correct_choice=-1), dict(correct_choice=2), dict(correct_choice="1")):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                self.store.create({**quiz, **invalid})
        self.assertIsNone(self.store.current())
        self.store.create(dict(title="是否通过", mode="approval", options=["甲", "乙"]))
        poll = self.store.snapshot()["poll"]
        self.assertEqual(poll["options"], ["赞成", "反对", "弃权"])
        self.store.vote("a", poll["id"], 2)
        abstentions = self.store.snapshot()["poll"]["mode_summary"]
        self.assertEqual(abstentions, dict(yes=0, no=0, abstain=1, approval_pct=None, passed=None))
        self.store.vote("b", poll["id"], 0)
        self.store.vote("c", poll["id"], 1)
        tied = self.store.snapshot()["poll"]["mode_summary"]
        self.assertEqual(tied, dict(yes=1, no=1, abstain=1, approval_pct=50.0, passed=False))
        self.store.transition(poll["id"], "closed")
        self.assertEqual(self.store.report(poll["id"])["questions"][0]["mode_summary"], tied)

    def test_mode_metadata_for_legacy_report(self):
        self.store.create(dict(title="旧版场次", options=["甲", "乙"]))
        poll = self.store.current()["id"]
        self.store.vote("a", poll, 1)
        self.store.transition(poll, "published")
        legacy = json.dumps([dict(id=poll, title="旧版场次", options=["甲", "乙"], counts=[0,1], total=1)])
        with self.store.db:
            self.store.db.execute("UPDATE poll_reports SET questions=? WHERE batch_id=?", (legacy, poll))
        question = self.store.report(poll)["questions"][0]
        self.assertEqual((question["mode"], question["correct_choice"], question["mode_summary"]), ("single", None, {}))
        self.assertEqual(question["counts"], [0,1])

    @patch("server.clock_ms", return_value=1_800_000_000_000)
    def test_batch_atomicity_deadline_and_first_vote(self, clock):
        questions = [dict(title=f"第{i}题", options=["是", "否"]) for i in range(1, 4)]
        self.store.create(questions[0])
        previous = self.store.current()["id"]
        self.store.transition(previous, "published")
        for group in ([], questions[:1], questions * 17, [questions[0], {"title":"坏题","options":["重复","重复"]}]):
            with self.assertRaises(ValueError):
                self.store.create_batch(dict(questions=group))
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM polls").fetchone()[0], 1)
        self.store.db.execute("CREATE TRIGGER fail_batch BEFORE INSERT ON polls WHEN NEW.title='第2题' "
                              "BEGIN SELECT RAISE(ABORT,'测试写入失败'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.store.create_batch(dict(questions=questions))
        self.assertEqual(self.store.current()["id"], previous)
        self.store.db.execute("DROP TRIGGER fail_batch")
        body = dict(questions=questions, previous_id=previous, duration_seconds=30)
        self.store.create_batch(body)
        admin = self.store.snapshot()
        group = admin["batch"]
        ids = [q["id"] for q in group["polls"]]
        self.assertEqual([q["title"] for q in group["polls"]], [q["title"] for q in questions])
        self.assertEqual(len(set(ids)), 3)
        self.assertEqual(ids[0],group["id"])
        self.assertTrue(all(q["remaining_ms"] == 30000 for q in group["polls"]))
        with self.assertRaises(ValueError): self.store.create_batch(body)
        self.store.vote("a", ids[0], 1)
        self.store.vote("a", ids[0], 1)
        with self.assertRaisesRegex(ValueError,"锁定"): self.store.vote("a", ids[0], 0)
        self.assertEqual(self.store.snapshot("a")["poll"]["id"], ids[1])
        self.assertEqual(self.store.snapshot("b")["poll"]["id"], ids[0])
        self.assertEqual(self.store.snapshot("b",ids[2])["poll"]["id"], ids[0])
        with self.assertRaisesRegex(ValueError,"上一题"): self.store.vote("b", ids[1], 0)
        self.store.change_deadline(dict(poll_id=ids[0], duration_seconds=90))
        self.store.db.close()
        self.store = Store(self.path)
        clock.return_value += 89999
        self.store.vote("a", ids[1], 0)
        self.assertTrue(all(q["remaining_ms"] == 1 for q in self.store.snapshot()["batch"]["polls"]))
        clock.return_value += 1
        with self.assertRaisesRegex(ValueError,"截止"): self.store.vote("b", ids[2], 1)
        self.store.vote("a", ids[0], 1)
        for q in self.store.snapshot()["batch"]["polls"]: self.assertEqual(q["phase"], "closed")
        for pid in ids:
            wire = self.store.snapshot("b",pid)
            self.assertNotIn("batch",wire)
            self.assertNotIn("counts",wire["poll"])
            self.assertNotIn("total",wire["poll"])
        self.store.transition(ids[0],"published")
        self.assertEqual([q["counts"] for q in self.store.snapshot()["batch"]["polls"]], [[0,1],[1,0],[0,0]])
        with self.assertRaisesRegex(ValueError,"变更"): self.store.create_batch(body)
        self.store.create(dict(title="新题", options=["是","否"]))
        with self.assertRaisesRegex(ValueError,"变更"): self.store.vote("a", ids[2], 0)

class NetworkTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "votes.sqlite3"
        self.service = VotingService(self.path, discovery_port=0)
        await self.start_server()
        self.session = ClientSession(connector=TCPConnector(limit=0))
        self.sockets = []

    async def start_server(self):
        self.runner = web.AppRunner(self.service.app())
        await self.runner.setup()
        self.site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await self.site.start()
        port = self.site._server.sockets[0].getsockname()[1]
        self.service.port = port
        self.base = f"http://127.0.0.1:{port}"

    async def asyncTearDown(self):
        await asyncio.gather(*(s.close() for s in self.sockets))
        await self.session.close()
        await self.runner.cleanup()
        self.tmp.cleanup()

    async def connect(self, index, code=None):
        ws = await self.session.ws_connect(self.base + "/ws")
        self.sockets.append(ws)
        await ws.send_json(dict(v=1, type="hello", device_id=f"aabbcc{index:06x}", code=code or self.service.store.join_code))
        return ws, await ws.receive_json(timeout=3)

    async def action(self, name, body):
        async with self.session.post(self.base + "/api/" + name, json=body,
                                    headers={"X-Host-Nonce":self.service.admin_nonce}) as response:
            data = await response.json()
            self.assertEqual(response.status, 200, data)
            return data

    async def receive_until(self, ws, predicate):
        for _ in range(40):
            data = await ws.receive_json(timeout=3)
            if predicate(data): return data
        self.fail("未收到目标消息")

    async def test_maximum_batch_fits_single_device_frame(self):
        ws, _ = await self.connect(0)
        question = dict(title="题" * 60, options=[str(i) + "字" * 23 for i in range(6)])
        await self.action("create_batch", {"questions": [question] * MAX_BATCH_POLLS})
        packet = await ws.receive_str(timeout=3)
        self.assertLess(len(packet.encode()), 2048)
        state = json.loads(packet)
        self.assertEqual(state["poll"]["batch"], {"index": 1, "count": MAX_BATCH_POLLS, "answered": 0})
        self.assertNotIn("batch", state)
        self.assertEqual(len(self.service.store.snapshot()["batch"]["polls"]), MAX_BATCH_POLLS)

    async def test_push_ready_voters_and_saved_csv(self):
        clients = [(await self.connect(i))[0] for i in range(10)]
        result = await self.action("create", dict(title="=选择", options=["甲,乙", "@是"]))
        self.assertEqual(result["pushed_to"], 10)
        packets = await asyncio.gather(*(ws.receive_json(timeout=2) for ws in clients))
        for packet in packets:
            self.assertEqual((packet["poll"]["phase"], packet["poll"]["title"], packet["poll"]["options"]),
                             ("open", "=选择", ["甲,乙", "@是"]))
        poll_id = packets[0]["poll"]["id"]
        url = self.base + "/api/history/" + poll_id
        async with self.session.get(url) as response:
            self.assertEqual(response.status, 404)
        await clients[0].send_json(dict(v=1, type="vote", poll_id=poll_id, choice=1))
        await self.receive_until(clients[0], lambda d: d["poll"]["my_choice"] == 1)
        await self.action("close", dict(poll_id=poll_id))
        async with self.session.get(self.base + "/api/history") as response:
            self.assertEqual((await response.json())["reports"][0]["id"], poll_id)
        async with self.session.get(url) as response:
            self.assertEqual((await response.json())["questions"][0]["counts"], [0,1])
        async with self.session.get(url + "/csv") as response:
            self.assertIn("attachment", response.headers["Content-Disposition"])
            rows = list(csv.reader(io.StringIO((await response.read()).decode("utf-8-sig"))))
        self.assertEqual(rows[1][5:11], ["'=选择","1","A","甲,乙","0","0.0%"])
        self.assertEqual(rows[2][5:11], ["'=选择","1","B","'@是","1","100.0%"])
        self.assertEqual(rows[0][11:], ["投票模式", "正确选项", "模式统计"])
        self.assertEqual(rows[1][11:], ["普通单选", "", ""])
        for path in ("/api/history", "/api/history/"+poll_id, "/api/history/"+poll_id+"/csv"):
            async with self.session.get(self.base+path, headers={"Host":"untrusted.example"}) as response:
                self.assertEqual(response.status, 403)

    async def test_mixed_modes_keep_hardware_protocol_and_persist_reports(self):
        voters = [(await self.connect(i))[0] for i in range(4)]
        await self.action("create_batch", dict(questions=[
            dict(title="地点", options=["公园", "车站"]),
            dict(title="是否通过", mode="approval"),
            dict(title="活动评分", mode="rating"),
        ]))
        anchor = self.service.store.current()["id"]
        quiz = dict(batch_id=anchor, question_id="a000000000000005", title="什么季节",
                    options=["夏天", "冬天"], mode="quiz", correct_choice=1)
        await self.action("append_question", quiz)
        await self.action("append_question", quiz)
        async with self.session.post(self.base + "/api/append_question", json={**quiz, "correct_choice":0},
                                     headers={"X-Host-Nonce":self.service.admin_nonce}) as response:
            self.assertEqual(response.status, 400)
        async with self.session.get(self.base + "/api/state") as response:
            admin = await response.json()
        self.assertTrue(admin["supports_modes"])
        polls = admin["batch"]["polls"]
        self.assertEqual([p["mode"] for p in polls], ["single", "approval", "rating", "quiz"])
        self.assertEqual([p["correct_choice"] for p in polls], [None, None, None, 1])
        self.assertEqual(polls[1]["options"], ["赞成", "反对", "弃权"])
        self.assertEqual(polls[2]["options"], [f"{i} 分" for i in range(1, 6)])
        self.assertIsNone(polls[2]["mode_summary"]["average"])
        self.assertIsNone(polls[3]["mode_summary"]["correct_pct"])
        choices = [(0,0,0,1), (1,0,2,1), (1,1,3,0), (1,2,4,0)]
        protocol_packets = []

        async def vote_round(ws, ballot):
            for question, choice in zip(polls, ballot):
                packet = await self.receive_until(ws, lambda m: m["type"] == "state"
                    and m["poll"]["id"] == question["id"] and m["poll"]["batch"]["count"] == 4)
                poll = packet["poll"]
                self.assertEqual(packet["v"], 1)
                self.assertEqual(poll["options"], question["options"])
                self.assertTrue({"mode", "correct_choice", "mode_summary", "counts", "total"}.isdisjoint(poll))
                if ws is voters[0]:
                    protocol_packets.append(packet)
                await ws.send_json(dict(v=1, type="vote", poll_id=question["id"], choice=choice))
            await self.receive_until(ws, lambda m: m["poll"]["batch"]["answered"] == 4)

        await asyncio.gather(*(vote_round(ws, ballot) for ws, ballot in zip(voters, choices)))
        await self.action("close", dict(poll_id=anchor))
        url = self.base + "/api/history/" + anchor
        async with self.session.get(url) as response:
            saved = await response.json()
        self.assertEqual((saved["participants"], saved["total_votes"], saved["question_count"]), (4,16,4))
        single, approval, rating, quiz_result = saved["questions"]
        self.assertEqual(single["counts"], [1,3])
        self.assertEqual(approval["counts"], [2,1,1])
        self.assertTrue(approval["mode_summary"]["passed"])
        self.assertAlmostEqual(approval["mode_summary"]["approval_pct"], 100 * 2/3, delta=0.05)
        self.assertEqual(rating["mode_summary"]["average"], 3.25)
        self.assertEqual(quiz_result["mode_summary"], dict(correct_count=2, correct_pct=50.0))
        self.assertEqual(quiz_result["correct_choice"], 1)
        async with self.session.get(url + "/csv") as response:
            rows = list(csv.DictReader(io.StringIO((await response.read()).decode("utf-8-sig"))))
        first_options = {row["题目"]:row for row in rows if row["选项编号"] == "A"}
        self.assertEqual(first_options["是否通过"]["投票模式"], "赞成 / 反对 / 弃权")
        self.assertIn("66.7%", first_options["是否通过"]["模式统计"])
        self.assertIn("3.25", first_options["活动评分"]["模式统计"])
        self.assertEqual(first_options["什么季节"]["正确选项"], "B")
        self.assertIn("50.0%", first_options["什么季节"]["模式统计"])
        await self.action("publish", dict(poll_id=anchor))
        await self.action("show_result", dict(batch_id=anchor, poll_id=quiz["question_id"]))
        packet = await self.receive_until(voters[0], lambda m: m["poll"]["id"] == quiz["question_id"]
                                          and m["poll"]["phase"] == "published")
        self.assertEqual(packet["poll"]["counts"], [2,2])
        self.assertTrue({"mode", "correct_choice", "mode_summary"}.isdisjoint(packet["poll"]))
        protocol_packets.append(packet)
        await asyncio.gather(*(ws.close() for ws in voters))
        await self.runner.cleanup()
        self.service = VotingService(self.path, discovery_port=0)
        await self.start_server()
        async with self.session.get(self.base + "/api/history/" + anchor) as response:
            self.assertEqual(await response.json(), saved)
        out = Path(__file__).resolve().parents[1] / "build" / "vote-modes-wire.jsonl"
        out.parent.mkdir(exist_ok=True)
        out.write_text("".join(json.dumps(packet, ensure_ascii=False) + "\n" for packet in protocol_packets), encoding="utf-8")

    async def test_append_during_voting_pushes_personal_next_question(self):
        fast, _ = await self.connect(0)
        slow, _ = await self.connect(1)
        await self.action("create", dict(title="集合地点", options=["学校", "广场"], duration_seconds=180))
        first = (await fast.receive_json(timeout=2))["poll"]["id"]
        await fast.send_json(dict(v=1, type="vote", poll_id=first, choice=0))
        await self.receive_until(fast, lambda msg: msg["poll"]["my_choice"] == 0)
        second = "a000000000000002"
        body = dict(batch_id=first, question_id=second, title="如何前往", options=["步行", "骑车"])
        replies = await asyncio.gather(self.action("append_question", body), self.action("append_question", body))
        self.assertTrue(all(r["pushed_to"] == 2 for r in replies))
        wire = []
        async def expect(ws, pid, answered, count):
            packet = await self.receive_until(ws, lambda m: m["type"] == "state" and m["poll"]["id"] == pid and
                        m["poll"].get("batch", {}).get("answered") == answered and m["poll"]["batch"]["count"] == count)
            self.assertNotIn("counts", packet["poll"])
            wire.append(packet)
        await expect(fast, second, 1, 2)
        await expect(slow, first, 0, 2)
        await fast.send_json(dict(v=1, type="vote", poll_id=second, choice=1))
        await expect(fast, second, 2, 2)
        third = "a000000000000003"
        await self.action("append_question", {**body, "question_id":third, "title":"一起用餐吗"})
        await expect(fast, third, 2, 3)
        await slow.send_json(dict(v=1, type="vote", poll_id=first, choice=1))
        await expect(slow, second, 1, 3)
        await asyncio.gather(*(s.close() for s in self.sockets))
        await self.runner.cleanup()
        self.service = VotingService(self.path, discovery_port=0)
        await self.start_server()
        _, resumed = await self.connect(1)
        self.assertEqual((resumed["poll"]["id"],resumed["poll"]["batch"]["answered"]), (second,1))
        wire.append(resumed)
        await self.action("close", dict(poll_id=first))
        report = self.service.store.report(first)
        self.assertEqual((report["participants"],report["total_votes"]), (2,3))
        self.assertEqual([q["counts"] for q in report["questions"]], [[1,1], [0,1], [0,0]])
        out = Path(__file__).resolve().parents[1] / "build" / "vote-append-wire.jsonl"
        out.parent.mkdir(exist_ok=True)
        out.write_text("".join(json.dumps(p, ensure_ascii=False) + "\n" for p in wire), encoding="utf-8")

    async def test_batch_independent_progress_reconnect_and_results(self):
        fast, _ = await self.connect(0)
        slow, _ = await self.connect(1)
        await self.action("create_batch",dict(questions=[
            dict(title=title,options=["是","否"]) for title in ("第一题","第二题","第三题")], duration_seconds=60))
        polls = self.service.store.snapshot()["batch"]["polls"]
        a,b,c = [q["id"] for q in polls]
        wire = []
        async def expect(ws, pid, count, phase="open"):
            packet = await self.receive_until(ws, lambda d: d["type"] == "state" and d["poll"]["id"] == pid
                                              and d["poll"]["phase"] == phase and d["poll"]["batch"]["answered"] == count)
            wire.append(packet)
            if phase != "published":
                self.assertNotIn("counts",packet["poll"])
                self.assertNotIn("total",packet["poll"])
            return packet["poll"]
        async def cast(ws, pid, choice):
            await ws.send_json(dict(v=1,type="vote",poll_id=pid,choice=choice))
        await expect(fast,a,0)
        await expect(slow,a,0)
        await cast(fast,a,1)
        async def wait_for_commit():
            while self.service.store.snapshot("aabbcc000000")["poll"]["id"] != b:
                await asyncio.sleep(.01)
        await asyncio.wait_for(wait_for_commit(), timeout=3)
        await slow.send_json(dict(v=1, type="sync"))
        await expect(slow,a,0)
        # 快设备未读取确认便断开；记录已落库，重连时直接拿到第二题。
        await fast.close()
        await asyncio.sleep(.03)
        fast, restored = await self.connect(0)
        self.assertEqual((restored["poll"]["id"],restored["poll"]["batch"]["answered"]), (b,1))
        wire.append(restored)
        await cast(fast,a,1)
        await expect(fast,b,1)
        await cast(fast,b,0)
        await expect(fast,c,2)
        await cast(fast,c,1)
        last = await expect(fast,c,3)
        self.assertEqual(last["my_choice"],1)
        await cast(slow,a,0)
        await expect(slow,b,1)
        async with self.session.get(self.base+"/api/state") as response:
            admin = await response.json()
        self.assertEqual([q["total"] for q in admin["batch"]["polls"]],[2,1,1])
        self.assertEqual([(d["answered"],d["voted"]) for d in admin["devices"]],[(3,True),(1,False)])
        await self.action("deadline",dict(poll_id=a,deadline_at_ms=clock_ms()+350))
        await expect(slow,b,1,"closed")
        await cast(slow,b,0)
        error = await self.receive_until(slow,lambda d:d["type"]=="error")
        self.assertIn("截止",error["message"])
        await self.action("publish",dict(poll_id=a))
        published = await expect(fast,a,3,"published")
        self.assertEqual(published["counts"],[1,1])
        await fast.send_json(dict(v=1,type="view",poll_id=published["batch"]["next"]))
        self.assertEqual((await expect(fast,b,3,"published"))["counts"],[1,0])
        # 公布后收到旧票重试，既不重复计数，也不打断本机正在翻看的结果。
        await cast(fast,a,1)
        self.assertEqual((await expect(fast,b,3,"published"))["counts"],[1,0])
        await self.action("show_result",dict(batch_id=a,poll_id=c))
        self.assertEqual((await expect(slow,c,1,"published"))["counts"],[0,1])
        await asyncio.gather(*(s.close() for s in self.sockets))
        await self.runner.cleanup()
        self.service = VotingService(self.path, discovery_port=0)
        await self.start_server()
        _, restored = await self.connect(1)
        self.assertEqual((restored["poll"]["id"],restored["poll"]["batch"]["answered"]), (c,1))
        wire.append(restored)
        out = Path(__file__).resolve().parents[1] / "build" / "vote-batch-wire.jsonl"
        out.parent.mkdir(exist_ok=True)
        out.write_text("".join(json.dumps(p,ensure_ascii=False,separators=(",",":"))+"\n" for p in wire), encoding="utf-8")

    async def test_ten_voters_complete_the_same_batch(self):
        clients = [(await self.connect(i))[0] for i in range(10)]
        await self.action("create_batch",dict(questions=[dict(title=f"题{i}",options=["是","否"]) for i in range(3)]))
        polls = self.service.store.snapshot()["batch"]["polls"]
        async def answer(index, ws):
            for i, poll in enumerate(polls):
                await self.receive_until(ws,lambda d: d["poll"]["id"] == poll["id"] and d["poll"]["batch"]["answered"] == i)
                await ws.send_json(dict(v=1,type="vote",poll_id=poll["id"],choice=(i+index)%2))
            await self.receive_until(ws,lambda d:d["poll"]["batch"]["answered"] == 3)
        await asyncio.gather(*(answer(i,ws) for i,ws in enumerate(clients)))
        self.assertEqual([q["counts"] for q in self.service.store.snapshot()["batch"]["polls"]],[[5,5]]*3)

    async def test_capacity_expands_during_voting_and_counts_200_voters(self):
        clients = [((await self.connect(i))[0], None) for i in range(DEFAULT_DEVICE_LIMIT)]
        questions = [dict(title=f"压力测试第{i + 1}题", options=["是","否"]) for i in range(3)]
        started = await self.action("create_batch", {"questions":questions})
        self.assertEqual(started["pushed_to"], DEFAULT_DEVICE_LIMIT)
        _, full = await self.connect(DEFAULT_DEVICE_LIMIT)
        self.assertIn("设备已满", full["message"])
        await self.action("device_limit", {"limit":MAX_DEVICE_LIMIT})
        clients.extend(await asyncio.gather(*(
            self.connect(i) for i in range(DEFAULT_DEVICE_LIMIT, MAX_DEVICE_LIMIT))))
        _, full = await self.connect(MAX_DEVICE_LIMIT)
        self.assertIn(f"{MAX_DEVICE_LIMIT} 台", full["message"])
        async with self.session.get(self.base + "/api/state") as response:
            live = await response.json()
        self.assertEqual(live["max_devices"], MAX_DEVICE_LIMIT)
        self.assertEqual(sum(d["online"] for d in live["devices"]), MAX_DEVICE_LIMIT)
        polls = live["batch"]["polls"]

        async def complete(index, ws, packet):
            if packet is None:
                packet = await ws.receive_json(timeout=10)
            for question in polls:
                self.assertEqual(packet["poll"]["id"], question["id"])
                await ws.send_json(dict(v=1, type="vote", poll_id=question["id"], choice=index % 2))
                packet = await ws.receive_json(timeout=10)
            self.assertEqual(packet["poll"]["batch"]["answered"], len(polls))

        await asyncio.gather(*(complete(i, ws, packet) for i, (ws, packet) in enumerate(clients)))
        poll_id = polls[0]["id"]
        await self.action("publish", {"poll_id":poll_id})
        results = await asyncio.gather(*(ws.receive_json(timeout=10) for ws, _ in clients))
        for packet in results:
            self.assertEqual(packet["poll"]["total"], MAX_DEVICE_LIMIT)
            self.assertEqual(packet["poll"]["counts"], [MAX_DEVICE_LIMIT // 2] * 2)
        report = self.service.store.report(poll_id)
        self.assertEqual((report["participants"], report["total_votes"]), (MAX_DEVICE_LIMIT, MAX_DEVICE_LIMIT * len(polls)))
        self.assertEqual([q["total"] for q in report["questions"]], [MAX_DEVICE_LIMIT] * len(polls))
        out = Path(__file__).resolve().parents[1] / "build" / "vote-capacity-wire.jsonl"
        out.parent.mkdir(exist_ok=True)
        out.write_text(json.dumps(results[0], ensure_ascii=False) + "\n", encoding="utf-8")

    async def test_idle_expiry_push_and_offline_voter(self):
        ws, _ = await self.connect(0)
        offline, _ = await self.connect(1)
        await self.action("create", dict(title="计时题", options=["是", "否"], duration_seconds=30))
        opened = (await ws.receive_json(timeout=3))["poll"]
        await offline.close()
        await ws.send_json(dict(v=1, type="vote", poll_id=opened["id"], choice=0))
        await self.receive_until(ws, lambda d: d["poll"]["my_choice"] == 0)
        await self.action("deadline", dict(poll_id=opened["id"], deadline_at_ms=clock_ms()+500))
        # 主持页面和设备均不再轮询，必须由主持服务主动推送截止。
        closed = (await self.receive_until(ws, lambda d: d["poll"]["phase"] == "closed"))["poll"]
        self.assertNotIn("counts", closed)
        self.assertEqual(closed["my_choice"], 0)
        back, restored = await self.connect(1)
        self.assertEqual(restored["poll"]["phase"], "closed")
        await back.send_json(dict(v=1, type="vote", poll_id=opened["id"], choice=1))
        error = await self.receive_until(back, lambda d: d["type"] == "error")
        self.assertIn("截止", error["message"])
        await self.action("publish", dict(poll_id=opened["id"]))
        result = await self.receive_until(back, lambda d: d["type"] == "state" and d["poll"]["phase"] == "published")
        self.assertEqual(result["poll"]["counts"], [1, 0])
        out = Path(__file__).resolve().parents[1] / "build" / "vote-timed-wire.jsonl"
        out.parent.mkdir(exist_ok=True)
        packets = [dict(v=1, type="state", poll=p) for p in (opened, closed)] + [restored, result]
        out.write_text("".join(json.dumps(d, ensure_ascii=False) + "\n" for d in packets), encoding="utf-8")

    async def test_rearm_cancel_and_restart_without_clients(self):
        await self.action("create", dict(title="延时题", options=["是", "否"], duration_seconds=60))
        poll = self.service.store.current()
        poll_id = poll["id"]
        short = clock_ms() + 400
        await self.action("deadline", dict(poll_id=poll_id, deadline_at_ms=short))
        await self.action("deadline", dict(poll_id=poll_id, duration_seconds=60))
        await asyncio.sleep(.45)
        self.assertEqual(self.service.store.snapshot()["poll"]["phase"], "open")
        await self.action("deadline", dict(poll_id=poll_id, deadline_at_ms=clock_ms()+400))
        await self.action("deadline", dict(poll_id=poll_id, deadline_at_ms=None))
        await asyncio.sleep(.45)
        self.assertEqual(self.service.store.snapshot()["poll"]["phase"], "open")
        deadline = clock_ms() + 60000
        await self.action("deadline", dict(poll_id=poll_id, deadline_at_ms=deadline))
        await self.runner.cleanup()
        self.service = VotingService(self.path, discovery_port=0)
        with patch("server.clock_ms", return_value=deadline-25000):
            await self.start_server()
            self.assertEqual(self.service.store.snapshot()["poll"]["remaining_ms"], 25000)
            await self.runner.cleanup()
        self.service = VotingService(self.path, discovery_port=0)
        with patch("server.clock_ms", return_value=deadline+1):
            await self.start_server()
            # 直接查看持久化状态，确保无客户端时启动也已经执行截止。
            self.assertEqual(self.service.store.db.execute("SELECT phase FROM polls").fetchone()[0], "closed")
        _, state = await self.connect(0)
        self.assertEqual(state["poll"]["phase"], "closed")
        self.assertNotIn("counts", state["poll"])

    async def test_ten_devices_reconnect_and_restart(self):
        clients = []
        transcript = []
        for i in range(10):
            ws, data = await self.connect(i)
            self.assertIsNone(data["poll"]); clients.append(ws); transcript.append(data)
        _, rejected = await self.connect(10)
        self.assertEqual(rejected["type"], "error")
        await self.action("create", dict(title="周末团建，你更想去哪里？", options=["森林公园", "历史博物馆", "海边露营", "城市骑行", "手工体验", "留在家里"]))
        states = [await ws.receive_json(timeout=3) for ws in clients]
        poll = states[0]["poll"]["id"]; transcript.extend(states)
        await asyncio.gather(*(ws.send_json(dict(v=1, type="vote", poll_id=poll, choice=i % 6)) for i, ws in enumerate(clients)))
        for i, ws in enumerate(clients):
            data = await self.receive_until(ws, lambda d: d.get("poll", {}).get("my_choice") == i % 6)
            self.assertNotIn("counts", data["poll"]); transcript.append(data)
        self.assertEqual(self.service.store.snapshot()["poll"]["total"], 10)
        await clients[0].send_json(dict(v=1, type="vote", poll_id=poll, choice=1))
        error = await self.receive_until(clients[0], lambda d: d["type"] == "error")
        self.assertIn("锁定", error["message"])
        self.assertEqual(self.service.store.snapshot()["poll"]["counts"], [2,2,2,2,1,1])
        await clients[0].close()
        await asyncio.sleep(.03)
        reconnected, state = await self.connect(0)
        self.assertEqual(state["poll"]["my_choice"], 0); transcript.append(state)
        await self.action("close", dict(poll_id=poll))
        await self.action("publish", dict(poll_id=poll))
        for ws in clients[1:] + [reconnected]:
            data = await self.receive_until(ws, lambda d: d.get("poll", {}).get("phase") == "published")
            self.assertEqual(data["poll"]["total"], 10); transcript.append(data)
        await asyncio.gather(*(s.close() for s in self.sockets))
        await self.runner.cleanup()
        self.service = VotingService(self.path, discovery_port=0)
        await self.start_server()
        _, restarted = await self.connect(0)
        self.assertEqual(restarted["poll"]["counts"], [2,2,2,2,1,1]); transcript.append(restarted)
        out = Path(__file__).resolve().parents[1] / "build" / "vote-wire.jsonl"
        out.parent.mkdir(exist_ok=True)
        out.write_text("".join(json.dumps(d, ensure_ascii=False, separators=(",", ":")) + "\n" for d in transcript), encoding="utf-8")

    async def test_authentication_and_admin_boundary(self):
        _, data = await self.connect(0, "invalid")
        self.assertEqual(data["type"], "error")
        first, _ = await self.connect(1)
        _, duplicate = await self.connect(1)
        self.assertEqual(duplicate["type"], "error")
        self.assertFalse(first.closed)
        for headers in [{}, {"X-Host-Nonce":self.service.admin_nonce, "Origin":"https://untrusted.example"}]:
            async with self.session.post(self.base + "/api/create", json={}, headers=headers) as response:
                self.assertEqual(response.status, 403)
        async with self.session.get(self.base + "/api/state", headers={"Host":"untrusted.example"}) as response:
            self.assertEqual(response.status, 403)
        async with self.session.get(self.base + "/api/history", headers={"Host":"untrusted.example"}) as response:
            self.assertEqual(response.status, 403)
        async with self.session.get(self.base + "/") as response:
            self.assertEqual(response.status, 200)
            self.assertIn("共选", await response.text())

    async def test_question_library_is_local_and_can_supply_append_drafts(self):
        ws, _ = await self.connect(0)
        saved = dict(id="a000000000000021", title="意见表决", mode="approval")
        async with self.session.get(self.base + "/api/question_library", headers={"Host": "untrusted.example"}) as response:
            self.assertEqual(response.status, 403)
        async with self.session.post(self.base + "/api/library_save", json=saved) as response:
            self.assertEqual(response.status, 403)
        await self.action("library_save", saved)
        self.assertIsNone(self.service.store.current())
        async with self.session.get(self.base + "/api/question_library") as response:
            [question] = (await response.json())["questions"]
        self.assertEqual(question["options"], ["赞成", "反对", "弃权"])
        await self.action("create", dict(title="现场问题", options=["甲", "乙"]))
        initial = (await ws.receive_json(timeout=3))["poll"]
        await self.action("append_question", {**question, "batch_id": initial["id"], "question_id": "a000000000000022"})
        await self.action("library_save", {**question, "title": "另一次表决"})
        await ws.send_json(dict(v=1, type="vote", poll_id=initial["id"], choice=0))
        next_question = await self.receive_until(ws, lambda d: d["poll"]["id"] == "a000000000000022")
        self.assertEqual(next_question["poll"]["title"], saved["title"])
        self.assertNotIn("revision", next_question["poll"])

    async def test_history_and_device_alias(self):
        ws0, _ = await self.connect(0)
        await self.action("create", dict(title="第一题", options=["赞成", "反对"]))
        p1 = self.service.store.current()["id"]
        await ws0.send_json(dict(v=1, type="vote", poll_id=p1, choice=0))
        await self.receive_until(ws0, lambda d: d["poll"]["my_choice"] == 0)
        await self.action("publish", dict(poll_id=p1))
        await self.action("create", dict(title="第二题", options=["甲", "乙", "丙"]))
        await self.action("alias", dict(device_id="aabbcc000000", alias="1号评委"))
        async with self.session.get(self.base + "/api/state") as response:
            state = await response.json()
            self.assertEqual(state["history_count"], 1)
            self.assertEqual(state["devices"][0]["alias"], "1号评委")
        await self.action("alias", dict(device_id="aabbcc000000", alias="   "))
        async with self.session.get(self.base + "/api/state") as response:
            state = await response.json()
            self.assertEqual(state["devices"][0]["alias"], "")
        async with self.session.post(
            self.base + "/api/alias",
            json=dict(device_id="aabbcc000000", alias="超长备注名" * 6),
            headers={"X-Host-Nonce": self.service.admin_nonce},
        ) as response:
            self.assertEqual(response.status, 400)
        async with self.session.get(self.base + "/api/history") as response:
            self.assertEqual(response.status, 200)
            reports = (await response.json())["reports"]
            self.assertEqual([item["title"] for item in reports], ["第一题"])
            self.assertEqual(reports[0]["total_votes"], 1)

    async def test_local_history_delete_removes_detail_and_download(self):
        await self.action("create", dict(title="删除测试", options=["是", "否"]))
        archived = self.service.store.current()["id"]
        await self.action("publish", {"poll_id": archived})
        await self.action("create", dict(title="正在收票", options=["甲", "乙"]))
        current = self.service.store.current()["id"]
        target = {"batch_id": archived}
        async with self.session.post(self.base + "/api/history_delete", json=target) as response:
            self.assertEqual(response.status, 403)
        await self.action("history_delete", target)
        async with self.session.get(self.base + "/api/history") as response:
            self.assertEqual((await response.json())["reports"], [])
        for suffix in ("", "/csv"):
            async with self.session.get(self.base + f"/api/history/{archived}{suffix}") as response:
                self.assertEqual(response.status, 404)
        self.assertEqual((self.service.store.current()["id"], self.service.store.current()["phase"]), (current, "open"))

    async def test_open_join_window_handshake_and_expiry(self):
        # 默认关闭：普通握手不暴露入场码，一键入场被拒绝。
        ws_normal, normal_state = await self.connect(0)
        self.assertNotIn("join_code", normal_state)
        await ws_normal.close()
        ws_closed = await self.session.ws_connect(self.base.replace("http", "ws") + "/ws")
        self.sockets.append(ws_closed)
        await ws_closed.send_json(dict(v=1, type="hello", device_id="aabbcc000001", open_join=True))
        rejected = await ws_closed.receive_json(timeout=3)
        self.assertEqual(rejected["type"], "error")
        self.assertIn("一键入场", rejected["message"])

        # 非法时长与跨站请求拒绝。
        async with self.session.post(self.base + "/api/open_join", json={"seconds": 60}) as response:
            self.assertEqual(response.status, 403)
        for bad in (-1, 5, 301, "60", True):
            async with self.session.post(
                self.base + "/api/open_join",
                json={"seconds": bad},
                headers={"X-Host-Nonce": self.service.admin_nonce},
            ) as response:
                self.assertEqual(response.status, 400)

        # 开启 60 秒窗口：免输码握手通过并下发当前 6 位入场码。
        await self.action("open_join", {"seconds": 60})
        async with self.session.get(self.base + "/api/state") as response:
            live = await response.json()
            self.assertTrue(live["supports_open_join"])
            self.assertGreater(live["open_join_remaining_ms"], 0)
            self.assertIsNotNone(live["open_join_until_ms"])

        ws_open = await self.session.ws_connect(self.base.replace("http", "ws") + "/ws")
        self.sockets.append(ws_open)
        await ws_open.send_json(dict(v=1, type="hello", device_id="aabbcc000002", open_join=True))
        welcomed = await ws_open.receive_json(timeout=3)
        self.assertEqual(welcomed["type"], "state")
        self.assertEqual(welcomed["join_code"], self.service.store.join_code)
        await ws_open.close()
        await asyncio.sleep(0.03)

        # 主动关闭后，一键入场再次被拒绝；但之前收到的入场码仍可正常重连。
        await self.action("open_join", {"seconds": 0})
        ws_rejoin, state_rejoin = await self.connect(2, welcomed["join_code"])
        self.assertEqual(state_rejoin["type"], "state")
        self.assertNotIn("join_code", state_rejoin)
        await ws_rejoin.close()

        ws_after = await self.session.ws_connect(self.base.replace("http", "ws") + "/ws")
        self.sockets.append(ws_after)
        await ws_after.send_json(dict(v=1, type="hello", device_id="aabbcc000003", open_join=True))
        denied = await ws_after.receive_json(timeout=3)
        self.assertEqual(denied["type"], "error")


if __name__ == "__main__": unittest.main(verbosity=2)
