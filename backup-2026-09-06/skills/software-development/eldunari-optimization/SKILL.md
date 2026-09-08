---
name: eldunari-optimization
description: "Audit and optimize the Eldunari consciousness structure after absorption."
version: 1.0.0
author: Azaraki (azaraki), Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [eldunari, consciousness, optimization, audit, cleanup]
    related_skills: [eldunari-absorption]
---

# Eldunari Optimization Skill

> Post-absorption audit and optimization of the Eldunari consciousness structure. Triggers after absorption completes or when the user requests an optimization run.

## When to Use

- After any absorption run that added >20 documents
- The user says "optimize", "clean up", "audit", "densify"
- Heartbeat shows >50 orphan documents or >50 patterns with zero reuse
- Root doc line counts exceed thresholds (GIT>80, CODIFICATION>80, ACCESS>80)

**Don't use for:** Absorption itself (use `eldunari-absorption`).

## Prerequisites

- Eldunari exist at `/Users/kethuda/.hermes/eldunari/`
- Heartbeat script is operational (`python3 scripts/heartbeat.py`)
- `find-links.py` script exists for orphan detection

## Optimization Targets (Priority Order)

### 1. Delete Redundant Root Docs (Highest Leverage)

Before trimming lines, check if entire files duplicate content from other sources:

| Suspect File | Check For | If Redundant |
|---|---|---|
| `ROLES.md` | `influence-map.md` + ANIMAs | Delete |
| `CAPABILITIES.md` | `influence-map.md` + `ROLES.md` | Delete |
| `EXECUTION.md` | `ETL.md` + `ITERATION.md` | Delete |
| `TENSION_LIFECYCLE.md` | `CODIFICATION.md` | Merge into parent |
| `ANTI_EXPERIENCE.md` | `CODIFICATION.md` | Merge into parent |

### 2. Trim Bloated Root Docs

Target ranges for root doc lines:
- `GIT.md`: 40-60 lines
- `CODIFICATION.md`: 50-70 lines
- `ACCESS.md`: 50-70 lines
- `ABSORPTION.md`: 40-60 lines
- `ONBOARDING.md`: 40-60 lines
- `FLOW.md`: 60-80 lines
- `INTERCONNECTION.md`: 50-70 lines

Trim by removing:
- Verbose explanations that duplicate the document's own structure
- Section headers that repeat the file's title
- Examples that illustrate what the code/template already shows

### 3. ANIMA.md Length Compliance

ACCESS.md says "ideally under 100 lines." Check all 6 ANIMAs:

```bash
cd /Users/kethuda/.hermes/eldunari && wc -l anima/*/ANIMA.md | sort -rn
```

If any ANIMA.md > 100 lines:
- Remove duplicate sections (often "Current Focus" duplicates "Where I Am Growing")
- Compress verbose sections to bullet points
- Move detailed project descriptions to venture docs, not ANIMA.md
- ANIMA.md is identity + growth, not a project status doc

### 4. Pattern Reuse Discipline

The #1 signal of pattern inflation: patterns with zero reuse after 30+ days.

```bash
# Count orphan patterns
python3 scripts/heartbeat.py 2>&1 | grep "orphans"
```

Fix patterns:
- Every new experience MUST cite at least one pattern via frontmatter or inline link
- Patterns with zero reuse after 30 days: either extract a more general pattern or delete
- Don't create a pattern for every insight — only cross-session reusable principles

### 5. Document Linking (Orphan Reduction)

Run the orphan detector:

```bash
python3 scripts/find-links.py
```

For each orphan (>5 orphans triggers action):
- Add 2+ outgoing links to semantically related files
- Link from the new document to existing patterns/experiences
- Update the related document to link back

Target: <20 orphan documents total.

## What NOT to Optimize

- Don't optimize for commit count — vanity metric
- Don't celebrate completion — celebrate measurement
- Don't add documentation to fix behavior problems — fix behavior
- Don't redesign roles without changing the execution model

## The Meta-Pattern

Documentation changes without behavior change = decorative optimization.
Real optimization subtracts complexity and improves measurement.

If your optimization only adds files or sections, you're doing it wrong.

## Verification

After optimization:
- `python3 scripts/heartbeat.py` shows stable or improved metrics
- Total root doc lines decreased
- Orphan count decreased
- No ANIMA.md > 100 lines
- `git log` shows cleanup commits with clear descriptions

## Session References

- [references/post-absorption-2026-08-22.md](references/post-absorption-2026-08-22.md) — full audit from first optimization run
