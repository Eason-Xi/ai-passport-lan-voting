#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

if [ -d "dist/共选主持台.app" ] && [ "$#" -eq 0 ]; then
    open "dist/共选主持台.app"
    exit 0
fi

if [ ! -x .venv/bin/python ]; then
    echo '首次运行，正在创建 .venv 并安装主持服务依赖...'
    python3 -m venv .venv
    .venv/bin/python -m pip install -r host/requirements-lock.txt
fi

if [ "$#" -eq 0 ]; then
    (sleep 1 && open "http://127.0.0.1:8765") >/dev/null 2>&1 &
fi
exec .venv/bin/python host/server.py "$@"
