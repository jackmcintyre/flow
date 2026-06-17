/**
 * Integration tests for TRUE run parallelism — Story 8.20 (part 1).
 *
 * 8.20 makes each dev's editing surface its own worktree, so multiple empties can
 * run against the same repository at once without corrupting each other's
 * in-flight changes. These tests drive two real dev flows
 * (materialise-worktree → edit-in-worktree → commit/push/PR) CONCURRENTLY against
 * ONE temp git repo (gh/pnpm stubbed, real git everywhere else) and assert the
 * isolation properties the concurrent dispatch (bmad:8.22) will stand on:
 *
 *   AC3 — each concurrent dev's branch/commit/PR contains EXACTLY that story's
 *         own changes: no file authored by the sibling leaks in, and no file the
 *         dev wrote is missing. Neither flow's worktree setup disturbs the
 *         other's in-flight edits.
 *
 *   AC4 — cleanup is concurrency- and crash-safe: a mid-build failure in one flow
 *         leaves a concurrently-running flow's worktree intact and leaves NO
 *         leftover worktree for the failed story; and a worktree left behind by a
 *         worker from a prior, now-dead session is reaped on a subsequent run
 *         (the stale-reap keys on the live session, not just the live path).
 *
 * vitest: plugins/flow/mcp-server/src/tools/__tests__/concurrent-runs-isolation.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execa as realExeca } from "execa";
import { stringify as yamlStringify } from "yaml";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { runDevTerminalAction } from "../run-dev-terminal-action.js";
import {
  materialiseDevStoryWorktree,
  reapStaleDevStoryWorktrees,
  devStoryWorktreePath,
} from "../../lib/dev-story-worktree.js";
import { GhPrCreateFailedError, PrePrLeakDetectedError } from "../../errors.js";

// ---------------------------------------------------------------------------
// Fixtures — two concurrent stories sharing one repo.
// ---------------------------------------------------------------------------

const SESSION_ULID = "01HZSESSION00000000008201";
const SOURCE_HASH = "d".repeat(64);

interface Story {
  ref: string;
  title: string;
  /** Repo-relative file the dev for this story creates (its own work). */
  ownFile: string;
  prUrl: string;
}

const STORY_A: Story = {
  ref: "8-20-story-a",
  title: "Concurrent story A",
  ownFile: "src/feature-a.ts",
  prUrl: "https://github.com/owner/repo/pull/8201",
};
const STORY_B: Story = {
  ref: "8-20-story-b",
  title: "Concurrent story B",
  ownFile: "src/feature-b.ts",
  prUrl: "https://github.com/owner/repo/pull/8202",
};

function fixtureSpec(ref: string): string {
  return `# Story ${ref}\n\nStatus: ready-for-dev\n\n## Acceptance Criteria\n\n**AC1 (integration):**\nThe dev edits in its own worktree.\n`;
}

interface TestContext {
  repoRoot: string;
  originDir: string;
  manifestPaths: Record<string, string>;
}

async function setupRepo(): Promise<TestContext> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "concurrent-runs-"));
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

  const manifestPaths: Record<string, string> = {};
  for (const story of [STORY_A, STORY_B]) {
    const specRelPath = `_bmad-output/implementation-artifacts/${story.ref}.md`;
    const specDir = path.join(repoRoot, "_bmad-output", "implementation-artifacts");
    await fs.mkdir(specDir, { recursive: true });
    await atomicWriteFile(path.join(specDir, `${story.ref}.md`), fixtureSpec(story.ref));

    const stateDir = path.join(repoRoot, ".flow", "state", "in-progress");
    await fs.mkdir(stateDir, { recursive: true });
    const manifestPath = path.join(stateDir, `${story.ref}.yaml`);
    await atomicWriteFile(
      manifestPath,
      yamlStringify({
        ref: story.ref,
        status: "in-progress",
        adapter: "bmad",
        source_path: specRelPath,
        source_hash: SOURCE_HASH,
        depends_on: [],
        acceptance_criteria: [{ text: "AC1 text", kind: "integration" }],
        title: story.title,
        narrative: "As a maintainer, I want concurrent isolation.",
        withdrawn: false,
        claimed_by: SESSION_ULID,
      }),
    );
    manifestPaths[story.ref] = manifestPath;
  }

  await realExeca("git", ["-C", repoRoot, "add", "."]);
  await realExeca("git", ["-C", repoRoot, "commit", "-m", "chore: scaffold stories"]);
  await realExeca("git", ["-C", repoRoot, "push", "origin", "dev"]);

  return { repoRoot, originDir, manifestPaths };
}

