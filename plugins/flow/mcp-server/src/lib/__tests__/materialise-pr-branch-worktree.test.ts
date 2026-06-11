/**
 * Tests for `materialisePrBranchWorktree` — native:01KTSQQQ00PTHY7YP8XP5SX31G.
 *
 * Verifies that:
 *   AC1/AC2: Two concurrent reviews for different stories each see only their
 *            own code and neither checkout is removed while the review is in flight.
 *   AC3:     Two stories under review at the same time resolve to distinct per-story
 *            folders (not one shared location).
 *   AC4:     Cleaning up one review copy leaves the sibling's copy intact.
 *
 * All git and gh calls are stubbed — no real git repo or network required.
 * The stub creates the worktree directory on `git worktree add` so downstream
 * filesystem checks work without a real git index.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs, mkdtempSync, rmSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { vi } from "vitest";
import { materialisePrBranchWorktree } from "../materialise-pr-branch-worktree.js";
import { sanitiseRefForPathSegment } from "../read-reviewer-result-file.js";
import type { execa as defaultExeca } from "execa";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const SESSION_ULID = "01HZSESSION00000000TESTING1";
const STORY_REF_A = "native:01KTSQQQ00PTHY7YP8XP5STORY_A";
const STORY_REF_B = "native:01KTSQQQ00PTHY7YP8XP5STORY_B";
const FAKE_HEAD_REF_OID_A = "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
const FAKE_HEAD_REF_OID_B = "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222";
const PR_NUMBER_A = 101;
const PR_NUMBER_B = 102;

// Minimal role-permissions stub — bypasses loadRolePermissions file read.
const PERMISSIONS_STUB = {
  role: "generalist-reviewer",
  tools_allow: ["runReviewerSession"],
  gh_allow: ["pr-view", "pr-diff"],
  gh_allow_args: {},
  sourcePath: "/stub/generalist-reviewer.yaml",
};

// ---------------------------------------------------------------------------
// Execa stub factory
// ---------------------------------------------------------------------------

/**
 * Build a stub execa implementation that:
 *   - Responds to `gh pr view --json headRefName,headRefOid` with the supplied sha.
 *   - Creates the worktree directory on `git worktree add`.
 *   - Actually removes the worktree directory on `git worktree remove`.
 *   - Succeeds silently on `git fetch`.
 */
function makeExecaStub(headRefOid: string): typeof defaultExeca {
  return vi.fn().mockImplementation(
    async (cmd: string, args: string[], _opts?: unknown) => {
      if (cmd === "gh") {
        const argsArr = args as string[];
        const isHeadRefQuery =
          argsArr.includes("headRefName,headRefOid") ||
          (argsArr.includes("--json") && argsArr.some((a) => a.includes("headRefOid")));
        if (isHeadRefQuery) {
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
          const worktreePath = argsArr[2];
          if (worktreePath) {
            await fs.mkdir(worktreePath, { recursive: true });
            // Write a sentinel file so we can confirm which story owns which folder.
            await fs.writeFile(
              path.join(worktreePath, ".story-owner"),
              headRefOid,
              "utf8",
            );
          }
          return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
        }

        if (argsArr[0] === "worktree" && argsArr[1] === "remove") {
          const removePath = argsArr[2];
          if (removePath) {
            await fs.rm(removePath, { recursive: true, force: true }).catch(() => {
              /* best-effort */
            });
          }
          return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
        }

        // git fetch and all other git commands — succeed silently.
        return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
      }

      return {
        stdout: "",
        stderr: `unexpected command in test stub: ${cmd}`,
        exitCode: 1,
        timedOut: false,
      };
    },
  ) as unknown as typeof defaultExeca;
}

// ---------------------------------------------------------------------------
// Fixture setup
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "materialise-test-"));
});

afterEach(async () => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore cleanup errors in teardown */
  }
});

// ---------------------------------------------------------------------------
// Helper: materialise one checkout
// ---------------------------------------------------------------------------

