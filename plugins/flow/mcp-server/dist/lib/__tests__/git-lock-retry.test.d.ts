/**
 * Regression tests for concurrent git-lock-contention retry in the mutating
 * git helpers — `gitCreateBranch`, `gitCommit`, `gitPush` (src/lib/git.ts).
 *
 * Concurrent drain workers (Story 8.22) run these ops against the SAME shared
 * `.git` (worktrees share the common dir; they push to one origin). Git does NOT
 * serialise concurrent ref/config/push transactions — the loser exits non-zero
 * with a transient lock error. This surfaced as a flaky `concurrent-drains-
 * isolation` test that reds CI under load. The helpers now retry transient lock
 * failures with a short backoff and re-throw any non-lock failure unchanged.
 *
 * These tests are deterministic — they inject lock failures via a stub `execa`
 * (which throws on a git failure exactly as the real execa reject does, and
 * returns a non-zero result for the reject:false push path) and a no-op sleep,
 * so no real process races.
 *
 * vitest: plugins/flow/mcp-server/src/lib/__tests__/git-lock-retry.test.ts
 */
export {};
