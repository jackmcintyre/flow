# Story 8.11: One-line summary of an auto-merge gate outcome

story_shape: substrate
Status: ready-for-dev

## Story

As a **plugin operator**,
I want **a pure helper that renders an auto-merge gate outcome as a single readable line**,
So that **after the gate runs I can see at a glance whether a PR was auto-merged or paused, and why, without inspecting the raw result object**.

This is the Stage-2-for-code proof re-run (Epic 8) after the source-only diff-size fix: a small, self-contained, purely-additive code helper the autonomous drain builds, verifies, CI-gates, and auto-merges end-to-end with zero human intervention. One new module plus its unit test — no existing file is modified.

## Dependencies

- None. Leaf story: one new pure module plus its unit test. No I/O, no state, no imports from existing modules.

## Acceptance Criteria

**AC1 — renders an auto-merged outcome as a one-line summary:**

`summariseGateOutcome(outcome)` is a new exported pure function in `plugins/crew/mcp-server/src/lib/summarise-gate-outcome.ts`. Given an object of shape `{ ref: string, prNumber: number, decision: "auto-merge" | "pause-needs-human", reason: string, merged: boolean }`, it returns a single-line string (no newline characters) that includes the `ref`, the PR number rendered as `PR#<prNumber>`, a human word for the outcome (`auto-merged` when `merged` is true, otherwise `paused for human`), and the `reason`. The function is pure and deterministic — no I/O, no mutation of the input.
vitest: plugins/crew/mcp-server/src/lib/__tests__/summarise-gate-outcome.test.ts

**AC2 — renders a paused outcome and never throws:**

Given an outcome whose `decision` is `"pause-needs-human"` and `merged` is `false` (e.g. `reason: "ci-not-green"`), `summariseGateOutcome` returns the same one-line shape with the `paused for human` wording and the given reason, and does not throw. The function never throws for any input matching the declared shape.
vitest: plugins/crew/mcp-server/src/lib/__tests__/summarise-gate-outcome.test.ts

## Notes

Keep it tiny and self-contained — a single pure function and a focused unit test, mirroring Story 8.7/8.10's shape. Do NOT import from or modify any existing module: accept a plain object and return a `string` so the PR's diff is purely new files (this keeps it classified `low.additive-only`). Run `pnpm --dir plugins/crew/mcp-server build && pnpm --dir plugins/crew/mcp-server test` GREEN before opening the PR, and commit the rebuilt `dist/`. Do not touch the execution manifest or any `.crew/state` file.
