/**
 * Integration tests for the run's dev step editing INSIDE its own worktree —
 * Story 8.20 (true run parallelism, part 1: the isolation substrate).
 *
 * Story 8.16 isolated only the dev's git *work product* (branch/commit/PR) by
 * transplanting the dev's changed paths from the shared orchestrating checkout
 * into a worktree afterwards. 8.20 makes the dev's *editing surface* the worktree
 * itself: the runtime roots the dev subagent in a worktree (per-agent
 * `isolation: 'worktree'`), the dev edits and builds there, and
 * `runDevTerminalAction` commits the worktree's own dirty set. The orchestrating
 * checkout is therefore NEVER the dev's editing surface and is never touched —
 * there is no transplant-then-restore window in which the shared checkout holds
 * the edits.
 *
 * These tests model that by materialising a clean worktree (what the runtime's
 * isolation primitive does), writing the dev's edits INTO the worktree, then
 * running `runDevTerminalAction` with `targetRepoRoot` pointed at the worktree
 * (gh/pnpm stubbed, real git everywhere else against a tmpdir repo with a real
 * bare origin). Asserts:
 *
 *   AC1 — the dev's changes appear ONLY in the worktree; `git -C <orchestrating
 *         checkout> status --porcelain` never reports the dev's files as dirty,
 *         at any point during or after the dev step.
 *   AC2 — a pre-existing dirty change in the orchestrating checkout never rides
 *         into the story commit and is left exactly as-is (the correctness floor
 *         8.16 guaranteed, now structural: the worktree is cut clean from base).
 *
 * vitest: plugins/flow/mcp-server/src/tools/__tests__/dev-edits-in-worktree.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execa as realExeca } from "execa";
import { stringify as yamlStringify } from "yaml";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { devOutcomeFilePath } from "../../lib/read-dev-outcome-file.js";
import { runDevTerminalAction } from "../run-dev-terminal-action.js";
import { materialiseDevStoryWorktree } from "../../lib/dev-story-worktree.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REF = "8-20-edit-in-worktree";
const TITLE = "Each dev edits in its own worktree";
const TYPE = "feat";
const BODY = "Make the dev's editing surface its own worktree.";
const SUMMARY = "Edit-in-worktree isolation on the run dev step.";
const FAKE_PR_URL = "https://github.com/owner/repo/pull/820";
const SESSION_ULID = "01HZSESSION00000000008200";
const SOURCE_HASH = "c".repeat(64);

const FIXTURE_SPEC = `
# Story 8.20: Edit-in-worktree

Status: ready-for-dev

## Acceptance Criteria

**AC1 (integration):**
The dev edits in its own worktree.

**AC2 (integration):**
A stray pre-existing change never rides into the commit.
`;

interface TestContext {
  repoRoot: string;
  originDir: string;
  manifestPath: string;
}

/**
 * Stand up a real git repo with a real `origin` (a sibling bare repo). The
 * default branch is `dev` so `materialiseDevStoryWorktree(..., base: 'dev')` and
 * `runDevTerminalAction`'s default base resolve.
 */
async function setupRepo(): Promise<TestContext> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dev-edit-in-wt-"));
  const repoRoot = path.join(tmp, "work");
  const originDir = path.join(tmp, "origin.git");
  await fs.mkdir(repoRoot, { recursive: true });

  await realExeca("git", ["init", "--bare", "-b", "dev", originDir]);

  await realExeca("git", ["-C", repoRoot, "init", "-b", "dev"]);
  await realExeca("git", ["-C", repoRoot, "config", "user.email", "t@t.com"]);
  await realExeca("git", ["-C", repoRoot, "config", "user.name", "Test User"]);
  await realExeca("git", ["-C", repoRoot, "remote", "add", "origin", originDir]);

  const srcDir = path.join(repoRoot, "src");
  await fs.mkdir(srcDir, { recursive: true });
  await atomicWriteFile(path.join(srcDir, "index.ts"), "export const x = 1;\n");
  await realExeca("git", ["-C", repoRoot, "add", "."]);
  await realExeca("git", ["-C", repoRoot, "commit", "-m", "chore: initial commit"]);
  await realExeca("git", ["-C", repoRoot, "push", "-u", "origin", "dev"]);

  const specRelPath = `_bmad-output/implementation-artifacts/${REF}.md`;
  const specDir = path.join(repoRoot, "_bmad-output", "implementation-artifacts");
  await fs.mkdir(specDir, { recursive: true });
  await atomicWriteFile(path.join(specDir, `${REF}.md`), FIXTURE_SPEC);

  const stateDir = path.join(repoRoot, ".flow", "state", "in-progress");
  await fs.mkdir(stateDir, { recursive: true });
  const manifestPath = path.join(stateDir, `${REF}.yaml`);
  await atomicWriteFile(
    manifestPath,
    yamlStringify({
      ref: REF,
      status: "in-progress",
      adapter: "bmad",
      source_path: specRelPath,
      source_hash: SOURCE_HASH,
      depends_on: [],
      acceptance_criteria: [{ text: "AC1 text", kind: "integration" }],
      title: TITLE,
      narrative: "As a maintainer, I want edit-in-worktree isolation.",
      withdrawn: false,
      claimed_by: SESSION_ULID,
    }),
  );

  // Commit the manifest + spec so they are not part of the worktree's dirty set.
  await realExeca("git", ["-C", repoRoot, "add", "."]);
  await realExeca("git", ["-C", repoRoot, "commit", "-m", "chore: scaffold story"]);
  await realExeca("git", ["-C", repoRoot, "push", "origin", "dev"]);

  return { repoRoot, originDir, manifestPath };
}

