#!/usr/bin/env bash
# Closes TradingView and relaunches it with a local Chromium debugging port.
set -u
umask 077

PORT="${IOF_PORT:-}"
NODE_BIN="${IOF_NODE:-$(command -v node 2>/dev/null || command -v nodejs 2>/dev/null || true)}"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/gexbot-tradingview-v1.0"
CONFIG_DIR="${IOF_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/gexbot-tradingview-v1.0}"
SANDBOX_CONSENT_FILE="${GEXBOT_SANDBOX_CONSENT_FILE:-$CONFIG_DIR/allow-no-sandbox}"
TV_LOG="$STATE_DIR/tradingview.log"

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
    printf '[gexbot] Node.js was not found. Run the top-level launcher instead.\n' >&2
    exit 1
fi
if [[ -z "$PORT" ]]; then
    PORT="$($NODE_BIN -e '
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
    printf '[gexbot] Refusing to use a state directory not owned by the current user.\n' >&2
    exit 1
fi
chmod 700 "$STATE_DIR" || exit 1
mkdir -p "$CONFIG_DIR"
if [[ ! -O "$CONFIG_DIR" ]]; then
    printf '[gexbot] Refusing to use a config directory not owned by the current user.\n' >&2
    exit 1
fi
chmod 700 "$CONFIG_DIR" || exit 1

# TRADINGVIEW_BIN can point at an AppImage or a non-standard installation.
declare -a TV_CMD
TV_NAME=""
if [[ -n "${TRADINGVIEW_BIN:-}" ]]; then
    if [[ ! -x "$TRADINGVIEW_BIN" ]]; then
        printf '[gexbot] TRADINGVIEW_BIN is not executable: %s\n' "$TRADINGVIEW_BIN" >&2
        exit 1
    fi
    TV_CMD=("$TRADINGVIEW_BIN")
    TV_NAME="$TRADINGVIEW_BIN"
elif command -v tradingview >/dev/null 2>&1; then
    TV_CMD=("$(command -v tradingview)")
    TV_NAME="${TV_CMD[0]}"
elif [[ -x /opt/TradingView/tradingview ]]; then
    TV_CMD=(/opt/TradingView/tradingview)
    TV_NAME="${TV_CMD[0]}"
elif [[ -x /snap/bin/tradingview ]]; then
    TV_CMD=(/snap/bin/tradingview)
    TV_NAME="${TV_CMD[0]}"
else
    FLATPAK_ID="${TRADINGVIEW_FLATPAK_ID:-}"
    if [[ -z "$FLATPAK_ID" ]] && command -v flatpak >/dev/null 2>&1; then
        FLATPAK_ID="$(flatpak list --app --columns=application,name 2>/dev/null | awk 'tolower($0) ~ /tradingview/ { print $1; exit }')"
    fi
    if [[ -n "$FLATPAK_ID" ]] && command -v flatpak >/dev/null 2>&1; then
        TV_CMD=(flatpak run "$FLATPAK_ID")
        TV_NAME="Flatpak $FLATPAK_ID"
    else
        printf '[gexbot] TradingView Desktop was not found.\n' >&2
        printf '[gexbot] Set TRADINGVIEW_BIN=/full/path/to/tradingview and try again.\n' >&2
        exit 1
    fi
fi

# Disabling Chromium's sandbox avoids certain Linux packaging failures, but it
# reduces renderer isolation. An interactive "yes" is saved in the user-only
# config directory so the warning does not require approval on every startup.
save_no_sandbox_consent() {
    local temp_file="${SANDBOX_CONSENT_FILE}.tmp-$$"
    if printf '%s\n' 'allow-no-sandbox' >"$temp_file" &&
       chmod 600 "$temp_file" &&
       mv -f "$temp_file" "$SANDBOX_CONSENT_FILE"; then
        printf '[gexbot] Saved this choice in %s.\n' "$SANDBOX_CONSENT_FILE" >&2
        return 0
    fi
    rm -f "$temp_file"
    printf '[gexbot] Could not save the choice; it applies to this startup only.\n' >&2
    return 1
}

