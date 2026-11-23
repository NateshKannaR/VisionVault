#!/usr/bin/env bash
set -eu

port="${1:-${PORT:-8000}}"
server_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
python_bin=python3
for candidate in "$server_dir/.venv/bin/python" "$server_dir/../.venv/bin/python" "$server_dir/venv/bin/python"; do
    if [[ -x "$candidate" ]]; then
        python_bin="$candidate"
        break
    fi
done

cd "$server_dir"
exec "$python_bin" -m uvicorn main:app --host 127.0.0.1 --port "$port" --no-proxy-headers --no-access-log --limit-concurrency 24
