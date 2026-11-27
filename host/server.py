"""同一局域网的投票主持服务：串行处理状态，SQLite 事务保证首次落票唯一。"""

from __future__ import annotations

import argparse
import asyncio
import csv
import io
import ipaddress
import json
import re
import secrets
import socket
import sqlite3
import sys
import time
from contextlib import contextmanager, suppress
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aiohttp import WSMsgType, web

ROOT = Path(__file__).resolve().parents[1]


def resolve_static_dir() -> Path:
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        bundled = Path(sys._MEIPASS) / "host" / "static"
        if bundled.is_dir():
            return bundled
    return ROOT / "host" / "static"


STATIC = resolve_static_dir()
DEFAULT_DEVICE_LIMIT = 10
MAX_DEVICE_LIMIT = 200
MAX_ALIAS_LENGTH = 20
MAX_MESSAGE = 4096
MAX_BATCH_POLLS = 50
MODE_LABELS = {"single": "普通单选", "approval": "赞成 / 反对 / 弃权", "rating": "五分评分", "quiz": "答题测验"}
FIXED_OPTIONS = {
    "approval": ["赞成", "反对", "弃权"],
    "rating": ["1 分", "2 分", "3 分", "4 分", "5 分"],
}
INSERT_OPEN_POLL = """INSERT INTO polls (id,title,options,mode,correct_choice,phase,created,deadline_at_ms,batch_id)
                      VALUES (?,?,?,?,?,'open',?,?,?)"""
MAX_DEADLINE_MS = 253402300799999  # 公历 9999 年末的 Unix 毫秒数。
OPEN_JOIN_DEFAULT_SECONDS = 300
OPEN_JOIN_MAX_SECONDS = 300
DISCOVERY_PORT = 48765
DISCOVERY_NETWORKS = tuple(map(ipaddress.IPv4Network, ("10.0.0.0/8", "172.16.0.0/12",
                                                       "192.168.0.0/16", "169.254.0.0/16", "127.0.0.0/8")))
FONT_POINTS = frozenset(
    cp
    for start, end in json.loads((STATIC / "font-coverage.json").read_text(encoding="utf-8"))["ranges"]
    for cp in range(start, end + 1)
)


def supported_text(text: object, maximum: int, name: str) -> str:
    if not isinstance(text, str):
        raise ValueError(f"{name}必须是文字")
    text = text.strip()
    if not 1 <= len(text) <= maximum:
        raise ValueError(f"{name}须为 1～{maximum} 个字符")
    missing = sorted({c for c in text if ord(c) not in FONT_POINTS})
    if missing:
        raise ValueError(f"投票器字库暂不支持：{''.join(missing[:12])}，请换成常用汉字或英文")
    return text


def clock_ms() -> int:
    return time.time_ns() // 1_000_000


def read_deadline(data: dict, now: int) -> int | None:
    if "duration_seconds" in data:
        duration = data["duration_seconds"]
        if "deadline_at_ms" in data or type(duration) is not int or duration <= 0:
            raise ValueError("请指定一种截止方式，时长须为正整数秒")
        deadline = now + duration * 1000
    else:
        deadline = data.get("deadline_at_ms")
    if deadline is not None and (type(deadline) is not int or not now < deadline <= MAX_DEADLINE_MS):
        raise ValueError("截止时间须晚于主持电脑的当前时间，且在有效日期范围内")
    return deadline


def read_question(data: dict) -> tuple[str, str, str, int | None]:
    if not isinstance(data, dict):
        raise ValueError("题目格式无效")
    title = supported_text(data.get("title"), 60, "题目")
    mode = data.get("mode", "single")
    if not isinstance(mode, str) or mode not in MODE_LABELS:
        raise ValueError("投票模式无效")
    options = FIXED_OPTIONS.get(mode)
    if options is None:
        raw = data.get("options")
        if not isinstance(raw, list) or not 2 <= len(raw) <= 6:
            raise ValueError("需要 2～6 个选项")
        options = [supported_text(option, 24, "选项") for option in raw]
        if len(set(options)) != len(options):
            raise ValueError("选项不能重复")
    correct_choice = data.get("correct_choice")
    if mode == "quiz":
        if type(correct_choice) is not int or not 0 <= correct_choice < len(options):
            raise ValueError("请为测验题选择有效的正确选项")
    else:
        correct_choice = None
    return title, json.dumps(options, ensure_ascii=False), mode, correct_choice


