"""共选局域网投票主持台 · 跨平台原生桌面客户端入口（macOS / Windows）。"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import platform
import socket
import subprocess
import sys
import threading
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

from aiohttp import web

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from host.server import VotingService  # noqa: E402

APP_TITLE = "共选 · 局域网投票主持台"
APP_STORAGE_NAME = "GongxuanVoting"


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def default_data_path() -> Path:
    if not is_frozen():
        return ROOT / "host" / "data" / "votes.sqlite3"
    system = platform.system()
    if system == "Darwin":
        base = Path.home() / "Library" / "Application Support" / APP_STORAGE_NAME
    elif system == "Windows":
        appdata = os.environ.get("APPDATA")
        base = Path(appdata) / APP_STORAGE_NAME if appdata else Path.home() / "AppData" / "Roaming" / APP_STORAGE_NAME
    else:
        xdg = os.environ.get("XDG_DATA_HOME")
        base = Path(xdg) / "gongxuan-voting" if xdg else Path.home() / ".local" / "share" / "gongxuan-voting"
    return base / "votes.sqlite3"


def probe_existing_host(port: int) -> bool:
    url = f"http://127.0.0.1:{port}/api/state"
    try:
        with urllib.request.urlopen(url, timeout=0.6) as resp:
            if resp.status != 200:
                return False
            data = json.loads(resp.read().decode("utf-8"))
            return isinstance(data, dict) and "join_code" in data and "host_id" in data
    except (OSError, ValueError, urllib.error.URLError):
        return False


def is_port_free(port: int) -> bool:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(("0.0.0.0", port))
        return True
    except OSError:
        return False
    finally:
        sock.close()


def choose_port(preferred: int, strict: bool = False) -> tuple[int, bool]:
    """返回 (port, reuse_existing)。若已有共选主持台运行在目标端口，直接复用。"""
    if is_port_free(preferred):
        return preferred, False
    if probe_existing_host(preferred):
        return preferred, True
    if strict:
        raise RuntimeError(f"端口 {preferred} 已被其他程序占用，请使用 --port 指定其他端口。")
    for candidate in range(preferred + 1, min(preferred + 50, 65535)):
        if is_port_free(candidate):
            return candidate, False
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(("0.0.0.0", 0))
        return sock.getsockname()[1], False
    finally:
        sock.close()


def decode_png_data_url(data_url: str) -> bytes:
    prefix = "data:image/png;base64,"
    if not isinstance(data_url, str) or not data_url.startswith(prefix):
        raise ValueError("无效的 PNG 图片数据")
    return base64.b64decode(data_url[len(prefix):])


class HostServerThread:
    """在后台独立线程运行 VotingService 的异步事件循环，供原生窗口直接访问。"""

    def __init__(self, data_path: Path, port: int, discovery_port: int | None = None):
        self.data_path = data_path
        self.port = port
        self.discovery_port = discovery_port
        self.service: VotingService | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._stop_event: asyncio.Event | None = None
        self._ready = threading.Event()
        self._error: BaseException | None = None
        self._thread = threading.Thread(target=self._run, name="gongxuan-host-server", daemon=True)

    def start(self, timeout: float = 10.0) -> None:
        self._thread.start()
        if not self._ready.wait(timeout):
            raise TimeoutError("本地主持服务启动超时")
        if self._error is not None:
            raise self._error

    def stop(self, timeout: float = 5.0) -> None:
        if self._loop and self._stop_event and not self._loop.is_closed():
            self._loop.call_soon_threadsafe(self._stop_event.set)
        self._thread.join(timeout=timeout)

    def _run(self) -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._loop = loop
        try:
            loop.run_until_complete(self._serve())
        except BaseException as exc:  # noqa: BLE001
            self._error = exc
            self._ready.set()
        finally:
            loop.close()

    async def _serve(self) -> None:
        self._stop_event = asyncio.Event()
        kwargs = {} if self.discovery_port is None else {"discovery_port": self.discovery_port}
        self.service = VotingService(self.data_path, self.port, **kwargs)
        runner = web.AppRunner(self.service.app(), access_log=None)
        await runner.setup()
        site = web.TCPSite(runner, "0.0.0.0", self.port)
        try:
            await site.start()
        except BaseException:
            await runner.cleanup()
            raise
        self._ready.set()
        try:
            await self._stop_event.wait()
        finally:
            await runner.cleanup()


class DesktopBridge:
    """暴露给前端页面的安全原生能力桥接（所有内部成员均以下划线隐藏）。"""

    def __init__(self, url: str, data_dir: Path):
        self._url = url
        self._data_dir = data_dir
        self._window = None
        self._fullscreen = False

    def bind_window(self, window) -> None:
        self._window = window

    def open_data_dir(self) -> bool:
        self._data_dir.mkdir(parents=True, exist_ok=True)
        system = platform.system()
        if system == "Darwin":
            subprocess.Popen(["open", str(self._data_dir)])
        elif system == "Windows":
            os.startfile(str(self._data_dir))  # type: ignore[attr-defined]
        else:
            subprocess.Popen(["xdg-open", str(self._data_dir)])
        return True

    def open_in_browser(self) -> bool:
        return webbrowser.open(self._url)

    def set_fullscreen(self, enable: bool) -> bool:
        target = bool(enable)
        if self._window is None or target == self._fullscreen:
            return self._fullscreen
        self._window.toggle_fullscreen()
        self._fullscreen = target
        return self._fullscreen

    def save_png(self, filename: str, data_url: str) -> bool:
        if self._window is None:
            return False
        import webview

        raw = decode_png_data_url(data_url)
        safe_name = Path(filename or "共选结果.png").name
        if not safe_name.lower().endswith(".png"):
            safe_name += ".png"
        target = self._window.create_file_dialog(
            webview.SAVE_DIALOG,
            directory=str(Path.home() / "Desktop"),
            save_filename=safe_name,
            file_types=("PNG 图片 (*.png)",),
        )
        if not target:
            return False
        dest = Path(target[0] if isinstance(target, (list, tuple)) else target)
        dest.write_bytes(raw)
        return True


def launch_desktop(port: int, data_path: Path, strict_port: bool = False) -> int:
    import webview

    chosen_port, reuse_existing = choose_port(port, strict=strict_port)
    url = f"http://127.0.0.1:{chosen_port}/"
    server_thread: HostServerThread | None = None

    if not reuse_existing:
        data_path.parent.mkdir(parents=True, exist_ok=True)
        server_thread = HostServerThread(data_path, chosen_port)
        server_thread.start()

    bridge = DesktopBridge(url, data_path.parent)
    window = webview.create_window(
        APP_TITLE,
        url=url,
        js_api=bridge,
        width=1280,
        height=840,
        min_size=(960, 640),
        background_color="#eff3ee",
        text_select=True,
    )
    bridge.bind_window(window)

    try:
        webview.start(debug=False)
    finally:
        if server_thread is not None:
            server_thread.stop()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="共选局域网投票主持台桌面客户端")
    parser.add_argument("--port", type=int, default=8765, help="监听端口（默认 8765）")
    parser.add_argument("--strict-port", action="store_true", help="端口被占用时不自动换端口")
    parser.add_argument("--data", type=Path, default=None, help="自定义 SQLite 数据库路径")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("端口须为 1～65535")
    data_path = args.data if args.data is not None else default_data_path()
    return launch_desktop(args.port, data_path, strict_port=args.strict_port)


if __name__ == "__main__":
    raise SystemExit(main())
