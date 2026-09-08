/**
 * chief-of-staff — Hermes Desktop fan-out command center (V2).
 *
 * A standalone runtime plugin (no codebase modification, no bundle patch) that
 * turns the agent's async subagent fan-out into a command-center pane: live
 * worker cards, streaming thinking / tool / output, per-worker steer +
 * interrupt, orchestrator steer (queued), worker model visibility + spawn
 * hints, full-output copy, and an Active/Past view toggle.
 *
 * This is the desktop UI for the lean6sigma / JIT-handoff orchestration
 * doctrine: the orchestrator (owner session) spawns REAL subagents via the
 * `delegate_task` model tool — this plugin NEVER spawns anything. It observes
 * (subagent.* events + `delegation.status`/`session.info` polling), steers
 * (subagent.steer for workers, queued prompt.submit for the orchestrator),
 * stops (`subagent.interrupt`), and configures (`config.set` on the
 * orchestrator session; children inherit model/reasoning).
 *
 * V2 changes (from live user testing):
 *  1. Worker model block: shows each worker's delegation-resolved model +
 *     a "Copy spawn hint" button. `config.set` CANNOT write
 *     `delegation.provider` (server.py:14102 special-cases only 'model',
 *     'reasoning', 'details_mode.*'), so per-worker model control is an
 *     explicit spawn instruction + a documented config.yaml manual override.
 *  2. Full-output copy: subagent.start relays `child_session_id`; output
 *     previews are ACCUMULATED (appended, never overwritten); Copy tries
 *     `session.history` for the child session (full transcript) and falls
 *     back to the accumulated buffer.
 *  3. Orchestrator steer: `prompt.submit {session_id, text, queued:true}`
 *     routes through _handle_busy_submit (server.py:10208) when the session
 *     is busy → the prompt runs AFTER the current turn (the fan-out join).
 *     Worker cards still use subagent.steer (ownership-gated).
 *  4. Stable card layout: fixed-height flex-col cards — header fixed,
 *     scrollable bounded middle, footer (steer + actions) always rendered
 *     and pinned to the bottom; the steer input never moves.
 *  5. Active/Past toggle in the pane header — filter of the render only,
 *     all workers stay in state.
 *
 * Data sources (all local, no telemetry):
 *   - Live worker list: the gateway's `active` subagent snapshot. Preferred
 *     RPC is `session.info` (returns `active` when the backend carries it);
 *     this checkout registers `delegation.status` as the reliable `active`
 *     source, so we LADDER: try `session.info`, fall back to
 *     `delegation.status`. Both return records shaped
 *     `{subagent_id, parent_id, depth, goal, model, started_at, tool_count,
 *     status}`.
 *   - Live stream: `subagent.*` events (start / thinking / text / tool /
 *     complete / progress) relayed by the owning session's delegate_task —
 *     reach renderer plugin listeners FIRST via emitGatewayEvent.
 *   - Poll `session.info` (then `delegation.status`) every ~8s as a backstop,
 *     coalesced so overlapping polls never stack.
 *
 * Ownership gate: `subagent.steer` only queues when the INVOKING session is
 * the one that spawned the worker (owner_session_id check in delegate_tool's
 * steer_subagent). This is the chief-of-staff authorization model: the
 * orchestrator session (the pane's active session id) steers its own fan-out.
 *
 * No upstream approval needed: standalone desktop plugin, mirrors
 * group-model-sync's register + pane + host.request + host.onEvent shape.
 */

import {
  Badge,
  Button,
  Codicon,
  EmptyState,
  GlyphSpinner,
  host,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tip
} from '@hermes/plugin-sdk'
import { jsx } from 'react/jsx-runtime'
import { useEffect, useMemo, useRef, useState } from 'react'

const ID = 'chief-of-staff'
const POLL_MS = 8000
const THINKING_CAP = 2000
const OUTPUT_CAP = 2000
// Cost disclaimer — placeholder text; another agent is writing the final copy
// and will steer the swap. Do not remove the render site (FIX 5).
const COST_DISCLAIMER = 'Switching models here adds token usage beyond a normal session, so expect higher costs. The impact varies by model, session, and context, and Fanout is not responsible for any charges these run up.'
const REASONING_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const REASONING_LABELS = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max',
  ultra: 'Ultra'
}
const NONE = '__none__'
const SUBAGENT_EVENTS = [
  'subagent.start',
  'subagent.thinking',
  'subagent.text',
  'subagent.tool',
  'subagent.complete',
  'subagent.progress'
]
const STATUS_LABELS = {
  running: 'running',
  done: 'done',
  complete: 'done',
  interrupted: 'interrupted',
  error: 'errored',
  errored: 'errored',
  failed: 'errored'
}
const STATUS_VARIANTS = {
  running: 'default',
  done: 'success',
  complete: 'success',
  interrupted: 'warning',
  error: 'destructive',
  errored: 'destructive',
  failed: 'destructive'
}

// ── tiny helpers ────────────────────────────────────────────────────────────

const asRecord = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})

const rpcErrorText = err => {
  const e = asRecord(err)
  return String(e.message || e.error || err || 'request failed')
}

const str = v => String(v == null ? '' : v)

