/**
 * Integration tests for TRUE drain parallelism — Story 8.20 (part 1).
 *
 * 8.20 makes each dev's editing surface its own worktree, so multiple drains can
 * run against the same repository at once without corrupting each other's
 * in-flight changes. These tests drive two real dev flows
 * (materialise-worktree → edit-in-worktree → commit/push/PR) CONCURRENTLY against
 * ONE temp git repo (gh/pnpm stubbed, real git everywhere else) and assert the
 * isolation properties the concurrent dispatch (bmad:8.22) will stand on:
 *
 *   AC3 — each concurrent dev's branch/commit/PR contains EXACTLY that story's
 *         own changes: no file authored by the sibling leaks in, and no file the
 *         dev wrote is missing. Neither flow's worktree setup disturbs the
 *         other's in-flight edits.
 *
 *   AC4 — cleanup is concurrency- and crash-safe: a mid-build failure in one flow
 *         leaves a concurrently-running flow's worktree intact and leaves NO
 *         leftover worktree for the failed story; and a worktree left behind by a
 *         worker from a prior, now-dead session is reaped on a subsequent drain
 *         (the stale-reap keys on the live session, not just the live path).
 *
 * vitest: plugins/flow/mcp-server/src/tools/__tests__/concurrent-drains-isolation.test.ts
 */
export {};
