#!/usr/bin/env sh
set -eu

porterminal_script_source=$0

# Resolve the real launcher location so this script can be invoked through a
# symlink installed in a directory on PATH.
case "$porterminal_script_source" in
    */*) ;;
    *)
        porterminal_script_source=$(command -v "$porterminal_script_source")
        ;;
esac

while [ -L "$porterminal_script_source" ]; do
    porterminal_link_dir=$(
        CDPATH= cd -P -- "$(dirname -- "$porterminal_script_source")" && pwd
    )
    porterminal_link_target=$(readlink "$porterminal_script_source")
    case "$porterminal_link_target" in
        /*)
            porterminal_script_source=$porterminal_link_target
            ;;
        *)
            porterminal_script_source=$porterminal_link_dir/$porterminal_link_target
            ;;
    esac
done

SCRIPT_DIR=$(CDPATH= cd -P -- "$(dirname -- "$porterminal_script_source")" && pwd)
COMMAND_NAME=${0##*/}
UV_BIN="$HOME/.local/bin/uv"
HOST="${PORTERMINAL_LOCALHOST_HOST:-127.0.0.1}"
PORT="${PORTERMINAL_LOCALHOST_PORT:-3444}"
CONFIG_FILE="$SCRIPT_DIR/.ptn/run-on-localhost.yaml"
SNIPPETS_FILE=""
PROMPT_PASSWORD=0

usage() {
    cat <<EOF
Usage: $COMMAND_NAME [options] [-- porterminal args...]

Runs Porterminal on the requested bind address and port.
No Tailscale Serve and no Cloudflare tunnel are started.
The default bind address is localhost-only: 127.0.0.1.

Options:
  -p, --password
                  Prompt for a one-time password for this session
  --host ADDRESS  Bind address (default: $HOST)
  --bind ADDRESS  Alias for --host
  --port PORT     Bind port (default: $PORT)
  --snippets PATH Path to a JSON snippets file for the Quick Commands modal
  --uv PATH       Path to uv (default: $HOME/.local/bin/uv)
  -h, --help      Show this help

Examples:
  $COMMAND_NAME
  $COMMAND_NAME --password
  $COMMAND_NAME --host 127.0.0.1 --port 3445
  $COMMAND_NAME --host 0.0.0.0 --port 3444
  $COMMAND_NAME --port 3445
  $COMMAND_NAME -- --verbose
EOF
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        -p|--password)
            PROMPT_PASSWORD=1
            shift
            ;;
        --host|--bind)
            if [ "$#" -lt 2 ]; then
                echo "Missing value for $1" >&2
                exit 1
            fi
            HOST="$2"
            shift 2
            ;;
        --port)
            if [ "$#" -lt 2 ]; then
                echo "Missing value for --port" >&2
                exit 1
            fi
            PORT="$2"
            shift 2
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

if [ -z "$HOST" ]; then
    echo "Host must not be empty" >&2
    exit 1
fi

case "$PORT" in
    ''|*[!0-9]*)
        echo "Port must be a number: $PORT" >&2
        exit 1
        ;;
esac

if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
    echo "Port must be between 1 and 65535: $PORT" >&2
    exit 1
fi

if [ ! -x "$UV_BIN" ]; then
    echo "uv not found at $UV_BIN" >&2
    echo "Install it with: python3 -m pip install --user uv" >&2
    exit 1
fi

mkdir -p "$SCRIPT_DIR/.ptn"

export UV_CACHE_DIR="${UV_CACHE_DIR:-$SCRIPT_DIR/.uv-cache}"
export UV_PYTHON_INSTALL_DIR="${UV_PYTHON_INSTALL_DIR:-$SCRIPT_DIR/.uv-python}"
export PORTERMINAL_CONFIG_PATH="$CONFIG_FILE"
export PORTERMINAL_SNIPPETS_PATH="$SNIPPETS_FILE"
export PORTERMINAL_ALLOW_SHUTDOWN=1

cd "$SCRIPT_DIR"

"$UV_BIN" run python - "$CONFIG_FILE" "$HOST" "$PORT" <<'PY'
from pathlib import Path
import sys

import yaml

config_path = Path(sys.argv[1])
host = sys.argv[2]
port = int(sys.argv[3])

if config_path.exists():
    data = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
else:
    data = {}

server = data.setdefault("server", {})
server["host"] = host
server["port"] = port

security = data.setdefault("security", {})
security.setdefault("require_password", False)
security.setdefault("max_auth_attempts", 5)

config_path.write_text(
    yaml.safe_dump(data, default_flow_style=False, sort_keys=False),
    encoding="utf-8",
)
PY

if [ "$PROMPT_PASSWORD" = "1" ]; then
    exec "$UV_BIN" run python -m porterminal --no-tunnel --password "$@"
fi

exec "$UV_BIN" run python -m porterminal --no-tunnel "$@"
