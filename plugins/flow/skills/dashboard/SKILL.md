---
name: flow:dashboard
description: One-shot cockpit — plugin/repo status, the outstanding backlog grouped by epic, and your hired team, in one read-only view.
allowed_tools: [Read, getStatus, getBacklogDashboard, getTeamSnapshot]
version: 0.1.0
---

# /flow:dashboard

# What this skill does

The cockpit's single **read surface**. One command renders three labelled sections in order:

1. **Status** — plugin version, resolved target-repo path, active adapter (and whether its config still matches the repo), standards-doc state, and the current cycle (from `getStatus`).
2. **Backlog** — the outstanding backlog as grouped-by-epic tables generated from live state, with each item's state (`to-do` / `in-progress` / `blocked` / `done` / `native-source-only`), readiness (`ready` / `not ready`), and claimability (from `getBacklogDashboard`). An approved item still blocked on an unmet dependency reads `ready` but `not claimable` — do not misread it as buildable.
3. **Team** — every hired role with its domain, fire count, and most recent knowledge entries (from `getTeamSnapshot`).

This single command replaces the former `/flow:status`, `/flow:board`, and `/flow:team` commands. It is **read-only**: it mutates nothing, starts no build, and touches no git. Every section is generated live from `.flow/state/**` and `team/**` — nothing here is hand-maintained, which is the old failure mode the cockpit replaces.

To **approve or unapprove** an item (flip its readiness), use `/flow:ready`. To **author or discard** items, use `/flow:plan`. To **hire** roles, use `/flow:hire`. This skill only shows the dashboard.

# Prerequisites

A target repo. The **Status** and **Backlog** sections need `.flow/config.yaml` resolved (auto-detected on first run by the workspace resolver — see `docs/README-install.md` checkpoint 5). The **Team** section works on a fresh repo before any config exists. An empty backlog or an unhired team each render a clean empty-state line — neither is an error.

# Steps

1. Identify the target repo root (the current Claude Code workspace root) as `targetRepoRoot`.
2. Render the three sections **in order**, each under its own `##` heading. For each section, call its tool and print the tool's text response **verbatim** under the heading — the tools already return fully rendered, deterministic text.
   - `## Status` — call `getStatus({ targetRepoRoot })`.
   - `## Backlog` — call `getBacklogDashboard({ targetRepoRoot })`.
   - `## Team` — call `getTeamSnapshot({ targetRepoRoot, knowledgeLimit: 3 })`.
3. **Per-section error handling (the point of the unified view).** Handle each section independently. If a section's tool call throws, do NOT abort the dashboard — print that section's `##` heading followed by a single line `  unavailable — {error message}` and continue to the next section. The common case: on a repo with no `.flow/config.yaml`, `getStatus` and `getBacklogDashboard` surface a resolver/adapter error while the **Team** section still renders. Surfacing the error per-section, rather than failing the whole command, is exactly why the three reads live in one place.

The plugin's automatic skill-usage sensor records this invocation deterministically (a `PreToolUse` hook on the `Skill` tool), so this skill records no telemetry of its own — doing so would double-count it relative to every other skill.

Never write to a manifest file, never edit `.flow/state/**`, and never run a git command from this skill. Your job is to call the three read tools and present their output.

# Failure modes

- **No `.flow/config.yaml` / no adapter matches:** the **Status** and **Backlog** sections each render `unavailable — {typed error}` (the error already tells the operator to init a planning tool the plugin understands, or follow `docs/README-install.md` step 5); the **Team** section still renders. Resolve the target repo and re-run.
- **`.flow/config.yaml` exists but the listed adapter no longer matches the repo:** the Status section's `adapter:` line shows `{name} (mismatched)` and lists other matching adapters — no exception is thrown, the report carries the downgrade.
- **A backlog manifest is malformed:** the **Backlog** section renders `unavailable — {MalformedExecutionManifestError naming the file and field}`. Fix the manifest (or re-run `/flow:plan` to re-materialise) and retry; the other two sections are unaffected.
- **A single persona file is malformed:** `getTeamSnapshot` renders the per-role `error:` stanza inline and continues for the remaining roles; the **Team** section as a whole still renders.
- **`docs/standards.md` missing or malformed:** the Status section's `standards:` line shows `missing` or `malformed` (with the absolute path). Run `cp plugins/flow/docs/standards-example.md {target-repo}/docs/standards.md` to fix (README-install.md checkpoint 5).
</content>
</invoke>
