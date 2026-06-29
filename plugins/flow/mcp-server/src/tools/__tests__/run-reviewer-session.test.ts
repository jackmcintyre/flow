/**
 * Integration tests for `runReviewerSession` composite tool — Story 4.6 Task 9.
 *
 * Behavioural contract source:
 *   _bmad-output/implementation-artifacts/4-6-reviewer-subagent-read-sources-and-run-acs.md
 *
 * Fixture shape (spec §4a):
 *   <tmp>/.flow/config.yaml           — native adapter
 *   <tmp>/.flow/native-stories/<ULID>.md — spec with 3 ACs
 *     AC1: artifact: hello-a.txt
 *     AC2: vitest: fixture passing test
 *     AC3: no marker (manual-check-required)
 *   <tmp>/.flow/state/in-progress/<ref>.yaml — pre-claimed manifest
 *   <tmp>/docs/standards.md           — 4 criteria (matches standards-example.md)
 *   <tmp>/hello-a.txt                 — the artifact AC1 expects
 *   <tmp>/__tests__/fixture.test.ts   — a vitest test named "fixture passing test"
 *
 * Stubs:
 *   - `execaImpl` injected to avoid real `gh pr diff` network calls.
 *   - `__resetGhErrorMapCacheForTests` called in beforeEach.
 *
 * Story 4.6 Task 9.1–9.5.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs, mkdtempSync, rmSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runReviewerSession } from "../run-reviewer-session.js";
import { scanSources } from "../scan-sources.js";
import { resetBmadAdapter } from "../../adapters/bmad/index.js";
import {
  DuplicateStandardsCriterionIdError,
  GhRecoverableError,
} from "../../errors.js";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import {
  sanitiseRefForPathSegment,
} from "../../lib/read-reviewer-result-file.js";
import { __resetGhErrorMapCacheForTests } from "../../lib/gh-error-map.js";
import type { ReviewerResultFileShape } from "../run-reviewer-session.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ULID = "01J9P0K2N3MZX0YV4S5RTQ4REV";
const STORY_REF = `native:${ULID}`;
const SESSION_ULID = "01HZSESSION00000000REVIEWER";
const PR_NUMBER = 42;

// ---------------------------------------------------------------------------
// Fixture content
// ---------------------------------------------------------------------------

const FIXTURE_SPEC = `# Fixture Story 4.6

## Narrative

As a tester, I want to run the reviewer session so that I can verify ACs.

## Acceptance Criteria

**AC1:**
**Given** the artifact file should exist, **When** the reviewer checks the file system, **Then** the file is present at the expected path.
artifact: hello-a.txt

**AC2:**
**Given** the vitest test is defined, **When** the reviewer runs it, **Then** it passes.
vitest: fixture passing test

**AC3:**
**Given** this requires manual inspection, **When** the reviewer examines it, **Then** the operator must verify manually.
artifact: hello-a.txt

## Implementation Notes

None.

## Dependencies

`;

/**
 * Story 10.1: every native AC now carries a `vitest:`/`artifact:` verification
 * marker, so `parseNativeStory` (reached via `readSourceStory`) rejects a
 * markerless AC. The reviewer's *manual-check-required* classification is a
 * property of `extractAcsFromSpec` + `classifyAc`, NOT of `parseNativeStory`.
 * To exercise the manual-check path without writing an (now-invalid) markerless
 * native story to disk, stub `extractAcsFromSpec` to return markerless AC
 * bodies while the on-disk fixture stays a valid native story for the
 * `readSourceStory` read. Returns the spy so callers can assert/restore.
 */
async function stubExtractAcsManual(
  bodies: string[][],
): Promise<{ mockRestore: () => void }> {
  const extractAcsMod = await import("../../lib/extract-acs-from-spec.js");
  const entries = bodies.map((body, i) => ({
    index: i + 1,
    tag: null,
    firstLine: body[0] ?? "",
    body,
  }));
  return vi.spyOn(extractAcsMod, "extractAcsFromSpec").mockResolvedValue(entries);
}

const FIXTURE_STANDARDS = `version: "0.1.0"
updated: "2026-05-24"
criteria:
  - name: "story-aligned"
    what: "The PR's diff implements only what the story's acceptance criteria require."
    check: "Map each diff hunk to one or more ACs."
    anti_criterion: "Scope creep."
  - name: "tests-cover-acs"
    what: "Every AC has at least one assertion."
    check: "Inspect test files."
    anti_criterion: "Tests that only exercise happy paths."
  - name: "no-canonical-fs-writes-outside-mcp"
    what: "No code path writes to canonical-state paths outside MCP tools."
    check: "Grep for raw fs.writeFile."
    anti_criterion: "Direct fs.write to .flow/state."
  - name: "errors-are-typed"
    what: "Every named failure mode throws a DomainError subclass."
    check: "Inspect new throw sites."
    anti_criterion: "throw new Error(...) for known failures."
`;

const FIXTURE_VITEST_TEST = `import { describe, it, expect } from "vitest";

describe("fixture", () => {
  it("fixture passing test", () => {
    expect(true).toBe(true);
  });
});
`;

const FAKE_PR_DIFF = `diff --git a/hello-a.txt b/hello-a.txt
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/hello-a.txt
@@ -0,0 +1 @@
+hello
`;

// ---------------------------------------------------------------------------
// Fixture manifest shape
// ---------------------------------------------------------------------------

