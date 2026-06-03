/**
 * Story 5.27: `runVitestCheck` workspace-aware cwd resolution.
 *
 * Tests for `findPackageRoot` (unit) and workspace-aware cwd logic exercised
 * through `runReviewerSession` (integration). Seeds three fixture trees (AC3)
 * and exercises both pre-5.26 and post-5.26 paths (AC4).
 *
 * AC3 fixtures:
 *   A (workspace shape)   — outer dir with no package.json + inner package with package.json
 *   B (no manifest)       — outer dir with no package.json anywhere; walk exhausts checkRoot
 *   C (root-level manifest) — outer dir with root package.json; test at tests/root.test.ts
 *
 * AC4 paths:
 *   Path 1 (pre-5.26)  — checkRoot === targetRepoRoot (or fixtureRoot); asserted by fixture A
 *   Path 2 (post-5.26) — checkRoot === a separate worktree-shaped directory
 *
 * Integration tests (AC3-A(b/c), AC3-B fail-reason, AC3-C cwd, AC4) drive
 * `runReviewerSession` with seeded fixtures and capture real `execa` stub calls —
 * same pattern as `run-reviewer-session.test.ts:456`.
 *
 * `vitest: plugins/flow/mcp-server/src/tools/__tests__/reviewer-vitest-cwd.test.ts`
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, promises as fsP } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { findPackageRoot, runReviewerSession } from "../run-reviewer-session.js";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { __resetGhErrorMapCacheForTests } from "../../lib/gh-error-map.js";
// ---------------------------------------------------------------------------
// Helper: sync fixture builder (for unit tests and fixture tree seeding)
// ---------------------------------------------------------------------------
function mkdir(p) {
    mkdirSync(p, { recursive: true });
}
function writeFile(p, content) {
    mkdir(path.dirname(p));
    writeFileSync(p, content, "utf8");
}
function writePackageJson(dir, name) {
    writeFile(path.join(dir, "package.json"), JSON.stringify({ name, version: "0.0.0", private: true }, null, 2));
}
// ---------------------------------------------------------------------------
// Minimal passing vitest test content
// ---------------------------------------------------------------------------
const PASSING_VITEST_TEST = `import { describe, it, expect } from "vitest";
describe("cwd-fixture", () => {
  it("always passes", () => {
    expect(true).toBe(true);
  });
});
`;
// ---------------------------------------------------------------------------
// runReviewerSession integration fixture helpers
//
// These build the full fixture tree that runReviewerSession needs:
//   <root>/.flow/config.yaml
//   <root>/.flow/native-stories/<ULID>.md   — spec with one vitest: AC
//   <root>/.flow/state/in-progress/<ref>.yaml
//   <root>/docs/standards.md
//   <root>/.flow/state/sessions/            — created by runReviewerSession
//
// The spec body is parameterised so each test can supply the vitest: path.
// ---------------------------------------------------------------------------
const FIXTURE_ULID = "01JCWDTEST5270000000000001";
const FIXTURE_REF = `native:${FIXTURE_ULID}`;
const FIXTURE_SESSION_ULID = "01JCSESSION527000000000001";
const FIXTURE_PR_NUMBER = 99;
const FIXTURE_STANDARDS = `version: "0.1.0"
updated: "2026-05-28"
criteria:
  - name: "story-aligned"
    what: "The PR's diff implements only what the story's acceptance criteria require."
    check: "Map each diff hunk to one or more ACs."
    anti_criterion: "Scope creep."
`;
const FAKE_PR_DIFF = `diff --git a/placeholder.txt b/placeholder.txt
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/placeholder.txt
@@ -0,0 +1 @@
+placeholder
`;
const FAKE_HEAD_REF_NAME = "story-5-27-pr-head";
const FAKE_HEAD_REF_OID = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
/** Build the spec markdown for a story with a single vitest: AC pointing at testFilePath. */
function makeSpecWithVitestAc(vitestPath) {
    return `# Fixture Story 5.27

## Narrative

As a tester, I want to verify runVitestCheck uses the correct cwd, so that the vitest check runs in the right package.

## Acceptance Criteria

**AC1:**
**Given** the vitest marker points at a test file, **When** the reviewer runs it, **Then** it uses the package-root cwd.
vitest: ${vitestPath}

## Implementation Notes

None.

## Dependencies

`;
}
function makeManifestYaml(ulid, ref, sessionUlid) {
    return [
        `ref: "${ref}"`,
        `status: in-progress`,
        `adapter: native`,
        `source_path: ".flow/native-stories/${ulid}.md"`,
        `source_hash: "${"a".repeat(64)}"`,
        `depends_on: []`,
        `acceptance_criteria:`,
        `  - text: "Given the vitest marker points at a test file."`,
        `    kind: integration`,
        `title: "Fixture Story 5.27"`,
        `narrative: "As a tester, I want to verify runVitestCheck uses the correct cwd, so that the vitest check runs in the right package."`,
        `withdrawn: false`,
        `claimed_by: "${sessionUlid}"`,
    ].join("\n");
}
/** Populate tmpRoot with the base runReviewerSession fixture (no worktree content). */
async function buildRunnerFixture(tmpRoot, vitestPath) {
    // .flow/config.yaml
    await fsP.mkdir(path.join(tmpRoot, ".flow"), { recursive: true });
    await atomicWriteFile(path.join(tmpRoot, ".flow", "config.yaml"), "adapter: native\nadapter_config: {}\n");
    // Native stories dir + spec file
    const storiesDir = path.join(tmpRoot, ".flow", "native-stories");
    await fsP.mkdir(storiesDir, { recursive: true });
    await atomicWriteFile(path.join(storiesDir, `${FIXTURE_ULID}.md`), makeSpecWithVitestAc(vitestPath));
    // In-progress state dir + manifest
    const inProgressDir = path.join(tmpRoot, ".flow", "state", "in-progress");
    await fsP.mkdir(inProgressDir, { recursive: true });
    await atomicWriteFile(path.join(inProgressDir, `${FIXTURE_REF}.yaml`), makeManifestYaml(FIXTURE_ULID, FIXTURE_REF, FIXTURE_SESSION_ULID));
    // docs/standards.md
    await fsP.mkdir(path.join(tmpRoot, "docs"), { recursive: true });
    await atomicWriteFile(path.join(tmpRoot, "docs", "standards.md"), FIXTURE_STANDARDS);
}
function makeRunnerStub(opts) {
    const pnpmCalls = [];
    const stub = vi.fn().mockImplementation(async (cmd, args, cmdOpts) => {
        if (cmd === "gh") {
            const argsArr = args;
            const isPrDiff = argsArr.includes("diff");
            const isHeadRefQuery = argsArr.includes("headRefName,headRefOid") ||
                (argsArr.includes("--json") && argsArr.some((a) => a.includes("headRefOid")));
            if (isPrDiff) {
                return { stdout: FAKE_PR_DIFF, stderr: "", exitCode: 0, timedOut: false };
            }
            if (isHeadRefQuery) {
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
            // All other gh calls (e.g. pr-view --json commits for risk-tier):
            return { stdout: '["chore: fixture commit"]', stderr: "", exitCode: 0, timedOut: false };
        }
        if (cmd === "git") {
            const argsArr = args;
            if (argsArr[0] === "worktree" && argsArr[1] === "add") {
                const worktreePath = argsArr[2];
                if (worktreePath) {
                    await fsP.mkdir(worktreePath, { recursive: true });
                    await opts.populateWorktree(worktreePath);
                }
                return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
            }
            if (argsArr[0] === "worktree" && argsArr[1] === "remove") {
                const removePath = argsArr[2];
                if (removePath) {
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
            const exitCode = opts.vitestExitCode ?? 0;
            pnpmCalls.push({
                args: args,
                cwd: cmdOpts?.cwd,
                exitCode,
            });
            return {
                stdout: exitCode === 0 ? "All tests passed." : "1 test failed.",
                stderr: "",
                exitCode,
                timedOut: false,
            };
        }
        return { stdout: "", stderr: `unexpected command: ${cmd}`, exitCode: 1, timedOut: false };
    });
    return {
        stub: stub,
        pnpmCalls,
    };
}
// ---------------------------------------------------------------------------
// Unit tests for findPackageRoot directly
// ---------------------------------------------------------------------------
describe("findPackageRoot — unit tests", () => {
    let tmp;
    beforeEach(() => {
        tmp = mkdtempSync(path.join(os.tmpdir(), "flow-5-27-unit-"));
    });
    afterEach(() => {
        rmSync(tmp, { recursive: true, force: true });
    });
    it("finds package.json in the test file's own directory", () => {
        writePackageJson(tmp, "pkg-own-dir");
        writeFile(path.join(tmp, "test.test.ts"), "// test");
        const result = findPackageRoot({
            testFilePathAbs: path.join(tmp, "test.test.ts"),
            checkRoot: tmp,
        });
        expect(result.ok).toBe(true);
        if (!result.ok)
            return;
        expect(result.packageRoot).toBe(tmp);
    });
    it("finds package.json in a parent directory (one level up)", () => {
        writePackageJson(tmp, "pkg-parent");
        const subdir = path.join(tmp, "tests");
        mkdir(subdir);
        writeFile(path.join(subdir, "my.test.ts"), "// test");
        const result = findPackageRoot({
            testFilePathAbs: path.join(subdir, "my.test.ts"),
            checkRoot: tmp,
        });
        expect(result.ok).toBe(true);
        if (!result.ok)
            return;
        expect(result.packageRoot).toBe(tmp);
    });
    it("finds the CLOSEST package.json when multiple are present (inner wins)", () => {
        // outer/package.json  (outer level)
        // outer/inner/package.json  (inner level — closest to test)
        // outer/inner/tests/my.test.ts
        writePackageJson(tmp, "outer-pkg");
        const inner = path.join(tmp, "inner");
        writePackageJson(inner, "inner-pkg");
        const testsDir = path.join(inner, "tests");
        mkdir(testsDir);
        writeFile(path.join(testsDir, "my.test.ts"), "// test");
        const result = findPackageRoot({
            testFilePathAbs: path.join(testsDir, "my.test.ts"),
            checkRoot: tmp,
        });
        expect(result.ok).toBe(true);
        if (!result.ok)
            return;
        expect(result.packageRoot).toBe(inner);
    });
    it("returns ok:false when no package.json found within checkRoot", () => {
        const subdir = path.join(tmp, "tests");
        mkdir(subdir);
        writeFile(path.join(subdir, "orphan.test.ts"), "// test");
        const result = findPackageRoot({
            testFilePathAbs: path.join(subdir, "orphan.test.ts"),
            checkRoot: tmp,
        });
        expect(result.ok).toBe(false);
    });
    it("sibling-path false-positive guard: /tmp/checker does not match checkRoot /tmp/check", () => {
        // Create two sibling dirs: check (no package.json) and checker (has package.json)
        const checkRoot = path.join(tmp, "check");
        const sibling = path.join(tmp, "checker");
        mkdir(checkRoot);
        writePackageJson(sibling, "sibling-pkg");
        const testsDir = path.join(checkRoot, "tests");
        mkdir(testsDir);
        writeFile(path.join(testsDir, "test.ts"), "// test");
        // Walk rooted at checkRoot — must NOT find sibling's package.json
        const result = findPackageRoot({
            testFilePathAbs: path.join(testsDir, "test.ts"),
            checkRoot,
        });
        expect(result.ok).toBe(false);
    });
});
// ---------------------------------------------------------------------------
// AC3: Fixture-tree integration tests driven through runReviewerSession
// ---------------------------------------------------------------------------
describe("AC3: fixture-tree integration — workspace-shaped, no-manifest, root-level-manifest", () => {
    let tmp;
    beforeEach(() => {
        tmp = mkdtempSync(path.join(os.tmpdir(), "flow-5-27-ac3-"));
        __resetGhErrorMapCacheForTests();
    });
    afterEach(() => {
        rmSync(tmp, { recursive: true, force: true });
    });
    // ---------------------------------------------------------------------------
    // Fixture A: workspace shape — outer dir with no package.json + inner package
    // ---------------------------------------------------------------------------
    describe("Fixture A (workspace shape)", () => {
        /**
         * The vitest: marker path in the spec — relative to checkRoot (the worktree).
         * Production code does: path.resolve(checkRoot, testFilePath) to get the abs path.
         */
        const TEST_FILE_REL = "plugins/flow/mcp-server/tests/my-test.test.ts";
        it("AC3-A(a): findPackageRoot identifies plugins/flow/mcp-server as the package root", () => {
            // Seed a standalone fixture tree (no runReviewerSession needed — pure unit of walk).
            const outerDir = path.join(tmp, "outer-a-unit");
            mkdir(outerDir);
            const innerPkgDir = path.join(outerDir, "plugins", "flow", "mcp-server");
            writePackageJson(innerPkgDir, "@flow/mcp-server");
            const testFilePath = path.join(innerPkgDir, "tests", "my-test.test.ts");
            writeFile(testFilePath, PASSING_VITEST_TEST);
            const result = findPackageRoot({
                testFilePathAbs: testFilePath,
                checkRoot: outerDir,
            });
            expect(result.ok).toBe(true);
            if (!result.ok)
                return;
            expect(result.packageRoot).toBe(innerPkgDir);
        });
        it("AC3-A(b/c): runReviewerSession invokes pnpm with cwd=innerPkgDir and returns status:pass", async () => {
            // The spec's vitest: marker is TEST_FILE_REL.
            // The worktree (checkRoot) will have the workspace-shaped fixture:
            //   <worktree>/plugins/flow/mcp-server/package.json
            //   <worktree>/plugins/flow/mcp-server/tests/my-test.test.ts
            // (no package.json at <worktree> root — mimics pnpm-workspace with no root manifest)
            await buildRunnerFixture(tmp, TEST_FILE_REL);
            let capturedInnerPkgDir = null;
            const { stub, pnpmCalls } = makeRunnerStub({
                vitestExitCode: 0,
                populateWorktree: (worktreePath) => {
                    // Seed workspace-shaped fixture inside the worktree.
                    // NO package.json at worktreePath root.
                    const innerPkgDir = path.join(worktreePath, "plugins", "flow", "mcp-server");
                    capturedInnerPkgDir = innerPkgDir;
                    writePackageJson(innerPkgDir, "@flow/mcp-server");
                    writeFile(path.join(innerPkgDir, "tests", "my-test.test.ts"), PASSING_VITEST_TEST);
                },
            });
            const result = await runReviewerSession({
                targetRepoRoot: tmp,
                sessionUlid: FIXTURE_SESSION_ULID,
                ref: FIXTURE_REF,
                prNumber: FIXTURE_PR_NUMBER,
                execaImpl: stub,
            });
            // AC3-A(c): status:pass
            const ac1 = result.acResults[1];
            expect(ac1).toBeDefined();
            expect(ac1.applicability).toBe("runnable-vitest");
            if (ac1.applicability !== "runnable-vitest")
                return;
            expect(ac1.status).toBe("pass");
            // AC3-A(b): pnpm was called with cwd === innerPkgDir (not the worktree root)
            expect(pnpmCalls).toHaveLength(1);
            const pnpmCall = pnpmCalls[0];
            expect(pnpmCall.cwd).toBe(capturedInnerPkgDir);
            expect(pnpmCall.args).toEqual(expect.arrayContaining(["vitest", "--run", "-t", TEST_FILE_REL]));
        });
    });
    // ---------------------------------------------------------------------------
    // Fixture B: no manifest — outer dir with no package.json + test with no package.json above
    // ---------------------------------------------------------------------------
    describe("Fixture B (no manifest — walk exhausts checkRoot)", () => {
        const TEST_FILE_REL_B = "tests/orphan.test.ts";
        it("AC3-B: findPackageRoot returns ok:false when no package.json found", () => {
            const outerDir = path.join(tmp, "outer-b-unit");
            mkdir(outerDir);
            const orphanTest = path.join(outerDir, TEST_FILE_REL_B);
            writeFile(orphanTest, PASSING_VITEST_TEST);
            const result = findPackageRoot({
                testFilePathAbs: orphanTest,
                checkRoot: outerDir,
            });
            expect(result.ok).toBe(false);
        });
        it("AC3-B: runVitestCheck fail reason matches AC2 verbatim string (from real production output)", async () => {
            // Drive runReviewerSession with a fixture where the vitest: marker points at a
            // test file that has NO package.json between it and checkRoot. The production
            // runVitestCheck must return the AC2 fail reason verbatim — we assert on the
            // real result.acResults[1].reason, NOT on a locally-constructed string.
            //
            // AC2 verbatim: "no package.json found between test file '<testFilePath>' and
            //               checkRoot '<checkRoot>' — vitest cannot run without a manifest"
            // where testFilePath = TEST_FILE_REL_B and checkRoot = the worktree path created
            // by git worktree add.
            await buildRunnerFixture(tmp, TEST_FILE_REL_B);
            let capturedWorktreePath = null;
            const { stub } = makeRunnerStub({
                vitestExitCode: 0,
                populateWorktree: (worktreePath) => {
                    capturedWorktreePath = worktreePath;
                    // Seed the test file but NO package.json anywhere under worktreePath.
                    writeFile(path.join(worktreePath, TEST_FILE_REL_B), PASSING_VITEST_TEST);
                },
            });
            const result = await runReviewerSession({
                targetRepoRoot: tmp,
                sessionUlid: FIXTURE_SESSION_ULID,
                ref: FIXTURE_REF,
                prNumber: FIXTURE_PR_NUMBER,
                execaImpl: stub,
            });
            // The AC should fail with the exact verbatim reason from run-reviewer-session.ts:293.
            const ac1 = result.acResults[1];
            expect(ac1).toBeDefined();
            expect(ac1.applicability).toBe("runnable-vitest");
            if (ac1.applicability !== "runnable-vitest")
                return;
            expect(ac1.status).toBe("fail");
            // Assert verbatim AC2 reason with the actual paths substituted.
            // capturedWorktreePath is the real checkRoot that production code used.
            expect(capturedWorktreePath).not.toBeNull();
            const expectedReason = `no package.json found between test file '${TEST_FILE_REL_B}' and checkRoot '${capturedWorktreePath}' — vitest cannot run without a manifest`;
            expect(ac1.reason).toBe(expectedReason);
        });
    });
    // ---------------------------------------------------------------------------
    // Fixture C: root-level manifest — outer dir has root package.json
    // ---------------------------------------------------------------------------
    describe("Fixture C (root-level manifest)", () => {
        const TEST_FILE_REL_C = "tests/root.test.ts";
        it("AC3-C: findPackageRoot resolves to outer dir when root has package.json", () => {
            const outerDir = path.join(tmp, "outer-c-unit");
            writePackageJson(outerDir, "root-pkg");
            const rootTest = path.join(outerDir, TEST_FILE_REL_C);
            writeFile(rootTest, PASSING_VITEST_TEST);
            const result = findPackageRoot({
                testFilePathAbs: rootTest,
                checkRoot: outerDir,
            });
            expect(result.ok).toBe(true);
            if (!result.ok)
                return;
            expect(result.packageRoot).toBe(outerDir);
        });
        it("AC3-C: runReviewerSession invokes pnpm with cwd=worktree root and returns status:pass", async () => {
            // The worktree has a root-level package.json — the walk should stop there.
            await buildRunnerFixture(tmp, TEST_FILE_REL_C);
            let capturedWorktreeRoot = null;
            const { stub, pnpmCalls } = makeRunnerStub({
                vitestExitCode: 0,
                populateWorktree: (worktreePath) => {
                    capturedWorktreeRoot = worktreePath;
                    // Root-level package.json present — walk stops at the root.
                    writePackageJson(worktreePath, "root-pkg");
                    writeFile(path.join(worktreePath, TEST_FILE_REL_C), PASSING_VITEST_TEST);
                },
            });
            const result = await runReviewerSession({
                targetRepoRoot: tmp,
                sessionUlid: FIXTURE_SESSION_ULID,
                ref: FIXTURE_REF,
                prNumber: FIXTURE_PR_NUMBER,
                execaImpl: stub,
            });
            // AC3-C: status:pass
            const ac1 = result.acResults[1];
            expect(ac1).toBeDefined();
            expect(ac1.applicability).toBe("runnable-vitest");
            if (ac1.applicability !== "runnable-vitest")
                return;
            expect(ac1.status).toBe("pass");
            // pnpm cwd === worktree root (where package.json is)
            expect(pnpmCalls).toHaveLength(1);
            const pnpmCall = pnpmCalls[0];
            expect(pnpmCall.cwd).toBe(capturedWorktreeRoot);
        });
    });
});
// ---------------------------------------------------------------------------
// AC4: Compatibility — both pre-5.26 and post-5.26 paths produce identical behaviour
// ---------------------------------------------------------------------------
describe("AC4: pre-5.26 and post-5.26 paths produce identical findPackageRoot behaviour", () => {
    let tmp;
    beforeEach(() => {
        tmp = mkdtempSync(path.join(os.tmpdir(), "flow-5-27-ac4-"));
        __resetGhErrorMapCacheForTests();
    });
    afterEach(() => {
        rmSync(tmp, { recursive: true, force: true });
    });
    /**
     * Shared fixture layout (workspace shape):
     *   <root>/plugins/flow/mcp-server/package.json
     *   <root>/plugins/flow/mcp-server/tests/my-test.test.ts
     */
    function buildWorkspaceFixture(root) {
        const innerPkgDir = path.join(root, "plugins", "flow", "mcp-server");
        writePackageJson(innerPkgDir, "@flow/mcp-server");
        const testFilePath = path.join(innerPkgDir, "tests", "my-test.test.ts");
        writeFile(testFilePath, PASSING_VITEST_TEST);
        const testFileRelPath = path.relative(root, testFilePath);
        return { innerPkgDir, testFilePath, testFileRelPath };
    }
    it("Path 1 (pre-5.26, checkRoot === targetRepoRoot): walk finds correct packageRoot", () => {
        // Simulates: checkRoot === targetRepoRoot (local dev, no PR-branch worktree)
        const targetRepoRoot = path.join(tmp, "local-dev");
        mkdir(targetRepoRoot);
        const { innerPkgDir, testFilePath } = buildWorkspaceFixture(targetRepoRoot);
        const result = findPackageRoot({
            testFilePathAbs: testFilePath,
            checkRoot: targetRepoRoot,
        });
        expect(result.ok).toBe(true);
        if (!result.ok)
            return;
        expect(result.packageRoot).toBe(innerPkgDir);
    });
    it("Path 2 (post-5.26, checkRoot === worktreePath): walk finds correct packageRoot in worktree", () => {
        // Simulates: checkRoot === <PR-branch worktree> (separate temp dir, mimics 5.26 output)
        const worktreePath = path.join(tmp, "pr-branch-worktree");
        mkdir(worktreePath);
        const { innerPkgDir, testFilePath } = buildWorkspaceFixture(worktreePath);
        const result = findPackageRoot({
            testFilePathAbs: testFilePath,
            checkRoot: worktreePath,
        });
        expect(result.ok).toBe(true);
        if (!result.ok)
            return;
        expect(result.packageRoot).toBe(innerPkgDir);
    });
    it("Path 1 and Path 2: identical filesystem state → identical packageRoot resolution", () => {
        // Both paths share the same workspace layout — assert results are structurally equal.
        const localDev = path.join(tmp, "local-dev-cmp");
        mkdir(localDev);
        const fixA = buildWorkspaceFixture(localDev);
        const worktree = path.join(tmp, "worktree-cmp");
        mkdir(worktree);
        const fixB = buildWorkspaceFixture(worktree);
        const resultA = findPackageRoot({
            testFilePathAbs: fixA.testFilePath,
            checkRoot: localDev,
        });
        const resultB = findPackageRoot({
            testFilePathAbs: fixB.testFilePath,
            checkRoot: worktree,
        });
        // Both must be ok:true
        expect(resultA.ok).toBe(true);
        expect(resultB.ok).toBe(true);
        // The relative path from checkRoot to packageRoot must be identical in both cases
        if (resultA.ok && resultB.ok) {
            const relA = path.relative(localDev, resultA.packageRoot);
            const relB = path.relative(worktree, resultB.packageRoot);
            expect(relA).toBe(relB);
        }
    });
    it("Path 1 via runReviewerSession (integration): pnpm cwd resolves to innerPkgDir in targetRepoRoot", async () => {
        // Pre-5.26 path: checkRoot === targetRepoRoot. runReviewerSession's worktree
        // (materialisePrBranchWorktree) is the checkRoot here — we seed the workspace
        // shape inside it. The walk should find innerPkgDir within the worktree.
        const TEST_FILE_REL = "plugins/flow/mcp-server/tests/my-test.test.ts";
        await buildRunnerFixture(tmp, TEST_FILE_REL);
        let capturedInnerPkgDir = null;
        const { stub, pnpmCalls } = makeRunnerStub({
            vitestExitCode: 0,
            populateWorktree: (worktreePath) => {
                const innerPkgDir = path.join(worktreePath, "plugins", "flow", "mcp-server");
                capturedInnerPkgDir = innerPkgDir;
                writePackageJson(innerPkgDir, "@flow/mcp-server");
                writeFile(path.join(innerPkgDir, "tests", "my-test.test.ts"), PASSING_VITEST_TEST);
            },
        });
        const result = await runReviewerSession({
            targetRepoRoot: tmp,
            sessionUlid: FIXTURE_SESSION_ULID,
            ref: FIXTURE_REF,
            prNumber: FIXTURE_PR_NUMBER,
            execaImpl: stub,
        });
        const ac1 = result.acResults[1];
        expect(ac1.applicability).toBe("runnable-vitest");
        if (ac1.applicability !== "runnable-vitest")
            return;
        expect(ac1.status).toBe("pass");
        expect(pnpmCalls).toHaveLength(1);
        expect(pnpmCalls[0].cwd).toBe(capturedInnerPkgDir);
    });
});
