#!/usr/bin/env python3
"""生成投票字体和主机/固件共享字库范围，或检查生成产物一致性。"""
import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FONT_DIR = ROOT / "assets" / "fonts"
MANIFEST = FONT_DIR / "vote-font.json"


def ranges(points):
    result = []
    for cp in sorted(points):
        if result and cp == result[-1][1] + 1:
            result[-1][1] = cp
        else:
            result.append([cp, cp])
    return result


def generate(source, converter):
    from fontTools.ttLib import TTFont
    source = Path(source).resolve()
    cmap = TTFont(source).getBestCmap()
    points = set(range(32, 127))
    for high in range(0xA1, 0xF8):
        for low in range(0xA1, 0xFF):
            try:
                char = bytes([high, low]).decode("gb2312")
            except UnicodeDecodeError:
                continue
            if 0x4E00 <= ord(char) <= 0x9FFF:
                points.add(ord(char))
    # 排除会把行高撑到 34px 的竖排重复符和组合声调；保留横排常用标点。
    points |= {p for p in range(0x3000, 0x3020) if p in cmap}
    points |= {p for p in range(0xFF01, 0xFF5F) if p in cmap}
    points |= {ord(c) for c in "—–…‘’“”·×℃"}
    assert points <= cmap.keys(), "源字体缺字"
    FONT_DIR.mkdir(parents=True, exist_ok=True)
    output = FONT_DIR / "vote_zh18.c"
    points_ranges = ranges(points)
    spec = ",".join(f"0x{a:x}-0x{b:x}" for a, b in points_ranges)
    command = ["node", str(converter), "--font", str(source), "--range", spec,
               "--size", "18", "--bpp", "4", "--format", "lvgl", "--no-compress",
               "--lv-font-name", "vote_zh18", "--lv-include", "lvgl.h", "--output", str(output)]
    subprocess.run(command, check=True)
    # 转换器首部记录了本机绝对路径，改为可复现参数说明，避免提交环境路径。
    text = output.read_text()
    text = re.sub(r" \* Opts:.*", " * 生成参数：SourceHanSansSC-Regular.otf / 18px / 4bpp / 未压缩", text)
    output.write_text(text)
    coverage = {"family": "Source Han Sans SC 2.005", "size": 18, "bpp": 4, "count": len(points), "ranges": points_ranges}
    (ROOT / "host/static/font-coverage.json").write_text(json.dumps(coverage, ensure_ascii=False, separators=(",", ":")) + "\n")
    header = "// 自动生成的字库范围；请运行 tools/gen_vote_font.py。\n#pragma once\n#include <stdint.h>\nstatic const uint32_t VOTE_FONT_RANGES[][2] = {\n"
    header += "".join(f"    {{0x{a:04X}, 0x{b:04X}}},\n" for a, b in points_ranges) + "};\n"
    (ROOT / "main/vote_font_ranges.h").write_text(header)
    metadata = {"converter": "lv_font_conv 1.5.3", "source": source.name,
                "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "license": "SIL Open Font License 1.1", "count": len(points), "files": {}}
    for file in [output, ROOT / "main/vote_font_ranges.h", ROOT / "host/static/font-coverage.json"]:
        metadata["files"][str(file.relative_to(ROOT))] = hashlib.sha256(file.read_bytes()).hexdigest()
    MANIFEST.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")
    print(f"已生成 {len(points)} 字符的 18px 字体")


def check():
    manifest = json.loads(MANIFEST.read_text())
    for name, sha in manifest["files"].items():
        assert hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == sha, f"字体产物已变更：{name}"
    coverage = json.loads((ROOT / "host/static/font-coverage.json").read_text())
    points = {c for a, b in coverage["ranges"] for c in range(a, b + 1)}
    assert len(points) == manifest["count"]
    # 界面所有中文字面量都必须在同一个实际绑定的字体内。
    for file in [ROOT / "main/vote_ui.c", ROOT / "main/vote_net.c", ROOT / "main/main.c"]:
        for literal in re.findall(r'"([^"\n]*)"', file.read_text()):
            missing = {c for c in literal if ord(c) > 127 and ord(c) not in points}
            assert not missing, f"{file.name} 缺字：{missing}"
    print(f"中文字体产物与界面覆盖检查通过：{len(points)} 字符 / 18px；实际 cmap 在 LVGL 预览中逐字验证")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["generate", "check"])
    parser.add_argument("--font")
    parser.add_argument("--converter")
    args = parser.parse_args()
    if args.action == "generate":
        generate(args.font, args.converter)
    else:
        check()
