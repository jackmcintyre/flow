/**
 * Unit tests for git.ts extensions added by Story 4.4.
 * Covers: assertNoNegativeFlags, gitCreateBranch, gitPush, gitCommit (conventional shape).
 * (Story 4.4 Task 1.3 / Task 1.4 / Task 2.1 / Task 2.2 / Task 2.3 / Task 2.5)
 */
import { describe, expect, it, vi } from "vitest";
import { assertNoNegativeFlags, gitCreateBranch, gitPush, gitCommit, stashWorkingTree, listDirtyPaths, CONVENTIONAL_COMMIT_TYPES, } from "../git.js";
import { NegativeCapabilityDeniedError, GitBranchNameMalformedError, GitPushFailedError, GitCommitMessageMalformedError, } from "../../errors.js";
function makeOkStub(extraArgs) {
    return vi.fn(async () => ({
        stdout: "",
        stderr: "",
        exitCode: 0,
        ...extraArgs,
    }));
}
// ---------------------------------------------------------------------------
// assertNoNegativeFlags (Task 1.3 / AC2 / Task 1.4)
// ---------------------------------------------------------------------------
describe("assertNoNegativeFlags", () => {
    const role = "generalist-dev";
    it("does not throw for a clean args array", () => {
        expect(() => assertNoNegativeFlags(["--title", "My PR"], role, "gh")).not.toThrow();
    });
    it("Task 1.4: throws NegativeCapabilityDeniedError for --no-verify (gh)", () => {
        const spy = vi.fn();
        expect(() => assertNoNegativeFlags(["--no-verify"], role, "gh")).toThrow(NegativeCapabilityDeniedError);
        expect(spy).not.toHaveBeenCalled();
    });
    it("Task 1.4: throws NegativeCapabilityDeniedError for --force (gh)", () => {
        expect(() => assertNoNegativeFlags(["--force"], role, "gh")).toThrow(NegativeCapabilityDeniedError);
    });
    it("Task 1.4: throws NegativeCapabilityDeniedError for --force-with-lease (gh)", () => {
        expect(() => assertNoNegativeFlags(["--force-with-lease"], role, "gh")).toThrow(NegativeCapabilityDeniedError);
    });
    it("Task 1.4: throws NegativeCapabilityDeniedError for --force-with-lease=refs/heads/main (gh)", () => {
        expect(() => assertNoNegativeFlags(["--force-with-lease=refs/heads/main"], role, "gh")).toThrow(NegativeCapabilityDeniedError);
    });
    it("Task 1.4: throws NegativeCapabilityDeniedError for --no-verify (git callSite)", () => {
        expect(() => assertNoNegativeFlags(["--no-verify"], role, "git")).toThrow(NegativeCapabilityDeniedError);
    });
    it("includes attempted_flag in the error", () => {
        try {
            assertNoNegativeFlags(["--no-verify"], role, "git");
            expect.fail("should have thrown");
        }
        catch (err) {
            expect(err).toBeInstanceOf(NegativeCapabilityDeniedError);
            const e = err;
            expect(e.attempted_flag).toBe("--no-verify");
            expect(e.callSite).toBe("git");
        }
    });
});
// ---------------------------------------------------------------------------
// gitCreateBranch (Task 2.1)
// ---------------------------------------------------------------------------
describe("gitCreateBranch", () => {
    it("runs git checkout -b with a valid branch name", async () => {
        const spy = makeOkStub();
        await gitCreateBranch({
            targetRepoRoot: "/tmp/repo",
            branchName: "story/4-4-terminal-action",
            execaImpl: spy,
        });
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0]).toEqual([
            "git",
            ["-C", "/tmp/repo", "checkout", "-b", "story/4-4-terminal-action"],
        ]);
    });
    it("Task 2.1: throws GitBranchNameMalformedError for non-story/ prefix BEFORE spawn", async () => {
        const spy = vi.fn();
        await expect(gitCreateBranch({
            targetRepoRoot: "/tmp/repo",
            branchName: "feature/my-feature",
            execaImpl: spy,
        })).rejects.toBeInstanceOf(GitBranchNameMalformedError);
        expect(spy).not.toHaveBeenCalled();
    });
    it("Task 2.1: throws GitBranchNameMalformedError for uppercase in branch name BEFORE spawn", async () => {
        const spy = vi.fn();
        await expect(gitCreateBranch({
            targetRepoRoot: "/tmp/repo",
            branchName: "story/Feature-Name",
            execaImpl: spy,
        })).rejects.toBeInstanceOf(GitBranchNameMalformedError);
        expect(spy).not.toHaveBeenCalled();
    });
    it("Task 2.1: throws GitBranchNameMalformedError for empty suffix BEFORE spawn", async () => {
        const spy = vi.fn();
        await expect(gitCreateBranch({
            targetRepoRoot: "/tmp/repo",
            branchName: "story/",
            execaImpl: spy,
        })).rejects.toBeInstanceOf(GitBranchNameMalformedError);
        expect(spy).not.toHaveBeenCalled();
    });
});
// ---------------------------------------------------------------------------
// gitPush (Task 2.2)
// ---------------------------------------------------------------------------
describe("gitPush", () => {
    it("Task 2.2: happy path — runs git push -u origin <branch>", async () => {
        const spy = makeOkStub();
        await gitPush({
            targetRepoRoot: "/tmp/repo",
            branchName: "story/4-4-test",
            role: "generalist-dev",
            execaImpl: spy,
        });
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0]).toEqual([
            "git",
            ["-C", "/tmp/repo", "push", "-u", "origin", "story/4-4-test"],
            expect.objectContaining({ reject: false }),
        ]);
    });
    it("Task 2.2: throws GitPushFailedError on non-zero exit", async () => {
        const spy = vi.fn(async () => ({
            stdout: "",
            stderr: "fatal: remote rejected",
            exitCode: 1,
        }));
        await expect(gitPush({
            targetRepoRoot: "/tmp/repo",
            branchName: "story/4-4-test",
            role: "generalist-dev",
            execaImpl: spy,
        })).rejects.toBeInstanceOf(GitPushFailedError);
    });
    it("Task 2.2: GitPushFailedError carries stderr", async () => {
        const spy = vi.fn(async () => ({
            stdout: "",
            stderr: "fatal: remote rejected",
            exitCode: 128,
        }));
        try {
            await gitPush({
                targetRepoRoot: "/tmp/repo",
                branchName: "story/4-4-test",
                role: "generalist-dev",
                execaImpl: spy,
            });
            expect.fail("should have thrown");
        }
        catch (err) {
            expect(err).toBeInstanceOf(GitPushFailedError);
            expect(err.stderr).toBe("fatal: remote rejected");
        }
    });
});
// ---------------------------------------------------------------------------
// gitCommit conventional shape (Task 2.3)
// ---------------------------------------------------------------------------
describe("gitCommit — conventional shape (Task 2.3)", () => {
    function makeConventionalSpy(sha = "abc123") {
        return vi.fn(async (_cmd, args) => {
            const subcmd = args[2];
            if (subcmd === "add")
                return { stdout: "", stderr: "", exitCode: 0 };
            if (subcmd === "commit")
                return { stdout: "", stderr: "", exitCode: 0 };
            if (subcmd === "rev-parse")
                return { stdout: `${sha}\n`, stderr: "", exitCode: 0 };
            throw new Error(`Unexpected: ${subcmd}`);
        });
    }
    it("Task 2.3: accepts a valid conventional-commits subject", async () => {
        const spy = makeConventionalSpy();
        const result = await gitCommit({
            targetRepoRoot: "/tmp/repo",
            paths: ["src/foo.ts"],
            message: "feat(4-4-terminal): Add terminal action",
            role: "generalist-dev",
            messageShape: "conventional",
            execaImpl: spy,
        });
        expect(result.commitSha).toBe("abc123");
        expect(spy).toHaveBeenCalledTimes(3);
    });
    it("Story 8.1: accepts real story refs in scope (bmad:<id>, native:<ULID>)", async () => {
        // Regression (spike 2026-05-29): the prior `[a-z0-9-]+` scope rejected every
        // real ref — colon, uppercase (Crockford ULID), and dot are all valid scope chars.
        for (const subject of [
            "feat(bmad:1.1): widen commit-scope regex",
            "fix(native:01HZ4MVSR41WKARM9Q9F8E7XYZ): handle edge case",
            "chore(bmad:6.2.0): bump",
        ]) {
            const spy = makeConventionalSpy();
            const result = await gitCommit({
                targetRepoRoot: "/tmp/repo",
                paths: ["src/foo.ts"],
                message: subject,
                role: "generalist-dev",
                messageShape: "conventional",
                execaImpl: spy,
            });
            expect(result.commitSha).toBe("abc123");
        }
    });
    it("Task 2.3: adds -m body flag when body is provided", async () => {
        const spy = makeConventionalSpy();
        await gitCommit({
            targetRepoRoot: "/tmp/repo",
            paths: ["src/foo.ts"],
            message: "feat(4-4-terminal): Add terminal action",
            role: "generalist-dev",
            messageShape: "conventional",
            body: "Detailed body text.",
            execaImpl: spy,
        });
        // Second call is the commit
        const commitCall = spy.mock.calls.find(([, a]) => a[2] === "commit");
        expect(commitCall).toBeDefined();
        const commitArgs = commitCall[1];
        expect(commitArgs).toContain("-m");
        // Should have two -m flags (subject + body)
        const mCount = commitArgs.filter((a) => a === "-m").length;
        expect(mCount).toBe(2);
        expect(commitArgs).toContain("Detailed body text.");
    });
    it("Task 2.3: rejects conventional subject with unknown type BEFORE spawn", async () => {
        const spy = vi.fn();
        await expect(gitCommit({
            targetRepoRoot: "/tmp/repo",
            paths: ["src/foo.ts"],
            message: "feature(4-4): some change",
            role: "generalist-dev",
            messageShape: "conventional",
            execaImpl: spy,
        })).rejects.toBeInstanceOf(GitCommitMessageMalformedError);
        expect(spy).not.toHaveBeenCalled();
    });
    it("Task 2.3: plugin-internal shape still works (backward compat)", async () => {
        const spy = makeConventionalSpy("deadbeef");
        const result = await gitCommit({
            targetRepoRoot: "/tmp/repo",
            paths: ["docs/standards.md"],
            message: "regenerate-standards: bmad:1.2.3",
            role: "generalist-dev",
            // messageShape defaults to "plugin-internal"
            execaImpl: spy,
        });
        expect(result.commitSha).toBe("deadbeef");
    });
    it("Task 2.3: all CONVENTIONAL_COMMIT_TYPES are recognised", () => {
        const expected = [
            "feat", "fix", "refactor", "test", "docs", "chore",
            "build", "ci", "perf", "style", "revert",
        ];
        expect([...CONVENTIONAL_COMMIT_TYPES].sort()).toEqual(expected.sort());
    });
});
// ---------------------------------------------------------------------------
// stashWorkingTree (Epic 10 drain fix-plan — Fix 2b, clean-root guard)
// ---------------------------------------------------------------------------
describe("stashWorkingTree", () => {
    it("scopes the stash to the given pathspecs, includes untracked (-u), and labels it", async () => {
        const spy = vi.fn(async () => ({
            stdout: "Saved working directory and index state WIP on main: abc123",
            stderr: "",
            exitCode: 0,
        }));
        const result = await stashWorkingTree({
            cwd: "/tmp/repo",
            paths: ["src/a.ts", "src/b.ts"],
            message: "crew-drain clean-root guard: native:01ABC",
            execaImpl: spy,
        });
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0]).toEqual([
            "git",
            [
                "-C", "/tmp/repo", "stash", "push", "-u",
                "-m", "crew-drain clean-root guard: native:01ABC",
                "--", "src/a.ts", "src/b.ts",
            ],
            { reject: false },
        ]);
        expect(result.stashed).toBe(true);
    });
    it("reports stashed:false when git says there is nothing to stash", async () => {
        const spy = vi.fn(async () => ({
            stdout: "No local changes to save",
            stderr: "",
            exitCode: 0,
        }));
        const result = await stashWorkingTree({
            cwd: "/tmp/repo",
            paths: ["src/a.ts"],
            execaImpl: spy,
        });
        expect(result.stashed).toBe(false);
    });
    it("reports stashed:false on a non-zero exit (best-effort, never throws)", async () => {
        const spy = vi.fn(async () => ({
            stdout: "",
            stderr: "fatal: Unable to create '.git/index.lock': File exists.",
            exitCode: 128,
        }));
        const result = await stashWorkingTree({
            cwd: "/tmp/repo",
            paths: ["src/a.ts"],
            execaImpl: spy,
        });
        expect(result.stashed).toBe(false);
        expect(result.stderr).toContain("index.lock");
    });
});
describe("listDirtyPaths — bare `.crew` symlink exclusion (native:01KT3FKYB7HNSEE5QQYMS57F7C)", () => {
    it("drops a bare `.crew` dirty path so the symlink can never be staged", async () => {
        // `git status --porcelain -z` emits NUL-terminated `XY<space>PATH` records.
        // The bare `.crew` symlink shows up as an untracked entry (`??`).
        const stdout = "?? .crew\0 M src/lib/git.ts\0?? .crew/state/ledger.yaml\0 M .crew/state\0";
        const spy = vi.fn(async () => ({ stdout, stderr: "", exitCode: 0 }));
        const result = await listDirtyPaths({
            cwd: "/repo",
            execaImpl: spy,
        });
        // AC2: the bare symlink is filtered out regardless of the gitignore rule.
        expect(result).not.toContain(".crew");
        // Real story changes are still surfaced for staging.
        expect(result).toContain("src/lib/git.ts");
        // The pre-existing `.crew/state` filters remain in force (same predicate).
        expect(result).not.toContain(".crew/state/ledger.yaml");
        expect(result).not.toContain(".crew/state");
    });
});
