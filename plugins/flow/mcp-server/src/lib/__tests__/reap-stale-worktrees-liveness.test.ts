/**
 * Unit tests for the liveness gate in `reapStaleDevStoryWorktrees` —
 * Story native:01KTSQWJ62C4XQBDK4NXTEPQC0, AC3.
 *
 * AC3: Given a work folder belonging to a run that is still alive,
 *      When a different run runs its stale-work-folder cleanup,
 *      Then that live run's work folder is left in place and only work
 *      folders whose owning run is confirmed dead are removed.
 *
 * These tests drive the real `reapStaleDevStoryWorktrees` function against
 * a real temporary git repository (git operations are real; process signals
 * and heartbeat reads are stubbed via `isSessionAliveImpl`). A worktree
 * owned by a still-alive session must survive; a worktree owned by a dead
 * session must be removed.
 *
 * vitest: plugins/flow/mcp-server/src/lib/__tests__/reap-stale-worktrees-liveness.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execa as realExeca } from "execa";
import {
  reapStaleDevStoryWorktrees,
  devStoryWorktreePath,
} from "../dev-story-worktree.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CURRENT_SESSION = "01HZLIVENESS0CURRENT000001";
const LIVE_SESSION = "01HZLIVENESS0LIVE000000001";
const DEAD_SESSION = "01HZLIVENESS0DEAD000000001";
const REF_LIVE = "native:01HZLIVENESS0LIVE000REF1";
const REF_DEAD = "native:01HZLIVENESS0DEAD000REF1";

// ---------------------------------------------------------------------------
// Test repo setup
// ---------------------------------------------------------------------------

interface Ctx {
  /** Absolute path to the temporary directory holding everything. */
  tmp: string;
  /** Absolute path to the git repo (the "targetRepoRoot"). */
  repoRoot: string;
}

async function setupRepo(): Promise<Ctx> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "reap-liveness-"));
  const repoRoot = path.join(tmp, "work");
  await fs.mkdir(repoRoot, { recursive: true });
  await realExeca("git", ["init", "-b", "main", repoRoot]);
  await realExeca("git", ["-C", repoRoot, "config", "user.email", "t@t.com"]);
  await realExeca("git", ["-C", repoRoot, "config", "user.name", "Test User"]);
  await realExeca("git", ["-C", repoRoot, "commit", "--allow-empty", "-m", "init"]);
  return { tmp, repoRoot };
}

/**
 * Cut a real worktree for `sessionUlid`+`ref` under `<parent>/.flow-worktrees/`.
 * Returns the path to the newly-created worktree.
 */
