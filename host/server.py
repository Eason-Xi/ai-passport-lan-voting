"""同一局域网的投票主持服务：串行处理状态，SQLite 事务保证首次落票唯一。"""

from __future__ import annotations

import argparse
import asyncio
import csv
import io
import ipaddress
import json
import math
import re
import secrets
import socket
import sqlite3
import sys
import time
from contextlib import contextmanager, suppress
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable

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
MAX_POLL_OPTIONS = 10
MAX_CUSTOM_MODES = 30
MAX_CUSTOM_MODE_NAME = 20
MAX_CUSTOM_MODE_GUIDE = 80
MAX_CUSTOM_MODE_UNIT = 6
MAX_MESSAGE = 4096
MAX_BATCH_POLLS = 50
ROSTER_MODES = frozenset(("all", "selected", "exclude"))
DEVICE_ID_RE = re.compile(r"^[0-9a-f]{12}$")
HEX16_RE = re.compile(r"^[0-9a-f]{16}$")
JOIN_CODE_RE = re.compile(r"^[0-9]{4}$")
MODE_LABELS = {"single": "普通单选", "approval": "赞成 / 反对 / 弃权", "rating": "五分评分", "quiz": "答题测验"}
BUILTIN_MODE_NAMES = frozenset(v.lower() for v in MODE_LABELS.values())
FIXED_OPTIONS = {
    "approval": ["赞成", "反对", "弃权"],
    "rating": ["1 分", "2 分", "3 分", "4 分", "5 分"],
}
INSERT_OPEN_POLL = """INSERT INTO polls (
    id,title,options,mode,mode_meta,correct_choice,phase,created,deadline_at_ms,batch_id,
    roster_mode,roster_devices,roster_allow_late,roster_eligible,excluded_see_results
) VALUES (?,?,?,?,?,?,'open',?,?,?,?,?,?,?,?)"""
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


