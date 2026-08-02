#!/usr/bin/env bash
# macOS entry point for the gexbot TradingView v1.0 overlay.
set -u

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

pause_after_error() {
    if [[ -t 0 ]]; then
        printf '\n  Press Return to close this window.'
        read -r _
    fi
}

fail() {
    printf '  [ERROR] %s\n' "$1" >&2
    pause_after_error
    exit 1
}

printf '\n'
printf '  ========================================\n'
printf '    gexbot v1.0 - TradingView overlay\n'
printf '  ========================================\n\n'

# Finder does not always provide the PATH from the user's interactive shell.
# Check common Node.js installation locations, including version managers.
NODE_BIN=""
NODE_VERSION=""
if [[ -n "${IOF_NODE:-}" ]]; then
    [[ -x "$IOF_NODE" ]] || fail "IOF_NODE is not executable: $IOF_NODE"
    NODE_BIN="$IOF_NODE"
    NODE_VERSION="$("$NODE_BIN" -p 'process.versions.node' 2>/dev/null || true)"
else
    NODE_CANDIDATES=()
    if command -v node >/dev/null 2>&1; then
        NODE_CANDIDATES+=("$(command -v node)")
    fi
    for candidate in \
        /opt/homebrew/bin/node \
        /usr/local/bin/node \
        /opt/local/bin/node \
        "$HOME/.volta/bin/node" \
        "$HOME/.asdf/shims/node" \
        "$HOME/.local/bin/node" \
        "$HOME/.local/share/mise/shims/node" \
        "$HOME"/.nvm/versions/node/*/bin/node \
        "$HOME"/.fnm/node-versions/*/installation/bin/node \
        "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node \
        "$HOME"/Library/Application\ Support/fnm/node-versions/*/installation/bin/node; do
        [[ -x "$candidate" ]] || continue
        NODE_CANDIDATES+=("$candidate")
    done

    FIRST_NODE_VERSION=""
    for candidate in "${NODE_CANDIDATES[@]}"; do
        candidate_version="$("$candidate" -p 'process.versions.node' 2>/dev/null || true)"
        candidate_major="${candidate_version%%.*}"
        if [[ -z "$FIRST_NODE_VERSION" && -n "$candidate_version" ]]; then
            FIRST_NODE_VERSION="$candidate_version"
        fi
        if [[ "$candidate_major" =~ ^[0-9]+$ ]] && (( candidate_major >= 22 )); then
            NODE_BIN="$candidate"
            NODE_VERSION="$candidate_version"
            break
        fi
    done

    if [[ -z "$NODE_BIN" ]]; then
        if [[ -n "$FIRST_NODE_VERSION" ]]; then
            printf '  [ERROR] Node.js 22 or newer is required (found %s).\n' "$FIRST_NODE_VERSION" >&2
        else
            printf '  [ERROR] Node.js was not found.\n' >&2
        fi
        printf '  Install the current LTS release from https://nodejs.org and try again.\n' >&2
        pause_after_error
        exit 1
    fi
fi

NODE_MAJOR="${NODE_VERSION%%.*}"
if [[ ! "$NODE_MAJOR" =~ ^[0-9]+$ ]] || (( NODE_MAJOR < 22 )); then
    printf '  [ERROR] Node.js 22 or newer is required (found %s).\n' "${NODE_VERSION:-unknown}" >&2
    printf '  Install the current LTS release from https://nodejs.org and try again.\n' >&2
    pause_after_error
    exit 1
fi

for file in app/companion.js app/expiry-protobuf.js app/content.js app/injected.js app/panel.css platform/macos/start.sh platform/macos/launch-tradingview-debug.sh; do
    if [[ ! -f "$SCRIPT_DIR/$file" ]]; then
        printf '  [ERROR] Missing file: %s\n' "$file" >&2
        printf '  Keep the complete cross-platform gexbot folder together.\n' >&2
        pause_after_error
        exit 1
    fi
done

if [[ -z "${IOF_API_KEY_PATH:-}" ]]; then
    API_KEY_FILE="$SCRIPT_DIR/api-key.txt"
    if [[ ! -e "$API_KEY_FILE" ]]; then
        (umask 077 && : >"$API_KEY_FILE") || fail "Could not create $API_KEY_FILE"
    fi
    chmod 600 "$API_KEY_FILE" || fail "Could not protect $API_KEY_FILE"
    if ! grep -q '[^[:space:]]' "$API_KEY_FILE"; then
        printf '  [WARNING] API key is not configured.\n' >&2
        printf '  Put the key on the first line of:\n  %s\n' "$API_KEY_FILE" >&2
        printf '  Save the file. Then run this launcher again.\n' >&2
        open -t "$API_KEY_FILE" >/dev/null 2>&1 || true
        pause_after_error
        exit 1
    fi
fi

printf '  Node %s OK. Starting TradingView and the companion...\n\n' "$NODE_VERSION"
if ! IOF_NODE="$NODE_BIN" IOF_ROOT_DIR="$SCRIPT_DIR" "$SCRIPT_DIR/platform/macos/start.sh"; then
    printf '\n  [ERROR] Startup failed. See the message above.\n' >&2
    pause_after_error
    exit 1
fi

printf '\n  Done. The gexbot companion is running in the background.\n'
printf '  Close TradingView normally when finished. The companion will shut down.\n\n'
sleep 4
