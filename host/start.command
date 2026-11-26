#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ ! -x .venv/bin/python ]; then
    echo '请先执行 python3 -m venv .venv，然后执行 .venv/bin/pip install -r host/requirements-lock.txt'
    exit 1
fi
exec .venv/bin/python host/server.py "$@"
