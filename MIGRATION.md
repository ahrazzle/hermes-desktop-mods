# Migration — legacy internal labels to Protean labels

Earlier internal builds of this repo carried a private vendor namespace in their
launchd label and in the watchdog/log filenames. Public builds use the
`com.protean.*` namespace and `protean-*` filenames. This note tells an
existing install how to move onto the new labels.

The legacy namespace string itself is deliberately **not** reproduced here — it
is whatever your current plist already carries, and it should not be published
on this surface. Every command below discovers it by pattern instead.

## Label mapping

| Surface | Legacy pattern (what an old install has) | Protean label (what this repo ships) |
|---|---|---|
| launchd Label | `com.<legacy>.caps-watchdog` | `com.protean.caps-watchdog` |
| plist file | `com.<legacy>.caps-watchdog.plist` | `com.protean.caps-watchdog.plist` |
| watchdog script | `<legacy>-caps-watchdog.sh` | `protean-caps-watchdog.sh` |
| log | `~/.hermes/logs/<legacy>-caps-watchdog.log` | `~/.hermes/logs/protean-caps-watchdog.log` |
| alert canary | `~/.hermes/logs/<legacy>-caps-watchdog.ALERT` | `~/.hermes/logs/protean-caps-watchdog.ALERT` |

The two Python patchers (`patch-groupchat-caps.py`, `patch-groupchat-slash.py`)
are unbranded and keep their filenames; their logic is unchanged.

## 1. Find your legacy label

Any entry below that is **not** `com.protean.caps-watchdog` /
`protean-caps-watchdog.sh` is the legacy one:

    launchctl list | grep -i caps-watchdog
    ls ~/Library/LaunchAgents | grep -i caps-watchdog
    ls ~/.hermes/scripts | grep -i caps-watchdog

## 2. Remove the legacy agent and script

    LEGACY_PLIST=$(ls ~/Library/LaunchAgents | grep -i caps-watchdog | grep -v '^com\.protean\.' | head -1)
    [ -n "$LEGACY_PLIST" ] && launchctl unload ~/Library/LaunchAgents/"$LEGACY_PLIST" 2>/dev/null
    [ -n "$LEGACY_PLIST" ] && rm -f ~/Library/LaunchAgents/"$LEGACY_PLIST"

    LEGACY_SH=$(ls ~/.hermes/scripts | grep -i caps-watchdog | grep -v '^protean-' | head -1)
    [ -n "$LEGACY_SH" ] && rm -f ~/.hermes/scripts/"$LEGACY_SH"

## 3. Install the Protean agent + script

Follow `REAPPLY.md` Step 1 — it installs
`~/Library/LaunchAgents/com.protean.caps-watchdog.plist` and
`~/.hermes/scripts/protean-caps-watchdog.sh`.

## 4. Carry the old log forward (optional)

    LEGACY_LOG=$(ls ~/.hermes/logs | grep -i 'caps-watchdog\.log' | grep -v '^protean-' | head -1)
    [ -n "$LEGACY_LOG" ] && mv ~/.hermes/logs/"$LEGACY_LOG" ~/.hermes/logs/protean-caps-watchdog.log

## Notes

- Nothing patches the bundle during migration. The watchdog is idempotent, so
  the new agent re-applies the same override on its first scheduled run; to do
  it immediately, invoke it once as in `REAPPLY.md` Step 2.
- The exit contract is unchanged: 0 = present, 1 = error, 3 = build shape
  changed (ALERT).
