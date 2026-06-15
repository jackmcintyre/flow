/**
 * Session-liveness primitive — Story native:01KTSQWJ62C4XQBDK4NXTEPQC0.
 *
 * Each run writes a heartbeat file (`heartbeat.json`) in its session
 * folder (`.flow/state/sessions/<ulid>/`) while it is executing. The heartbeat
 * carries the process id and a refresh timestamp. Two seams gate on it:
 *
 *   1. `scanOrphanedInProgress` — before treating a manifest claimed by another
 *      session as an orphan, verify that session is dead. A live session's
 *      manifests are left alone; only a confirmed-dead session's manifests are
 *      returned as orphans.
 *
 *   2. `reapStaleDevStoryWorktrees` — before removing a worktree belonging to
 *      another session, verify that session is dead. A live session's worktrees
 *      are left in place; only confirmed-dead sessions' worktrees are reaped.
 *
 * ### Liveness contract
 *
 * `isSessionAlive(targetRepoRoot, sessionUlid)` returns `true` when the
 * heartbeat file exists, the recorded pid is still running
 * (`process.kill(pid, 0)` succeeds), AND the timestamp is within the
 * staleness window. It returns `false` when the pid is absent or dead,
 * or the timestamp is stale beyond the window.
 *
 * **Fail-safe default**: when liveness CANNOT be determined (missing file,
 * malformed JSON, filesystem error), the function returns `false` — i.e. it
 * treats the session as dead so crash-recovery still proceeds. This is the
 * correct safe-fail direction for recovery: a genuinely live run refreshes its
 * heartbeat continuously, so a missing/unreadable heartbeat reliably means the
 * run is gone. The opposite default (treat indeterminate as alive) would strand
 * genuinely abandoned work forever.
 *
 * Note: this is the OPPOSITE of the worktree / PR-gate helpers, which err on
 * the side of NOT reclaiming. For liveness specifically, "cannot determine" ==
 * "treat as dead" because live runs always have a fresh heartbeat; the risk we
 * are guarding against is FALSE ALIVE (protecting a live run from an incorrect
 * dead verdict), not false dead. A missed recovery of a truly dead run is
 * recoverable on the next sweep; force-deleting a live run's work is not.
 *
 * ### Refresh model & staleness window
 *
 * The run has no background timer (it runs as a sequential workflow and is
 * suspended inside long `agent()` build calls), so the heartbeat is NOT refreshed
 * on a fixed interval. Instead it is refreshed EVENT-DRIVEN through the run's
 * own per-story seams: an initial write when the run starts (the reap/recover
 * seam), then again on every `claimNextStory` (before a build) and every
 * `processDevTranscript` (after a build). The longest possible gap between two
 * refreshes is therefore exactly ONE dev build, which is hard-bounded by the
 * build timeout (`DEFAULT_BUILD_TEST_TIMEOUT_MS` = 20 min — the build is killed
 * at that point and the post-build seam refreshes).
 *
 * `HEARTBEAT_STALE_MS` (30 min) must comfortably exceed that one-build ceiling so
 * a live run mid-build is never falsely judged dead (the dangerous direction —
 * a false-dead verdict force-deletes a live run's work). 30 min = 1.5× the 20-min
 * build ceiling. Erring large is safe here: a false-ALIVE verdict only delays
 * recovery of a genuinely dead run until the window lapses (the next sweep gets
 * it), whereas a false-dead corrupts live work.
 */

import * as path from "node:path";
import { promises as fs } from "node:fs";
import { atomicWriteFile } from "./managed-fs.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * How old (ms) the heartbeat timestamp may be before we consider the session
 * dead. Internal: the run refreshes the heartbeat through its per-story seams,
 * so the longest gap between refreshes is one dev build (hard-bounded by the
 * 20-min build timeout). 30 min = 1.5× that ceiling — comfortably larger so a
 * live run mid-build is never judged dead. See the module doc for the
 * event-driven refresh model and the false-dead-vs-false-alive rationale.
 */