def mode_summary(mode, correct_choice, counts):
    if mode == "approval":
        yes, no, abstain = counts
        valid = yes + no
        return dict(yes=yes, no=no, abstain=abstain, approval_pct=100 * yes / valid if valid else None,
                    passed=yes > no if valid else None)
    total = sum(counts)
    if mode == "rating":
        return {"average": sum(score * count for score, count in enumerate(counts, 1)) / total if total else None}
    if mode == "quiz":
        correct = counts[correct_choice]
        return dict(correct_count=correct, correct_pct=100 * correct / total if total else None)
    return {}


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, seen REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS polls (
                id TEXT PRIMARY KEY, title TEXT NOT NULL, options TEXT NOT NULL,
                phase TEXT NOT NULL, created REAL NOT NULL, deadline_at_ms INTEGER, batch_id TEXT,
                mode TEXT NOT NULL DEFAULT 'single', correct_choice INTEGER,
                history_deleted INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS votes (
                poll_id TEXT NOT NULL, device_id TEXT NOT NULL, choice INTEGER NOT NULL,
                created REAL NOT NULL, PRIMARY KEY (poll_id, device_id)
            );
            CREATE TABLE IF NOT EXISTS poll_reports (
                batch_id TEXT PRIMARY KEY, title TEXT NOT NULL, started_at_ms INTEGER NOT NULL, ended_at_ms INTEGER,
                question_count INTEGER NOT NULL, participants INTEGER NOT NULL, total_votes INTEGER NOT NULL,
                questions TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS question_library (
                id TEXT PRIMARY KEY, title TEXT NOT NULL, options TEXT NOT NULL, mode TEXT NOT NULL,
                correct_choice INTEGER, revision INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
            );
        """)
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            columns = {r["name"] for r in self.db.execute("PRAGMA table_info(polls)")}
            if "deadline_at_ms" not in columns:
                self.db.execute("ALTER TABLE polls ADD COLUMN deadline_at_ms INTEGER")
            if "batch_id" not in columns:
                self.db.execute("ALTER TABLE polls ADD COLUMN batch_id TEXT")
            if "mode" not in columns:
                self.db.execute("ALTER TABLE polls ADD COLUMN mode TEXT NOT NULL DEFAULT 'single'")
            if "correct_choice" not in columns:
                self.db.execute("ALTER TABLE polls ADD COLUMN correct_choice INTEGER")
            if "history_deleted" not in columns:
                self.db.execute("ALTER TABLE polls ADD COLUMN history_deleted INTEGER NOT NULL DEFAULT 0")
            self.db.execute("UPDATE polls SET batch_id=id WHERE batch_id IS NULL")
            self.db.execute("CREATE INDEX IF NOT EXISTS polls_by_batch ON polls(batch_id)")
            # 旧版保留了原票和题目，但没有记录实际截止时刻。
            for batch in self.db.execute("""
                SELECT p.* FROM polls p LEFT JOIN poll_reports r ON r.batch_id=p.id
                WHERE p.id=p.batch_id AND p.phase IN ('closed','published') AND r.batch_id IS NULL AND p.history_deleted=0
                ORDER BY p.rowid
            """).fetchall():
                self._save_report(batch, None)
            self.db.execute("INSERT OR IGNORE INTO settings VALUES ('join_code', ?)", (f"{secrets.randbelow(1000000):06d}",))
            # 会场标识可公开，随数据库保留；入场码只用于 WebSocket 登记。
            self.db.execute("INSERT OR IGNORE INTO settings VALUES ('host_id', ?)", (secrets.token_hex(8),))
        settings = dict(self.db.execute("SELECT key, value FROM settings WHERE key IN ('host_id', 'join_code')"))
        self.join_code = settings["join_code"]
        self.host_id = settings["host_id"]

    def aliases(self) -> dict[str, str]:
        row = self.db.execute("SELECT value FROM settings WHERE key='device_aliases'").fetchone()
        if not row:
            return {}
        try:
            data = json.loads(row["value"])
        except (TypeError, json.JSONDecodeError):
            return {}
        if not isinstance(data, dict):
            return {}
        return {k: v for k, v in data.items() if isinstance(k, str) and isinstance(v, str)}

    def set_alias(self, device: object, alias: object) -> str:
        if not isinstance(device, str) or not re.fullmatch(r"[0-9a-f]{12}", device):
            raise ValueError("设备编号无效")
        if not isinstance(alias, str):
            raise ValueError("设备备注必须是文字")
        cleaned = alias.strip()
        if len(cleaned) > MAX_ALIAS_LENGTH:
            raise ValueError(f"设备备注最多 {MAX_ALIAS_LENGTH} 个字符")
        if any(ord(c) < 32 or ord(c) == 127 for c in cleaned):
            raise ValueError("设备备注不能包含换行或控制字符")
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            if not self.db.execute("SELECT 1 FROM devices WHERE id=?", (device,)).fetchone():
                raise ValueError("该设备尚未登记")
            mapping = self.aliases()
            if cleaned:
                mapping[device] = cleaned
            else:
                mapping.pop(device, None)
            self.db.execute(
                "INSERT INTO settings VALUES ('device_aliases', ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (json.dumps(mapping, ensure_ascii=False),),
            )
        return cleaned

    def _latest(self):
        # 批次用首题编号标识，按插入顺序定位，避免电脑校时改变当前场次。
        return self.db.execute("SELECT * FROM polls WHERE id=(SELECT batch_id FROM polls ORDER BY rowid DESC LIMIT 1)").fetchone()

    def library_questions(self) -> list[dict]:
        rows = self.db.execute("""
            SELECT id,title,options,mode,correct_choice,revision FROM question_library ORDER BY updated_at_ms DESC,rowid DESC
        """)
        questions = []
        for row in rows:
            question = dict(row)
            question["options"] = json.loads(question["options"])
            questions.append(question)
        return questions

    def save_library_question(self, data: dict):
        question_id = data.get("id")
        revision = data.get("revision")
        if not isinstance(question_id, str) or not re.fullmatch(r"[0-9a-f]{16}", question_id):
            raise ValueError("题库编号无效")
        if revision is not None and (type(revision) is not int or revision < 1):
            raise ValueError("题库版本无效")
        entry = read_question(data)
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            current = self.db.execute(
                "SELECT title,options,mode,correct_choice,revision FROM question_library WHERE id=?", (question_id,)
            ).fetchone()
            if current is None:
                if revision is not None:
                    raise ValueError("找不到这道题，请返回题库再试")
                self.db.execute("""
                    INSERT INTO question_library(id,title,options,mode,correct_choice,revision,updated_at_ms)
                    VALUES (?,?,?,?,?,1,?)
                """, (question_id, *entry, clock_ms()))
                return
            if tuple(current)[:-1] == entry:
                # 保持重试幂等，已经保存的同一内容不另建题目或增加版本。
                return
            if revision != current["revision"]:
                raise ValueError("题库里的这道题已有新版本，请返回题库重新打开")
            self.db.execute("""
                UPDATE question_library SET title=?,options=?,mode=?,correct_choice=?,revision=revision+1,updated_at_ms=?
                WHERE id=?
            """, (*entry, clock_ms(), question_id))

    def _save_report(self, batch, ended_at_ms):
        questions = []
        for poll in self.db.execute("SELECT * FROM polls WHERE batch_id=? ORDER BY rowid", (batch["id"],)):
            options = json.loads(poll["options"])
            counts = self._counts(poll["id"], len(options))
            questions.append(dict(id=poll["id"], title=poll["title"], options=options, counts=counts, total=sum(counts),
                                  **self._mode_fields(poll, counts)))
        participants = self.db.execute("""
            SELECT COUNT(DISTINCT v.device_id) FROM votes v JOIN polls p ON p.id=v.poll_id WHERE p.batch_id=?
        """, (batch["id"],)).fetchone()[0]
        self.db.execute("""
            INSERT INTO poll_reports(batch_id,title,started_at_ms,ended_at_ms,question_count,participants,total_votes,questions)
            VALUES (?,?,?,?,?,?,?,?)
        """, (batch["id"], batch["title"], round(batch["created"] * 1000), ended_at_ms, len(questions),
              participants, sum(q["total"] for q in questions), json.dumps(questions, ensure_ascii=False)))

    def _finish(self, poll, phase, ended_at_ms):
        # 截止和统计同事务提交。后续公布或重发原票都不改写这份统计。
        self.db.execute("UPDATE polls SET phase=? WHERE batch_id=?", (phase, poll["id"]))
        if poll["phase"] == "open":
            self._save_report(poll, ended_at_ms)

    def history(self, before=None):
        query = """SELECT rowid AS cursor, batch_id AS id, title, started_at_ms, ended_at_ms,
                          question_count, participants, total_votes FROM poll_reports"""
        params = ()
        if before is not None:
            query += " WHERE rowid < ?"
            params = (before,)
        rows = [dict(row) for row in self.db.execute(query + " ORDER BY rowid DESC LIMIT 21", params)]
        return dict(reports=rows[:20], next_before=rows[19]["cursor"] if len(rows) > 20 else None)

    def delete_report(self, batch_id: object):
        if not isinstance(batch_id, str) or not re.fullmatch(r"[0-9a-f]{16}", batch_id):
            raise ValueError("投票记录编号无效")
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            removed = self.db.execute("DELETE FROM poll_reports WHERE batch_id=?", (batch_id,)).rowcount
            if removed:
                # 保留当前投票的公布流程，并标记场次，避免旧库补档重新生成这份归档。
                self.db.execute("UPDATE polls SET history_deleted=1 WHERE id=?", (batch_id,))
            elif not self.db.execute("SELECT 1 FROM polls WHERE id=? AND history_deleted=1", (batch_id,)).fetchone():
                raise ValueError("找不到可删除的历史记录")

    def report(self, batch_id):
        row = self.db.execute("""SELECT batch_id AS id, title, started_at_ms, ended_at_ms,
                question_count, participants, total_votes, questions FROM poll_reports WHERE batch_id=?""",
                              (batch_id,)).fetchone()
        if row is None:
            return None
        report = dict(row)
        questions = json.loads(report["questions"])
        for question in questions:
            # 旧版归档保持原样，读取时按单选解释。
            question.setdefault("mode", "single")
            question.setdefault("correct_choice", None)
            question.setdefault("mode_summary", {})
        report["questions"] = questions
        return report

    @staticmethod
    def _due(poll, now: int) -> bool:
        return poll is not None and poll["phase"] == "open" and poll["deadline_at_ms"] is not None and now >= poll["deadline_at_ms"]

    @contextmanager
    def _locked_poll(self):
        while True:
            with self.db:
                self.db.execute("BEGIN IMMEDIATE")
                now = clock_ms()
                poll = self._latest()
                if not self._due(poll, now):
                    yield poll, now
                    return
                # 单独提交自动截止。即使下一笔操作因迟到被拒，截止状态也必须保留。
                self._finish(poll, "closed", poll["deadline_at_ms"])

    def current(self, now=None):
        poll = self._latest()
        if self._due(poll, clock_ms() if now is None else now):
            with self._locked_poll() as (poll, _):
                return poll
        return poll

    def device_limit(self) -> int:
        row = self.db.execute("SELECT value FROM settings WHERE key='device_limit'").fetchone()
        return int(row[0]) if row else DEFAULT_DEVICE_LIMIT

    def set_device_limit(self, limit: object):
        if type(limit) is not int or not 1 <= limit <= MAX_DEVICE_LIMIT:
            raise ValueError(f"请输入 1～{MAX_DEVICE_LIMIT} 的整数作为设备上限")
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            registered = self.db.execute("SELECT COUNT(*) FROM devices").fetchone()[0]
            if limit < registered:
                raise ValueError(f"已有 {registered} 台设备登记，设备上限不能更低。可先移除离线设备")
            self.db.execute("INSERT INTO settings VALUES ('device_limit', ?) "
                            "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (str(limit),))

    def register(self, device: str):
        if not re.fullmatch(r"[0-9a-f]{12}", device):
            raise ValueError("设备编号无效")
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            if not self.db.execute("SELECT 1 FROM devices WHERE id=?", (device,)).fetchone():
                limit = self.device_limit()
                if self.db.execute("SELECT COUNT(*) FROM devices").fetchone()[0] >= limit:
                    raise ValueError(f"本场设备已满，最多登记 {limit} 台")
            self.db.execute("INSERT INTO devices VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET seen=excluded.seen",
                            (device, time.time()))

    def create(self, data: dict):
        self._create_questions([data], data)

    def create_batch(self, data: dict):
        questions = data.get("questions")
        if not isinstance(questions, list) or not 2 <= len(questions) <= MAX_BATCH_POLLS:
            raise ValueError(f"批量发题需要 2～{MAX_BATCH_POLLS} 道题")
        self._create_questions(questions, data)

    def _create_questions(self, questions: list, data: dict):
        entries = []
        for i, question in enumerate(questions, 1):
            try:
                entries.append(read_question(question))
            except ValueError as exc:
                if len(questions) == 1:
                    raise
                raise ValueError(f"第 {i} 题：{exc}") from exc
        with self._locked_poll() as (poll, now):
            if poll and poll["phase"] != "published":
                raise ValueError("请先公布当前投票的结果，再发起新题")
            if "previous_id" in data and data["previous_id"] != (poll["id"] if poll else None):
                raise ValueError("当前投票已变更，请刷新后操作")
            deadline = read_deadline(data, now)
            batch_id = secrets.token_hex(8)
            self.db.executemany(INSERT_OPEN_POLL,
                ((batch_id if i == 0 else secrets.token_hex(8), *entry, now / 1000, deadline, batch_id)
                 for i, entry in enumerate(entries)))

    def append_question(self, data: dict):
        entry = read_question(data)
        question_id = data.get("question_id")
        if not isinstance(question_id, str) or not re.fullmatch(r"[0-9a-f]{16}", question_id):
            raise ValueError("追加题目的编号无效")
        with self._locked_poll() as (batch, now):
            if not batch or batch["id"] != data.get("batch_id"):
                raise ValueError("场次已变更，请核对当前投票")
            # 浏览器为一次提交固定题号。重试复用原题，即使期间已截止或达到上限。
            existing = self.db.execute("SELECT batch_id,title,options,mode,correct_choice FROM polls WHERE id=?",
                                       (question_id,)).fetchone()
            if existing is not None:
                if question_id != batch["id"] and tuple(existing) == (batch["id"], *entry):
                    return
                raise ValueError("这个题号已用于其他内容，请重新添加")
            if batch["phase"] != "open":
                raise ValueError("本场已结束收票，不能追加题目")
            count = self.db.execute("SELECT COUNT(*) FROM polls WHERE batch_id=?", (batch["id"],)).fetchone()[0]
            if count >= MAX_BATCH_POLLS:
                raise ValueError(f"本场已达到 {MAX_BATCH_POLLS} 题上限")
            self.db.execute(INSERT_OPEN_POLL, (question_id, *entry, now / 1000, batch["deadline_at_ms"], batch["id"]))

    def change_deadline(self, data: dict):
        with self._locked_poll() as (poll, now):
            if not poll or poll["id"] != data.get("poll_id"):
                raise ValueError("题目已变更，请刷新后操作")
            if poll["phase"] != "open":
                raise ValueError("投票已截止，不能修改截止时间")
            if "duration_seconds" not in data and "deadline_at_ms" not in data:
                raise ValueError("请选择截止方式")
            deadline = read_deadline(data, now)
            self.db.execute("UPDATE polls SET deadline_at_ms=? WHERE batch_id=?", (deadline, poll["id"]))

    def transition(self, poll_id: object, phase: str):
        with self._locked_poll() as (poll, now):
            if not poll or poll["id"] != poll_id:
                raise ValueError("题目已变更，请刷新后操作")
            if phase == "closed" and poll["phase"] != "open":
                raise ValueError("当前题目已截止")
            if phase == "published" and poll["phase"] == "published":
                return
            self._finish(poll, phase, now)

    def show_result(self, batch_id, poll_id):
        with self._locked_poll() as (batch, _):
            if not batch or batch["id"] != batch_id or batch["phase"] != "published":
                raise ValueError("请先公布本组结果")
            if not isinstance(poll_id, str) or not self.db.execute(
                    "SELECT 1 FROM polls WHERE id=? AND batch_id=?", (poll_id, batch_id)).fetchone():
                raise ValueError("该题不在当前投票中")
            self.db.execute("INSERT OR REPLACE INTO settings (key,value) VALUES ('shown_result',?)", (poll_id,))

    def vote(self, device: str, poll_id: object, choice: object):
        with self._locked_poll() as (batch, now):
            poll = None
            if batch and isinstance(poll_id, str):
                poll = self.db.execute("SELECT * FROM polls WHERE batch_id=? AND id=?", (batch["id"], poll_id)).fetchone()
            if not poll:
                raise ValueError("题目已变更，本次提交未计票")
            old = self.db.execute("SELECT choice FROM votes WHERE poll_id=? AND device_id=?",
                                  (poll_id, device)).fetchone()
            # 截止后可确认原票；首次落票用取得写锁时的主持电脑时间判定。
            if old is not None:
                if type(choice) is not int or choice != old[0]:
                    raise ValueError("本机已投票，首次选择已锁定")
                return
            if poll["phase"] != "open":
                raise ValueError("投票已截止，本次提交未计票")
            if type(choice) is not int or not 0 <= choice < len(json.loads(poll["options"])):
                raise ValueError("选项编号无效")
            # 先确认原票，再检查个人顺序。丢失回执时重发上一题不会妨碍下一题。
            first = self.db.execute("SELECT p.id FROM polls p WHERE p.batch_id=? AND NOT EXISTS "
                                    "(SELECT 1 FROM votes v WHERE v.poll_id=p.id AND v.device_id=?) "
                                    "ORDER BY p.rowid LIMIT 1", (batch["id"], device)).fetchone()
            if first is None or first[0] != poll_id:
                raise ValueError("请先完成上一题，本次提交未计票")
            self.db.execute("INSERT INTO votes VALUES (?, ?, ?, ?)", (poll_id, device, choice, now / 1000))

    def snapshot(self, device: str | None = None, viewed_id: str | None = None):
        now = clock_ms()
        batch = self.current(now)
        state = {"v": 1, "type": "state", "poll": None}
        if device is None:
            state["server_now_ms"] = now
        if not batch:
            return state
        rows = self.db.execute("SELECT * FROM polls WHERE batch_id=? ORDER BY rowid", (batch["id"],)).fetchall()
        published = batch["phase"] == "published"
        shown = None
        if published and len(rows) > 1:
            setting = self.db.execute("SELECT value FROM settings WHERE key='shown_result'").fetchone()
            shown = setting[0] if setting and any(p["id"] == setting[0] for p in rows) else batch["id"]
        if device is None:
            items = [self._poll_item(p, now, -1, True, host=True) for p in rows]
            state["poll"] = items[0]
            if len(rows) > 1:
                state["batch"] = {"id": batch["id"], "polls": items, "shown_result": shown}
            return state
        mine = dict(self.db.execute("SELECT v.poll_id,v.choice FROM votes v JOIN polls p ON p.id=v.poll_id "
                                    "WHERE p.batch_id=? AND v.device_id=?", (batch["id"], device)))
        ids = [p["id"] for p in rows]
        if published:
            result_id = viewed_id if viewed_id in ids else shown
            index = ids.index(result_id) if result_id else 0
        else:
            index = next((i for i, pid in enumerate(ids) if pid not in mine), len(rows)-1)
        poll = rows[index]
        item = self._poll_item(poll, now, mine.get(poll["id"], -1), published)
        if len(rows) > 1:
            item["batch"] = {"index": index+1, "count": len(rows), "answered": len(mine)}
            if published:
                item["batch"].update(next=ids[(index+1) % len(rows)], prev=ids[index-1])
        state["poll"] = item
        return state

    @staticmethod
    def _mode_fields(poll, counts):
        mode, correct_choice = poll["mode"], poll["correct_choice"]
        return dict(mode=mode, correct_choice=correct_choice, mode_summary=mode_summary(mode, correct_choice, counts))

    def _poll_item(self, poll, now, choice, show_counts, *, host=False):
        options = json.loads(poll["options"])
        item = dict(id=poll["id"], title=poll["title"], options=options, phase=poll["phase"], my_choice=choice)
        if poll["deadline_at_ms"] is not None:
            item["deadline_at_ms"] = poll["deadline_at_ms"]
            if poll["phase"] == "open":
                item["remaining_ms"] = max(0, poll["deadline_at_ms"] - now)
        if show_counts:
            counts = self._counts(poll["id"], len(options))
            item.update(counts=counts, total=sum(counts))
            if host:
                item.update(self._mode_fields(poll, counts))
        return item

    def _counts(self, poll_id, option_count):
        counts = [0] * option_count
        for choice, total in self.db.execute("SELECT choice,COUNT(*) FROM votes WHERE poll_id=? GROUP BY choice", (poll_id,)):
            counts[choice] = total
        return counts


def report_csv(report):
    def beijing(ms):
        return datetime.fromtimestamp(ms / 1000, timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M:%S") if ms is not None else ""

    def cell(text):
        # 避免表格软件把题目或选项文字解释成公式。
        return "'" + text if text.lstrip().startswith(("=", "+", "-", "@")) else text

    out = io.StringIO(newline="")
    writer = csv.writer(out)
    writer.writerow(["发起时间（北京时间）", "结束时间（北京时间）", "参与人数", "整场票数",
                     "题号", "题目", "本题票数", "选项编号", "选项", "选项票数", "得票比例",
                     "投票模式", "正确选项", "模式统计"])
    shared = [beijing(report["started_at_ms"]), beijing(report["ended_at_ms"]), report["participants"], report["total_votes"]]
    for number, question in enumerate(report["questions"], 1):
        total = question["total"]
        mode = question["mode"]
        correct_choice = question["correct_choice"]
        summary = question["mode_summary"]
        answer = chr(65 + correct_choice) if correct_choice is not None else ""
        stats = ""
        if mode == "approval":
            stats = "无有效表决票"
            if summary["approval_pct"] is not None:
                outcome = "通过" if summary["passed"] else "未通过"
                stats = f'{outcome} · 赞成率 {summary["approval_pct"]:.1f}%（不计弃权）'
        elif mode == "rating":
            average = summary["average"]
            stats = f"平均 {average:.2f} 分" if average is not None else "暂无评分"
        elif mode == "quiz":
            percent = summary["correct_pct"]
            stats = f'答对 {summary["correct_count"]} 人 · 正确率 {percent:.1f}%' if percent is not None else "暂无作答"
        extra = [MODE_LABELS[mode], answer, stats]
        for i, (option, count) in enumerate(zip(question["options"], question["counts"])):
            percent = 100 * count / total if total else 0
            writer.writerow([*shared, number, cell(question["title"]), total, chr(65+i), cell(option), count,
                             f"{percent:.1f}%", *extra])
    return out.getvalue().encode("utf-8-sig")


class HostDiscovery(asyncio.DatagramProtocol):
    def __init__(self, service):
        self.service = service

    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, message, address):
        if len(message) != 12 or message[:4] not in (b"GXV1", b"GXV2"):
            return
        ip = ipaddress.IPv4Address(address[0])
        if not any(ip in network for network in DISCOVERY_NETWORKS):
            return
        payload = message[4:] + bytes.fromhex(self.service.store.host_id) + self.service.port.to_bytes(2, "big")
        if message[:4] == b"GXV1":
            self.transport.sendto(b"GXH1" + payload, address)
        else:
            flags = bytes([1 if self.service.open_join_active() else 0])
            self.transport.sendto(b"GXH2" + payload + flags, address)


class VotingService:
    def __init__(self, path: Path, port: int = 8765, discovery_port: int = DISCOVERY_PORT):
        self.store = Store(path)
        self.clients: dict[str, web.WebSocketResponse] = {}
        self.viewed: dict[str, str] = {}
        self.port = port
        self.admin_nonce = secrets.token_urlsafe(24)
        self.broadcast_lock = asyncio.Lock()
        self.addresses = []
        self.discovery_port = discovery_port
        self.discovery = None
        self.deadline_changed = asyncio.Event()
        self.deadline_task = None
        self.open_join_until_ms = 0

    def open_join_remaining_ms(self) -> int:
        return max(0, self.open_join_until_ms - clock_ms())

    def open_join_active(self) -> bool:
        return self.open_join_remaining_ms() > 0

    def set_open_join(self, seconds: object) -> int:
        if type(seconds) is not int or not (seconds == 0 or 10 <= seconds <= OPEN_JOIN_MAX_SECONDS):
            raise ValueError(f"一键入场时长须为 0（关闭）或 10～{OPEN_JOIN_MAX_SECONDS} 秒")
        self.open_join_until_ms = 0 if seconds == 0 else clock_ms() + seconds * 1000
        return self.open_join_until_ms

    async def watch_deadline(self):
        while True:
            self.deadline_changed.clear()
            try:
                poll = self.store.current()
                deadline = poll["deadline_at_ms"] if poll else None
                if deadline is None or poll["phase"] != "open":
                    # 读快照或落票也可能先触发截止，仍需把新阶段推给所有在线设备。
                    if deadline is not None and poll["phase"] == "closed":
                        await self.broadcast()
                    await self.deadline_changed.wait()
                    continue
                # 定期对照墙上时钟，主持电脑休眠或校时后也能按实际时刻截止。
                delay = min(1.0, max(0, deadline - clock_ms()) / 1000)
                with suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(self.deadline_changed.wait(), delay)
            except sqlite3.Error as exc:
                print(f"截止时间暂时无法核对，将重试（{exc}）", flush=True)
                await asyncio.sleep(1)

    async def send_state(self, device: str, ws: web.WebSocketResponse, extra: dict | None = None):
        try:
            state = self.store.snapshot(device, self.viewed.get(device))
            if extra:
                state.update(extra)
            await asyncio.wait_for(ws.send_json(state, dumps=lambda x: json.dumps(x, ensure_ascii=False)), 2)
            return True
        except (ConnectionError, RuntimeError, asyncio.TimeoutError):
            await ws.close()
            return False

    async def broadcast(self):
        # 单次广播读取最新快照；串行发送，避免截止/公布与落票快照乱序。
        async with self.broadcast_lock:
            sent = await asyncio.gather(*(self.send_state(d, w) for d, w in list(self.clients.items())))
            return sum(sent)

    async def ws_device(self, request: web.Request):
        ws = web.WebSocketResponse(heartbeat=15, max_msg_size=MAX_MESSAGE, compress=False)
        await ws.prepare(request)
        device = None
        try:
            first = await asyncio.wait_for(ws.receive(), 8)
            if first.type != WSMsgType.TEXT:
                raise ValueError("请先登记设备")
            data = json.loads(first.data)
            if not isinstance(data, dict) or type(data.get("v")) is not int or data.get("v") != 1 or data.get("type") != "hello":
                raise ValueError("协议版本或握手无效")
            open_join = data.get("open_join") is True
            if open_join:
                if not self.open_join_active():
                    raise ValueError("一键入场已关闭，请使用入场码")
            else:
                code = data.get("code")
                if not isinstance(code, str) or not code.isascii() or not secrets.compare_digest(code, self.store.join_code):
                    raise ValueError("入场码错误，长按确定可切换")
            candidate = data.get("device_id", "")
            if not isinstance(candidate, str):
                raise ValueError("设备编号无效")
            if candidate in self.clients and not self.clients[candidate].closed:
                raise ValueError("设备仍有旧连接，请稍后重连")
            self.store.register(candidate)
            device = candidate
            self.clients[device] = ws
            await self.send_state(device, ws, {"join_code": self.store.join_code} if open_join else None)
            recent = []
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    if msg.type in (WSMsgType.ERROR, WSMsgType.CLOSE, WSMsgType.CLOSED):
                        break
                    continue
                now = time.monotonic()
                recent = [t for t in recent if now - t < 1]
                if len(recent) >= 8:
                    raise ValueError("消息过于频繁")
                recent.append(now)
                try:
                    data = json.loads(msg.data)
                    if not isinstance(data, dict) or type(data.get("v")) is not int or data.get("v") != 1:
                        raise ValueError("协议无效")
                    if data.get("type") == "vote":
                        self.store.vote(device, data.get("poll_id"), data.get("choice"))
                        # 收票期间每台设备只看自己的进度。只回执给提交者，避免并发时成倍推送。
                        await self.send_state(device, ws)
                    elif data.get("type") == "view":
                        requested = data.get("poll_id")
                        if not isinstance(requested, str) or not re.fullmatch(r"[0-9a-f]{16}", requested):
                            raise ValueError("题目编号无效")
                        batch = self.store.current()
                        if not batch or batch["phase"] != "published" or not self.store.db.execute(
                                "SELECT 1 FROM polls WHERE id=? AND batch_id=?", (requested, batch["id"])).fetchone():
                            raise ValueError("请等待主持人公布本组结果")
                        self.viewed[device] = requested
                        await self.send_state(device, ws)
                    elif data.get("type") == "sync":
                        await self.send_state(device, ws)
                    else:
                        raise ValueError("消息类型无效")
                except (ValueError, sqlite3.Error) as exc:
                    message = str(exc) if isinstance(exc, ValueError) else "记录写入失败，请稍后重试"
                    await ws.send_json({"v": 1, "type": "error", "message": message})
                    await self.send_state(device, ws)
        except (ValueError, TypeError, asyncio.TimeoutError, sqlite3.Error) as exc:
            if not ws.closed:
                message = "登记存储失败，请联系主持人" if isinstance(exc, sqlite3.Error) else str(exc) or "登记超时"
                await ws.send_json({"v": 1, "type": "error", "message": message})
        finally:
            if device and self.clients.get(device) is ws:
                del self.clients[device]
                self.viewed.pop(device, None)
            await ws.close()
        return ws

    def admin_guard(self, request: web.Request):
        try:
            local = ipaddress.ip_address(request.remote or "").is_loopback
        except ValueError:
            local = False
        # 主持界面仅在运行服务的电脑访问，同时防止跨站请求和 DNS rebinding。
        if not local or request.host not in {f"127.0.0.1:{self.port}", f"localhost:{self.port}", f"[::1]:{self.port}"}:
            raise web.HTTPForbidden(text="请在主持电脑打开 http://127.0.0.1:%d" % self.port)
        if request.method != "GET" and request.headers.get("X-Host-Nonce") != self.admin_nonce:
            raise web.HTTPForbidden(text="主持会话失效，请刷新页面")
        origin = request.headers.get("Origin")
        if origin and origin != f"http://{request.host}":
            raise web.HTTPForbidden(text="不允许跨站请求")

    async def admin_state(self, request):
        self.admin_guard(request)
        state = self.store.snapshot()
        latest_report = self.store.db.execute("SELECT batch_id FROM poll_reports ORDER BY rowid DESC LIMIT 1").fetchone()
        history_count = self.store.db.execute("SELECT COUNT(*) FROM poll_reports").fetchone()[0]
        state["latest_report"] = latest_report[0] if latest_report else None
        state.update(join_code=self.store.join_code, nonce=self.admin_nonce, max_devices=self.store.device_limit(),
                     device_limit_max=MAX_DEVICE_LIMIT,
                     addresses=self.addresses, port=self.port, host_id=self.store.host_id,
                     discovery_available=self.discovery is not None, max_batch_polls=MAX_BATCH_POLLS,
                     supports_append=True, supports_modes=True, supports_question_library=True,
                     supports_history_delete=True, supports_open_join=True,
                     open_join_remaining_ms=self.open_join_remaining_ms(),
                     open_join_until_ms=self.open_join_until_ms if self.open_join_active() else None,
                     history_count=history_count)
        current_id = state["poll"]["id"] if state["poll"] else ""
        answered = dict(self.store.db.execute("SELECT v.device_id, COUNT(*) FROM votes v JOIN polls p ON p.id=v.poll_id "
                                               "WHERE p.batch_id=? GROUP BY v.device_id", (current_id,)))
        question_count = len(state["batch"]["polls"]) if "batch" in state else 1
        aliases = self.store.aliases()
        state["devices"] = [dict(id=r["id"], online=r["id"] in self.clients, answered=answered.get(r["id"], 0),
                                 voted=answered.get(r["id"], 0) == question_count, alias=aliases.get(r["id"], ""))
                            for r in self.store.db.execute("SELECT * FROM devices ORDER BY id")]
        return web.json_response(state)

    async def history_index(self, request):
        self.admin_guard(request)
        before = request.query.get("before")
        if before is not None and (not re.fullmatch(r"[1-9][0-9]{0,18}", before) or int(before) > 2**63 - 1):
            raise web.HTTPBadRequest(text="历史分页编号无效")
        return web.json_response(self.store.history(int(before) if before is not None else None),
                                 headers={"Cache-Control": "no-store"})

    async def question_library(self, request):
        self.admin_guard(request)
        return web.json_response({"questions": self.store.library_questions()}, headers={"Cache-Control": "no-store"})

    async def history_detail(self, request):
        self.admin_guard(request)
        report = self.store.report(request.match_info["id"])
        if report is None:
            raise web.HTTPNotFound(text="找不到已结束的投票")
        if request.match_info.get("format") == "csv":
            name = f'vote-{report["id"]}.csv'
            return web.Response(body=report_csv(report), content_type="text/csv", charset="utf-8",
                                headers={"Content-Disposition": f'attachment; filename="{name}"',
                                         "Cache-Control": "no-store"})
        return web.json_response(report, headers={"Cache-Control": "no-store"})

    async def admin_action(self, request):
        self.admin_guard(request)
        try:
            data = await request.json()
            if not isinstance(data, dict):
                raise ValueError("请求格式无效")
            action = request.match_info["action"]
            if action == "create":
                self.store.create(data)
            elif action == "create_batch":
                self.store.create_batch(data)
            elif action == "append_question":
                self.store.append_question(data)
            elif action == "deadline":
                self.store.change_deadline(data)
            elif action in ("close", "publish"):
                self.store.transition(data.get("poll_id"), "closed" if action == "close" else "published")
                if action == "publish":
                    self.viewed.clear()
            elif action == "show_result":
                self.store.show_result(data.get("batch_id"), data.get("poll_id"))
                self.viewed.clear()
            elif action == "forget":
                device = data.get("device_id")
                if not isinstance(device, str):
                    raise ValueError("设备编号无效")
                if device in self.clients:
                    raise ValueError("请先断开该设备")
                with self.store.db:
                    self.store.db.execute("DELETE FROM devices WHERE id=?", (device,))
            elif action == "alias":
                self.store.set_alias(data.get("device_id"), data.get("alias", ""))
            elif action == "device_limit":
                self.store.set_device_limit(data.get("limit"))
            elif action == "library_save":
                self.store.save_library_question(data)
            elif action == "history_delete":
                self.store.delete_report(data.get("batch_id"))
            elif action == "open_join":
                self.set_open_join(data.get("seconds", OPEN_JOIN_DEFAULT_SECONDS))
            else:
                raise ValueError("操作无效")
            if action in ("create", "create_batch", "deadline", "close", "publish"):
                self.deadline_changed.set()
            if action in ("alias", "device_limit", "library_save", "history_delete", "open_join"):
                return web.json_response({"ok": True})
            sent = await self.broadcast()
            if action in ("create", "create_batch", "append_question"):
                return web.json_response({"ok": True, "pushed_to": sent})
            return web.json_response({"ok": True})
        except (ValueError, TypeError, json.JSONDecodeError) as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except sqlite3.Error:
            return web.json_response({"error": "数据写入失败，操作未确认；请检查磁盘后重试"}, status=500)

    async def static(self, request):
        self.admin_guard(request)
        name = request.match_info.get("name", "index.html")
        if name not in {"index.html", "app.js", "style.css", "font-coverage.json", "favicon.ico"}:
            raise web.HTTPNotFound()
        return web.FileResponse(STATIC / name, headers={"Cache-Control": "no-store",
            "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; object-src 'none'; frame-ancestors 'none'"})

    async def cleanup(self, app):
        if self.deadline_task is not None:
            self.deadline_task.cancel()
            with suppress(asyncio.CancelledError):
                await self.deadline_task
        if self.discovery is not None:
            self.discovery.close()
            self.discovery = None
        await asyncio.gather(*(ws.close(code=1001, message=b"shutdown") for ws in list(self.clients.values())))
        self.store.db.close()

    async def read_addresses(self, app):
        self.store.current()
        self.deadline_task = asyncio.create_task(self.watch_deadline())
        # 系统名称解析可能等待局域网 DNS，不在投票或计票处理期间阻塞事件循环。
        self.addresses = await asyncio.to_thread(lan_addresses, self.port)
        try:
            self.discovery, _ = await asyncio.get_running_loop().create_datagram_endpoint(
                lambda: HostDiscovery(self), local_addr=("0.0.0.0", self.discovery_port), family=socket.AF_INET)
        except OSError as exc:
            print(f"主持台自动发现暂不可用（{exc}），仍可手动填写局域网地址。", flush=True)

    def app(self):
        # 主持表单可包含整组中文选项。投票器仍使用单题快照和原来的 WebSocket 大小限制。
        app = web.Application(client_max_size=128 * 1024)
        app.router.add_get("/ws", self.ws_device)
        app.router.add_get("/api/state", self.admin_state)
        app.router.add_get("/api/question_library", self.question_library)
        app.router.add_get("/api/history", self.history_index)
        app.router.add_get("/api/history/{id:[0-9a-f]+}", self.history_detail)
        app.router.add_get("/api/history/{id:[0-9a-f]+}/{format:csv}", self.history_detail)
        app.router.add_post("/api/{action}", self.admin_action)
        app.router.add_get("/", self.static)
        app.router.add_get("/{name}", self.static)
        app.on_startup.append(self.read_addresses)
        app.on_shutdown.append(self.cleanup)
        return app


def lan_addresses(port):
    # 不向互联网发包；结合主机名解析与内核私有路由探测获取候选局域网地址。
    found: set[str] = set()
    try:
        for item in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = ipaddress.IPv4Address(item[4][0])
            if not ip.is_loopback and not ip.is_link_local:
                found.add(str(ip))
    except socket.gaierror:
        pass
    for probe in ("10.255.255.255", "192.168.0.1", "172.16.0.1"):
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.connect((probe, 1))
            ip = ipaddress.IPv4Address(sock.getsockname()[0])
            if not ip.is_loopback and not ip.is_link_local:
                found.add(str(ip))
        except OSError:
            pass
        finally:
            sock.close()
    return [f"ws://{ip}:{port}/ws" for ip in sorted(found)]


def main():
    parser = argparse.ArgumentParser(description="局域网投票主持台（运行时无需互联网）")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--data", type=Path, default=ROOT / "host" / "data" / "votes.sqlite3")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("端口须为 1～65535")
    service = VotingService(args.data, args.port)
    # 本机网页也可以走 IPv6 回环，投票器仍通过原来的局域网 IPv4 地址入场。
    loopback = None
    if socket.has_ipv6:
        with suppress(OSError):
            loopback = socket.create_server(("::1", args.port), family=socket.AF_INET6)
    alternate = f" 或 http://[::1]:{args.port}" if loopback else ""
    print(f"主持台：http://127.0.0.1:{args.port}{alternate}   入场码：{service.store.join_code}", flush=True)
    web.run_app(service.app(), host="0.0.0.0", port=args.port, sock=loopback, access_log=None)


if __name__ == "__main__":
    main()
