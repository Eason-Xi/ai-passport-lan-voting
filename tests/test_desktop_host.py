"""验证桌面客户端启动器核心逻辑（端口分配、服务线程启停、已有实例探测与 PNG 解码）。"""

from __future__ import annotations

import base64
import json
import socket
import sys
import tempfile
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from host.desktop import (  # noqa: E402
    HostServerThread,
    choose_port,
    decode_png_data_url,
    launch_desktop,
    probe_existing_host,
)


def pick_unused_port() -> int:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]
    finally:
        sock.close()


class DesktopHostTest(unittest.TestCase):
    def test_server_thread_lifecycle_and_reuse_detection(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "votes.sqlite3"
            port = pick_unused_port()
            server = HostServerThread(db, port, discovery_port=0)
            server.start()
            try:
                self.assertEqual(probe_existing_host(port), f"http://127.0.0.1:{port}/")
                chosen, reused = choose_port(port)
                self.assertEqual(chosen, port)
                self.assertEqual(reused, f"http://127.0.0.1:{port}/")
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/state", timeout=2) as resp:
                    self.assertEqual(resp.status, 200)
                    data = json.loads(resp.read().decode("utf-8"))
                    self.assertIn("join_code", data)
                    self.assertIn("history_count", data)
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=2) as resp:
                    self.assertEqual(resp.status, 200)
                    self.assertIn("大屏投屏", resp.read().decode("utf-8"))
            finally:
                server.stop()
            self.assertFalse(probe_existing_host(port))

    @unittest.skipUnless(socket.has_ipv6, "系统未启用 IPv6")
    def test_desktop_opens_existing_ipv6_host_without_starting_a_second_room(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"host_id":"0123456789abcdef","join_code":"123456"}')

            def log_message(self, *_args):
                pass

        class LoopbackServer(ThreadingHTTPServer):
            address_family = socket.AF_INET6

        try:
            server = LoopbackServer(("::1", 0), Handler)
        except OSError as exc:
            self.skipTest(f"系统无法绑定 IPv6 回环地址（{exc}）")
        with server:
            port = server.server_port
            with socket.socket() as blocker:
                # IPv4 同端口被另一个程序占用，IPv6 仍可访问原主持台。
                blocker.bind(("127.0.0.1", port))
                blocker.listen()
                thread = Thread(target=server.serve_forever, daemon=True)
                thread.start()
                try:
                    expected_url = f"http://[::1]:{port}/"
                    self.assertEqual(choose_port(port, strict=True), (port, expected_url))
                    frontend = Mock()
                    with tempfile.TemporaryDirectory() as tmp, \
                            patch.dict(sys.modules, {"webview": frontend}), patch("host.desktop.HostServerThread") as worker:
                        db = Path(tmp) / "unused" / "votes.sqlite3"
                        self.assertEqual(launch_desktop(port, db), 0)
                        worker.assert_not_called()
                        self.assertEqual(frontend.create_window.call_args.kwargs["url"], expected_url)
                        self.assertFalse(db.parent.exists())
                finally:
                    server.shutdown()
                    thread.join()

    def test_choose_port_fallback_when_occupied_by_other_process(self):
        blocker = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        blocker.bind(("0.0.0.0", 0))
        blocker.listen(1)
        busy_port = blocker.getsockname()[1]
        try:
            chosen, reused = choose_port(busy_port, strict=False)
            self.assertNotEqual(chosen, busy_port)
            self.assertFalse(reused)
            with self.assertRaises(RuntimeError):
                choose_port(busy_port, strict=True)
        finally:
            blocker.close()

    def test_decode_png_data_url(self):
        payload = b"\x89PNG\r\n\x1a\nfake"
        encoded = "data:image/png;base64," + base64.b64encode(payload).decode("ascii")
        self.assertEqual(decode_png_data_url(encoded), payload)
        with self.assertRaises(ValueError):
            decode_png_data_url("data:image/jpeg;base64,AAAA")


if __name__ == "__main__":
    unittest.main(verbosity=2)
