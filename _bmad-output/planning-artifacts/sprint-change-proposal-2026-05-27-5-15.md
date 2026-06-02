---
date: 2026-05-27 (late session)
author: Jack (via correct-course fast-path)
scope: Minor
trigger: First dogfood canary, post pre-Epic-5 hygiene promotion
supersedes: none — co-exists with sprint-change-proposal-2026-05-27.md (the 5.13 stub from this morning)
---

# Sprint Change Proposal — Story 5.15 (gh pr view --json baseRepository)

## 1. Issue Summary

Today's first dogfood canary after the pre-Epic-5 hygiene promotion (`pre-dogfood-resumption-1` tag) surfaced a real reviewer-path defect: every `/flow:start` reviewer step halts with `Unknown JSON field: "baseRepository"` from `gh pr view`. Three tool sites query a `gh` field that does not exist on the live `gh` schema (gh 2.92.0). The unit test that should have caught this mocks a synthetic shape with the bad field name, so CI is green.

**Canary evidence:** scratch repo `jackmcintyre/scratch` PR #1 (kept open intentionally for re-run). Story manifest sits in `.flow/state/in-progress/` with the reviewer-failure block, ready to be picked up by L1b orphan-recovery once the fix ships.

**Full diagnosis:** `/tmp/handoff-2026-05-27-canary-baseRepository-fix.md`.

## 2. Impact Analysis

- **Epic impact:** Epic 5. New story 5.15; no scope movement on other 5.x stories. (Story 5.14 number deliberately skipped — no pre-existing claim.)
- **Story impact:** new substrate story 5.15. 5.10/5.11/5.12/5.13 already done. `epic-5-retrospective` stays `optional`.
- **Artifact conflicts:** none — purely additive.
- **Technical impact:**
  - 3 source files in `plugins/flow/mcp-server/src/tools/` change call sites.
  - 1 existing test fixture updated (`run-auto-merge-gate.test.ts:54`).
  - 2 new tests added (1 real-gh integration, 1 grep-guard against `baseRepository` regression).
  - No schema, telemetry, or surface changes.
- **Dogfood resumption:** blocked until 5.15 merges. No other open canary findings of this severity.

## 3. Recommended Approach

**Direct adjustment.** Stub Story 5.15 in epic-5 + sprint-status, ship via `/ship-story 5-15` as a single substrate PR onto `dev`, merge, then re-run the canary against the preserved scratch orphan (this also exercises Story 5.11's L1b orphan-recovery branch for the first time).

- **Effort:** small. ~3-file source change + 1 fixture migration + 2 small tests.
- **Risk:** low. Replacement (`gh repo view --json owner,name`) is the canonical way to get current-repo identity; semantics match because PRs in the canary target the current repo.
- **Timeline:** in the same session window.

## 4. Detailed Change Proposals

### 4.1 Epic file — append Story 5.15 block ✅ APPLIED

`_bmad-output/planning-artifacts/epics/epic-5-orchestration-recovery-visibility-and-resilience.md` — Story 5.15 block appended after Story 5.13.

ACs at a glance (all carry `artifact:` / `vitest:` markers — guards against the AC-marker gap documented in memory):
- **AC1** — replace 3 call sites; pick `gh repo view --json owner,name` (or `git config` parse — spec author's call).
- **AC2** — real-gh integration test, skipped when `gh` unavailable on host.
- **AC3** — cheap grep-guard test against `baseRepository` reappearing in src/.
- **AC4** — update mock in `run-auto-merge-gate.test.ts:54` to match the new shape.
- **AC5 (manual)** — canary re-run validates end-to-end. Documented in retro notes, not a CI gate.

### 4.2 Sprint status — backlog entry ✅ APPLIED

`_bmad-output/implementation-artifacts/sprint-status.yaml`: inserted `5-15-fix-gh-pr-view-base-repository-non-field: backlog` between `5-13-...: done` and `epic-5-retrospective: optional`. Bumped `last_updated` comment.

### 4.3 No PRD / architecture / UX changes

Substrate defect, not a scope change.

## 5. Implementation Handoff

**Scope:** Minor — direct implementation by `/ship-story 5-15`.

**Next actions:**
1. `/ship-story 5-15` — full BMad cycle. Spec author writes the spec from the epic block.
2. Merge the resulting PR to `dev`.
3. Re-run canary in the preserved scratch dir (path in `/tmp/crew-canary-scratch-path`); `/flow:start` should pick up the orphan and reach reviewer success.
4. Tear down scratch on success (`rm -rf $SCRATCH`; delete `jackmcintyre/scratch` GH repo).

**Success criteria:**
- `/flow:start` reviewer step on scratch PR #1 no longer halts with `Unknown JSON field: "baseRepository"`.
- `pnpm test` green; new grep-guard test would have failed before the fix.
- Dogfood resumption proceeds to the next gate (canary-shape, per Jack-call list).
