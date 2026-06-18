---
name: flow:ready
description: "The intake cockpit — list backlog items with their readiness and dependency state, approve (or unapprove) a chosen item so the dev loop may claim it, or discard an un-built draft permanently."
allowed_tools: [listClaimableTodos, markStoryReady, discardDraft]
---

<!-- Behavioural contract source: _bmad-output/implementation-artifacts/9-1-readiness-brake-and-minimal-intake-cockpit.md -->

# /flow:ready

# What this skill does

This is the **intake cockpit** for the readiness brake (Epic 9). The run only ever claims a backlog item once you have explicitly marked it **ready** — a freshly-scanned item sits in the backlog but is *not claimable* until you approve it here. `/flow:ready` lets you:

1. **See the backlog** — every un-claimed item in `to-do/`, with its readiness flag and whether its dependencies are satisfied.
2. **Toggle readiness** — flip a chosen item to ready (admit it to the claim queue) or back to not-ready (park it behind the brake).
3. **Discard a draft** — permanently remove an un-built draft that you have decided not to build, so it never reappears after a scan.

Readiness is a flat operator flag on the item's manifest, orthogonal to its status. Marking an item ready does **not** move it between states, does **not** start any build, and does **not** touch git — it only flips the gate the run checks before claiming. Everything flows through the `markStoryReady` or `discardDraft` tools; this skill never edits a manifest file directly, never deletes a file directly, and never runs a git command.

# Prerequisites

A target repo with `.flow/config.yaml` resolved and at least one backlog item under `<target-repo>/.flow/state/to-do/` (run `/flow:plan` first if the backlog is empty — the planning flow materialises stories automatically).

# Steps

1. Identify the target repo root (the current Claude Code workspace root) as `targetRepoRoot`.
2. Call the `listClaimableTodos` MCP tool with `{ targetRepoRoot }`. It returns `todos: [{ ref, title, depends_on, depsReady, ready }]` for every un-claimed backlog item, plus `inProgressCount`.
3. Render the backlog as a readable table or list. For each item show:
   - `shortHandle` alongside `ref` and `title` — display the short handle (`shortHandle` field from each `ClaimableCandidate`) as the primary identifier on each line (e.g. `[01KT1NR9] native:01KT1NR9… — My story title`). The short handle is always non-empty and is much more readable at a glance than the full ref.
   - **ready** — `ready` (approved, claimable) or `not ready` (behind the brake)
   - **deps** — `deps ready` when `depsReady` is true; otherwise `waiting on: <unmet depends_on refs>`
   - A one-line note that an item is only claimed by the run when it is BOTH `ready` AND `deps ready`.
   If `todos` is empty, say the backlog has no un-claimed items and point the operator at `/flow:plan` (which materialises stories automatically).
4. **Toggle readiness:** if the operator named an item (and a direction) when invoking the skill, or once they tell you which item to toggle and whether to mark it ready or not-ready, call the `markStoryReady` MCP tool with `{ targetRepoRoot, ref: <chosen ref>, ready: <true|false> }`. Do this once per chosen item.
   - On a real toggle it reports the new `ready` value and `noop: false`; when the item already held that value it reports `noop: true` (nothing changed).
   - Then re-run step 2/3 so the operator sees the updated backlog.
5. **Discard a draft:** if the operator says they want to permanently discard or remove a listed un-claimed item, call the `discardDraft` MCP tool with `{ targetRepoRoot, ref: <chosen ref> }`. This removes both the backlog entry and the underlying source draft file so the item cannot be resurrected by a future scan.
   - On success it reports `{ removed: true, noop: false }`. Re-render the backlog so the operator sees the item is gone.
   - If the ref was already absent, it reports `{ removed: false, noop: true }` — a clean no-op; nothing to show.
   - On a `NotAnEligibleDraftError` (see Failure modes below), surface the typed error message verbatim and do not retry.

Never write to a manifest file, never delete a file directly, never edit `.flow/state/**`, and never run a git command from this skill — the `markStoryReady` and `discardDraft` tools own every mutation. Your job is to present the backlog and relay the operator's intent through the tools.

# Failure modes

- **The named ref is not an un-claimed backlog item (toggle path):** `markStoryReady` throws `NotAnEligibleBacklogItemError`. The readiness brake only applies to items still waiting in `to-do/` — an item that has already been claimed (`in-progress/`), completed (`done/`), blocked, withdrawn, or that does not exist cannot be toggled. Surface the error verbatim; it names the precise reason.
- **The named ref is not eligible for discard (discard path):** `discardDraft` throws `NotAnEligibleDraftError` with one of four machine-readable reasons:
  - `not-in-to-do` — the ref has been claimed (`in-progress/`), completed (`done/`), or blocked; live or completed work may not be discarded.
  - `withdrawn` — the ref is already marked withdrawn; it is already logically retired.
  - `wrong-adapter` — the ref belongs to a non-native adapter; use `/flow:plan` or `markWithdrawn` for external-adapter refs.
  - `not-found` — this reason is never reached on the discard path because absent refs return a no-op result rather than an error; it is listed here for completeness.
  Surface the error verbatim and do not delete any file yourself.
- **No `.flow/config.yaml` / no backlog:** if `listClaimableTodos` returns an empty `todos` list, the backlog has nothing to approve yet — run `/flow:plan` to author and materialise source stories into the backlog.
- **A backlog manifest is malformed:** `listClaimableTodos` propagates `MalformedExecutionManifestError`, naming the file and offending field. Fix the manifest (or re-run `/flow:plan` to re-materialise) and retry.