/**
 * execaImpl shared by concurrent flows. Real git everywhere; `gh` returns the PR
 * URL keyed off the worktree cwd (so each flow's gh resolves its own branch),
 * and `pnpm` (build gate) passes. A `failForWorktreeContaining` substring forces
 * a gh failure for one specific flow to model a mid-build/PR failure.
 */
function makeStubExeca(opts: {
  prUrlForCwd: (cwd: string) => string;
  failForWorktreeContaining?: string;
}): ReturnType<typeof vi.fn> {
  return vi.fn(
    async (
      cmd: string,
      args: readonly string[],
      options?: Record<string, unknown>,
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
      if (cmd === "gh") {
        const cwd = typeof options?.cwd === "string" ? (options.cwd as string) : "";
        if (opts.failForWorktreeContaining && cwd.includes(opts.failForWorktreeContaining)) {
          return { stdout: "", stderr: "gh pr create failed", exitCode: 1 };
        }
        return { stdout: opts.prUrlForCwd(cwd), stderr: "", exitCode: 0 };
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

async function registeredWorktrees(repoRoot: string): Promise<string[]> {
  const r = await realExeca(
    "git",
    ["-C", repoRoot, "worktree", "list", "--porcelain"],
    { reject: false },
  );
  return (r.stdout ?? "")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length).trim());
}

/**
 * Canonicalise a path (resolve symlinks) so comparisons against
 * `git worktree list` output hold on macOS, where `os.tmpdir()` is a symlink
 * (`/tmp` → `/private/tmp`, `/var/folders` real path) but git reports the real
 * path. Returns the input unchanged if it no longer exists on disk.
 */
async function real(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return p;
  }
}

/**
 * Run one full dev flow: materialise the worktree, write the dev's own edit into
 * it, then commit/push/PR. Returns the worktree handle + result (or the thrown
 * error). Models exactly what one run worker does.
 */
async function runDevFlow(
  ctx: TestContext,
  story: Story,
  execaImpl: ReturnType<typeof vi.fn>,
  sessionUlid = SESSION_ULID,
): Promise<{ worktreePath: string; cleanup: () => Promise<{ warnings: string[] }>; result?: unknown; error?: unknown }> {
  const wt = await materialiseDevStoryWorktree({
    targetRepoRoot: ctx.repoRoot,
    sessionUlid,
    ref: story.ref,
    base: "dev",
    execaImpl: execaImpl as unknown as Parameters<typeof materialiseDevStoryWorktree>[0]["execaImpl"],
  });
  // The dev edits its OWN file inside its OWN worktree.
  await atomicWriteFile(
    path.join(wt.worktreePath, story.ownFile),
    `export const ${story.ref.replace(/[^a-z]/g, "")} = true;\n`,
  );
  try {
    const result = await runDevTerminalAction({
      targetRepoRoot: wt.worktreePath,
      ref: story.ref,
      title: story.title,
      type: "feat",
      body: `Implement ${story.ref}.`,
      summary: `One-line summary for ${story.ref}.`,
      manifestPath: ctx.manifestPaths[story.ref]!,
      sessionUlid,
      // Story native:01KT40THFTS10F9PT37KCW9PF4: the pre-PR sync gate rebases the
      // branch onto `origin/<base>`. This test repo's trunk is `dev`; each story's
      // branch was cut from `origin/dev` and touches only its own file, so the
      // rebase is a clean fast-forward for both concurrent flows.
      base: "dev",
      howToTestWalkthrough: `1. Run the app. 2. Verify ${story.ref} changes are isolated.`,
      execaImpl: execaImpl as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
    });
    return { worktreePath: wt.worktreePath, cleanup: wt.cleanup, result };
  } catch (error) {
    return { worktreePath: wt.worktreePath, cleanup: wt.cleanup, error };
  }
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

describe("concurrent runs — AC3 (two concurrent devs produce two non-cross-contaminated commits)", () => {
  it("each commit contains exactly its own story's changes; neither leaks into the other", async () => {
    const prUrlForCwd = (cwd: string): string => {
      if (cwd.includes(STORY_A.ref)) return STORY_A.prUrl;
      if (cwd.includes(STORY_B.ref)) return STORY_B.prUrl;
      return "https://github.com/owner/repo/pull/1";
    };
    const spy = makeStubExeca({ prUrlForCwd });

    // Drive BOTH dev flows concurrently against the SAME repo.
    const [a, b] = await Promise.all([
      runDevFlow(ctx, STORY_A, spy),
      runDevFlow(ctx, STORY_B, spy),
    ]);

    const resA = a.result as { ok: boolean; branch: string };
    const resB = b.result as { ok: boolean; branch: string };
    expect(resA.ok).toBe(true);
    expect(resB.ok).toBe(true);

    // Concurrent worktree creation succeeded without shared-`.git` lock failure:
    // both branches exist in origin and each commit is precisely its own work.
    const filesA = await commitFiles(ctx.originDir, resA.branch);
    const filesB = await commitFiles(ctx.originDir, resB.branch);

    // A's commit has A's file and NOT B's; B's commit has B's file and NOT A's.
    expect(filesA).toContain(STORY_A.ownFile);
    expect(filesA).not.toContain(STORY_B.ownFile);
    expect(filesB).toContain(STORY_B.ownFile);
    expect(filesB).not.toContain(STORY_A.ownFile);

    // Each dev's worktree contains only its own edit — neither setup disturbed
    // the other's in-flight file.
    await expect(fs.access(path.join(a.worktreePath, STORY_A.ownFile))).resolves.toBeUndefined();
    await expect(fs.access(path.join(a.worktreePath, STORY_B.ownFile))).rejects.toBeTruthy();
    await expect(fs.access(path.join(b.worktreePath, STORY_B.ownFile))).resolves.toBeUndefined();
    await expect(fs.access(path.join(b.worktreePath, STORY_A.ownFile))).rejects.toBeTruthy();

    // The orchestrating checkout holds NEITHER dev's edit.
    await expect(fs.access(path.join(ctx.repoRoot, STORY_A.ownFile))).rejects.toBeTruthy();
    await expect(fs.access(path.join(ctx.repoRoot, STORY_B.ownFile))).rejects.toBeTruthy();

    await Promise.all([a.cleanup(), b.cleanup()]);
  });

  /**
   * AC1 same-file overlap case (Story native:01KT47430Q4C73K5E3ZECBSE5R):
   *
   * Two concurrent builders BOTH edit the same shared file (`src/shared-component.ts`).
   * In correct worktree isolation each builder edits its OWN COPY of that file inside
   * its own worktree; the shared master copy (the orchestrating checkout) is left
   * untouched. Each story's PR carries only its own version of the shared file, not
   * the sibling's, so the changes do not cross-contaminate.
   *
   * This test specifically exercises the collision path the original disjoint-file
   * test (feature-a.ts/feature-b.ts) does NOT cover: both stories touching the same
   * path. Isolation holds because the WORKTREE boundary keeps each builder's write
   * inside its own working tree; the orchestrating root checkout is never touched.
   */
  it("AC1 (same-file overlap): each builder's PR carries only its own change to a shared file; shared master is untouched", async () => {
    const SHARED_FILE = "src/shared-component.ts";

    // Helper: run a dev flow where the story edits the shared file (not its own file).
    async function runSharedFileDevFlow(
      story: Story,
      execaImpl: ReturnType<typeof vi.fn>,
    ) {
      const wt = await materialiseDevStoryWorktree({
        targetRepoRoot: ctx.repoRoot,
        sessionUlid: SESSION_ULID,
        ref: story.ref,
        base: "dev",
        execaImpl: execaImpl as unknown as Parameters<typeof materialiseDevStoryWorktree>[0]["execaImpl"],
      });
      // Each builder writes its OWN content to the SAME shared file path — but
      // inside its own worktree, so the files are independent on disk.
      await atomicWriteFile(
        path.join(wt.worktreePath, SHARED_FILE),
        `// Written by ${story.ref}\nexport const component = "${story.ref}";\n`,
      );
      try {
        const result = await runDevTerminalAction({
          targetRepoRoot: wt.worktreePath,
          ref: story.ref,
          title: story.title,
          type: "feat",
          body: `Edit shared file for ${story.ref}.`,
          summary: `One-line summary for ${story.ref}.`,
          manifestPath: ctx.manifestPaths[story.ref]!,
          sessionUlid: SESSION_ULID,
          base: "dev",
          howToTestWalkthrough: `1. Run the app. 2. Verify shared file has ${story.ref} content only.`,
          execaImpl: execaImpl as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
        });
        return { worktreePath: wt.worktreePath, cleanup: wt.cleanup, result };
      } catch (error) {
        return { worktreePath: wt.worktreePath, cleanup: wt.cleanup, error };
      }
    }

    const prUrlForCwd = (cwd: string): string => {
      if (cwd.includes(STORY_A.ref)) return STORY_A.prUrl;
      if (cwd.includes(STORY_B.ref)) return STORY_B.prUrl;
      return "https://github.com/owner/repo/pull/1";
    };
    const spy = makeStubExeca({ prUrlForCwd });

    // Run both builders concurrently — both editing the SAME file path.
    const [a, b] = await Promise.all([
      runSharedFileDevFlow(STORY_A, spy),
      runSharedFileDevFlow(STORY_B, spy),
    ]);

    const resA = a.result as { ok: boolean; branch: string };
    const resB = b.result as { ok: boolean; branch: string };
    expect(resA.ok).toBe(true);
    expect(resB.ok).toBe(true);

    // Each branch in origin carries the shared file — but with its OWN story's content.
    const filesA = await commitFiles(ctx.originDir, resA.branch);
    const filesB = await commitFiles(ctx.originDir, resB.branch);
    expect(filesA).toContain(SHARED_FILE);
    expect(filesB).toContain(SHARED_FILE);

    // The content in each branch is its OWN story's version, not the sibling's.
    const contentA = await realExeca(
      "git",
      ["-C", ctx.originDir, "show", `${resA.branch}:${SHARED_FILE}`],
      { reject: false },
    );
    const contentB = await realExeca(
      "git",
      ["-C", ctx.originDir, "show", `${resB.branch}:${SHARED_FILE}`],
      { reject: false },
    );
    expect(contentA.stdout).toContain(STORY_A.ref);
    expect(contentA.stdout).not.toContain(STORY_B.ref);
    expect(contentB.stdout).toContain(STORY_B.ref);
    expect(contentB.stdout).not.toContain(STORY_A.ref);

    // The orchestrating checkout's master copy of the shared file is UNTOUCHED
    // (does not exist — it was never in the initial commit).
    await expect(
      fs.access(path.join(ctx.repoRoot, SHARED_FILE)),
    ).rejects.toBeTruthy();

    await Promise.all([a.cleanup(), b.cleanup()]);
  });

  /**
   * AC1 leak detection: a builder that DOES leak (writes to absolute shared-copy path)
   * is caught by the pre-PR leak gate (PrePrLeakDetectedError) and no PR is opened.
   * This verifies the deterministic safety net (AC2 behaviour surfaced from the
   * concurrent-run perspective).
   */
  it("AC1 (leak gate): a builder that dirtied the shared master copy is stopped BEFORE opening a PR", async () => {
    // Materialise A's worktree.
    const wt = await materialiseDevStoryWorktree({
      targetRepoRoot: ctx.repoRoot,
      sessionUlid: SESSION_ULID,
      ref: STORY_A.ref,
      base: "dev",
    });

    // Simulate a builder that leaked: write to the SHARED ROOT (not the worktree).
    // This is exactly what a builder using an absolute shared-copy path would do.
    const leakedFile = path.join(ctx.repoRoot, STORY_A.ownFile);
    await atomicWriteFile(leakedFile, "leaked edit\n");

    // Also write inside the worktree so the commit has something staged.
    const worktreeFile = path.join(wt.worktreePath, STORY_A.ownFile);
    await atomicWriteFile(worktreeFile, "worktree edit\n");

    const prUrlForCwd = (): string => STORY_A.prUrl;
    const spy = makeStubExeca({ prUrlForCwd });

    const flowResult = await runDevTerminalAction({
      targetRepoRoot: wt.worktreePath,
      ref: STORY_A.ref,
      title: STORY_A.title,
      type: "feat",
      body: "body",
      summary: "summary",
      manifestPath: ctx.manifestPaths[STORY_A.ref]!,
      sessionUlid: SESSION_ULID,
      base: "dev",
      execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
    }).catch((e) => e);

    // The pre-PR leak gate must have stopped with PrePrLeakDetectedError.
    expect(flowResult).toBeInstanceOf(PrePrLeakDetectedError);
    const err = flowResult as PrePrLeakDetectedError;
    expect(err.leakedPaths).toContain(STORY_A.ownFile);

    // No PR was opened — gh was never called.
    const ghCalls = (spy.mock.calls as [string][]).filter(([cmd]) => cmd === "gh");
    expect(ghCalls).toHaveLength(0);

    // Clean up leaked file so afterEach teardown does not fail.
    await fs.rm(leakedFile, { force: true });
    await wt.cleanup();
  });
});

describe("concurrent runs — AC4 (cleanup is concurrency- and crash-safe)", () => {
  it("a mid-build failure in one flow leaves a concurrent flow's worktree intact and leaks no worktree", async () => {
    const prUrlForCwd = (cwd: string): string =>
      cwd.includes(STORY_A.ref) ? STORY_A.prUrl : STORY_B.prUrl;
    // Story B's gh pr create fails → B's flow throws mid-step.
    const spy = makeStubExeca({ prUrlForCwd, failForWorktreeContaining: STORY_B.ref });

    const [a, b] = await Promise.all([
      runDevFlow(ctx, STORY_A, spy),
      runDevFlow(ctx, STORY_B, spy),
    ]);

    // A succeeded; B hard-failed — the failure was isolated to B's flow.
    expect((a.result as { ok: boolean }).ok).toBe(true);
    expect(b.error).toBeInstanceOf(GhPrCreateFailedError);

    // B's failure did NOT disturb A's worktree — A's is still present and usable.
    const aReal = await real(a.worktreePath);
    const aWtBefore = await registeredWorktrees(ctx.repoRoot);
    expect(aWtBefore).toContain(aReal);
    await expect(fs.access(path.join(a.worktreePath, STORY_A.ownFile))).resolves.toBeUndefined();

    // Clean up the failed flow's worktree (what the run does after a worker
    // returns) — it removes ONLY B's worktree, never A's.
    await b.cleanup();
    const afterBCleanup = await registeredWorktrees(ctx.repoRoot);
    // No leftover worktree for the failed story B survives.
    expect(afterBCleanup.filter((w) => w.includes(STORY_B.ref))).toEqual([]);
    // A's worktree is untouched by B's cleanup.
    expect(afterBCleanup).toContain(aReal);

    await a.cleanup();
    const finalWts = await registeredWorktrees(ctx.repoRoot);
    expect(finalWts.filter((w) => w.includes(STORY_A.ref))).toEqual([]);
  });

  it("reaps a worktree left behind by a prior, now-dead session on a subsequent run", async () => {
    const deadSession = "01HZDEADSESSION0000000000";

    // A prior worker (now-dead session) left a worktree behind — model it by
    // materialising one under the dead session and NOT cleaning it up.
    const stale = await materialiseDevStoryWorktree({
      targetRepoRoot: ctx.repoRoot,
      sessionUlid: deadSession,
      ref: STORY_A.ref,
      base: "dev",
    });
    // It is registered and on disk before the reap.
    const staleReal = await real(stale.worktreePath);
    expect(await registeredWorktrees(ctx.repoRoot)).toContain(staleReal);

    // The current (live) session also has its own worktree in flight.
    const live = await materialiseDevStoryWorktree({
      targetRepoRoot: ctx.repoRoot,
      sessionUlid: SESSION_ULID,
      ref: STORY_B.ref,
      base: "dev",
    });
    const liveReal = await real(live.worktreePath);

    // The next run's crash-recovery reap, keyed on the LIVE session.
    const { reaped } = await reapStaleDevStoryWorktrees({
      targetRepoRoot: ctx.repoRoot,
      currentSessionUlid: SESSION_ULID,
    });

    // The dead session's worktree was reaped; the live session's was NOT.
    // (The reap removes by git's registered path, which is canonicalised.)
    const reapedReal = await Promise.all(reaped.map((p) => real(p)));
    expect(reaped).toContain(staleReal);
    expect(reapedReal).not.toContain(liveReal);

    const remaining = await registeredWorktrees(ctx.repoRoot);
    expect(remaining).not.toContain(staleReal);
    expect(remaining).toContain(liveReal);
    // The stale directory is physically gone.
    await expect(fs.access(stale.worktreePath)).rejects.toBeTruthy();

    await live.cleanup();
  });

  it("derives a stable, sibling (non-nested) worktree path per session+ref", () => {
    const p = devStoryWorktreePath(ctx.repoRoot, SESSION_ULID, STORY_A.ref);
    // Sibling of the checkout — never nested inside it (so a dev's scan never
    // recurses into a self-copy, and concurrent worktrees do not sit in the tree).
    expect(p.startsWith(ctx.repoRoot + path.sep)).toBe(false);
    expect(p).toContain(SESSION_ULID);
    expect(p).toContain("8-20-story-a");
  });
});
