# Session Transcript Recovery

## When to Use

The desktop app times out loading a profile's session history ("Could not open X's chat — Time out loading X's session history"), `sessions/` is empty or nearly empty, but `state.db` has session rows with message data. Profile backend processes are running and functional (group chats work), but the desktop can't show history.

## Diagnosis: Confirm the Mismatch

```bash
# Compare files vs database entries per profile
for p in ~/.hermes/profiles/*/; do
  name=$(basename "$p")
  files=$(ls "$p/sessions/"*.json 2>/dev/null | wc -l)
  db=$(sqlite3 "$p/state.db" "SELECT COUNT(*) FROM sessions;" 2>/dev/null)
  echo "$name: $files files / $db db entries"
done
```

A profile where `files == 0` (or far fewer than `db`) and agents are running is a recovery candidate.

## Recovery: Reconstruct Transcript Files from state.db

The profile's `state.db` contains all message content in the `messages` table. Reconstruct `sessions/*.json` transcript files from it. This reads the database only — it does not affect running agents.

### Step 1: Check what's recoverable

```bash
# See which sessions have messages in the DB
sqlite3 ~/.hermes/profiles/<name>/state.db \
  "SELECT session_id, COUNT(*) as msg_count FROM messages GROUP BY session_id ORDER BY msg_count DESC;"

# See session metadata
sqlite3 ~/.hermes/profiles/<name>/state.db \
  "SELECT id, title, display_name, archived, hidden, message_count, started_at, ended_at FROM sessions ORDER BY started_at DESC;"
```

Sessions with `archived=1` or `hidden=1` are excluded from desktop display by default. Unhide if needed:
```bash
sqlite3 ~/.hermes/profiles/<name>/state.db "UPDATE sessions SET hidden=0 WHERE hidden=1;"
```

### Step 2: Run the reconstruction script

```python
import sqlite3, json, os

# Expand the leading ~ to the real home path; os.path.join does NOT expand it.
profile_dir = os.path.expanduser("~/.hermes/profiles/<name>")
db_path = os.path.join(profile_dir, "state.db")
sessions_dir = os.path.join(profile_dir, "sessions")
os.makedirs(sessions_dir, exist_ok=True)

conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row

cur = conn.execute(
    "SELECT id, title, display_name, profile_name, hidden, archived, pinned, "
    "message_count, started_at, ended_at "
    "FROM sessions WHERE archived=0 AND hidden=0 ORDER BY started_at DESC"
)

for sess in cur.fetchall():
    sid = sess["id"]
    title = sess["title"] or sess["display_name"] or "unnamed"
    safe_title = "".join(c if c.isalnum() or c in " -_" else "_" for c in title)
    filepath = os.path.join(sessions_dir, f"{sid}_{safe_title[:40]}.json")

    msg_cur = conn.execute(
        "SELECT id, session_id, role, content, tool_calls, tool_name, "
        "effect_disposition, timestamp, token_count, finish_reason, "
        "reasoning, reasoning_content, display_kind, display_metadata "
        "FROM messages WHERE session_id=? AND active=1 ORDER BY timestamp",
        (sid,)
    )
    messages = msg_cur.fetchall()
    if not messages:
        continue

    transcript = {
        "session_id": sid,
        "title": title,
        "profile": "<name>",
        "started_at": sess["started_at"],
        "ended_at": sess["ended_at"],
        "message_count": len(messages),
        "messages": [dict(m) for m in messages]
    }

    with open(filepath, "w") as f:
        json.dump(transcript, f, indent=2, ensure_ascii=False)
    print(f"Wrote {filepath}: {len(messages)} messages")

conn.close()
```

### Step 3: Verify

```bash
# Validate all reconstructed files parse as JSON
for f in ~/.hermes/profiles/<name>/sessions/*.json; do
  python3 -c "import json; json.load(open('$f'))" && echo "OK: $f" || echo "BAD: $f"
done

# Check total size
du -sh ~/.hermes/profiles/<name>/sessions/*.json
```

### Step 4: Test in the desktop app

Open the profile chat in the desktop app. If it still times out, the issue may be deeper (transcript format mismatch, desktop expecting a different schema). But the missing-files cause is resolved.

## Important Notes

- **Profile backends are independent processes.** `ps aux | grep "hermes_cli.main.*serve"` shows each profile as a separate Python process on its own port. Reconstructing session files does not touch these processes or their in-memory state.
- **`hermes sessions list` only queries the default profile's `~/.hermes/state.db`.** It does not aggregate across profiles. Do not use it to verify per-profile session health.
- **`request_dump_*.json` files are API request/error dumps, not session transcripts.** They don't help the desktop load session history.
- **`ws_orphan_reap` in logs** means the desktop disconnected and the session was cleaned up. This often accompanies transcript file loss.
- **Backup first if unsure:** `cp ~/.hermes/profiles/<name>/state.db ~/.hermes/profiles/<name>/state.db.bak`