const truncate = (text, max) => {
  const t = str(text)
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** A subagent's live status (events + active records use slightly different
 *  vocab; normalize to the brief's four-card states). */
const normalizeStatus = raw => {
  const s = str(raw).toLowerCase()
  return STATUS_LABELS[s] || s || 'running'
}

const statusVariant = raw => STATUS_VARIANTS[normalizeStatus(raw)] || 'muted'

/** The pane's active session id — host.state.activeSessionId atom, falling
 *  back to the last seen session.info event session_id. */
function currentSessionId(fallbackEventSid) {
  try {
    const atom = host.state && host.state.activeSessionId
    const live = typeof atom === 'function' ? atom() : atom
    const sid = live && typeof live.get === 'function' ? live.get() : live
    if (sid) {
      return str(sid)
    }
  } catch {
    /* atom read failed — fall through */
  }
  return fallbackEventSid ? str(fallbackEventSid) : ''
}

// ── RPC helpers ─────────────────────────────────────────────────────────────

/** The gateway JSON-RPC door. */
const gate = (method, params = {}) => host.request(method, params)

/** Live worker snapshot — ladder: session.info (per brief) → delegation.status
 *  (the registered `active` source in this checkout). */
async function fetchActiveWorkers() {
  let turnStarted = undefined
  try {
    const res = await gate('session.info', {})
    const rec = asRecord(res)
    turnStarted = rec.turn_started_at != null
      ? rec.turn_started_at
      : (rec.payload && rec.payload.turn_started_at != null
        ? rec.payload.turn_started_at
        : undefined)
    const active = Array.isArray(rec.active)
      ? rec.active
      : Array.isArray(rec.payload && rec.payload.active)
        ? rec.payload.active
        : null
    if (active) {
      // turn_started_at rides every session.info response — the poll uses it
      // as the reliable backstop for steer-queue drain detection.
      return { active, source: 'session.info', turn_started_at: turnStarted }
    }
    /* session.info resolved but carried no active list — ladder down */
  } catch {
    /* unknown method or transport error — ladder down */
  }
  const res = await gate('delegation.status', {})
  const rec = asRecord(res)
  const active = Array.isArray(rec.active) ? rec.active : null
  return { active: active || [], source: 'delegation.status', turn_started_at: turnStarted }
}

/** Provider/model catalog — CONFIGURED providers only (explicit_only),
 *  matching the desktop model menu. */
async function fetchModelOptions() {
  const res = await gate('model.options', { explicit_only: true })
  const providers = (asRecord(res).providers || [])
    .filter(p => p && p.slug)
    .map(p => ({
      slug: String(p.slug),
      name: String(p.name || p.slug),
      models: (p.models || [])
        .map(m => (typeof m === 'string' ? m : String(m.id || m.name || '')))
        .filter(Boolean)
    }))
  return providers
}

/** Profile roster — the same rich rows the Bots pane renders
 *  (profiles.list on the active gateway). */
async function fetchProfiles() {
  const res = await gate('profiles.list', {})
  const list = (asRecord(res).profiles || [])
    .map(p => ({
      name: String(p.name || p.profile || '').trim(),
      display: String(p.display_name || p.name || p.profile || '').trim()
    }))
    .filter(p => p.name && p.name !== 'default')
  return list
}

/** Current model/provider/reasoning for the orchestrator session. */
async function readOrchestratorConfig(sid) {
  const [modelRes, reasoningRes] = await Promise.allSettled([
    gate('config.get', { key: 'provider', session_id: sid }),
    gate('config.get', { key: 'reasoning', session_id: sid })
  ])
  const modelInfo = asRecord(modelRes.status === 'fulfilled' ? modelRes.value : {})
  const reasoningInfo = asRecord(reasoningRes.status === 'fulfilled' ? reasoningRes.value : {})
  return {
    model: String(modelInfo.model || ''),
    provider: String(modelInfo.provider || ''),
    reasoning: String(reasoningInfo.value || reasoningInfo.reasoning_effort || ''),
    errors: [
      modelRes.status === 'rejected' ? rpcErrorText(modelRes.reason) : null,
      reasoningRes.status === 'rejected' ? rpcErrorText(reasoningRes.reason) : null
    ].filter(Boolean)
  }
}

/** Build the ready-to-paste spawn instruction for ONE worker, based on the
 *  worker spawn config. Task-specific (not "for each task") so the user can
 *  vary profile/model/reasoning per worker. config.set cannot write
 *  delegation.provider in this checkout, so per-worker control is this
 *  instruction + a config.yaml manual override — NOT a session mutation.
 *
 *  IMPORTANT (verified in test session 20260901_124323_226af2): a profile-
 *  scoped spawn runs as an INDEPENDENT Hermes process (HERMES_HOME=<profile>
 *  hermes chat -q ...) — delegate_task has no per-task profile parameter and
 *  children always inherit the parent profile. Independent processes emit NO
 *  subagent.* events, so they will NOT appear in this pane. The instruction
 *  says so honestly. */
function buildSpawnInstruction(profile, model, provider, reasoning) {
  const p = String(profile || '').trim()
  const m = String(model || '').trim()
  const r = String(reasoning || '').trim()
  const parts = []
  parts.push('When you spawn THIS worker for this task, configure it as follows (put this specification in the worker\'s goal/context):')
  if (p) {
    parts.push(`- Profile: ${p} — run the worker as an independent process under that profile (HERMES_HOME=~/.hermes/profiles/${p}). Note: this worker emits NO subagent.* events (it will not appear in the Chief of Staff pane), subagent.steer will not work on it, and you must collect its output from the process result.`)
    if (r) {
      parts.push(`- Reasoning: ${r}`)
    }
    if (m) {
      parts.push(`- Model: ${m}${provider ? ` (provider ${provider})` : ''}`)
    }
  } else {
    // No profile → delegated workers. Model/Reasoning lines are unactionable
    // here (delegate_task has no per-task profile; children inherit the
    // parent profile's model/provider), so omit them rather than mislead.
    parts.push('- Use the orchestrator\'s current defaults — delegated workers inherit the parent profile\'s model and provider.')
  }
  parts.push('You may vary these per task — each worker can have its own profile/model/reasoning.')
  return parts.join('\n')
}

/** Pull the FULL final_response for a worker out of the ORCHESTRATOR's session
 *  history. The [ASYNC DELEGATION BATCH COMPLETE] message injected into the
 *  parent session carries the child's complete final_response (up to 24k
 *  chars) — NOT the 500-char cap the subagent.complete event relays
 *  (delegate_tool.py:3442 `summary[:500]`). Matches by a distinctive goal
 *  prefix and extracts text after the task header. Returns '' if not found. */
function extractDelegationSummary(goal, messages) {
  const goalKey = str(goal || '').trim().slice(0, 80)
  if (!goalKey || !Array.isArray(messages) || !messages.length) {
    return ''
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || typeof m !== 'object') {
      continue
    }
    const text = str(m.text != null ? m.text : m.content)
    if (!text || !text.includes(goalKey)) {
      continue
    }
    // Found the completion message. Walk back to the task header line.
    const idx = text.indexOf(goalKey)
    let lineStart = text.lastIndexOf('\n--- ', idx)
    if (lineStart === -1) {
      lineStart = text.lastIndexOf('\n───', idx)
    }
    const after = lineStart === -1 ? text : text.slice(lineStart + 1)
    // Cut at the next task header, the transcript footer, or the end.
    const cut = after.search(/\n--- |\n────────/)
    return (cut === -1 ? after : after.slice(0, cut)).trim()
  }
  return ''
}

/** Assemble the FULL output for a worker. Priority (verified against source):
 *  1. Full final_response extracted from the ORCHESTRATOR's live session
 *     history (the completion message carries the full text; the event
 *     summary is capped at 500 chars at delegate_tool.py:3442).
 *  2. `summary` — the 500-char event relay.
 *  3. `outputTail` — subagent.complete relays output_tail: the last 12 tool
 *     results with real content ({tool, preview, is_error}).
 *  4. `outputBuffer` — locally accumulated previews (thin: the gateway
 *     DELIBERATELY skips subagent.text to the parent — server.py "skip the
 *     parent emit"). */