async function materialiseFor(
  storyRef: string,
  prNumber: number,
  headRefOid: string,
): Promise<ReturnType<typeof materialisePrBranchWorktree>> {
  return materialisePrBranchWorktree({
    targetRepoRoot: tmpRoot,
    sessionUlid: SESSION_ULID,
    prNumber,
    storyRef,
    execaImpl: makeExecaStub(headRefOid),
    permissionsOverride: PERMISSIONS_STUB,
  });
}

// ---------------------------------------------------------------------------
// AC3: distinct per-story paths
// ---------------------------------------------------------------------------

describe("per-story checkout path keying (AC3)", () => {
  it("resolves story A and story B to distinct folders", async () => {
    const resultA = await materialiseFor(STORY_REF_A, PR_NUMBER_A, FAKE_HEAD_REF_OID_A);
    const resultB = await materialiseFor(STORY_REF_B, PR_NUMBER_B, FAKE_HEAD_REF_OID_B);

    expect(resultA.worktreePath).not.toBe(resultB.worktreePath);
  });

  it("embeds the sanitised story ref as the last path segment", async () => {
    const result = await materialiseFor(STORY_REF_A, PR_NUMBER_A, FAKE_HEAD_REF_OID_A);

    const expectedSlug = sanitiseRefForPathSegment(STORY_REF_A);
    expect(result.worktreePath).toContain(expectedSlug);
  });

  it("path contains the review-worktree segment followed by the story slug", async () => {
    const result = await materialiseFor(STORY_REF_A, PR_NUMBER_A, FAKE_HEAD_REF_OID_A);

    const expectedSlug = sanitiseRefForPathSegment(STORY_REF_A);
    const expectedSuffix = path.join("review-worktree", expectedSlug);
    expect(result.worktreePath).toContain(expectedSuffix);
  });
});

// ---------------------------------------------------------------------------
// AC1/AC2: concurrent reviews — each sees only its own code; neither is
//          removed while the other's review is still in progress.
// ---------------------------------------------------------------------------

