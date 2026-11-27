"""验证桌面客户端启动器核心逻辑（端口分配、服务线程启停、已有实例探测与 PNG 解码）。"""

from __future__ import annotations

import base64
import json
import socket
import sys
import tempfile
import unittest
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from host.desktop import (  # noqa: E402
    HostServerThread,
    choose_port,
    decode_png_data_url,
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
                self.assertTrue(probe_existing_host(port))
                chosen, reused = choose_port(port)
                self.assertEqual(chosen, port)
                self.assertTrue(reused)
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
