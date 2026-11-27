"""用固件的 UDP 客户端连接真实主持服务，覆盖会场选择与地址变更。"""
import asyncio
import socket
import sys
import tempfile
import unittest
from pathlib import Path

from aiohttp import ClientSession, web

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "host"))
from server import VotingService


async def discover(port, *host_id):
    process = await asyncio.create_subprocess_exec(
        str(ROOT / "build/vote-tests/discovery"), str(port), *host_id,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    output, errors = await asyncio.wait_for(process.communicate(), 5)
    if process.returncode:
        raise AssertionError(errors.decode())
    return dict(line.split() for line in output.decode().splitlines())


class DiscoveryTests(unittest.IsolatedAsyncioTestCase):
    async def start(self, path):
        service = VotingService(path, discovery_port=0)
        runner = web.AppRunner(service.app())
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        service.port = site._server.sockets[0].getsockname()[1]
        return service, runner, service.discovery.get_extra_info("sockname")[1]

    async def test_manual_address_if_discovery_port_busy(self):
        with tempfile.TemporaryDirectory() as tmp, socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as occupied:
            occupied.bind(("0.0.0.0", 0))
            host = VotingService(Path(tmp) / "votes.sqlite3", discovery_port=occupied.getsockname()[1])
            runner = web.AppRunner(host.app())
            await runner.setup()
            try:
                self.assertIsNone(host.discovery)
                site = web.TCPSite(runner, "127.0.0.1", 0)
                await site.start()
                host.port = site._server.sockets[0].getsockname()[1]
                async with ClientSession() as client:
                    async with client.ws_connect(f"ws://127.0.0.1:{host.port}/ws") as ws:
                        await ws.send_json(dict(v=1,type="hello",device_id="aabbcc000001",code=host.store.join_code))
                        self.assertEqual((await ws.receive_json())["type"], "state")
            finally:
                await runner.cleanup()

    async def test_existing_room_and_moved_host(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "votes.sqlite3"
            host, runner, port = await self.start(path)
            room_id, code = host.store.host_id, host.store.join_code
            try:
                peers = await discover(port)
                self.assertEqual(peers, {room_id: f"ws://127.0.0.1:{host.port}/ws"})
                async with ClientSession() as session:
                    async with session.ws_connect(peers[room_id]) as ws:
                        await ws.send_json(dict(v=1,type="hello",device_id="aabbcc000001",code=code))
                        self.assertEqual((await ws.receive_json())["type"], "state")
            finally:
                await runner.cleanup()
            host, runner, port = await self.start(path)
            try:
                self.assertEqual(host.store.host_id, room_id)
                self.assertEqual(host.store.join_code, code)
                self.assertEqual(await discover(port, room_id), {room_id:f"ws://127.0.0.1:{host.port}/ws"})
            finally:
                await runner.cleanup()

    async def test_multiple_rooms_and_invalid_replies(self):
        class Rooms(asyncio.DatagramProtocol):
            def connection_made(self, transport):
                self.transport = transport

            def datagram_received(self, query, addr):
                if len(query) != 12 or query[:4] != b"GXV1":
                    return
                prefix = b"GXH1" + query[4:]
                for byte, port in [(1, 8765), (2, 9898), (1, 8765), (3, 0)]:
                    self.transport.sendto(prefix + bytes([byte]) * 8 + port.to_bytes(2, "big"), addr)
                self.transport.sendto(b"GXH1" + bytes(16) + b"\x22\x3d", addr)
                self.transport.sendto(prefix, addr)

        transport, _ = await asyncio.get_running_loop().create_datagram_endpoint(Rooms, local_addr=("127.0.0.1", 0))
        port = transport.get_extra_info("sockname")[1]
        try:
            peers = await discover(port)
            first, second = "01" * 8, "02" * 8
            self.assertEqual(peers, {first:"ws://127.0.0.1:8765/ws", second:"ws://127.0.0.1:9898/ws"})
            self.assertEqual(await discover(port, second), {second:peers[second]})
            self.assertEqual(await discover(port, "aa" * 8), {})
        finally:
            transport.close()

    async def test_discovery_open_join_flag(self):
        def probe(port, nonce):
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                sock.settimeout(2)
                sock.sendto(b"GXV2" + nonce, ("127.0.0.1", port))
                return sock.recvfrom(64)[0]

        with tempfile.TemporaryDirectory() as tmp:
            host, runner, port = await self.start(Path(tmp) / "votes.sqlite3")
            try:
                nonce = b"12345678"
                reply = await asyncio.to_thread(probe, port, nonce)
                self.assertEqual(len(reply), 23)
                self.assertEqual(reply[:12], b"GXH2" + nonce)
                self.assertEqual(reply[22], 0)
                host.set_open_join(60)
                reply_open = await asyncio.to_thread(probe, port, nonce)
                self.assertEqual(len(reply_open), 23)
                self.assertEqual(reply_open[22], 1)
                host.set_open_join(0)
                reply_closed = await asyncio.to_thread(probe, port, nonce)
                self.assertEqual(reply_closed[22], 0)
            finally:
                await runner.cleanup()


if __name__ == "__main__":
    unittest.main(verbosity=2)
