/**
 * Integration tests for the drain's dev step editing INSIDE its own worktree —
 * Story 8.20 (true drain parallelism, part 1: the isolation substrate).
 *
 * Story 8.16 isolated only the dev's git *work product* (branch/commit/PR) by
 * transplanting the dev's changed paths from the shared orchestrating checkout
 * into a worktree afterwards. 8.20 makes the dev's *editing surface* the worktree
 * itself: the runtime roots the dev subagent in a worktree (per-agent
 * `isolation: 'worktree'`), the dev edits and builds there, and
 * `runDevTerminalAction` commits the worktree's own dirty set. The orchestrating
 * checkout is therefore NEVER the dev's editing surface and is never touched —
 * there is no transplant-then-restore window in which the shared checkout holds
 * the edits.
 *
 * These tests model that by materialising a clean worktree (what the runtime's
 * isolation primitive does), writing the dev's edits INTO the worktree, then
 * running `runDevTerminalAction` with `targetRepoRoot` pointed at the worktree
 * (gh/pnpm stubbed, real git everywhere else against a tmpdir repo with a real
 * bare origin). Asserts:
 *
 *   AC1 — the dev's changes appear ONLY in the worktree; `git -C <orchestrating
 *         checkout> status --porcelain` never reports the dev's files as dirty,
 *         at any point during or after the dev step.
 *   AC2 — a pre-existing dirty change in the orchestrating checkout never rides
 *         into the story commit and is left exactly as-is (the correctness floor
 *         8.16 guaranteed, now structural: the worktree is cut clean from base).
 *
 * vitest: plugins/flow/mcp-server/src/tools/__tests__/dev-edits-in-worktree.test.ts
 */
export {};