has_saved_no_sandbox_consent() {
    [[ -f "$SANDBOX_CONSENT_FILE" && ! -L "$SANDBOX_CONSENT_FILE" ]] || return 1
    [[ "$(<"$SANDBOX_CONSENT_FILE")" == "allow-no-sandbox" ]] || return 1
    chmod 600 "$SANDBOX_CONSENT_FILE" 2>/dev/null || true
}

request_no_sandbox_consent() {
    local reason="$1" answer=""

    case "${GEXBOT_ALLOW_NO_SANDBOX:-}" in
        1|true|TRUE|yes|YES)
            printf '[gexbot] Consent pre-approved by GEXBOT_ALLOW_NO_SANDBOX=1.\n' >&2
            return 0
            ;;
        0|false|FALSE|no|NO)
            printf '[gexbot] --no-sandbox was declined by GEXBOT_ALLOW_NO_SANDBOX.\n' >&2
            return 1
            ;;
    esac

    if has_saved_no_sandbox_consent; then
        printf '[gexbot] Using your previously saved approval for reduced sandboxing.\n' >&2
        return 0
    fi

    printf '\n[gexbot] SECURITY NOTICE: %s\n' "$reason" >&2
    printf '[gexbot] TradingView can run with --no-sandbox, but this reduces Chromium renderer isolation\n' >&2
    printf '[gexbot] for this TradingView session. It does not change system files or run as root.\n' >&2

    if [[ -t 0 ]]; then
        read -r -p "[gexbot] Continue with reduced sandboxing? [y/N] " answer
        case "${answer,,}" in
            y|yes)
                save_no_sandbox_consent || true
                return 0
                ;;
            *) return 1 ;;
        esac
    fi

    if [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]] && command -v zenity >/dev/null 2>&1; then
        if zenity --question \
            --title="gexbot TradingView security notice" \
            --text="$reason\n\nContinuing with --no-sandbox reduces Chromium renderer isolation for this TradingView session. It does not modify system files or run as root.\n\nContinue?" \
            --ok-label="Continue" --cancel-label="Cancel" 2>/dev/null; then
            save_no_sandbox_consent || true
            return 0
        fi
        return 1
    fi

    printf '[gexbot] No interactive prompt is available, so the safer default is to cancel.\n' >&2
    printf '[gexbot] After reviewing the risk, opt in with GEXBOT_ALLOW_NO_SANDBOX=1.\n' >&2
    return 1
}

