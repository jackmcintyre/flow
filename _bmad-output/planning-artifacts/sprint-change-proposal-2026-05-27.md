# Sprint Change Proposal — 2026-05-27

## Issue summary

Story 5.13 is named in the pre-Epic-5 enhancement plan (`~/.claude/plans/ok-now-i-want-imperative-axolotl.md` item #5) as the next ship. Neither the epic-5 story block nor the sprint-status entry exists yet, so `/ship-story 5-13` would fail with `NO_ELIGIBLE_STORY`.

## Impact analysis

- **Epic 5 file** (`_bmad-output/planning-artifacts/epics/epic-5-orchestration-recovery-visibility-and-resilience.md`): append Story 5.13 block after 5.12.
- **sprint-status.yaml**: insert `5-13-planner-validator-prose-vs-manifest-deps-at-scan-time: backlog` between 5.12 and `epic-5-retrospective`.
- **PRD / Architecture / UX**: no impact. This is substrate hardening using established patterns (Zod boundaries, scan-time validation, typed `blocked_by` enum).

## Recommended approach

**Direct Adjustment**, **Minor scope**. Single epic-file append + single sprint-status line. Spec authoring happens later inside `/ship-story 5-13`'s Step 4 (opus + bmad-create-story).

Rationale: 5.13 is the last functional pre-dogfood item per the re-sequenced plan. Closes L4 (planner contracts enforceable at scan time, per postmortem 2026-05-25) and the typed-`blocked_by` carry-forward from Epic 4's retro. Both fit a single ship because the typed enum's members include the planner-validator's `deps-drift` reason — designing them coherently is cheaper than splitting.

## Detailed change proposals

### Change 1 — Epic 5 file

Append Story 5.13 block to `_bmad-output/planning-artifacts/epics/epic-5-orchestration-recovery-visibility-and-resilience.md`, after the existing 5.12 closing `---` separator. Block matches the shape of 5.11 / 5.12 (header, source/dependency notes, user-story triplet, AC list with integration ACs).

ACs (full text in the epic file):
- **AC1** — `scanSources` extracts dep references from spec body; drift between extracted set and manifest `depends_on` refuses the scan-write with a `[deps-drift]` stderr line. Spec author owns exact extraction patterns.
- **AC2** — `blocked_by` migrates from free string to Zod-typed enum with 10 initial members (including `orphan-no-transcript` from 5.11 and `deps-drift` from AC1).
- **AC3** — `/flow:start`'s blocked-recovery surface uses the typed reason to render a per-case operator hint (memory `project_blocked_recovery_prose_lies`).
- **AC4 (integration)** — vitest covers drift-refusal, Zod boundary rejection, and per-enum operator hints.
- **AC5 (integration)** — existing `blocked/` test fixtures migrated to typed values.

### Change 2 — sprint-status.yaml

Insert line 79 between 5.12 (done) and `epic-5-retrospective: optional`:

```yaml
5-13-planner-validator-prose-vs-manifest-deps-at-scan-time: backlog
```

## Implementation handoff

**Scope:** Minor. Direct edit, no backlog reorganisation needed. Hand off to `/ship-story 5-13`; Step 4 will spawn `bmad-create-story` (opus) to author the full spec.

**Success criteria:**
- `/ship-story 5-13` resolves without `NO_ELIGIBLE_STORY`.
- Opus spec author produces a 5.13 spec with exact extraction patterns for AC1 and a migration plan for AC2/AC5.
- Single PR ships against `dev` per the post-2026-05-25 trunk discipline.
