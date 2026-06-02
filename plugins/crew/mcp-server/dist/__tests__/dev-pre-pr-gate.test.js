/**
 * Pre-PR full build-and-test gate — Story native:01KT3ER5E9ACCERHAEJ5NM94TH.
 *
 * `runDevTerminalAction` now runs the project's full BUILD AND TESTS
 * (the same whole-project check CI runs) AFTER the commit and BEFORE
 * `gh pr create`. A failing test suite raises `PrePrTestFailedError` and NO
 * pull request is opened; a green build+test run opens the PR.
 *
 * These tests drive the tool with a stubbed command runner (`execaImpl`) so
 * we can assert the ordered command stream without spawning a real build:
 *
 *   AC1 (integration) — on a green build+test run: the PR that is opened is
 *         created after both pnpm build AND pnpm test pass; verified by
 *         asserting both commands appear in the stream before pr-create.
 *
 *   AC2 (unit) — on a failing test suite (non-zero exit from pnpm test):
 *         gh pr create is NOT called and a structured `PrePrTestFailedError`
 *         surfacing the exit code + captured output is raised instead.
 *         Also verified: a failing build (AC2b) still blocks PR creation via
 *         `PrePrBuildFailedError`.
 *
 * @see _bmad-output/implementation-artifacts/native:01KT3ER5E9ACCERHAEJ5NM94TH.md
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execa as realExeca } from "execa";
import { stringify as yamlStringify } from "yaml";
import { atomicWriteFile } from "../lib/managed-fs.js";
import { runDevTerminalAction } from "../tools/run-dev-terminal-action.js";
import { PrePrBuildFailedError, PrePrTestFailedError } from "../errors.js";
import { PROJECT_BUILD_COMMAND, PROJECT_BUILD_ARGS, PROJECT_TEST_COMMAND, PROJECT_TEST_ARGS, } from "../lib/run-project-build.js";
// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const REF = "native:01KT3ER5E9ACCERHAEJ5NM94TH";
const TITLE = "Require a fully green build-and-test run before the builder opens a pull request";
const TYPE = "feat";
const BODY = "Adds a test gate to the pre-PR sequence so a red test suite blocks PR creation.";
const SUMMARY = "Pre-PR build-and-test gate.";
const FAKE_PR_URL = "https://github.com/owner/repo/pull/9999";
const SESSION_ULID = "01HZSESSION0000000000GATE1";
const SOURCE_HASH = "c".repeat(64);
const FIXTURE_SPEC = `
# Story: Pre-PR build-and-test gate

Status: ready-for-dev

## Acceptance Criteria

**AC1 (integration):**
Given a green build and test run, the PR opens with no red commits.

**AC2 (unit):**
Given a failing test suite, gh pr create is not called and failure is reported.
`;
async function setupRepo() {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-pre-pr-gate-"));
    await realExeca("git", ["-C", repoRoot, "init"]);
    await realExeca("git", ["-C", repoRoot, "config", "user.email", "test@test.com"]);
    await realExeca("git", ["-C", repoRoot, "config", "user.name", "Test User"]);
    const srcDir = path.join(repoRoot, "src");
    await fs.mkdir(srcDir, { recursive: true });
    await atomicWriteFile(path.join(srcDir, "index.ts"), "export const x = 1;\n");
    await realExeca("git", ["-C", repoRoot, "add", "."]);
    await realExeca("git", ["-C", repoRoot, "commit", "-m", "chore: initial commit"]);
    const stateDir = path.join(repoRoot, ".crew", "state", "in-progress");
    await fs.mkdir(stateDir, { recursive: true });
    const specRelPath = `_bmad-output/implementation-artifacts/native:01KT3ER5E9ACCERHAEJ5NM94TH.md`;
    const specDir = path.join(repoRoot, "_bmad-output", "implementation-artifacts");
    await fs.mkdir(specDir, { recursive: true });
    await atomicWriteFile(path.join(specDir, `native:01KT3ER5E9ACCERHAEJ5NM94TH.md`), FIXTURE_SPEC);
    const manifestPath = path.join(stateDir, `native:01KT3ER5E9ACCERHAEJ5NM94TH.yaml`);
    const manifest = {
        ref: REF,
        status: "in-progress",
        adapter: "native",
        source_path: specRelPath,
        source_hash: SOURCE_HASH,
        depends_on: [],
        acceptance_criteria: [
            { text: "AC1 text", kind: "integration" },
            { text: "AC2 text", kind: "unit" },
        ],
        title: TITLE,
        narrative: "As a team operator, I want every pull request to arrive green from its very first commit.",
        withdrawn: false,
        claimed_by: SESSION_ULID,
    };
    await atomicWriteFile(manifestPath, yamlStringify(manifest));
    // Simulate dev work done after the initial commit.
    await atomicWriteFile(path.join(srcDir, "new-feature.ts"), "export const y = 2;\n");
    return { repoRoot, manifestPath };
}
function makeStubExeca(opts) {
    return vi.fn(async (cmd, args, options) => {
        opts.recorded.push({
            cmd,
            args: [...args],
            cwd: typeof options?.cwd === "string" ? options.cwd : undefined,
        });
        if (cmd === "pnpm" && args[0] === "build") {
            if (opts.buildShouldFail) {
                return {
                    stdout: "src/sibling.ts(3,5): build stdout marker",
                    stderr: "src/sibling.ts(3,5): error TS2339: Property 'z' does not exist.",
                    exitCode: 2,
                };
            }
            return { stdout: "build ok", stderr: "", exitCode: 0 };
        }
        if (cmd === "pnpm" && args[0] === "test") {
            if (opts.testShouldFail) {
                return {
                    stdout: "FAIL src/sibling.test.ts > existing test > breaks when y is wrong",
                    stderr: "AssertionError: expected 1 to equal 2",
                    exitCode: 1,
                };
            }
            return { stdout: "All tests passed.", stderr: "", exitCode: 0 };
        }
        if (cmd === "gh") {
            return { stdout: FAKE_PR_URL, stderr: "", exitCode: 0 };
        }
        // git push must not hit the network — stub it green.
        if (cmd === "git" && args[2] === "push") {
            return { stdout: "", stderr: "", exitCode: 0 };
        }
        // Story native:01KT40THFTS10F9PT37KCW9PF4: the pre-PR sync gate runs
        // `git fetch origin` + `git rebase origin/<base>` before the build/test
        // gates. The tmpdir repo has no `origin`, so stub both green — these tests
        // exercise the build/test gates, not the sync gate.
        if (cmd === "git" && (args[2] === "fetch" || args[2] === "rebase")) {
            return { stdout: "", stderr: "", exitCode: 0 };
        }
        // Delegate real git ops (checkout/add/commit/rev-parse).
        const result = await realExeca(cmd, args, { ...options, reject: false });
        return {
            stdout: typeof result.stdout === "string" ? result.stdout : "",
            stderr: typeof result.stderr === "string" ? result.stderr : "",
            exitCode: typeof result.exitCode === "number" ? result.exitCode : 0,
        };
    });
}
/** Index of the first recorded build invocation (`pnpm build`), or -1. */
function firstBuildIdx(recorded) {
    return recorded.findIndex((c) => c.cmd === PROJECT_BUILD_COMMAND &&
        c.args[0] === PROJECT_BUILD_ARGS[0] &&
        c.args.length === PROJECT_BUILD_ARGS.length);
}
/** Index of the first recorded test invocation (`pnpm test`), or -1. */
function firstTestIdx(recorded) {
    return recorded.findIndex((c) => c.cmd === PROJECT_TEST_COMMAND &&
        c.args[0] === PROJECT_TEST_ARGS[0] &&
        c.args.length === PROJECT_TEST_ARGS.length);
}
/** Index of the first recorded PR-create invocation (`gh pr create`), or -1. */
function firstPrCreateIdx(recorded) {
    return recorded.findIndex((c) => c.cmd === "gh" && c.args.includes("pr"));
}
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
let ctx;
beforeEach(async () => {
    ctx = await setupRepo();
});
afterEach(async () => {
    await fs.rm(ctx.repoRoot, { recursive: true, force: true });
});
describe("AC1 — a green build+test run opens the PR (integration)", () => {
    it("runs build then tests then PR-create in order when both pass", async () => {
        const recorded = [];
        const spy = makeStubExeca({ buildShouldFail: false, testShouldFail: false, recorded });
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
            execaImpl: spy,
        });
        expect(result.ok).toBe(true);
        expect(result.prUrl).toBe(FAKE_PR_URL);
        // Both gates ran.
        const buildIdx = firstBuildIdx(recorded);
        const testIdx = firstTestIdx(recorded);
        const prIdx = firstPrCreateIdx(recorded);
        expect(buildIdx).toBeGreaterThanOrEqual(0);
        expect(testIdx).toBeGreaterThan(buildIdx); // test runs AFTER build
        expect(prIdx).toBeGreaterThan(testIdx); // PR-create runs AFTER tests
        // PR-create invoked exactly once.
        const ghPrCreateCalls = recorded.filter((c) => c.cmd === "gh" && c.args.includes("pr") && c.args.includes("create"));
        expect(ghPrCreateCalls).toHaveLength(1);
    });
});
describe("AC2 — a failing test suite blocks PR creation (unit)", () => {
    it("when pnpm test exits non-zero, gh pr create is not called and PrePrTestFailedError is raised", async () => {
        const recorded = [];
        const spy = makeStubExeca({ buildShouldFail: false, testShouldFail: true, recorded });
        let caught;
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
                execaImpl: spy,
            });
        }
        catch (err) {
            caught = err;
        }
        // A structured test-failure surfaced.
        expect(caught).toBeInstanceOf(PrePrTestFailedError);
        const e = caught;
        expect(e.exitCode).toBe(1);
        expect(e.stderr).toContain("AssertionError");
        expect(e.stdout).toContain("FAIL src/sibling.test.ts");
        expect(e.message).toContain("No pull request was opened");
        // The test WAS invoked.
        const testIdx = firstTestIdx(recorded);
        expect(testIdx).toBeGreaterThanOrEqual(0);
        // No PR-create step was invoked.
        const ghCalls = recorded.filter((c) => c.cmd === "gh");
        expect(ghCalls).toHaveLength(0);
    });
    it("when pnpm build exits non-zero, neither pnpm test nor gh pr create is called", async () => {
        const recorded = [];
        const spy = makeStubExeca({ buildShouldFail: true, testShouldFail: false, recorded });
        let caught;
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
                execaImpl: spy,
            });
        }
        catch (err) {
            caught = err;
        }
        // Build failure surfaced (not test failure).
        expect(caught).toBeInstanceOf(PrePrBuildFailedError);
        // No test gate was invoked (build failed first).
        const testIdx = firstTestIdx(recorded);
        expect(testIdx).toBe(-1);
        // No PR-create step was invoked.
        const ghCalls = recorded.filter((c) => c.cmd === "gh");
        expect(ghCalls).toHaveLength(0);
    });
});
