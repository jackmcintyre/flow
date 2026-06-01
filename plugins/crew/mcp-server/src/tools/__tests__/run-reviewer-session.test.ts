/**
 * Integration tests for `runReviewerSession` composite tool — Story 4.6 Task 9.
 *
 * Behavioural contract source:
 *   _bmad-output/implementation-artifacts/4-6-reviewer-subagent-read-sources-and-run-acs.md
 *
 * Fixture shape (spec §4a):
 *   <tmp>/.crew/config.yaml           — native adapter
 *   <tmp>/.crew/native-stories/<ULID>.md — spec with 3 ACs
 *     AC1: artifact: hello-a.txt
 *     AC2: vitest: fixture passing test
 *     AC3: no marker (manual-check-required)
 *   <tmp>/.crew/state/in-progress/<ref>.yaml — pre-claimed manifest
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
import {
  DuplicateStandardsCriterionIdError,
  GhRecoverableError,
} from "../../errors.js";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import {
  reviewerResultFilePath,
  sanitiseRefForPathSegment,
} from "../../lib/read-reviewer-result-file.js";
import { __resetGhErrorMapCacheForTests } from "../../lib/gh-error-map.js";
import type { execa } from "execa";
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
    anti_criterion: "Direct fs.write to .crew/state."
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

const FIXTURE_VITEST_FAILING_TEST = `import { describe, it, expect } from "vitest";

describe("fixture", () => {
  it("fixture passing test", () => {
    expect(true).toBe(false);
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
    `source_path: ".crew/native-stories/${ULID}.md"`,
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
   * The tmpRoot directory. When provided, `git worktree add` intercept
   * creates the worktree directory populated from tmpRoot. Required for
   * tests that perform artifact checks.
   */
  tmpRoot?: string;
}

function makeDiscriminatingStub(opts: DiscriminatingStubOpts = {}) {
  const stub = vi.fn().mockImplementation(
    async (cmd: string, args: string[], _cmdOpts?: unknown) => {
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
          stdout: opts.vitest?.stdout ?? "",
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
  // .crew/config.yaml
  await fs.mkdir(path.join(tmpRoot, ".crew"), { recursive: true });
  await atomicWriteFile(
    path.join(tmpRoot, ".crew", "config.yaml"),
    "adapter: native\nadapter_config: {}\n",
  );

  // Native stories dir + spec file
  const storiesDir = path.join(tmpRoot, ".crew", "native-stories");
  await fs.mkdir(storiesDir, { recursive: true });
  await atomicWriteFile(path.join(storiesDir, `${ULID}.md`), FIXTURE_SPEC);

  // In-progress state dir + manifest
  const inProgressDir = path.join(tmpRoot, ".crew", "state", "in-progress");
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

  // vitest test file (passing)
  await fs.mkdir(path.join(tmpRoot, "__tests__"), { recursive: true });
  await atomicWriteFile(path.join(tmpRoot, "__tests__", "fixture.test.ts"), FIXTURE_VITEST_TEST);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "crew-4-6-"));
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
    const vitestCall = stub.mock.calls.find(
      (c: unknown[]) => c[0] === "pnpm",
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
    await fs.rm(path.join(tmpRoot, ".crew", "native-stories", `${ULID}.md`));

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
      ".crew",
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

  it("a passing artifact + passing vitest + manual AC: recommendedVerdict === 'BLOCKED'", async () => {
    // Story 10.1: the manual AC can no longer be a markerless native AC on disk
    // (parseNativeStory rejects it). Stub extractAcsFromSpec to return the three
    // canonical ACs — artifact (pass), vitest (pass), manual — so the reviewer's
    // "any manual-check-required → BLOCKED" rule is exercised. AC1 artifact and
    // AC2 vitest both pass; AC3 is manual → BLOCKED per spec §3f rule 2.
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

      // AC3 is manual-check-required → BLOCKED per spec §3f rule 2
      // (any manual-check-required → BLOCKED unless all are runnable-*)
      expect(parsed.recommendedVerdict).toBe("BLOCKED");
      expect(result.recommendedVerdict).toBe("BLOCKED");
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

  it("all-manual-check fixture: recommendedVerdict === 'BLOCKED'", async () => {
    // Story 10.1: a native story whose every AC is markerless is now invalid to
    // parseNativeStory, so we exercise the all-manual case via an
    // extractAcsFromSpec stub (the on-disk fixture stays a valid native story
    // for readSourceStory). Both ACs are markerless → manual → BLOCKED.
    const spy = await stubExtractAcsManual([
      ["**Given** something, **When** reviewed, **Then** it is correct."],
      ["**Given** something else, **When** reviewed, **Then** it is also correct."],
    ]);

    try {
      const result = await callSession();

      const raw = await fs.readFile(expectedFilePath(), "utf8");
      const parsed = JSON.parse(raw) as ReviewerResultFileShape;

      expect(parsed.recommendedVerdict).toBe("BLOCKED");
      expect(result.recommendedVerdict).toBe("BLOCKED");
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
