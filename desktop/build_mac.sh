#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

VENV_DIR="${DESKTOP_VENV:-.venv-desktop}"
if [[ ! -x "${VENV_DIR}/bin/python" ]]; then
    echo "正在创建桌面打包虚拟环境 ${VENV_DIR}..."
    python3 -m venv "${VENV_DIR}"
    "${VENV_DIR}/bin/python" -m pip install -r desktop/requirements-desktop.txt
fi

echo "1/3 正在生成应用图标..."
"${VENV_DIR}/bin/python" desktop/gen_icons.py

echo "2/3 正在使用 PyInstaller 打包 macOS 原生客户端..."
"${VENV_DIR}/bin/pyinstaller" \
    --clean \
    --noconfirm \
    --distpath dist \
    --workpath build/pyinstaller \
    desktop/gongxuan.spec

APP_PATH="dist/共选主持台.app"
if [[ ! -d "${APP_PATH}" ]]; then
    echo "构建失败：未找到 ${APP_PATH}" >&2
    exit 1
fi

echo "3/3 正在执行本地 Ad-hoc 签名并生成便携压缩包..."
codesign --force --deep --sign - "${APP_PATH}"
ARCH="$(uname -m)"
ZIP_PATH="dist/共选主持台-macOS-${ARCH}.zip"
rm -f "${ZIP_PATH}"
ditto -c -k --sequesterRsrc --keepParent "${APP_PATH}" "${ZIP_PATH}"

echo "构建完成："
echo "  可直接双击打开：${REPO_ROOT}/${APP_PATH}"
echo "  可分发压缩包：  ${REPO_ROOT}/${ZIP_PATH}"
