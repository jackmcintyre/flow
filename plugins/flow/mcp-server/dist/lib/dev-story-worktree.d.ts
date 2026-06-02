/**
 * `materialiseDevStoryWorktree` — Story 8.16, superseded by Story 8.20.
 *
 * Cuts a dedicated git worktree for the drain's generalist-dev step so the dev
 * **edits and builds inside the worktree**, not in the orchestrating session's
 * `targetRepoRoot` checkout. This is the true-parallelism substrate: when the
 * dev's *editing surface* (not merely its commit) is its own worktree, two devs
 * working the same repository at once cannot cross-pollute each other's
 * in-flight changes, and one flow's cleanup cannot revert a sibling's work.
 *
 * History — what 8.20 changed:
 *
 *   Story 8.16 (PR #212) isolated only the dev's git *work product*: the dev
 *   still edited in the shared `targetRepoRoot`, and this helper transplanted
 *   the dev's own changed paths into the worktree afterwards (current-dirty
 *   minus a pre-edit baseline) then reverted them in the checkout on cleanup.
 *   That baseline-diff attribution is correct for a *serial* drain but breaks
 *   under concurrency: two devs editing the same checkout each see the other's
 *   edits as "their own", and one flow's cleanup reverts files the other is
 *   still editing.
 *
 *   Story 8.20 makes the dev edit *in* the worktree (the workflow spawns the dev
 *   subagent with the runtime's per-agent `isolation: 'worktree'` primitive, so
 *   its file-editing sandbox root *is* the worktree). A worktree cut clean from
 *   `base` therefore contains ONLY the dev's own edits — so the
 *   snapshot-dirty-paths baseline, the current-minus-baseline transplant, and
 *   the orchestrating-checkout restore are all gone. The correctness floor 8.16
 *   fought for (no stray pre-existing change ever rides into a story commit) is
 *   now preserved *structurally*: the worktree never contains anything but the
 *   dev's work, so there is nothing to attribute and nothing to subtract.
 *
 * Worktree location (8.20 design point 3): a **sibling of the checkout**, under
 * `<parent>/.crew-worktrees/<sessionUlid>/dev-<ref>-worktree`, NOT nested inside
 * `targetRepoRoot`. A nested worktree would make a dev's own file search / build
 * scan recurse into a self-copy, and would put concurrent worktrees inside the
 * shared tree. The worktree still shares the checkout's `.git` object store and
 * `origin` remote (it is a real `git worktree`), so `gh` resolves the same repo
 * and `git worktree list` enumerates every session's worktrees — which is how
 * stale-session leftovers are reaped (see `reapStaleDevStoryWorktrees`).
 *
 * Mirrors the precedent `materialise-pr-branch-worktree.ts` (Story 5.26):
 * `git worktree add --detach` off the base and a best-effort idempotent
 * `cleanup()`. The static `canonical-fs-guard` test allows this file to spawn
 * `git` directly (same precedent as 8.16 / 5.26).
 */
import { execa as defaultExeca } from "execa";
export interface DevStoryWorktreeResult {
    /** Absolute path to the materialised worktree (the dev's editing + git surface). */
    worktreePath: string;
    /** Diagnostic log from the setup phase (stale-worktree reaping, etc.). */
    setupLog: string[];
    /**
     * Best-effort teardown: removes THIS worktree only. Errors become warnings,
     * NOT fatal — repeated drains must not accumulate orphaned worktrees, and a
     * failure mid-build must not leave the worktree wedged. Crucially it touches
     * ONLY this story's worktree path, so a concurrent flow's worktree is never
     * disturbed (8.20 AC4).
     */
    cleanup: () => Promise<{
        warnings: string[];
    }>;
}
export interface DevStoryWorktreeOpts {
    /** The orchestrating session's checkout — the `.git` host the worktree is cut from. */
    targetRepoRoot: string;
    sessionUlid: string;
    /** Story ref — used to name the worktree path deterministically. */
    ref: string;
    /** Base branch the worktree (and ultimately the PR) is cut from. */
    base: string;
    /** Test seam — production callers do not pass this. */
    execaImpl?: typeof defaultExeca;
    /**
     * Test seam for the `git worktree add` retry backoff — production callers do
     * not pass this (the default awaits a real timer). Injecting a no-op keeps the
     * unit test that drives the lock-contention retry path instant.
     */
    sleepImpl?: (ms: number) => Promise<void>;
}
/**
 * The directory that holds ALL of a session's dev-story worktrees — a sibling
 * of the checkout, never nested inside it. Exported so the reaper and tests
 * derive the same root.
 */
export declare function devStoryWorktreesRoot(targetRepoRoot: string, sessionUlid: string): string;
/** The worktree path for one story in one session. Exported for the reaper/tests. */
export declare function devStoryWorktreePath(targetRepoRoot: string, sessionUlid: string, ref: string): string;
export declare function materialiseDevStoryWorktree(opts: DevStoryWorktreeOpts): Promise<DevStoryWorktreeResult>;
export interface ReapStaleDevStoryWorktreesResult {
    /** Absolute paths of stale worktrees that were removed (or attempted). */
    reaped: string[];
    /** Non-fatal warnings (a removal that failed). */
    warnings: string[];
}
/**
 * Reap dev-story worktrees left behind by *other* (dead) sessions.
 *
 * A worker that dies mid-build leaves a worktree keyed by its now-dead session
 * id. The per-path stale-reap in `materialiseDevStoryWorktree` only matches the
 * *live* session's own path, so cross-session leftovers would otherwise
 * accumulate forever. The crash-recovery scan already identifies dead sessions;
 * this reaps their leftover worktrees too (8.20 AC4).
 *
 * Enumerates registered worktrees via `git worktree list --porcelain`, keeps
 * only those under the dev-story worktrees parent (`<parent>/.crew-worktrees/`)
 * whose session segment is NOT the current session, and removes each. Removing
 * one stale worktree NEVER disturbs the current session's worktree or another
 * dead session's — each removal targets one explicit path.
 *
 * Best-effort and read-tolerant: a non-zero `git worktree list` (e.g. not a
 * repo) returns an empty result rather than throwing, so a degraded git state
 * never blocks the drain.
 */
export declare function reapStaleDevStoryWorktrees(opts: {
    targetRepoRoot: string;
    currentSessionUlid: string;
    execaImpl?: typeof defaultExeca;
}): Promise<ReapStaleDevStoryWorktreesResult>;
