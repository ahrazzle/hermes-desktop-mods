# Model Switch Recovery — Detailed Walkthrough

When a model stops working and you need to switch without disrupting existing sessions or group chats.

## Session model storage

Hermes stores model configuration at **two levels**:

### Default (config.yaml)
`~/.hermes/config.yaml` (or per-profile `~/.hermes/profiles/<name>/config.yaml`):

```yaml
model:
  default: meituan/longcat-2.0:free
  provider: nous
  base_url: https://inference-api.nousresearch.com/v1
  key_env: HERMES_CUSTOM_STEALTH_OX_ALPHA_API_KEY
```

This is the fallback for any session that doesn't have its own `model_config`.

### Per-session (state.db)
Each session row in `state.db` carries its own `model_config` JSON:

```sql
SELECT id, source, model, model_config, started_at FROM sessions ORDER BY started_at DESC;
```

```
20260826_164626_d255bc | desktop | upstage/solar-pro4:free | {"model": "Qwen/Qwen3.8-Flash-Next-FP8", "provider": "empero", ...} | 1787777187
```

When a session has a `model_config`, that overrides the default. If it's empty or absent, the session uses `config.yaml`.

## The problem pattern

1. Default profile's `config.yaml` points to a model/provider that breaks (e.g., `nous` API returns 502, auth expires, model deprecated).
2. The desktop app is already on a working session (manually switched earlier), so the chat UI works.
3. Profile backend processes for other profiles may also be affected if they share the broken config.
4. Group chats on messaging platforms use profile-specific config — switching the default doesn't fix them; you must fix the profile or the specific session.

## Diagnosis sequence

### Step 1: Is it the provider or the model?
```bash
# Test the base_url directly
curl -sS <base_url>/v1/models -H "Authorization: Bearer <key>" | head -c 200
```
- Connection refused / DNS failure → endpoint is down
- 502/503 → provider having issues
- 401/403 → key/env var expired or wrong
- Successful JSON → provider works; the specific model may be the issue

### Step 2: What did each session use?
```bash
sqlite3 ~/.hermes/state.db \
  "SELECT id, source, model, model_config, started_at, message_count \
   FROM sessions WHERE started_at > <timestamp> ORDER BY started_at DESC;"
```
Compare `model_config` across sessions. If some sessions have a different provider/model and work, that's your target.

### Step 3: Read the per-profile configs
```bash
for p in ~/.hermes/profiles/*/; do
  name=$(basename "$p")
  echo "=== $name ==="
  head -6 "$p/config.yaml" 2>/dev/null
done
```
The broken model may only be in the default profile. Other profiles may already be on working models.

## Fix options (least invasive first)

### Option A: Switch the default model (one-liner)
```bash
hermes config set model.default "Qwen/Qwen3.8-Flash-Next-FP8"
hermes config set model.provider "empero"
hermes config set model.base_url "https://free.empero.org/v1"
# Restart gateway
pkill -f "hermes_cli.main.*gateway"
```
**Effect**: New sessions use the new model. Existing sessions are untouched (each has its own `model_config`).

### Option B: Fix a specific session (targeted)
```bash
sqlite3 ~/.hermes/state.db \
  "UPDATE sessions SET model_config='{\"model\":\"Qwen/Qwen3.8-Flash-Next-FP8\",\"provider\":\"empero\"}' \
   WHERE id='<session-id>';"
```
**Effect**: Only that session's model changes. All other sessions remain as-is.

### Option C: Fix a per-profile config
```bash
# Edit the profile's config.yaml directly, or use:
cd ~/.hermes/profiles/<name>
hermes --profile <name> config set model.default "<new-model>"
hermes --profile <name> config set model.provider "<new-provider>"
```
Then restart that profile's serve process:
```bash
pkill -f "hermes_cli.main.*serve.*<name>"
```

## What NOT to do

- **Don't delete or recreate sessions** to change the model. Session IDs are stable references; recreating loses message history.
- **Don't edit config.yaml by hand** unless you know the exact YAML structure — use `hermes config set` to avoid indent corruption.
- **Don't assume `hermes sessions list` shows everything** — it only queries the default profile's `state.db`. Use per-profile sqlite queries for full visibility.

## Real example from this session

**Problem**: Default model `meituan/longcat-2.0:free` via `nous` was broken.

**Diagnosis**:
- `~/.hermes/config.yaml` → `model.default: meituan/longcat-2.0:free`, `provider: nous`
- `sqlite3 state.db` → desktop session `20260826_164626_d255bc` already on `Qwen/Qwen3.8-Flash-Next-FP8` via `empero` (manually switched)
- `for p in profiles/*/` → 8 of 9 profiles already on Qwen/empero; only `aetherean` was on `stealth-ox-alpha` via `nous`

**Fix**:
```bash
hermes config set model.default "Qwen/Qwen3.8-Flash-Next-FP8"
hermes config set model.provider "empero"
hermes config set model.base_url "https://free.empero.org/v1"
pkill -f "hermes_cli.main.*gateway"
```
**Result**: Default profile now matches the working config all other profiles already used. Zero existing sessions affected.

## Verification checklist

After any model switch:
- [ ] `hermes config get model.default` shows the new model
- [ ] `hermes config get model.provider` shows the new provider
- [ ] Provider `/v1/models` endpoint responds (curl test)
- [ ] Gateway restarted and picked up new PID
- [ ] Existing session's `model_config` in state.db unchanged
- [ ] New message in the target chat routes through the new model