/**
 * execaImpl that runs real git everywhere, but stubs `gh` (no network) and
 * `pnpm` (the pre-PR build gate). `cwd` from the gh call is captured so we can
 * assert the gh process was pinned to the worktree (the right repo context).
 */
function makeStubExeca(opts: {
  ghShouldFail?: boolean;
  ghStdout?: string;
  ghCwds: string[];
}): ReturnType<typeof vi.fn> {
  return vi.fn(
    async (
      cmd: string,
      args: readonly string[],
      options?: Record<string, unknown>,
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
      if (cmd === "gh") {
        opts.ghCwds.push(typeof options?.cwd === "string" ? (options.cwd as string) : "");
        if (opts.ghShouldFail) {
          return { stdout: "", stderr: "gh pr create failed", exitCode: 1 };
        }
        return { stdout: opts.ghStdout ?? FAKE_PR_URL, stderr: "", exitCode: 0 };
      }
      if (cmd === "pnpm") {
        return { stdout: "build ok", stderr: "", exitCode: 0 };
      }
      const result = await realExeca(cmd, args as string[], { ...options, reject: false });
      return {
        stdout: typeof result.stdout === "string" ? result.stdout : "",
        stderr: typeof result.stderr === "string" ? result.stderr : "",
        exitCode: typeof result.exitCode === "number" ? result.exitCode : 0,
      };
    },
  );
}

