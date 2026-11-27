"""真实 TCP/WebSocket、十端并发、重连与持久化边界；不模拟物理无线。"""
import asyncio
import json
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from aiohttp import ClientSession, WSMsgType, web

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "host"))
from server import MAX_DEADLINE_MS, Store, VotingService, clock_ms


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "votes.sqlite3"
        self.store = Store(self.path)

    def tearDown(self):
        self.store.db.close()
        self.tmp.cleanup()

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
                self.assertEqual((store.join_code, store.host_id), ("001234", "0123456789abcdef"))
            finally:
                store.db.close()


class NetworkTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "votes.sqlite3"
        self.service = VotingService(self.path, discovery_port=0)
        await self.start_server()
        self.session = ClientSession()
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

    async def receive_until(self, ws, predicate):
        for _ in range(40):
            data = await ws.receive_json(timeout=3)
            if predicate(data): return data
        self.fail("未收到目标消息")

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
        out.write_text("".join(json.dumps(d, ensure_ascii=False) + "\n" for d in packets))

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
        out.write_text("".join(json.dumps(d, ensure_ascii=False, separators=(",", ":")) + "\n" for d in transcript))

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
            self.assertEqual(state["history_count"], 2)
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
            history = (await response.json())["polls"]
            self.assertEqual([item["title"] for item in history], ["第二题", "第一题"])
            self.assertEqual(history[1]["counts"], [1, 0])
            self.assertEqual(history[1]["total"], 1)


if __name__ == "__main__": unittest.main(verbosity=2)
