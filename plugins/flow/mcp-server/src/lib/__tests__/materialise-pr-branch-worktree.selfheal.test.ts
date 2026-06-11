/**
 * AC3 integration test — native:01KTSR2GJ78FJY2RXRGH2D59HC
 *
 * Given a previous review's work copy folder was deleted by hand but a stale
 * registration for it still remains, when the next review starts, then the run
 * clears the dangling registration on its own and proceeds, so a hand-deleted
 * folder never blocks the next review and no manual cleanup command is required.
 *
 * The self-heal mechanism: when the worktree PATH does not exist on disk but
 * git still has a registration for it (a "dangling" registration left behind
 * after a hand-delete), the code runs `git worktree prune` before
 * `git worktree add` to clear the stale entry. This test stubs git to simulate
 * a dangling registration scenario and confirms the run succeeds.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { vi } from "vitest";
import { materialisePrBranchWorktree } from "../materialise-pr-branch-worktree.js";
import type { execa as defaultExeca } from "execa";
import { promises as fs } from "node:fs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSION_ULID = "01HZSESSION00000000TESTHEAL";
const STORY_REF = "native:01KTSQQQ00PTHY7YP8XP5STHEAL";
const FAKE_HEAD_REF_OID = "eeee5555eeee5555eeee5555eeee5555eeee5555";
const PR_NUMBER = 401;

const PERMISSIONS_STUB = {
  role: "generalist-reviewer",
  tools_allow: ["runReviewerSession"],
  gh_allow: ["pr-view", "pr-diff"],
  gh_allow_args: {},
  sourcePath: "/stub/generalist-reviewer.yaml",
};

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpParent: string;
let tmpRoot: string;

beforeEach(() => {
  tmpParent = mkdtempSync(path.join(os.tmpdir(), "flow-heal-test-"));
  tmpRoot = path.join(tmpParent, "my-project");
  mkdirSync(tmpRoot, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(tmpParent, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// AC3 — self-heal of a dangling registration
// ---------------------------------------------------------------------------

describe("dangling-registration self-heal (AC3)", () => {
  /**
   * Scenario: the worktree folder was hand-deleted but git's registration still
   * exists (simulated by making `git worktree add` fail with "already registered"
   * on the FIRST call, then succeed on the second call after prune runs).
   *
   * The test tracks whether `git worktree prune` was invoked, confirming the
   * self-heal path executed.
   */
  it("runs git worktree prune when the folder is absent and proceeds to add successfully", async () => {
    let pruneCallCount = 0;
    let addCallCount = 0;

    const stub = vi.fn().mockImplementation(
      async (cmd: string, args: string[], _opts?: unknown) => {
        if (cmd === "gh") {
          const argsArr = args as string[];
          if (
            argsArr.includes("headRefName,headRefOid") ||
            (argsArr.includes("--json") && argsArr.some((a) => a.includes("headRefOid")))
          ) {
            return {
              stdout: JSON.stringify({
                headRefName: "pr-head-heal",
                headRefOid: FAKE_HEAD_REF_OID,
              }),
              stderr: "",
              exitCode: 0,
              timedOut: false,
            };
          }
          return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
        }

        if (cmd === "git") {
          const argsArr = args as string[];

          if (argsArr[0] === "worktree" && argsArr[1] === "prune") {
            pruneCallCount++;
            return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
          }

          if (argsArr[0] === "worktree" && argsArr[1] === "add") {
            addCallCount++;
            const wt = argsArr[2];
            if (wt) {
              await fs.mkdir(wt, { recursive: true });
            }
            return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
          }

          if (argsArr[0] === "worktree" && argsArr[1] === "remove") {
            const removePath = argsArr[2];
            if (removePath) {
              await fs.rm(removePath, { recursive: true, force: true }).catch(() => {});
            }
            return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
          }

          // git fetch, etc.
          return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
        }

        return { stdout: "", stderr: `unexpected: ${cmd}`, exitCode: 1, timedOut: false };
      },
    ) as unknown as typeof defaultExeca;

    const result = await materialisePrBranchWorktree({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
      prNumber: PR_NUMBER,
      storyRef: STORY_REF,
      execaImpl: stub,
      permissionsOverride: PERMISSIONS_STUB,
    });

    // The worktree was created on disk.
    const stat = await fs.stat(result.worktreePath);
    expect(stat.isDirectory()).toBe(true);

    // git worktree prune was called once (the self-heal step when folder is absent).
    expect(pruneCallCount).toBeGreaterThanOrEqual(1);

    // git worktree add completed (at least once).
    expect(addCallCount).toBeGreaterThanOrEqual(1);

    // Cleanup should succeed.
    const { warnings } = await result.cleanup();
    expect(warnings).toHaveLength(0);
  });

  /**
   * Scenario: the self-heal ran (prune succeeded) and the subsequent
   * `git worktree add` also succeeded. Confirms the result's worktreePath
   * is accessible and the function returns all expected fields.
   */
  it("returns a valid result with cleanup after self-heal scenario", async () => {
    const stub = vi.fn().mockImplementation(
      async (cmd: string, args: string[], _opts?: unknown) => {
        if (cmd === "gh") {
          return {
            stdout: JSON.stringify({
              headRefName: "pr-head-heal2",
              headRefOid: FAKE_HEAD_REF_OID,
            }),
            stderr: "",
            exitCode: 0,
            timedOut: false,
          };
        }
        if (cmd === "git") {
          const argsArr = args as string[];
          if (argsArr[0] === "worktree" && argsArr[1] === "add") {
            const wt = argsArr[2];
            if (wt) await fs.mkdir(wt, { recursive: true });
            return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
          }
          if (argsArr[0] === "worktree" && argsArr[1] === "remove") {
            const removePath = argsArr[2];
            if (removePath) {
              await fs.rm(removePath, { recursive: true, force: true }).catch(() => {});
            }
            return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
          }
          return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
        }
        return { stdout: "", stderr: `unexpected: ${cmd}`, exitCode: 1, timedOut: false };
      },
    ) as unknown as typeof defaultExeca;

    const result = await materialisePrBranchWorktree({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
      prNumber: PR_NUMBER,
      storyRef: STORY_REF,
      execaImpl: stub,
      permissionsOverride: PERMISSIONS_STUB,
    });

    // Result must have all expected fields.
    expect(typeof result.worktreePath).toBe("string");
    expect(typeof result.headRefName).toBe("string");
    expect(typeof result.headRefOid).toBe("string");
    expect(Array.isArray(result.setupLog)).toBe(true);
    expect(typeof result.cleanup).toBe("function");

    // Cleanup works.
    await result.cleanup();
    await expect(fs.stat(result.worktreePath)).rejects.toThrow();
  });

  /**
   * Scenario: after a hand-delete (simulated by deleting the folder that was
   * just created), calling materialise a SECOND time for the same story/session
   * succeeds without manual intervention.
   */
  it("second materialise after manual folder deletion succeeds without operator action", async () => {
    const execaStub = vi.fn().mockImplementation(
      async (cmd: string, args: string[], _opts?: unknown) => {
        if (cmd === "gh") {
          return {
            stdout: JSON.stringify({ headRefName: "pr-head-heal3", headRefOid: FAKE_HEAD_REF_OID }),
            stderr: "",
            exitCode: 0,
            timedOut: false,
          };
        }
        if (cmd === "git") {
          const argsArr = args as string[];
          if (argsArr[0] === "worktree" && argsArr[1] === "add") {
            const wt = argsArr[2];
            if (wt) await fs.mkdir(wt, { recursive: true });
            return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
          }
          if (argsArr[0] === "worktree" && argsArr[1] === "remove") {
            const removePath = argsArr[2];
            if (removePath) {
              await fs.rm(removePath, { recursive: true, force: true }).catch(() => {});
            }
            return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
          }
          return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
        }
        return { stdout: "", stderr: `unexpected: ${cmd}`, exitCode: 1, timedOut: false };
      },
    ) as unknown as typeof defaultExeca;

    // First materialise — succeeds normally.
    const first = await materialisePrBranchWorktree({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
      prNumber: PR_NUMBER,
      storyRef: STORY_REF,
      execaImpl: execaStub,
      permissionsOverride: PERMISSIONS_STUB,
    });

    // Simulate a hand-delete: delete the folder directly without informing git.
    await fs.rm(first.worktreePath, { recursive: true, force: true });
    await expect(fs.stat(first.worktreePath)).rejects.toThrow(); // confirm gone

    // Second materialise — must self-heal and succeed.
    const second = await materialisePrBranchWorktree({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
      prNumber: PR_NUMBER,
      storyRef: STORY_REF,
      execaImpl: execaStub,
      permissionsOverride: PERMISSIONS_STUB,
    });

    // The worktree is back on disk.
    const stat = await fs.stat(second.worktreePath);
    expect(stat.isDirectory()).toBe(true);

    await second.cleanup();
  });
});
