/**
 * `reapStaleWorktrees` tool — Story 8.20 AC4.
 *
 * Crash-orphan reaping for dev-story worktrees. A worker that dies mid-build
 * leaves a worktree keyed by its now-dead session id; the per-path stale-reap in
 * `materialiseDevStoryWorktree` only matches the *live* session's own path, so
 * cross-session leftovers would otherwise accumulate forever. The run's
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
import { reapStaleDevStoryWorktrees } from "../lib/dev-story-worktree.js";
import { writeSessionHeartbeat } from "../lib/session-liveness.js";

export interface ReapStaleWorktreesResult {
  reaped: string[];
  warnings: string[];
}

export async function reapStaleWorktrees(opts: {
  targetRepoRoot: string;
  sessionUlid: string;
  execaImpl?: typeof defaultExeca;
  /** Test seam — production callers omit this. */
  isSessionAliveImpl?: (targetRepoRoot: string, sessionUlid: string) => Promise<boolean>;
}): Promise<ReapStaleWorktreesResult> {
  // INITIAL HEARTBEAT (Story native:01KTSQWJ — the liveness WRITE side). This is
  // the run's first session-bearing seam in the recover phase, so establishing
  // the heartbeat here makes this run visible as alive BEFORE it does any long
  // work (a concurrently-starting second run must not treat us as a dead orphan
  // while our first build is in flight). Fail-soft: a heartbeat write must never
  // break reaping — a missed write just means the next per-story seam refreshes it.
  try {
    await writeSessionHeartbeat(opts.targetRepoRoot, opts.sessionUlid);
  } catch {
    /* best-effort: liveness is refreshed again on the next claim/build seam */
  }
  const { reaped, warnings } = await reapStaleDevStoryWorktrees({
    targetRepoRoot: opts.targetRepoRoot,
    currentSessionUlid: opts.sessionUlid,
    ...(opts.execaImpl ? { execaImpl: opts.execaImpl } : {}),
    ...(opts.isSessionAliveImpl ? { isSessionAliveImpl: opts.isSessionAliveImpl } : {}),
  });
  return { reaped, warnings };
}
