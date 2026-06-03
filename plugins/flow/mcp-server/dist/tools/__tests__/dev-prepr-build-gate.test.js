/**
 * Pre-PR full-build gate — Story 8.17.
 *
 * `runDevTerminalAction` runs the project's full build (the same whole-project
 * type-check CI runs) AFTER the commit and BEFORE `gh pr create`. A red build
 * raises `PrePrBuildFailedError` and NO pull request is opened; a green build
 * opens the PR exactly as before. This is the deterministic tool-layer seam that
 * replaces the prose-only "run the build green first" mandate — the #211 failure
 * class (a story broke an untouched sibling file, its story-scoped vitest passed
 * in isolation, and a red PR was opened).
 *
 * These tests drive the tool with a stubbed command runner (`execaImpl`) that
 * records the ordered command stream, so we can assert:
 *   AC1 — on a failing build: the build runs BEFORE any PR-create step, NO
 *         PR-create step is invoked, and a structured build-failure (the typed
 *         error carrying the build's exit code + captured output) surfaces.
 *   AC2 — on a passing build: the PR-create step is invoked exactly once with
 *         the same arguments shape it receives today.
 *   AC3 — the gate runs the project's FULL build (`pnpm build`) with its cwd set
 *         to the dev's working directory (`<targetRepoRoot>/plugins/flow`), so a
 *         future refactor cannot silently narrow it to a partial build.
 *
 * @see _bmad-output/implementation-artifacts/8-17-dev-runs-full-build-before-opening-pr.md
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execa as realExeca } from "execa";
import { stringify as yamlStringify } from "yaml";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { runDevTerminalAction } from "../run-dev-terminal-action.js";
import { PrePrBuildFailedError } from "../../errors.js";
import { PROJECT_BUILD_COMMAND, PROJECT_BUILD_ARGS, deriveProjectBuildCwd, } from "../../lib/run-project-build.js";
// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const REF = "8-17-prepr-build-gate";
const TITLE = "Dev runs the full project build before opening the PR";
const TYPE = "feat";
const BODY = "Adds a tool-layer pre-PR build gate so a red build blocks the PR.";
const SUMMARY = "Pre-PR full-build gate.";
const FAKE_PR_URL = "https://github.com/owner/repo/pull/817";
const SESSION_ULID = "01HZSESSION00000000008170";
const SOURCE_HASH = "b".repeat(64);
const FIXTURE_SPEC = `
# Story 8.17: Pre-PR build gate

Status: ready-for-dev

## Acceptance Criteria

**AC1 (integration):**
Given a failing build, the gate blocks the PR.
`;
async function setupRepo() {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-prepr-build-"));
    await realExeca("git", ["-C", repoRoot, "init"]);
    await realExeca("git", ["-C", repoRoot, "config", "user.email", "test@test.com"]);
    await realExeca("git", ["-C", repoRoot, "config", "user.name", "Test User"]);
    const srcDir = path.join(repoRoot, "src");
    await fs.mkdir(srcDir, { recursive: true });
    await atomicWriteFile(path.join(srcDir, "index.ts"), "export const x = 1;\n");
    await realExeca("git", ["-C", repoRoot, "add", "."]);
    await realExeca("git", ["-C", repoRoot, "commit", "-m", "chore: initial commit"]);
    const stateDir = path.join(repoRoot, ".flow", "state", "in-progress");
    await fs.mkdir(stateDir, { recursive: true });
    const specRelPath = `_bmad-output/implementation-artifacts/${REF}.md`;
    const specDir = path.join(repoRoot, "_bmad-output", "implementation-artifacts");
    await fs.mkdir(specDir, { recursive: true });
    await atomicWriteFile(path.join(specDir, `${REF}.md`), FIXTURE_SPEC);
    const manifestPath = path.join(stateDir, `${REF}.yaml`);
    const manifest = {
        ref: REF,
        status: "in-progress",
        adapter: "bmad",
        source_path: specRelPath,
        source_hash: SOURCE_HASH,
        depends_on: [],
        acceptance_criteria: [{ text: "AC1 text", kind: "integration" }],
        title: TITLE,
        narrative: "As a maintainer, I want a tool-layer build gate.",
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
        if (cmd === "pnpm") {
            if (opts.buildShouldFail) {
                return {
                    stdout: "src/sibling.ts(3,5): build stdout marker",
                    stderr: "src/sibling.ts(3,5): error TS2339: Property 'z' does not exist.",
                    exitCode: 2,
                };
            }
            return { stdout: "build ok", stderr: "", exitCode: 0 };
        }
        if (cmd === "gh") {
            return { stdout: FAKE_PR_URL, stderr: "", exitCode: 0 };
        }
        // git push must not hit the network — stub it green.
        if (cmd === "git" && args[2] === "push") {
            return { stdout: "", stderr: "", exitCode: 0 };
        }
        // Story native:01KT40THFTS10F9PT37KCW9PF4: the pre-PR sync gate runs
        // `git fetch origin` + `git rebase origin/<base>` before the build gate.
        // The tmpdir repo has no `origin`, so stub both green — these tests
        // exercise the build gate, not the sync gate.
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
        PROJECT_BUILD_ARGS.every((a, i) => c.args[i] === a));
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
describe("AC1 — a failing build blocks PR creation (integration)", () => {
    it("runs the build before any PR-create step, opens NO PR, and returns a structured build-failure", async () => {
        const recorded = [];
        const spy = makeStubExeca({ buildShouldFail: true, recorded });
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
        // (a) A structured build-failure surfaced, carrying the exit code + output.
        expect(caught).toBeInstanceOf(PrePrBuildFailedError);
        const e = caught;
        expect(e.exitCode).toBe(2);
        expect(e.stderr).toContain("error TS2339");
        expect(e.stdout).toContain("build stdout marker");
        expect(e.message).toContain("No pull request was opened");
        // (b) The build WAS invoked.
        const buildIdx = firstBuildIdx(recorded);
        expect(buildIdx).toBeGreaterThanOrEqual(0);
        // (b) No PR-create step was invoked at all.
        expect(firstPrCreateIdx(recorded)).toBe(-1);
        const ghCalls = recorded.filter((c) => c.cmd === "gh");
        expect(ghCalls).toHaveLength(0);
        // (a) The build ran before any PR-create step (trivially true since there
        // was none, but also assert no gh call exists after the build index).
        const ghAfterBuild = recorded
            .slice(buildIdx + 1)
            .some((c) => c.cmd === "gh");
        expect(ghAfterBuild).toBe(false);
    });
});
describe("AC2 — a green build opens the PR exactly as before (integration)", () => {
    it("runs the build first, then invokes PR-create exactly once with the same args shape", async () => {
        const recorded = [];
        const spy = makeStubExeca({ buildShouldFail: false, recorded });
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
        // The build ran BEFORE the PR-create step.
        const buildIdx = firstBuildIdx(recorded);
        const prIdx = firstPrCreateIdx(recorded);
        expect(buildIdx).toBeGreaterThanOrEqual(0);
        expect(prIdx).toBeGreaterThan(buildIdx);
        // PR-create invoked exactly once.
        const ghPrCreateCalls = recorded.filter((c) => c.cmd === "gh" && c.args.includes("pr") && c.args.includes("create"));
        expect(ghPrCreateCalls).toHaveLength(1);
        // Same argument shape it receives today: pr create --title <x> --body <y> --base <z>.
        const ghArgs = ghPrCreateCalls[0].args;
        expect(ghArgs.slice(0, 2)).toEqual(["pr", "create"]);
        expect(ghArgs).toContain("--title");
        expect(ghArgs).toContain("--body");
        expect(ghArgs).toContain("--base");
    });
});
describe("AC3 — the gate runs the project's full build in the dev's working directory (unit)", () => {
    it("the build command is `pnpm build` (the full whole-project build, not a story-scoped subset)", async () => {
        const recorded = [];
        const spy = makeStubExeca({ buildShouldFail: false, recorded });
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
        const buildCall = recorded.find((c) => c.cmd === PROJECT_BUILD_COMMAND && c.args[0] === PROJECT_BUILD_ARGS[0]);
        expect(buildCall).toBeDefined();
        // The full build is `pnpm build` — the same command CI runs (which fans out
        // to `pnpm -r build` → tsc -p tsconfig.json). NOT a per-file / story-scoped
        // tsc invocation.
        expect(buildCall.cmd).toBe("pnpm");
        expect(buildCall.args).toEqual(["build"]);
        expect(buildCall.args).not.toContain("--filter");
    });
    it("the build cwd is derived from the dev's working directory (`<workingDir>/plugins/flow`)", async () => {
        const recorded = [];
        const spy = makeStubExeca({ buildShouldFail: false, recorded });
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
        const buildCall = recorded.find((c) => c.cmd === "pnpm");
        expect(buildCall).toBeDefined();
        // worktree:false → the dev's working directory is targetRepoRoot, so the
        // build runs in <targetRepoRoot>/plugins/flow (mirrors CI's
        // working-directory: plugins/flow). The derivation is asserted so a future
        // refactor cannot silently relocate or narrow the gate.
        const expectedCwd = path.join(ctx.repoRoot, "plugins", "flow");
        expect(buildCall.cwd).toBe(expectedCwd);
        expect(deriveProjectBuildCwd(ctx.repoRoot)).toBe(expectedCwd);
    });
    it("deriveProjectBuildCwd joins plugins/flow onto the dev working dir", () => {
        expect(deriveProjectBuildCwd("/tmp/wt")).toBe(path.join("/tmp/wt", "plugins", "flow"));
    });
});
