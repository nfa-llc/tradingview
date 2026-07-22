#!/usr/bin/env bash
# Stops the companion and closes the debug-enabled TradingView session by default.
# Pass --companion-only only when you intentionally accept leaving CDP available.
set -u
umask 077

RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp}/gexbot-tradingview-v1.0-$(id -u)"
PID_FILE="$RUNTIME_DIR/companion.pid"
TV_PID_FILE="$RUNTIME_DIR/tradingview.pid"
STOPPED=false

if [[ -r "$PID_FILE" ]]; then
    PID="$(<"$PID_FILE")"
    if [[ "$PID" =~ ^[0-9]+$ ]] && kill -0 "$PID" 2>/dev/null; then
        CMD="$(tr '\0' ' ' <"/proc/$PID/cmdline" 2>/dev/null || true)"
        if [[ "$CMD" == *companion.js* ]]; then
            printf '[gexbot] Stopping companion PID %s...\n' "$PID"
            kill "$PID" 2>/dev/null || true
            for _ in {1..20}; do
                kill -0 "$PID" 2>/dev/null || break
                sleep 0.1
            done
            kill -0 "$PID" 2>/dev/null && kill -KILL "$PID" 2>/dev/null || true
            STOPPED=true
        fi
    fi
    rm -f "$PID_FILE"
fi
rm -f "$RUNTIME_DIR/debug.port"

if [[ "$STOPPED" == false ]]; then
    printf '[gexbot] No running companion was found.\n'
fi

if [[ "${1:-}" == "--companion-only" ]]; then
    printf '[gexbot] WARNING: TradingView remains open with its unauthenticated local debug endpoint.\n' >&2
else
    PIDS="$(pgrep -i -x tradingview 2>/dev/null || true)"
    if [[ -r "$TV_PID_FILE" ]]; then
        TV_PID="$(<"$TV_PID_FILE")"
        if [[ "$TV_PID" =~ ^[0-9]+$ ]] && kill -0 "$TV_PID" 2>/dev/null; then
            PIDS="$(printf '%s\n%s\n' "$PIDS" "$TV_PID" | awk 'NF && !seen[$0]++')"
        fi
    fi
    if [[ -n "$PIDS" ]]; then
        printf '[gexbot] Closing the debug-enabled TradingView session...\n'
        kill $PIDS 2>/dev/null || true
    fi
    rm -f "$TV_PID_FILE"
fi