async function fetchFullOutput(worker, orchSid) {
  const rec = asRecord(worker)
  const summary = str(rec.summary || '').trim()
  if (orchSid && rec.goal) {
    try {
      const res = await gate('session.history', { session_id: orchSid })
      const msgs = (asRecord(res).messages || []).filter(m => m && typeof m === 'object')
      const full = extractDelegationSummary(rec.goal, msgs)
      if (full && full.length > summary.length) {
        return full
      }
    } catch {
      /* history fetch failed — fall through */
    }
  }
  if (summary) {
    return summary
  }
  const tail = Array.isArray(rec.outputTail) && rec.outputTail.length
    ? rec.outputTail.map(t => {
        const tr = asRecord(t)
        const preview = str(tr.preview || tr.text || '').trim()
        return preview ? `[${tr.tool || 'tool'}${tr.is_error ? ' · error' : ''}] ${preview}` : ''
      }).filter(Boolean).join('\n\n')
    : ''
  if (tail) {
    return tail
  }
  return str(rec.outputBuffer) || str(rec.output)
}

// ── components ──────────────────────────────────────────────────────────────

function Spinner({ label }) {
  return jsx('div', {
    className: 'flex items-center gap-2 py-4 text-xs text-(--ui-text-tertiary)',
    children: [jsx(GlyphSpinner, { className: 'size-3.5 text-(--ui-text-tertiary)', spinner: 'breathe' }), label || 'Loading…']
  })
}

function StatusBadge({ status }) {
  const norm = normalizeStatus(status)
  return jsx(Badge, {
    className: 'shrink-0 text-[0.6rem] capitalize',
    variant: statusVariant(status),
    children: norm
  })
}

function ReasoningSelect({ value, onChange, disabled }) {
  return jsx(Select, {
    disabled,
    onValueChange: v => onChange(v === NONE ? '' : v),
    value: value || NONE,
    children: [
      jsx(SelectTrigger, {
        className: 'h-7 rounded-md text-xs',
        children: jsx(SelectValue, { placeholder: 'Reasoning' })
      }),
      jsx(SelectContent, {
        children: [
          jsx(SelectItem, { key: NONE, value: NONE, children: 'Reasoning: inherit' }),
          ...REASONING_LEVELS.map(level =>
            jsx(SelectItem, { key: level, value: level, children: `Reasoning: ${REASONING_LABELS[level]}` })
          )
        ]
      })
    ]
  })
}

function ProfileSelect({ profiles, value, onChange, disabled }) {
  return jsx(Select, {
    disabled,
    onValueChange: v => onChange(v === NONE ? '' : v),
    value: value || NONE,
    children: [
      jsx(SelectTrigger, {
        className: 'h-7 rounded-md text-xs',
        children: jsx(SelectValue, { placeholder: 'Profile' })
      }),
      jsx(SelectContent, {
        children: [
          jsx(SelectItem, { key: NONE, value: NONE, children: 'Profile: inherit' }),
          ...profiles.map(p =>
            jsx(SelectItem, { key: p.name, value: p.name, children: `Profile: ${p.display || p.name}` })
          )
        ]
      })
    ]
  })
}

function ModelControls({ catalog, provider, model, onChange, disabled }) {
  // Always render Selects when the catalog is loaded. The old version auto-
  // inferred freeText from `!catalog.some(...)` at MOUNT time (catalog is
  // empty then), which locked the pane in free-text mode until the user
  // clicked a hidden ▾ — the "arrows don't appear / fields go blank" bug.
  if (!catalog.length) {
    return jsx('div', {
      className: 'grid grid-cols-2 gap-1.5',
      children: [
        jsx(Input, {
          disabled,
          className: 'h-7 rounded-md text-xs',
          onChange: e => onChange({ provider: e.target.value }),
          placeholder: 'provider',
          value: provider
        }),
        jsx(Input, {
          disabled,
          className: 'h-7 rounded-md text-xs',
          onChange: e => onChange({ model: e.target.value }),
          placeholder: 'model',
          value: model
        })
      ]
    })
  }

  const active = catalog.find(p => p.slug === provider) || null
  const models = active ? active.models : []
  // Keep the current provider/model selectable even when they are not in the
  // catalog (custom provider typed earlier) — never blank the fields.
  const providerOptions = catalog.some(p => p.slug === provider)
    ? catalog
    : provider
      ? [...catalog, { slug: provider, name: provider, models: [] }]
      : catalog
  const modelOptions = models.length
    ? models
    : model
      ? [model]
      : []

  return jsx('div', {
    className: 'grid grid-cols-2 gap-1.5',
    children: [
      jsx(Select, {
        disabled,
        onValueChange: v => {
          const prov = catalog.find(p => p.slug === v)
          onChange({ provider: v, model: (prov && prov.models[0]) || '' })
        },
        value: provider || undefined,
        children: [
          jsx(SelectTrigger, {
            className: 'h-7 rounded-md text-xs',
            children: jsx(SelectValue, { placeholder: 'Provider' })
          }),
          jsx(SelectContent, {
            children: providerOptions.map(p =>
              jsx(SelectItem, { key: p.slug, value: p.slug, children: p.name })
            )
          })
        ]
      }),
      jsx(Select, {
        disabled,
        onValueChange: v => onChange({ model: v }),
        value: model || undefined,
        children: [
          jsx(SelectTrigger, {
            className: 'h-7 rounded-md text-xs',
            children: jsx(SelectValue, { placeholder: 'Model' })
          }),
          jsx(SelectContent, {
            children: modelOptions.map(m =>
              jsx(SelectItem, { key: m, value: m, children: m })
            )
          })
        ]
      })
    ]
  })
}

// ── worker card ─────────────────────────────────────────────────────────────