async function addWorktree(repoRoot: string, sessionUlid: string, ref: string): Promise<string> {
  const wtPath = devStoryWorktreePath(repoRoot, sessionUlid, ref);
  await fs.mkdir(path.dirname(wtPath), { recursive: true });
  await realExeca("git", ["-C", repoRoot, "worktree", "add", "--detach", wtPath, "main"]);
  return wtPath;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let ctx: Ctx;

beforeEach(async () => {
  ctx = await setupRepo();
});

afterEach(async () => {
  await fs.rm(ctx.tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC3: live session's worktree is left in place
// ---------------------------------------------------------------------------

describe("reapStaleDevStoryWorktrees — liveness gate (AC3)", () => {
  it(
    "leaves a worktree belonging to a still-alive session in place — " +
      "a live dev's editing surface is never force-deleted by a concurrent run",
    async () => {
      // Set up: one live session's worktree.
      const liveWt = await addWorktree(ctx.repoRoot, LIVE_SESSION, REF_LIVE);

      // isSessionAliveImpl: LIVE_SESSION is alive, everything else is dead.
      const isAlive = async (_root: string, sessionUlid: string): Promise<boolean> => {
        return sessionUlid === LIVE_SESSION;
      };

      const result = await reapStaleDevStoryWorktrees({
        targetRepoRoot: ctx.repoRoot,
        currentSessionUlid: CURRENT_SESSION,
        isSessionAliveImpl: isAlive,
      });

      // The live session's worktree must not be reaped.
      expect(result.reaped).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);

      // Verify the worktree is still on disk.
      await expect(fs.access(liveWt)).resolves.toBeUndefined();
    },
  );

  it(
    "removes a worktree belonging to a confirmed-dead session — " +
      "crash-abandoned leftovers are still cleaned up",
    async () => {
      // Set up: one dead session's worktree.
      const deadWt = await addWorktree(ctx.repoRoot, DEAD_SESSION, REF_DEAD);

      // isSessionAliveImpl: everything is dead.
      const allDead = async (): Promise<boolean> => false;

      const result = await reapStaleDevStoryWorktrees({
        targetRepoRoot: ctx.repoRoot,
        currentSessionUlid: CURRENT_SESSION,
        isSessionAliveImpl: allDead,
      });

      // The dead session's worktree must be reaped.
      expect(result.reaped).toHaveLength(1);
      const reapedNorm = result.reaped[0]!.replace(/\\/g, "/");
      const deadWtNorm = deadWt.replace(/\\/g, "/");
      // The reaped path may be resolved through realpath — compare basename as a
      // stable identifier across symlink-heavy tempdirs (e.g. macOS /var→/private).
      expect(path.basename(reapedNorm)).toBe(path.basename(deadWtNorm));

      // Verify the worktree is gone from disk.
      await expect(fs.access(deadWt)).rejects.toThrow();
    },
  );

  it(
    "selectively reaps dead worktrees while leaving live ones intact when both are present",
    async () => {
      // Set up: one live and one dead session worktree.
      const liveWt = await addWorktree(ctx.repoRoot, LIVE_SESSION, REF_LIVE);
      const deadWt = await addWorktree(ctx.repoRoot, DEAD_SESSION, REF_DEAD);

      // isSessionAliveImpl: only LIVE_SESSION is alive.
      const isAlive = async (_root: string, sessionUlid: string): Promise<boolean> => {
        return sessionUlid === LIVE_SESSION;
      };

      const result = await reapStaleDevStoryWorktrees({
        targetRepoRoot: ctx.repoRoot,
        currentSessionUlid: CURRENT_SESSION,
        isSessionAliveImpl: isAlive,
      });

      // Only the dead session's worktree was reaped.
      expect(result.reaped).toHaveLength(1);
      expect(path.basename(result.reaped[0]!)).toBe(path.basename(deadWt));

      // Live worktree still on disk; dead worktree gone.
      await expect(fs.access(liveWt)).resolves.toBeUndefined();
      await expect(fs.access(deadWt)).rejects.toThrow();
    },
  );

  it(
    "never reaps the current session's own worktrees regardless of liveness check " +
      "(the live-session guard fires before the liveness check)",
    async () => {
      // Set up a worktree belonging to the CURRENT session.
      const ownRef = "native:01HZLIVENESS0CURRENT0REF1";
      const ownWt = await addWorktree(ctx.repoRoot, CURRENT_SESSION, ownRef);

      // A stub that would say current session is dead — must never fire for own worktrees.
      const allDead = async (): Promise<boolean> => false;

      const result = await reapStaleDevStoryWorktrees({
        targetRepoRoot: ctx.repoRoot,
        currentSessionUlid: CURRENT_SESSION,
        isSessionAliveImpl: allDead,
      });

      // Own worktree must never be reaped.
      expect(result.reaped).toHaveLength(0);

      // Own worktree still on disk.
      await expect(fs.access(ownWt)).resolves.toBeUndefined();
    },
  );

  it(
    "treats a session with indeterminate liveness (aliveCheck returns false) as dead " +
      "— fail-safe ensures truly crashed leftovers are still cleaned up",
    async () => {
      // Simulate a crashed session with a bad/missing heartbeat (isAlive → false).
      const deadWt = await addWorktree(ctx.repoRoot, DEAD_SESSION, REF_DEAD);
      const indeterminate = async (): Promise<boolean> => false;

      const result = await reapStaleDevStoryWorktrees({
        targetRepoRoot: ctx.repoRoot,
        currentSessionUlid: CURRENT_SESSION,
        isSessionAliveImpl: indeterminate,
      });

      // Indeterminate = treat as dead → worktree must be reaped.
      expect(result.reaped).toHaveLength(1);
      await expect(fs.access(deadWt)).rejects.toThrow();
    },
  );
});
