/**
 * Integration tests for `runDevTerminalAction`.
 *
 * Uses a real tmpdir git repo (real git init, real commits), stubs
 * `git push` and `gh pr create` via execaImpl injection to avoid network IO.
 *
 * Covers AC3 (3a)–(3i) from Story 4.4.
 * AC3 (3j) — tool count — is covered by ask-mode-enforcement / ask-skill /
 * get-team-snapshot tests updated in Task 4.6.
 *
 * @see _bmad-output/implementation-artifacts/4-4-dev-subagent-git-push-and-gh-pr-create-terminal-action.md § Behavioural contract
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execa as realExeca } from "execa";
import { stringify as yamlStringify } from "yaml";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { devOutcomeFilePath } from "../../lib/read-dev-outcome-file.js";
import { materialiseDevStoryWorktree } from "../../lib/dev-story-worktree.js";
import { runDevTerminalAction } from "../run-dev-terminal-action.js";
import {
  ConventionalCommitTypeUnknownError,
  GitPushFailedError,
  GhPrCreateFailedError,
  MissingWalkthroughError,
  NegativeCapabilityDeniedError,
  PrePrLeakDetectedError,
  RebaseConflictError,
  PrePrBuildFailedError,
} from "../../errors.js";
import { DEFAULT_BUILD_TEST_TIMEOUT_MS } from "../../lib/run-project-build.js";
import { seedFlowShapedBuildHome } from "../../lib/__tests__/flow-shaped-build-home.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REF = "4-4-terminal-action-integration";
const TITLE = "Integration test for runDevTerminalAction";
const TYPE = "feat";
const BODY =
  "This commit adds the runDevTerminalAction MCP tool. " +
  "It covers branch creation, conventional commit, push, and PR creation.";
const SUMMARY = "Implements the dev subagent terminal action.";
const FAKE_PR_URL = "https://github.com/owner/repo/pull/42";
const SESSION_ULID = "01HZSESSION00000000000001";
const SOURCE_HASH = "a".repeat(64);

/**
 * Fixture by-hand walk-through used in tests that need to pass the
 * walk-through gate (Story native:01KVAEEF3V59H7P4V3R1HBXNC0).
 * Tests that intentionally omit or blank it are in the AC2 describe block.
 */
const FIXTURE_WALKTHROUGH =
  "1. Run `pnpm flow:run`\n" +
  "2. Observe the walk-through rendered under 'How to check it yourself' in the PR.\n" +
  "3. Confirm the fallback line does NOT appear.";

/** The honest fallback text the PR body emits when no walk-through is supplied. */
const FALLBACK_LINE = "No walk-through was provided by the developer";

/** Fixture spec with three ACs: one (user-surface), one untagged, one (integration). */
const FIXTURE_SPEC = `
# Story 4.4: Dev terminal action

Status: ready-for-dev

## Acceptance Criteria

**AC1 (user-surface):**
Given a finished implementation,
When the dev subagent emits its terminal action,
Then it creates a branch and opens a PR.

**AC2:**
Given the dev subagent permission spec,
When it attempts --no-verify,
Then the execa wrapper refuses.

**AC3 (integration):**
vitest runs the dev terminal action against a fixture repo.
`;

// ---------------------------------------------------------------------------
// Test repo setup
// ---------------------------------------------------------------------------

interface TestContext {
  repoRoot: string;
  manifestPath: string;
  specPath: string;
}

async function setupRepo(): Promise<TestContext> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "run-dev-terminal-"));

  // git init with a name and email (required for git commit)
  await realExeca("git", ["-C", repoRoot, "init"]);
  await realExeca("git", [
    "-C", repoRoot, "config", "user.email", "test@test.com",
  ]);
  await realExeca("git", [
    "-C", repoRoot, "config", "user.name", "Test User",
  ]);

  // Write a file and make an initial commit so HEAD exists and checkout -b works
  const srcDir = path.join(repoRoot, "src");
  await fs.mkdir(srcDir, { recursive: true });
  await atomicWriteFile(path.join(srcDir, "index.ts"), "export const x = 1;\n");
  // Flow-shaped build home so the structural toolchain resolver lands on
  // plugins/flow + pnpm (Story native:01KVTB3Z) — the stub intercepts pnpm.
  await seedFlowShapedBuildHome(repoRoot);
  await realExeca("git", ["-C", repoRoot, "add", "."]);
  await realExeca("git", ["-C", repoRoot, "commit", "-m", "chore: initial commit"]);

  // Set up .flow/state/in-progress/<ref>.yaml
  const stateDir = path.join(repoRoot, ".flow", "state", "in-progress");
  await fs.mkdir(stateDir, { recursive: true });

  // Write spec file to a known location
  const specRelPath = `_bmad-output/implementation-artifacts/${REF}.md`;
  const specDir = path.join(repoRoot, "_bmad-output", "implementation-artifacts");
  await fs.mkdir(specDir, { recursive: true });
  const specPath = path.join(specDir, `${REF}.md`);
  await atomicWriteFile(specPath, FIXTURE_SPEC);

  // Write manifest — use source_path (repo-relative)
  const manifestPath = path.join(stateDir, `${REF}.yaml`);
  const manifest = {
    ref: REF,
    status: "in-progress",
    adapter: "bmad",
    source_path: specRelPath,
    source_hash: SOURCE_HASH,
    depends_on: [],
    acceptance_criteria: [
      { text: "AC1 text", kind: "unit" },
    ],
    title: TITLE,
    narrative: "As a dev, I want a terminal action.",
    withdrawn: false,
    claimed_by: SESSION_ULID,
  };
  // Use atomicWriteFile for manifest (not a canonical path in this test, just a tmpdir)
  await atomicWriteFile(manifestPath, yamlStringify(manifest));

  // Also write a new file (simulate dev work done after initial commit)
  await atomicWriteFile(
    path.join(srcDir, "new-feature.ts"),
    "export const y = 2;\n",
  );

  return { repoRoot, manifestPath, specPath };
}

// ---------------------------------------------------------------------------
// execaImpl factory: real git for add/commit/checkout/rev-parse, stub push and gh
// ---------------------------------------------------------------------------

type ExecaResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

