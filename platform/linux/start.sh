#!/usr/bin/env bash
# Starts TradingView in debug mode, then runs the gexbot companion as a daemon.
set -u
umask 077

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${IOF_ROOT_DIR:-$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)}"
NODE_BIN="${IOF_NODE:-$(command -v node 2>/dev/null || command -v nodejs 2>/dev/null || true)}"
RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp}/gexbot-tradingview-v1.0-$(id -u)"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/gexbot-tradingview-v1.0"
PID_FILE="$RUNTIME_DIR/companion.pid"
TV_PID_FILE="$RUNTIME_DIR/tradingview.pid"
COMPANION_LOG="$STATE_DIR/companion.log"

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
    printf '[gexbot] Node.js was not found. Run the top-level launcher instead.\n' >&2
    exit 1
fi

mkdir -p "$RUNTIME_DIR" "$STATE_DIR"
if [[ ! -O "$RUNTIME_DIR" || ! -O "$STATE_DIR" ]]; then
    printf '[gexbot] Refusing to use a runtime/state directory not owned by the current user.\n' >&2
    exit 1
fi
chmod 700 "$RUNTIME_DIR" "$STATE_DIR" || exit 1

# Use a fresh, unpredictable loopback port for each normal launch. This reduces
# exposure of Chromium's unauthenticated debugging endpoint. IOF_PORT remains
# available for controlled debugging environments that require a fixed port.
if [[ -z "${IOF_PORT:-}" ]]; then
    IOF_PORT="$($NODE_BIN -e '
        const net = require("net");
        const server = net.createServer();
        server.listen(0, "127.0.0.1", () => {
            process.stdout.write(String(server.address().port));
            server.close();
        });
        server.on("error", () => process.exit(1));
    ')" || exit 1
fi
export IOF_PORT
printf '%s\n' "$IOF_PORT" >"$RUNTIME_DIR/debug.port"
chmod 600 "$RUNTIME_DIR/debug.port"
printf '[gexbot] Selected random loopback debug port %s.\n' "$IOF_PORT"

# Stop the previous companion before reopening TradingView. Otherwise it could
# inject into the new window just before it is replaced by the new companion.
if [[ -r "$PID_FILE" ]]; then
    OLD_PID="$(<"$PID_FILE")"
    if [[ "$OLD_PID" =~ ^[0-9]+$ ]] && kill -0 "$OLD_PID" 2>/dev/null; then
        OLD_CMD="$(tr '\0' ' ' <"/proc/$OLD_PID/cmdline" 2>/dev/null || true)"
        if [[ "$OLD_CMD" == *companion.js* ]]; then
            printf '[gexbot] Stopping the previous companion (PID %s)...\n' "$OLD_PID"
            kill "$OLD_PID" 2>/dev/null || true
            for _ in {1..20}; do
                kill -0 "$OLD_PID" 2>/dev/null || break
                sleep 0.1
            done
            kill -0 "$OLD_PID" 2>/dev/null && kill -KILL "$OLD_PID" 2>/dev/null || true
        fi
    fi
    rm -f "$PID_FILE"
fi

IOF_TV_PID_FILE="$TV_PID_FILE" "$SCRIPT_DIR/launch-tradingview-debug.sh" || exit 1

printf '[gexbot] Starting the gexbot companion...\n'
printf '\n%s Companion launch\n' "$(date '+%Y-%m-%d %H:%M:%S')" >>"$COMPANION_LOG"
nohup env IOF_PORT="$IOF_PORT" IOF_PID_FILE="$PID_FILE" "$NODE_BIN" "$ROOT_DIR/companion.js" \
    >>"$COMPANION_LOG" 2>&1 </dev/null &
COMPANION_PID=$!
printf '%s\n' "$COMPANION_PID" >"$PID_FILE"

sleep 1
if ! kill -0 "$COMPANION_PID" 2>/dev/null; then
    rm -f "$PID_FILE"
    printf '[gexbot] The companion exited during startup. Log: %s\n' "$COMPANION_LOG" >&2
    tail -n 20 "$COMPANION_LOG" >&2
    exit 1
fi

printf '[gexbot] Ready (companion PID %s).\n' "$COMPANION_PID"
printf '[gexbot] Companion log: %s\n' "$COMPANION_LOG"
