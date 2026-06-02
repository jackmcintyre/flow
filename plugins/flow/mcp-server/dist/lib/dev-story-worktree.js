/**
 * `materialiseDevStoryWorktree` — Story 8.16, superseded by Story 8.20.
 *
 * Cuts a dedicated git worktree for the drain's generalist-dev step so the dev
 * **edits and builds inside the worktree**, not in the orchestrating session's
 * `targetRepoRoot` checkout. This is the true-parallelism substrate: when the
 * dev's *editing surface* (not merely its commit) is its own worktree, two devs
 * working the same repository at once cannot cross-pollute each other's
 * in-flight changes, and one flow's cleanup cannot revert a sibling's work.
 *
 * History — what 8.20 changed:
 *
 *   Story 8.16 (PR #212) isolated only the dev's git *work product*: the dev
 *   still edited in the shared `targetRepoRoot`, and this helper transplanted
 *   the dev's own changed paths into the worktree afterwards (current-dirty
 *   minus a pre-edit baseline) then reverted them in the checkout on cleanup.
 *   That baseline-diff attribution is correct for a *serial* drain but breaks
 *   under concurrency: two devs editing the same checkout each see the other's
 *   edits as "their own", and one flow's cleanup reverts files the other is
 *   still editing.
 *
 *   Story 8.20 makes the dev edit *in* the worktree (the workflow spawns the dev
 *   subagent with the runtime's per-agent `isolation: 'worktree'` primitive, so
 *   its file-editing sandbox root *is* the worktree). A worktree cut clean from
 *   `base` therefore contains ONLY the dev's own edits — so the
 *   snapshot-dirty-paths baseline, the current-minus-baseline transplant, and
 *   the orchestrating-checkout restore are all gone. The correctness floor 8.16
 *   fought for (no stray pre-existing change ever rides into a story commit) is
 *   now preserved *structurally*: the worktree never contains anything but the
 *   dev's work, so there is nothing to attribute and nothing to subtract.
 *
 * Worktree location (8.20 design point 3): a **sibling of the checkout**, under
 * `<parent>/.crew-worktrees/<sessionUlid>/dev-<ref>-worktree`, NOT nested inside
 * `targetRepoRoot`. A nested worktree would make a dev's own file search / build
 * scan recurse into a self-copy, and would put concurrent worktrees inside the
 * shared tree. The worktree still shares the checkout's `.git` object store and
 * `origin` remote (it is a real `git worktree`), so `gh` resolves the same repo
 * and `git worktree list` enumerates every session's worktrees — which is how
 * stale-session leftovers are reaped (see `reapStaleDevStoryWorktrees`).
 *
 * Mirrors the precedent `materialise-pr-branch-worktree.ts` (Story 5.26):
 * `git worktree add --detach` off the base and a best-effort idempotent
 * `cleanup()`. The static `canonical-fs-guard` test allows this file to spawn
 * `git` directly (same precedent as 8.16 / 5.26).
 */
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { execa as defaultExeca } from "execa";
import { DevStoryWorktreeError } from "../errors.js";
import { GIT_LOCK_CONTENTION, GIT_LOCK_MAX_ATTEMPTS, gitLockBackoffMs, defaultGitLockSleep, } from "./git.js";
// ---------------------------------------------------------------------------
// Internal: run a git subcommand via execa (mirrors the materialise-pr-branch
// precedent — git operations bypass the gh allowlist).
// ---------------------------------------------------------------------------
async function runGit(args, cwd, execaImpl) {
    const result = await execaImpl("git", args, { cwd, reject: false });
    return {
        stdout: typeof result.stdout === "string" ? result.stdout : "",
        stderr: typeof result.stderr === "string" ? result.stderr : "",
        exitCode: typeof result.exitCode === "number" ? result.exitCode : 1,
    };
}
// Concurrent `git worktree add` against a shared `.git` can lose a lock race
// (two dev workers, Story 8.22) exactly as the mutating ops in `git.ts` can —
// so the retry policy (regex / attempt budget / backoff / sleep) is shared from
// there rather than duplicated here. The prior code comment claiming git
// "serialises" concurrent worktree adds was wrong; it surfaced as the flaky
// `concurrent-drains-isolation` test that reds CI under load.
/**
 * Sanitise a story ref into a filesystem-safe worktree directory segment.
 * `bmad:8.20` → `bmad-8.20`.
 */
function refSegment(ref) {
    return ref.replace(/[^A-Za-z0-9._-]/g, "-");
}
/** Resolve symlinks; return the input unchanged if it cannot be resolved. */
async function realpathOrSelf(p) {
    try {
        return await fs.realpath(p);
    }
    catch {
        return p;
    }
}
/**
 * The directory that holds ALL of a session's dev-story worktrees — a sibling
 * of the checkout, never nested inside it. Exported so the reaper and tests
 * derive the same root.
 */
