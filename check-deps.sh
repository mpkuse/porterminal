#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

MISSING_REQUIRED=0
WARNINGS=0

section() {
    printf '\n[%s]\n' "$1"
}

ok() {
    printf '  [OK] %s\n' "$1"
}

warn() {
    WARNINGS=$((WARNINGS + 1))
    printf '  [WARN] %s\n' "$1"
}

fail() {
    MISSING_REQUIRED=$((MISSING_REQUIRED + 1))
    printf '  [MISSING] %s\n' "$1"
}

command_exists() {
    command -v "$1" >/dev/null 2>&1
}

section "Repo"
if [ -d "$SCRIPT_DIR/.git" ]; then
    ok "git repository detected at $SCRIPT_DIR"
else
    warn "no .git directory found; assuming this is a copied checkout"
fi

if [ -x "$SCRIPT_DIR/run-local.sh" ]; then
    ok "run-local.sh is present and executable"
else
    fail "run-local.sh is missing or not executable"
fi

if [ -f "$SCRIPT_DIR/.ptn/run-local.yaml" ]; then
    ok "local config file found: .ptn/run-local.yaml"
else
    warn "local config file missing: .ptn/run-local.yaml"
fi

if [ -f "$SCRIPT_DIR/.ptn/snippets.json" ]; then
    ok "snippets file found: .ptn/snippets.json"
else
    warn "snippets file missing: .ptn/snippets.json"
fi

section "System"
if command_exists python3; then
    PYTHON_VERSION=$(python3 -c 'import sys; print(".".join(map(str, sys.version_info[:3])))')
    ok "python3 found ($PYTHON_VERSION)"
else
    fail "python3 not found"
fi

if command_exists uv; then
    ok "uv found ($(uv --version 2>/dev/null || echo "version unknown"))"
else
    fail "uv not found"
fi

if command_exists git; then
    ok "git found ($(git --version 2>/dev/null || echo "version unknown"))"
else
    warn "git not found"
fi

section "Tailscale"
if command_exists tailscale; then
    ok "tailscale CLI found"
    if tailscale status >/dev/null 2>&1; then
        ok "tailscale daemon is reachable"
    else
        warn "tailscale CLI exists, but 'tailscale status' failed"
    fi
else
    fail "tailscale not found"
fi

section "Python Package Runtime"
if command_exists uv; then
    if UV_CACHE_DIR="${UV_CACHE_DIR:-$SCRIPT_DIR/.uv-cache}" \
       UV_PYTHON_INSTALL_DIR="${UV_PYTHON_INSTALL_DIR:-$SCRIPT_DIR/.uv-python}" \
       uv run python -c '
import importlib.util
modules = [
    "fastapi",
    "uvicorn",
    "yaml",
    "pydantic",
    "rich",
    "qrcode",
    "bcrypt",
    "tyro",
]
missing = [name for name in modules if importlib.util.find_spec(name) is None]
if missing:
    raise SystemExit("missing:" + ",".join(missing))
' >/tmp/porterminal-check-deps.out 2>/tmp/porterminal-check-deps.err; then
        ok "required Python packages resolve via 'uv run'"
    else
        ERR_MSG=$(cat /tmp/porterminal-check-deps.err 2>/dev/null || true)
        case "$ERR_MSG" in
            missing:*)
                fail "missing Python modules via 'uv run': ${ERR_MSG#missing:}"
                ;;
            *)
                fail "could not verify Python modules via 'uv run' (${ERR_MSG%%$'\n'*})"
                ;;
        esac
    fi
else
    warn "skipped Python package runtime check because uv is missing"
fi

section "Optional"
if command_exists cloudflared; then
    ok "cloudflared found for upstream tunnel mode"
else
    warn "cloudflared not found; upstream public tunnel mode will not work"
fi

for shell_name in bash zsh fish nu; do
    if command_exists "$shell_name"; then
        ok "shell available: $shell_name"
    fi
done

section "Summary"
if [ "$MISSING_REQUIRED" -eq 0 ]; then
    ok "required checks passed"
else
    printf '  [FAIL] %s required check(s) missing\n' "$MISSING_REQUIRED"
fi

if [ "$WARNINGS" -eq 0 ]; then
    ok "no warnings"
else
    printf '  [WARN] %s warning(s)\n' "$WARNINGS"
fi

if [ "$MISSING_REQUIRED" -eq 0 ]; then
    printf '\nYou should be able to try:\n'
    printf '  ./run-local.sh --snippets .ptn/snippets.json\n'
    exit 0
fi

printf '\nFix the missing items above, then rerun:\n'
printf '  ./check-deps.sh\n'
exit 1
