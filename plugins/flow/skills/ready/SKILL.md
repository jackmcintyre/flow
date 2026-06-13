---
name: flow:ready
description: "The intake cockpit — list backlog items with their readiness and dependency state, and approve (or unapprove) a chosen item so the dev loop may claim it."
allowed_tools: [listClaimableTodos, markStoryReady]
---

<!-- Behavioural contract source: _bmad-output/implementation-artifacts/9-1-readiness-brake-and-minimal-intake-cockpit.md -->

# /flow:ready

# What this skill does

This is the minimal **intake cockpit** for the readiness brake (Epic 9). The drain only ever claims a backlog item once you have explicitly marked it **ready** — a freshly-scanned item sits in the backlog but is *not claimable* until you approve it here. `/flow:ready` lets you:

1. **See the backlog** — every un-claimed item in `to-do/`, with its readiness flag and whether its dependencies are satisfied.
2. **Toggle readiness** — flip a chosen item to ready (admit it to the claim queue) or back to not-ready (park it behind the brake).

Readiness is a flat operator flag on the item's manifest, orthogonal to its status. Marking an item ready does **not** move it between states, does **not** start any build, and does **not** touch git — it only flips the gate the drain checks before claiming. Everything flows through the `markStoryReady` tool; this skill never edits a manifest file directly and never runs a git command.

This story ships **only the brake** — listing and toggling. It does not author new items, reorder the backlog, or auto-approve anything; those are later Epic 9 stories. For now, you approve by hand.

# Prerequisites

A target repo with `.flow/config.yaml` resolved and at least one scanned backlog item under `<target-repo>/.flow/state/to-do/` (run `/flow:scan` first if the backlog is empty).

# Steps

1. Identify the target repo root (the current Claude Code workspace root) as `targetRepoRoot`.
2. Call the `listClaimableTodos` MCP tool with `{ targetRepoRoot }`. It returns `todos: [{ ref, title, depends_on, depsReady, ready }]` for every un-claimed backlog item, plus `inProgressCount`.
3. Render the backlog as a readable table or list. For each item show:
   - `shortHandle` alongside `ref` and `title` — display the short handle (`shortHandle` field from each `ClaimableCandidate`) as the primary identifier on each line (e.g. `[01KT1NR9] native:01KT1NR9… — My story title`). The short handle is always non-empty and is much more readable at a glance than the full ref.
   - **ready** — `ready` (approved, claimable) or `not ready` (behind the brake)
   - **deps** — `deps ready` when `depsReady` is true; otherwise `waiting on: <unmet depends_on refs>`
   - A one-line note that an item is only claimed by the drain when it is BOTH `ready` AND `deps ready`.
   If `todos` is empty, say the backlog has no un-claimed items and point the operator at `/flow:scan` (to scan source stories) or `/flow:plan`.
4. If the operator named an item (and a direction) when invoking the skill, or once they tell you which item to toggle and whether to mark it ready or not-ready, call the `markStoryReady` MCP tool with `{ targetRepoRoot, ref: <chosen ref>, ready: <true|false> }`. Do this once per chosen item.
5. Print the tool's result. On a real toggle it reports the new `ready` value and `noop: false`; when the item already held that value it reports `noop: true` (nothing changed). Then re-run step 2/3 so the operator sees the updated backlog.

Never write to a manifest file, never edit `.flow/state/**`, and never run a git command from this skill — the `markStoryReady` tool owns every mutation. Your job is to present the backlog and relay the operator's toggle through the tool.

# Failure modes

- **The named ref is not an un-claimed backlog item:** `markStoryReady` throws `NotAnEligibleBacklogItemError`. The readiness brake only applies to items still waiting in `to-do/` — an item that has already been claimed (`in-progress/`), completed (`done/`), blocked, withdrawn, or that does not exist cannot be toggled. Surface the error verbatim; it names the precise reason. To retire an item from the backlog, use `/flow:plan` (discard), not this skill.
- **No `.flow/config.yaml` / no backlog:** if `listClaimableTodos` returns an empty `todos` list, the backlog has nothing to approve yet — run `/flow:scan` to project source stories into the backlog first.
- **A backlog manifest is malformed:** `listClaimableTodos` propagates `MalformedExecutionManifestError`, naming the file and offending field. Fix the manifest (or re-run `/flow:scan`) and retry.
