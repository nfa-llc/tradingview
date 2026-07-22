#!/usr/bin/env bash
# Linux entry point for the gexbot TradingView v1.0 overlay.
set -u

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

printf '\n'
printf '  ========================================\n'
printf '    gexbot v1.0 - TradingView overlay\n'
printf '  ========================================\n\n'

# Prefer an explicit Node executable, then the normal Linux command names.
NODE_BIN="${IOF_NODE:-}"
if [[ -n "$NODE_BIN" ]]; then
    if [[ ! -x "$NODE_BIN" ]]; then
        printf '  [ERROR] IOF_NODE is not executable: %s\n' "$NODE_BIN" >&2
        exit 1
    fi
elif command -v node >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
elif command -v nodejs >/dev/null 2>&1; then
    NODE_BIN="$(command -v nodejs)"
else
    printf '  [ERROR] Node.js was not found.\n\n' >&2
    printf '  Install Node.js 22 or newer from https://nodejs.org and try again.\n' >&2
    exit 1
fi

NODE_VERSION="$("$NODE_BIN" -p 'process.versions.node' 2>/dev/null || true)"
NODE_MAJOR="${NODE_VERSION%%.*}"
if [[ ! "$NODE_MAJOR" =~ ^[0-9]+$ ]] || (( NODE_MAJOR < 22 )); then
    printf '  [ERROR] Node.js 22 or newer is required (found %s).\n' "${NODE_VERSION:-unknown}" >&2
    printf '  Install the current LTS release from https://nodejs.org and try again.\n' >&2
    exit 1
fi

for file in companion.js expiry-protobuf.js content.js injected.js panel.css platform/linux/start.sh platform/linux/launch-tradingview-debug.sh platform/linux/stop.sh; do
    if [[ ! -f "$SCRIPT_DIR/$file" ]]; then
        printf '  [ERROR] Missing file: %s\n' "$file" >&2
        printf '  Keep the complete cross-platform gexbot folder together.\n' >&2
        exit 1
    fi
done

if [[ -z "${IOF_API_KEY_PATH:-}" ]]; then
    API_KEY_FILE="$SCRIPT_DIR/api-key.txt"
    if [[ ! -s "$API_KEY_FILE" ]]; then
        for LEGACY_KEY_FILE in "$SCRIPT_DIR/gb-tradingview-linux/api-key.txt" "$SCRIPT_DIR/gb-tradingview-windows/api-key.txt"; do
            if [[ -f "$LEGACY_KEY_FILE" && ! -L "$LEGACY_KEY_FILE" ]] && grep -q '[^[:space:]]' "$LEGACY_KEY_FILE"; then
                (umask 077 && cp -- "$LEGACY_KEY_FILE" "$API_KEY_FILE") || exit 1
                chmod 600 "$API_KEY_FILE" || exit 1
                rm -f -- "$LEGACY_KEY_FILE"
                printf '  Migrated the existing API key into the shared package.\n'
                break
            fi
        done
    fi
    if [[ ! -e "$API_KEY_FILE" ]]; then
        (umask 077 && : >"$API_KEY_FILE") || exit 1
    fi
    chmod 600 "$API_KEY_FILE" || exit 1
    if ! grep -q '[^[:space:]]' "$API_KEY_FILE"; then
        printf '  [WARNING] API key is not configured.\n' >&2
        printf '  Edit %s, put the key on the first line, then run this launcher again.\n\n' "$API_KEY_FILE" >&2
        exit 1
    fi
fi

printf '  Node %s OK. Starting TradingView and the companion...\n\n' "$NODE_VERSION"
if ! IOF_NODE="$NODE_BIN" IOF_ROOT_DIR="$SCRIPT_DIR" "$SCRIPT_DIR/platform/linux/start.sh"; then
    printf '\n  [ERROR] Startup failed; see the message above.\n' >&2
    exit 1
fi

printf '\n  Done. The gexbot companion is running in the background.\n'
printf '  Close TradingView normally when finished; the companion will shut itself down.\n\n'
