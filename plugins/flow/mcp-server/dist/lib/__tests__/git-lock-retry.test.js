/**
 * Regression tests for concurrent git-lock-contention retry in the mutating
 * git helpers — `gitCreateBranch`, `gitCommit`, `gitPush` (src/lib/git.ts).
 *
 * Concurrent drain workers (Story 8.22) run these ops against the SAME shared
 * `.git` (worktrees share the common dir; they push to one origin). Git does NOT
 * serialise concurrent ref/config/push transactions — the loser exits non-zero
 * with a transient lock error. This surfaced as a flaky `concurrent-drains-
 * isolation` test that reds CI under load. The helpers now retry transient lock
 * failures with a short backoff and re-throw any non-lock failure unchanged.
 *
 * These tests are deterministic — they inject lock failures via a stub `execa`
 * (which throws on a git failure exactly as the real execa reject does, and
 * returns a non-zero result for the reject:false push path) and a no-op sleep,
 * so no real process races.
 *
 * vitest: plugins/flow/mcp-server/src/lib/__tests__/git-lock-retry.test.ts
 */
import { describe, expect, it } from "vitest";
import { gitCreateBranch, gitCommit, gitPush, gitLockBackoffMs, GIT_LOCK_MAX_ATTEMPTS, } from "../git.js";
import { GitPushFailedError } from "../../errors.js";
const LOCK = "fatal: could not lock ref 'refs/heads/story/x': Unable to create '.git/refs/heads/story/x.lock': File exists";
const NON_LOCK = "fatal: invalid reference: no-such-thing";
const noopSleep = async () => { };
/** An execa-shaped thrown error (mirrors execa's reject: carries .stderr/.exitCode). */
function execaError(stderr) {
    const e = new Error(`Command failed with exit code 128: git\n${stderr}`);
    e.stderr = stderr;
    e.exitCode = 128;
    return e;
}
function subcmd(args) {
    // args are like ["-C", root, "<subcmd>", ...] or ["-C", root, "push", ...]
    return args[2] ?? "";
}
describe("gitCreateBranch — lock-contention retry", () => {
    it("retries checkout -b on a transient lock error, then succeeds", async () => {
        let checkouts = 0;
        const execaImpl = (async (_cmd, args) => {
            if (subcmd(args) === "checkout") {
                checkouts += 1;
                if (checkouts === 1)
                    throw execaError(LOCK);
            }
            return { stdout: "", stderr: "", exitCode: 0 };
        });
        await expect(gitCreateBranch({ targetRepoRoot: "/repo", branchName: "story/x", execaImpl, sleepImpl: noopSleep })).resolves.toBeUndefined();
        expect(checkouts).toBe(2);
    });
    it("does NOT retry a non-lock checkout failure — re-throws the original error", async () => {
        let checkouts = 0;
        const original = execaError(NON_LOCK);
        const execaImpl = (async (_cmd, args) => {
            if (subcmd(args) === "checkout") {
                checkouts += 1;
                throw original;
            }
            return { stdout: "", stderr: "", exitCode: 0 };
        });
        await expect(gitCreateBranch({ targetRepoRoot: "/repo", branchName: "story/x", execaImpl, sleepImpl: noopSleep })).rejects.toBe(original);
        expect(checkouts).toBe(1);
    });
});
describe("gitCommit — lock-contention retry on the commit", () => {
    it("retries the commit on a transient lock error, then returns the SHA", async () => {
        let commits = 0;
        const execaImpl = (async (_cmd, args) => {
            const s = subcmd(args);
            if (s === "commit") {
                commits += 1;
                if (commits === 1)
                    throw execaError(LOCK);
                return { stdout: "", stderr: "", exitCode: 0 };
            }
            if (s === "rev-parse")
                return { stdout: "abc123\n", stderr: "", exitCode: 0 };
            return { stdout: "", stderr: "", exitCode: 0 }; // add
        });
        const result = await gitCommit({
            targetRepoRoot: "/repo",
            paths: ["src/x.ts"],
            message: "append-knowledge: bmad-8.23",
            role: "generalist-dev",
            execaImpl,
            sleepImpl: noopSleep,
        });
        expect(result.commitSha).toBe("abc123");
        expect(commits).toBe(2);
    });
});
describe("gitPush — lock-contention retry", () => {
    it("retries push on a transient lock error, then succeeds", async () => {
        let pushes = 0;
        const execaImpl = (async (_cmd, args) => {
            if (subcmd(args) === "push") {
                pushes += 1;
                if (pushes === 1)
                    return { stdout: "", stderr: LOCK, exitCode: 128 };
            }
            return { stdout: "", stderr: "", exitCode: 0 };
        });
        await expect(gitPush({ targetRepoRoot: "/repo", branchName: "story/x", role: "generalist-dev", execaImpl, sleepImpl: noopSleep })).resolves.toBeUndefined();
        expect(pushes).toBe(2);
    });
    it("does NOT retry a non-lock push failure — throws GitPushFailedError after one attempt", async () => {
        let pushes = 0;
        const execaImpl = (async (_cmd, args) => {
            if (subcmd(args) === "push") {
                pushes += 1;
                return { stdout: "", stderr: "fatal: remote rejected", exitCode: 1 };
            }
            return { stdout: "", stderr: "", exitCode: 0 };
        });
        await expect(gitPush({ targetRepoRoot: "/repo", branchName: "story/x", role: "generalist-dev", execaImpl, sleepImpl: noopSleep })).rejects.toBeInstanceOf(GitPushFailedError);
        expect(pushes).toBe(1);
    });
    it("gives up after the attempt budget when the push lock never clears", async () => {
        let pushes = 0;
        const execaImpl = (async (_cmd, args) => {
            if (subcmd(args) === "push") {
                pushes += 1;
                return { stdout: "", stderr: LOCK, exitCode: 128 };
            }
            return { stdout: "", stderr: "", exitCode: 0 };
        });
        await expect(gitPush({ targetRepoRoot: "/repo", branchName: "story/x", role: "generalist-dev", execaImpl, sleepImpl: noopSleep })).rejects.toBeInstanceOf(GitPushFailedError);
        // Caps at the attempt budget — does not retry forever. Tracks the constant
        // so the assertion follows future tuning of the budget.
        expect(pushes).toBe(GIT_LOCK_MAX_ATTEMPTS);
    });
});
describe("gitLockBackoffMs — full-jitter backoff window", () => {
    it("draws each backoff from [0, window) so lockstepped workers decorrelate", () => {
        // With random()=0 the backoff is the window floor (0); with random()→1 it
        // approaches the window ceiling. The window doubles per 1-based attempt up to
        // the cap, so two workers on the same attempt land in different slots.
        const lo = (n) => gitLockBackoffMs(n, () => 0);
        const hi = (n) => gitLockBackoffMs(n, () => 0.999999);
        // Floor is always 0 (full jitter); ceiling grows then plateaus at the cap.
        expect(lo(1)).toBe(0);
        expect(lo(5)).toBe(0);
        expect(hi(1)).toBe(24); // window 25  → [0,25)
        expect(hi(2)).toBe(49); // window 50  → [0,50)
        expect(hi(3)).toBe(99); // window 100 → [0,100)
        // Capped at 500ms regardless of how many attempts deep we go.
        expect(hi(10)).toBe(499);
        expect(hi(50)).toBe(499);
    });
    it("never returns a negative delay for the first attempt", () => {
        expect(gitLockBackoffMs(1, () => 0)).toBeGreaterThanOrEqual(0);
        expect(gitLockBackoffMs(0, () => 0.5)).toBeGreaterThanOrEqual(0);
    });
});