function makeManifestYaml(ref: string, sessionUlid: string): string {
  return [
    `ref: "${ref}"`,
    `status: in-progress`,
    `adapter: native`,
    `source_path: ".flow/native-stories/${ULID}.md"`,
    `source_hash: "${"a".repeat(64)}"`,
    `depends_on: []`,
    `acceptance_criteria:`,
    `  - text: "Given the artifact should exist."`,
    `    kind: integration`,
    `title: "Fixture Story 4.6"`,
    `narrative: "As a tester, I want to run the reviewer session."`,
    `withdrawn: false`,
    `claimed_by: "${sessionUlid}"`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Discriminating execaImpl stub — routes by command name.
//
// Story 5.26 update: runReviewerSession now calls materialisePrBranchWorktree,
// which invokes:
//   - `gh pr view --json headRefName,headRefOid` (needs JSON response)
//   - `git fetch origin <headRefName>` (needs exit 0)
//   - `git worktree add <path> <sha>` (needs to actually create the directory
//      so artifact checks against worktreePath work)
//   - `git worktree remove <path> --force` (cleanup — needs exit 0)
//
// The stub creates the worktree directory by symlinking tmpRoot content when
// git worktree add is intercepted. This keeps existing artifact-check
// assertions working without requiring a real git repo.
// ---------------------------------------------------------------------------

// Fake head ref returned to materialisePrBranchWorktree for non-error test paths.
const FAKE_HEAD_REF_NAME = "pr-head";
const FAKE_HEAD_REF_OID = "aabbccddaabbccddaabbccddaabbccddaabbccdd";

/**
 * Intercepts `git worktree add <worktreePath> <sha>` and creates the
 * worktreePath directory populated with the same files as `tmpRoot`.
 * This lets artifact checks against `worktreePath` find the same fixtures.
 */
async function createWorktreeFromTmpRoot(
  worktreePath: string,
  tmpRoot: string,
): Promise<void> {
  const { promises: fsP } = await import("node:fs");
  await fsP.mkdir(worktreePath, { recursive: true });
  // Copy top-level files from tmpRoot into worktreePath (not subdirectories —
  // the fixture only uses hello-a.txt at the top level for artifact checks).
  const entries = await fsP.readdir(tmpRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile()) {
      await fsP.copyFile(
        path.join(tmpRoot, entry.name),
        path.join(worktreePath, entry.name),
      );
    }
  }
}

interface DiscriminatingStubOpts {
  /** Overrides for `gh …` calls (default: returns FAKE_PR_DIFF for pr-diff, JSON for headRef). */
  gh?: { stdout?: string; stderr?: string; exitCode?: number; timedOut?: boolean };
  /** Overrides for `pnpm vitest …` calls (default: exitCode 0 = pass). */
  vitest?: { stdout?: string; stderr?: string; exitCode?: number; timedOut?: boolean };
  /**
   * Overrides for the worktree dependency install — `pnpm install` / `npm ci` /
   * `yarn install` / `bun install` (Story native:01KVWMCK). Default: exitCode 0
   * (install succeeds), so existing tests behave as before. Override exitCode to a
   * non-zero value to drive the unpreparable-environment setup-error path.
   */
  install?: { stdout?: string; stderr?: string; exitCode?: number; timedOut?: boolean };
  /**
   * The tmpRoot directory. When provided, `git worktree add` intercept
   * creates the worktree directory populated from tmpRoot. Required for
   * tests that perform artifact checks.
   */
  tmpRoot?: string;
}

function makeDiscriminatingStub(opts: DiscriminatingStubOpts = {}) {
  const stub = vi.fn().mockImplementation(
    async (cmd: string, args: string[], _cmdOpts?: unknown) => {
      // Worktree dependency install (Story native:01KVWMCK): pnpm install /
      // npm ci / yarn install / bun install. Intercepted BEFORE the per-manager
      // branches so a `vitest.exitCode` override (failing-vitest tests) does not
      // also fail the install. Defaults to exit 0 (env prepared successfully).
      const isInstallCmd =
        (cmd === "pnpm" && args[0] === "install") ||
        (cmd === "npm" && args[0] === "ci") ||
        (cmd === "yarn" && args[0] === "install") ||
        (cmd === "bun" && args[0] === "install");
      if (isInstallCmd) {
        return {
          stdout: opts.install?.stdout ?? "",
          stderr: opts.install?.stderr ?? "",
          exitCode: opts.install?.exitCode ?? 0,
          timedOut: opts.install?.timedOut ?? false,
        };
      }

      if (cmd === "gh") {
        const argsArr = args as string[];
        const isPrDiff = argsArr.includes("diff");
        const isHeadRefQuery =
          argsArr.includes("headRefName,headRefOid") ||
          (argsArr.includes("--json") && argsArr.some((a) => a.includes("headRefOid")));

        if (opts.gh?.exitCode !== undefined && opts.gh.exitCode !== 0) {
          // Error path — return the overridden response for all gh calls.
          return {
            stdout: opts.gh?.stdout ?? "",
            stderr: opts.gh?.stderr ?? "",
            exitCode: opts.gh.exitCode,
            timedOut: opts.gh?.timedOut ?? false,
          };
        }

        if (isPrDiff) {
          return {
            stdout: opts.gh?.stdout ?? FAKE_PR_DIFF,
            stderr: opts.gh?.stderr ?? "",
            exitCode: opts.gh?.exitCode ?? 0,
            timedOut: opts.gh?.timedOut ?? false,
          };
        }

        if (isHeadRefQuery) {
          // Return the headRef JSON for materialisePrBranchWorktree.
          return {
            stdout: JSON.stringify({
              headRefName: FAKE_HEAD_REF_NAME,
              headRefOid: FAKE_HEAD_REF_OID,
            }),
            stderr: "",
            exitCode: 0,
            timedOut: false,
          };
        }

        // All other gh calls (e.g. pr-view --json commits for risk-tier classification):
        return {
          stdout: opts.gh?.stdout ?? '["chore: stub commit"]',
          stderr: opts.gh?.stderr ?? "",
          exitCode: opts.gh?.exitCode ?? 0,
          timedOut: opts.gh?.timedOut ?? false,
        };
      }

      if (cmd === "git") {
        const argsArr = args as string[];
        // Handle git worktree add — create the directory from tmpRoot.
        if (argsArr[0] === "worktree" && argsArr[1] === "add") {
          const worktreePath = argsArr[2];
          if (worktreePath && opts.tmpRoot) {
            await createWorktreeFromTmpRoot(worktreePath, opts.tmpRoot);
          } else if (worktreePath) {
            // No tmpRoot provided — just create the directory.
            const { promises: fsP } = await import("node:fs");
            await fsP.mkdir(worktreePath, { recursive: true });
          }
          return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
        }
        // Handle git worktree remove — actually remove the directory.
        if (argsArr[0] === "worktree" && argsArr[1] === "remove") {
          const removePath = argsArr[2];
          if (removePath) {
            const { promises: fsP } = await import("node:fs");
            await fsP.rm(removePath, { recursive: true, force: true }).catch(() => {
              /* best-effort */
            });
          }
          return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
        }
        // git fetch and all other git commands — succeed silently.
        return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
      }

      if (cmd === "pnpm") {
        return {
          // Default to a realistic passing vitest summary so the zero-executed
          // guard (fix 01KV43ET) sees ≥1 test actually RAN — exit 0 with empty
          // output is no longer a pass. Tests that need a specific run shape
          // (zero-match, failure) override opts.vitest.stdout/exitCode.
          stdout: opts.vitest?.stdout ?? "\n Test Files  1 passed (1)\n      Tests  1 passed (1)\n",
          stderr: opts.vitest?.stderr ?? "",
          exitCode: opts.vitest?.exitCode ?? 0,
          timedOut: opts.vitest?.timedOut ?? false,
        };
      }
      // Fallback for any other command — should not occur in production paths.
      return { stdout: "", stderr: `unexpected command: ${cmd}`, exitCode: 1, timedOut: false };
    },
  );
  return stub as unknown as typeof import("execa").execa;
}

/** Convenience: gh-only stub (no vitest calls expected in this test path). */
function makeGhExecaStub(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  timedOut?: boolean;
} = {}) {
  // Defer tmpRoot resolution — accessed via the closure over `tmpRoot` at call time.
  return makeDiscriminatingStub({ gh: opts, get tmpRoot() { return tmpRoot; } });
}

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

async function buildFixture(tmpRoot: string): Promise<void> {
  // .flow/config.yaml
  await fs.mkdir(path.join(tmpRoot, ".flow"), { recursive: true });
  await atomicWriteFile(
    path.join(tmpRoot, ".flow", "config.yaml"),
    "adapter: native\nadapter_config: {}\n",
  );

  // Native stories dir + spec file
  const storiesDir = path.join(tmpRoot, ".flow", "native-stories");
  await fs.mkdir(storiesDir, { recursive: true });
  await atomicWriteFile(path.join(storiesDir, `${ULID}.md`), FIXTURE_SPEC);

  // In-progress state dir + manifest
  const inProgressDir = path.join(tmpRoot, ".flow", "state", "in-progress");
  await fs.mkdir(inProgressDir, { recursive: true });
  await atomicWriteFile(
    path.join(inProgressDir, `${STORY_REF}.yaml`),
    makeManifestYaml(STORY_REF, SESSION_ULID),
  );

  // docs/standards.md
  await fs.mkdir(path.join(tmpRoot, "docs"), { recursive: true });
  await atomicWriteFile(path.join(tmpRoot, "docs", "standards.md"), FIXTURE_STANDARDS);

  // The artifact AC1 expects
  await atomicWriteFile(path.join(tmpRoot, "hello-a.txt"), "hello world\n");

  // package.json at root so Story 5.27's findPackageRoot can resolve cwd for vitest checks.
  // The vitest: marker value "fixture passing test" is used as testFilePath; the walk starts
  // at path.dirname(path.resolve(tmpRoot, "fixture passing test")) === tmpRoot.
  await atomicWriteFile(
    path.join(tmpRoot, "package.json"),
    JSON.stringify({ name: "fixture-4-6", version: "0.0.0", private: true }, null, 2),
  );
  // pnpm lockfile so the toolchain resolver (Story native:01KVTB3Z) detects the
  // package manager as pnpm for the reviewer's vitest invocation — mirroring the
  // real Flow repo. Without a lockfile and no local vitest binary the resolver
  // would default to npm, and this fixture asserts the `pnpm vitest` invocation.
  await atomicWriteFile(
    path.join(tmpRoot, "pnpm-lock.yaml"),
    "lockfileVersion: '9.0'\n",
  );

  // vitest test file (passing)
  await fs.mkdir(path.join(tmpRoot, "__tests__"), { recursive: true });
  await atomicWriteFile(path.join(tmpRoot, "__tests__", "fixture.test.ts"), FIXTURE_VITEST_TEST);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "flow-4-6-"));
  await buildFixture(tmpRoot);
  __resetGhErrorMapCacheForTests();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper to call runReviewerSession with defaults
// ---------------------------------------------------------------------------

