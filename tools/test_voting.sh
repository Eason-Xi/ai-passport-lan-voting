#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
voting_python="${VOTING_PYTHON:-.venv/bin/python}"
mkdir -p build/vote-tests
"${CC:-cc}" -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined -Imain \
    tests/test_vote_discovery.c main/vote_discovery.c main/vote_portal.c -o build/vote-tests/discovery
build/vote-tests/discovery
"${voting_python}" tests/test_voting_server.py
"${voting_python}" tests/test_vote_onboarding.py
if [[ -z "${IDF_PATH:-}" ]]; then
    echo "请先激活 ESP-IDF 5.5.3，以便用其 cJSON 编译真实固件解析器。" >&2
    exit 1
fi
# 上游 cJSON 单独编译；项目源码仍启用全部警告并视警告为错误。
"${CC:-cc}" -std=c11 -fsanitize=address,undefined -c \
    "${IDF_PATH}/components/json/cJSON/cJSON.c" -o build/vote-tests/cJSON.o
"${CC:-cc}" -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined \
    -Imain -I"${IDF_PATH}/components/json/cJSON" tests/test_vote_protocol.c \
    main/vote_protocol.c main/vote_model.c build/vote-tests/cJSON.o \
    -o build/vote-tests/protocol
build/vote-tests/protocol build/vote-wire.jsonl
build/vote-tests/protocol build/vote-timed-wire.jsonl
build/vote-tests/protocol build/vote-batch-wire.jsonl
build/vote-tests/protocol build/vote-append-wire.jsonl
build/vote-tests/protocol build/vote-modes-wire.jsonl
"${CC:-cc}" -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined \
    -Imain tests/test_vote_model.c main/vote_model.c main/vote_settings.c \
    -o build/vote-tests/model
build/vote-tests/model
