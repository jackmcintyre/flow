# Sprint Change Proposal — 2026-05-25

**Trigger:** Dogfood rollback documented in `_bmad-output/postmortems/2026-05-25-dogfood-rollback.md`.
**Scope:** Moderate. Three new stories added to Epic 5; no changes to PRD, architecture, or UX.
**Mode:** Batch (Jack pre-approved the slicing before this workflow ran).

## Issue summary

A single `/flow:start` invocation on bmad:4.14 exposed three compounding tool defects (MCP idle-reap, no orphan-recovery in the outer loop, transient dev transcript). Cascade produced one orphaned story, two half-shipped PRs, and a full rollback to `0a3f2b7`. Full timeline + root causes in the postmortem.

## Impact analysis

- **Epic 5 (Orchestration • Recovery • Visibility • Resilience):** three new stories appended (5.10, 5.11, 5.12). Existing Epic 5 stories untouched.
- **Sprint status:** three new `backlog` entries; `last_updated` bumped to 2026-05-25.
- **PRD / architecture / UX:** no changes. The new work hardens existing recovery surfaces; it doesn't change requirements.
- **Other epics:** none. Epic 4 work remains backlogged; the dogfood pause does not affect its authoring queue.

## Recommended approach

**Direct adjustment** — add the three stories within the existing Epic 5 plan. Rationale:

- Theme fits ("session dies; recover cleanly").
- All three are pure substrate hardening — no scope change to the product surface.
- Smaller intervention than a new epic; preserves the Epic 5 narrative.

**Sequencing:**
1. **5.10** first (transcript persistence — cheapest, blocks 5.11).
2. **5.11** next (orphan recovery — depends on 5.10).
3. **5.12** independently (MCP reap resilience — may resolve via Anthropic-side knob).

**Dogfooding pause:** `/flow:start` remains paused until 5.10 + 5.11 + at least one of 5.12's three accepted paths is merged. Substrate work uses `/ship-story` on the `dev` branch.

## Detailed change proposals

### Epic 5 — append three story blocks

See `_bmad-output/planning-artifacts/epics/epic-5-orchestration-recovery-visibility-and-resilience.md` after this proposal applies. Each stub follows the existing 5.x format (user story, ACs, integration-test AC at the end).

### Sprint status — append three backlog entries

```
5-10-persist-dev-transcript-to-disk-before-any-mcp-call: backlog
5-11-orphan-recovery-branch-in-crew-start: backlog
5-12-mcp-child-resilient-to-parent-stdin-close: backlog
```

`last_updated` bumped to `2026-05-25`.

### CLAUDE.md + memory entries

Already applied in a separate commit on `dev`:
- "Current posture (post 2026-05-25 rollback)" section in `CLAUDE.md`.
- Memory entries: `project-dev-branch-is-trunk`, `project-dogfood-paused-until-l1`, `feedback-stop-dont-fix-forward`.

## Implementation handoff

**Scope:** Moderate. Three stories enter `backlog`; the next step is `/bmad-create-story` against 5.10, then `/ship-story` to deliver.

**Recipient:** developer agent (via `/ship-story`).

**Success criteria:**
- 5.10 PR merged to `dev` with transcript-on-disk vitest coverage.
- 5.11 PR merged to `dev`; orphan-recovery integration test seeded with-and-without persisted transcript.
- 5.12 PR merged to `dev` via path (a), (b), or (c) — whichever Anthropic's host architecture permits.
- Postmortem L1 marked addressed; dogfood pause lifted by PM (Jack) after a clean smoke run.
