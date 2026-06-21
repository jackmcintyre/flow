# Story 8.18: Drain progress heartbeat through long phases

story_shape: substrate
Status: ready-for-dev

## Story

As an **operator who walks away during a drain**,
I want **the drain to emit a clear progress line as it enters and leaves each phase of a story — especially the long dev-build phase — with elapsed time**,
So that **I can tell at a glance whether the run is making progress or has hung, without reading agent transcripts**.

This was surfaced by the first real end-to-end drain (2026-05-30): the dev-build phase ran for roughly ten minutes emitting nothing to the operator-facing narrator, because the loop only logs at coarse seam boundaries (session start, claim, PR number, verdict, gate) and the entire claim→PR span is a single long agent call with no intermediate signal. To an operator, a long silent build is indistinguishable from a hang. This is a low-risk observability change — it adds narrator output only and changes no control flow.

## Dependencies

- None. Touches the drain workflow's existing narrator (`log()`) call sites only.

## Acceptance Criteria

**AC1 — each story phase emits a start line and a completion line with elapsed time (unit):**

The drain emits an operator-facing progress line when it ENTERS each major per-story phase (at minimum: dev-build, review, gate) and when it LEAVES that phase, and the leave-line includes the elapsed wall-clock time for that phase. A pure helper that formats these progress lines (given a phase name, a transition (start/done), and an elapsed duration) is unit-tested: it asserts a start line and a done-with-elapsed line are produced for a representative phase, and that the duration is rendered in a human-readable form.
vitest: plugins/crew/mcp-server/src/lib/__tests__/format-drain-progress.test.ts

**AC2 — the long dev-build phase is explicitly marked as the long-running one (unit):**

The dev-build start line carries an explicit signal that this is the longest phase (so an operator reading the narrator understands a multi-minute gap here is expected, not a hang). The progress-line helper renders this marker for the dev-build phase and the test asserts it is present for dev-build and absent for the short phases.
vitest: plugins/crew/mcp-server/src/lib/__tests__/format-drain-progress.test.ts

**AC3 — progress lines are additive and do not alter drain outcomes (integration):**

The progress lines are emitted through the existing narrator channel and change no control flow: the set of result buckets (completed / merged / pausedForHuman / blocked) and the drain reason for a run are identical with and without the new lines. An existing-style drain integration test (with seams stubbed) asserts the run's structured result is unchanged and that the new progress lines appear in the captured narrator output.
vitest: plugins/crew/mcp-server/src/tools/__tests__/drain-progress-heartbeat.test.ts

## Notes

The drain loop is `plugins/crew/workflows/drain.workflow.js`. Today it calls `log()` at: session start, orphan-recovery transitions, `claimed <ref>`, `<ref> -> PR #<n>`, `<ref> verdict -> <v>`, and gate outcomes. The silent span is between `claimed <ref>` and `-> PR #<n>` — the single long dev `agent()` call. Add a `log()` immediately BEFORE the dev spawn (marking it the long phase) and after it returns (with elapsed time), and similarly bracket the review and gate steps.

Put the line-formatting in a small pure helper module under `plugins/crew/mcp-server/src/lib/` (e.g. `format-drain-progress.ts`) so it is unit-testable and the workflow just calls it — keep the workflow change to inserting `log(formatX(...))` calls. Note a runtime constraint to respect, not fight: workflow scripts cannot call `Date.now()`/`new Date()` (the runtime forbids it for resume-determinism), so derive elapsed time from a clock value the runtime already provides or pass timing in rather than calling the wall clock directly inside the script — the helper itself should take an elapsed-ms number as input (keeping it pure) and let the caller supply it via whatever clock seam the workflow runtime allows. A true periodic mid-`agent()` heartbeat (a line every N seconds DURING the single long dev call) is out of scope here — it needs concurrency the serial loop does not have; this story delivers phase-boundary milestones + elapsed time, which closes the "is it hung?" gap. If you find a safe way to emit a periodic tick, note it as a follow-up rather than expanding this story.

This change touches the workflow plus a new pure helper + its tests: rebuild and commit `dist/` in the same change (CI fails on `src`/`dist` drift), keep the diff scoped, and run the full `pnpm build` and `pnpm test` from `plugins/crew/mcp-server` green before opening the PR. It is a `low`-risk change (additive narrator output, new pure module, no control-flow change). Do not write or edit any execution manifest or `.crew/state` file; the tools own the ledger.
