"""生成共选主持台高清应用图标（PNG / Windows ICO / macOS ICNS / 网页 favicon）。"""

from __future__ import annotations

import platform
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "desktop" / "assets"
FONT_PATH = ROOT / "assets" / "fonts" / "SourceHanSansSC-Regular.otf"
FAVICON_PATH = ROOT / "host" / "static" / "favicon.ico"


def render_master_icon(size: int = 1024) -> Image.Image:
    """绘制带有 macOS 风格安全留白与松翠渐变的 1024px 应用图标。"""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    # macOS 规范留白：约 80% 主体圆角方形，兼顾 Windows 与网页 icon 清晰度
    pad = int(size * 0.09)
    box = (pad, pad, size - pad, size - pad)
    radius = int((size - pad * 2) * 0.225)

    # 渐变松翠绿底板
    grad = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    px = grad.load()
    c_top = (29, 126, 105)
    c_bot = (14, 68, 56)
    span = max(1, (size - pad * 2))
    for y in range(pad, size - pad):
        t = (y - pad) / span
        r = int(c_top[0] + (c_bot[0] - c_top[0]) * t)
        g = int(c_top[1] + (c_bot[1] - c_top[1]) * t)
        b = int(c_top[2] + (c_bot[2] - c_top[2]) * t)
        for x in range(pad, size - pad):
            # 轻微左上至右下层次提亮
            dx = (x - pad) / span
            boost = int((0.5 - dx) * 10)
            px[x, y] = (
                max(0, min(255, r + boost)),
                max(0, min(255, g + boost)),
                max(0, min(255, b + boost)),
                255,
            )

    mask = Image.new("L", (size, size), 0)
    mdraw = ImageDraw.Draw(mask)
    mdraw.rounded_rectangle(box, radius=radius, fill=255)
    img.paste(grad, (0, 0), mask)

    # 细腻内描边 + 底部温暖光斑
    overlay = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    odraw = ImageDraw.Draw(overlay)
    odraw.rounded_rectangle(
        (pad + 6, pad + 6, size - pad - 6, size - pad - 6),
        radius=radius - 5,
        outline=(255, 255, 255, 42),
        width=6,
    )
    # 右下角小琥珀金投票点缀圆章（加松翠外圈分隔，与「共」字留出清爽呼吸空间）
    badge_d = int(size * 0.195)
    bx2 = size - pad - int(size * 0.065)
    by2 = size - pad - int(size * 0.065)
    bx1 = bx2 - badge_d
    by1 = by2 - badge_d
    ring = int(size * 0.018)
    odraw.ellipse((bx1 - ring, by1 - ring, bx2 + ring, by2 + ring), fill=(16, 75, 62, 255))
    odraw.ellipse((bx1, by1, bx2, by2), fill=(214, 146, 56, 255))
    # 白色勾选符号
    cx = (bx1 + bx2) / 2
    cy = (by1 + by2) / 2
    odraw.line(
        [
            (cx - badge_d * 0.22, cy + badge_d * 0.01),
            (cx - badge_d * 0.05, cy + badge_d * 0.18),
            (cx + badge_d * 0.24, cy - badge_d * 0.17),
        ],
        fill=(255, 255, 255, 255),
        width=max(4, int(size * 0.022)),
        joint="curve",
    )
    img = Image.alpha_composite(img, overlay)

    # 中央偏左上「共」字（使用仓库自带思源黑体，视觉均衡不与角标冲突）
    draw = ImageDraw.Draw(img)
    font = ImageFont.truetype(str(FONT_PATH), int(size * 0.41))
    bbox = draw.textbbox((0, 0), "共", font=font, stroke_width=7)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    tx = (size - tw) / 2 - bbox[0] - size * 0.04
    ty = (size - th) / 2 - bbox[1] - size * 0.045

    # 柔和文字投影
    draw.text((tx, ty + 10), "共", font=font, fill=(6, 36, 29, 95), stroke_width=7, stroke_fill=(6, 36, 29, 95))
    draw.text((tx, ty), "共", font=font, fill=(248, 252, 249, 255), stroke_width=7, stroke_fill=(248, 252, 249, 255))
    return img


def build_icns(master: Image.Image, target: Path) -> bool:
    if platform.system() != "Darwin" or not shutil.which("iconutil"):
        return False
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "icon.iconset"
        iconset.mkdir()
        sizes = [16, 32, 128, 256, 512]
        for s in sizes:
            master.resize((s, s), Image.Resampling.LANCZOS).save(iconset / f"icon_{s}x{s}.png")
            master.resize((s * 2, s * 2), Image.Resampling.LANCZOS).save(iconset / f"icon_{s}x{s}@2x.png")
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(target)], check=True)
    return True


def main() -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)
    master = render_master_icon(1024)
    png_path = ASSETS / "icon.png"
    ico_path = ASSETS / "icon.ico"
    icns_path = ASSETS / "icon.icns"

    master.save(png_path, format="PNG")
    master.save(ico_path, format="ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    master.save(FAVICON_PATH, format="ICO", sizes=[(16, 16), (32, 32), (48, 48)])
    icns_ok = build_icns(master, icns_path)
    print(f"Generated icons: PNG={png_path.name}, ICO={ico_path.name}, ICNS={'ok' if icns_ok else 'skipped'}")


if __name__ == "__main__":
    main()