export function devStoryWorktreesRoot(targetRepoRoot, sessionUlid) {
    return path.join(path.dirname(targetRepoRoot), ".crew-worktrees", sessionUlid);
}
/** The worktree path for one story in one session. Exported for the reaper/tests. */
export function devStoryWorktreePath(targetRepoRoot, sessionUlid, ref) {
    return path.join(devStoryWorktreesRoot(targetRepoRoot, sessionUlid), `dev-${refSegment(ref)}-worktree`);
}
// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------
export async function materialiseDevStoryWorktree(opts) {
    const { targetRepoRoot, sessionUlid, ref, base } = opts;
    const execaImpl = opts.execaImpl ?? defaultExeca;
    const sleep = opts.sleepImpl ?? defaultGitLockSleep;
    const setupLog = [];
    // -------------------------------------------------------------------------
    // Step 1: Compute the worktree path (sibling of the checkout) and reap any
    // stale worktree already sitting at exactly this path (e.g. a crashed prior
    // run of the SAME session+ref). This reaps ONLY this path — a concurrent
    // flow's worktree (a different ref) is untouched.
    // -------------------------------------------------------------------------
    const worktreePath = devStoryWorktreePath(targetRepoRoot, sessionUlid, ref);
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    let staleExists = false;
    try {
        await fs.access(worktreePath);
        staleExists = true;
    }
    catch {
        // Nothing to reap.
    }
    if (staleExists) {
        setupLog.push(`[dev-story-worktree] stale worktree detected at ${worktreePath}; reaping.`);
        const reap = await runGit(["-C", targetRepoRoot, "worktree", "remove", worktreePath, "--force"], targetRepoRoot, execaImpl);
        if (reap.exitCode !== 0) {
            setupLog.push(`[dev-story-worktree] git worktree remove failed (exit ${reap.exitCode}): ${reap.stderr}. ` +
                `Falling back to fs.rm.`);
            try {
                await fs.rm(worktreePath, { recursive: true, force: true });
                await runGit(["-C", targetRepoRoot, "worktree", "prune"], targetRepoRoot, execaImpl);
            }
            catch (rmErr) {
                setupLog.push(`[dev-story-worktree] fs.rm also failed: ${rmErr instanceof Error ? rmErr.message : String(rmErr)}.`);
            }
        }
    }
    // -------------------------------------------------------------------------
    // Step 2: git worktree add --detach <path> <base> — a clean checkout cut from
    // `base`, the dev's editing + build surface. `--detach` keeps `base` usable in
    // the orchestrating checkout and composes with concurrency (each story cuts a
    // distinct path off the same base).
    //
    // Concurrency caveat: git does NOT fully serialise concurrent `git worktree
    // add` against a shared `.git` — two workers can collide on the config/index/
    // ref locks and the loser exits non-zero with a transient lock error. Retry
    // those with a short backoff; a non-lock failure (e.g. a bad base ref) still
    // fails fast on the first attempt. runDevTerminalAction creates the story
    // branch inside the worktree next.
    // -------------------------------------------------------------------------
    let add = await runGit(["-C", targetRepoRoot, "worktree", "add", "--detach", worktreePath, base], targetRepoRoot, execaImpl);
    for (let attempt = 1; add.exitCode !== 0 &&
        attempt < GIT_LOCK_MAX_ATTEMPTS &&
        GIT_LOCK_CONTENTION.test(add.stderr); attempt++) {
        setupLog.push(`[dev-story-worktree] git worktree add for ${ref} hit lock contention ` +
            `(attempt ${attempt}/${GIT_LOCK_MAX_ATTEMPTS}): ${add.stderr.trim()}. Retrying.`);
        await sleep(gitLockBackoffMs(attempt));
        add = await runGit(["-C", targetRepoRoot, "worktree", "add", "--detach", worktreePath, base], targetRepoRoot, execaImpl);
    }
    if (add.exitCode !== 0) {
        throw new DevStoryWorktreeError({
            ref,
            phase: "worktree-add",
            underlyingMessage: `git worktree add ${worktreePath} ${base} failed (exit ${add.exitCode}): ${add.stderr}`,
        });
    }
    setupLog.push(`[dev-story-worktree] worktree for ${ref} cut clean from ${base} at ${worktreePath}.`);
    // -------------------------------------------------------------------------
    // Step 3: Cleanup — remove ONLY this worktree. The orchestrating checkout is
    // NEVER touched (the dev never edited it), so there is nothing to restore —
    // the transplant/restore machinery 8.16 needed is gone. Best-effort: failures
    // surface as warnings, not throws, so a failed flow never wedges a sibling.
    // -------------------------------------------------------------------------
    async function cleanup() {
        const warnings = [];
        const remove = await runGit(["-C", targetRepoRoot, "worktree", "remove", worktreePath, "--force"], targetRepoRoot, execaImpl);
        if (remove.exitCode !== 0) {
            warnings.push(`[dev-story-worktree] cleanup: git worktree remove ${worktreePath} --force ` +
                `failed (exit ${remove.exitCode}): ${remove.stderr}. ` +
                `Run 'git worktree prune' to clean up.`);
            // Belt-and-braces: also try a raw fs.rm + prune so a future drain's
            // stale-reap does not trip over a half-removed directory.
            try {
                await fs.rm(worktreePath, { recursive: true, force: true });
                await runGit(["-C", targetRepoRoot, "worktree", "prune"], targetRepoRoot, execaImpl);
            }
            catch {
                // Already reported above.
            }
        }
        return { warnings };
    }
    return { worktreePath, setupLog, cleanup };
}
/**
 * Reap dev-story worktrees left behind by *other* (dead) sessions.
 *
 * A worker that dies mid-build leaves a worktree keyed by its now-dead session
 * id. The per-path stale-reap in `materialiseDevStoryWorktree` only matches the
 * *live* session's own path, so cross-session leftovers would otherwise
 * accumulate forever. The crash-recovery scan already identifies dead sessions;
 * this reaps their leftover worktrees too (8.20 AC4).
 *
 * Enumerates registered worktrees via `git worktree list --porcelain`, keeps
 * only those under the dev-story worktrees parent (`<parent>/.crew-worktrees/`)
 * whose session segment is NOT the current session, and removes each. Removing
 * one stale worktree NEVER disturbs the current session's worktree or another
 * dead session's — each removal targets one explicit path.
 *
 * Best-effort and read-tolerant: a non-zero `git worktree list` (e.g. not a
 * repo) returns an empty result rather than throwing, so a degraded git state
 * never blocks the drain.
 */
