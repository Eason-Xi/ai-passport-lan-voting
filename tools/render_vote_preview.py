#!/usr/bin/env python3
"""编译实际固件界面与 LVGL 9.5，在主机生成截图并检查字库与内存。"""
import concurrent.futures
import hashlib
import os
import re
import struct
import subprocess
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "build" / "vote-preview"
LVGL = ROOT / "managed_components" / "lvgl__lvgl"
CONF = ROOT / "tools" / "vote_preview" / "lv_conf.h"


def png(path, width, height, data):
    def chunk(tag, body):
        block = tag + body
        return struct.pack(">I", len(body)) + block + struct.pack(">I", zlib.crc32(block) & 0xFFFFFFFF)
    scan = b"".join(b"\0" + data[y*width*3:(y+1)*width*3] for y in range(height))
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(scan)) + chunk(b"IEND", b""))


def main():
    assert LVGL.is_dir(), "请先构建固件以获取锁定的 LVGL"
    OUT.mkdir(parents=True, exist_ok=True)
    flags = ["-std=gnu11", "-O1", "-g0", f'-DLV_CONF_PATH="{CONF}"',
             f"-I{LVGL}", f"-I{ROOT / 'main'}"]
    identity = hashlib.sha256(CONF.read_bytes() + (ROOT / "dependencies.lock").read_bytes()).hexdigest()[:10]
    objdir = OUT / f"obj-{identity}"
    objdir.mkdir(exist_ok=True)
    source = sorted((LVGL / "src").rglob("*.c")) + [ROOT / f for f in [
        "main/vote_ui.c", "main/vote_model.c", "assets/fonts/vote_zh18.c", "tools/vote_preview/preview.c"]]
    def compile_file(file):
        obj = objdir / (str(file.relative_to(ROOT)).replace("/", "_") + ".o")
        vendor = file.is_relative_to(LVGL)
        if vendor and obj.exists() and obj.stat().st_mtime >= file.stat().st_mtime:
            return obj
        checks = [] if vendor else ["-Wall", "-Wextra", "-Werror"]
        result = subprocess.run(["cc", *flags, *checks, "-c", str(file), "-o", str(obj)], capture_output=True, text=True)
        if result.returncode: raise RuntimeError(result.stderr)
        return obj
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(os.cpu_count() or 4, 8)) as pool:
        objects = list(pool.map(compile_file, source))
    binary = OUT / "preview"
    subprocess.run(["cc", *map(str, objects), "-o", str(binary), "-lm"], check=True)
    result = subprocess.run([str(binary), str(OUT)], check=True, capture_output=True, text=True, timeout=60)
    print(result.stdout)
    (OUT / "report.txt").write_text(result.stdout)
    images = []
    for ppm in sorted(OUT.glob("*.ppm")):
        raw = ppm.read_bytes()
        head = re.match(rb"P6\s+(\d+)\s+(\d+)\s+255\s", raw)
        width, height = int(head[1]), int(head[2]); data = raw[head.end():]
        assert len(data) == width * height * 3
        png(ppm.with_suffix(".png"), width, height, data)
        images.append(data)
        ppm.unlink()
    columns = 5; rows = (len(images) + columns - 1) // columns
    width = columns * 240; height = rows * 320
    contact = bytearray(width * height * 3)
    for i, data in enumerate(images):
        for y in range(320):
            start = ((i // columns * 320 + y) * width + i % columns * 240) * 3
            contact[start:start+720] = data[y*720:(y+1)*720]
    png(OUT / "overview.png", width, height, contact)
    print(f"已生成 {len(images)} 个页面预览：{OUT}")


if __name__ == "__main__": main()