function callSession(opts: {
  execaImpl?: typeof import("execa").execa;
  pluginRootOverride?: string;
} = {}) {
  return runReviewerSession({
    targetRepoRoot: tmpRoot,
    sessionUlid: SESSION_ULID,
    ref: STORY_REF,
    prNumber: PR_NUMBER,
    execaImpl: opts.execaImpl ?? makeGhExecaStub(),
    pluginRootOverride: opts.pluginRootOverride,
  });
}

// ---------------------------------------------------------------------------
// AC4(c): Three-reads assertion — all three called, in order
// ---------------------------------------------------------------------------

describe("AC4(c): three reads are called in order (source story → pr diff → standards)", () => {
  it("all three I/O operations are invoked; ordering is source < gh < standards", async () => {
    // Spy on lookupStandards via module spying
    const lookupStandardsMod = await import("../../state/lookup-standards.js");
    const lookupSpy = vi.spyOn(lookupStandardsMod, "lookupStandards");

    // Stub execaImpl to track invocation order
    const execaStub = makeGhExecaStub();

    // The workspace activeAdapter.readSourceStory is harder to spy directly;
    // we assert it was called by checking the sourceStory is populated.

    const result = await runReviewerSession({
      targetRepoRoot: tmpRoot,
      sessionUlid: SESSION_ULID,
      ref: STORY_REF,
      prNumber: PR_NUMBER,
      execaImpl: execaStub,
    });

    // All three reads returned data
    expect(result.sourceStory.ref).toBe(STORY_REF);
    expect(result.prDiff).toContain("hello-a.txt");
    expect(result.standards.version).toBe("0.1.0");

    // lookupStandards was called once
    expect(lookupSpy).toHaveBeenCalledTimes(1);

    // execaImpl is shared for both gh pr diff and pnpm vitest calls.
    // Assert the first call (gh pr diff) specifically — gh is called before vitest.
    // Cast to vi.Mock to access mock.calls (the stub is a vi.fn()).
    const stub = execaStub as unknown as ReturnType<typeof vi.fn>;
    const firstCallArgs = stub.mock.calls[0] as unknown[];
    expect(firstCallArgs).toBeDefined();
    expect(firstCallArgs![0]).toBe("gh");
    expect(firstCallArgs![1]).toEqual(expect.arrayContaining(["pr", "diff", String(PR_NUMBER)]));

    lookupSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// AC4(d): Structured result assertions (passing artifact, passing vitest, manual)
// ---------------------------------------------------------------------------

describe("AC4(d): structured acResults for the three fixture ACs", () => {
  it("AC1: runnable-artifact-check, status: pass, reason contains 'artifact present'", async () => {
    const result = await callSession();

    const ac1 = result.acResults[1];
    expect(ac1).toBeDefined();
    expect(ac1!.applicability).toBe("runnable-artifact-check");
    if (ac1!.applicability !== "runnable-artifact-check") return;
    expect(ac1!.artifactPath).toBe("hello-a.txt");
    expect(ac1!.status).toBe("pass");
    expect(ac1!.reason).toContain("artifact present");
  });

  // AC4(d) spec clause: "AC2: applicability is runnable-vitest, pass path"
  // Uses a discriminating stub that returns pnpm vitest exit 0 (pass path).
  // Asserts ac2.status === "pass" deterministically (not vacuous).
  it("AC2: applicability is runnable-vitest, pass path — stub returns pnpm exitCode 0, status === 'pass', filter used", async () => {
    // Stub: gh returns diff, pnpm vitest returns exit 0 (pass).
    const passingStub = makeDiscriminatingStub({ vitest: { exitCode: 0 }, get tmpRoot() { return tmpRoot; } });
    const result = await callSession({ execaImpl: passingStub });

    const ac2 = result.acResults[2];
    expect(ac2).toBeDefined();
    expect(ac2!.applicability).toBe("runnable-vitest");
    if (ac2!.applicability !== "runnable-vitest") return;
    expect(ac2!.testNameFilter).toBe("fixture passing test");
    // Deterministic: pnpm stub returned exitCode 0, so status MUST be "pass".
    expect(ac2!.status).toBe("pass");
    expect(ac2!.exitCode).toBe(0);
    // The vitest filter string from the AC body was forwarded to the stub.
    const stub = passingStub as unknown as ReturnType<typeof vi.fn>;
    // Find the vitest invocation specifically — the install call (`pnpm install`,
    // Story native:01KVWMCK) is also a `pnpm` call and runs first.
    const vitestCall = stub.mock.calls.find(
      (c: unknown[]) => c[0] === "pnpm" && Array.isArray(c[1]) && (c[1] as string[]).includes("vitest"),
    );
    expect(vitestCall).toBeDefined();
    expect(vitestCall![1]).toEqual(
      expect.arrayContaining(["vitest", "--run", "-t", "fixture passing test"]),
    );
  });

  it("AC3: manual-check-required, reason contains 'manual check required'", async () => {
    // Story 10.1: a markerless native AC is now invalid to parseNativeStory, so
    // the manual-check path is exercised via an extractAcsFromSpec stub returning
    // a markerless AC body (the reviewer logic under test is independent of the
    // native parser). One artifact AC keeps the fixture realistic; AC2 is the
    // markerless manual one.
    const spy = await stubExtractAcsManual([
      ["**Given** the artifact file should exist, **When** the reviewer checks, **Then** present.", "artifact: hello-a.txt"],
      ["**Given** this requires manual inspection, **When** examined, **Then** verify manually."],
    ]);
    try {
      const result = await callSession();

      const ac2 = result.acResults[2];
      expect(ac2).toBeDefined();
      expect(ac2!.applicability).toBe("manual-check-required");
      if (ac2!.applicability !== "manual-check-required") return;
      expect(ac2!.reason).toContain("manual check required");
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// AC4(e): Standards-by-id assertion
// ---------------------------------------------------------------------------

describe("AC4(e): standardsByCriterionId has 4 entries keyed by slugified name", () => {
  it("Object.keys returns 4 entries; story-aligned.what matches fixture standards", async () => {
    const result = await callSession();

    expect(Object.keys(result.standardsByCriterionId)).toHaveLength(4);
    const storyAligned = result.standardsByCriterionId["story-aligned"];
    expect(storyAligned).toBeDefined();
    expect(storyAligned!.what).toContain("acceptance criteria require");
  });
});

// ---------------------------------------------------------------------------
// AC4(f): Negative path — missing artifact
// ---------------------------------------------------------------------------

describe("AC4(f): missing artifact → acResults[1].status === 'fail' with ENOENT", () => {
  it("removes hello-a.txt before invocation; AC1 fails with ENOENT reason", async () => {
    await fs.rm(path.join(tmpRoot, "hello-a.txt"));

    const result = await callSession();

    const ac1 = result.acResults[1];
    expect(ac1!.applicability).toBe("runnable-artifact-check");
    if (ac1!.applicability !== "runnable-artifact-check") return;
    expect(ac1!.status).toBe("fail");
    expect(ac1!.reason).toContain("ENOENT");
    expect(ac1!.reason).toContain("hello-a.txt");
  });
});

// ---------------------------------------------------------------------------
// AC4(g): Negative path — failing vitest filter (discriminating stub, exit 1)
//
// Issue 2 fix: use a discriminating stub that returns pnpm vitest exitCode 1
// so no real subprocess is spawned. Asserts status === "fail", exitCode !== 0,
// and reason contains the verbatim "vitest filter '...' failed" message per
// the spec. The 60s timeout hack is removed — stub completes in milliseconds.
// ---------------------------------------------------------------------------

describe("AC4(g): failing vitest filter → acResults[2].status === 'fail', exitCode !== 0, reason verbatim", () => {
  it("stub returns pnpm exitCode 1 → AC2 status === 'fail', reason contains 'vitest filter ... failed'", async () => {
    // Stub: gh returns diff, pnpm vitest returns exit 1 (fail path).
    const failingStub = makeDiscriminatingStub({ vitest: { exitCode: 1, stderr: "1 failed" }, get tmpRoot() { return tmpRoot; } });

    const result = await callSession({ execaImpl: failingStub });

    const ac2 = result.acResults[2];
    expect(ac2).toBeDefined();
    expect(ac2!.applicability).toBe("runnable-vitest");
    if (ac2!.applicability !== "runnable-vitest") return;
    expect(ac2!.status).toBe("fail");
    expect(ac2!.exitCode).not.toBe(0);
    // Spec §2c verbatim reason: "vitest filter '<filter>' failed (exit <code>)"
    expect(ac2!.reason).toContain("vitest filter 'fixture passing test' failed");
  });
});

// ---------------------------------------------------------------------------
// AC4(h): Negative path — duplicate criterion id
// ---------------------------------------------------------------------------

describe("AC4(h): duplicate criterion id → DuplicateStandardsCriterionIdError", () => {
  it("standards doc with two criteria that slugify to same id raises DuplicateStandardsCriterionIdError", async () => {
    const malformedStandards = `version: "0.1.0"
updated: "2026-05-24"
criteria:
  - name: "Story Aligned"
    what: "First."
    check: "Check first."
    anti_criterion: "Anti first."
  - name: "story aligned"
    what: "Second."
    check: "Check second."
    anti_criterion: "Anti second."
`;
    await atomicWriteFile(path.join(tmpRoot, "docs", "standards.md"), malformedStandards);

    await expect(callSession()).rejects.toThrow(DuplicateStandardsCriterionIdError);

    // The error message names the criterion id and both offending names
    try {
      await callSession();
    } catch (err) {
      expect(err).toBeInstanceOf(DuplicateStandardsCriterionIdError);
      const msg = (err as DuplicateStandardsCriterionIdError).message;
      expect(msg).toContain("story-aligned");
      expect(msg).toContain("Story Aligned");
      expect(msg).toContain("story aligned");
    }
  });
});

// ---------------------------------------------------------------------------
// AC4(i): Negative path — pr-diff recoverable error propagates uncaught
// ---------------------------------------------------------------------------

describe("AC4(i): gh pr-diff recoverable error propagates from runReviewerSession", () => {
  it("stubbed execaImpl returning exit 4 with rate-limit stderr → GhRecoverableError propagates", async () => {
    // Exit code 4 matches the 'defer' class per gh-error-map.yaml's first entry
    // (API rate limit exceeded). The gh wrapper raises GhRecoverableError which
    // propagates uncaught from runReviewerSession.
    const rateLimitStub = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "API rate limit exceeded",
      exitCode: 4,
      timedOut: false,
    }) as unknown as typeof import("execa").execa;

    await expect(
      runReviewerSession({
        targetRepoRoot: tmpRoot,
        sessionUlid: SESSION_ULID,
        ref: STORY_REF,
        prNumber: PR_NUMBER,
        execaImpl: rateLimitStub,
      }),
    ).rejects.toThrow(GhRecoverableError);
  });
});

// ---------------------------------------------------------------------------
// AC4(j): Negative path — adapter read error (missing source story file)
// ---------------------------------------------------------------------------

describe("AC4(j): missing source story file → error propagates from runReviewerSession", () => {
  it("deletes native-stories/<ULID>.md before invocation; runReviewerSession throws", async () => {
    await fs.rm(path.join(tmpRoot, ".flow", "native-stories", `${ULID}.md`));

    await expect(callSession()).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Bonus: prDiff is populated from the stub
// ---------------------------------------------------------------------------

describe("prDiff is populated from the execaImpl stub", () => {
  it("result.prDiff contains the stub's stdout string", async () => {
    const result = await callSession();
    expect(result.prDiff).toBe(FAKE_PR_DIFF);
  });
});

// ---------------------------------------------------------------------------
// AC4(k): reviewer-result.json persistence assertions (Task 9.6 — revision 2)
// ---------------------------------------------------------------------------

describe("AC4(k): reviewer-result.json persistence (revision 2)", () => {
  const expectedFilePath = () =>
    path.join(
      tmpRoot,
      ".flow",
      "state",
      "sessions",
      SESSION_ULID,
      sanitiseRefForPathSegment(STORY_REF),
      "reviewer-result.json",
    );

  it("happy path: reviewer-result.json exists at expected path after successful session", async () => {
    await callSession();

    const raw = await fs.readFile(expectedFilePath(), "utf8");
    const parsed = JSON.parse(raw) as ReviewerResultFileShape;

    // Required keys are present
    expect(parsed).toHaveProperty("sessionUlid", SESSION_ULID);
    expect(parsed).toHaveProperty("ref", STORY_REF);
    expect(parsed).toHaveProperty("prNumber", PR_NUMBER);
    expect(parsed).toHaveProperty("sourceStoryRef");
    expect(parsed).toHaveProperty("recommendedVerdict");
    expect(parsed).toHaveProperty("acResults");
    expect(parsed).toHaveProperty("standardsByCriterionId");
  });

  it("a passing artifact + passing vitest + manual AC: recommendedVerdict === 'NEEDS CHANGES'", async () => {
    // Story 10.1: the manual AC can no longer be a markerless native AC on disk
    // (parseNativeStory rejects it). Stub extractAcsFromSpec to return the three
    // canonical ACs — artifact (pass), vitest (pass), manual — so the reviewer's
    // "any manual-check-required → NEEDS CHANGES" rule is exercised.
    // Story native:01KV06ZGHHM1MZ2DS2HENXQG7N (unbacked-criterion gate):
    //   A criterion with no resolvable evidence marker (manual-check-required) is
    //   treated as "unbacked" and yields NEEDS CHANGES, not BLOCKED. The reviewer
    //   explicitly refuses approval rather than signalling an operational stall.
    const spy = await stubExtractAcsManual([
      ["**Given** the artifact, **When** checked, **Then** present.", "artifact: hello-a.txt"],
      ["**Given** the vitest, **When** run, **Then** passes.", "vitest: fixture passing test"],
      ["**Given** manual inspection, **When** examined, **Then** verify manually."],
    ]);
    try {
      const passingStub = makeDiscriminatingStub({ vitest: { exitCode: 0 }, get tmpRoot() { return tmpRoot; } });
      const result = await callSession({ execaImpl: passingStub });

      const raw = await fs.readFile(expectedFilePath(), "utf8");
      const parsed = JSON.parse(raw) as ReviewerResultFileShape;

      // AC3 is manual-check-required → NEEDS CHANGES (unbacked criterion, not operational blocker)
      expect(parsed.recommendedVerdict).toBe("NEEDS CHANGES");
      expect(result.recommendedVerdict).toBe("NEEDS CHANGES");
    } finally {
      spy.mockRestore();
    }
  });

  it("missing artifact: reviewer-result.json has recommendedVerdict === 'NEEDS CHANGES'", async () => {
    // Remove the artifact file
    await fs.rm(path.join(tmpRoot, "hello-a.txt"));

    const result = await callSession();

    const raw = await fs.readFile(expectedFilePath(), "utf8");
    const parsed = JSON.parse(raw) as ReviewerResultFileShape;

    expect(parsed.recommendedVerdict).toBe("NEEDS CHANGES");
    expect(result.recommendedVerdict).toBe("NEEDS CHANGES");
  });

  it("all-manual-check fixture: recommendedVerdict === 'NEEDS CHANGES'", async () => {
    // Story 10.1: a native story whose every AC is markerless is now invalid to
    // parseNativeStory, so we exercise the all-manual case via an
    // extractAcsFromSpec stub (the on-disk fixture stays a valid native story
    // for readSourceStory). Both ACs are markerless → manual-check-required.
    // Story native:01KV06ZGHHM1MZ2DS2HENXQG7N (unbacked-criterion gate):
    //   All ACs have no resolvable evidence marker → all are unbacked → NEEDS CHANGES.
    const spy = await stubExtractAcsManual([
      ["**Given** something, **When** reviewed, **Then** it is correct."],
      ["**Given** something else, **When** reviewed, **Then** it is also correct."],
    ]);

    try {
      const result = await callSession();

      const raw = await fs.readFile(expectedFilePath(), "utf8");
      const parsed = JSON.parse(raw) as ReviewerResultFileShape;

      expect(parsed.recommendedVerdict).toBe("NEEDS CHANGES");
      expect(result.recommendedVerdict).toBe("NEEDS CHANGES");
    } finally {
      spy.mockRestore();
    }
  });

  it("empty acResults (extractAcsFromSpec returns []): recommendedVerdict === 'BLOCKED'", async () => {
    // The native story parser enforces at least one AC block, so we can't produce
    // empty acResults by writing a spec file. Instead, stub extractAcsFromSpec to
    // return [] while leaving the normal spec in place for readSourceStory to parse.
    const extractAcsMod = await import("../../lib/extract-acs-from-spec.js");
    const spy = vi.spyOn(extractAcsMod, "extractAcsFromSpec").mockResolvedValueOnce([]);

    try {
      const result = await callSession();

      const raw = await fs.readFile(expectedFilePath(), "utf8");
      const parsed = JSON.parse(raw) as ReviewerResultFileShape;

      expect(parsed.recommendedVerdict).toBe("BLOCKED");
      expect(result.recommendedVerdict).toBe("BLOCKED");
      expect(Object.keys(result.acResults)).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("result object carries sessionUlid, ref, prNumber, sourceStoryRef, recommendedVerdict fields", async () => {
    const result = await callSession();

    expect(result.sessionUlid).toBe(SESSION_ULID);
    expect(result.ref).toBe(STORY_REF);
    expect(result.prNumber).toBe(PR_NUMBER);
    expect(result.sourceStoryRef).toBe(STORY_REF);
    expect(["READY FOR MERGE", "NEEDS CHANGES", "BLOCKED"]).toContain(result.recommendedVerdict);
  });
});

// ---------------------------------------------------------------------------
// Story native:01KTAP1N6DEF181646EW3RJH8W — friction telemetry emissions
// AC1: empty acResults → exactly one agent.friction event with kind 'empty-input'
// AC2: missing artifact (ENOENT) → exactly one agent.friction event with kind 'missing-cited-source'
// ---------------------------------------------------------------------------

describe("friction telemetry — AC1: empty acResults → empty-input event, verdict unchanged", () => {
  it("emits exactly one agent.friction 'empty-input' event when extractAcsFromSpec returns [] and verdict is BLOCKED", async () => {
    // Stub extractAcsFromSpec to return [] — no AC markers found.
    const extractAcsMod = await import("../../lib/extract-acs-from-spec.js");
    const spy = vi.spyOn(extractAcsMod, "extractAcsFromSpec").mockResolvedValueOnce([]);

    // Spy on emitFriction via recordAgentFriction (the underlying call)
    const recordFrictionMod = await import("../record-agent-friction.js");
    const frictionSpy = vi.spyOn(recordFrictionMod, "recordAgentFriction");

    try {
      const result = await callSession();

      // The verdict is unchanged (BLOCKED) — emitFriction is additive.
      expect(result.recommendedVerdict).toBe("BLOCKED");

      // Exactly one friction event emitted with the correct shape.
      const frictionCalls = frictionSpy.mock.calls;
      const emptyInputCalls = frictionCalls.filter((c) => c[0]?.kind === "empty-input");
      expect(emptyInputCalls).toHaveLength(1);
      const call = emptyInputCalls[0]![0]!;
      expect(call.kind).toBe("empty-input");
      expect(call.role).toBe("generalist-reviewer");
      expect(call.session_id).toBe(SESSION_ULID);
      expect(call.story_id).toBe(STORY_REF);
    } finally {
      spy.mockRestore();
      frictionSpy.mockRestore();
    }
  });

  it("does NOT emit a friction event on the happy path (non-empty acResults)", async () => {
    // Normal fixture session — has artifact AC (pass/fail) and vitest AC.
    const recordFrictionMod = await import("../record-agent-friction.js");
    const frictionSpy = vi.spyOn(recordFrictionMod, "recordAgentFriction");

    try {
      await callSession();

      // No empty-input friction events should fire (non-empty acResults).
      const emptyInputCalls = frictionSpy.mock.calls.filter(
        (c) => c[0]?.kind === "empty-input",
      );
      expect(emptyInputCalls).toHaveLength(0);
    } finally {
      frictionSpy.mockRestore();
    }
  });

  it("verdict is unchanged (BLOCKED) even if emitFriction throws internally", async () => {
    // Stub extractAcsFromSpec to return [] AND stub recordAgentFriction to throw.
    const extractAcsMod = await import("../../lib/extract-acs-from-spec.js");
    const extractSpy = vi.spyOn(extractAcsMod, "extractAcsFromSpec").mockResolvedValueOnce([]);

    const recordFrictionMod = await import("../record-agent-friction.js");
    const frictionSpy = vi.spyOn(recordFrictionMod, "recordAgentFriction").mockRejectedValue(
      new Error("telemetry write failed"),
    );

    try {
      // Must not throw — emitFriction is fail-soft.
      const result = await callSession();
      expect(result.recommendedVerdict).toBe("BLOCKED");
    } finally {
      extractSpy.mockRestore();
      frictionSpy.mockRestore();
    }
  });
});

describe("friction telemetry — AC2: missing artifact (ENOENT) → missing-cited-source event, verdict unchanged", () => {
  it("emits exactly one agent.friction 'missing-cited-source' event per missing artifact check", async () => {
    // Stub extractAcsFromSpec to return exactly ONE artifact AC (to get deterministic count).
    // The fixture spec has two artifact ACs (AC1 + AC3 both reference hello-a.txt), so
    // we stub to get a single AC for a precise 1:1 assertion.
    const extractAcsMod = await import("../../lib/extract-acs-from-spec.js");
    const extractSpy = vi.spyOn(extractAcsMod, "extractAcsFromSpec").mockResolvedValueOnce([
      { index: 1, tag: null, firstLine: "artifact: hello-a.txt", body: ["artifact: hello-a.txt"] },
    ]);

    // Remove the artifact file so the reviewer gets an ENOENT result.
    await fs.rm(path.join(tmpRoot, "hello-a.txt"));

    const recordFrictionMod = await import("../record-agent-friction.js");
    const frictionSpy = vi.spyOn(recordFrictionMod, "recordAgentFriction");

    try {
      const result = await callSession();

      // The verdict is unchanged (NEEDS CHANGES) — artifact failed.
      expect(result.recommendedVerdict).toBe("NEEDS CHANGES");

      // Exactly one missing-cited-source friction event (one artifact check, one miss).
      const missingCalls = frictionSpy.mock.calls.filter(
        (c) => c[0]?.kind === "missing-cited-source",
      );
      expect(missingCalls).toHaveLength(1);
      const call = missingCalls[0]![0]!;
      expect(call.kind).toBe("missing-cited-source");
      expect(call.role).toBe("generalist-reviewer");
      expect(call.session_id).toBe(SESSION_ULID);
      expect(call.story_id).toBe(STORY_REF);
    } finally {
      extractSpy.mockRestore();
      frictionSpy.mockRestore();
    }
  });

  it("does NOT emit a missing-cited-source event when the artifact is present", async () => {
    const recordFrictionMod = await import("../record-agent-friction.js");
    const frictionSpy = vi.spyOn(recordFrictionMod, "recordAgentFriction");

    try {
      await callSession();

      const missingCalls = frictionSpy.mock.calls.filter(
        (c) => c[0]?.kind === "missing-cited-source",
      );
      expect(missingCalls).toHaveLength(0);
    } finally {
      frictionSpy.mockRestore();
    }
  });

  it("verdict is unchanged (NEEDS CHANGES) even if emitFriction throws internally", async () => {
    await fs.rm(path.join(tmpRoot, "hello-a.txt"));

    const recordFrictionMod = await import("../record-agent-friction.js");
    const frictionSpy = vi.spyOn(recordFrictionMod, "recordAgentFriction").mockRejectedValue(
      new Error("telemetry write failed"),
    );

    try {
      // Must not throw — emitFriction is fail-soft.
      const result = await callSession();
      expect(result.recommendedVerdict).toBe("NEEDS CHANGES");
    } finally {
      frictionSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Story native:01KV06ZGHHM1MZ2DS2HENXQG7N — unbacked-criterion gate
//
// AC1: Any criterion presented as covered but not backed by resolving evidence
//      (missing marker, or a failing check) must be flagged as unbacked, named
//      in the outcome, and prevent an approved verdict.
//      Any criterion fully backed (passing test, existing artifact) must let
//      the pull request proceed toward approval.
//
// AC2: A criterion with NO covering evidence at all (no marker) is treated as
//      unbacked → NEEDS CHANGES, not passed over to approval.
//
// Tests are structured by the task-list coverage matrix:
//   T1: missing marker → unbacked → NEEDS CHANGES
//   T2: failing test marker → NEEDS CHANGES (exercised; named by AC result reason)
//   T3: passing test marker → no objection; all-pass → READY FOR MERGE
//   T4: existing artifact → no objection; all-pass → READY FOR MERGE
//   T5: criterion with no marker at all → unbacked → NEEDS CHANGES (AC2 pinning)
// ---------------------------------------------------------------------------

describe("unbacked-criterion gate — AC1: missing or failing marker prevents approval", () => {
  it("T1: criterion with missing marker (manual-check-required) → unbacked → NEEDS CHANGES", async () => {
    // Stub a single AC with no marker — simulates a spec AC with no vitest:/artifact: line.
    // The presenter implies it is covered, but there is no resolvable evidence marker.
    const spy = await stubExtractAcsManual([
      ["**Given** some criterion, **When** checked, **Then** it passes."],
    ]);
    try {
      const result = await callSession();

      // The criterion is unbacked (manual-check-required) → NEEDS CHANGES.
      expect(result.recommendedVerdict).toBe("NEEDS CHANGES");
      // The acResult names the criterion via its applicability and reason.
      expect(result.acResults[1]).toBeDefined();
      expect(result.acResults[1]!.applicability).toBe("manual-check-required");
      expect(result.acResults[1]!.reason).toContain("manual check required");
    } finally {
      spy.mockRestore();
    }
  });

  it("T2: failing test marker → reviewer names it as failed → NEEDS CHANGES", async () => {
    // An AC with a vitest: marker whose test fails → status: fail → NEEDS CHANGES.
    // The criterion is presented as covered but the evidence does not resolve.
    const spy = await stubExtractAcsManual([
      ["**Given** a test, **When** run, **Then** it passes.", "vitest: fixture passing test"],
    ]);
    const failingStub = makeDiscriminatingStub({ vitest: { exitCode: 1, stderr: "1 failed" }, get tmpRoot() { return tmpRoot; } });
    try {
      const result = await callSession({ execaImpl: failingStub });

      expect(result.recommendedVerdict).toBe("NEEDS CHANGES");
      expect(result.acResults[1]).toBeDefined();
      expect(result.acResults[1]!.applicability).toBe("runnable-vitest");
      if (result.acResults[1]!.applicability !== "runnable-vitest") return;
      expect(result.acResults[1]!.status).toBe("fail");
      // The reason names the specific failing filter.
      expect(result.acResults[1]!.reason).toContain("fixture passing test");
    } finally {
      spy.mockRestore();
    }
  });

  it("T3: passing test marker → no objection → READY FOR MERGE (single-AC, all pass)", async () => {
    // A single AC with a vitest: marker that passes → all evidence resolves → READY FOR MERGE.
    const spy = await stubExtractAcsManual([
      ["**Given** a test, **When** run, **Then** it passes.", "vitest: fixture passing test"],
    ]);
    const passingStub = makeDiscriminatingStub({ vitest: { exitCode: 0 }, get tmpRoot() { return tmpRoot; } });
    try {
      const result = await callSession({ execaImpl: passingStub });

      expect(result.recommendedVerdict).toBe("READY FOR MERGE");
      expect(result.acResults[1]).toBeDefined();
      if (result.acResults[1]!.applicability !== "runnable-vitest") {
        expect(result.acResults[1]!.applicability).toBe("runnable-vitest");
        return;
      }
      expect(result.acResults[1]!.status).toBe("pass");
    } finally {
      spy.mockRestore();
    }
  });

  it("T4: existing artifact → no objection → READY FOR MERGE (single-AC, all pass)", async () => {
    // A single AC with an artifact: marker pointing to an existing file → READY FOR MERGE.
    // hello-a.txt is present in the fixture (buildFixture writes it to tmpRoot).
    // The worktree stub copies tmpRoot files into the worktree, so the artifact resolves.
    const spy = await stubExtractAcsManual([
      ["**Given** the artifact exists, **When** checked, **Then** present.", "artifact: hello-a.txt"],
    ]);
    try {
      const result = await callSession();

      expect(result.recommendedVerdict).toBe("READY FOR MERGE");
      expect(result.acResults[1]).toBeDefined();
      expect(result.acResults[1]!.applicability).toBe("runnable-artifact-check");
      if (result.acResults[1]!.applicability !== "runnable-artifact-check") return;
      expect(result.acResults[1]!.status).toBe("pass");
    } finally {
      spy.mockRestore();
    }
  });

  it("T5 (AC2 pin): criterion with no covering evidence at all → unbacked → NEEDS CHANGES, not approval slip-through", async () => {
    // AC2 specifically pins the fall-through risk: a criterion that cites no
    // covering evidence at all (no vitest:/artifact: line) must not slip through
    // to an approved verdict. It must be treated as unbacked → NEEDS CHANGES.
    //
    // Two ACs: AC1 passes (backed), AC2 has no marker (unbacked).
    // The verdict must be NEEDS CHANGES (not READY FOR MERGE) because AC2 has no
    // resolvable evidence even though AC1 is fully backed.
    const spy = await stubExtractAcsManual([
      ["**Given** the artifact exists, **When** checked, **Then** present.", "artifact: hello-a.txt"],
      ["**Given** this criterion, **When** checked, **Then** it holds."],
    ]);
    try {
      const result = await callSession();

      // AC1 is backed and passes; AC2 has no marker → unbacked.
      // The verdict MUST be NEEDS CHANGES — AC2 must NOT slip through to approval.
      expect(result.recommendedVerdict).toBe("NEEDS CHANGES");

      // AC1: backed artifact, passes.
      expect(result.acResults[1]).toBeDefined();
      expect(result.acResults[1]!.applicability).toBe("runnable-artifact-check");
      if (result.acResults[1]!.applicability === "runnable-artifact-check") {
        expect(result.acResults[1]!.status).toBe("pass");
      }

      // AC2: unbacked — no marker → manual-check-required.
      expect(result.acResults[2]).toBeDefined();
      expect(result.acResults[2]!.applicability).toBe("manual-check-required");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("unbacked-criterion gate — AC1: all backed and passing → approval proceeds", () => {
  it("both artifact (passing) and vitest (passing) → READY FOR MERGE", async () => {
    // Two ACs: artifact (present) + vitest (exit 0). Both resolve → no unbacked
    // criteria → READY FOR MERGE.
    const spy = await stubExtractAcsManual([
      ["**Given** the artifact, **When** checked, **Then** present.", "artifact: hello-a.txt"],
      ["**Given** the test, **When** run, **Then** passes.", "vitest: fixture passing test"],
    ]);
    const passingStub = makeDiscriminatingStub({ vitest: { exitCode: 0 }, get tmpRoot() { return tmpRoot; } });
    try {
      const result = await callSession({ execaImpl: passingStub });

      expect(result.recommendedVerdict).toBe("READY FOR MERGE");

      // No unbacked criteria.
      const values = Object.values(result.acResults);
      expect(values.every((r) => r.applicability !== "manual-check-required")).toBe(true);
      expect(values.every((r) => (r as { status?: string }).status !== "fail")).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Story native:01KVS10J5NZQPGT7MSMJPTZERM — standards-missing setup-error path
//
// AC1 (run-reviewer-session side): when docs/standards.md is absent,
// runReviewerSession MUST persist a reviewer-result.json with
// recommendedVerdict: "setup-error" (carrying FR45 guidance in setupError)
// INSTEAD OF throwing — so processReviewerTranscript has a present, distinctly-
// marked file to read, enabling the review-could-not-run variant.
//
// AC2 (reviewer path — existing verdicts unchanged): a genuine NEEDS CHANGES /
// BLOCKED verdict still routes to its existing path; READY FOR MERGE still goes
// to the merge gate. These paths are already covered by the existing tests above;
// the regression guards below confirm the new setup-error code path is cleanly
// isolated and does NOT affect those routes.
// ---------------------------------------------------------------------------

describe("standards-missing setup-error — AC1: persists reviewer-result.json with 'setup-error' (Story F5b)", () => {
  it("deletes docs/standards.md before invocation — result has recommendedVerdict:'setup-error', does NOT throw", async () => {
    // Remove docs/standards.md — this triggers StandardsDocMissingError in lookupStandards.
    await fs.rm(path.join(tmpRoot, "docs", "standards.md"));

    // runReviewerSession MUST NOT throw; it MUST persist the marker instead.
    const result = await callSession();

    expect(result.recommendedVerdict).toBe("setup-error");
    expect(result.acResults).toEqual({});
  });

  it("reviewer-result.json persisted with recommendedVerdict:'setup-error' and setupError carrying FR45 guidance", async () => {
    await fs.rm(path.join(tmpRoot, "docs", "standards.md"));

    const expectedFilePath = path.join(
      tmpRoot,
      ".flow",
      "state",
      "sessions",
      SESSION_ULID,
      sanitiseRefForPathSegment(STORY_REF),
      "reviewer-result.json",
    );

    await callSession();

    // File must be present.
    const raw = await fs.readFile(expectedFilePath, "utf8");
    const parsed = JSON.parse(raw) as { recommendedVerdict: string; setupError?: string };

    expect(parsed.recommendedVerdict).toBe("setup-error");
    // setupError must carry the FR45 guidance so processReviewerTranscript can surface it.
    expect(typeof parsed.setupError).toBe("string");
    expect(parsed.setupError).toContain("FR45");
    expect(parsed.setupError).toContain("standards.md");
  });

  it("regression: NEEDS CHANGES on normal fixture (standards present) is unaffected", async () => {
    // docs/standards.md is present (seeded in buildFixture). A missing artifact → NEEDS CHANGES.
    await fs.rm(path.join(tmpRoot, "hello-a.txt"));
    const result = await callSession();
    expect(result.recommendedVerdict).toBe("NEEDS CHANGES");
  });

  it("regression: READY FOR MERGE on normal fixture (all pass) is unaffected", async () => {
    const spy = await stubExtractAcsManual([
      ["**Given** the artifact, **When** checked, **Then** present.", "artifact: hello-a.txt"],
      ["**Given** the test, **When** run, **Then** passes.", "vitest: fixture passing test"],
    ]);
    const passingStub = makeDiscriminatingStub({ vitest: { exitCode: 0 }, get tmpRoot() { return tmpRoot; } });
    try {
      const result = await callSession({ execaImpl: passingStub });
      expect(result.recommendedVerdict).toBe("READY FOR MERGE");
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Story native:01KVWMCK — reviewer installs deps into the materialised worktree
// before the AC walk.
//
// AC1: a dependency-importing suite that would fail in an un-installed worktree
//   passes once the reviewer installs deps — the install runs EXACTLY ONCE, at the
//   worktree's lockfile root, BEFORE any vitest check, and a green suite reaches an
//   approved verdict instead of bouncing.
// AC2: when the worktree cannot be prepared (install fails), the outcome is a
//   re-runnable setup-error, NOT a quality NEEDS CHANGES — and the AC walk never
//   runs, so the story is not dead-ended in rework.
// ---------------------------------------------------------------------------

describe("worktree dependency install — AC1: install runs once, before the AC walk (Story 01KVWMCK)", () => {
  const findCalls = (stub: ReturnType<typeof vi.fn>) => {
    const calls = stub.mock.calls as unknown[][];
    const isInstall = (c: unknown[]) =>
      c[0] === "pnpm" && Array.isArray(c[1]) && (c[1] as string[]).includes("install");
    const isVitest = (c: unknown[]) =>
      c[0] === "pnpm" && Array.isArray(c[1]) && (c[1] as string[]).includes("vitest");
    return {
      installIdx: calls.findIndex(isInstall),
      vitestIdx: calls.findIndex(isVitest),
      installCalls: calls.filter(isInstall),
    };
  };

  it("a frozen install runs exactly once, BEFORE the vitest check, at the worktree root", async () => {
    const spy = await stubExtractAcsManual([
      ["**Given** the test, **When** run, **Then** passes.", "vitest: fixture passing test"],
    ]);
    const passingStub = makeDiscriminatingStub({ vitest: { exitCode: 0 }, get tmpRoot() { return tmpRoot; } });
    try {
      const result = await callSession({ execaImpl: passingStub });

      const stub = passingStub as unknown as ReturnType<typeof vi.fn>;
      const { installIdx, vitestIdx, installCalls } = findCalls(stub);

      // Install happened, exactly once, and ran a clean frozen install.
      expect(installCalls).toHaveLength(1);
      expect(installCalls[0]![1]).toEqual(
        expect.arrayContaining(["install", "--frozen-lockfile"]),
      );
      // Install ran BEFORE the vitest check (so deps are present when tests run).
      expect(installIdx).toBeGreaterThanOrEqual(0);
      expect(vitestIdx).toBeGreaterThanOrEqual(0);
      expect(installIdx).toBeLessThan(vitestIdx);

      // Install ran in the materialised review worktree, NOT the operator's repo.
      const installCwd = (installCalls[0]![2] as { cwd?: string } | undefined)?.cwd ?? "";
      expect(installCwd).toContain(".flow-worktrees");
      expect(installCwd).not.toBe(tmpRoot);

      // The green suite reaches an approved verdict (single passing vitest AC).
      expect(result.recommendedVerdict).toBe("READY FOR MERGE");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("worktree dependency install — AC2: a failed install is a setup-error, not a quality verdict (Story 01KVWMCK)", () => {
  const expectedFilePath = () =>
    path.join(
      tmpRoot,
      ".flow",
      "state",
      "sessions",
      SESSION_ULID,
      sanitiseRefForPathSegment(STORY_REF),
      "reviewer-result.json",
    );

  it("install exits non-zero → recommendedVerdict 'setup-error', AC walk skipped, worktree cleaned up", async () => {
    const failingInstallStub = makeDiscriminatingStub({
      install: { exitCode: 1, stderr: "ERR_PNPM_OUTDATED_LOCKFILE: lockfile out of date" },
      get tmpRoot() { return tmpRoot; },
    });

    const result = await callSession({ execaImpl: failingInstallStub });

    // Setup-error sentinel — NEVER a quality NEEDS CHANGES.
    expect(result.recommendedVerdict).toBe("setup-error");
    expect(result.recommendedVerdict).not.toBe("NEEDS CHANGES");
    expect(result.acResults).toEqual({});

    // The AC walk never ran — no vitest invocation.
    const stub = failingInstallStub as unknown as ReturnType<typeof vi.fn>;
    const calls = stub.mock.calls as unknown[][];
    const vitestRan = calls.some(
      (c) => c[0] === "pnpm" && Array.isArray(c[1]) && (c[1] as string[]).includes("vitest"),
    );
    expect(vitestRan).toBe(false);

    // The worktree was cleaned up before returning (git worktree remove called).
    const removeCalled = calls.some(
      (c) => c[0] === "git" && Array.isArray(c[1]) && (c[1] as string[])[0] === "worktree" && (c[1] as string[])[1] === "remove",
    );
    expect(removeCalled).toBe(true);
  });

  it("persists reviewer-result.json with setup-error + a setupError naming the install failure", async () => {
    const failingInstallStub = makeDiscriminatingStub({
      install: { exitCode: 1, stderr: "ERR_PNPM_OUTDATED_LOCKFILE: lockfile out of date" },
      get tmpRoot() { return tmpRoot; },
    });

    await callSession({ execaImpl: failingInstallStub });

    const raw = await fs.readFile(expectedFilePath(), "utf8");
    const parsed = JSON.parse(raw) as { recommendedVerdict: string; setupError?: string };

    expect(parsed.recommendedVerdict).toBe("setup-error");
    expect(typeof parsed.setupError).toBe("string");
    expect(parsed.setupError).toContain("dependency install failed");
    // It is surfaced as a re-runnable setup problem, not a quality failure.
    expect(parsed.setupError).toContain("setup problem");
  });

  it("regression: a passing install leaves the normal NEEDS CHANGES path intact (missing artifact)", async () => {
    await fs.rm(path.join(tmpRoot, "hello-a.txt"));
    const result = await callSession();
    expect(result.recommendedVerdict).toBe("NEEDS CHANGES");
  });
});

// ---------------------------------------------------------------------------
// Story native:01KW5W081X3TJPQBCYF3WAK9RZ AC3 — derived BMad markers reach the
// reviewer's classifier through the manifest-to-reviewer data flow.
//
// A BMad source story carries NO inline `vitest:`/`artifact:` markers, so before
// this story every BMad AC classified manual-check-required and the verdict
// stalled. This integration test builds a real BMad workspace, scans it (so the
// manifest carries the derived markers — AC1), and runs `runReviewerSession`
// against it, asserting each derived-marker AC classifies runnable-artifact /
// runnable-vitest (NOT manual-check-required), while a genuinely markerless AC
// still falls back to manual.
// ---------------------------------------------------------------------------

describe("Story native:01KW5W081X3TJPQBCYF3WAK9RZ AC3 — BMad derived markers reach the reviewer", () => {
  const BMAD_REF = "bmad:1.3";
  const STORIES_ROOT = "_bmad-output/planning-artifacts/stories";
  const ARTIFACT_REL = "_bmad-output/implementation-artifacts/1-3-derive-markers.md";
  const TEST_REL = "src/derive/__tests__/derived.test.ts";

  // Integration AC1 (no test reference → artifact convention), unit AC2 (its own
  // prose cites a real test → vitest), unit AC3 (no signal anywhere → stays manual).
  // The Dev Notes deliberately carry NO test path, so AC3 cannot borrow one.
  const BMAD_STORY = [
    "# Story 1.3: Derive markers",
    "",
    "Status: ready-for-dev",
    "",
    "## Story",
    "",
    "As an operator, I want derived markers, so that the reviewer does not stall.",
    "",
    "## Acceptance Criteria",
    "",
    "**AC1 (integration):**",
    "**Given** a live MCP server,",
    "**When** the adapter scans stories,",
    "**Then** the manifest is populated.",
    "",
    "**AC2:**",
    "**Given** a repo,",
    `**When** \`${TEST_REL}\` runs,`,
    "**Then** the new branch is covered.",
    "",
    "**AC3:**",
    "**Given** a subjective design call,",
    "**When** the reviewer reads it,",
    "**Then** a human must judge it.",
    "",
    "## Dev Notes",
    "",
    "AC1 is verified by its implementation-artifact doc. AC3 has no mechanical check.",
    "",
  ].join("\n");

  const TEST_FILE_CONTENTS = [
    'import { describe, it, expect } from "vitest";',
    'describe("derived", () => {',
    '  it("derived passing test", () => {',
    "    expect(true).toBe(true);",
    "  });",
    "});",
  ].join("\n");

  let bmadRoot: string;

  beforeEach(async () => {
    bmadRoot = mkdtempSync(path.join(os.tmpdir(), "flow-bmad-derive-"));

    // .flow/config.yaml — BMad adapter.
    await fs.mkdir(path.join(bmadRoot, ".flow"), { recursive: true });
    await atomicWriteFile(
      path.join(bmadRoot, ".flow", "config.yaml"),
      `adapter: bmad\nadapter_config:\n  stories_root: ${STORIES_ROOT}\n`,
    );

    // BMad source story.
    await fs.mkdir(path.join(bmadRoot, STORIES_ROOT), { recursive: true });
    await atomicWriteFile(
      path.join(bmadRoot, STORIES_ROOT, "1-3-derive-markers.md"),
      BMAD_STORY,
    );

    // The two derivation targets, present on the dev tree so scan-time resolution
    // succeeds: the implementation-artifact doc (AC1) and the unit test (AC2).
    await fs.mkdir(path.join(bmadRoot, path.dirname(ARTIFACT_REL)), { recursive: true });
    await atomicWriteFile(path.join(bmadRoot, ARTIFACT_REL), "# impl doc\n");
    await fs.mkdir(path.join(bmadRoot, path.dirname(TEST_REL)), { recursive: true });
    await atomicWriteFile(path.join(bmadRoot, TEST_REL), TEST_FILE_CONTENTS);

    // docs/standards.md
    await fs.mkdir(path.join(bmadRoot, "docs"), { recursive: true });
    await atomicWriteFile(path.join(bmadRoot, "docs", "standards.md"), FIXTURE_STANDARDS);

    __resetGhErrorMapCacheForTests();
    resetBmadAdapter();
  });

  afterEach(() => {
    rmSync(bmadRoot, { recursive: true, force: true });
    resetBmadAdapter();
  });

  const FAKE_BMAD_DIFF = `diff --git a/${TEST_REL} b/${TEST_REL}
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/${TEST_REL}
@@ -0,0 +1 @@
+test
`;

  /**
   * Stub that materialises a worktree containing the derived targets directly (the
   * artifact doc, the unit test, and a package.json + lockfile so the vitest runner
   * resolves a package root and the install runs). Avoids recursive copy so the
   * worktree, which lives under bmadRoot, cannot copy itself.
   */
  function makeBmadStub() {
    return vi.fn().mockImplementation(
      async (cmd: string, args: string[]) => {
        const argv = args as string[];

        // Worktree dependency install (lockfile present) → succeed.
        if (cmd === "pnpm" && argv[0] === "install") {
          return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
        }

        if (cmd === "gh") {
          if (argv.includes("diff")) {
            return { stdout: FAKE_BMAD_DIFF, stderr: "", exitCode: 0, timedOut: false };
          }
          if (argv.includes("headRefName,headRefOid")) {
            return {
              stdout: JSON.stringify({
                headRefName: "pr-head",
                headRefOid: "aabbccddaabbccddaabbccddaabbccddaabbccdd",
              }),
              stderr: "",
              exitCode: 0,
              timedOut: false,
            };
          }
          // pr-view --json commits (risk-tier) and any other gh call.
          return { stdout: '["feat: derive markers"]', stderr: "", exitCode: 0, timedOut: false };
        }

        if (cmd === "git") {
          if (argv[0] === "worktree" && argv[1] === "add") {
            const worktreePath = argv[2]!;
            await fs.mkdir(path.join(worktreePath, path.dirname(ARTIFACT_REL)), { recursive: true });
            await fs.writeFile(path.join(worktreePath, ARTIFACT_REL), "# impl doc\n");
            await fs.mkdir(path.join(worktreePath, path.dirname(TEST_REL)), { recursive: true });
            await fs.writeFile(path.join(worktreePath, TEST_REL), TEST_FILE_CONTENTS);
            await fs.writeFile(
              path.join(worktreePath, "package.json"),
              JSON.stringify({ name: "bmad-fixture", version: "0.0.0", private: true }),
            );
            await fs.writeFile(path.join(worktreePath, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
            return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
          }
          if (argv[0] === "worktree" && argv[1] === "remove") {
            const removePath = argv[2];
            if (removePath) {
              await fs.rm(removePath, { recursive: true, force: true }).catch(() => {});
            }
            return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
          }
          return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
        }

        if (cmd === "pnpm") {
          // vitest run — a realistic passing summary so the zero-executed guard is satisfied.
          return {
            stdout: "\n Test Files  1 passed (1)\n      Tests  1 passed (1)\n",
            stderr: "",
            exitCode: 0,
            timedOut: false,
          };
        }

        return { stdout: "", stderr: `unexpected command: ${cmd}`, exitCode: 1, timedOut: false };
      },
    ) as unknown as typeof import("execa").execa;
  }

  it("scan persists derived markers and the reviewer classifies them runnable (artifact + vitest), not manual", async () => {
    // --- AC1: scan persists the derived markers into the to-do manifest. ---
    await scanSources({ targetRepoRoot: bmadRoot });
    const manifestPath = path.join(bmadRoot, ".flow", "state", "to-do", `${BMAD_REF}.yaml`);
    const manifestText = await fs.readFile(manifestPath, "utf8");
    // AC1 integration → artifact convention; AC2 unit → vitest from the cited test.
    expect(manifestText).toContain(`type: artifact`);
    expect(manifestText).toContain(ARTIFACT_REL);
    expect(manifestText).toContain(`type: vitest`);
    expect(manifestText).toContain(TEST_REL);

    // --- AC3: the reviewer classifies derived markers as runnable, not manual. ---
    const result = await runReviewerSession({
      targetRepoRoot: bmadRoot,
      sessionUlid: "01HZSESSION0000000000BMADREV",
      ref: BMAD_REF,
      prNumber: 7,
      execaImpl: makeBmadStub(),
    });

    const ac1 = result.acResults[1]!;
    expect(ac1.applicability).toBe("runnable-artifact-check");
    if (ac1.applicability === "runnable-artifact-check") {
      expect(ac1.status).toBe("pass");
    }
    const ac2 = result.acResults[2]!;
    expect(ac2.applicability).toBe("runnable-vitest");
    if (ac2.applicability === "runnable-vitest") {
      expect(ac2.status).toBe("pass");
    }
    // AC3 had no derivable signal → it must still fall back to manual verification.
    expect(result.acResults[3]!.applicability).toBe("manual-check-required");
  });
});
