---
name: hermes-profile-diagnostics
description: "Diagnose failed Hermes profiles and agents."
version: 1.0.0
author: Hermes Agent
license: MIT
tags: [hermes, diagnostics, profiles, sessions, troubleshooting]
---

# Hermes Profile Diagnostics

Use when profiles won't load, agents won't wake, the desktop app shows timeout errors on session history, or `hermes sessions list` returns fewer sessions than expected.

## Quick Health Check

```bash
# Overall system state
hermes status

# Is the gateway running?
hermes status | grep -A5 "Gateway Service"

# Are profile servers alive?
ps aux | grep "hermes_cli.main" | grep -v grep

# Session list (default profile only — see below for per-profile)
hermes sessions list
```

## The Core Diagnostic: state.db vs sessions/ Dir

Each profile has **two** session stores that can drift apart:

1. **`~/.hermes/profiles/<name>/state.db`** — SQLite database with session metadata (id, title, message_count, timestamps, archived/hidden flags)
2. **`~/.hermes/profiles/<name>/sessions/`** — Directory with transcript files (request_dump_*.json) that the desktop app loads for history

**When the desktop times out loading a session, the transcript file is usually missing.**

Run this to compare:

```bash
for p in ~/.hermes/profiles/*/; do
  name=$(basename "$p")
  db_count=$(sqlite3 "$p/state.db" "SELECT COUNT(*) FROM sessions;" 2>/dev/null)
  dir_count=$(ls "$p/sessions/" 2>/dev/null | wc -l)
  echo "$name: state.db=$db_count, sessions/=$dir_count"
done
```

**Red flag:** `state.db` has sessions but `sessions/` dir is empty or has far fewer files. That profile's agents are running but the desktop can't show history.

## Per-Profile Session Contents

To see what's actually in a profile's database:

```bash
# List sessions with key fields
sqlite3 ~/.hermes/profiles/<name>/state.db \
  "SELECT id, title, display_name, profile_name, hidden, archived, pinned, message_count, started_at, ended_at, last_activity_description FROM sessions ORDER BY started_at DESC;"

# Count messages per session
sqlite3 ~/.hermes/profiles/<name>/state.db \
  "SELECT session_id, COUNT(*) as msg_count FROM messages GROUP BY session_id ORDER BY msg_count DESC;"
```

## Desktop App Diagnostics

```bash
# Desktop/GUI logs — look for timeout, session.reclaimed, ws_orphan_reap
tail -100 ~/.hermes/logs/desktop.log
tail -100 ~/.hermes/logs/gui.log

# Errors
tail -50 ~/.hermes/logs/errors.log

# Agent logs per profile
tail -50 ~/.hermes/profiles/<name>/logs/agent.log
tail -50 ~/.hermes/profiles/<name>/logs/gui.log
```

Key log patterns:
- `session.reclaimed` with `reason: ws_orphan_reap` — desktop disconnected, session was reaped
- `tui turn finished` with `status=complete` — session worked fine
- Repeated gateway restarts in gui.log — desktop app crash loops

## Common Findings

| Symptom | Likely Cause |
|---|---|
| `hermes sessions list` shows few sessions | Only querying default profile's state.db |
| Desktop times out on session history | sessions/ dir empty, state.db has metadata only |
| All profile servers running but can't chat | WebSocket disconnect / orphan reaping |
| Session appears archived in DB | `archived=1` flag — desktop may hide it |
| `ws_orphan_reap` in logs | Desktop app closed connection prematurely |

## Model Failure Recovery

When a model stops responding (timeouts, 502s, auth failures) across sessions, diagnose which layer is broken before touching sessions:

### 1. Read the current config
```bash
hermes config get model.default
hermes config get model.provider
hermes config get model.base_url
```

### 2. Check session history to find what's actually failing
```bash
sqlite3 ~/.hermes/state.db \
  "SELECT id, source, model, model_config, started_at, ended_at, message_count \
   FROM sessions WHERE source='desktop' ORDER BY started_at DESC LIMIT 10;"
```
The `model_config` JSON shows the exact provider/model each session used — compare the broken session's config against working ones.

### 3. Check profile-level configs if sessions span multiple profiles
```bash
for p in ~/.hermes/profiles/*/; do
  name=$(basename "$p")
  head -5 "$p/config.yaml" 2>/dev/null
  echo "---"
done
```
Each profile is an independent Hermes instance with its own `config.yaml`. The broken model may only affect the default profile.

### 4. Identify the broken layer: provider vs model vs session
- **Provider down**: curl the provider's `/v1/models` endpoint. A 502/connection refused means the provider endpoint is broken, not a specific model.
- **Specific model broken**: provider responds but the model fails only on inference calls — switch to a different model on the same provider.
- **Session-level config drift**: a session's `model_config` in state.db points to a provider/model combo that no longer works — update the session's config directly in SQLite (see below).

### 5. Fix at the config level (preserves all existing sessions)
```bash
# Switch default model+provider (does NOT touch existing session configs)
hermes config set model.default "<new-model>"
hermes config set model.provider "<new-provider>"
hermes config set model.base_url "<new-base-url>"

# Restart gateway to pick up changes
pkill -f "hermes_cli.main.*gateway"  # or kill the specific PID
```

### 6. Fix at the session level (targeted — one session only)
```bash
# Update a specific session's model_config in state.db
sqlite3 ~/.hermes/state.db \
  "UPDATE sessions SET model_config='{\"model\":\"<new-model>\",\"provider\":\"<new-provider>\"}' \
   WHERE id='<session-id>';"
```
Session-level `model_config` overrides the default — this is how per-session model switches work without affecting other chats.

### 7. Verify the new provider/model works
```bash
curl -sS <base_url>/v1/models -H "Authorization: Bearer <key-or-test>" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('data',d)), 'models available')"
```

### Key files
- `references/model-switch-recovery.md` — detailed walkthrough with real examples
- `references/iteration-cap-diagnostics.md` — tracing round/message caps (`max_turns`), the 90-default discrepancy, and how to change or remove them

### References
- `references/session-store-architecture.md` — how Hermes stores sessions
- `references/session-transcript-recovery.md` — reconstruct missing transcripts