# Electron normally uses a root-owned, setuid chrome-sandbox helper. Some Linux
# package moves, restores, and AppImage setups strip that mode. Detect the common
# case before closing an already-running TradingView instance.
declare -a TV_EXTRA_ARGS=()
USING_NO_SANDBOX=false
if (( ${#TV_CMD[@]} == 1 )); then
    TV_EXE="$(readlink -f -- "${TV_CMD[0]}" 2>/dev/null || printf '%s' "${TV_CMD[0]}")"
    SANDBOX_HELPER="$(dirname -- "$TV_EXE")/chrome-sandbox"
    if [[ -e "$SANDBOX_HELPER" ]]; then
        SANDBOX_UID="$(stat -Lc '%u' "$SANDBOX_HELPER" 2>/dev/null || printf '?')"
        SANDBOX_MODE="$(stat -Lc '%a' "$SANDBOX_HELPER" 2>/dev/null || printf '?')"
        if [[ "$SANDBOX_UID" != "0" || ! "$SANDBOX_MODE" =~ ^[4-7][0-7]{3}$ ]]; then
            SANDBOX_REASON="chrome-sandbox is not configured as setuid root (owner $SANDBOX_UID, mode $SANDBOX_MODE)."
            if request_no_sandbox_consent "$SANDBOX_REASON"; then
                TV_EXTRA_ARGS+=(--no-sandbox)
                USING_NO_SANDBOX=true
            else
                printf '[gexbot] Startup canceled; TradingView was not launched with --no-sandbox.\n' >&2
                exit 1
            fi
        fi
    fi
fi

printf '[gexbot] Closing TradingView...\n'
TV_PIDS="$(pgrep -i -x tradingview 2>/dev/null || true)"
if [[ -n "$TV_PIDS" ]]; then
    # Ask it to close normally first, then force only processes that remain.
    kill $TV_PIDS 2>/dev/null || true
    for _ in {1..20}; do
        pgrep -i -x tradingview >/dev/null 2>&1 || break
        sleep 0.25
    done
    TV_PIDS="$(pgrep -i -x tradingview 2>/dev/null || true)"
    [[ -z "$TV_PIDS" ]] || kill -KILL $TV_PIDS 2>/dev/null || true
fi
sleep 1

printf '[gexbot] Starting %s with --remote-debugging-port=%s...\n' "$TV_NAME" "$PORT"
printf '%s TradingView launch\n' "$(date '+%Y-%m-%d %H:%M:%S')" >"$TV_LOG"

launch_tradingview() {
    nohup "${TV_CMD[@]}" "${TV_EXTRA_ARGS[@]}" \
        "--remote-debugging-address=127.0.0.1" \
        "--remote-debugging-port=$PORT" \
        >>"$TV_LOG" 2>&1 </dev/null &
    TV_PID=$!
    if [[ -n "${IOF_TV_PID_FILE:-}" ]]; then
        printf '%s\n' "$TV_PID" >"$IOF_TV_PID_FILE"
        chmod 600 "$IOF_TV_PID_FILE"
    fi
}

# Use Node for the readiness probe so curl/wget is not another dependency.
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

wait_for_debug_port() {
    for _ in {1..40}; do
        debug_ready && return 0
        # A sandbox setup error is fatal and immediate; do not make the user wait
        # for the full timeout before the automatic retry below.
        if ! kill -0 "$TV_PID" 2>/dev/null && grep -qE 'SUID sandbox helper|No usable sandbox|setuid_sandbox_host' "$TV_LOG" 2>/dev/null; then
            return 1
        fi
        sleep 0.5
    done
    return 1
}

launch_tradingview
if wait_for_debug_port; then
    printf '[gexbot] Debug port %s is ready.\n' "$PORT"
    exit 0
fi

# Cover sandbox failures that cannot be found by the preflight check (notably
# some AppImages and distro-specific user-namespace restrictions), but obtain
# the same explicit consent before retrying with reduced isolation.
if [[ "$USING_NO_SANDBOX" == false ]] && grep -qE 'SUID sandbox helper|No usable sandbox|setuid_sandbox_host' "$TV_LOG" 2>/dev/null; then
    SANDBOX_REASON="The Linux Chromium sandbox prevented TradingView from starting."
    if request_no_sandbox_consent "$SANDBOX_REASON"; then
        printf '[gexbot] Retrying with the approved --no-sandbox compatibility fallback...\n'
        printf '%s\n' '--- consented --no-sandbox retry ---' >>"$TV_LOG"
        TV_EXTRA_ARGS+=(--no-sandbox)
        USING_NO_SANDBOX=true
        launch_tradingview
        if wait_for_debug_port; then
            printf '[gexbot] Debug port %s is ready.\n' "$PORT"
            exit 0
        fi
    else
        printf '[gexbot] Retry canceled; TradingView was not launched with --no-sandbox.\n' >&2
        exit 1
    fi
fi

printf '[gexbot] TradingView did not open debug port %s within 20 seconds.\n' "$PORT" >&2
printf '[gexbot] TradingView log: %s\n' "$TV_LOG" >&2
if [[ -s "$TV_LOG" ]]; then
    printf '%s\n' '--- last TradingView log lines ---' >&2
    tail -n 20 "$TV_LOG" >&2
fi
exit 1
