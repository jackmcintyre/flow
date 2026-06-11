/**
 * AC4 unit test — native:01KTSR2GJ78FJY2RXRGH2D59HC
 *
 * Given the place where review work copies now live, when a review work copy is
 * created there, then it sits in the same out-of-project location family the
 * builder's work copies use, confirming the two follow one model and neither can
 * reach into the main project folder.
 *
 * This is a pure unit test: it asserts on the computed path shapes directly
 * (using the exported `reviewWorktreePath` and `devStoryWorktreePath` path
 * helpers) without running any git commands or creating any directories.
 */

import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { reviewWorktreePath } from "../materialise-pr-branch-worktree.js";
import { devStoryWorktreePath } from "../dev-story-worktree.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FAKE_REPO_ROOT = "/home/user/my-project";
const SESSION_ULID = "01HZSESSION00000000TESTPATH";
const STORY_REF = "native:01KTSQQQ00PTHY7YP8XP5STPATH";
const DEV_REF = "native:01KTSQQQ00PTHY7YP8XP5DEVPATH";

// ---------------------------------------------------------------------------
// AC4 — same location family as dev worktrees
// ---------------------------------------------------------------------------

describe("review worktree path family (AC4)", () => {
  it("review worktree path is NOT nested inside the repo root", () => {
    const wtPath = reviewWorktreePath(FAKE_REPO_ROOT, SESSION_ULID, STORY_REF);

    const rel = path.relative(FAKE_REPO_ROOT, wtPath);
    expect(
      rel.startsWith(".."),
      `Expected path outside FAKE_REPO_ROOT.\nwtPath=${wtPath}\nFAKE_REPO_ROOT=${FAKE_REPO_ROOT}`,
    ).toBe(true);
  });

  it("dev worktree path is NOT nested inside the repo root (confirming the model)", () => {
    const wtPath = devStoryWorktreePath(FAKE_REPO_ROOT, SESSION_ULID, DEV_REF);

    const rel = path.relative(FAKE_REPO_ROOT, wtPath);
    expect(
      rel.startsWith(".."),
      `Expected dev path outside FAKE_REPO_ROOT.\nwtPath=${wtPath}\nFAKE_REPO_ROOT=${FAKE_REPO_ROOT}`,
    ).toBe(true);
  });

  it("review worktree and dev worktree share the same .flow-worktrees parent", () => {
    const reviewPath = reviewWorktreePath(FAKE_REPO_ROOT, SESSION_ULID, STORY_REF);
    const devPath = devStoryWorktreePath(FAKE_REPO_ROOT, SESSION_ULID, DEV_REF);

    // Both live under <parent>/.flow-worktrees/<sessionUlid>/
    const expectedBase = path.join(
      path.dirname(FAKE_REPO_ROOT),
      ".flow-worktrees",
      SESSION_ULID,
    );

    expect(
      reviewPath.startsWith(expectedBase),
      `review path should start with ${expectedBase}\ngot: ${reviewPath}`,
    ).toBe(true);
    expect(
      devPath.startsWith(expectedBase),
      `dev path should start with ${expectedBase}\ngot: ${devPath}`,
    ).toBe(true);
  });

  it("review worktree path and dev worktree path for the SAME session are distinct", () => {
    const reviewPath = reviewWorktreePath(FAKE_REPO_ROOT, SESSION_ULID, STORY_REF);
    const devPath = devStoryWorktreePath(FAKE_REPO_ROOT, SESSION_ULID, STORY_REF);

    expect(reviewPath).not.toBe(devPath);
  });

  it("review worktree path includes 'review-' prefix segment", () => {
    const wtPath = reviewWorktreePath(FAKE_REPO_ROOT, SESSION_ULID, STORY_REF);
    const basename = path.basename(wtPath);
    expect(basename.startsWith("review-")).toBe(true);
  });

  it("dev worktree path includes 'dev-' prefix segment (confirming the naming convention)", () => {
    const wtPath = devStoryWorktreePath(FAKE_REPO_ROOT, SESSION_ULID, DEV_REF);
    const basename = path.basename(wtPath);
    expect(basename.startsWith("dev-")).toBe(true);
  });

  it("different session ULIDs produce different base paths (sessions are isolated)", () => {
    const sessionA = "01HZSESSION00000000TESTPATH_A";
    const sessionB = "01HZSESSION00000000TESTPATH_B";

    const pathA = reviewWorktreePath(FAKE_REPO_ROOT, sessionA, STORY_REF);
    const pathB = reviewWorktreePath(FAKE_REPO_ROOT, sessionB, STORY_REF);

    expect(pathA).not.toBe(pathB);
    expect(pathA).toContain(sessionA);
    expect(pathB).toContain(sessionB);
  });
});
