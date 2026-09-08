# hermes-desktop-mods / backup-2026-09-06

Backup of our custom Hermes setup, taken before a major `hermes update`
(re-checkout of `hermes-agent` from `origin/main`). Restore after the update
per the runbook below.

## Why this exists

Our installed Hermes source lives in `/Users/kethuda/.hermes/hermes-agent`
as a git checkout. A `hermes update` re-checks out that directory from
`origin/main` (NousResearch/hermes-agent), which **overwrites every local
change in that tree**. Our customizations sit on top of the
`v2026.8.31` base (`8dbf07e9` is the local tip = 68 customized files,
+6182/-206). This folder preserves them.

Everything OUTSIDE that git dir (config, plugins, desktop-plugins, skills)
survives the checkout but is still backed up here for redeployment.

## What's inside

| Path | What it is | Survives update? |
|------|-----------|------------------|
| `hermes-source-customization/` | The 68 customized source files of our installed `hermes-agent` (as of commit `8dbf07e9`). Includes gateway/, hermes_cli/, tui_gateway/, agent/, cli.py, run_agent.py, hermes_state.py, apps/desktop/electron/, pyproject.toml + tests. | NO — this is what the update wipes. Restore after. |
| `user-config.yaml` | Our `~/.hermes/config.yaml` (custom model/provider routing, group_sessions, plugins/hooks, _config_version=39). | Survives, but restore if reset. |
| `petdex-desktop-plugin/` | Custom lifecycle-hook plugin (`~/.hermes/plugins/petdex-desktop`). | Survives, but restore if deleted. |
| `desktop-plugins/chief-of-staff/` | Custom desktop plugin (plugin.yaml + plugin.js). | Survives, restore if reset. |
| `desktop-plugins/group-model-sync/` | Custom desktop plugin (plugin.js). | Survives, restore if reset. |
| `skills/hermes-openrouter-provider-routing/` | Custom skill (OpenRouter Baidu-preference routing). | Survives, restore if reset. |
| `skills/hermes-profile-diagnostics/` | Custom diagnostics skill (+ references). | Survives, restore if reset. |
| `skills/devops/sdlc-review/` | Custom skill. | Survives, restore if reset. |
| `skills/software-development/eldunari-optimization/` | Custom skill (+ references). | Survives, restore if reset. |

## Update scope (what changed upstream)

Base `v2026.8.31` → current `origin/main` tip `820106d` (2026-09-06):
~5,585 commits, 300 files, +25,727/-38,328. Churn is concentrated in the
agent core engine (`agent/`, 260 files) plus a brand-new `acp_adapter/`
module (12 files, Anthropic Context Protocol bridge), desktop e2e tests,
and CI. `gateway/`, `hermes_cli/`, `tools/`, `plugins/`, `skills/`
directories upstream were unchanged — only the files WE customized overlap.

## How to restore (after the update completes)

1. Confirm the update is done and `hermes --version` shows the new build.
2. Source files (`hermes-source-customization/`): the 68 files need to be
   re-applied on top of the new tree. Simplest: copy each file back over the
   updated `/Users/kethuda/.hermes/hermes-agent/`. If the update applied a
   fix that overlaps one of our files, review the merge first.
3. `user-config.yaml`: copy back to `/Users/kethuda/.hermes/config.yaml`
   only if it was reset. (It normally survives.)
4. Plugins/desktop-plugins/skills: copy each dir back to its `~/.hermes`
   location only if missing. They normally survive.
5. Restart the gateway: `hermes update` (or `hermes gateway restart`).

NOTE: The desktop mods (group-chat caps override, slash-command patchers,
watchdog, launchagent plist, SOP) are NOT baked into the source tree — they
live in this repo and are reapplied via `REAPPLY.md` after checkout. This
backup complements that flow by capturing the SOURCE-level customizations.

## How this backup was made

- `hermes-agent`: `git diff --name-only v2026.8.31 8dbf07e9` (68 files) →
  tarball → extracted into `hermes-source-customization/`.
- Everything else: `cp` from the live `~/.hermes` tree.
