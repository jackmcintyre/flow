/**
 * AC1 integration test — native:01KTSR2GJ78FJY2RXRGH2D59HC
 *
 * Given a review runs against a pull request, when the review checks out that
 * pull request's code to inspect it, then the checkout is placed OUTSIDE the
 * main project folder (alongside where the builder's work copies already live),
 * so the review's test run can only ever see the pull request's own tools and
 * dependencies and never those of the main project folder.
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

const SESSION_ULID = "01HZSESSION00000000TESTLOC1";
const STORY_REF = "native:01KTSQQQ00PTHY7YP8XP5STLOC";
const FAKE_HEAD_REF_OID = "cccc3333cccc3333cccc3333cccc3333cccc3333";
const PR_NUMBER = 201;

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
            // Note: we intentionally do NOT write any files here — the location
            // test only verifies path placement, not content.
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

beforeEach(() => {
  // Create a "project folder" under a temp parent directory — the worktree
  // must land OUTSIDE this directory, not nested inside it.
  const tmpParent = mkdtempSync(path.join(os.tmpdir(), "flow-loc-test-"));
  tmpRoot = path.join(tmpParent, "my-project");
  mkdirSync(tmpRoot, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(path.dirname(tmpRoot), { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// AC1 — worktree lands OUTSIDE the main project folder
// ---------------------------------------------------------------------------

describe("review worktree placement (AC1)", () => {
  it("the review worktree path is NOT nested inside the main project folder", async () => {
    const result = await materialisePrBranchWorktree({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
      prNumber: PR_NUMBER,
      storyRef: STORY_REF,
      execaImpl: makeExecaStub(FAKE_HEAD_REF_OID),
      permissionsOverride: PERMISSIONS_STUB,
    });

    // The worktree must NOT be under tmpRoot.
    const rel = path.relative(tmpRoot, result.worktreePath);
    expect(rel.startsWith(".."), `Expected worktreePath to be outside tmpRoot.\nworktreePath=${result.worktreePath}\ntmpRoot=${tmpRoot}`).toBe(true);
  });

  it("the review worktree is created on disk at the reported path", async () => {
    const result = await materialisePrBranchWorktree({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
      prNumber: PR_NUMBER,
      storyRef: STORY_REF,
      execaImpl: makeExecaStub(FAKE_HEAD_REF_OID),
      permissionsOverride: PERMISSIONS_STUB,
    });

    const stat = await fs.stat(result.worktreePath);
    expect(stat.isDirectory()).toBe(true);
  });

  it("the review worktree is a sibling of the project folder under .flow-worktrees", async () => {
    const result = await materialisePrBranchWorktree({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
      prNumber: PR_NUMBER,
      storyRef: STORY_REF,
      execaImpl: makeExecaStub(FAKE_HEAD_REF_OID),
      permissionsOverride: PERMISSIONS_STUB,
    });

    // Expected prefix: <parent-of-project>/.flow-worktrees/<sessionUlid>/
    const expectedPrefix = path.join(
      path.dirname(tmpRoot),
      ".flow-worktrees",
      SESSION_ULID,
    );
    expect(
      result.worktreePath.startsWith(expectedPrefix),
      `worktreePath=${result.worktreePath} should start with ${expectedPrefix}`,
    ).toBe(true);
  });
});
