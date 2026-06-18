---
name: flow:dashboard
description: "One dashboard command that replaces the separate status, board, and team views"
allowed_tools: [getStatus, getBacklogDashboard, getTeamSnapshot]
version: 0.1.0
---

# /flow:dashboard

# What this skill does

This is the **unified cockpit**. It combines three separate read surfaces into one command: **team** (roles and health), **backlog** (grouped by epic with per-item status), and **system** (plugin version and adapter state). Running `/flow:dashboard` replaces running `/flow:status`, `/flow:board`, and `/flow:team` separately.

The dashboard renders three clearly labelled sections:

1. **Team** — Your hired roster: roles, domains, fire counts (invocation count), and recent knowledge entries.
2. **Backlog** — Your outstanding stories, grouped by epic, showing state, readiness, and claimability.
3. **System** — Plugin version, target repo, active adapter, standards-doc state, and current cycle.

Each section is independent: if one data source fails to load, the other two still render with a clear 'could not load [section]' note in the failed section.

# Prerequisites

- A target repo with `.flow/config.yaml` resolved (required for status and backlog sections; team section does not require it).
- Empty states render cleanly: an empty team shows 'nothing here yet', an empty backlog shows 'nothing here', and missing adapter shows appropriate guidance.

# Steps

1. **Identify the target repo root** as `targetRepoRoot` (the current Claude Code workspace root).
2. **Fetch each section independently with per-section error handling:**
   - **Team:** Call `getTeamSnapshot({ targetRepoRoot, knowledgeLimit: 3 })`. On success, capture the rendered snapshot. On error, capture a labelled 'could not load team' note.
   - **Backlog:** Call `getBacklogDashboard({ targetRepoRoot })`. On success, capture the rendered dashboard. On error, capture a labelled 'could not load backlog' note.
   - **System:** Call `getStatus({ targetRepoRoot })`. On success, capture the five-line status block. On error, capture a labelled 'could not load system status' note.
3. **Render the unified dashboard** with three clearly labelled sections:
   ```
   === FLOW DASHBOARD ===

   [ TEAM ]
   {team snapshot or error note}

   [ BACKLOG ]
   {backlog dashboard or error note}

   [ SYSTEM ]
   {status block or error note}
   ```
4. Print the rendered output verbatim.

# Failure modes

- **Team snapshot fails:** Render `  — could not load team` and continue.
- **Backlog dashboard fails:** Render `  — could not load backlog` and continue.
- **Status check fails:** Render `  — could not load system status` and continue.
- **All three fail:** All three sections show their respective error notes. The command still completes (not a hard failure).
- **No `.flow/config.yaml` (adapter resolution required):** The status and backlog sections fail with `NoAdapterMatchedError` or similar; their error notes render. The team section (no adapter required) may still succeed. The overall dashboard completes with partial content.

# Notes

- This skill calls three independent data-fetch tools, each wrapped in error handling. No section's failure blocks the others.
- The skill does not mutate state, start a build, or touch git. It is a pure read-only aggregation of existing tools.
- `/flow:status`, `/flow:board`, and `/flow:team` are now marked **not user-invocable** in their metadata, but their underlying MCP tools (`getStatus`, `getBacklogDashboard`, `getTeamSnapshot`) remain callable and are used by this dashboard skill.
