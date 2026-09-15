#!/bin/bash
# Protean caps watchdog — re-applies the group-chat cap override after any
# Hermes desktop app update clobbers it (updates replace the renderer bundle).
# Installed as a launchd LaunchAgent; runs at login + hourly.
#
# Override (delegated to patch-groupchat-caps.py): rounds=9999, messages=9999,
# continuations=9999 (members stays 6). The minifier (rolldown) INLINES the
# caps into the bundle as literal 3/10/2 at context-anchored sites — the old
# `var A=3,B=10,C=2,D=6;` declaration stopped existing when the bundler changed
# shape, which is why the previous regex-based watchdog went silent. The
# patcher detects the cap sites by structural anchor (stable against minifier
# variable renames) and reports rc=3 when no cap pattern matches at all.
#
# Failure mode (kept per Shaka): rc=3 (no cap pattern matched) means the
# build shape changed beyond recognition and the caps are UNVERIFIED — that is
# an ALERT (canary file + log + macOS notification), not a no-op.
set -u

APP_DIR="$HOME/.hermes/hermes-agent/apps/desktop/release/mac-arm64/Hermes.app"
ASSETS_DIR="$APP_DIR/Contents/Resources/app.asar.unpacked/dist/assets"
PATCHER="$HOME/.hermes/scripts/patch-groupchat-caps.py"
SLASH_PATCHER="$HOME/.hermes/scripts/patch-groupchat-slash.py"
LOG="$HOME/.hermes/logs/protean-caps-watchdog.log"
ALERT_FILE="$HOME/.hermes/logs/protean-caps-watchdog.ALERT"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }

alert() {
  # Durable signal: canary file + log line. Best-effort macOS notification.
  printf '%s ALERT %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"
  printf '%s\n' "$*" > "$ALERT_FILE"
  osascript -e "display notification \"$1\" with title \"Protean caps watchdog\"" 2>/dev/null || true
}

if [ ! -d "$ASSETS_DIR" ]; then
  log "no unpacked assets dir (app not installed?) — nothing to do"
  exit 0
fi
if [ ! -f "$PATCHER" ]; then
  alert "patcher $PATCHER missing"
  exit 1
fi
if [ ! -f "$SLASH_PATCHER" ]; then
  alert "slash patcher $SLASH_PATCHER missing"
  exit 1
fi

OUT="$(python3 "$PATCHER" 2>&1)"
RC=$?

case "$RC" in
  0)
    # Override present (patched or already applied) — override is healthy.
    log "$OUT"
    rm -f "$ALERT_FILE"
    NEED_SIGN=0
    # Only the upstream bundle needs re-signing; a patch landed iff PATCHED.
    if printf '%s' "$OUT" | grep -q '^PATCHED'; then
      NEED_SIGN=1
    fi
    # Group-slash patch (local feature): same contract, same exit codes.
    SOUT="$(python3 "$SLASH_PATCHER" 2>&1)"
    SRC=$?
    case "$SRC" in
      0)
        log "$SOUT"
        if printf '%s' "$SOUT" | grep -q '^PATCHED'; then
          NEED_SIGN=1
        fi
        ;;
      3)
        # Build shape changed; slash patch unverified — alert, don't assume.
        alert "$SOUT"
        exit 1
        ;;
      *)
        log "slash patcher error (rc=$SRC): $SOUT"
        alert "slash patcher error rc=$SRC — $SOUT"
        exit 1
        ;;
    esac
    if [ "$NEED_SIGN" = "1" ]; then
      if /usr/bin/codesign --force --deep --sign - "$APP_DIR" 2>>"$LOG"; then
        /usr/bin/codesign --verify --deep --strict "$APP_DIR" 2>>"$LOG" \
          && log "re-signed and verified" || log "re-signed but VERIFY FAILED"
      else
        log "codesign failed"
      fi
    fi
    ;;
  3)
    # Build shape changed; caps unverified — alert, don't assume.
    alert "$OUT"
    exit 1
    ;;
  *)
    # Real error (bundle missing, mid-patch abort, etc.)
    log "patcher error (rc=$RC): $OUT"
    alert "patcher error rc=$RC — $OUT"
    exit 1
    ;;
esac

exit 0
