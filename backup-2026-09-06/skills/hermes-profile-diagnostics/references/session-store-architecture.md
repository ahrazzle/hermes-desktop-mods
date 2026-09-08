# Session Store Architecture

Hermes maintains session data across multiple stores that can diverge.

## Per-Profile Stores

### `state.db` (SQLite)

Each profile has its own `~/.hermes/profiles/<name>/state.db`. This is the canonical session metadata store. Key tables:

- **sessions** — session metadata: id, title, display_name, profile_name, timestamps (started_at, ended_at, last_activity_at), message_count, flags (archived, hidden, pinned), cost tracking, handoff state
- **messages** — full message content: session_id, role, content, tool_calls, tool_name, effect_disposition, timestamp, reasoning fields, platform_message_id

The desktop app queries this for session lists and metadata. It does NOT load message content from here for display — that comes from transcript files.

### `sessions/` directory

Each profile has `~/.hermes/profiles/<name>/sessions/`. Contains `request_dump_*.json` files — these are the transcript files the desktop app loads to render session history. When these are missing, the desktop times out trying to load a session even though state.db has valid metadata.

### Why they diverge

- Sessions created via the desktop app write to both stores
- Sessions created via CLI or other surfaces may write to state.db but not persist transcripts to sessions/
- WebSocket disconnects (`ws_orphan_reap`) can clean up session resources including transcript files
- Profile migrations, backups/restores, or manual database edits can cause mismatches

## Central Store

### `~/.hermes/state.db`

The default (non-profile) Hermes instance uses `~/.hermes/state.db`. `hermes sessions list` queries this database only — it does NOT aggregate across profiles. Each profile is an isolated Hermes instance with its own state.db.

### `~/.hermes/sessions/`

The central session directory used by the gateway. Contains request dumps from the default profile. Profile-specific sessions live in their own profile directories.

## Log Locations

| Log | Path |
|---|---|
| Gateway | `~/.hermes/logs/gateway.log` |
| Desktop app | `~/.hermes/logs/desktop.log` |
| GUI/TUI gateway | `~/.hermes/logs/gui.log` |
| Errors | `~/.hermes/logs/errors.log` |
| Per-profile agent | `~/.hermes/profiles/<name>/logs/agent.log` |
| Per-profile GUI | `~/.hermes/profiles/<name>/logs/gui.log` |

## Key Log Events

- `session.reclaimed` with `reason: ws_orphan_reap` — the desktop/app disconnected and the session was cleaned up
- `tui turn finished` with `status=complete` — a turn completed successfully
- `ws closed` with `code=1012` (timeout) or `code=1005` (abnormal) — connection issues
- Repeated `hermes_cli.web_server: Mounted plugin API routes` — the GUI/server is restarting repeatedly