const HEARTBEAT_STALE_MS = 30 * 60_000; // 30 minutes

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HeartbeatPayload {
  /** PID of the process that owns this session. */
  pid: number;
  /** ISO-8601 timestamp of when this heartbeat was last written/refreshed. */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Path helper
// ---------------------------------------------------------------------------

/**
 * Absolute path to the heartbeat file for a session.
 *
 * Lives alongside dev-transcript.txt and dev-outcome.json under the session
 * directory: `.flow/state/sessions/<ulid>/heartbeat.json`.
 */
function heartbeatFilePath(
  targetRepoRoot: string,
  sessionUlid: string,
): string {
  return path.join(
    targetRepoRoot,
    ".flow",
    "state",
    "sessions",
    sessionUlid,
    "heartbeat.json",
  );
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/**
 * Write (or refresh) the heartbeat for `sessionUlid` under `targetRepoRoot`.
 *
 * Records the current process pid and a fresh `updatedAt` ISO timestamp.
 * Creates parent directories with `{ recursive: true }`.
 *
 * Uses `atomicWriteFile` (from managed-fs) for atomic writes so a concurrent
 * second refresh never produces a partially-written heartbeat.
 * The write is idempotent: each call stamps a fresh `updatedAt` over the same
 * path; last-writer-wins is fine because only one process owns a given session.
 *
 * Callers (run loop) should refresh on an interval; the initial write
 * establishes the file so a newly-started session is immediately visible as
 * alive to a concurrently-starting sweep.
 */
export async function writeSessionHeartbeat(
  targetRepoRoot: string,
  sessionUlid: string,
): Promise<void> {
  const filePath = heartbeatFilePath(targetRepoRoot, sessionUlid);
  const payload: HeartbeatPayload = {
    pid: process.pid,
    updatedAt: new Date().toISOString(),
  };
  await atomicWriteFile(filePath, JSON.stringify(payload));
}

// ---------------------------------------------------------------------------
// Reader / liveness check
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the session identified by `sessionUlid` appears to be
 * alive — i.e. its heartbeat file exists, its pid is still running, AND its
 * timestamp is within the staleness window.
 *
 * Returns `false` in every other case (including all error paths). See module
 * doc for the fail-safe rationale.
 *
 * @param targetRepoRoot - Absolute path to the repo root.
 * @param sessionUlid    - Session ULID to probe.
 * @param nowMs          - Optional override for "now" (test seam). Defaults to Date.now().
 * @param killImpl       - Optional override for process.kill (test seam). Defaults to process.kill.
 */
export async function isSessionAlive(
  targetRepoRoot: string,
  sessionUlid: string,
  opts?: {
    nowMs?: number;
    killImpl?: (pid: number, signal: number) => void;
  },
): Promise<boolean> {
  const nowMs = opts?.nowMs ?? Date.now();
  const killImpl = opts?.killImpl ?? ((pid: number, signal: number) => process.kill(pid, signal));

  const filePath = heartbeatFilePath(targetRepoRoot, sessionUlid);

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    // ENOENT or any read error → treat as dead (fail-safe).
    return false;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Malformed JSON → treat as dead.
    return false;
  }

  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof (payload as Record<string, unknown>)["pid"] !== "number" ||
    typeof (payload as Record<string, unknown>)["updatedAt"] !== "string"
  ) {
    // Missing/wrong-typed fields → treat as dead.
    return false;
  }

  const { pid, updatedAt } = payload as HeartbeatPayload;

  // --- Timestamp staleness check -------------------------------------------
  const updatedAtMs = new Date(updatedAt).getTime();
  if (!Number.isFinite(updatedAtMs)) {
    // Unparseable timestamp → treat as dead.
    return false;
  }
  if (nowMs - updatedAtMs > HEARTBEAT_STALE_MS) {
    // Timestamp is too old; the process stopped refreshing.
    return false;
  }

  // --- PID liveness check ---------------------------------------------------
  // process.kill(pid, 0) probes existence without sending a real signal.
  // Throws ESRCH when the process does not exist, EPERM when it exists but
  // is owned by another user (still alive!), or succeeds when the calling
  // process owns/can see it.
  try {
    killImpl(pid, 0);
    // No throw → process exists.
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") {
      // Process exists but we don't have permission to signal it → alive.
      return true;
    }
    // ESRCH or any other error → process is gone → dead.
    return false;
  }
}
