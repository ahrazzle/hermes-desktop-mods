# Receipt — Stage 2: re-derived slash + caps patchers for post-#111283 bundle

Agent: mozi. Date: 2026-09-18 (EDT). Task: goal "Re-derive slash patcher + rewrite caps
regexes for post-111283 bundle" per aska-digital/hermes-desktop-mods#3 + hazen-brief-111283.md.

## Result

- COMMIT: 6504bfb1b26b2ffb9fb89e3c016d70f07314b6e0 on branch `mozi/111283-patcher-rewrite`
  (from origin/main c71a58e) in /Users/kethuda/Documents/github-repos/hermes-desktop-mods.
  NOT pushed (per constraints). hazen-brief-111283.md untouched/uncommitted (Stage 1 owns it).
- PATCHER EXIT CODES on the test copies of the installed bundle:
  - baseline reproduction with the OLD patchers (expected ALERT): caps rc=3, states
    [absent,absent,absent,upstream,absent,absent]; slash rc=3 — matches Proteus's live state.
  - NEW patch-groupchat-caps.py: fresh copy rc=0 (all 6 sites 3/10/2→9999); re-apply on the
    patched copy rc=0 (ALREADY PATCHED); re-apply on a slash+caps copy rc=0.
  - NEW patch-groupchat-slash.py: fresh copy rc=0; re-apply rc=0; on slash+caps copy rc=0.
  - Negative ALERT tests (each rc=3 with the file byte-UNCHANGED): head shape shifted;
    duplicated SITE-4 text (ambiguity detected as "ambiguous", not silently first-matched);
    queue tail replaced with the pre-#111283 direct-driver shape.

## Bundle path tested

- /tmp/dm111283-bundle/ — snapshot of the installed
  ~/.hermes/hermes-agent/apps/desktop/release/mac-arm64/Hermes.app/Contents/Resources/
  app.asar.unpacked/dist/assets/index-kkaHszuX.js
- pristine.js sha256 d1319273bb7478139a19d547686bacfaf21374de6459f2b65f37f9d0da22c101
  (= hazen brief §Provenance; live file re-verified byte-identical AFTER all testing —
  the installed bundle itself was never patched).
- Final patched copies: t-caps.js 27dd52cb…, t-slash.js 2b4908b4…, t-both.js a574cac3…
  (full shas in commit notes; slash-then-caps and caps-then-slash are BYTE-IDENTICAL —
  cmp verified — and every patched variant passes `node --check` as ESM).

## What changed and why (against brief verdict summary §1–6)

1. Anchor: kept ANCHOR+SNIPPET flow but ANCHOR is now CONSTRUCTED — 13 structural probes
   (function head with named parameter captures, then window/global probes referencing them)
   resolve every minified name at runtime (this build: Dj/oMe/rje/DA/GA/OA/nj/hMe/Qk/NA/FA/
   LA/q). Exact-one-match required everywhere; any miss => rc=3, zero writes. The letter
   churn the brief warns about ("letters WILL shift on the next rebuild") no longer costs a
   re-derivation round as long as the source shapes hold.
2. drive(): enqueues via the queue owner (probe-discovered from the `,queue(e,t,s),s}` tail),
   drops the old epoch bump; keeps the snippet's own queued activity record (early return
   still bypasses the body's). Zero direct round-driver calls — verified: 0 `pMe(` in the
   injected snippet, 1 `hMe(` (constraint "enqueue through the queue path" satisfied; the
   failedMembers 4th param is passed by the untouched upstream drain loop, which is the
   only remaining direct driver call — no direct call was left for us to pass it through).
3. Guard interception: `if(oMe(a))return null;` → `if(i&&i.length&&oMe(a))return null;` at
   the unique call site. Attachments-first ordering is load-bearing: oMe emits its warning
   toast as a SIDE EFFECT of being evaluated, so any order evaluating the guard on plain
   command text would toast on every intercepted /cmd (caught by the behavior harness).
   Upstream rejection semantics survive for command-shaped-with-attachments (harness T3)
   and the oMe function itself is untouched for any other door.
4. Session lookup: `sessions[gsk(thread,member)] || (hts(sessions,mk(member)) ? null :
   sessions[mk(member)])` — mirrors stopGroupThread's own pattern verbatim: thread-scoped
   key first, bare-key fallback ONLY when hasThreadScopedGroupSession proves the room/member
   never migrated (harness T5 + T5b cover both directions).
5. Caps regexes: all six sites rewritten with named captures + `(?P=x)` backreferences
   (Python 3.9-safe; `\k<name>` NOT used); sites now span pMe (1,2,6) + aMe (3,4,5); SITE 3
   re-anchored to the standalone `if(p.length&&c<=2){` gate per brief §5. Cap literals are
   capture groups `(3|9999)` style → single compiled pattern does upstream/patched/mixed
   detection AND patching (no fragile string-replace of regex source anymore); literal
   coverage matches brief: one 3, four 10s, three 2s; members-6 untouched.
6. Live-fingerprint anchors (`function Dj(`, `hMe(e,t,s)`, `oMe(a)`, `let s=r||rje();`) were
   used as derivation evidence only — none is hardcoded in either patcher.

## Behavior harness (beyond regex matching)

node harness (harness.mjs, kept in /tmp/dm111283-bundle) extracts the PATCHED Dj plus the
REAL oMe/FA/LA/NA from t-both.js, stubs module deps, and asserts 27 checks — ALL PASS:
/command dispatch to thread-scoped session + visible user entry + no drive started; non-exec
dispatch result → queued via hMe with queued activity record; command+attachment → null +
warning toast (upstream semantics); `/etc/hosts` → normal send path, body queue call once,
no snippet firing; bare-key fallback for unmigrated rooms; scoped-room miss → "no live
session" post, no dispatch; no-mention → default-profile session, posted as Room; caps
9999 literals in place; exactly one `__GSPATCH` marker.

## Constraints honored

- No writes to the installed bundle (re-sha-verified after tests); no ~/.hermes/scripts
  changes; no push; hermes-agent checkout untouched (git status clean for tracked files).
- ANCHOR + SNIPPET flow intact in the slash patcher; exit codes 0/1/3 unchanged for the
  watchdog interface.
- Notes updated in-place: groupchat-mods-manifest.txt (new re-derivation log), REAPPLY.md
  (rename-agnostic verify grep + dated section), desktop-overrides.md (anchor + semantics
  paragraphs incl. the now-realized #94063 guard history).

## Handoff notes (for the deploy stage, NOT done here)

- Deploy = copy both patchers to ~/.hermes/scripts, run protean-caps-watchdog.sh once
  (patches + re-signs the live bundle), confirm ALERT file absent; then the issue's E2E
  check: `/status` in a room posts an entry, and a rapid follow-up during an active member
  turn queues (waits) instead of overlapping.
- If a future rebuild changes SOURCE shapes (not just letters), probes will fail-closed to
  rc=3 with the offending probe named in the log — that is a genuine re-derive signal, and
  the manifest procedure + hazen brief §6 verification set apply.

STABLE