function makeStubExeca(opts: {
  pushShouldFail?: boolean;
  ghShouldFail?: boolean;
  ghStdout?: string;
  buildShouldFail?: boolean;
  testShouldFail?: boolean;
  /** Simulate a build timeout: pnpm build returns exitCode 1 with timedOut:true */
  buildTimedOut?: boolean;
  /** Simulate a test timeout: pnpm test returns exitCode 1 with timedOut:true */
  testTimedOut?: boolean;
  /**
   * Story native:01KT40THFTS10F9PT37KCW9PF4: when set, `git rebase <onto>`
   * returns a non-zero exit carrying this conflict output, so the wrapper aborts
   * and throws RebaseConflictError. The actual `rebase --abort` is stubbed to
   * succeed.
   */
  rebaseConflictStdout?: string;
}): ReturnType<typeof vi.fn> {
  return vi.fn(
    async (
      cmd: string,
      args: readonly string[],
      options?: Record<string, unknown>,
    ): Promise<ExecaResult & { timedOut?: boolean }> => {
      // Story 8.17 / native:01KT3ER5E9ACCERHAEJ5NM94TH: the pre-PR build gate
      // spawns `pnpm build` and the test gate spawns `pnpm ... test`. Stub both
      // so the integration tests never spawn a real build/test run; default to
      // success. Distinguish by whether a test sub-command appears in the args.
      if (cmd === "pnpm") {
        const isTestRun = args.some((a) => /test|vitest/.test(a));
        if (isTestRun) {
          if (opts.testTimedOut) {
            return { stdout: "", stderr: "", exitCode: 1, timedOut: true };
          }
          if (opts.testShouldFail) {
            return { stdout: "", stderr: "1 failed", exitCode: 1 };
          }
          return { stdout: "test ok", stderr: "", exitCode: 0 };
        }
        if (opts.buildTimedOut) {
          return { stdout: "", stderr: "", exitCode: 1, timedOut: true };
        }
        if (opts.buildShouldFail) {
          return { stdout: "", stderr: "tsc: error TS2339", exitCode: 1 };
        }
        return { stdout: "build ok", stderr: "", exitCode: 0 };
      }

      if (cmd === "gh") {
        if (opts.ghShouldFail) {
          return { stdout: "", stderr: "gh pr create failed", exitCode: 1 };
        }
        return {
          stdout: opts.ghStdout ?? FAKE_PR_URL,
          stderr: "",
          exitCode: 0,
        };
      }

      // git commands
      const subcmd = args[2]; // args = ["-C", root, subcmd, ...]

      // Story native:01KT40THFTS10F9PT37KCW9PF4: the pre-PR sync gate runs
      // `git fetch origin` then `git rebase origin/<base>` in the tmpdir repo,
      // which has no `origin` remote. Stub both so the integration tests never
      // touch a network remote; default fetch + rebase to success.
      if (subcmd === "fetch") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (subcmd === "rebase") {
        // `rebase --abort` (args[3] === "--abort") always succeeds.
        if (args[3] === "--abort") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        // `rebase <onto>`: a configured conflict returns non-zero with the
        // conflict output so the wrapper aborts and throws RebaseConflictError.
        if (opts.rebaseConflictStdout !== undefined) {
          return { stdout: opts.rebaseConflictStdout, stderr: "", exitCode: 1 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }

      if (subcmd === "push") {
        if (opts.pushShouldFail) {
          // Return with exitCode non-zero (reject:false means no throw from real execa)
          return { stdout: "", stderr: "fatal: remote rejected", exitCode: 128 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }

      // Delegate real git ops to real execa
      const result = await realExeca(cmd, args as string[], {
        ...options,
        reject: false,
      });
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.exitCode ?? 0,
      };
    },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let ctx: TestContext;

beforeEach(async () => {
  ctx = await setupRepo();
});

afterEach(async () => {
  await fs.rm(ctx.repoRoot, { recursive: true, force: true });
});

describe("runDevTerminalAction — happy path (AC3a)", () => {
  it("(3a) creates branch, commits, pushes (stubbed), creates PR (stubbed), returns result", async () => {
    const spy = makeStubExeca({ ghStdout: FAKE_PR_URL });

    const result = await runDevTerminalAction({
      targetRepoRoot: ctx.repoRoot,
      ref: REF,
      title: TITLE,
      type: TYPE,
      body: BODY,
      summary: SUMMARY,
      manifestPath: ctx.manifestPath,
      sessionUlid: SESSION_ULID,
      worktree: false,
      howToTestWalkthrough: FIXTURE_WALKTHROUGH,
      execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
    });

    // (3a) tool returns { ok: true, branch, commitSha, prUrl }
    expect(result.ok).toBe(true);
    expect(result.prUrl).toBe(FAKE_PR_URL);
    expect(result.branch).toMatch(/^story\//);
    expect(result.commitSha).toBeTruthy();
    expect(result.commitSha.length).toBeGreaterThan(0);

    // (3a) branch was created — check git
    const branchResult = await realExeca(
      "git",
      ["-C", ctx.repoRoot, "branch", "--show-current"],
      { reject: false },
    );
    expect(branchResult.stdout.trim()).toBe(result.branch);

    // (3a) commit subject equals feat(<ref>): <title>
    const logResult = await realExeca(
      "git",
      ["-C", ctx.repoRoot, "log", "-1", "--pretty=%s"],
      { reject: false },
    );
    expect(logResult.stdout.trim()).toBe(`${TYPE}(${REF}): ${TITLE}`);

    // (3a) gh pr create was called with --title and --body
    const ghCall = (spy.mock.calls as [string, string[]][]).find(
      ([cmd]) => cmd === "gh",
    );
    expect(ghCall).toBeDefined();
    const ghArgs = ghCall![1];
    expect(ghArgs).toContain("--title");
    expect(ghArgs).toContain("--body");

    const bodyIdx = ghArgs.indexOf("--body");
    const bodyArg = ghArgs[bodyIdx + 1]!;
    // Machine block anchors
    expect(bodyArg).toContain("<!-- flow:pr:machine -->");
    expect(bodyArg).toContain("<!-- /flow:pr:machine -->");
    // ACs checklist (three entries from fixture spec)
    expect(bodyArg).toContain("- [ ] AC1:");
    expect(bodyArg).toContain("- [ ] AC2:");
    expect(bodyArg).toContain("- [ ] AC3:");
    // Free-form summary
    expect(bodyArg).toContain(SUMMARY);
  });

  it("(3a) commit body has all lines ≤72 chars (URLs excepted)", async () => {
    const spy = makeStubExeca({ ghStdout: FAKE_PR_URL });

    await runDevTerminalAction({
      targetRepoRoot: ctx.repoRoot,
      ref: REF,
      title: TITLE,
      type: TYPE,
      body: BODY,
      summary: SUMMARY,
      manifestPath: ctx.manifestPath,
      sessionUlid: SESSION_ULID,
      worktree: false,
      howToTestWalkthrough: FIXTURE_WALKTHROUGH,
      execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
    });

    // Check the git commit body via log
    const logResult = await realExeca(
      "git",
      ["-C", ctx.repoRoot, "log", "-1", "--pretty=%b"],
      { reject: false },
    );
    const bodyText = logResult.stdout.trim();
    if (bodyText.length > 0) {
      for (const line of bodyText.split("\n")) {
        if (/https?:\/\//.test(line)) continue;
        expect(line.length, `line too long: "${line}"`).toBeLessThanOrEqual(72);
      }
    }
  });

  it("(3a) prUrl equals stubbed gh pr create stdout", async () => {
    const customUrl = "https://github.com/owner/repo/pull/99";
    const spy = makeStubExeca({ ghStdout: customUrl });

    const result = await runDevTerminalAction({
      targetRepoRoot: ctx.repoRoot,
      ref: REF,
      title: TITLE,
      type: TYPE,
      body: BODY,
      summary: SUMMARY,
      manifestPath: ctx.manifestPath,
      sessionUlid: SESSION_ULID,
      worktree: false,
      howToTestWalkthrough: FIXTURE_WALKTHROUGH,
      execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
    });

    expect(result.prUrl).toBe(customUrl);
  });
});

describe("runDevTerminalAction — PR base branch", () => {
  /** Helper: pull the value following `--base` out of the stubbed gh call. */
  function baseArgFromSpy(spy: ReturnType<typeof vi.fn>): string | undefined {
    const ghCall = (spy.mock.calls as [string, string[]][]).find(
      ([cmd]) => cmd === "gh",
    );
    expect(ghCall).toBeDefined();
    const ghArgs = ghCall![1];
    const baseIdx = ghArgs.indexOf("--base");
    return baseIdx === -1 ? undefined : ghArgs[baseIdx + 1];
  }

  it("defaults the PR base to `main` when no base is supplied", async () => {
    const spy = makeStubExeca({ ghStdout: FAKE_PR_URL });

    await runDevTerminalAction({
      targetRepoRoot: ctx.repoRoot,
      ref: REF,
      title: TITLE,
      type: TYPE,
      body: BODY,
      summary: SUMMARY,
      manifestPath: ctx.manifestPath,
      sessionUlid: SESSION_ULID,
      worktree: false,
      howToTestWalkthrough: FIXTURE_WALKTHROUGH,
      execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
    });

    expect(baseArgFromSpy(spy)).toBe("main");
  });

  it("honours an explicit base branch override", async () => {
    const spy = makeStubExeca({ ghStdout: FAKE_PR_URL });

    await runDevTerminalAction({
      targetRepoRoot: ctx.repoRoot,
      ref: REF,
      title: TITLE,
      type: TYPE,
      body: BODY,
      summary: SUMMARY,
      manifestPath: ctx.manifestPath,
      sessionUlid: SESSION_ULID,
      worktree: false,
      base: "release",
      howToTestWalkthrough: FIXTURE_WALKTHROUGH,
      execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
    });

    expect(baseArgFromSpy(spy)).toBe("release");
  });
});

describe("runDevTerminalAction — branch slug edge cases (AC3b)", () => {
  it("(3b) title with punctuation collapses to kebab", async () => {
    const spy = makeStubExeca({ ghStdout: FAKE_PR_URL });
    const result = await runDevTerminalAction({
      targetRepoRoot: ctx.repoRoot,
      ref: "1-2-auth",
      title: "User Auth Token Handling",
      type: "feat",
      body: "body",
      summary: "summary",
      manifestPath: ctx.manifestPath,
      sessionUlid: SESSION_ULID,
      worktree: false,
      howToTestWalkthrough: FIXTURE_WALKTHROUGH,
      execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
    });
    expect(result.branch).toMatch(/^story\/[a-z0-9-]+$/);
    expect(result.branch).toContain("1-2-auth");
  });

  it("(3b) title slug trimmed to 40 chars", async () => {
    const longTitle =
      "This is a very very very very very long story title exceeding forty chars";
    const spy = makeStubExeca({ ghStdout: FAKE_PR_URL });
    const result = await runDevTerminalAction({
      targetRepoRoot: ctx.repoRoot,
      ref: "1-1-x",
      title: longTitle,
      type: "fix",
      body: "body",
      summary: "summary",
      manifestPath: ctx.manifestPath,
      sessionUlid: SESSION_ULID,
      worktree: false,
      howToTestWalkthrough: FIXTURE_WALKTHROUGH,
      execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
    });
    const afterRef = result.branch.slice("story/1-1-x-".length);
    expect(afterRef.length).toBeLessThanOrEqual(40);
  });

  it("(3b) Unicode title: slug starts with story/ and has alphanumeric", async () => {
    const spy = makeStubExeca({ ghStdout: FAKE_PR_URL });
    const result = await runDevTerminalAction({
      targetRepoRoot: ctx.repoRoot,
      ref: "2-1-setup",
      title: "Setup fuer Aeerger resume",
      type: "chore",
      body: "body",
      summary: "summary",
      manifestPath: ctx.manifestPath,
      sessionUlid: SESSION_ULID,
      worktree: false,
      howToTestWalkthrough: FIXTURE_WALKTHROUGH,
      execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
    });
    expect(result.branch).toMatch(/^story\/[a-z0-9-]+$/);
  });
});

describe("runDevTerminalAction — commit type validation (AC3c)", () => {
  it("(3c) invalid type 'feature' raises ConventionalCommitTypeUnknownError BEFORE any spawn", async () => {
    const spy = vi.fn();
    await expect(
      runDevTerminalAction({
        targetRepoRoot: ctx.repoRoot,
        ref: REF,
        title: TITLE,
        type: "feature",
        body: BODY,
        summary: SUMMARY,
        manifestPath: ctx.manifestPath,
        sessionUlid: SESSION_ULID,
        worktree: false,
        execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
      }),
    ).rejects.toBeInstanceOf(ConventionalCommitTypeUnknownError);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("runDevTerminalAction — body wrap (AC3d)", () => {
  it("(3d) a 200-char body line is wrapped so each line ≤72 chars in the commit", async () => {
    const words = Array.from({ length: 30 }, (_, i) => `word${i}`);
    const longBody = words.join(" "); // > 72 chars with spaces
    expect(longBody.length).toBeGreaterThan(72);

    const spy = makeStubExeca({ ghStdout: FAKE_PR_URL });
    await runDevTerminalAction({
      targetRepoRoot: ctx.repoRoot,
      ref: REF,
      title: TITLE,
      type: TYPE,
      body: longBody,
      summary: SUMMARY,
      manifestPath: ctx.manifestPath,
      sessionUlid: SESSION_ULID,
      worktree: false,
      howToTestWalkthrough: FIXTURE_WALKTHROUGH,
      execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
    });

    const logResult = await realExeca(
      "git",
      ["-C", ctx.repoRoot, "log", "-1", "--pretty=%b"],
      { reject: false },
    );
    const bodyText = logResult.stdout.trim();
    for (const line of bodyText.split("\n")) {
      if (/https?:\/\//.test(line)) continue;
      expect(line.length, `line too long: "${line}"`).toBeLessThanOrEqual(72);
    }
  });

  it("(3d) a body with a 100-char URL line is left untouched", async () => {
    const longUrl = "https://github.com/owner/repo/issues/" + "x".repeat(70);
    expect(longUrl.length).toBeGreaterThan(72);

    const spy = makeStubExeca({ ghStdout: FAKE_PR_URL });
    await runDevTerminalAction({
      targetRepoRoot: ctx.repoRoot,
      ref: REF,
      title: TITLE,
      type: TYPE,
      body: longUrl,
      summary: SUMMARY,
      manifestPath: ctx.manifestPath,
      sessionUlid: SESSION_ULID,
      worktree: false,
      howToTestWalkthrough: FIXTURE_WALKTHROUGH,
      execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
    });

    const logResult = await realExeca(
      "git",
      ["-C", ctx.repoRoot, "log", "-1", "--pretty=%b"],
      { reject: false },
    );
    // The URL line must appear intact
    expect(logResult.stdout).toContain(longUrl);
  });
});

describe("runDevTerminalAction — negative capabilities (AC3e)", () => {
  it("(3e-i) --no-verify in gh args raises NegativeCapabilityDeniedError without spawn", async () => {
    const { gh: ghWrapper } = await import("../../lib/gh.js");
    const spy = vi.fn();

    // We test the gh wrapper directly (test-only path)
    const perms = {
      role: "generalist-dev",
      tools_allow: ["runDevTerminalAction"],
      gh_allow: ["pr-create"],
      gh_allow_args: {},
      sourcePath: "/fake/permissions/generalist-dev.yaml",
    };

    await expect(
      ghWrapper({
        role: "generalist-dev",
        permissions: perms,
        subcommand: "pr-create",
        args: ["--no-verify"],
        execaImpl: spy as unknown as Parameters<typeof ghWrapper>[0]["execaImpl"],
      }),
    ).rejects.toBeInstanceOf(NegativeCapabilityDeniedError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("(3e-ii) --force-with-lease in gh args raises NegativeCapabilityDeniedError", async () => {
    const { gh: ghWrapper } = await import("../../lib/gh.js");
    const spy = vi.fn();
    const perms = {
      role: "generalist-dev",
      tools_allow: ["runDevTerminalAction"],
      gh_allow: ["pr-create"],
      gh_allow_args: {},
      sourcePath: "/fake/permissions/generalist-dev.yaml",
    };

    await expect(
      ghWrapper({
        role: "generalist-dev",
        permissions: perms,
        subcommand: "pr-create",
        args: ["--force-with-lease"],
        execaImpl: spy as unknown as Parameters<typeof ghWrapper>[0]["execaImpl"],
      }),
    ).rejects.toBeInstanceOf(NegativeCapabilityDeniedError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("(3e-ii) --force-with-lease=refs/heads/main raises NegativeCapabilityDeniedError", async () => {
    const { gh: ghWrapper } = await import("../../lib/gh.js");
    const spy = vi.fn();
    const perms = {
      role: "generalist-dev",
      tools_allow: ["runDevTerminalAction"],
      gh_allow: ["pr-create"],
      gh_allow_args: {},
      sourcePath: "/fake/permissions/generalist-dev.yaml",
    };

    await expect(
      ghWrapper({
        role: "generalist-dev",
        permissions: perms,
        subcommand: "pr-create",
        args: ["--force-with-lease=refs/heads/main"],
        execaImpl: spy as unknown as Parameters<typeof ghWrapper>[0]["execaImpl"],
      }),
    ).rejects.toBeInstanceOf(NegativeCapabilityDeniedError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("(3e-ii) --force in gh args raises NegativeCapabilityDeniedError", async () => {
    const { gh: ghWrapper } = await import("../../lib/gh.js");
    const spy = vi.fn();
    const perms = {
      role: "generalist-dev",
      tools_allow: ["runDevTerminalAction"],
      gh_allow: ["pr-create"],
      gh_allow_args: {},
      sourcePath: "/fake/permissions/generalist-dev.yaml",
    };

    await expect(
      ghWrapper({
        role: "generalist-dev",
        permissions: perms,
        subcommand: "pr-create",
        args: ["--force"],
        execaImpl: spy as unknown as Parameters<typeof ghWrapper>[0]["execaImpl"],
      }),
    ).rejects.toBeInstanceOf(NegativeCapabilityDeniedError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("(3e-iii) --no-verify in git push raises NegativeCapabilityDeniedError", async () => {
    const { assertNoNegativeFlags } = await import("../../lib/git.js");
    expect(() =>
      assertNoNegativeFlags(["--no-verify"], "generalist-dev", "git"),
    ).toThrow(NegativeCapabilityDeniedError);
  });
});

describe("runDevTerminalAction — push failure (AC3f)", () => {
  it("(3f) stubbed push failure raises GitPushFailedError with stderr", async () => {
    const spy = makeStubExeca({ pushShouldFail: true });

    await expect(
      runDevTerminalAction({
        targetRepoRoot: ctx.repoRoot,
        ref: REF,
        title: TITLE,
        type: TYPE,
        body: BODY,
        summary: SUMMARY,
        manifestPath: ctx.manifestPath,
        sessionUlid: SESSION_ULID,
        worktree: false,
        howToTestWalkthrough: FIXTURE_WALKTHROUGH,
        execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
      }),
    ).rejects.toBeInstanceOf(GitPushFailedError);
  });

  it("(3f) local branch and commit are NOT rolled back after push failure", async () => {
    const spy = makeStubExeca({ pushShouldFail: true });

    try {
      await runDevTerminalAction({
        targetRepoRoot: ctx.repoRoot,
        ref: REF,
        title: TITLE,
        type: TYPE,
        body: BODY,
        summary: SUMMARY,
        manifestPath: ctx.manifestPath,
        sessionUlid: SESSION_ULID,
        worktree: false,
        howToTestWalkthrough: FIXTURE_WALKTHROUGH,
        execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
      });
    } catch {
      // expected
    }

    // Branch still exists
    const branchResult = await realExeca(
      "git",
      ["-C", ctx.repoRoot, "branch", "--show-current"],
      { reject: false },
    );
    expect(branchResult.stdout.trim()).toMatch(/^story\//);

    // Commit was made
    const logResult = await realExeca(
      "git",
      ["-C", ctx.repoRoot, "log", "-1", "--pretty=%s"],
      { reject: false },
    );
    expect(logResult.stdout.trim()).toContain(TYPE);
  });
});

describe("runDevTerminalAction — gh pr create failure (AC3g)", () => {
  it("(3g) gh pr create failure raises GhPrCreateFailedError", async () => {
    const spy = makeStubExeca({ ghShouldFail: true });

    await expect(
      runDevTerminalAction({
        targetRepoRoot: ctx.repoRoot,
        ref: REF,
        title: TITLE,
        type: TYPE,
        body: BODY,
        summary: SUMMARY,
        manifestPath: ctx.manifestPath,
        sessionUlid: SESSION_ULID,
        worktree: false,
        howToTestWalkthrough: FIXTURE_WALKTHROUGH,
        execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
      }),
    ).rejects.toBeInstanceOf(GhPrCreateFailedError);
  });

  it("(3g) gh pr create stdout missing PR URL raises GhPrCreateFailedError", async () => {
    const spy = makeStubExeca({ ghStdout: "not-a-pr-url" });

    await expect(
      runDevTerminalAction({
        targetRepoRoot: ctx.repoRoot,
        ref: REF,
        title: TITLE,
        type: TYPE,
        body: BODY,
        summary: SUMMARY,
        manifestPath: ctx.manifestPath,
        sessionUlid: SESSION_ULID,
        worktree: false,
        howToTestWalkthrough: FIXTURE_WALKTHROUGH,
        execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
      }),
    ).rejects.toBeInstanceOf(GhPrCreateFailedError);
  });
});

describe("runDevTerminalAction — manifest PR identifier recorded (AC3h / native:01KTNJ6QVZWVF407QEJPZSDTZK)", () => {
  it("(3h) pr_number and pr_branch are stamped onto the in-progress manifest after successful run", async () => {
    // Story native:01KTNJ6QVZWVF407QEJPZSDTZK: runDevTerminalAction now records
    // the real PR number and branch onto the in-progress manifest so that the
    // dep-merge-check can use `gh pr view <prNumber>` instead of a title-derived
    // slug probe (which fails when the real branch name differs from the slug).
    const spy = makeStubExeca({ ghStdout: FAKE_PR_URL });
    await runDevTerminalAction({
      targetRepoRoot: ctx.repoRoot,
      ref: REF,
      title: TITLE,
      type: TYPE,
      body: BODY,
      summary: SUMMARY,
      manifestPath: ctx.manifestPath,
      sessionUlid: SESSION_ULID,
      worktree: false,
      howToTestWalkthrough: FIXTURE_WALKTHROUGH,
      execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
    });

    // FAKE_PR_URL = "https://github.com/owner/repo/pull/42" → prNumber = 42.
    const after = await fs.readFile(ctx.manifestPath, "utf8");
    expect(after).toContain("pr_number: 42");
    // pr_branch is the buildBranchSlug of {ref, title}.
    expect(after).toContain("pr_branch:");
  });
});

describe("runDevTerminalAction — ACs checklist mirroring (AC3i)", () => {
  it("(3i) machine block contains three ACs in numeric order", async () => {
    const spy = makeStubExeca({ ghStdout: FAKE_PR_URL });
    await runDevTerminalAction({
      targetRepoRoot: ctx.repoRoot,
      ref: REF,
      title: TITLE,
      type: TYPE,
      body: BODY,
      summary: SUMMARY,
      manifestPath: ctx.manifestPath,
      sessionUlid: SESSION_ULID,
      worktree: false,
      howToTestWalkthrough: FIXTURE_WALKTHROUGH,
      execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
    });

    const ghCall = (spy.mock.calls as [string, string[]][]).find(
      ([cmd]) => cmd === "gh",
    );
    const ghArgs = ghCall![1];
    const bodyIdx = ghArgs.indexOf("--body");
    const bodyArg = ghArgs[bodyIdx + 1]!;

    // Three ACs in order
    const ac1Idx = bodyArg.indexOf("- [ ] AC1:");
    const ac2Idx = bodyArg.indexOf("- [ ] AC2:");
    const ac3Idx = bodyArg.indexOf("- [ ] AC3:");

    expect(ac1Idx).toBeGreaterThanOrEqual(0);
    expect(ac2Idx).toBeGreaterThan(ac1Idx);
    expect(ac3Idx).toBeGreaterThan(ac2Idx);
  });

  it("(3i) (integration)-tagged AC is in the checklist", async () => {
    const spy = makeStubExeca({ ghStdout: FAKE_PR_URL });
    await runDevTerminalAction({
      targetRepoRoot: ctx.repoRoot,
      ref: REF,
      title: TITLE,
      type: TYPE,
      body: BODY,
      summary: SUMMARY,
      manifestPath: ctx.manifestPath,
      sessionUlid: SESSION_ULID,
      worktree: false,
      howToTestWalkthrough: FIXTURE_WALKTHROUGH,
      execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
    });

    const ghCall = (spy.mock.calls as [string, string[]][]).find(
      ([cmd]) => cmd === "gh",
    );
    const ghArgs = ghCall![1];
    const bodyIdx = ghArgs.indexOf("--body");
    const bodyArg = ghArgs[bodyIdx + 1]!;

    // AC3 is the (integration)-tagged one
    expect(bodyArg).toContain("- [ ] AC3:");
    expect(bodyArg).toContain("vitest runs the dev terminal action");
  });
});

// ---------------------------------------------------------------------------
// Story 4.8b AC5a: dev-outcome.json write path
// ---------------------------------------------------------------------------

describe("runDevTerminalAction — dev-outcome.json write (Story 4.8b AC5a)", () => {
  it("(5a) writes dev-outcome.json to the session directory with correct content", async () => {
    const targetPrUrl = "https://github.com/jackmcintyre/crew/pull/42";
    const spy = makeStubExeca({ ghStdout: targetPrUrl });

    const result = await runDevTerminalAction({
      targetRepoRoot: ctx.repoRoot,
      ref: REF,
      title: TITLE,
      type: TYPE,
      body: BODY,
      summary: SUMMARY,
      manifestPath: ctx.manifestPath,
      sessionUlid: SESSION_ULID,
      worktree: false,
      howToTestWalkthrough: FIXTURE_WALKTHROUGH,
      execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
    });

    // Confirm successful result
    expect(result.ok).toBe(true);
    expect(result.prUrl).toBe(targetPrUrl);

    // dev-outcome.json must exist in the per-ref session directory
    // (story native:01KT3YDHM10FPQ77N22BTJP9AF).
    const devOutcomePath = devOutcomeFilePath(ctx.repoRoot, SESSION_ULID, REF);
    const raw = await fs.readFile(devOutcomePath, "utf8");
    const parsed = JSON.parse(raw) as {
      prUrl: string;
      prNumber: number;
      branch: string;
      commitSha: string;
    };

    expect(parsed.prUrl).toBe(targetPrUrl);
    expect(parsed.prNumber).toBe(42);
    expect(parsed.branch).toBe(result.branch);
    expect(parsed.commitSha).toBe(result.commitSha);
  });

  it("(5a) prNumber is parsed correctly from PR URL with multi-digit number", async () => {
    const targetPrUrl = "https://github.com/owner/repo/pull/123";
    const spy = makeStubExeca({ ghStdout: targetPrUrl });

    await runDevTerminalAction({
      targetRepoRoot: ctx.repoRoot,
      ref: REF,
      title: TITLE,
      type: TYPE,
      body: BODY,
      summary: SUMMARY,
      manifestPath: ctx.manifestPath,
      sessionUlid: SESSION_ULID,
      worktree: false,
      howToTestWalkthrough: FIXTURE_WALKTHROUGH,
      execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
    });

    const devOutcomePath = devOutcomeFilePath(ctx.repoRoot, SESSION_ULID, REF);
    const raw = await fs.readFile(devOutcomePath, "utf8");
    const parsed = JSON.parse(raw) as { prNumber: number };
    expect(parsed.prNumber).toBe(123);
  });

  it("(5a) GhPrCreateFailedError raised when PR URL has no /pull/<n> segment", async () => {
    // A URL that passes startsWith("https://github.com/") but has no /pull/<n>
    const malformedUrl = "https://github.com/owner/repo/issues/42";
    const spy = makeStubExeca({ ghStdout: malformedUrl });

    await expect(
      runDevTerminalAction({
        targetRepoRoot: ctx.repoRoot,
        ref: REF,
        title: TITLE,
        type: TYPE,
        body: BODY,
        summary: SUMMARY,
        manifestPath: ctx.manifestPath,
        sessionUlid: SESSION_ULID,
        worktree: false,
        howToTestWalkthrough: FIXTURE_WALKTHROUGH,
        execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
      }),
    ).rejects.toBeInstanceOf(GhPrCreateFailedError);
  });
});

// ---------------------------------------------------------------------------
// Story native:01KT40THFTS10F9PT37KCW9PF4 — pre-PR sync gate
// (fetch + rebase onto latest origin/main before opening the PR)
// ---------------------------------------------------------------------------

/** Pull the `subcmd` from a recorded git call: args = ["-C", root, subcmd, ...]. */
function gitCalls(spy: ReturnType<typeof vi.fn>): { subcmd: string; args: string[] }[] {
  return (spy.mock.calls as [string, string[]][])
    .filter(([cmd]) => cmd === "git")
    .map(([, args]) => ({ subcmd: args[2]!, args }));
}

describe("runDevTerminalAction — pre-PR sync gate (AC1: origin/main advanced)", () => {
  it("(AC1) fetches and rebases onto origin/<base> BEFORE the build/test gates, then opens the PR", async () => {
    // The stub returns success for fetch + rebase (origin/main has advanced but
    // the story integrates cleanly), so the PR opens against the integrated tree.
    const spy = makeStubExeca({ ghStdout: FAKE_PR_URL });

    const result = await runDevTerminalAction({
      targetRepoRoot: ctx.repoRoot,
      ref: REF,
      title: TITLE,
      type: TYPE,
      body: BODY,
      summary: SUMMARY,
      manifestPath: ctx.manifestPath,
      sessionUlid: SESSION_ULID,
      worktree: false,
      howToTestWalkthrough: FIXTURE_WALKTHROUGH,
      execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
    });

    expect(result.ok).toBe(true);
    expect(result.prUrl).toBe(FAKE_PR_URL);

    // fetch origin and rebase origin/main were both invoked.
    const calls = gitCalls(spy);
    const fetchCall = calls.find((c) => c.subcmd === "fetch");
    const rebaseCall = calls.find(
      (c) => c.subcmd === "rebase" && c.args[3] !== "--abort",
    );
    expect(fetchCall, "git fetch origin should run").toBeDefined();
    expect(fetchCall!.args).toEqual([
      "-C", ctx.repoRoot, "fetch", "origin",
    ]);
    expect(rebaseCall, "git rebase origin/<base> should run").toBeDefined();
    expect(rebaseCall!.args).toEqual([
      "-C", ctx.repoRoot, "rebase", "origin/main",
    ]);

    // No abort on the clean path.
    expect(
      calls.some((c) => c.subcmd === "rebase" && c.args[3] === "--abort"),
    ).toBe(false);

    // Ordering: fetch + rebase run BEFORE the build (pnpm) and test gates and
    // BEFORE the push and `gh pr create` — the build/test gates validate the
    // rebase-integrated tree, the exact state that lands on main.
    const order = (spy.mock.calls as [string, string[]][])
      .map(([cmd, args]): string | null => {
        if (cmd === "git" && args[2] === "fetch") return "fetch";
        if (cmd === "git" && args[2] === "rebase" && args[3] !== "--abort") return "rebase";
        if (cmd === "pnpm" && args.some((a) => /test|vitest/.test(a))) return "test-gate";
        if (cmd === "pnpm") return "build-gate";
        if (cmd === "git" && args[2] === "push") return "push";
        if (cmd === "gh") return "gh-pr-create";
        return null;
      })
      .filter((s): s is string => s !== null);

    const idxFetch = order.indexOf("fetch");
    const idxRebase = order.indexOf("rebase");
    const idxBuild = order.indexOf("build-gate");
    const idxTest = order.indexOf("test-gate");
    const idxPush = order.indexOf("push");
    const idxGh = order.indexOf("gh-pr-create");

    expect(idxFetch).toBeGreaterThanOrEqual(0);
    expect(idxRebase).toBeGreaterThan(idxFetch);
    expect(idxBuild).toBeGreaterThan(idxRebase);
    expect(idxTest).toBeGreaterThan(idxBuild);
    expect(idxPush).toBeGreaterThan(idxTest);
    expect(idxGh).toBeGreaterThan(idxPush);
  });
});

describe("runDevTerminalAction — pre-PR sync gate (AC2: genuine conflict)", () => {
  const CONFLICT_OUTPUT =
    "Auto-merging src/registry.ts\n" +
    "CONFLICT (content): Merge conflict in src/registry.ts\n" +
    "error: could not apply 1a2b3c4... feat: register new tool\n";

  it("(AC2) aborts the rebase, never pushes or opens a PR, and carries the readable conflict reason", async () => {
    const spy = makeStubExeca({ rebaseConflictStdout: CONFLICT_OUTPUT });

    let caught: unknown;
    try {
      await runDevTerminalAction({
        targetRepoRoot: ctx.repoRoot,
        ref: REF,
        title: TITLE,
        type: TYPE,
        body: BODY,
        summary: SUMMARY,
        manifestPath: ctx.manifestPath,
        sessionUlid: SESSION_ULID,
        worktree: false,
        execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
      });
      expect.fail("should have thrown RebaseConflictError");
    } catch (err) {
      caught = err;
    }

    // The returned outcome is a RebaseConflictError carrying the readable reason
    // naming the clashing path (the parked reason surfaced to the operator).
    expect(caught).toBeInstanceOf(RebaseConflictError);
    const e = caught as RebaseConflictError;
    expect(e.conflictingPaths).toContain("src/registry.ts");
    expect(e.reason).toContain("src/registry.ts");
    expect(e.message).toContain("src/registry.ts");
    expect(e.message).toContain("NO pull request was opened");

    const calls = gitCalls(spy);

    // `git rebase --abort` ran to leave the working tree clean.
    expect(
      calls.some((c) => c.subcmd === "rebase" && c.args[3] === "--abort"),
      "git rebase --abort should run after a genuine conflict",
    ).toBe(true);

    // push was NEVER invoked — the conflicting branch never reaches origin.
    expect(calls.some((c) => c.subcmd === "push")).toBe(false);

    // gh pr create was NEVER invoked — no doomed PR is opened.
    expect((spy.mock.calls as [string, string[]][]).some(([cmd]) => cmd === "gh")).toBe(false);

    // The build/test gates never ran either — the conflict aborts before them.
    expect((spy.mock.calls as [string, string[]][]).some(([cmd]) => cmd === "pnpm")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Story native:01KT47430Q4C73K5E3ZECBSE5R — pre-PR leak gate (AC2)
//
// When a builder's edits have reached the shared master copy (the orchestrating
// root checkout is dirty), `runDevTerminalAction` MUST stop BEFORE creating the
// PR and throw `PrePrLeakDetectedError`. No `gh pr create` is ever called.
//
// Setup mirrors concurrent-runs-isolation.test.ts: a real bare origin, a work
// checkout, a materialised worktree for the dev. The "leak" is simulated by
// writing directly to the ORCHESTRATING ROOT (not the worktree), which is exactly
// what a builder using an absolute shared-copy path would do.
// ---------------------------------------------------------------------------

interface WorktreeTestContext {
  repoRoot: string;
  originDir: string;
  tmpDir: string;
  manifestPath: string;
  specPath: string;
}

async function setupWorktreeRepo(): Promise<WorktreeTestContext> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "leak-gate-"));
  const repoRoot = path.join(tmpDir, "work");
  const originDir = path.join(tmpDir, "origin.git");
  await fs.mkdir(repoRoot, { recursive: true });

  // Bare origin + work clone.
  await realExeca("git", ["init", "--bare", "-b", "main", originDir]);
  await realExeca("git", ["-C", repoRoot, "init", "-b", "main"]);
  await realExeca("git", ["-C", repoRoot, "config", "user.email", "t@t.com"]);
  await realExeca("git", ["-C", repoRoot, "config", "user.name", "Test User"]);
  await realExeca("git", ["-C", repoRoot, "remote", "add", "origin", originDir]);

  // Initial commit so HEAD exists and worktrees can be cut.
  const srcDir = path.join(repoRoot, "src");
  await fs.mkdir(srcDir, { recursive: true });
  await atomicWriteFile(path.join(srcDir, "index.ts"), "export const x = 1;\n");
  // Flow-shaped build home so the structural resolver lands on plugins/flow +
  // pnpm (Story native:01KVTB3Z), committed into the base so the cut worktree
  // carries it (the dev gate resolves against the worktree).
  await seedFlowShapedBuildHome(repoRoot);
  await realExeca("git", ["-C", repoRoot, "add", "."]);
  await realExeca("git", ["-C", repoRoot, "commit", "-m", "chore: initial commit"]);
  await realExeca("git", ["-C", repoRoot, "push", "-u", "origin", "main"]);

  // Story spec + manifest under the work checkout.
  const specRelPath = `_bmad-output/implementation-artifacts/${REF}.md`;
  const specDir = path.join(repoRoot, "_bmad-output", "implementation-artifacts");
  await fs.mkdir(specDir, { recursive: true });
  const specPath = path.join(specDir, `${REF}.md`);
  await atomicWriteFile(specPath, FIXTURE_SPEC);

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
      source_hash: "a".repeat(64),
      depends_on: [],
      acceptance_criteria: [{ text: "AC1 text", kind: "unit" }],
      title: TITLE,
      narrative: "As a dev, I want a terminal action.",
      withdrawn: false,
      claimed_by: SESSION_ULID,
    }),
  );

  // Commit the spec + manifest so the worktree base is clean.
  await realExeca("git", ["-C", repoRoot, "add", "."]);
  await realExeca("git", ["-C", repoRoot, "commit", "-m", "chore: scaffold spec"]);
  await realExeca("git", ["-C", repoRoot, "push", "origin", "main"]);

  return { repoRoot, originDir, tmpDir, manifestPath, specPath };
}

/**
 * execaImpl for leak gate tests: real git everywhere; push and `gh` succeed;
 * `pnpm` (build + test gates) passes. We never actually push or open a PR in
 * these tests — the leak gate throws before reaching those calls.
 */
function makeLeakGateStubExeca(opts: {
  ghStdout?: string;
} = {}): ReturnType<typeof vi.fn> {
  return vi.fn(
    async (
      cmd: string,
      args: readonly string[],
      options?: Record<string, unknown>,
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
      if (cmd === "pnpm") {
        return { stdout: "ok", stderr: "", exitCode: 0 };
      }
      if (cmd === "gh") {
        return { stdout: opts.ghStdout ?? FAKE_PR_URL, stderr: "", exitCode: 0 };
      }
      // Real git for everything else (branch creation, commit, etc.).
      const result = await realExeca(cmd, args as string[], { ...options, reject: false });
      return {
        stdout: typeof result.stdout === "string" ? result.stdout : "",
        stderr: typeof result.stderr === "string" ? result.stderr : "",
        exitCode: typeof result.exitCode === "number" ? result.exitCode : 0,
      };
    },
  );
}

// ---------------------------------------------------------------------------
// Story native:01KTAP1N6DEF181646EW3RJH8W — friction telemetry AC3
// pre-PR gate errors (build, test, rebase-conflict) → exactly one
// agent.friction 'forced-fallback' event per gate failure, error unchanged.
// ---------------------------------------------------------------------------

describe("runDevTerminalAction — friction telemetry AC3: forced-fallback on gate failures", () => {
  it("AC3: build gate failure → exactly one forced-fallback friction event, PrePrBuildFailedError re-raised", async () => {
    const recordFrictionMod = await import("../record-agent-friction.js");
    const frictionSpy = vi.spyOn(recordFrictionMod, "recordAgentFriction");

    const spy = makeStubExeca({ buildShouldFail: true });

    try {
      await expect(
        runDevTerminalAction({
          targetRepoRoot: ctx.repoRoot,
          ref: REF,
          title: TITLE,
          type: TYPE,
          body: BODY,
          summary: SUMMARY,
          manifestPath: ctx.manifestPath,
          sessionUlid: SESSION_ULID,
          worktree: false,
          execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
        }),
      ).rejects.toThrow(); // PrePrBuildFailedError

      // Exactly one forced-fallback friction event.
      const forcedCalls = frictionSpy.mock.calls.filter(
        (c) => c[0]?.kind === "forced-fallback",
      );
      expect(forcedCalls).toHaveLength(1);
      const call = forcedCalls[0]![0]!;
      expect(call.kind).toBe("forced-fallback");
      expect(call.role).toBe("generalist-dev");
      expect(call.session_id).toBe(SESSION_ULID);
      expect(call.story_id).toBe(REF);
    } finally {
      frictionSpy.mockRestore();
    }
  });

  it("AC3: test gate failure → exactly one forced-fallback friction event, PrePrTestFailedError re-raised", async () => {
    const recordFrictionMod = await import("../record-agent-friction.js");
    const frictionSpy = vi.spyOn(recordFrictionMod, "recordAgentFriction");

    const spy = makeStubExeca({ testShouldFail: true });

    try {
      await expect(
        runDevTerminalAction({
          targetRepoRoot: ctx.repoRoot,
          ref: REF,
          title: TITLE,
          type: TYPE,
          body: BODY,
          summary: SUMMARY,
          manifestPath: ctx.manifestPath,
          sessionUlid: SESSION_ULID,
          worktree: false,
          execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
        }),
      ).rejects.toThrow(); // PrePrTestFailedError

      // Exactly one forced-fallback friction event.
      const forcedCalls = frictionSpy.mock.calls.filter(
        (c) => c[0]?.kind === "forced-fallback",
      );
      expect(forcedCalls).toHaveLength(1);
      const call = forcedCalls[0]![0]!;
      expect(call.kind).toBe("forced-fallback");
      expect(call.role).toBe("generalist-dev");
      expect(call.session_id).toBe(SESSION_ULID);
      expect(call.story_id).toBe(REF);
    } finally {
      frictionSpy.mockRestore();
    }
  });

  it("AC3: rebase conflict → exactly one forced-fallback friction event, RebaseConflictError re-raised", async () => {
    const recordFrictionMod = await import("../record-agent-friction.js");
    const frictionSpy = vi.spyOn(recordFrictionMod, "recordAgentFriction");

    const CONFLICT_OUTPUT =
      "CONFLICT (content): Merge conflict in src/index.ts\n" +
      "error: could not apply 1a2b3c4... feat: something\n";
    const spy = makeStubExeca({ rebaseConflictStdout: CONFLICT_OUTPUT });

    try {
      await expect(
        runDevTerminalAction({
          targetRepoRoot: ctx.repoRoot,
          ref: REF,
          title: TITLE,
          type: TYPE,
          body: BODY,
          summary: SUMMARY,
          manifestPath: ctx.manifestPath,
          sessionUlid: SESSION_ULID,
          worktree: false,
          execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
        }),
      ).rejects.toThrow(); // RebaseConflictError

      // Exactly one forced-fallback friction event.
      const forcedCalls = frictionSpy.mock.calls.filter(
        (c) => c[0]?.kind === "forced-fallback",
      );
      expect(forcedCalls).toHaveLength(1);
      const call = forcedCalls[0]![0]!;
      expect(call.kind).toBe("forced-fallback");
      expect(call.role).toBe("generalist-dev");
      expect(call.session_id).toBe(SESSION_ULID);
      expect(call.story_id).toBe(REF);
    } finally {
      frictionSpy.mockRestore();
    }
  });

  it("AC3: no friction emitted on the happy path (all gates pass)", async () => {
    const recordFrictionMod = await import("../record-agent-friction.js");
    const frictionSpy = vi.spyOn(recordFrictionMod, "recordAgentFriction");

    const spy = makeStubExeca({ ghStdout: FAKE_PR_URL });

    try {
      const result = await runDevTerminalAction({
        targetRepoRoot: ctx.repoRoot,
        ref: REF,
        title: TITLE,
        type: TYPE,
        body: BODY,
        summary: SUMMARY,
        manifestPath: ctx.manifestPath,
        sessionUlid: SESSION_ULID,
        worktree: false,
        howToTestWalkthrough: FIXTURE_WALKTHROUGH,
        execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
      });

      expect(result.ok).toBe(true);

      // No forced-fallback friction events on the happy path.
      const forcedCalls = frictionSpy.mock.calls.filter(
        (c) => c[0]?.kind === "forced-fallback",
      );
      expect(forcedCalls).toHaveLength(0);
    } finally {
      frictionSpy.mockRestore();
    }
  });

  it("AC3: build gate error propagates unchanged even if emitFriction throws internally", async () => {
    const recordFrictionMod = await import("../record-agent-friction.js");
    const frictionSpy = vi.spyOn(recordFrictionMod, "recordAgentFriction").mockRejectedValue(
      new Error("telemetry write failed"),
    );

    const spy = makeStubExeca({ buildShouldFail: true });

    try {
      // Must throw the original PrePrBuildFailedError, not the friction error.
      const { PrePrBuildFailedError: PrePrBuildFailedErrorClass } = await import("../../errors.js");
      await expect(
        runDevTerminalAction({
          targetRepoRoot: ctx.repoRoot,
          ref: REF,
          title: TITLE,
          type: TYPE,
          body: BODY,
          summary: SUMMARY,
          manifestPath: ctx.manifestPath,
          sessionUlid: SESSION_ULID,
          worktree: false,
          execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
        }),
      ).rejects.toBeInstanceOf(PrePrBuildFailedErrorClass);
    } finally {
      frictionSpy.mockRestore();
    }
  });
});

describe("runDevTerminalAction — pre-PR leak gate (Story native:01KT47430Q4C73K5E3ZECBSE5R AC2)", () => {
  let wtCtx: WorktreeTestContext;

  beforeEach(async () => {
    wtCtx = await setupWorktreeRepo();
  });

  afterEach(async () => {
    await fs.rm(wtCtx.tmpDir, { recursive: true, force: true });
  });

  it("AC2: stops BEFORE pr-create and throws PrePrLeakDetectedError when the shared master is dirtied", async () => {
    // Materialise the dev's worktree.
    const wt = await materialiseDevStoryWorktree({
      targetRepoRoot: wtCtx.repoRoot,
      sessionUlid: SESSION_ULID,
      ref: REF,
      base: "main",
    });

    // The file path the builder will write — same relative path in both locations.
    // A builder using an absolute shared-copy path would write to both.
    const leakedRelPath = "src/new-feature.ts";

    try {
      // The dev writes its change INSIDE the worktree (its own editing surface).
      const worktreeFile = path.join(wt.worktreePath, leakedRelPath);
      await fs.mkdir(path.join(wt.worktreePath, "src"), { recursive: true });
      await atomicWriteFile(worktreeFile, "export const y = 2;\n");

      // SIMULATE a leak: the SAME relative path is ALSO written to the SHARED ROOT
      // checkout. This is exactly what a builder using an absolute shared-copy path
      // would produce — the same file appears in both the worktree and the root.
      const leakedFile = path.join(wtCtx.repoRoot, leakedRelPath);
      await atomicWriteFile(leakedFile, "leaked content — same path as worktree file\n");

      const spy = makeLeakGateStubExeca();

      let caught: unknown;
      try {
        await runDevTerminalAction({
          targetRepoRoot: wt.worktreePath,
          ref: REF,
          title: TITLE,
          type: TYPE,
          body: BODY,
          summary: SUMMARY,
          manifestPath: wtCtx.manifestPath,
          sessionUlid: SESSION_ULID,
          base: "main",
          // worktree: true (default)
          execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
        });
        expect.fail("should have thrown PrePrLeakDetectedError");
      } catch (err) {
        caught = err;
      }

      // The gate must throw PrePrLeakDetectedError.
      expect(caught).toBeInstanceOf(PrePrLeakDetectedError);
      const e = caught as PrePrLeakDetectedError;
      // The leaked path must be named (same relative path the builder committed).
      expect(e.leakedPaths.length).toBeGreaterThan(0);
      expect(e.leakedPaths.some((p) => p.includes("new-feature.ts"))).toBe(true);
      // The shared root path must be named.
      expect(e.sharedRootPath).toBeTruthy();
      // The message must be readable and name the leaked path.
      expect(e.message).toContain("NO pull request was opened");
      expect(e.message).toContain("new-feature.ts");

      // gh pr create was NEVER called — no PR was opened.
      expect(
        (spy.mock.calls as [string, string[]][]).some(([cmd]) => cmd === "gh"),
        "gh pr create must never be called when the leak gate fires",
      ).toBe(false);

      // push was NEVER called — the leaking branch never reaches origin.
      const gitPushCalled = (spy.mock.calls as [string, string[]][]).some(
        ([cmd, args]) => cmd === "git" && Array.isArray(args) && args[2] === "push",
      );
      expect(gitPushCalled, "git push must never be called when the leak gate fires").toBe(false);

      // Clean up leaked file so afterEach teardown does not fail.
      await fs.rm(leakedFile, { force: true });
    } finally {
      await wt.cleanup();
    }
  });

  it("AC2 (clean path): does NOT throw when the shared master is clean and the PR opens normally", async () => {
    // Materialise the dev's worktree.
    const wt = await materialiseDevStoryWorktree({
      targetRepoRoot: wtCtx.repoRoot,
      sessionUlid: SESSION_ULID,
      ref: REF,
      base: "main",
    });

    try {
      // The dev writes its change INSIDE the worktree only (no leak).
      const worktreeFile = path.join(wt.worktreePath, "src", "new-feature.ts");
      await fs.mkdir(path.join(wt.worktreePath, "src"), { recursive: true });
      await atomicWriteFile(worktreeFile, "export const y = 2;\n");

      const spy = makeLeakGateStubExeca({ ghStdout: FAKE_PR_URL });

      const result = await runDevTerminalAction({
        targetRepoRoot: wt.worktreePath,
        ref: REF,
        title: TITLE,
        type: TYPE,
        body: BODY,
        summary: SUMMARY,
        manifestPath: wtCtx.manifestPath,
        sessionUlid: SESSION_ULID,
        base: "main",
        howToTestWalkthrough: FIXTURE_WALKTHROUGH,
        // worktree: true (default)
        execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
      });

      // Clean path: the tool succeeded and a PR was opened.
      expect(result.ok).toBe(true);
      expect(result.prUrl).toBe(FAKE_PR_URL);
    } finally {
      await wt.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Story native:01KTN5E6T75XKDX8A0SGBVPRYS — time budget (AC3)
//
// AC3: No per-run override → DEFAULT_BUILD_TEST_TIMEOUT_MS applies.
//       Per-run override → the override is honoured instead.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Story native:01KTSR1YKQFFFCY8KB5B0148M2 — branch reuse on crash retry (AC2)
//
// When a story's work branch already exists (created on a prior attempt that
// crashed before completing), runDevTerminalAction must pick up the existing
// branch and proceed to commit/push/PR instead of dying on a
// "branch already exists" error.
// ---------------------------------------------------------------------------

describe("runDevTerminalAction — branch reuse on crash retry (Story native:01KTSR1YKQFFFCY8KB5B0148M2 AC2)", () => {
  it("AC2: resumes on the existing branch and opens the PR when the branch was already created", async () => {
    // Simulate: the branch was created on the first attempt but the run crashed
    // before pushing. The `rev-parse` probe returns success (branch exists), so
    // gitCreateBranch falls through to plain `checkout` instead of `checkout -b`.
    const branchName = "story/" + REF.toLowerCase().replace(/[^a-z0-9]/g, "-");

    // Pre-create the branch in the real local repo so the existence probe finds it.
    await realExeca("git", ["-C", ctx.repoRoot, "checkout", "-b", branchName]);
    // Switch back to the base branch so runDevTerminalAction can check out the
    // story branch again as if resuming from the start.
    await realExeca("git", ["-C", ctx.repoRoot, "checkout", "-"]);

    const spy = makeStubExeca({ ghStdout: FAKE_PR_URL });

    // This must succeed — the "already exists" path reuses the branch.
    const result = await runDevTerminalAction({
      targetRepoRoot: ctx.repoRoot,
      ref: REF,
      title: TITLE,
      type: TYPE,
      body: BODY,
      summary: SUMMARY,
      manifestPath: ctx.manifestPath,
      sessionUlid: SESSION_ULID,
      worktree: false,
      howToTestWalkthrough: FIXTURE_WALKTHROUGH,
      execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
    });

    expect(result.ok).toBe(true);
    expect(result.prUrl).toBe(FAKE_PR_URL);
    expect(result.branch).toMatch(/^story\//);

    // Verify the final working branch matches the pre-existing story branch.
    const branchResult = await realExeca(
      "git",
      ["-C", ctx.repoRoot, "branch", "--show-current"],
      { reject: false },
    );
    expect(branchResult.stdout.trim()).toBe(result.branch);
  });

  it("AC2: branch-reuse path: runDevTerminalAction succeeds when starting on a pre-existing branch", async () => {
    // Determine the branch name that runDevTerminalAction will compute for this
    // ref+title pair (mirrors buildBranchSlug logic so the pre-created branch
    // matches exactly what the impl will look for).
    const { buildBranchSlug } = await import("../../lib/pr-body.js");
    const branchForRef = buildBranchSlug({ ref: REF, title: TITLE });

    // Pre-create the branch (simulating a first attempt that crashed after
    // branch creation but before the rest of the run), then switch back to
    // the base branch so the retry starts from main.
    await realExeca("git", ["-C", ctx.repoRoot, "checkout", "-b", branchForRef]);
    const { promises: fs2 } = await import("node:fs");
    await fs2.writeFile(
      path.join(ctx.repoRoot, "src", "crash-retry-file.ts"),
      "export const z = 3;\n",
    );
    await realExeca("git", ["-C", ctx.repoRoot, "checkout", "-"]);

    // This run must not throw even though the branch already exists.
    const spy = makeStubExeca({ ghStdout: FAKE_PR_URL });
    const result = await runDevTerminalAction({
      targetRepoRoot: ctx.repoRoot,
      ref: REF,
      title: TITLE,
      type: TYPE,
      body: BODY,
      summary: SUMMARY,
      manifestPath: ctx.manifestPath,
      sessionUlid: SESSION_ULID,
      worktree: false,
      howToTestWalkthrough: FIXTURE_WALKTHROUGH,
      execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
    });

    expect(result.ok).toBe(true);
    expect(result.prUrl).toBe(FAKE_PR_URL);
    // The PR branch must be the same story branch — no duplicate was created.
    expect(result.branch).toBe(branchForRef);
  });
});

describe("runDevTerminalAction — time budget (Story native:01KTN5E6T75XKDX8A0SGBVPRYS AC3)", () => {
  it("AC3a: applies the default budget when no override is supplied — a timed-out build is reported as a build failure", async () => {
    // A timed-out build must surface PrePrBuildFailedError with timedOut:true,
    // regardless of whether an override was supplied. When no override is given,
    // the default budget is used internally.
    const spy = makeStubExeca({ buildTimedOut: true });

    let caught: unknown;
    try {
      await runDevTerminalAction({
        targetRepoRoot: ctx.repoRoot,
        ref: REF,
        title: TITLE,
        type: TYPE,
        body: BODY,
        summary: SUMMARY,
        manifestPath: ctx.manifestPath,
        sessionUlid: SESSION_ULID,
        worktree: false,
        // No buildTestTimeoutMs — the default applies.
        execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PrePrBuildFailedError);
    const e = caught as PrePrBuildFailedError;
    expect(e.timedOut).toBe(true);
    // timeoutMs should reflect the default budget.
    expect(e.timeoutMs).toBe(DEFAULT_BUILD_TEST_TIMEOUT_MS);
  });

  it("AC3b: honours a per-run override — the override budget is reflected in the error", async () => {
    const CUSTOM_TIMEOUT = 30_000; // 30 s override
    const spy = makeStubExeca({ buildTimedOut: true });

    let caught: unknown;
    try {
      await runDevTerminalAction({
        targetRepoRoot: ctx.repoRoot,
        ref: REF,
        title: TITLE,
        type: TYPE,
        body: BODY,
        summary: SUMMARY,
        manifestPath: ctx.manifestPath,
        sessionUlid: SESSION_ULID,
        worktree: false,
        buildTestTimeoutMs: CUSTOM_TIMEOUT,
        execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PrePrBuildFailedError);
    const e = caught as PrePrBuildFailedError;
    expect(e.timedOut).toBe(true);
    // The override budget is reflected in the error so the operator can see
    // which budget was in effect when the timeout fired.
    expect(e.timeoutMs).toBe(CUSTOM_TIMEOUT);
    // The message names the override budget in seconds.
    expect(e.message).toContain("30s");
  });

  it("AC3c: a within-budget run (no timeout) is not affected by the budget being set", async () => {
    // Even when a budget is configured, a healthy run that completes before the
    // budget is completely unaffected — the PR opens normally.
    const spy = makeStubExeca({ ghStdout: FAKE_PR_URL });

    const result = await runDevTerminalAction({
      targetRepoRoot: ctx.repoRoot,
      ref: REF,
      title: TITLE,
      type: TYPE,
      body: BODY,
      summary: SUMMARY,
      manifestPath: ctx.manifestPath,
      sessionUlid: SESSION_ULID,
      worktree: false,
      buildTestTimeoutMs: 60_000,
      howToTestWalkthrough: FIXTURE_WALKTHROUGH,
      execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
    });

    expect(result.ok).toBe(true);
    expect(result.prUrl).toBe(FAKE_PR_URL);
  });
});

// ---------------------------------------------------------------------------
// Story native:01KVAEEF3V59H7P4V3R1HBXNC0 — developer-authored walk-through
//
// AC1: A normally-opened PR's how-to-test section contains a real,
//      feature-specific walk-through (not the fallback line).
// AC2: An absent walk-through is caught at the seam (MissingWalkthroughError).
// ---------------------------------------------------------------------------

describe("runDevTerminalAction — developer walk-through in PR body (Story native:01KVAEEF3V59H7P4V3R1HBXNC0 AC1)", () => {
  it("AC1: PR body 'How to check it yourself' section contains the developer-supplied walk-through, not the fallback", async () => {
    // A normally-opened PR: developer supplies howToTestWalkthrough.
    // The how-to-test section must contain the supplied text; the fallback line
    // must NOT appear.
    const spy = makeStubExeca({ ghStdout: FAKE_PR_URL });

    const result = await runDevTerminalAction({
      targetRepoRoot: ctx.repoRoot,
      ref: REF,
      title: TITLE,
      type: TYPE,
      body: BODY,
      summary: SUMMARY,
      manifestPath: ctx.manifestPath,
      sessionUlid: SESSION_ULID,
      worktree: false,
      howToTestWalkthrough: FIXTURE_WALKTHROUGH,
      execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
    });

    expect(result.ok).toBe(true);

    // Extract the PR body from the stubbed gh call.
    const ghCall = (spy.mock.calls as [string, string[]][]).find(
      ([cmd]) => cmd === "gh",
    );
    expect(ghCall).toBeDefined();
    const ghArgs = ghCall![1];
    const bodyIdx = ghArgs.indexOf("--body");
    const bodyArg = ghArgs[bodyIdx + 1]!;

    // The how-to-test section must contain the developer-supplied walk-through text.
    expect(bodyArg).toContain("How to check it yourself");
    expect(bodyArg).toContain(FIXTURE_WALKTHROUGH);

    // The honest fallback line must NOT appear.
    expect(bodyArg).not.toContain(FALLBACK_LINE);
  });

  it("AC1: PR body walk-through is feature-specific — a distinct walk-through is preserved verbatim", async () => {
    // Different walks for different features must each appear verbatim.
    const distinctWalkthrough =
      "1. Open the app\n2. Navigate to Settings\n3. Click 'Save'\n4. Observe the confirmation toast.";

    const spy = makeStubExeca({ ghStdout: FAKE_PR_URL });

    await runDevTerminalAction({
      targetRepoRoot: ctx.repoRoot,
      ref: REF,
      title: TITLE,
      type: TYPE,
      body: BODY,
      summary: SUMMARY,
      manifestPath: ctx.manifestPath,
      sessionUlid: SESSION_ULID,
      worktree: false,
      howToTestWalkthrough: distinctWalkthrough,
      execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
    });

    const ghCall = (spy.mock.calls as [string, string[]][]).find(
      ([cmd]) => cmd === "gh",
    );
    const ghArgs = ghCall![1];
    const bodyIdx = ghArgs.indexOf("--body");
    const bodyArg = ghArgs[bodyIdx + 1]!;

    // Walk-through is rendered verbatim.
    expect(bodyArg).toContain(distinctWalkthrough);
    expect(bodyArg).not.toContain(FALLBACK_LINE);
  });
});

describe("runDevTerminalAction — absent walk-through caught at seam (Story native:01KVAEEF3V59H7P4V3R1HBXNC0 AC2)", () => {
  it("AC2: absent howToTestWalkthrough throws MissingWalkthroughError BEFORE push and gh pr create", async () => {
    // No walk-through supplied — the seam must catch the absence.
    const spy = makeStubExeca({ ghStdout: FAKE_PR_URL });

    let caught: unknown;
    try {
      await runDevTerminalAction({
        targetRepoRoot: ctx.repoRoot,
        ref: REF,
        title: TITLE,
        type: TYPE,
        body: BODY,
        summary: SUMMARY,
        manifestPath: ctx.manifestPath,
        sessionUlid: SESSION_ULID,
        worktree: false,
        // howToTestWalkthrough intentionally absent
        execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
      });
      expect.fail("should have thrown MissingWalkthroughError");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MissingWalkthroughError);
    const e = caught as MissingWalkthroughError;
    expect(e.ref).toBe(REF);
    expect(e.message).toContain("NO pull request was opened");

    // gh pr create must NEVER be called — no PR opened.
    expect(
      (spy.mock.calls as [string, string[]][]).some(([cmd]) => cmd === "gh"),
      "gh pr create must not be called when walk-through is absent",
    ).toBe(false);

    // push must NEVER be called — the branch never reaches origin.
    const gitPushCalled = (spy.mock.calls as [string, string[]][]).some(
      ([cmd, args]) => cmd === "git" && Array.isArray(args) && args[2] === "push",
    );
    expect(gitPushCalled, "git push must not be called when walk-through is absent").toBe(false);
  });

  it("AC2: blank (whitespace-only) howToTestWalkthrough throws MissingWalkthroughError", async () => {
    const spy = makeStubExeca({ ghStdout: FAKE_PR_URL });

    await expect(
      runDevTerminalAction({
        targetRepoRoot: ctx.repoRoot,
        ref: REF,
        title: TITLE,
        type: TYPE,
        body: BODY,
        summary: SUMMARY,
        manifestPath: ctx.manifestPath,
        sessionUlid: SESSION_ULID,
        worktree: false,
        howToTestWalkthrough: "   \n  ",
        execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
      }),
    ).rejects.toBeInstanceOf(MissingWalkthroughError);
  });

  it("AC2: empty-string howToTestWalkthrough throws MissingWalkthroughError", async () => {
    const spy = makeStubExeca({ ghStdout: FAKE_PR_URL });

    await expect(
      runDevTerminalAction({
        targetRepoRoot: ctx.repoRoot,
        ref: REF,
        title: TITLE,
        type: TYPE,
        body: BODY,
        summary: SUMMARY,
        manifestPath: ctx.manifestPath,
        sessionUlid: SESSION_ULID,
        worktree: false,
        howToTestWalkthrough: "",
        execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
      }),
    ).rejects.toBeInstanceOf(MissingWalkthroughError);
  });

  it("AC2: a non-empty walk-through (even one word) passes the gate and opens the PR normally", async () => {
    const spy = makeStubExeca({ ghStdout: FAKE_PR_URL });

    const result = await runDevTerminalAction({
      targetRepoRoot: ctx.repoRoot,
      ref: REF,
      title: TITLE,
      type: TYPE,
      body: BODY,
      summary: SUMMARY,
      manifestPath: ctx.manifestPath,
      sessionUlid: SESSION_ULID,
      worktree: false,
      howToTestWalkthrough: "Run the app and observe the feature works.",
      execaImpl: spy as unknown as Parameters<typeof runDevTerminalAction>[0]["execaImpl"],
    });

    expect(result.ok).toBe(true);
    expect(result.prUrl).toBe(FAKE_PR_URL);
  });
});
