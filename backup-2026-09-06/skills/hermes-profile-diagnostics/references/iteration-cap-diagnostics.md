# Iteration Cap Diagnostics — max_turns, Round Caps, and the 90-Default Mystery

When the agent reports a turn/round/message cap (e.g. "iteration 30/90") and the config says something different, here's how to trace where the cap actually comes from.

## The cap in question

`agent.max_turns` controls how many tool-call iterations a single conversation turn can run before Hermes forces a wrap-up. Messages like "Still working... (40 min elapsed - iteration 30/90, ...)" are injected when approaching this limit.

## Config resolution hierarchy

Settings resolve in this order (highest priority first):

1. **CLI arguments** — e.g. `hermes chat --max-turns 200` (per-invocation override)
2. **Profile config** — `~/.hermes/profiles/<name>/config.yaml` if a profile is active
3. **Default config** — `~/.hermes/config.yaml`
4. **Built-in defaults** — whatever the codebase hardcoded

**Critical nuance**: the default profile's `config.yaml` is NOT necessarily what a group-chat session sees. Group chats route through a specific profile's gateway. If you have multiple profiles, the profile serving the group may have its own `max_turns` that overrides the default.

## The 90 vs unlimited discrepancy

There is a known inconsistency in Hermes' documentation:

| Source | Stated default |
|---|---|
| Skill reference (`references/configuration.md`) | `max_turns (90)` |
| Live docs (hermes-agent.nousresearch.com) | `none` (unlimited) |
| Runtime (code) | Confirmed: `none` = unlimited; positive int = cap |

The skill reference listing `90` as the default is **outdated** relative to the current runtime. The live behavior is: unlimited by default, capped only when explicitly set.

However, some users report seeing 90 in Telegram group chats even when the config says otherwise. Likely causes (in descending probability):

1. **The group chat runs under a different profile** whose config has `max_turns: 90` or is unset and the profile was created before the default changed.
2. **The skill reference's "90" is what the user read** and assumed was the runtime default, even though the actual cap came from a profile config they set earlier.
3. **A platform-level (Telegram group) override** — possible but not confirmed in current docs.

## How to trace the actual cap

```bash
# 1. Check default config
hermes config get agent.max_turns

# 2. Check EVERY profile config
for p in ~/.hermes/profiles/*/; do
  name=$(basename "$p")
  val=$(grep -A1 "^agent:" "$p/config.yaml" 2>/dev/null | grep "max_turns" | awk '{print $2}')
  echo "$name: max_turns=$val"
done

# 3. If you use named profiles for gateways, check which profile serves the group chat
hermes -p <profile> config get agent.max_turns
```

## How to change it

```bash
# Raise the cap (global, default profile)
hermes config set agent.max_turns 200

# Remove entirely (unlimited)
hermes config set agent.max_turns none

# Per-profile (for group-chat profiles)
hermes -p <profile_name> config set agent.max_turns none
```

Valid "no limit" spellings (case-insensitive): `none`, `null`, `unlimited`, `infinite`, `infinity`, `inf`, `0`, `-1`.

## Related settings

| Setting | Section | What it controls |
|---|---|---|
| `agent.max_turns` | `agent` | Iteration cap per conversation turn |
| `agent.run_budget_seconds` | `agent` | Wall-clock budget per run (separate from iteration cap) |
| `delegation.max_iterations` | `delegation` | Subagent iteration cap (50 default, NOT the same as max_turns) |
| `delegation.max_concurrent_children` | `delegation` | Parallel subagent cap |

**Do NOT confuse** `agent.max_turns` (conversation turn iterations) with `delegation.max_iterations` (subagent iterations) — they are separate knobs with different defaults.

## When mid-task pressure warnings were removed

Prior to April 2026, Hermes injected warnings at 70% and 90% of the iteration budget. This caused models to abandon complex tasks prematurely and was removed. Current behavior: no mid-task pressure; only a wrap-up request at exhaustion plus one grace call. If you're seeing "iteration X/90" style progress messages, those are status updates, not pressure warnings — they were reintroduced in a different form for long-running tasks.

## Verification

After changing `max_turns`, confirm with a long-running task that would have hit the old cap. The progress messages should reflect the new limit (or disappear entirely if set to unlimited).