function WorkerCard({ worker, sessionId, orchModel, orchReasoning, onSteer, onInterrupt, onCopied }) {
  const [thinkingOpen, setThinkingOpen] = useState(true)
  const [steerText, setSteerText] = useState('')
  const [busy, setBusy] = useState('')
  // FIX 4 — output body expand/collapse so full in-pane worker output is
  // reachable (the copy feature still grabs the authoritative full summary).
  const [outputOpen, setOutputOpen] = useState(false)

  const running = worker.status === 'running'
  const goal = truncate(worker.goal, 160)
  const thinking = str(worker.thinking)
  const thinkingTruncated = thinking.length > THINKING_CAP
  const shownThinking = thinkingTruncated ? thinking.slice(-THINKING_CAP) : thinking
  const showThinking = running || !!thinking

  // Fix 1 — worker model block: the worker's model field is the
  // delegation-resolved truth; reasoning inherits from the orchestrator
  // session. `config.set` cannot write delegation.provider in this checkout,
  // so control is an explicit spawn instruction + config.yaml manual override.
  const spawnModel = worker.model || orchModel || ''
  const spawnReasoning = orchReasoning || 'inherit'
  const spawnHint = `For each task: use model ${spawnModel || "the orchestrator's current model"} with reasoning ${spawnReasoning} for the worker. Include this explicitly in each task's goal/context.`

  const doSteer = async () => {
    const text = steerText.trim()
    if (!text) {
      return
    }
    setBusy('steer')
    try {
      await onSteer(worker.subagent_id, text)
      setSteerText('')
    } finally {
      setBusy('')
    }
  }

  const doInterrupt = async () => {
    if (busy) {
      return
    }
    setBusy('interrupt')
    try {
      await onInterrupt(worker.subagent_id)
    } finally {
      setBusy('')
    }
  }

  // Fix 2 (V4) — full-output copy: orchestrator-history extraction (the
  // completion message carries the full final_response), then summary /
  // output_tail / buffer fallbacks. Never just the last preview.
  const doCopy = async () => {
    setBusy('copy')
    try {
      const full = await fetchFullOutput(worker, sessionId)
      await navigator.clipboard.writeText(full)
      onCopied(`Copied full output for ${worker.subagent_id}`)
    } catch (e) {
      onCopied(`Copy failed: ${rpcErrorText(e)}`)
    } finally {
      setBusy('')
    }
  }

  const doCopyHint = async () => {
    setBusy('hint')
    try {
      await navigator.clipboard.writeText(spawnHint)
      onCopied(`Spawn hint copied for ${worker.subagent_id}`)
    } catch (e) {
      onCopied(`Spawn hint copy failed: ${rpcErrorText(e)}`)
    } finally {
      setBusy('')
    }
  }

  return jsx('div', {
    className: 'flex h-56 flex-col rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-surface-secondary) p-2',
    children: [
      // ── header (fixed, never scrolls) ────────────────────────────────────
      jsx('div', {
        className: 'shrink-0',
        children: [
          jsx('div', {
            className: 'flex items-center gap-1.5',
            children: [
              jsx(StatusBadge, { status: worker.status }),
              jsx('div', {
                className: 'min-w-0 flex-1',
                children: [
                  jsx('div', {
                    className: 'truncate text-xs font-medium text-(--ui-text-primary)',
                    title: goal,
                    children: goal || '(no goal)'
                  }),
                  jsx('div', {
                    className: 'truncate text-[0.6rem] text-(--ui-text-quaternary)',
                    children: [
                      worker.subagent_id,
                      worker.depth ? ` · depth ${worker.depth}` : '',
                      worker.tool_count != null ? ` · ${worker.tool_count} tool${worker.tool_count === 1 ? '' : 's'}` : '',
                      worker.child_session_id ? ' · history' : ''
                    ].join('')
                  })
                ]
              })
            ]
          }),
          // worker model block (fix 1)
          jsx('div', {
            className: 'mt-1 flex items-center justify-between gap-1.5',
            children: [
              jsx('div', {
                className: 'min-w-0 truncate text-[0.6rem] text-(--ui-text-tertiary)',
                title: spawnHint,
                children: [
                  spawnModel
                    ? `Worker model: ${spawnModel} · reasoning ${spawnReasoning}`
                    : `Worker model: inherits orchestrator · reasoning ${spawnReasoning}`
                ]
              }),
              jsx(Button, {
                className: 'h-5 shrink-0 px-1.5 text-[0.6rem]',
                disabled: busy === 'hint',
                onClick: () => void doCopyHint(),
                size: 'sm',
                variant: 'ghost',
                children: busy === 'hint' ? '…' : 'Copy spawn hint'
              })
            ]
          })
        ]
      }),

      // ── middle (bounded, internal scroll; footer never moves) ────────────
      jsx('div', {
        className: 'min-h-0 flex-1 overflow-y-auto',
        children: [
          // thinking block — ALWAYS present while running (ellipsis if empty)
          showThinking
            ? jsx('div', {
                className: 'mt-1.5',
                children: [
                  jsx(Button, {
                    className: 'h-5 px-1 text-[0.6rem] text-(--ui-text-tertiary)',
                    onClick: () => setThinkingOpen(o => !o),
                    size: 'sm',
                    variant: 'ghost',
                    children: thinkingOpen
                      ? '▾ thinking'
                      : `▸ thinking${thinking ? ` (${thinking.length} chars)` : ' (…)'}`
                  }),
                  thinkingOpen
                    ? jsx('div', {
                        className: 'mt-0.5 max-h-24 overflow-y-auto rounded bg-(--ui-surface-tertiary) p-1.5 text-[0.65rem] leading-snug whitespace-pre-wrap text-(--ui-text-secondary)',
                        children: !thinking
                          ? (running ? '…' : '')
                          : thinkingTruncated ? `…${shownThinking}` : shownThinking
                      })
                    : null
                ]
              })
            : null,

          // tool line — fixed-height single line, truncated
          worker.lastTool
            ? jsx('div', {
                className: 'mt-1 flex h-4 items-center gap-1 text-[0.65rem] text-(--ui-text-tertiary)',
                children: [
                  jsx(Codicon, { className: 'size-3 shrink-0', name: 'debug-alt' }),
                  jsx('span', { className: 'truncate', children: truncate(worker.lastTool, 120) })
                ]
              })
            : null,

          // output block — internal scroll. Collapsed shows a truncated
          // preview; once output exceeds OUTPUT_CAP a toggle reveals it fully.
          worker.output || running
            ? jsx('div', {
                className: outputOpen
                  ? 'mt-1 max-h-60 overflow-y-auto rounded bg-(--ui-surface-tertiary) p-1.5 text-[0.65rem] leading-snug whitespace-pre-wrap text-(--ui-text-secondary)'
                  : 'mt-1 max-h-20 overflow-y-auto rounded bg-(--ui-surface-tertiary) p-1.5 text-[0.65rem] leading-snug whitespace-pre-wrap text-(--ui-text-secondary)',
                children: worker.output ? (outputOpen ? worker.output : truncate(worker.output, OUTPUT_CAP)) : (running ? '…' : '')
              })
            : null,
          (worker.output && worker.output.length > OUTPUT_CAP)
            ? jsx('button', {
                className: 'mt-1 text-[0.6rem] text-(--ui-text-tertiary) underline decoration-dotted underline-offset-2 hover:text-foreground',
                onClick: () => setOutputOpen(o => !o),
                type: 'button',
                children: outputOpen ? 'show less' : `show all output (${worker.output.length} chars)`
              })
            : null
        ]
      }),

      // ── footer (always rendered, pinned to card bottom) ───────────────────
      jsx('div', {
        className: 'shrink-0',
        children: [
          // steer row — worker cards only; hidden for past workers (fix 5)
          running
            ? jsx('div', {
                className: 'mt-1.5 flex items-end gap-1.5',
                children: [
                  jsx(Input, {
                    className: 'h-7 min-w-0 flex-1 rounded-md text-xs',
                    onChange: e => setSteerText(e.target.value),
                    onKeyDown: e => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        void doSteer()
                      }
                    },
                    placeholder: 'Steer this worker (⌘↵)',
                    value: steerText
                  }),
                  jsx(Button, {
                    className: 'h-7 shrink-0 px-2 text-xs',
                    disabled: busy === 'steer' || !steerText.trim() || !sessionId,
                    onClick: () => void doSteer(),
                    size: 'sm',
                    children: busy === 'steer' ? '…' : 'Steer'
                  })
                ]
              })
            : null,

          // action row — interrupt for running; copy for all states
          jsx('div', {
            className: running ? 'mt-1.5 flex items-center gap-1.5' : 'mt-1.5 flex items-center gap-1.5',
            children: [
              running
                ? jsx(Button, {
                    className: 'h-6 px-2 text-xs',
                    disabled: busy === 'interrupt' || !sessionId,
                    onClick: () => void doInterrupt(),
                    size: 'sm',
                    variant: 'destructive',
                    children: busy === 'interrupt' ? '…' : 'Interrupt'
                  })
                : null,
              jsx(Button, {
                className: 'h-6 px-2 text-xs',
                disabled: busy === 'copy',
                onClick: () => void doCopy(),
                size: 'sm',
                variant: 'ghost',
                children: busy === 'copy' ? '…' : 'Copy output for forward'
              })
            ]
          })
        ]
      })
    ]
  })
}

