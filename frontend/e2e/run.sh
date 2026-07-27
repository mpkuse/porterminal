#!/usr/bin/env bash
# Self-contained runner for the gesture e2e checks:
#   builds the frontend, starts a throwaway no-password server, runs the
#   Playwright checks against real Chrome, then tears the server down.
#
# Usage:
#   ./run.sh                 # build + start server + test + cleanup
#   SKIP_BUILD=1 ./run.sh    # skip the frontend rebuild
#
# Requires: uv (backend), google-chrome, and playwright resolvable from
# node_modules (npm install here, or it is linked from the npx cache below).
set -euo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$(cd "$E2E_DIR/.." && pwd)"
REPO_ROOT="$(cd "$FRONTEND_DIR/.." && pwd)"
PORT=9455
CONFIG="$E2E_DIR/ptn-e2e.yaml"
export PTN_URL="http://127.0.0.1:${PORT}/?e2e=1"

# --- resolve playwright ------------------------------------------------------
if [ ! -e "$E2E_DIR/node_modules/playwright" ]; then
    PW_NM="$(find "$HOME/.npm/_npx" -maxdepth 3 -type d -path '*/node_modules/playwright' 2>/dev/null | head -1)"
    if [ -n "$PW_NM" ]; then
        ln -sfn "$(dirname "$PW_NM")" "$E2E_DIR/node_modules"
        echo "linked playwright from npx cache: $PW_NM"
    else
        echo "playwright not found. Run:  (cd '$E2E_DIR' && npm install)" >&2
        exit 1
    fi
fi

kill_port() {
    local pid
    pid="$(ss -ltnp 2>/dev/null | grep ":${PORT} " | grep -oP 'pid=\K[0-9]+' | head -1 || true)"
    [ -n "${pid:-}" ] && kill "$pid" 2>/dev/null || true
}
cleanup() { kill_port; sleep 0.5; kill_port; }
trap cleanup EXIT

# --- build -------------------------------------------------------------------
if [ "${SKIP_BUILD:-0}" != "1" ]; then
    echo "building frontend..."
    (cd "$FRONTEND_DIR" && npm run build >/dev/null)
fi

# --- start server ------------------------------------------------------------
kill_port
echo "starting server on 127.0.0.1:${PORT}..."
( cd "$REPO_ROOT" && PORTERMINAL_CONFIG_PATH="$CONFIG" uv run ptn --no-tunnel ) \
    > "$E2E_DIR/.server.log" 2>&1 &

for _ in $(seq 1 40); do
    curl -sf -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null && break
    sleep 0.5
done
if ! curl -sf -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null; then
    echo "server failed to start; log:" >&2
    tail -20 "$E2E_DIR/.server.log" >&2
    exit 1
fi

# --- test --------------------------------------------------------------------
cd "$E2E_DIR"
set +e
node gestures.e2e.mjs; touch_rc=$?
echo
node dex.e2e.mjs; dex_rc=$?
set -e
[ "$touch_rc" -eq 0 ] && [ "$dex_rc" -eq 0 ]
