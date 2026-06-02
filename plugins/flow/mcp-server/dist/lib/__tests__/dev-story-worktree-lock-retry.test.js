/**
 * Regression tests for `materialiseDevStoryWorktree`'s retry on concurrent
 * `git worktree add` lock contention.
 *
 * Two drain workers (Story 8.22) can fire `git worktree add` against the SAME
 * `.git` at once and collide on git's internal config/index/ref locks; the loser
 * exits non-zero with a transient lock error. Git does NOT serialise these, which
 * surfaced as a flaky `concurrent-drains-isolation` test that reds CI under load.
 * These tests pin the fix deterministically — they do NOT race real processes:
 * a stub `execaImpl` injects a lock error on chosen `git worktree add` attempts
 * and passes everything else through to real git, so the retry path is exercised
 * with zero timing dependence (a no-op `sleepImpl` keeps it instant).
 *
 * vitest: plugins/flow/mcp-server/src/lib/__tests__/dev-story-worktree-lock-retry.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execa as realExeca } from "execa";
import { materialiseDevStoryWorktree } from "../dev-story-worktree.js";
import { GIT_LOCK_MAX_ATTEMPTS } from "../git.js";
import { DevStoryWorktreeError } from "../../errors.js";
const SESSION_ULID = "01HZSESSION00000000009999";
const REF = "8-23-lock-retry";
const LOCK_STDERR = "fatal: could not lock config file /tmp/work/.git/config: File exists";
const NON_LOCK_STDERR = "fatal: invalid reference: no-such-base";
/** Minimal real git repo on `main` with one commit — enough for `worktree add main`. */
async function setupRepo() {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "wt-lock-retry-"));
    const repoRoot = path.join(tmp, "work");
    await fs.mkdir(repoRoot, { recursive: true });
    await realExeca("git", ["init", "-b", "main", repoRoot]);
    await realExeca("git", ["-C", repoRoot, "config", "user.email", "t@t.com"]);
    await realExeca("git", ["-C", repoRoot, "config", "user.name", "Test User"]);
    // An empty commit is enough for `git worktree add main` to resolve; avoids a
    // raw write-shaped fs call (banned by the canonical-fs-guard outside managed-fs).
    await realExeca("git", ["-C", repoRoot, "commit", "--allow-empty", "-m", "init"]);
    return { tmp, repoRoot };
}
/** Is this invocation a `git worktree add`? */
function isWorktreeAdd(cmd, args) {
    return cmd === "git" && args.includes("worktree") && args.includes("add");
}
/**
 * execaImpl that injects `stderr` (with the given exit code) on the first
 * `failAdds` `git worktree add` calls, then passes through to real git. Records
 * how many `worktree add` attempts were made.
 */
function makeFlakyAddExeca(opts) {
    let addAttempts = 0;
    const impl = async (cmd, args, options) => {
        if (isWorktreeAdd(cmd, args)) {
            addAttempts += 1;
            if (addAttempts <= opts.failAdds) {
                return { stdout: "", stderr: opts.stderr, exitCode: opts.exitCode ?? 128 };
            }
        }
        const r = await realExeca(cmd, args, { ...options, reject: false });
        return {
            stdout: typeof r.stdout === "string" ? r.stdout : "",
            stderr: typeof r.stderr === "string" ? r.stderr : "",
            exitCode: typeof r.exitCode === "number" ? r.exitCode : 0,
        };
    };
    return { impl, attempts: () => addAttempts };
}
let ctx;
const noopSleep = async () => { };
beforeEach(async () => {
    ctx = await setupRepo();
});
afterEach(async () => {
    await fs.rm(ctx.tmp, { recursive: true, force: true });
});
describe("materialiseDevStoryWorktree — concurrent worktree-add lock retry", () => {
    it("retries a transient lock-contention failure and succeeds", async () => {
        const flaky = makeFlakyAddExeca({ failAdds: 1, stderr: LOCK_STDERR });
        const result = await materialiseDevStoryWorktree({
            targetRepoRoot: ctx.repoRoot,
            sessionUlid: SESSION_ULID,
            ref: REF,
            base: "main",
            execaImpl: flaky.impl,
            sleepImpl: noopSleep,
        });
        // It retried once (2 attempts total) and ultimately created the worktree.
        expect(flaky.attempts()).toBe(2);
        await expect(fs.access(result.worktreePath)).resolves.toBeUndefined();
        expect(result.setupLog.some((l) => /lock contention/i.test(l))).toBe(true);
    });
    it("survives several consecutive lock collisions within the attempt budget", async () => {
        const flaky = makeFlakyAddExeca({ failAdds: 4, stderr: LOCK_STDERR });
        const result = await materialiseDevStoryWorktree({
            targetRepoRoot: ctx.repoRoot,
            sessionUlid: SESSION_ULID,
            ref: REF,
            base: "main",
            execaImpl: flaky.impl,
            sleepImpl: noopSleep,
        });
        // 4 failures + 1 success = 5 attempts (well within the budget), worktree created.
        expect(flaky.attempts()).toBe(5);
        await expect(fs.access(result.worktreePath)).resolves.toBeUndefined();
    });
    it("does NOT retry a non-lock failure — fails fast on the first attempt", async () => {
        // Persistent non-lock error: if retry were unconditional this would loop to
        // the budget; the lock-scoped guard means exactly one attempt then throw.
        const flaky = makeFlakyAddExeca({ failAdds: 99, stderr: NON_LOCK_STDERR });
        await expect(materialiseDevStoryWorktree({
            targetRepoRoot: ctx.repoRoot,
            sessionUlid: SESSION_ULID,
            ref: REF,
            base: "main",
            execaImpl: flaky.impl,
            sleepImpl: noopSleep,
        })).rejects.toBeInstanceOf(DevStoryWorktreeError);
        expect(flaky.attempts()).toBe(1);
    });
    it("gives up after the attempt budget when the lock never clears", async () => {
        const flaky = makeFlakyAddExeca({ failAdds: 99, stderr: LOCK_STDERR });
        await expect(materialiseDevStoryWorktree({
            targetRepoRoot: ctx.repoRoot,
            sessionUlid: SESSION_ULID,
            ref: REF,
            base: "main",
            execaImpl: flaky.impl,
            sleepImpl: noopSleep,
        })).rejects.toBeInstanceOf(DevStoryWorktreeError);
        // Capped at the max-attempts budget — does not retry forever. Tracks the
        // constant so the assertion follows future tuning of the budget.
        expect(flaky.attempts()).toBe(GIT_LOCK_MAX_ATTEMPTS);
    });
});
