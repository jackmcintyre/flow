# Story 8.7: Summarise drain result

story_shape: substrate
Status: ready-for-dev

## Story

As a **plugin operator**,
I want **a pure helper that renders the stateless drain's structured return as a single human-readable line**,
So that **after a drain run I can see at a glance what happened — how many stories completed, merged, paused for me, or blocked — without parsing the raw object**.

This is the bootstrap story for the Stage-1 stateless-drain dogfood (Epic 8): a small, low-risk, pure additive helper the autonomous drain builds end-to-end as the proof-point. No I/O, no side effects, no existing files changed.

## Dependencies

- None. Leaf story: one new pure module plus its unit test. Does not read or mutate any state.

## Acceptance Criteria

**AC1 — formats a populated drain result into a one-line summary:**

`summariseDrainResult(result)` is a new exported pure function in `plugins/crew/mcp-server/src/lib/summarise-drain-result.ts`. Given a drain return object of shape `{ sessionUlid: string, drainedReason: string, completed: string[], merged: Array<{ ref: string, prNumber: number }>, pausedForHuman: Array<{ ref: string, prNumber: number, reason: string }>, blocked: Array<{ ref: string, blocked_by: string }> }`, it returns a single-line string of the form `drain <sessionUlid>: <C> completed, <M> merged, <P> paused-for-human, <B> blocked (drainedReason: <drainedReason>)`, where each count is the corresponding array's length. The function is pure and deterministic — no I/O, no mutation of the input.
vitest: plugins/crew/mcp-server/src/lib/__tests__/summarise-drain-result.test.ts

**AC2 — handles an all-empty result gracefully:**

Given a result whose `completed` / `merged` / `pausedForHuman` / `blocked` arrays are empty (e.g. `drainedReason: "queue-drained"`), `summariseDrainResult` returns the same one-line shape with every count `0` and does not throw. A missing (undefined) optional array is treated as empty (count `0`) rather than throwing.
vitest: plugins/crew/mcp-server/src/lib/__tests__/summarise-drain-result.test.ts

## Notes

Keep it tiny — a single pure function and a focused unit test. Run `pnpm --dir plugins/crew/mcp-server build && pnpm --dir plugins/crew/mcp-server test` green before opening the PR. Do not touch the execution manifest or any `.crew/state` file.
