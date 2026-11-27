# -*- mode: python ; coding: utf-8 -*-
"""共选局域网投票主持台 PyInstaller 跨平台打包配置（macOS .app & Windows .exe）。"""

from pathlib import Path
import sys

SPEC_DIR = Path(SPECPATH).resolve()
REPO_ROOT = SPEC_DIR.parent
ASSETS_DIR = SPEC_DIR / "assets"

APP_NAME = "共选主持台"
IS_MAC = sys.platform == "darwin"
IS_WIN = sys.platform == "win32"

icon_file = None
if IS_MAC and (ASSETS_DIR / "icon.icns").exists():
    icon_file = str(ASSETS_DIR / "icon.icns")
elif IS_WIN and (ASSETS_DIR / "icon.ico").exists():
    icon_file = str(ASSETS_DIR / "icon.ico")

datas = [
    (str(REPO_ROOT / "host" / "static"), "host/static"),
]

hiddenimports = [
    "host.server",
    "aiohttp",
    "webview",
]
if IS_MAC:
    hiddenimports += [
        "webview.platforms.cocoa",
        "objc",
        "Foundation",
        "AppKit",
        "WebKit",
    ]
elif IS_WIN:
    hiddenimports += [
        "webview.platforms.edgechromium",
        "webview.platforms.winforms",
        "clr",
    ]

excludes = [
    "tkinter",
    "unittest",
    "pydoc",
    "doctest",
    "test",
    "PIL",
    "PyQt6",
    "PySide6",
    "matplotlib",
    "numpy",
]

a = Analysis(
    [str(REPO_ROOT / "host" / "desktop.py")],
    pathex=[str(REPO_ROOT)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    noarchive=False,
    optimize=1,
)

pyz = PYZ(a.pure)

if IS_MAC:
    exe = EXE(
        pyz,
        a.scripts,
        [],
        exclude_binaries=True,
        name=APP_NAME,
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=False,
        console=False,
        disable_windowed_traceback=False,
        argv_emulation=False,
        icon=icon_file,
    )
    coll = COLLECT(
        exe,
        a.binaries,
        a.datas,
        strip=False,
        upx=False,
        name=APP_NAME,
    )
    app = BUNDLE(
        coll,
        name=f"{APP_NAME}.app",
        icon=icon_file,
        bundle_identifier="com.folotoy.gongxuan.voting",
        info_plist={
            "CFBundleDisplayName": APP_NAME,
            "CFBundleName": APP_NAME,
            "CFBundleShortVersionString": "0.5.0",
            "CFBundleVersion": "0.5.0",
            "NSHighResolutionCapable": True,
            "NSLocalNetworkUsageDescription": "共选主持台需要访问局域网，用于自动发现并连接现场的投票器设备。",
            "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True},
        },
    )
else:
    exe = EXE(
        pyz,
        a.scripts,
        a.binaries,
        a.datas,
        [],
        name=APP_NAME,
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=False,
        console=False,
        disable_windowed_traceback=False,
        icon=icon_file,
    )
