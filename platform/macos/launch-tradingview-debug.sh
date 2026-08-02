#!/usr/bin/env bash
# Closes TradingView and relaunches it with a local Chromium debugging port.
set -u
umask 077

PORT="${IOF_PORT:-}"
NODE_BIN="${IOF_NODE:-$(command -v node 2>/dev/null || true)}"
STATE_DIR="${IOF_STATE_DIR:-$HOME/Library/Logs/gexbot-tradingview-v1.0}"
TV_LOG="$STATE_DIR/tradingview.log"

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
    printf '[gexbot] Node.js was not found. Run the top-level launcher instead.\n' >&2
    exit 1
fi
if [[ -z "$PORT" ]]; then
    PORT="$("$NODE_BIN" -e '
        const net = require("net");
        const server = net.createServer();
        server.listen(0, "127.0.0.1", () => {
            process.stdout.write(String(server.address().port));
            server.close();
        });
        server.on("error", () => process.exit(1));
    ')" || exit 1
fi
if [[ ! "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
    printf '[gexbot] Invalid IOF_PORT: %s\n' "$PORT" >&2
    exit 1
fi

mkdir -p "$STATE_DIR"
if [[ ! -O "$STATE_DIR" ]]; then
    printf '[gexbot] Refusing to use a log directory not owned by the current user.\n' >&2
    exit 1
fi
chmod 700 "$STATE_DIR" || exit 1

# TRADINGVIEW_BIN can point at a TradingView app bundle or executable.
TV_MODE=""
TV_APP=""
TV_EXEC=""
TV_NAME=""
if [[ -n "${TRADINGVIEW_BIN:-}" ]]; then
    if [[ -d "$TRADINGVIEW_BIN" && "$TRADINGVIEW_BIN" == *.app ]]; then
        TV_MODE="app"
        TV_APP="$TRADINGVIEW_BIN"
        TV_NAME="$TRADINGVIEW_BIN"
    elif [[ -x "$TRADINGVIEW_BIN" ]]; then
        TV_MODE="executable"
        TV_EXEC="$TRADINGVIEW_BIN"
        TV_NAME="$TRADINGVIEW_BIN"
    else
        printf '[gexbot] TRADINGVIEW_BIN is not an app bundle or executable: %s\n' "$TRADINGVIEW_BIN" >&2
        exit 1
    fi
else
    for candidate in \
        /Applications/TradingView.app \
        "$HOME/Applications/TradingView.app" \
        /Applications/Setapp/TradingView.app; do
        if [[ -d "$candidate" ]]; then
            TV_APP="$candidate"
            break
        fi
    done
    if [[ -z "$TV_APP" ]] && command -v mdfind >/dev/null 2>&1; then
        TV_APP="$(mdfind 'kMDItemFSName == "TradingView.app" && kMDItemContentType == "com.apple.application-bundle"' 2>/dev/null | head -n 1)"
        [[ -d "$TV_APP" ]] || TV_APP=""
    fi
    if [[ -z "$TV_APP" ]]; then
        printf '[gexbot] TradingView Desktop was not found.\n' >&2
        printf '[gexbot] Install it in Applications or set TRADINGVIEW_BIN to its full path.\n' >&2
        exit 1
    fi
    TV_MODE="app"
    TV_NAME="$TV_APP"
fi

TV_PROCESS_NAME="TradingView"
if [[ "$TV_MODE" == "app" && -x /usr/libexec/PlistBuddy ]]; then
    BUNDLE_EXECUTABLE="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$TV_APP/Contents/Info.plist" 2>/dev/null || true)"
    [[ -z "$BUNDLE_EXECUTABLE" ]] || TV_PROCESS_NAME="$BUNDLE_EXECUTABLE"
elif [[ "$TV_MODE" == "executable" ]]; then
    TV_PROCESS_NAME="$(basename "$TV_EXEC")"
fi

printf '[gexbot] Closing TradingView...\n'
if command -v osascript >/dev/null 2>&1; then
    osascript -e 'tell application "TradingView" to quit' >/dev/null 2>&1 || true
fi
TV_PIDS="$(pgrep -x "$TV_PROCESS_NAME" 2>/dev/null || true)"
if [[ -n "$TV_PIDS" ]]; then
    kill $TV_PIDS 2>/dev/null || true
    for _ in {1..20}; do
        pgrep -x "$TV_PROCESS_NAME" >/dev/null 2>&1 || break
        sleep 0.25
    done
    TV_PIDS="$(pgrep -x "$TV_PROCESS_NAME" 2>/dev/null || true)"
    [[ -z "$TV_PIDS" ]] || kill -KILL $TV_PIDS 2>/dev/null || true
fi
sleep 1

printf '[gexbot] Starting %s with --remote-debugging-port=%s...\n' "$TV_NAME" "$PORT"
printf '%s TradingView launch\n' "$(date '+%Y-%m-%d %H:%M:%S')" >"$TV_LOG"

if [[ "$TV_MODE" == "app" ]]; then
    if ! open -n "$TV_APP" --args \
        "--remote-debugging-address=127.0.0.1" \
        "--remote-debugging-port=$PORT" \
        >>"$TV_LOG" 2>&1; then
        printf '[gexbot] macOS could not open %s.\n' "$TV_APP" >&2
        exit 1
    fi
    TV_PID=""
    for _ in {1..20}; do
        TV_PID="$(pgrep -n -x "$TV_PROCESS_NAME" 2>/dev/null || true)"
        [[ -z "$TV_PID" ]] || break
        sleep 0.1
    done
else
    nohup "$TV_EXEC" \
        "--remote-debugging-address=127.0.0.1" \
        "--remote-debugging-port=$PORT" \
        >>"$TV_LOG" 2>&1 </dev/null &
    TV_PID=$!
fi

if [[ -n "${IOF_TV_PID_FILE:-}" && -n "$TV_PID" ]]; then
    printf '%s\n' "$TV_PID" >"$IOF_TV_PID_FILE"
    chmod 600 "$IOF_TV_PID_FILE"
fi

# Use Node for the readiness probe so no other network tool is required.
debug_ready() {
    "$NODE_BIN" -e '
        const http = require("http");
        const req = http.get({host:"127.0.0.1", port:+process.argv[1], path:"/json/version", timeout:1000}, r => {
            r.resume(); process.exit(r.statusCode === 200 ? 0 : 1);
        });
        req.on("timeout", () => req.destroy());
        req.on("error", () => process.exit(1));
    ' "$PORT" >/dev/null 2>&1
}

for _ in {1..40}; do
    if debug_ready; then
        printf '[gexbot] Debug port %s is ready.\n' "$PORT"
        exit 0
    fi
    sleep 0.5
done

printf '[gexbot] TradingView did not open debug port %s within 20 seconds.\n' "$PORT" >&2
printf '[gexbot] TradingView launch log: %s\n' "$TV_LOG" >&2
if [[ -s "$TV_LOG" ]]; then
    printf '%s\n' '--- TradingView launch log ---' >&2
    tail -n 20 "$TV_LOG" >&2
fi
exit 1