// ── pane root ───────────────────────────────────────────────────────────────

function PaneRoot() {
  const [sessionId, setSessionId] = useState(() => currentSessionId(''))
  const [workers, setWorkers] = useState([])
  const [catalog, setCatalog] = useState([])
  const [profiles, setProfiles] = useState([])
  const [orchModel, setOrchModel] = useState('')
  const [orchProvider, setOrchProvider] = useState('')
  const [orchReasoning, setOrchReasoning] = useState('')
  const [draft, setDraft] = useState(null)
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(true)
  const [applying, setApplying] = useState(false)
  // fix 5 — view toggle: 'active' (running) | 'past' (done/interrupted/errored)
  const [view, setView] = useState('active')
  // fix 3 (V4) — pending orchestrator steers: a LIST, each visible until the
  // queued prompt actually drains (detected via session.info turn_started_at
  // changing — the false→true running edge was unreliable and cleared one
  // steer late). Prevents silent "queued, fired later" surprises.
  const [pendingSteers, setPendingSteers] = useState([])
  const pendingSteersRef = useRef([])
  const updatePendingSteers = next => {
    pendingSteersRef.current = next
    setPendingSteers(next)
  }
  // fix 3 — orchestrator steer state
  const [orchSteerText, setOrchSteerText] = useState('')
  const [steeringOrch, setSteeringOrch] = useState(false)
  // FIX 1 — steer-queue drain tracking. The queued prompt.submit for each
  // steer runs at the orchestrator's next turn start (after the fan-out join),
  // so a steer is "drained" once the session leaves the busy turn it was
  // queued under. The old detector dropped exactly ONE steer per
  // turn_started_at change and only latched its baseline when steers were
  // pending — so (a) multiple steers draining under a single observable change
  // under-counted and left leftovers that NEVER cleared, (b) missed event
  // cadence left the queue stuck, and (c) a stale baseline persisted across
  // batches. Robust fix:
  //   • lastTurnStartedRef is latched on EVERY valid observation (event AND
  //     8s poll), independent of the queue — no stale baseline across batches.
  //   • observeTurnStart() clears the ENTIRE queue when a new distinct turn
  //     start appears PAST the turn the batch was queued under, because the
  //     whole queued batch runs in order at the fan-out join. One transition
  //     therefore represents however many steers actually drained.
  const pollInFlight = useRef(false)
  const eventSid = useRef('')
  const lastTurnStartedRef = useRef(null)
  const steerBatchTurnRef = useRef(null)
  const observeTurnStart = tsa => {
    const value = tsa == null ? '' : String(tsa)
    if (!value || value === lastTurnStartedRef.current) {
      return // no valid value, or same turn already seen
    }
    const prev = lastTurnStartedRef.current
    lastTurnStartedRef.current = value
    const pending = pendingSteersRef.current
    if (!pending.length) {
      return
    }
    // Baseline not yet established (prev==null) or the batch lacks a recorded
    // busy-turn baseline: treat this observation as the turn-under-which, do
    // not drain yet (the queued steer hasn't necessarily run).
    if (prev == null || steerBatchTurnRef.current == null) {
      if (steerBatchTurnRef.current == null) {
        steerBatchTurnRef.current = prev == null ? value : steerBatchTurnRef.current
      }
      return
    }
    // Orchestrator advanced past the busy turn the steers were queued under —
    // every queued steer has run. Clear the whole queue (handles N steers in
    // one transition, and cadence-missed transitions across polls).
    if (value !== steerBatchTurnRef.current) {
      updatePendingSteers([])
      steerBatchTurnRef.current = null
      const n = pending.length
      const last = pending[n - 1]
      setStatus(
        n === 1
          ? `Orchestrator steer delivered: "${truncate(last ? last.text : '', 80)}"`
          : `${n} orchestrator steers delivered (last: "${truncate(last ? last.text : '', 80)}")`
      )
    }
  }

  // Refresh the active-session id from the live atom periodically (the atom
  // can be null on a fresh draft and populate once a session activates).
  useEffect(() => {
    const t = window.setInterval(() => {
      setSessionId(s => currentSessionId(eventSid.current) || s)
    }, POLL_MS)
    return () => window.clearInterval(t)
  }, [])

  /** Upsert a worker card keyed by subagent_id. `_appendOutput` marks output
   *  chunks that ACCUMULATE (subagent.text / subagent.complete previews) —
   *  never overwrite; everything else replaces its field. */
  const upsertWorker = patch => {
    const rec = asRecord(patch)
    const sid = str(rec.subagent_id)
    if (!sid) {
      return
    }
    setWorkers(prev => {
      const idx = prev.findIndex(w => w.subagent_id === sid)
      if (idx === -1) {
        const initialOutput = rec.outputBuffer != null
          ? str(rec.outputBuffer)
          : rec.output != null ? str(rec.output) : ''
        return [
          ...prev,
          {
            subagent_id: sid,
            parent_id: rec.parent_id ? str(rec.parent_id) : '',
            depth: rec.depth != null ? rec.depth : 0,
            goal: rec.goal != null ? str(rec.goal) : '',
            model: rec.model ? str(rec.model) : '',
            child_session_id: rec.child_session_id ? str(rec.child_session_id) : '',
            started_at: rec.started_at || null,
            tool_count: rec.tool_count != null ? rec.tool_count : 0,
            status: rec.status ? normalizeStatus(rec.status) : 'running',
            thinking: rec.thinking ? str(rec.thinking) : '',
            lastTool: rec.lastTool ? str(rec.lastTool) : '',
            summary: rec.summary != null ? str(rec.summary) : '',
            outputTail: Array.isArray(rec.outputTail) ? rec.outputTail : [],
            output: initialOutput,
            outputBuffer: initialOutput
          }
        ]
      }
      const next = [...prev]
      const cur = next[idx]
      let output = cur.output
      let outputBuffer = cur.outputBuffer || ''
      if (rec._appendOutput && rec.output != null) {
        const chunk = str(rec.output)
        if (chunk) {
          outputBuffer = outputBuffer ? `${outputBuffer}\n\n${chunk}` : chunk
          output = outputBuffer
        }
      } else if (rec.output != null) {
        outputBuffer = str(rec.output)
        output = outputBuffer
      }
      next[idx] = {
        ...cur,
        parent_id: rec.parent_id != null ? str(rec.parent_id) : cur.parent_id,
        depth: rec.depth != null ? rec.depth : cur.depth,
        goal: rec.goal != null ? str(rec.goal) : cur.goal,
        model: rec.model ? str(rec.model) : cur.model,
        child_session_id: rec.child_session_id ? str(rec.child_session_id) : cur.child_session_id,
        started_at: rec.started_at || cur.started_at,
        tool_count: rec.tool_count != null ? rec.tool_count : cur.tool_count,
        status: rec.status ? normalizeStatus(rec.status) : cur.status,
        thinking: rec.thinking != null ? str(rec.thinking) : cur.thinking,
        lastTool: rec.lastTool != null ? str(rec.lastTool) : cur.lastTool,
        summary: rec.summary != null ? str(rec.summary) : cur.summary,
        outputTail: Array.isArray(rec.outputTail) ? rec.outputTail : cur.outputTail,
        output,
        outputBuffer
      }
      return next
    })
  }

  /** Poll session.info (→ delegation.status) as the backstop live-worker
   *  source, coalesced. Poll records MERGE into existing workers so
   *  accumulated fields (outputBuffer, child_session_id, thinking) survive. */
  const pollWorkers = async () => {
    if (pollInFlight.current) {
      return
    }
    pollInFlight.current = true
    try {
      const { active, turn_started_at } = await fetchActiveWorkers()
      // Steer-queue drain backstop: the poll pulls fresh session.info every
      // POLL_MS, so turn_started_at transitions are observed even if the live
      // session.info event is missed or throttled. Deduped inside observeTurnStart.
      observeTurnStart(turn_started_at)
      const seen = new Set()
      const byId = {}
      for (const w of active) {
        const rec = asRecord(w)
        const sid = str(rec.subagent_id)
        if (!sid) {
          continue
        }
        seen.add(sid)
        byId[sid] = {
          subagent_id: sid,
          parent_id: rec.parent_id ? str(rec.parent_id) : '',
          depth: rec.depth != null ? rec.depth : 0,
          goal: rec.goal != null ? str(rec.goal) : '',
          model: rec.model ? str(rec.model) : '',
          started_at: rec.started_at || null,
          tool_count: rec.tool_count != null ? rec.tool_count : 0,
          status: rec.status ? normalizeStatus(rec.status) : 'running'
        }
      }
      setWorkers(prev => {
        const merged = prev.map(w => {
          const poll = byId[w.subagent_id]
          if (!poll) {
            return { ...w, status: w.status === 'running' ? 'done' : w.status }
          }
          return { ...w, ...poll }
        })
        const fresh = Object.values(byId).filter(w => !prev.some(p => p.subagent_id === w.subagent_id))
        return [...fresh, ...merged]
      })
      setStatus('')
    } catch (err) {
      setStatus(`Worker poll failed: ${rpcErrorText(err)}`)
    } finally {
      pollInFlight.current = false
      setLoading(false)
    }
  }

  /** Initial load: session id, catalog, orchestrator config, live workers. */
  const refresh = async () => {
    setLoading(true)
    setStatus('')
    const sid = currentSessionId(eventSid.current)
    if (sid) {
      setSessionId(sid)
    }
    try {
      const providers = await fetchModelOptions()
      setCatalog(providers)
    } catch (e) {
      setStatus(`Model catalog failed: ${rpcErrorText(e)}`)
    }
    try {
      const list = await fetchProfiles()
      setProfiles(list)
    } catch (e) {
      setStatus(`Profile list failed: ${rpcErrorText(e)}`)
    }
    if (sid) {
      try {
        const cfg = await readOrchestratorConfig(sid)
        if (cfg.model) {
          setOrchModel(cfg.model)
        }
        if (cfg.provider) {
          setOrchProvider(cfg.provider)
        }
        setOrchReasoning(cfg.reasoning)
        if (cfg.errors.length) {
          setStatus(cfg.errors.join(' · '))
        }
      } catch (e) {
        setStatus(`Orchestrator config failed: ${rpcErrorText(e)}`)
      }
    }
    await pollWorkers()
  }

  // Mount: subscribe to the subagent.* event family + initial load.
  useEffect(() => {
    refresh()
    const disposers = SUBAGENT_EVENTS.map(type =>
      host.onEvent(type, event => {
        const payload = asRecord(event && event.payload)
        const sid = event && event.session_id
        if (sid) {
          eventSid.current = str(sid)
        }
        if (!payload.subagent_id) {
          return
        }
        switch (type) {
          case 'subagent.start':
            upsertWorker({
              subagent_id: payload.subagent_id,
              parent_id: payload.parent_id,
              depth: payload.depth,
              goal: payload.goal || payload.preview,
              model: payload.model,
              child_session_id: payload.child_session_id,
              tool_count: payload.tool_count,
              status: 'running'
            })
            break
          case 'subagent.thinking':
            upsertWorker({ subagent_id: payload.subagent_id, thinking: payload.preview || payload.text })
            break
          case 'subagent.text':
            upsertWorker({ subagent_id: payload.subagent_id, output: payload.preview || payload.text, _appendOutput: true })
            break
          case 'subagent.tool':
            upsertWorker({
              subagent_id: payload.subagent_id,
              lastTool: [payload.tool_name, payload.preview].filter(Boolean).join(' · '),
              tool_count: payload.tool_count
            })
            break
          case 'subagent.complete':
            upsertWorker({
              subagent_id: payload.subagent_id,
              status: payload.status || 'done',
              summary: payload.summary || payload.preview || payload.text,
              outputTail: Array.isArray(payload.output_tail) ? payload.output_tail : undefined,
              output: payload.summary || payload.preview || payload.text,
              _appendOutput: true
            })
            break
          case 'subagent.progress':
            upsertWorker({ subagent_id: payload.subagent_id })
            break
          default:
            break
        }
      })
    )
    // Also latch the session id from session.info events.
    const sidDisp = host.onEvent('session.info', event => {
      const sid = event && event.session_id
      if (sid) {
        eventSid.current = str(sid)
        setSessionId(str(sid))
      }
    })
    // FIX 1 — steer-queue drain listener. turn.start is NOT broadcast as a
        // gateway event (verified server.py), but session.info IS emitted at turn
        // start and carries `turn_started_at` (server.py:7557). Feed observeTurnStart
        // (which is robust to N steers draining per observable change and to missed
        // event cadence); the 8s poll below is the reliable backstop that also feeds
        // it, so a transition isn't missed even if this event stops firing.
        const runDisp = host.onEvent('session.info', event => {
          const sid = event && event.session_id
          if (!sid) {
            return
          }
          const payload = asRecord(event && event.payload)
          if (sid !== currentSessionId(eventSid.current)) {
            return
          }
          observeTurnStart(payload.turn_started_at)
        })
    const poll = window.setInterval(() => void pollWorkers(), POLL_MS)
    return () => {
      disposers.forEach(d => d && d())
      sidDisp && sidDisp()
      runDisp && runDisp()
      window.clearInterval(poll)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Worker spawn config — does NOT mutate the orchestrator session. The pane
  // must never change the main session's model/reasoning (user finding: Apply
  // pushed selections into the orchestrator). config.set cannot write
  // delegation.provider in this checkout, so per-worker model control is the
  // copied spawn instruction the orchestrator pastes into each task's goal.
  const copySpawnInstruction = async () => {
    const d = asRecord(draft)
    const profile = (d.profile || '').trim()
    const model = (d.model || orchModel || '').trim()
    const provider = (d.provider || orchProvider || '').trim()
    const reasoning = ((d.reasoning || orchReasoning) || '').trim()
    const text = buildSpawnInstruction(profile, model, provider, reasoning)
    setApplying(true)
    try {
      await navigator.clipboard.writeText(text)
      setStatus('Spawn instruction copied — paste it into the orchestrator prompt (per-task goal)')
    } catch (e) {
      setStatus(`Spawn instruction copy failed: ${rpcErrorText(e)}`)
    } finally {
      setApplying(false)
    }
  }

  const steerWorker = async (subagentId, text) => {
    try {
      const res = await gate('subagent.steer', {
        subagent_id: subagentId,
        text,
        session_id: sessionId
      })
      const rec = asRecord(res)
      setStatus(
        rec.status === 'queued'
          ? `Steer queued for ${subagentId}`
          : rec.status === 'rejected'
            ? `Steer rejected for ${subagentId} — not this session's worker`
            : `Steer: ${rpcErrorText(res)}`
      )
      if (rec.status === 'queued') {
        upsertWorker({ subagent_id: subagentId, output: `⏩ steer queued: ${truncate(text, 120)}`, _appendOutput: true })
      }
    } catch (err) {
      setStatus(`Steer failed: ${rpcErrorText(err)}`)
    }
  }

  const interruptWorker = async subagentId => {
    try {
      const res = await gate('subagent.interrupt', {
        subagent_id: subagentId,
        session_id: sessionId
      })
      const rec = asRecord(res)
      setStatus(rec.found === false ? `Interrupt: worker ${subagentId} not found` : `Interrupt sent to ${subagentId}`)
      upsertWorker({ subagent_id: subagentId, status: 'interrupted' })
    } catch (err) {
      setStatus(`Interrupt failed: ${rpcErrorText(err)}`)
    }
  }

  // Fix 3 — orchestrator steer: queue the prompt; _handle_busy_submit runs it
  // AFTER the orchestrator's current turn (the fan-out join).
  const steerOrchestrator = async () => {
    const text = orchSteerText.trim()
    if (!text || !sessionId) {
      return
    }
    setSteeringOrch(true)
    try {
      const res = await gate('prompt.submit', { session_id: sessionId, text, queued: true })
      const rec = asRecord(res)
      if (rec.error) {
        setStatus(`Orchestrator steer not queued: ${rpcErrorText(rec.error)}`)
      } else {
        // Record the busy turn this steer was queued under (FIX 1 drain baseline).
        if (!pendingSteersRef.current.length) {
          steerBatchTurnRef.current = lastTurnStartedRef.current
        }
        updatePendingSteers([...pendingSteersRef.current, { text, queuedAt: Date.now() }])
        setStatus('queued — will run after the orchestrator\'s current turn (fan-out join)')
        setOrchSteerText('')
      }
    } catch (err) {
      setStatus(`Orchestrator steer failed: ${rpcErrorText(err)} — prompt was not queued`)
    } finally {
      setSteeringOrch(false)
    }
  }

  const sortedWorkers = useMemo(
    () =>
      [...workers].sort((a, b) => {
        if (a.status === 'running' && b.status !== 'running') {
          return -1
        }
        if (b.status === 'running' && a.status !== 'running') {
          return 1
        }
        return String(a.started_at || 0).localeCompare(String(b.started_at || 0))
      }),
    [workers]
  )

  // fix 5 — filter render only; all workers stay in state
  const filteredWorkers = useMemo(
    () => sortedWorkers.filter(w => (view === 'active' ? w.status === 'running' : w.status !== 'running')),
    [sortedWorkers, view]
  )

  const runningCount = workers.filter(w => w.status === 'running').length

  return jsx('div', {
    className: 'flex h-full flex-col',
    children: [
      // header
      jsx('div', {
        className: 'border-b border-(--ui-stroke-secondary) px-2 py-1.5',
        children: [
          jsx('div', {
            className: 'flex items-center justify-between gap-2',
            children: [
              jsx('div', {
                className: 'min-w-0',
                children: [
                  jsx('div', {
                    className: 'truncate text-xs font-semibold text-(--ui-text-primary)',
                    children: sessionId ? `Orchestrator · ${sessionId}` : 'Orchestrator'
                  }),
                  jsx('div', {
                    className: 'text-[0.6rem] text-(--ui-text-quaternary)',
                    children: [orchModel, orchProvider ? ` (${orchProvider})` : '', orchReasoning ? ` · reasoning ${orchReasoning}` : ''].join('') || 'no active session'
                  })
                ]
              }),
              // Active/Past segmented toggle (fix 5)
              jsx('div', {
                className: 'flex shrink-0 items-center gap-0.5 rounded-md border border-(--ui-stroke-secondary) p-0.5',
                children: [
                  jsx(Button, {
                    'aria-label': 'Show active workers',
                    className: 'h-5 px-2 text-[0.65rem]',
                    onClick: () => setView('active'),
                    size: 'sm',
                    variant: view === 'active' ? 'secondary' : 'ghost',
                    children: `Active${runningCount ? ` ${runningCount}` : ''}`
                  }),
                  jsx(Button, {
                    'aria-label': 'Show past workers',
                    className: 'h-5 px-2 text-[0.65rem]',
                    onClick: () => setView('past'),
                    size: 'sm',
                    variant: view === 'past' ? 'secondary' : 'ghost',
                    children: 'Past'
                  })
                ]
              }),
              jsx(Tip, {
                label: 'Refresh workers + orchestrator config',
                children: jsx(Button, {
                  'aria-label': 'Refresh',
                  className: 'shrink-0 text-(--ui-text-tertiary) hover:text-foreground',
                  onClick: () => void refresh(),
                  size: 'sm',
                  variant: 'ghost',
                  children: jsx(Codicon, { name: 'refresh' })
                })
              })
            ]
          })
        ]
      }),

      // worker spawn config (NOT orchestrator-session mutation)
      jsx('div', {
        className: 'border-b border-(--ui-stroke-secondary) px-2 py-1.5',
        children: [
          jsx('div', {
            className: 'mb-1 text-[0.6rem] font-semibold uppercase tracking-wider text-(--ui-text-tertiary)',
            children: 'Worker spawn config'
          }),
          jsx(ModelControls, {
            catalog,
            disabled: !!applying || !sessionId,
            model: (draft && draft.model) || orchModel,
            onChange: patch => setDraft(d => ({ ...(d || {}), ...patch })),
            provider: (draft && draft.provider) || orchProvider
          }),
          // FIX 5 — cost disclaimer slot. Text is a placeholder; another agent
          // writes the final copy. Render ALWAYS so the orchestrator can swap
          // the constant text without touching this render site.
          jsx('div', {
            className: 'mt-1 text-[0.6rem] leading-snug text-(--ui-text-tertiary)',
            children: COST_DISCLAIMER
          }),
          jsx('div', {
            className: 'mt-1.5 flex items-center gap-1.5',
            children: [
              jsx(ProfileSelect, {
                disabled: !!applying || !sessionId,
                onChange: v => setDraft(d => ({ ...(d || {}), profile: v })),
                profiles,
                value: (draft && draft.profile) || ''
              }),
              jsx(ReasoningSelect, {
                disabled: !!applying || !sessionId,
                onChange: v => setDraft(d => ({ ...(d || {}), reasoning: v })),
                value: (draft && draft.reasoning) || orchReasoning
              }),
              jsx(Button, {
                className: 'h-7 shrink-0 px-2 text-xs',
                disabled: !!applying || !sessionId,
                onClick: () => void copySpawnInstruction(),
                size: 'sm',
                children: applying ? '…' : 'Copy spawn instruction'
              })
            ]
          }),
          // FIX 3c — helper text: a profile-spawned worker runs as its own
          // process and will not appear in this pane.
          jsx('p', {
            className: 'mt-1 text-[0.6rem] leading-snug text-(--ui-text-tertiary)',
            children: "Profile-spawned workers run outside this pane and won't appear in it."
          }),
          // fix 3 — orchestrator steer row (queued via prompt.submit)
          jsx('div', {
            className: 'mt-1.5 flex items-end gap-1.5',
            children: [
              jsx(Input, {
                className: 'h-7 min-w-0 flex-1 rounded-md text-xs',
                onChange: e => setOrchSteerText(e.target.value),
                onKeyDown: e => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    void steerOrchestrator()
                  }
                },
                placeholder: 'Steer orchestrator — queued after its current turn (⌘↵)',
                value: orchSteerText
              }),
              jsx(Button, {
                className: 'h-7 shrink-0 px-2 text-xs',
                disabled: steeringOrch || !orchSteerText.trim() || !sessionId,
                onClick: () => void steerOrchestrator(),
                size: 'sm',
                children: steeringOrch ? '…' : 'Steer'
              })
            ]
          })
        ]
      }),

      // pending orchestrator steer chip(s) — PERSISTENT until each drains at
      // the next turn start (turn_started_at change). Shows EVERY queued steer.
      pendingSteers.length
        ? jsx('div', {
            className: 'border-b border-(--ui-stroke-tertiary) bg-(--ui-bg-tertiary) px-2 py-1.5',
            children: [
              ...pendingSteers.map((s, i) =>
                jsx('div', {
                  key: `${s.queuedAt}-${i}`,
                  className: 'flex items-center gap-1.5',
                  children: [
                    jsx(Codicon, { className: 'size-3 shrink-0 text-(--ui-text-secondary)', name: 'clock' }),
                    jsx('span', {
                      className: 'min-w-0 flex-1 truncate text-[0.65rem] text-(--ui-text-primary)',
                      title: s.text,
                      children: `⏳ #${i + 1} Steer queued: ${truncate(s.text, 140)}`
                    })
                  ]
                })
              ),
              jsx('div', {
                className: 'mt-1 flex items-center justify-between gap-1.5',
                children: [
                  jsx('span', {
                    className: 'text-[0.6rem] text-(--ui-text-tertiary)',
                    children: 'Each runs when the orchestrator\'s current turn ends (fan-out join), in order.'
                  }),
                  jsx(Button, {
                    className: 'h-5 shrink-0 px-1.5 text-[0.6rem]',
                    onClick: () => {
                      updatePendingSteers([])
                      steerBatchTurnRef.current = null
                      setStatus('Steer queue cleared locally — already-queued prompts may still run')
                    },
                    size: 'sm',
                    variant: 'ghost',
                    children: 'clear all'
                  })
                ]
              })
            ]
          })
        : null,

      // visible status line (instrumentation: never a bare silent return)
      status
        ? jsx('div', {
            className: 'border-b border-(--ui-stroke-secondary) px-2 py-1 text-[0.65rem] text-(--ui-text-secondary)',
            children: status
          })
        : null,

      // worker list / empty state
      jsx('div', {
        className: 'min-h-0 flex-1 overflow-y-auto p-2',
        children: loading
          ? jsx(Spinner, { label: 'Loading workers…' })
          : !filteredWorkers.length
            ? jsx(EmptyState, {
                title: view === 'active' ? 'No active workers' : 'No past workers',
                description:
                  view === 'active'
                    ? 'Post a delegate_task fan-out from the orchestrator session and live worker cards appear here: thinking streams, tool lines tick, and you can steer or interrupt each worker, or copy its full output to forward to another.'
                    : 'Finished, interrupted, and errored subagents appear here with their final output ready to copy. Steer and interrupt are only available while a worker is active.'
              })
            : jsx('div', {
                className: 'flex flex-col gap-2',
                children: [
                  jsx('div', {
                    className: 'text-[0.6rem] font-semibold uppercase tracking-wider text-(--ui-text-tertiary)',
                    children: view === 'active'
                      ? `${filteredWorkers.length} worker${filteredWorkers.length === 1 ? '' : 's'}${runningCount ? ` · ${runningCount} running` : ''}`
                      : `${filteredWorkers.length} past worker${filteredWorkers.length === 1 ? '' : 's'}`
                  }),
                  ...filteredWorkers.map(w =>
                    jsx(WorkerCard, {
                      key: w.subagent_id,
                      onCopied: msg => setStatus(msg),
                      onInterrupt: interruptWorker,
                      onSteer: steerWorker,
                      orchModel,
                      orchReasoning,
                      sessionId,
                      worker: w
                    })
                  )
                ]
              })
      })
    ]
  })
}

// ── plugin export ────────────────────────────────────────────────────────────

export default {
  id: ID,
  name: 'Chief of Staff',
  version: '0.4.0',
  description: 'Fan-out command center: live subagent worker cards, per-worker steer + interrupt, queued orchestrator steer, worker model + spawn hints, full-output copy, Active/Past toggle, and orchestrator model/reasoning control.',

  register(ctx) {
    ctx.register({
      id: 'chief-of-staff-pane',
      area: 'panes',
      title: 'Chief of Staff',
      data: {
        placement: 'right',
        width: 380
      },
      render: () => jsx(PaneRoot, {})
    })
  }
}