describe("concurrent reviews — isolation (AC1 + AC2)", () => {
  it("two concurrent checkouts exist simultaneously on disk in separate folders", async () => {
    const [resultA, resultB] = await Promise.all([
      materialiseFor(STORY_REF_A, PR_NUMBER_A, FAKE_HEAD_REF_OID_A),
      materialiseFor(STORY_REF_B, PR_NUMBER_B, FAKE_HEAD_REF_OID_B),
    ]);

    // Both directories must be present after concurrent materialise.
    const [statA, statB] = await Promise.all([
      fs.stat(resultA.worktreePath),
      fs.stat(resultB.worktreePath),
    ]);
    expect(statA.isDirectory()).toBe(true);
    expect(statB.isDirectory()).toBe(true);

    // The two paths must be distinct.
    expect(resultA.worktreePath).not.toBe(resultB.worktreePath);
  });

  it("each reviewer sees only its own story's sentinel file", async () => {
    const [resultA, resultB] = await Promise.all([
      materialiseFor(STORY_REF_A, PR_NUMBER_A, FAKE_HEAD_REF_OID_A),
      materialiseFor(STORY_REF_B, PR_NUMBER_B, FAKE_HEAD_REF_OID_B),
    ]);

    // Sentinel written with the OID used to create each checkout.
    const sentinelA = await fs.readFile(
      path.join(resultA.worktreePath, ".story-owner"),
      "utf8",
    );
    const sentinelB = await fs.readFile(
      path.join(resultB.worktreePath, ".story-owner"),
      "utf8",
    );

    // Each reviewer's folder contains only its own sha.
    expect(sentinelA).toBe(FAKE_HEAD_REF_OID_A);
    expect(sentinelB).toBe(FAKE_HEAD_REF_OID_B);

    // Reviewer A's folder does not contain story B's sentinel and vice versa.
    await expect(
      fs.access(path.join(resultA.worktreePath, ".story-b-marker")),
    ).rejects.toThrow();
  });

  it("checkout A is still present on disk while review B is in flight", async () => {
    // Materialise both concurrently so they overlap.
    const [resultA, resultB] = await Promise.all([
      materialiseFor(STORY_REF_A, PR_NUMBER_A, FAKE_HEAD_REF_OID_A),
      materialiseFor(STORY_REF_B, PR_NUMBER_B, FAKE_HEAD_REF_OID_B),
    ]);

    // Clean up B's checkout (simulating B's review finishing).
    await resultB.cleanup();

    // A's checkout must still be present.
    const statA = await fs.stat(resultA.worktreePath);
    expect(statA.isDirectory()).toBe(true);

    // B's checkout must be gone.
    await expect(fs.stat(resultB.worktreePath)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC4: cleanup only removes the requesting story's own folder, not sibling's
// ---------------------------------------------------------------------------

describe("cleanup scope isolation (AC4)", () => {
  it("cleaning up story A does not remove story B's checkout", async () => {
    const [resultA, resultB] = await Promise.all([
      materialiseFor(STORY_REF_A, PR_NUMBER_A, FAKE_HEAD_REF_OID_A),
      materialiseFor(STORY_REF_B, PR_NUMBER_B, FAKE_HEAD_REF_OID_B),
    ]);

    // Clean up A.
    const { warnings } = await resultA.cleanup();
    expect(warnings).toHaveLength(0);

    // B's directory must still exist.
    const statB = await fs.stat(resultB.worktreePath);
    expect(statB.isDirectory()).toBe(true);
  });

  it("cleaning up story B does not remove story A's checkout", async () => {
    const [resultA, resultB] = await Promise.all([
      materialiseFor(STORY_REF_A, PR_NUMBER_A, FAKE_HEAD_REF_OID_A),
      materialiseFor(STORY_REF_B, PR_NUMBER_B, FAKE_HEAD_REF_OID_B),
    ]);

    // Clean up B.
    const { warnings } = await resultB.cleanup();
    expect(warnings).toHaveLength(0);

    // A's directory must still exist.
    const statA = await fs.stat(resultA.worktreePath);
    expect(statA.isDirectory()).toBe(true);
  });

  it("cleanup removes only the per-story folder, not the shared parent", async () => {
    const result = await materialiseFor(STORY_REF_A, PR_NUMBER_A, FAKE_HEAD_REF_OID_A);

    const sharedParent = path.join(
      tmpRoot,
      ".flow",
      "state",
      "sessions",
      SESSION_ULID,
      "review-worktree",
    );

    // Parent must exist before cleanup (it was created as part of mkdir -p).
    const statBefore = await fs.stat(sharedParent);
    expect(statBefore.isDirectory()).toBe(true);

    // Run cleanup.
    await result.cleanup();

    // The per-story folder is gone.
    await expect(fs.stat(result.worktreePath)).rejects.toThrow();

    // The shared parent is still present (cleanup must not have rm -rf'd it).
    const statAfter = await fs.stat(sharedParent);
    expect(statAfter.isDirectory()).toBe(true);
  });

  it("sequential cleanup of both stories leaves the shared parent intact", async () => {
    const [resultA, resultB] = await Promise.all([
      materialiseFor(STORY_REF_A, PR_NUMBER_A, FAKE_HEAD_REF_OID_A),
      materialiseFor(STORY_REF_B, PR_NUMBER_B, FAKE_HEAD_REF_OID_B),
    ]);

    await resultA.cleanup();
    await resultB.cleanup();

    // Both per-story folders are gone.
    await expect(fs.stat(resultA.worktreePath)).rejects.toThrow();
    await expect(fs.stat(resultB.worktreePath)).rejects.toThrow();

    // The shared parent directory still exists.
    const sharedParent = path.join(
      tmpRoot,
      ".flow",
      "state",
      "sessions",
      SESSION_ULID,
      "review-worktree",
    );
    const stat = await fs.stat(sharedParent);
    expect(stat.isDirectory()).toBe(true);
  });
});