export async function reapStaleDevStoryWorktrees(opts) {
    const { targetRepoRoot, currentSessionUlid } = opts;
    const execaImpl = opts.execaImpl ?? defaultExeca;
    const reaped = [];
    const warnings = [];
    const list = await runGit(["-C", targetRepoRoot, "worktree", "list", "--porcelain"], targetRepoRoot, execaImpl);
    if (list.exitCode !== 0) {
        return { reaped, warnings };
    }
    // The parent dir that holds *every* session's dev-story worktrees:
    //   <parent>/.crew-worktrees/<sessionUlid>/dev-<ref>-worktree
    // `git worktree list` reports CANONICAL (symlink-resolved) paths, so canonicalise
    // the checkout root before deriving the parent — otherwise a symlinked
    // targetRepoRoot (e.g. a macOS tmpdir) would make every prefix check miss and
    // leak every stale worktree. realpath is best-effort: fall back to the raw path.
    const canonRoot = await realpathOrSelf(targetRepoRoot);
    const worktreesParent = path.join(path.dirname(canonRoot), ".crew-worktrees");
    const liveSessionDir = path.join(worktreesParent, currentSessionUlid);
    const registered = list.stdout
        .split("\n")
        .filter((l) => l.startsWith("worktree "))
        .map((l) => l.slice("worktree ".length).trim())
        .filter((p) => p.length > 0);
    for (const wt of registered) {
        // Only consider dev-story worktrees (under the shared parent dir).
        const rel = path.relative(worktreesParent, wt);
        if (rel.startsWith("..") || path.isAbsolute(rel))
            continue;
        // Skip the live session's own worktrees — never reap our own in-flight work.
        const inLiveSession = path.relative(liveSessionDir, wt);
        if (!inLiveSession.startsWith("..") && !path.isAbsolute(inLiveSession)) {
            continue;
        }
        const remove = await runGit(["-C", targetRepoRoot, "worktree", "remove", wt, "--force"], targetRepoRoot, execaImpl);
        reaped.push(wt);
        if (remove.exitCode !== 0) {
            warnings.push(`[dev-story-worktree] reap: git worktree remove ${wt} --force failed ` +
                `(exit ${remove.exitCode}): ${remove.stderr}.`);
            try {
                await fs.rm(wt, { recursive: true, force: true });
                await runGit(["-C", targetRepoRoot, "worktree", "prune"], targetRepoRoot, execaImpl);
            }
            catch {
                // Already reported.
            }
        }
    }
    return { reaped, warnings };
}
