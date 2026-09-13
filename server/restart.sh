#!/usr/bin/env bash
# restart.sh — stops whatever holds the server port, then starts a fresh FastAPI instance.
# Usage: ./server/restart.sh [PORT]

PORT="${1:-8000}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Kill any existing process holding the port
if command -v lsof >/dev/null 2>&1; then
    PIDS=$(lsof -ti tcp:"$PORT")
    if [ -n "$PIDS" ]; then
        echo "[server] Stopping process(es) on port $PORT: $PIDS"
        kill -9 $PIDS 2>/dev/null || true
    fi
elif command -v fuser >/dev/null 2>&1; then
    fuser -k "$PORT/tcp" 2>/dev/null || true
fi

# Wait briefly for socket release
sleep 0.5

# Detect python executable (venv in project root or server dir, otherwise system python3)
PYTHON="python3"
if [ -f "$DIR/.venv/bin/python" ]; then
    PYTHON="$DIR/.venv/bin/python"
elif [ -f "$DIR/venv/bin/python" ]; then
    PYTHON="$DIR/venv/bin/python"
elif [ -f "$DIR/../venv/bin/python" ]; then
    PYTHON="$DIR/../venv/bin/python"
fi

mkdir -p "$DIR/logs"
LOG="$DIR/logs/uvicorn.log"
ERR_LOG="$DIR/logs/uvicorn.log.err"

echo "[server] Starting VisionVault FastAPI server on port $PORT using $PYTHON..."
cd "$DIR"
nohup "$PYTHON" -m uvicorn main:app --host 127.0.0.1 --port "$PORT" > "$LOG" 2> "$ERR_LOG" &
PID=$!

# Wait and poll /health
for i in {1..25}; do
    sleep 0.5
    if command -v curl >/dev/null 2>&1; then
        RES=$(curl -s -m 2 "http://127.0.0.1:$PORT/health" 2>/dev/null || true)
        if [ -n "$RES" ]; then
            echo "[server] Server is live:"
            echo "$RES"
            exit 0
        fi
    fi
done

echo "[server] Server did not respond to /health; see $ERR_LOG"
tail -n 15 "$ERR_LOG" 2>/dev/null || true
exit 1
