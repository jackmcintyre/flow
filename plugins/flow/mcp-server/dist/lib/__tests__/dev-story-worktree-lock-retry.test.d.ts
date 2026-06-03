/**
 * Regression tests for `materialiseDevStoryWorktree`'s retry on concurrent
 * `git worktree add` lock contention.
 *
 * Two drain workers (Story 8.22) can fire `git worktree add` against the SAME
 * `.git` at once and collide on git's internal config/index/ref locks; the loser
 * exits non-zero with a transient lock error. Git does NOT serialise these, which
 * surfaced as a flaky `concurrent-drains-isolation` test that reds CI under load.
 * These tests pin the fix deterministically — they do NOT race real processes:
 * a stub `execaImpl` injects a lock error on chosen `git worktree add` attempts
 * and passes everything else through to real git, so the retry path is exercised
 * with zero timing dependence (a no-op `sleepImpl` keeps it instant).
 *
 * vitest: plugins/flow/mcp-server/src/lib/__tests__/dev-story-worktree-lock-retry.test.ts
 */
export {};
