/**
 * `reapStaleWorktrees` tool — Story 8.20 AC4.
 *
 * Crash-orphan reaping for dev-story worktrees. A worker that dies mid-build
 * leaves a worktree keyed by its now-dead session id; the per-path stale-reap in
 * `materialiseDevStoryWorktree` only matches the *live* session's own path, so
 * cross-session leftovers would otherwise accumulate forever. The drain's
 * crash-recovery phase calls this BEFORE the main loop (alongside
 * `scanOrphanedInProgress`) to remove worktrees left by dead sessions, keying
 * the keep/skip decision on the live session id — exactly as the crash-recovery
 * scan keys on the live session for in-progress manifests.
 *
 * Pure orchestration over `reapStaleDevStoryWorktrees`; the git spawning lives in
 * `lib/dev-story-worktree.ts` (the sanctioned worktree git-spawn module). Returns
 * `{ reaped, warnings }`. Best-effort: never throws on a degraded git state.
 */
import { execa as defaultExeca } from "execa";
export interface ReapStaleWorktreesResult {
    reaped: string[];
    warnings: string[];
}
export declare function reapStaleWorktrees(opts: {
    targetRepoRoot: string;
    sessionUlid: string;
    execaImpl?: typeof defaultExeca;
}): Promise<ReapStaleWorktreesResult>;
