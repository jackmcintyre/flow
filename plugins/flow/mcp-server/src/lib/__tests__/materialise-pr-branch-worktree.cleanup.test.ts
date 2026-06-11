/**
 * AC2 integration test — native:01KTSR2GJ78FJY2RXRGH2D59HC
 *
 * Given a review has finished, whether it passed, failed, or errored, when the
 * run moves on, then the review work copy that was created for it is removed
 * automatically, so review folders do not accumulate across runs.
 *
 * This test verifies that the cleanup() callback, when invoked on every exit
 * path (pass, fail, error simulation), removes the review worktree from disk.
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

const SESSION_ULID = "01HZSESSION00000000TESTCLN1";
const STORY_REF = "native:01KTSQQQ00PTHY7YP8XP5STCLN";
const FAKE_HEAD_REF_OID = "dddd4444dddd4444dddd4444dddd4444dddd4444";
const PR_NUMBER = 301;

const PERMISSIONS_STUB = {
  role: "generalist-reviewer",
  tools_allow: ["runReviewerSession"],
  gh_allow: ["pr-view", "pr-diff"],
  gh_allow_args: {},
  sourcePath: "/stub/generalist-reviewer.yaml",
};

// ---------------------------------------------------------------------------
// Stub factory
// ---------------------------------------------------------------------------

function makeExecaStub(headRefOid: string): typeof defaultExeca {
  return vi.fn().mockImplementation(
    async (cmd: string, args: string[], _opts?: unknown) => {
      if (cmd === "gh") {
        const argsArr = args as string[];
        if (
          argsArr.includes("headRefName,headRefOid") ||
          (argsArr.includes("--json") && argsArr.some((a) => a.includes("headRefOid")))
        ) {
          return {
            stdout: JSON.stringify({
              headRefName: `pr-head-${headRefOid.slice(0, 6)}`,
              headRefOid,
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
        if (argsArr[0] === "worktree" && argsArr[1] === "add") {
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
        return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
      }

      return { stdout: "", stderr: `unexpected command: ${cmd}`, exitCode: 1, timedOut: false };
    },
  ) as unknown as typeof defaultExeca;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpRoot: string;
let tmpParent: string;

beforeEach(() => {
  tmpParent = mkdtempSync(path.join(os.tmpdir(), "flow-cleanup-test-"));
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
// Helper: materialise one checkout
// ---------------------------------------------------------------------------

async function materialise() {
  return materialisePrBranchWorktree({
    targetRepoRoot: tmpRoot,
    sessionUlid: SESSION_ULID,
    prNumber: PR_NUMBER,
    storyRef: STORY_REF,
    execaImpl: makeExecaStub(FAKE_HEAD_REF_OID),
    permissionsOverride: PERMISSIONS_STUB,
  });
}

// ---------------------------------------------------------------------------
// AC2 — cleanup removes the worktree on every exit path
// ---------------------------------------------------------------------------

describe("review worktree cleanup (AC2)", () => {
  it("cleanup() removes the worktree from disk on a normal (pass) exit", async () => {
    const result = await materialise();
    // Confirm it was created.
    const statBefore = await fs.stat(result.worktreePath);
    expect(statBefore.isDirectory()).toBe(true);

    // Simulate a passing review exit path.
    const { warnings } = await result.cleanup();
    expect(warnings).toHaveLength(0);

    // The directory must be gone.
    await expect(fs.stat(result.worktreePath)).rejects.toThrow();
  });

  it("cleanup() removes the worktree from disk on a failing (NEEDS CHANGES) exit path", async () => {
    const result = await materialise();
    // Confirm it was created.
    expect((await fs.stat(result.worktreePath)).isDirectory()).toBe(true);

    // Simulate a review that produced failures — cleanup is still called.
    const { warnings } = await result.cleanup();
    expect(warnings).toHaveLength(0);

    await expect(fs.stat(result.worktreePath)).rejects.toThrow();
  });

  it("cleanup() removes the worktree when called after a simulated error path (try/finally)", async () => {
    const result = await materialise();
    // Confirm it was created.
    expect((await fs.stat(result.worktreePath)).isDirectory()).toBe(true);

    // Simulate the try/finally pattern used in runReviewerSession — even if the
    // inner work throws, cleanup runs in finally. We catch the thrown error so
    // the test body continues after the try/finally block.
    let caught: unknown;
    try {
      throw new Error("simulated review error");
    } catch (err) {
      caught = err;
    } finally {
      await result.cleanup();
    }

    // The simulated error was thrown (just confirming the test flow was correct).
    expect(caught).toBeInstanceOf(Error);

    // Worktree must be gone even though the review "errored".
    await expect(fs.stat(result.worktreePath)).rejects.toThrow();
  });

  it("cleanup() is idempotent — calling it twice does not throw", async () => {
    const result = await materialise();
    await result.cleanup();

    // Second call should return warnings (not throw) because the path is already gone.
    const second = await result.cleanup();
    // warnings may or may not be present — what matters is it does not throw.
    expect(Array.isArray(second.warnings)).toBe(true);
  });
});