class ApiError(ValueError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _is_strict_int(value: object) -> bool:
    return type(value) is int


def _is_finite_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def clean_plain_text(raw: object, min_chars: int, max_chars: int, field_name: str) -> str:
    if not isinstance(raw, str):
        raise ValueError(f"{field_name}必须是文字")
    text = raw.strip()
    if not min_chars <= len(text) <= max_chars:
        if min_chars == 0:
            raise ValueError(f"{field_name}最多 {max_chars} 个字符")
        raise ValueError(f"{field_name}须为 {min_chars}～{max_chars} 个字符")
    if any(ord(c) < 32 or ord(c) == 127 for c in text):
        raise ValueError(f"{field_name}不能包含换行或控制字符")
    return text


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


def random_join_code() -> str:
    return f"{secrets.randbelow(10000):04d}"


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


def _read_pass_pct(raw: object) -> float:
    if not _is_finite_number(raw) or not (0 < float(raw) <= 100):
        raise ValueError("通过线须为大于 0 且不超过 100 的百分比数值")
    return round(float(raw), 1)


def _read_pass_op(raw: object) -> str:
    if raw in ("gt", "gte"):
        return str(raw)
    raise ValueError("通过线判定方式无效")


def _read_weights(raw: object, option_count: int) -> list[float]:
    if not isinstance(raw, list) or len(raw) != option_count:
        raise ValueError(f"需要为全部 {option_count} 个选项设置分值")
    weights: list[float] = []
    for idx, item in enumerate(raw, 1):
        if not _is_finite_number(item) or not (-1000 <= float(item) <= 1000):
            raise ValueError(f"第 {idx} 个选项的分值须为 -1000～1000 之间的数字")
        val = round(float(item), 2)
        weights.append(int(val) if val.is_integer() else val)
    return weights


def parse_custom_mode_input(data: dict) -> dict:
    if not isinstance(data, dict):
        raise ValueError("自定义模式格式无效")
    name = clean_plain_text(data.get("name"), 1, MAX_CUSTOM_MODE_NAME, "模式名称")
    if name.lower() in BUILTIN_MODE_NAMES:
        raise ValueError("模式名称不能与内置投票模式重名")
    raw_guide = data.get("guide")
    guide = "" if raw_guide in (None, "") else clean_plain_text(raw_guide, 0, MAX_CUSTOM_MODE_GUIDE, "模式说明")

    base_kind = data.get("base_kind")
    if not isinstance(base_kind, str) or base_kind not in MODE_LABELS:
        raise ValueError("基础统计类型无效")

    fixed_options: list[str] | None = None
    raw_fixed = data.get("fixed_options")
    requires_fixed = base_kind in ("approval", "rating")
    if requires_fixed or raw_fixed is not None:
        if not isinstance(raw_fixed, list) or not 2 <= len(raw_fixed) <= MAX_POLL_OPTIONS:
            raise ValueError(
                f"该统计类型须预设 2～{MAX_POLL_OPTIONS} 个固定选项"
                if requires_fixed
                else f"预设选项须为 2～{MAX_POLL_OPTIONS} 项"
            )
        fixed_options = [supported_text(opt, 24, "预设选项") for opt in raw_fixed]
        if len(set(fixed_options)) != len(fixed_options):
            raise ValueError("预设选项不能重复")

    rule_config: dict = {}
    if base_kind == "approval":
        count = len(fixed_options or [])
        yes_index = data.get("yes_index", 0)
        if not _is_strict_int(yes_index) or not 0 <= yes_index < count:
            raise ValueError("请选择有效的「赞成/通过」选项")
        raw_abstain = data.get("abstain_index", None)
        abstain_index: int | None = None
        if raw_abstain is not None:
            if not _is_strict_int(raw_abstain) or not 0 <= raw_abstain < count:
                raise ValueError("弃权选项下标无效")
            if raw_abstain == yes_index:
                raise ValueError("弃权项不能与赞成项相同")
            if count < 3:
                raise ValueError("仅有 2 个选项时不能设置弃权项")
            abstain_index = raw_abstain
        pass_pct = _read_pass_pct(data.get("pass_pct", 50))
        pass_op = _read_pass_op(data.get("pass_op", "gt"))
        if pass_pct == 100 and pass_op == "gt":
            raise ValueError("100% 通过线请选用「达到（≥）」判定")
        rule_config = {
            "yes_index": yes_index,
            "abstain_index": abstain_index,
            "pass_pct": int(pass_pct) if float(pass_pct).is_integer() else pass_pct,
            "pass_op": pass_op,
        }
    elif base_kind == "rating":
        raw_unit = data.get("unit", "分")
        unit = "分" if raw_unit is None else clean_plain_text(raw_unit, 0, MAX_CUSTOM_MODE_UNIT, "分值单位")
        rule_config = {
            "weights": _read_weights(data.get("weights"), len(fixed_options or [])),
            "unit": unit,
        }

    return {
        "name": name,
        "guide": guide,
        "base_kind": base_kind,
        "fixed_options": fixed_options,
        "rule_config": rule_config,
    }


def custom_mode_to_spec(custom: dict) -> dict:
    spec: dict = {
        "id": custom["id"],
        "name": custom["name"],
        "base_kind": custom["base_kind"],
    }
    if custom["base_kind"] == "approval":
        spec["yes_index"] = custom.get("yes_index", 0)
        spec["abstain_index"] = custom.get("abstain_index", None)
        spec["pass_pct"] = custom.get("pass_pct", 50)
        spec["pass_op"] = custom.get("pass_op", "gt")
    elif custom["base_kind"] == "rating":
        spec["weights"] = list(custom.get("weights") or [])
        spec["unit"] = custom.get("unit", "分")
    return spec


def validate_mode_meta(raw: object, expected_mode: str, option_count: int) -> dict:
    if not isinstance(raw, dict):
        raise ValueError("自定义模式快照格式无效")
    raw_id = raw.get("id")
    mode_id = raw_id if isinstance(raw_id, str) and HEX16_RE.fullmatch(raw_id) else "0000000000000000"
    name = clean_plain_text(raw.get("name"), 1, MAX_CUSTOM_MODE_NAME, "模式名称")
    spec: dict = {"id": mode_id, "name": name, "base_kind": expected_mode}
    if expected_mode == "approval":
        yes_index = raw.get("yes_index", 0)
        if not _is_strict_int(yes_index) or not 0 <= yes_index < option_count:
            raise ValueError("自定义表决模式的赞成项配置无效")
        raw_abstain = raw.get("abstain_index", None)
        abstain_index: int | None = None
        if raw_abstain is not None:
            if (
                not _is_strict_int(raw_abstain)
                or not 0 <= raw_abstain < option_count
                or raw_abstain == yes_index
                or option_count < 3
            ):
                raise ValueError("自定义表决模式的弃权项配置无效")
            abstain_index = raw_abstain
        pass_pct = _read_pass_pct(raw.get("pass_pct", 50))
        pass_op = _read_pass_op(raw.get("pass_op", "gt"))
        if pass_pct == 100 and pass_op == "gt":
            raise ValueError("100% 通过线请选用「达到（≥）」判定")
        spec.update(
            yes_index=yes_index,
            abstain_index=abstain_index,
            pass_pct=int(pass_pct) if float(pass_pct).is_integer() else pass_pct,
            pass_op=pass_op,
        )
    elif expected_mode == "rating":
        raw_unit = raw.get("unit", "分")
        unit = "分" if raw_unit is None else clean_plain_text(raw_unit, 0, MAX_CUSTOM_MODE_UNIT, "分值单位")
        spec.update(weights=_read_weights(raw.get("weights"), option_count), unit=unit)
    return spec


def _read_custom_options(raw: object) -> list[str]:
    if not isinstance(raw, list) or not 2 <= len(raw) <= MAX_POLL_OPTIONS:
        raise ValueError(f"需要 2～{MAX_POLL_OPTIONS} 个选项")
    options = [supported_text(option, 24, "选项") for option in raw]
    if len(set(options)) != len(options):
        raise ValueError("选项不能重复")
    return options


def read_question(
    data: dict,
    custom_mode_lookup: Callable[[str], dict | None] | None = None,
) -> tuple[str, str, str, str | None, int | None]:
    if not isinstance(data, dict):
        raise ValueError("题目格式无效")
    title = supported_text(data.get("title"), 60, "题目")

    mode_meta: dict | None = None
    raw_custom_id = data.get("custom_mode_id")
    if isinstance(raw_custom_id, str) and raw_custom_id.strip():
        if not HEX16_RE.fullmatch(raw_custom_id):
            raise ValueError("自定义模式编号无效")
        found = custom_mode_lookup(raw_custom_id) if custom_mode_lookup else None
        if found is not None:
            mode = found["base_kind"]
            options = list(found["fixed_options"]) if found["fixed_options"] else _read_custom_options(data.get("options"))
            mode_meta = custom_mode_to_spec(found)
        elif data.get("mode_meta") is not None:
            mode = data.get("mode", "single")
            if not isinstance(mode, str) or mode not in MODE_LABELS:
                raise ValueError("投票模式无效")
            options = _read_custom_options(data.get("options"))
            mode_meta = validate_mode_meta(data.get("mode_meta"), mode, len(options))
        else:
            raise ValueError("所选自定义投票模式不存在或已被删除，请重新选择模式")
    elif data.get("mode_meta") is not None:
        mode = data.get("mode", "single")
        if not isinstance(mode, str) or mode not in MODE_LABELS:
            raise ValueError("投票模式无效")
        options = _read_custom_options(data.get("options"))
        mode_meta = validate_mode_meta(data.get("mode_meta"), mode, len(options))
    else:
        mode = data.get("mode", "single")
        if not isinstance(mode, str) or mode not in MODE_LABELS:
            raise ValueError("投票模式无效")
        fixed = FIXED_OPTIONS.get(mode)
        options = list(fixed) if fixed is not None else _read_custom_options(data.get("options"))

    correct_choice = data.get("correct_choice")
    if mode == "quiz":
        if type(correct_choice) is not int or not 0 <= correct_choice < len(options):
            raise ValueError("请为测验题选择有效的正确选项")
    else:
        correct_choice = None

    mode_meta_json = json.dumps(mode_meta, ensure_ascii=False) if mode_meta is not None else None
    return title, json.dumps(options, ensure_ascii=False), mode, mode_meta_json, correct_choice


def mode_summary(mode: str, correct_choice: int | None, counts: list[int], mode_meta: dict | None = None) -> dict:
    total = sum(counts)
    if mode == "approval":
        yes_index = mode_meta.get("yes_index", 0) if mode_meta else 0
        abstain_index = mode_meta.get("abstain_index") if (mode_meta and "abstain_index" in mode_meta) else 2
        pass_pct = float(mode_meta.get("pass_pct", 50)) if mode_meta else 50.0
        pass_op = mode_meta.get("pass_op", "gt") if mode_meta else "gt"
        yes = counts[yes_index] if 0 <= yes_index < len(counts) else 0
        abstain = counts[abstain_index] if (abstain_index is not None and 0 <= abstain_index < len(counts)) else 0
        valid = max(0, total - abstain)
        no = max(0, valid - yes)
        approval_pct = (100 * yes / valid) if valid else None
        if approval_pct is None:
            passed = None
        elif pass_op == "gte":
            passed = approval_pct + 1e-9 >= pass_pct
        else:
            passed = approval_pct > pass_pct + 1e-9
        result = dict(yes=yes, no=no, abstain=abstain, approval_pct=approval_pct, passed=passed)
        if mode_meta:
            result.update(
                pass_pct=int(pass_pct) if pass_pct.is_integer() else pass_pct,
                pass_op=pass_op,
                has_abstain=abstain_index is not None,
            )
        return result
    if mode == "rating":
        weights = mode_meta.get("weights") if mode_meta else None
        if isinstance(weights, list) and len(weights) == len(counts):
            weighted = sum(float(w) * c for w, c in zip(weights, counts))
        else:
            weighted = sum(score * count for score, count in enumerate(counts, 1))
        average = weighted / total if total else None
        result = {"average": average}
        if mode_meta:
            rounded_total = round(weighted, 2)
            result["total_score"] = (int(rounded_total) if rounded_total.is_integer() else rounded_total) if total else None
            result["unit"] = mode_meta.get("unit", "分")
        return result
    if mode == "quiz":
        correct = counts[correct_choice] if (correct_choice is not None and 0 <= correct_choice < len(counts)) else 0
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
            CREATE TABLE IF NOT EXISTS kicked_devices (
                device_id TEXT PRIMARY KEY, kicked_code TEXT NOT NULL, kicked_at_ms INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS custom_modes (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, guide TEXT NOT NULL DEFAULT '',
                base_kind TEXT NOT NULL, fixed_options TEXT, rule_config TEXT NOT NULL DEFAULT '{}',
                updated_at_ms INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS polls (
                id TEXT PRIMARY KEY, title TEXT NOT NULL, options TEXT NOT NULL,
                phase TEXT NOT NULL, created REAL NOT NULL, deadline_at_ms INTEGER, batch_id TEXT,
                mode TEXT NOT NULL DEFAULT 'single', mode_meta TEXT, correct_choice INTEGER,
                history_deleted INTEGER NOT NULL DEFAULT 0,
                roster_mode TEXT NOT NULL DEFAULT 'all',
                roster_devices TEXT NOT NULL DEFAULT '[]',
                roster_allow_late INTEGER NOT NULL DEFAULT 1,
                roster_eligible TEXT,
                excluded_see_results INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS votes (
                poll_id TEXT NOT NULL, device_id TEXT NOT NULL, choice INTEGER NOT NULL,
                created REAL NOT NULL, PRIMARY KEY (poll_id, device_id)
            );
            CREATE TABLE IF NOT EXISTS poll_reports (
                batch_id TEXT PRIMARY KEY, title TEXT NOT NULL, started_at_ms INTEGER NOT NULL, ended_at_ms INTEGER,
                question_count INTEGER NOT NULL, participants INTEGER NOT NULL, total_votes INTEGER NOT NULL,
                roster_summary TEXT NOT NULL DEFAULT '', questions TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS question_library (
                id TEXT PRIMARY KEY, title TEXT NOT NULL, options TEXT NOT NULL, mode TEXT NOT NULL,
                mode_meta TEXT, correct_choice INTEGER, revision INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
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
            if "mode_meta" not in columns:
                self.db.execute("ALTER TABLE polls ADD COLUMN mode_meta TEXT")
            if "correct_choice" not in columns:
                self.db.execute("ALTER TABLE polls ADD COLUMN correct_choice INTEGER")
            if "history_deleted" not in columns:
                self.db.execute("ALTER TABLE polls ADD COLUMN history_deleted INTEGER NOT NULL DEFAULT 0")
            if "roster_mode" not in columns:
                self.db.execute("ALTER TABLE polls ADD COLUMN roster_mode TEXT NOT NULL DEFAULT 'all'")
            if "roster_devices" not in columns:
                self.db.execute("ALTER TABLE polls ADD COLUMN roster_devices TEXT NOT NULL DEFAULT '[]'")
            if "roster_allow_late" not in columns:
                self.db.execute("ALTER TABLE polls ADD COLUMN roster_allow_late INTEGER NOT NULL DEFAULT 1")
            if "roster_eligible" not in columns:
                self.db.execute("ALTER TABLE polls ADD COLUMN roster_eligible TEXT")
            if "excluded_see_results" not in columns:
                self.db.execute("ALTER TABLE polls ADD COLUMN excluded_see_results INTEGER NOT NULL DEFAULT 1")

            lib_cols = {r["name"] for r in self.db.execute("PRAGMA table_info(question_library)")}
            if "mode_meta" not in lib_cols:
                self.db.execute("ALTER TABLE question_library ADD COLUMN mode_meta TEXT")

            rep_cols = {r["name"] for r in self.db.execute("PRAGMA table_info(poll_reports)")}
            if "roster_summary" not in rep_cols:
                self.db.execute("ALTER TABLE poll_reports ADD COLUMN roster_summary TEXT NOT NULL DEFAULT ''")

            self.db.execute("UPDATE polls SET batch_id=id WHERE batch_id IS NULL")
            self.db.execute("CREATE INDEX IF NOT EXISTS polls_by_batch ON polls(batch_id)")
            # 旧版保留了原票和题目，但没有记录实际截止时刻。
            for batch in self.db.execute("""
                SELECT p.* FROM polls p LEFT JOIN poll_reports r ON r.batch_id=p.id
                WHERE p.id=p.batch_id AND p.phase IN ('closed','published') AND r.batch_id IS NULL AND p.history_deleted=0
                ORDER BY p.rowid
            """).fetchall():
                self._save_report(batch, None)

            # 新库初始化 4 位纯数字入场码；旧 6 位数据库自动升级为 4 位纯数字入场码。
            existing_code = self.db.execute("SELECT value FROM settings WHERE key='join_code'").fetchone()
            if existing_code is None:
                self.db.execute("INSERT INTO settings VALUES ('join_code', ?)", (random_join_code(),))
            elif not JOIN_CODE_RE.fullmatch(existing_code["value"]):
                self.db.execute("UPDATE settings SET value=? WHERE key='join_code'", (random_join_code(),))

            # 会场标识可公开，随数据库保留；入场码只用于 WebSocket 登记。
            self.db.execute("INSERT OR IGNORE INTO settings VALUES ('host_id', ?)", (secrets.token_hex(8),))
        settings = dict(self.db.execute("SELECT key, value FROM settings WHERE key IN ('host_id', 'join_code')"))
        self.join_code = settings["join_code"]
        self.host_id = settings["host_id"]

    # ==================== 通用设置与参与名单辅助 ====================

    def _get_setting(self, key: str, default: str | None = None) -> str | None:
        row = self.db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return row["value"] if row else default

    def _set_setting(self, key: str, value: str):
        self.db.execute(
            "INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )

    @staticmethod
    def _parse_device_list(raw: str | None) -> list[str]:
        if not raw:
            return []
        try:
            parsed = json.loads(raw)
        except (TypeError, json.JSONDecodeError):
            return []
        if not isinstance(parsed, list):
            return []
        seen: set[str] = set()
        out: list[str] = []
        for item in parsed:
            if isinstance(item, str) and DEVICE_ID_RE.fullmatch(item) and item not in seen:
                seen.add(item)
                out.append(item)
        return out

    @staticmethod
    def _parse_mode_meta(raw: str | None) -> dict | None:
        if not raw:
            return None
        try:
            parsed = json.loads(raw)
        except (TypeError, json.JSONDecodeError):
            return None
        return parsed if isinstance(parsed, dict) else None

    @staticmethod
    def _normalize_roster_mode(raw: object) -> str:
        return raw if isinstance(raw, str) and raw in ROSTER_MODES else "all"

    def is_device_eligible_for_batch(self, batch: sqlite3.Row, device: str) -> bool:
        mode = self._normalize_roster_mode(batch["roster_mode"])
        if mode == "all":
            return True
        listed = set(self._parse_device_list(batch["roster_devices"]))
        if mode == "selected":
            return device in listed
        if device in listed:
            return False
        if not batch["roster_allow_late"] and batch["roster_eligible"] is not None:
            return device in set(self._parse_device_list(batch["roster_eligible"]))
        return True

    @staticmethod
    def format_roster_summary(
        mode: str,
        device_ids: list[str],
        allow_late: bool,
        eligible_snapshot: list[str] | None,
    ) -> str:
        if mode == "all":
            return "全员参与"
        if mode == "selected":
            return f"仅选中 {len(device_ids)} 台参与"
        if not allow_late and eligible_snapshot is not None:
            if device_ids:
                return f"排除 {len(device_ids)} 台 · 锁定 {len(eligible_snapshot)} 台参与"
            return f"锁定 {len(eligible_snapshot)} 台参与"
        return f"排除 {len(device_ids)} 台（其余参与）" if device_ids else "全员参与"

    def get_roster_config(self) -> dict:
        registered = {r["id"] for r in self.db.execute("SELECT id FROM devices")}
        mode = self._normalize_roster_mode(self._get_setting("roster_mode", "all"))
        device_ids = [d for d in self._parse_device_list(self._get_setting("roster_devices", "[]")) if d in registered]
        allow_late_raw = self._get_setting("roster_allow_late", "1")
        allow_late = True if mode == "all" else False if mode == "selected" else (allow_late_raw != "0")
        excluded_see_results = self._get_setting("excluded_see_results", "1") != "0"
        return {
            "mode": mode,
            "device_ids": [] if mode == "all" else device_ids,
            "allow_late_join": allow_late,
            "excluded_see_results": excluded_see_results,
        }

    def set_roster_config(self, data: dict):
        if not isinstance(data, dict):
            raise ValueError("参与设备配置格式无效")
        with self._locked_poll() as (batch, _):
            if batch and batch["phase"] != "published":
                raise ApiError("本轮投票进行中，参与名单已锁定；请等待公布结果后再调整下一轮参与设备", 409)
            current = self.get_roster_config()
            mode = current["mode"]
            if "mode" in data:
                if not isinstance(data["mode"], str) or data["mode"] not in ROSTER_MODES:
                    raise ValueError("参与设备模式无效")
                mode = data["mode"]
            registered = {r["id"] for r in self.db.execute("SELECT id FROM devices")}
            device_ids = list(current["device_ids"])
            if "device_ids" in data:
                raw_ids = data["device_ids"]
                if not isinstance(raw_ids, list):
                    raise ValueError("设备列表格式无效")
                seen: set[str] = set()
                cleaned: list[str] = []
                for item in raw_ids:
                    if not isinstance(item, str) or not DEVICE_ID_RE.fullmatch(item):
                        raise ValueError("包含无效的设备编号")
                    if item not in registered:
                        raise ValueError("列表中包含尚未登记或已移除的设备，请刷新后重试")
                    if item not in seen:
                        seen.add(item)
                        cleaned.append(item)
                device_ids = cleaned
            elif mode == "all":
                device_ids = []
            if mode == "all":
                device_ids = []

            allow_late = current["allow_late_join"]
            if "allow_late_join" in data:
                if type(data["allow_late_join"]) is not bool:
                    raise ValueError("中途加入选项格式无效")
                allow_late = data["allow_late_join"]
            if mode == "all":
                allow_late = True
            elif mode == "selected":
                allow_late = False

            excluded_see = current["excluded_see_results"]
            if "excluded_see_results" in data:
                if type(data["excluded_see_results"]) is not bool:
                    raise ValueError("旁观结果选项格式无效")
                excluded_see = data["excluded_see_results"]

            self._set_setting("roster_mode", mode)
            self._set_setting("roster_devices", json.dumps(device_ids))
            self._set_setting("roster_allow_late", "1" if allow_late else "0")
            self._set_setting("excluded_see_results", "1" if excluded_see else "0")

    def build_active_roster_state(
        self,
        batch: sqlite3.Row,
        all_device_ids: list[str],
        online_set: set[str],
    ) -> dict:
        mode = self._normalize_roster_mode(batch["roster_mode"])
        device_ids = self._parse_device_list(batch["roster_devices"])
        allow_late = True if mode == "all" else False if mode == "selected" else bool(batch["roster_allow_late"])
        excluded_see_results = batch["excluded_see_results"] != 0
        eligible_snapshot = (
            self._parse_device_list(batch["roster_eligible"])
            if batch["roster_eligible"] is not None
            else None
        )

        if mode == "selected" or (mode == "exclude" and not allow_late and eligible_snapshot is not None):
            frozen = device_ids if mode == "selected" else (eligible_snapshot or [])
            frozen_set = set(frozen)
            eligible_total = len(frozen)
            eligible_online = sum(1 for d in online_set if d in frozen_set)
            excluded_count = sum(1 for d in all_device_ids if d not in frozen_set)
        else:
            eligible_total = 0
            eligible_online = 0
            excluded_count = 0
            for d in all_device_ids:
                if self.is_device_eligible_for_batch(batch, d):
                    eligible_total += 1
                    if d in online_set:
                        eligible_online += 1
                else:
                    excluded_count += 1

        return {
            "mode": mode,
            "locked": batch["phase"] != "published",
            "device_ids": device_ids,
            "allow_late_join": allow_late,
            "excluded_see_results": excluded_see_results,
            "eligible_total": eligible_total,
            "eligible_online": eligible_online,
            "excluded_count": excluded_count,
            "summary": self.format_roster_summary(mode, device_ids, allow_late, eligible_snapshot),
        }

    # ==================== 入场码改码与踢出/移除设备 ====================

    def rotate_join_code(self, raw_code: object = None) -> str:
        if raw_code is None or raw_code == "":
            next_code = random_join_code()
            if next_code == self.join_code:
                next_code = f"{(int(next_code) + 1) % 10000:04d}"
        else:
            if not isinstance(raw_code, str):
                raise ValueError("请输入 4 位纯数字入场码")
            cleaned = raw_code.strip()
            if not JOIN_CODE_RE.fullmatch(cleaned):
                raise ValueError("请输入 4 位纯数字入场码")
            if cleaned == self.join_code:
                return cleaned
            next_code = cleaned

        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            self._set_setting("join_code", next_code)
            # 更换新入场码后，之前按旧码记录的移出拦截自动清空。
            self.db.execute("DELETE FROM kicked_devices")
        self.join_code = next_code
        return next_code

    def is_kicked(self, device: str) -> bool:
        row = self.db.execute(
            "SELECT kicked_code FROM kicked_devices WHERE device_id=?",
            (device,),
        ).fetchone()
        if not row:
            return False
        if row["kicked_code"] == self.join_code:
            return True
        with self.db:
            self.db.execute("DELETE FROM kicked_devices WHERE device_id=?", (device,))
        return False

    def remove_device(self, device: object, *, record_kick: bool):
        if not isinstance(device, str) or not DEVICE_ID_RE.fullmatch(device):
            raise ValueError("设备编号无效")
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            existed = self.db.execute("SELECT 1 FROM devices WHERE id=?", (device,)).fetchone()
            if not existed and not record_kick:
                raise ValueError("该设备尚未登记")
            self.db.execute("DELETE FROM devices WHERE id=?", (device,))
            mapping = self.aliases()
            if device in mapping:
                mapping.pop(device, None)
                self._set_setting("device_aliases", json.dumps(mapping, ensure_ascii=False))
            roster_ids = self._parse_device_list(self._get_setting("roster_devices", "[]"))
            if device in roster_ids:
                cleaned = [d for d in roster_ids if d != device]
                self._set_setting("roster_devices", json.dumps(cleaned))
            if record_kick:
                self.db.execute(
                    """INSERT INTO kicked_devices(device_id, kicked_code, kicked_at_ms)
                       VALUES (?, ?, ?)
                       ON CONFLICT(device_id) DO UPDATE SET
                         kicked_code=excluded.kicked_code,
                         kicked_at_ms=excluded.kicked_at_ms""",
                    (device, self.join_code, clock_ms()),
                )

    # ==================== 自定义投票模式 ====================

    @staticmethod
    def _row_to_custom_mode(row: sqlite3.Row) -> dict:
        fixed_options = None
        if row["fixed_options"]:
            try:
                parsed = json.loads(row["fixed_options"])
                if isinstance(parsed, list):
                    fixed_options = [s for s in parsed if isinstance(s, str)]
            except (TypeError, json.JSONDecodeError):
                fixed_options = None
        try:
            rule = json.loads(row["rule_config"] or "{}")
            if not isinstance(rule, dict):
                rule = {}
        except (TypeError, json.JSONDecodeError):
            rule = {}
        mode = {
            "id": row["id"],
            "name": row["name"],
            "guide": row["guide"] or "",
            "base_kind": row["base_kind"],
            "fixed_options": fixed_options,
            "updated_at_ms": row["updated_at_ms"],
        }
        if row["base_kind"] == "approval":
            mode["yes_index"] = rule.get("yes_index", 0)
            mode["abstain_index"] = rule.get("abstain_index", None)
            mode["pass_pct"] = rule.get("pass_pct", 50)
            mode["pass_op"] = "gte" if rule.get("pass_op") == "gte" else "gt"
        elif row["base_kind"] == "rating":
            mode["weights"] = [w for w in (rule.get("weights") or []) if _is_finite_number(w)]
            mode["unit"] = rule.get("unit", "分") if isinstance(rule.get("unit"), str) else "分"
        return mode

    def list_custom_modes(self) -> list[dict]:
        rows = self.db.execute("SELECT * FROM custom_modes ORDER BY updated_at_ms DESC, rowid DESC").fetchall()
        return [self._row_to_custom_mode(r) for r in rows]

    def get_custom_mode(self, mode_id: str) -> dict | None:
        row = self.db.execute("SELECT * FROM custom_modes WHERE id=?", (mode_id,)).fetchone()
        return self._row_to_custom_mode(row) if row else None

    def save_custom_mode(self, data: dict) -> str:
        parsed = parse_custom_mode_input(data)
        raw_id = data.get("id")
        mode_id: str | None = None
        if raw_id not in (None, ""):
            if not isinstance(raw_id, str) or not HEX16_RE.fullmatch(raw_id):
                raise ValueError("自定义模式编号无效")
            mode_id = raw_id

        now = clock_ms()
        fixed_json = json.dumps(parsed["fixed_options"], ensure_ascii=False) if parsed["fixed_options"] is not None else None
        rule_json = json.dumps(parsed["rule_config"], ensure_ascii=False)
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            existing = self.db.execute("SELECT id, name FROM custom_modes").fetchall()
            for row in existing:
                if row["name"].lower() == parsed["name"].lower() and row["id"] != mode_id:
                    raise ApiError(f"已存在名为「{parsed['name']}」的自定义模式，请换一个名称", 409)
            if mode_id is not None:
                if not any(row["id"] == mode_id for row in existing):
                    raise ApiError("找不到要编辑的自定义模式，可能已被删除", 404)
                self.db.execute(
                    """UPDATE custom_modes
                       SET name=?, guide=?, base_kind=?, fixed_options=?, rule_config=?, updated_at_ms=?
                       WHERE id=?""",
                    (parsed["name"], parsed["guide"], parsed["base_kind"], fixed_json, rule_json, now, mode_id),
                )
                return mode_id
            if len(existing) >= MAX_CUSTOM_MODES:
                raise ValueError(f"最多保存 {MAX_CUSTOM_MODES} 个自定义投票模式，请先删除不需要的模式")
            next_id = secrets.token_hex(8)
            self.db.execute(
                """INSERT INTO custom_modes(id, name, guide, base_kind, fixed_options, rule_config, updated_at_ms)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (next_id, parsed["name"], parsed["guide"], parsed["base_kind"], fixed_json, rule_json, now),
            )
            return next_id

    def delete_custom_mode(self, raw_id: object):
        if not isinstance(raw_id, str) or not HEX16_RE.fullmatch(raw_id):
            raise ValueError("自定义模式编号无效")
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            deleted = self.db.execute("DELETE FROM custom_modes WHERE id=?", (raw_id,)).rowcount
            if not deleted:
                raise ApiError("找不到要删除的自定义模式", 404)

    # ==================== 设备备注 ====================

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
        if not isinstance(device, str) or not DEVICE_ID_RE.fullmatch(device):
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
            self._set_setting("device_aliases", json.dumps(mapping, ensure_ascii=False))
        return cleaned

    # ==================== 题库与投票核心 ====================

    def _latest(self):
        # 批次用首题编号标识，按插入顺序定位，避免电脑校时改变当前场次。
        return self.db.execute("SELECT * FROM polls WHERE id=(SELECT batch_id FROM polls ORDER BY rowid DESC LIMIT 1)").fetchone()

    def library_questions(self) -> list[dict]:
        rows = self.db.execute("""
            SELECT id,title,options,mode,mode_meta,correct_choice,revision
            FROM question_library ORDER BY updated_at_ms DESC,rowid DESC
        """)
        questions = []
        for row in rows:
            question = dict(row)
            question["options"] = json.loads(question["options"])
            meta = self._parse_mode_meta(question.pop("mode_meta", None))
            if meta is not None:
                question["mode_meta"] = meta
            questions.append(question)
        return questions

    def save_library_question(self, data: dict):
        question_id = data.get("id")
        revision = data.get("revision")
        if not isinstance(question_id, str) or not HEX16_RE.fullmatch(question_id):
            raise ValueError("题库编号无效")
        if revision is not None and (type(revision) is not int or revision < 1):
            raise ValueError("题库版本无效")
        entry = read_question(data, self.get_custom_mode)
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            current = self.db.execute(
                "SELECT title,options,mode,mode_meta,correct_choice,revision FROM question_library WHERE id=?",
                (question_id,),
            ).fetchone()
            if current is None:
                if revision is not None:
                    raise ValueError("找不到这道题，请返回题库再试")
                self.db.execute("""
                    INSERT INTO question_library(id,title,options,mode,mode_meta,correct_choice,revision,updated_at_ms)
                    VALUES (?,?,?,?,?,?,1,?)
                """, (question_id, *entry, clock_ms()))
                return
            if tuple(current)[:-1] == entry:
                # 保持重试幂等，已经保存的同一内容不另建题目或增加版本。
                return
            if revision != current["revision"]:
                raise ValueError("题库里的这道题已有新版本，请返回题库重新打开")
            self.db.execute("""
                UPDATE question_library
                SET title=?,options=?,mode=?,mode_meta=?,correct_choice=?,revision=revision+1,updated_at_ms=?
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
        mode = self._normalize_roster_mode(batch["roster_mode"])
        roster_ids = self._parse_device_list(batch["roster_devices"])
        allow_late = True if mode == "all" else False if mode == "selected" else bool(batch["roster_allow_late"])
        eligible_snapshot = (
            self._parse_device_list(batch["roster_eligible"])
            if batch["roster_eligible"] is not None
            else None
        )
        roster_summary = self.format_roster_summary(mode, roster_ids, allow_late, eligible_snapshot)
        self.db.execute("""
            INSERT INTO poll_reports(
                batch_id,title,started_at_ms,ended_at_ms,question_count,participants,total_votes,roster_summary,questions
            ) VALUES (?,?,?,?,?,?,?,?,?)
        """, (batch["id"], batch["title"], round(batch["created"] * 1000), ended_at_ms, len(questions),
              participants, sum(q["total"] for q in questions), roster_summary, json.dumps(questions, ensure_ascii=False)))

    def _finish(self, poll, phase, ended_at_ms):
        # 截止和统计同事务提交。后续公布或重发原票都不改写这份统计。
        self.db.execute("UPDATE polls SET phase=? WHERE batch_id=?", (phase, poll["id"]))
        if poll["phase"] == "open":
            self._save_report(poll, ended_at_ms)

    def history(self, before=None):
        query = """SELECT rowid AS cursor, batch_id AS id, title, started_at_ms, ended_at_ms,
                          question_count, participants, total_votes, roster_summary FROM poll_reports"""
        params = ()
        if before is not None:
            query += " WHERE rowid < ?"
            params = (before,)
        rows = []
        for row in self.db.execute(query + " ORDER BY rowid DESC LIMIT 21", params):
            item = dict(row)
            if not item.get("roster_summary"):
                item.pop("roster_summary", None)
            rows.append(item)
        return dict(reports=rows[:20], next_before=rows[19]["cursor"] if len(rows) > 20 else None)

    def delete_report(self, batch_id: object):
        if not isinstance(batch_id, str) or not HEX16_RE.fullmatch(batch_id):
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
                question_count, participants, total_votes, roster_summary, questions FROM poll_reports WHERE batch_id=?""",
                              (batch_id,)).fetchone()
        if row is None:
            return None
        report = dict(row)
        if not report.get("roster_summary"):
            report.pop("roster_summary", None)
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
            self._set_setting("device_limit", str(limit))

    def register(self, device: str):
        if not DEVICE_ID_RE.fullmatch(device):
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
                entries.append(read_question(question, self.get_custom_mode))
            except ValueError as exc:
                if len(questions) == 1:
                    raise
                raise ValueError(f"第 {i} 题：{exc}") from exc
        with self._locked_poll() as (poll, now):
            if poll and poll["phase"] != "published":
                raise ValueError("请先公布当前投票的结果，再发起新题")
            if "previous_id" in data and data["previous_id"] != (poll["id"] if poll else None):
                raise ValueError("当前投票已变更，请刷新后操作")

            registered_ids = [r["id"] for r in self.db.execute("SELECT id FROM devices ORDER BY id")]
            roster_cfg = self.get_roster_config()
            roster_mode = roster_cfg["mode"]
            raw_roster_ids = roster_cfg["device_ids"]
            frozen_roster_devices = "[]"
            frozen_allow_late = 1
            frozen_eligible: str | None = None
            frozen_excluded_see = 1 if roster_cfg["excluded_see_results"] else 0

            if roster_mode == "selected":
                if not raw_roster_ids:
                    raise ValueError("当前为「选中参与」模式，请至少选中 1 台投票器后再发起投票")
                frozen_roster_devices = json.dumps(raw_roster_ids)
                frozen_allow_late = 0
                frozen_eligible = json.dumps(raw_roster_ids)
            elif roster_mode == "exclude":
                frozen_roster_devices = json.dumps(raw_roster_ids)
                frozen_allow_late = 1 if roster_cfg["allow_late_join"] else 0
                if not frozen_allow_late:
                    excluded_set = set(raw_roster_ids)
                    remaining = [d for d in registered_ids if d not in excluded_set]
                    if not remaining:
                        raise ValueError("当前已排除全部设备且锁定名单，请取消排除至少 1 台或开启「允许中途新机加入」")
                    frozen_eligible = json.dumps(remaining)

            deadline = read_deadline(data, now)
            batch_id = secrets.token_hex(8)
            self.db.executemany(
                INSERT_OPEN_POLL,
                (
                    (
                        batch_id if i == 0 else secrets.token_hex(8),
                        *entry,
                        now / 1000,
                        deadline,
                        batch_id,
                        roster_mode,
                        frozen_roster_devices,
                        frozen_allow_late,
                        frozen_eligible,
                        frozen_excluded_see,
                    )
                    for i, entry in enumerate(entries)
                ),
            )

    def append_question(self, data: dict):
        entry = read_question(data, self.get_custom_mode)
        question_id = data.get("question_id")
        if not isinstance(question_id, str) or not HEX16_RE.fullmatch(question_id):
            raise ValueError("追加题目的编号无效")
        with self._locked_poll() as (batch, now):
            if not batch or batch["id"] != data.get("batch_id"):
                raise ValueError("场次已变更，请核对当前投票")
            # 浏览器为一次提交固定题号。重试复用原题，即使期间已截止或达到上限。
            existing = self.db.execute(
                "SELECT batch_id,title,options,mode,mode_meta,correct_choice FROM polls WHERE id=?",
                (question_id,),
            ).fetchone()
            if existing is not None:
                if question_id != batch["id"] and tuple(existing) == (batch["id"], *entry):
                    return
                raise ValueError("这个题号已用于其他内容，请重新添加")
            if batch["phase"] != "open":
                raise ValueError("本场已结束收票，不能追加题目")
            count = self.db.execute("SELECT COUNT(*) FROM polls WHERE batch_id=?", (batch["id"],)).fetchone()[0]
            if count >= MAX_BATCH_POLLS:
                raise ValueError(f"本场已达到 {MAX_BATCH_POLLS} 题上限")
            self.db.execute(
                INSERT_OPEN_POLL,
                (
                    question_id,
                    *entry,
                    now / 1000,
                    batch["deadline_at_ms"],
                    batch["id"],
                    batch["roster_mode"],
                    batch["roster_devices"],
                    batch["roster_allow_late"],
                    batch["roster_eligible"],
                    batch["excluded_see_results"],
                ),
            )

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
            if not poll or not batch:
                raise ValueError("题目已变更，本次提交未计票")
            if not self.is_device_eligible_for_batch(batch, device):
                raise ValueError("本轮未安排此设备参与，未计票")
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
        state: dict = {"v": 1, "type": "state", "poll": None}
        if device is None:
            state["server_now_ms"] = now
        if not batch:
            return state
        published = batch["phase"] == "published"
        if device is not None:
            eligible = self.is_device_eligible_for_batch(batch, device)
            if not eligible:
                if not published or batch["excluded_see_results"] == 0:
                    state["standby_reason"] = "excluded"
                    return state
                state["standby_reason"] = "observer"
        rows = self.db.execute("SELECT * FROM polls WHERE batch_id=? ORDER BY rowid", (batch["id"],)).fetchall()
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
            index = next((i for i, pid in enumerate(ids) if pid not in mine), len(rows) - 1)
        poll = rows[index]
        item = self._poll_item(poll, now, mine.get(poll["id"], -1), published)
        if len(rows) > 1:
            item["batch"] = {"index": index + 1, "count": len(rows), "answered": len(mine)}
            if published:
                item["batch"].update(next=ids[(index + 1) % len(rows)], prev=ids[index - 1])
        state["poll"] = item
        return state

    def _mode_fields(self, poll, counts):
        mode, correct_choice = poll["mode"], poll["correct_choice"]
        mode_meta = self._parse_mode_meta(poll["mode_meta"])
        fields = dict(
            mode=mode,
            correct_choice=correct_choice,
            mode_summary=mode_summary(mode, correct_choice, counts, mode_meta),
        )
        if mode_meta is not None:
            fields["mode_meta"] = mode_meta
        return fields

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
            if 0 <= choice < option_count:
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
                     "投票模式", "正确选项", "模式统计", "参与范围"])
    shared = [beijing(report["started_at_ms"]), beijing(report["ended_at_ms"]), report["participants"], report["total_votes"]]
    roster_label = report.get("roster_summary") or "全员参与"
    for number, question in enumerate(report["questions"], 1):
        total = question["total"]
        mode = question["mode"]
        mode_meta = question.get("mode_meta")
        correct_choice = question["correct_choice"]
        summary = question["mode_summary"]
        answer = chr(65 + correct_choice) if correct_choice is not None else ""
        stats = ""
        if mode == "approval":
            stats = "无有效表决票"
            if summary.get("approval_pct") is not None:
                outcome = "通过" if summary["passed"] else "未通过"
                abstain_note = "" if summary.get("has_abstain") is False else "（不计弃权）"
                threshold_note = ""
                if summary.get("pass_pct") is not None:
                    op_sym = "≥" if summary.get("pass_op") == "gte" else ">"
                    threshold_note = f' · 阈值 {op_sym}{summary["pass_pct"]}%'
                stats = f'{outcome} · 赞成率 {summary["approval_pct"]:.1f}%{abstain_note}{threshold_note}'
        elif mode == "rating":
            average = summary.get("average")
            unit = summary.get("unit", "分")
            suffix = f" {unit}" if unit else ""
            if average is None:
                stats = "暂无评分"
            else:
                total_score = summary.get("total_score")
                total_part = f" · 总计 {total_score}{suffix}" if total_score is not None else ""
                stats = f"平均 {average:.2f}{suffix}{total_part}"
        elif mode == "quiz":
            percent = summary.get("correct_pct")
            stats = f'答对 {summary["correct_count"]} 人 · 正确率 {percent:.1f}%' if percent is not None else "暂无作答"
        mode_label = (mode_meta or {}).get("name") or MODE_LABELS[mode]
        extra = [mode_label, answer, stats, roster_label]
        for i, (option, count) in enumerate(zip(question["options"], question["counts"])):
            percent = 100 * count / total if total else 0
            writer.writerow([*shared, number, cell(question["title"]), total, chr(65 + i), cell(option), count,
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

    async def broadcast(self) -> tuple[int, int]:
        # 单次广播读取最新快照；串行发送，避免截止/公布与落票快照乱序。
        async with self.broadcast_lock:
            items = list(self.clients.items())
            batch = self.store.current()
            results = await asyncio.gather(*(self.send_state(d, w) for d, w in items))
            total_sent = sum(1 for ok in results if ok)
            eligible_sent = sum(
                1
                for (d, _), ok in zip(items, results)
                if ok and (batch is None or self.store.is_device_eligible_for_batch(batch, d))
            )
            return total_sent, eligible_sent

    async def kick_device(self, device: object):
        if not isinstance(device, str) or not DEVICE_ID_RE.fullmatch(device):
            raise ValueError("设备编号无效")
        ws = self.clients.get(device)
        registered = self.store.db.execute("SELECT 1 FROM devices WHERE id=?", (device,)).fetchone()
        if ws is None and not registered:
            raise ValueError("该设备不在当前会场中")
        self.store.remove_device(device, record_kick=True)
        if ws is not None:
            self.clients.pop(device, None)
            self.viewed.pop(device, None)
            with suppress(Exception):
                if not ws.closed:
                    await ws.send_json({"v": 1, "type": "error", "message": "已被移出会场，长按确定可换码"})
                    await ws.close(code=1008, message=b"kicked")

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
            if not isinstance(candidate, str) or not DEVICE_ID_RE.fullmatch(candidate):
                raise ValueError("设备编号无效")
            if self.store.is_kicked(candidate):
                raise ValueError("已被移出会场，长按确定可换码")
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
                        if not isinstance(requested, str) or not HEX16_RE.fullmatch(requested):
                            raise ValueError("题目编号无效")
                        batch = self.store.current()
                        if not batch or batch["phase"] != "published" or not self.store.db.execute(
                                "SELECT 1 FROM polls WHERE id=? AND batch_id=?", (requested, batch["id"])).fetchone():
                            raise ValueError("请等待主持人公布本组结果")
                        if not self.store.is_device_eligible_for_batch(batch, device) and batch["excluded_see_results"] == 0:
                            raise ValueError("本轮未安排此设备查看结果")
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
        batch = self.store.current()
        device_rows = self.store.db.execute("SELECT * FROM devices ORDER BY id").fetchall()
        all_device_ids = [r["id"] for r in device_rows]
        online_set = set(self.clients.keys())
        roster = self.store.get_roster_config()
        roster_set = set(roster["device_ids"])
        active_roster = (
            self.store.build_active_roster_state(batch, all_device_ids, online_set)
            if batch is not None
            else None
        )
        is_round_locked = batch is not None and batch["phase"] != "published"

        state.update(
            join_code=self.store.join_code,
            nonce=self.admin_nonce,
            max_devices=self.store.device_limit(),
            device_limit_max=MAX_DEVICE_LIMIT,
            addresses=self.addresses,
            port=self.port,
            host_id=self.store.host_id,
            discovery_available=self.discovery is not None,
            max_batch_polls=MAX_BATCH_POLLS,
            supports_append=True,
            supports_modes=True,
            supports_question_library=True,
            supports_history_delete=True,
            supports_open_join=True,
            supports_rotate_join_code=True,
            supports_kick=True,
            supports_roster=True,
            supports_custom_modes=True,
            open_join_remaining_ms=self.open_join_remaining_ms(),
            open_join_until_ms=self.open_join_until_ms if self.open_join_active() else None,
            history_count=history_count,
            roster=roster,
            active_roster=active_roster,
            custom_modes=self.store.list_custom_modes(),
        )
        current_id = state["poll"]["id"] if state["poll"] else ""
        answered = dict(self.store.db.execute("SELECT v.device_id, COUNT(*) FROM votes v JOIN polls p ON p.id=v.poll_id "
                                               "WHERE p.batch_id=? GROUP BY v.device_id", (current_id,)))
        question_count = len(state["batch"]["polls"]) if "batch" in state else 1
        aliases = self.store.aliases()
        devices = []
        for r in device_rows:
            dev_id = r["id"]
            active_eligible = self.store.is_device_eligible_for_batch(batch, dev_id) if batch is not None else None
            if roster["mode"] == "all":
                next_eligible = True
            elif roster["mode"] == "selected":
                next_eligible = dev_id in roster_set
            else:
                next_eligible = dev_id not in roster_set
            devices.append(
                dict(
                    id=dev_id,
                    online=dev_id in online_set,
                    answered=answered.get(dev_id, 0),
                    voted=answered.get(dev_id, 0) == question_count,
                    alias=aliases.get(dev_id, ""),
                    eligible=bool(active_eligible) if is_round_locked else next_eligible,
                    active_eligible=active_eligible,
                )
            )
        state["devices"] = devices
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
            extra: dict = {}
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
                if not isinstance(device, str) or not DEVICE_ID_RE.fullmatch(device):
                    raise ValueError("设备编号无效")
                if device in self.clients:
                    raise ValueError("请先断开该设备，或直接使用踢出设备")
                self.store.remove_device(device, record_kick=False)
            elif action == "kick":
                await self.kick_device(data.get("device_id"))
            elif action == "alias":
                self.store.set_alias(data.get("device_id"), data.get("alias", ""))
            elif action == "device_limit":
                self.store.set_device_limit(data.get("limit"))
            elif action == "roster_config":
                self.store.set_roster_config(data)
            elif action == "custom_mode_save":
                extra["mode_id"] = self.store.save_custom_mode(data)
            elif action == "custom_mode_delete":
                self.store.delete_custom_mode(data.get("id"))
            elif action == "rotate_join_code":
                extra["join_code"] = self.store.rotate_join_code(data.get("code"))
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
            if action in (
                "alias",
                "device_limit",
                "roster_config",
                "custom_mode_save",
                "custom_mode_delete",
                "rotate_join_code",
                "kick",
                "forget",
                "library_save",
                "history_delete",
                "open_join",
            ):
                return web.json_response({"ok": True, **extra})
            _, eligible_sent = await self.broadcast()
            if action in ("create", "create_batch", "append_question"):
                return web.json_response({"ok": True, "pushed_to": eligible_sent})
            return web.json_response({"ok": True})
        except ApiError as exc:
            return web.json_response({"error": str(exc)}, status=exc.status)
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
