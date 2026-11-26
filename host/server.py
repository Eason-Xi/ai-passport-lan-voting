"""同一局域网的投票主持服务：串行处理状态，SQLite 事务保证首次落票唯一。"""

from __future__ import annotations

import argparse
import asyncio
import ipaddress
import json
import re
import secrets
import socket
import sqlite3
import time
from contextlib import contextmanager, suppress
from pathlib import Path

from aiohttp import WSMsgType, web

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "host" / "static"
MAX_DEVICES = 10
MAX_MESSAGE = 4096
MAX_DEADLINE_MS = 253402300799999  # 公历 9999 年末的 Unix 毫秒数。
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
                phase TEXT NOT NULL, created REAL NOT NULL, deadline_at_ms INTEGER
            );
            CREATE TABLE IF NOT EXISTS votes (
                poll_id TEXT NOT NULL, device_id TEXT NOT NULL, choice INTEGER NOT NULL,
                created REAL NOT NULL, PRIMARY KEY (poll_id, device_id)
            );
        """)
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            if "deadline_at_ms" not in {r["name"] for r in self.db.execute("PRAGMA table_info(polls)")}:
                self.db.execute("ALTER TABLE polls ADD COLUMN deadline_at_ms INTEGER")
            self.db.execute("INSERT OR IGNORE INTO settings VALUES ('join_code', ?)", (f"{secrets.randbelow(1000000):06d}",))
            # 会场标识可公开，随数据库保留；入场码只用于 WebSocket 登记。
            self.db.execute("INSERT OR IGNORE INTO settings VALUES ('host_id', ?)", (secrets.token_hex(8),))
        settings = dict(self.db.execute("SELECT key, value FROM settings WHERE key IN ('host_id', 'join_code')"))
        self.join_code = settings["join_code"]
        self.host_id = settings["host_id"]

    def _latest(self):
        # 以插入顺序选题，电脑离线校时不会令已结束的旧题重新成为当前题。
        return self.db.execute("SELECT * FROM polls ORDER BY rowid DESC LIMIT 1").fetchone()

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
                self.db.execute("UPDATE polls SET phase='closed' WHERE id=?", (poll["id"],))

    def current(self, now=None):
        poll = self._latest()
        if self._due(poll, clock_ms() if now is None else now):
            with self._locked_poll() as (poll, _):
                return poll
        return poll

    def register(self, device: str):
        if not re.fullmatch(r"[0-9a-f]{12}", device):
            raise ValueError("设备编号无效")
        if not self.db.execute("SELECT 1 FROM devices WHERE id=?", (device,)).fetchone():
            if self.db.execute("SELECT COUNT(*) FROM devices").fetchone()[0] >= MAX_DEVICES:
                raise ValueError("本场最多登记 10 台设备，请先在主持端移除闲置设备")
        with self.db:
            self.db.execute("INSERT INTO devices VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET seen=excluded.seen",
                            (device, time.time()))

    def create(self, data: dict):
        title = supported_text(data.get("title"), 60, "题目")
        raw = data.get("options")
        if not isinstance(raw, list) or not 2 <= len(raw) <= 6:
            raise ValueError("需要 2～6 个选项")
        options = [supported_text(o, 24, "选项") for o in raw]
        if len(set(options)) != len(options):
            raise ValueError("选项不能重复")
        with self._locked_poll() as (poll, now):
            if poll and poll["phase"] != "published":
                raise ValueError("请先公布当前题目的结果，再发起新题")
            deadline = read_deadline(data, now)
            self.db.execute("INSERT INTO polls (id, title, options, phase, created, deadline_at_ms) VALUES (?, ?, ?, 'open', ?, ?)",
                            (secrets.token_hex(8), title, json.dumps(options, ensure_ascii=False), now / 1000, deadline))

    def change_deadline(self, data: dict):
        with self._locked_poll() as (poll, now):
            if not poll or poll["id"] != data.get("poll_id"):
                raise ValueError("题目已变更，请刷新后操作")
            if poll["phase"] != "open":
                raise ValueError("投票已截止，不能修改截止时间")
            if "duration_seconds" not in data and "deadline_at_ms" not in data:
                raise ValueError("请选择截止方式")
            deadline = read_deadline(data, now)
            self.db.execute("UPDATE polls SET deadline_at_ms=? WHERE id=?", (deadline, poll["id"]))

    def transition(self, poll_id: object, phase: str):
        with self._locked_poll() as (poll, _):
            if not poll or poll["id"] != poll_id:
                raise ValueError("题目已变更，请刷新后操作")
            if phase == "closed" and poll["phase"] != "open":
                raise ValueError("当前题目已截止")
            if phase == "published" and poll["phase"] == "published":
                return
            self.db.execute("UPDATE polls SET phase=? WHERE id=?", (phase, poll_id))

    def vote(self, device: str, poll_id: object, choice: object):
        with self._locked_poll() as (poll, now):
            if not poll or poll_id != poll["id"]:
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
            self.db.execute("INSERT INTO votes VALUES (?, ?, ?, ?)", (poll_id, device, choice, now / 1000))

    def snapshot(self, device: str | None = None):
        now = clock_ms()
        poll = self.current(now)
        state = {"v": 1, "type": "state", "poll": None}
        if device is None:
            state["server_now_ms"] = now
        if not poll:
            return state
        options = json.loads(poll["options"])
        votes = list(self.db.execute("SELECT device_id, choice FROM votes WHERE poll_id=?", (poll["id"],)))
        item = dict(id=poll["id"], title=poll["title"], options=options, phase=poll["phase"], my_choice=-1)
        if poll["deadline_at_ms"] is not None:
            item["deadline_at_ms"] = poll["deadline_at_ms"]
            if poll["phase"] == "open":
                item["remaining_ms"] = max(0, poll["deadline_at_ms"] - now)
        for vote in votes:
            if vote["device_id"] == device:
                item["my_choice"] = vote["choice"]
        # 未公布前不向设备发送票数，防止通过协议提前窥见结果。
        if device is None or poll["phase"] == "published":
            item["counts"] = [sum(v["choice"] == i for v in votes) for i in range(len(options))]
            item["total"] = len(votes)
        state["poll"] = item
        return state


class HostDiscovery(asyncio.DatagramProtocol):
    def __init__(self, service):
        self.service = service

    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, message, address):
        if len(message) != 12 or message[:4] != b"GXV1":
            return
        ip = ipaddress.IPv4Address(address[0])
        if not any(ip in network for network in DISCOVERY_NETWORKS):
            return
        reply = b"GXH1" + message[4:] + bytes.fromhex(self.service.store.host_id)
        self.transport.sendto(reply + self.service.port.to_bytes(2, "big"), address)


class VotingService:
    def __init__(self, path: Path, port: int = 8765, discovery_port: int = DISCOVERY_PORT):
        self.store = Store(path)
        self.clients: dict[str, web.WebSocketResponse] = {}
        self.port = port
        self.admin_nonce = secrets.token_urlsafe(24)
        self.broadcast_lock = asyncio.Lock()
        self.addresses = []
        self.discovery_port = discovery_port
        self.discovery = None
        self.deadline_changed = asyncio.Event()
        self.deadline_task = None

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

    async def send_state(self, device: str, ws: web.WebSocketResponse):
        try:
            await asyncio.wait_for(ws.send_json(self.store.snapshot(device), dumps=lambda x: json.dumps(x, ensure_ascii=False)), 2)
        except (ConnectionError, RuntimeError, asyncio.TimeoutError):
            await ws.close()

    async def broadcast(self):
        # 单次广播读取最新快照；串行发送，避免截止/公布与落票快照乱序。
        async with self.broadcast_lock:
            await asyncio.gather(*(self.send_state(d, w) for d, w in list(self.clients.items())))

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
            code = data.get("code")
            if not isinstance(code, str) or not code.isascii() or not secrets.compare_digest(code, self.store.join_code):
                raise ValueError("入场码错误，请重新配网")
            candidate = data.get("device_id", "")
            if not isinstance(candidate, str):
                raise ValueError("设备编号无效")
            if candidate in self.clients and not self.clients[candidate].closed:
                raise ValueError("设备仍有旧连接，请稍后重连")
            self.store.register(candidate)
            device = candidate
            self.clients[device] = ws
            await self.send_state(device, ws)
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
                        await self.broadcast()
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
        state.update(join_code=self.store.join_code, nonce=self.admin_nonce, max_devices=MAX_DEVICES,
                     addresses=self.addresses, port=self.port, host_id=self.store.host_id,
                     discovery_available=self.discovery is not None)
        current_id = state["poll"]["id"] if state["poll"] else ""
        voted = {r[0] for r in self.store.db.execute("SELECT device_id FROM votes WHERE poll_id=?", (current_id,))}
        state["devices"] = [dict(id=r["id"], online=r["id"] in self.clients, voted=r["id"] in voted)
                            for r in self.store.db.execute("SELECT * FROM devices ORDER BY id")]
        return web.json_response(state)

    async def admin_action(self, request):
        self.admin_guard(request)
        try:
            data = await request.json()
            if not isinstance(data, dict):
                raise ValueError("请求格式无效")
            action = request.match_info["action"]
            if action == "create":
                self.store.create(data)
            elif action == "deadline":
                self.store.change_deadline(data)
            elif action in ("close", "publish"):
                self.store.transition(data.get("poll_id"), "closed" if action == "close" else "published")
            elif action == "forget":
                device = data.get("device_id")
                if not isinstance(device, str):
                    raise ValueError("设备编号无效")
                if device in self.clients:
                    raise ValueError("请先断开该设备")
                with self.store.db:
                    self.store.db.execute("DELETE FROM devices WHERE id=?", (device,))
            else:
                raise ValueError("操作无效")
            if action in ("create", "deadline", "close", "publish"):
                self.deadline_changed.set()
            await self.broadcast()
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
            "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'"})

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
        app = web.Application(client_max_size=MAX_MESSAGE)
        app.router.add_get("/ws", self.ws_device)
        app.router.add_get("/api/state", self.admin_state)
        app.router.add_post("/api/{action}", self.admin_action)
        app.router.add_get("/", self.static)
        app.router.add_get("/{name}", self.static)
        app.on_startup.append(self.read_addresses)
        app.on_shutdown.append(self.cleanup)
        return app


def lan_addresses(port):
    # 不向互联网发包；主机名解析提供候选地址，也允许用户手动查看网卡地址。
    try:
        addresses = sorted({item[4][0] for item in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)
                            if not ipaddress.ip_address(item[4][0]).is_loopback})
    except socket.gaierror:
        addresses = []
    return [f"ws://{ip}:{port}/ws" for ip in addresses]


def main():
    parser = argparse.ArgumentParser(description="局域网投票主持台（运行时无需互联网）")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--data", type=Path, default=ROOT / "host" / "data" / "votes.sqlite3")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("端口须为 1～65535")
    service = VotingService(args.data, args.port)
    print(f"主持台：http://127.0.0.1:{args.port}   入场码：{service.store.join_code}", flush=True)
    web.run_app(service.app(), host="0.0.0.0", port=args.port, access_log=None)


if __name__ == "__main__":
    main()
