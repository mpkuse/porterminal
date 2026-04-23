#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
UV_BIN="$HOME/.local/bin/uv"
PORT=3444
SERVE_WITH_TAILSCALE=1
TAILSCALE_URL=""
PORTERMINAL_PID=""
LOG_TAIL_PID=""
LOG_FILE=""
TAILSCALE_LOG_FILE=""
SNIPPETS_FILE=""

usage() {
    cat <<EOF
Usage: ./run-local.sh [options] [-- porterminal args...]

Runs Porterminal locally with --no-tunnel and optionally exposes it inside
your tailnet with Tailscale Serve.

Options:
  --no-tailscale-serve
                  Do not run tailscale serve; localhost only
  --snippets PATH Path to a JSON snippets file for the Quick Commands modal
  --uv PATH       Path to uv (default: $HOME/.local/bin/uv)
  -h, --help      Show this help

Examples:
  ./run-local.sh
  ./run-local.sh --no-tailscale-serve
  ./run-local.sh --snippets .ptn/snippets.json
  ./run-local.sh -- --verbose
EOF
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --no-tailscale-serve)
            SERVE_WITH_TAILSCALE=0
            shift
            ;;
        --snippets)
            if [ "$#" -lt 2 ]; then
                echo "Missing value for --snippets" >&2
                exit 1
            fi
            SNIPPETS_FILE="$2"
            shift 2
            ;;
        --uv)
            if [ "$#" -lt 2 ]; then
                echo "Missing value for --uv" >&2
                exit 1
            fi
            UV_BIN="$2"
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        --)
            shift
            break
            ;;
        *)
            break
            ;;
    esac
done

if [ ! -x "$UV_BIN" ]; then
    echo "uv not found at $UV_BIN" >&2
    echo "Install it with: python3 -m pip install --user uv" >&2
    exit 1
fi

export UV_CACHE_DIR="${UV_CACHE_DIR:-$SCRIPT_DIR/.uv-cache}"
export UV_PYTHON_INSTALL_DIR="${UV_PYTHON_INSTALL_DIR:-$SCRIPT_DIR/.uv-python}"

print_tailscale_qr() {
    url="$1"

    "$UV_BIN" run python -c '
import sys

import qrcode

url = sys.argv[1]
qr = qrcode.QRCode(border=1)
qr.add_data(url)
qr.make(fit=True)
qr.print_ascii(tty=False)
' "$url" || true
}

tailscale_url() {
    tailscale status --json 2>/dev/null | "$UV_BIN" run python -c '
import json
import sys

try:
    status = json.load(sys.stdin)
except json.JSONDecodeError:
    sys.exit(0)

dns_name = status.get("Self", {}).get("DNSName", "").rstrip(".")
if dns_name:
    print(f"https://{dns_name}")
'
}

start_tailscale_serve() {
    if [ "$SERVE_WITH_TAILSCALE" = "0" ]; then
        return
    fi

    if ! command -v tailscale >/dev/null 2>&1; then
        echo "tailscale not found; continuing with localhost only" >&2
        return
    fi

    TAILSCALE_LOG_FILE="$SCRIPT_DIR/.ptn/tailscale-serve.log"
    if tailscale serve --bg "$PORT" >"$TAILSCALE_LOG_FILE" 2>&1; then
        TAILSCALE_URL=$(tailscale_url || true)
        if [ -z "$TAILSCALE_URL" ]; then
            echo "Tailscale Serve is configured, but the tailnet URL could not be detected." >&2
            echo "Run: tailscale serve status" >&2
        fi
        return
    fi

    if grep -q "Access denied: serve config denied" "$TAILSCALE_LOG_FILE"; then
        echo "Tailscale needs elevated permission to configure Serve on this machine."
        echo "Running: sudo tailscale serve --bg $PORT"
        echo "Tip: run 'sudo tailscale set --operator=\$USER' once to avoid sudo next time."
        echo

        if sudo tailscale serve --bg "$PORT" >>"$TAILSCALE_LOG_FILE" 2>&1; then
            TAILSCALE_URL=$(tailscale_url || true)
            if [ -z "$TAILSCALE_URL" ]; then
                echo "Tailscale Serve is configured, but the tailnet URL could not be detected." >&2
                echo "Run: tailscale serve status" >&2
            fi
            return
        fi
    fi

    if [ -z "$TAILSCALE_URL" ]; then
        echo "tailscale serve failed; continuing with localhost only" >&2
        echo "Log: $TAILSCALE_LOG_FILE" >&2
        if grep -q "tailscaled.*not.*running" "$TAILSCALE_LOG_FILE"; then
            echo "tailscaled does not appear to be running." >&2
            echo "Try: sudo systemctl start tailscaled" >&2
        fi
        return
    fi
}

print_connect_info() {
    echo
    if [ -n "$TAILSCALE_URL" ]; then
        print_tailscale_qr "$TAILSCALE_URL"
        echo
        echo "Tailscale Serve URL:"
        echo "  $TAILSCALE_URL"
    else
        echo "Local URL:"
        echo "  http://127.0.0.1:$PORT"
    fi
    echo
    echo "Porterminal is running locally with --no-tunnel."
    echo "Press Ctrl+C to stop."
    echo
}

wait_for_porterminal() {
    python3 - "$PORT" <<'PY'
import sys
import time
import urllib.request

port = sys.argv[1]
url = f"http://127.0.0.1:{port}/health"
deadline = time.time() + 30

while time.time() < deadline:
    try:
        with urllib.request.urlopen(url, timeout=1) as response:
            if response.status == 200:
                sys.exit(0)
    except Exception:
        time.sleep(0.25)

sys.exit(1)
PY
}

stop_porterminal() {
    if [ -n "$LOG_TAIL_PID" ] && kill -0 "$LOG_TAIL_PID" 2>/dev/null; then
        kill "$LOG_TAIL_PID" 2>/dev/null || true
        wait "$LOG_TAIL_PID" 2>/dev/null || true
    fi

    if [ -n "$PORTERMINAL_PID" ] && kill -0 "$PORTERMINAL_PID" 2>/dev/null; then
        kill "$PORTERMINAL_PID" 2>/dev/null || true
        wait "$PORTERMINAL_PID" 2>/dev/null || true
    fi
}

start_porterminal() {
    LOG_FILE="$SCRIPT_DIR/.ptn/run-local.log"
    : > "$LOG_FILE"

    PORTERMINAL_CONFIG_PATH="$SCRIPT_DIR/.ptn/run-local.yaml" \
    PORTERMINAL_SNIPPETS_PATH="${SNIPPETS_FILE}" \
    PORTERMINAL_ALLOW_SHUTDOWN=1 \
        "$UV_BIN" run python -m porterminal --no-tunnel "$@" >"$LOG_FILE" 2>&1 &
    PORTERMINAL_PID=$!
    tail -n 0 -f "$LOG_FILE" &
    LOG_TAIL_PID=$!

    if ! wait_for_porterminal; then
        echo "Porterminal did not start on http://127.0.0.1:$PORT" >&2
        echo "Log: $LOG_FILE" >&2
        stop_porterminal
        exit 1
    fi
}

cd "$SCRIPT_DIR"
trap stop_porterminal INT TERM EXIT
start_porterminal "$@"
start_tailscale_serve
print_connect_info
wait "$PORTERMINAL_PID"
