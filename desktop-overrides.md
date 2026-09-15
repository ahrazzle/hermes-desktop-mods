# Protean Desktop Overrides — Durable Mechanism (rev 6, 2026-08-30)

**Rev 6 change (per Shaka):** post-update re-derivation. The 2026-08-30
update rebuilt the bundle (index-Dh-pjnId.js → index-CkH99u3C.js); caps anchors
matched and were auto-reapplied by the watchdog; the slash anchor did not
(rc=3, ALERT). Re-derived from the new bundle: sendToGroupChat = `function Lye`,
anchor `let s=r||Bve();`, names remapped (append Sb→vb, $groupChats Zy→Hy,
update xb→_b, activity Pb→zb, driver Wye→Fye, mint Pve→Bve, memberKey wb→Sb,
durableMembers Hve→kb). Full log in `groupchat-mods-manifest.txt`.

**Rev 5 change (per Shaka):** corrected the group-slash dispatch semantics.
Rev 4 dispatched every slash command and posted the result — skill/send-type
commands (e.g. `/project-handoff-takeover`) returned scaffolding (`type:'skill'`)
that got rendered as a literal "Slash" entry while the room sat still. Now:
`exec`/`plugin` results post into the room as before; `skill`/`send`/`alias`/
error results fall through to the round driver (`Fye`/`Wye`), so the room members
receive the command text and act on it. This is what "slash = whole group chat"
means for skill commands.

**Rev 4 change (per Shaka):** group-room slash commands (local feature, no
upstream equivalent yet). New patcher `patch-groupchat-slash.py` wired into the
same watchdog; re-signs if either patcher lands a patch. Same exit contract
(0 = present, 1 = error, 3 = shape changed → ALERT).

**Rev 3 change (per Shaka):** watchdog now has a negative-check alert path. A bundle that matches NEITHER the upstream 3/10/2 pattern NOR the applied 999/999/999 pattern is treated as a shape change the watchdog cannot verify — it writes `~/.hermes/logs/protean-caps-watchdog.ALERT`, logs an ALERT line, fires a macOS notification, and exits 1. No-match is no longer a silent no-op.

## What was patched

**Group chat round/message caps** in the Hermes desktop app (Bot Mode bundled plugin):

- Live file: `~/.hermes/hermes-agent/apps/desktop/release/mac-arm64/Hermes.app/Contents/Resources/app.asar.unpacked/dist/assets/index-<hash>.js` (hash changes every build)
- Change: `var <A>=3,<B>=10,<C>=2,<D>=6;` → `<A>=999,<B>=999,<C>=999,<D>=6;`
- Meaning: rounds=3→999, messages=10→999, continuations=2→999. Members cap (6) unchanged.
- The asar entry is `unpacked: True` (stub in app.asar; content lives in app.asar.unpacked/). Patching the unpacked file is sufficient — do NOT repack the asar.
- Minifier renames constants each build (observed: `Zve` → `Fve`), so match by the VALUE pattern, never by variable name.
- Source seed (for rebuilds from this checkout): `apps/desktop/src/plugins/hermes-bots/plugin.js` lines ~6704-6711 (GROUP_CHAT_MAX_ROUNDS/MESSAGES/CONTINUATIONS = 999).

## Durable mechanism: launchd watchdog (AUTOMATIC)

`~/Library/LaunchAgents/com.protean.caps-watchdog.plist` → runs
`~/.hermes/scripts/protean-caps-watchdog.sh` at login + every hour:

1. Scans `app.asar.unpacked/dist/assets/index-*.js` for the upstream 3/10/2 value pattern.
2. If found (an update clobbered the override) → patches to 999/999/999, clears any stale ALERT, re-signs adhoc, verifies signature.
3. If already 999 (patched pattern) → no-op.
4. If a bundle exists but matches NEITHER pattern → ALERT (canary file + log + notification + exit 1) — build shape changed, caps unverified. This is the negative check: no-match is NOT success.

**Proven 2026-08-27:** simulated clobber → watchdog re-patched, re-signed, verified in ~1s.
Log: `~/.hermes/logs/protean-caps-watchdog.log`

## Group-room slash commands (rev 4, local feature)

Patcher: `~/.hermes/scripts/patch-groupchat-slash.py` (idempotent, marker `__GSPATCH`).
Anchor: `let s=r||Pve();` inside minified `sendToGroupChat` (unique; `Pve`=mintGroupThreadId).

Semantics (injected into `sendToGroupChat` — the single user-send choke point for rooms):

- `/cmd` (no mention) → `command.dispatch` against the default profile's session (via `session.list`, `resolved_id||id`), result posted as a `Slash` entry in the room thread.
- `/cmd @bot ...` → dispatch per mentioned member's session (`room.sessions[groupMemberKey(member)]`), one result entry per target. Mention tokens are stripped from the arg.
- The command text is appended as the user's message; the thread is minted; the round driver never starts (early return).
- Non-command `/`-starters (`/etc/hosts …`) pass through unchanged (regex `^\/[a-z][\w-]*(\s|$)`); commands with attachments pass through (can't dispatch a command with an image).
- Known limits: whole-room commands target the DEFAULT profile session — if none exists, posts guidance instead. CLI-only commands that `command.dispatch` rejects come back as an error entry. If upstream merges #94063 (slash rejection guard) before #91334 (composer reuse), the guard lands in the same function and will block dispatch until allow-listed — the watchdog will ALERT only if the anchor disappears, not if the guard wins.
- Bundle backup: `index-*.js.pre-group-slash.bak` beside the bundle.
- Test: restart the desktop app, then in a group room run `/status`, `/rollback`, `/model @<bot>`, `/steer do x @<bot>`. Results appear as `Slash` entries.

### Why source commits DON'T survive (verified in update_cmd.py)

- Desktop updater runs `hermes update --yes --gateway --keep-stash` → local edits stay parked in stash, never re-applied.
- On `main` with diverged history → `reset --hard origin/<branch>` (kills local commits).
- On a custom branch → auto-switch to target branch (commits kept on the branch but not built).
- No update-related hook event exists in the hooks system.
- => The watchdog is the only reliable re-apply path on this machine. An upstream PR making caps configurable would be the true architectural fix (Da Vinci's point) — revisit if/when upstream accepts config-driven group chat limits.

## Model/provider standard (nous / deepseek-v4-flash-0731)

All 8 profiles: `model.provider=nous`, `model.default=deepseek/deepseek-v4-flash-0731`,
`model.base_url=''`, no `model.key_env`, no `agent.max_turns`.
Stale VeniceAI `key_env` lives only inside provider definitions (dormant) — do not re-add
`model.key_env` at the top level or the empero alias will silently re-route traffic.

## Manual re-apply (if watchdog ever fails)

```bash
bash ~/.hermes/scripts/protean-caps-watchdog.sh
codesign --force --deep --sign - ~/.hermes/hermes-agent/apps/desktop/release/mac-arm64/Hermes.app
```
