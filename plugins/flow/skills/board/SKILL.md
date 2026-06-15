---
name: flow:board
description: "The cockpit read surface — render the outstanding backlog as grouped-by-epic tables generated from live state, with each item's status, readiness, and claimability."
allowed_tools: [getBacklogDashboard]
version: 0.1.0
---

<!-- Behavioural contract source: _bmad-output/implementation-artifacts/9-5-generated-backlog-dashboard.md -->

# /flow:board

# What this skill does

This is the cockpit's **read surface**. It renders the outstanding backlog as **grouped-by-epic tables generated from live state** — never a hand-maintained list. It reads the backlog the same way the rest of the plugin does (the backlog-inventory enumeration over the `.flow/state/**` directories), groups items by epic, and shows each item's:

- **state** — which state bucket the item sits in (`to-do`, `in-progress`, `blocked`, `done`, or `native-source-only`).
- **readiness** — `ready` (approved via `/flow:ready`) or `not ready` (behind the readiness brake).
- **claimability** — `claimable` when the run would claim it (a `to-do` item that is approved AND dependency-satisfied AND not withdrawn); otherwise `not claimable`. An approved item that is still blocked on an unmet dependency reads `ready` but `not claimable` — do not misread it as buildable.

This is a **read-only** view: it mutates nothing, starts no build, and touches no git. The table is **generated output**, not a checked-in file — there is nothing here to hand-edit, which is the old failure mode the cockpit replaces. Everything flows through the `getBacklogDashboard` tool; this skill never reads or writes a manifest file directly and never runs a git command.

To **approve or unapprove** an item (flip its readiness), use `/flow:ready`. To **author** or **discard** items, use `/flow:plan`. This skill only shows the board.

# Prerequisites

A target repo with `.flow/config.yaml` resolved. An empty backlog renders cleanly (a "nothing here" line) — it is not an error.

# Steps

1. Identify the target repo root (the current Claude Code workspace root) as `targetRepoRoot`.
2. Call the `getBacklogDashboard` MCP tool with `{ targetRepoRoot }`. It returns the rendered dashboard text, already grouped by epic with each item's state, readiness, and claimability.
3. Print the returned text verbatim for the operator. If the backlog is empty, the tool already renders a "nothing here" line — relay it as-is.

The plugin's automatic skill-usage sensor records this invocation deterministically (a `PreToolUse` hook on the `Skill` tool), so this skill no longer records its own telemetry — doing so would double-count it relative to every other skill.

Never write to a manifest file, never edit `.flow/state/**`, and never run a git command from this skill. Your job is to call the read tool and present its output.

# Failure modes

- **A backlog manifest is malformed:** `getBacklogDashboard` propagates `MalformedExecutionManifestError`, naming the file and offending field. Fix the manifest (or re-run `/flow:scan`) and retry.
- **No `.flow/config.yaml`:** the underlying workspace resolution surfaces the resolver's typed error verbatim — resolve the target repo (run `/flow:status` to check) and retry.