/** Repo-relative file list of a commit by sha/branch, in a given repo root. */
async function commitFiles(repoRoot: string, sha = "HEAD"): Promise<string[]> {
  const r = await realExeca(
    "git",
    ["-C", repoRoot, "show", "--name-only", "--pretty=format:", sha],
    { reject: false },
  );
  return (r.stdout ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Non-`.flow/state` dirty paths in a repo's working tree. */
async function dirtyNonState(repoRoot: string): Promise<string[]> {
  const r = await realExeca(
    "git",
    ["-C", repoRoot, "status", "--porcelain"],
    { reject: false },
  );
  return (r.stdout ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => !l.includes(".flow/state/"));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let ctx: TestContext;

beforeEach(async () => {
  ctx = await setupRepo();
});

afterEach(async () => {
  await fs.rm(path.dirname(ctx.repoRoot), { recursive: true, force: true });
});

describe("dev edits in worktree — AC1 (orchestrating checkout never holds the dev's edits)", () => {
  it("edits land only in the worktree; the orchestrating checkout stays clean throughout", async () => {
    const ghCwds: string[] = [];
    const spy = makeStubExeca({ ghStdout: FAKE_PR_URL, ghCwds });

    // The runtime's isolation primitive: materialise the dev's clean worktree.
    const wt = await materialiseDevStoryWorktree({
      targetRepoRoot: ctx.repoRoot,
      sessionUlid: SESSION_ULID,
      ref: REF,
      base: "dev",
      execaImpl: spy as unknown as Parameters<typeof materialiseDevStoryWorktree>[0]["execaImpl"],
    });

    // The worktree is a sibling of the checkout, NOT nested inside it.
    expect(wt.worktreePath.startsWith(ctx.repoRoot + path.sep)).toBe(false);

    // The orchestrating checkout is clean immediately after worktree creation —
    // there is no transplant window that dirties it.
    expect(await dirtyNonState(ctx.repoRoot)).toEqual([]);

    // The DEV edits INSIDE the worktree (its editing surface) — not in repoRoot.
    await atomicWriteFile(
      path.join(wt.worktreePath, "src", "index.ts"),
      "export const x = 2; // dev edit\n",
    );
    await atomicWriteFile(
      path.join(wt.worktreePath, "src", "feature.ts"),
      "export const feature = true;\n",
    );

    // While the dev's edits exist in the worktree, the orchestrating checkout
    // shows NONE of them.
    expect(await dirtyNonState(ctx.repoRoot)).toEqual([]);

    const result = await runDevTerminalAction({
      targetRepoRoot: wt.worktreePath,
      ref: REF,
      title: TITLE,
      type: TYPE,
      body: BODY,
      summary: SUMMARY,
      manifestPath: ctx.manifestPath,
      sessionUlid: SESSION_ULID,
      // Story native:01KT40THFTS10F9PT37KCW9PF4: the pre-PR sync gate rebases the
      // branch onto `origin/<base>` before opening the PR. This test repo's trunk
      // is `dev`, so pin the base to it — the branch was cut from `origin/dev`, so
      // the rebase is a clean no-op fast-forward (no conflict).
      base: "dev",
      execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
    });

    expect(result.ok).toBe(true);
    expect(result.branch).toMatch(/^story\//);

    // gh ran with cwd pinned to the worktree (the right repo context).
    expect(ghCwds.length).toBe(1);
    expect(ghCwds[0]).toBe(wt.worktreePath);

    // The orchestrating checkout NEVER held the dev's edits — index.ts is still
    // the committed content and feature.ts never appeared there.
    const orchIndex = await fs.readFile(path.join(ctx.repoRoot, "src", "index.ts"), "utf8");
    expect(orchIndex).toBe("export const x = 1;\n");
    await expect(
      fs.access(path.join(ctx.repoRoot, "src", "feature.ts")),
    ).rejects.toBeTruthy();
    expect(await dirtyNonState(ctx.repoRoot)).toEqual([]);

    // The dev's change DID land — on the pushed story branch in origin.
    const originFiles = await commitFiles(ctx.originDir, result.branch);
    expect(originFiles).toContain("src/index.ts");
    expect(originFiles).toContain("src/feature.ts");

    // dev-outcome.json was written to the ORCHESTRATING checkout's per-ref
    // session dir (resolved from the worktree via git --git-common-dir), not the
    // worktree's. Per-ref namespaced (story native:01KT3YDHM10FPQ77N22BTJP9AF).
    const outcomeRaw = await fs.readFile(
      devOutcomeFilePath(ctx.repoRoot, SESSION_ULID, REF),
      "utf8",
    );
    const outcome = JSON.parse(outcomeRaw) as { prUrl: string; prNumber: number };
    expect(outcome.prUrl).toBe(FAKE_PR_URL);
    expect(outcome.prNumber).toBe(820);

    await wt.cleanup();
  });
});

describe("dev edits in worktree — AC2 (a stray pre-existing change never rides into the commit)", () => {
  it("excludes an unrelated dirty change in the checkout; leaves it untouched", async () => {
    const ghCwds: string[] = [];
    const spy = makeStubExeca({ ghStdout: FAKE_PR_URL, ghCwds });

    // Seed an UNRELATED, pre-existing uncommitted change in the orchestrating
    // checkout — present before and during the dev step.
    await atomicWriteFile(
      path.join(ctx.repoRoot, "src", "index.ts"),
      "export const x = 1; // STRAY pre-existing edit\n",
    );

    const wt = await materialiseDevStoryWorktree({
      targetRepoRoot: ctx.repoRoot,
      sessionUlid: SESSION_ULID,
      ref: REF,
      base: "dev",
      execaImpl: spy as unknown as Parameters<typeof materialiseDevStoryWorktree>[0]["execaImpl"],
    });

    // The worktree is cut clean from `dev` — the stray edit is NOT in it.
    const wtIndex = await fs.readFile(path.join(wt.worktreePath, "src", "index.ts"), "utf8");
    expect(wtIndex).toBe("export const x = 1;\n");

    // The dev makes its OWN change (a new file) in the worktree.
    await atomicWriteFile(
      path.join(wt.worktreePath, "src", "feature.ts"),
      "export const feature = true;\n",
    );

    const result = await runDevTerminalAction({
      targetRepoRoot: wt.worktreePath,
      ref: REF,
      title: TITLE,
      type: TYPE,
      body: BODY,
      summary: SUMMARY,
      manifestPath: ctx.manifestPath,
      sessionUlid: SESSION_ULID,
      // Story native:01KT40THFTS10F9PT37KCW9PF4: the pre-PR sync gate rebases the
      // branch onto `origin/<base>` before opening the PR. This test repo's trunk
      // is `dev`, so pin the base to it — the branch was cut from `origin/dev`, so
      // the rebase is a clean no-op fast-forward (no conflict).
      base: "dev",
      execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
    });

    // The story commit contains ONLY the dev's own file, never the stray edit.
    const committed = await commitFiles(ctx.originDir, result.branch);
    expect(committed).toContain("src/feature.ts");
    expect(committed).not.toContain("src/index.ts");

    // The stray change is left exactly as-is in the orchestrating checkout.
    const strayStill = await fs.readFile(path.join(ctx.repoRoot, "src", "index.ts"), "utf8");
    expect(strayStill).toBe("export const x = 1; // STRAY pre-existing edit\n");

    await wt.cleanup();
  });
});
