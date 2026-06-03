import { execa as defaultExeca } from "execa";
export interface GitCommitResult {
    commitSha: string;
    stdout: string;
    stderr: string;
}
/**
 * Required shape for conventional-commits subject lines (Story 4.4).
 * Format: `<type>(<ref>): <subject>` where type is one of the
 * CONVENTIONAL_COMMIT_TYPES set. The ref is the story ref (kebab/digits).
 * The subject is non-empty.
 */
export declare const CONVENTIONAL_COMMIT_TYPES: readonly ["feat", "fix", "refactor", "test", "docs", "chore", "build", "ci", "perf", "style", "revert"];
/**
 * Assert that `args` contains none of the unconditionally forbidden flags.
 * Throws `NegativeCapabilityDeniedError` BEFORE any subprocess spawn on
 * the first offending flag found.
 *
 * Exported so `lib/gh.ts` can re-use without duplicating the set.
 * (Story 4.4 Task 1.3)
 */
export declare function assertNoNegativeFlags(args: readonly string[], role: string, callSite: "gh" | "git"): void;
/** stderr substrings that mark a transient git-lock collision worth retrying. */
export declare const GIT_LOCK_CONTENTION: RegExp;
/** Total attempts (initial + retries) before surfacing a git-lock failure. */
export declare const GIT_LOCK_MAX_ATTEMPTS = 8;
/**
 * Full-jitter exponential backoff for git-lock contention retries (1-based
 * `attempt`). Returns a delay drawn uniformly from `[0, window)`, where `window`
 * doubles each attempt up to `GIT_LOCK_BACKOFF_CAP_MS`.
 *
 * Why jitter: two concurrent workers that collide on a lock and then back off by
 * the SAME deterministic delay stay phase-locked and keep colliding — exactly the
 * lockstep that left the `concurrent-drains-isolation` test red on CI under load
 * even with a (linear) retry already in place. Randomising each backoff into a
 * growing window decorrelates the workers so the loser reschedules into a
 * different slot. This is the standard "full jitter" policy (AWS architecture
 * blog: "Exponential Backoff And Jitter").
 *
 * `random` is injectable so tests can assert the window bounds deterministically;
 * production uses `Math.random`.
 */
export declare function gitLockBackoffMs(attempt: number, random?: () => number): number;
/** Default backoff sleep (real timer); overridable via a `sleepImpl` test seam. */
export declare function defaultGitLockSleep(ms: number): Promise<void>;
/**
 * Single entrypoint for plugin-side git commits (Story 1.5 AC4).
 * Stages the given `paths` then commits with the given `message`.
 *
 * The static guard in `tests/canonical-fs-guard.test.ts` forbids any
 * file other than this one from spawning `git` directly (AC6f).
 *
 * `role` is accepted for forward-compat (a later story will surface
 * it in the structured telemetry event for the commit). It is NOT
 * yet allowlist-checked — git is reached only from MCP tools that
 * themselves were already role-gated, so an extra git-side allowlist
 * would be redundant in v1.
 *
 * **`messageShape`** (Story 4.4 Task 2.3):
 * - `"plugin-internal"` (default): existing shape `<tool-name>: <ref>`.
 * - `"conventional"`: validates against the conventional-commits
 *   subject regex `^<type>(<ref>): <subject>$`. The `body` field
 *   (already wrapped at 72 chars by the caller) is passed as a second
 *   `-m` flag.
 *
 * Refuses calls whose message does not match the required shape AND
 * calls with an empty `paths` set, in both cases BEFORE any
 * subprocess spawn (verified by an `execaImpl` spy in tests).
 *
 * Single-purpose: no retry, no `--no-verify`, no `-S` signing, no
 * `--amend`. Three `execa` calls (plugin-internal) or four
 * (conventional with body), in order: `add`, `commit`, then
 * `rev-parse HEAD` to harvest the commit SHA.
 */
export declare function gitCommit(opts: {
    targetRepoRoot: string;
    paths: readonly string[];
    message: string;
    role: string;
    messageShape?: "plugin-internal" | "conventional";
    body?: string;
    execaImpl?: typeof defaultExeca;
    /** Test seam for the lock-contention retry backoff (production omits this). */
    sleepImpl?: (ms: number) => Promise<void>;
}): Promise<GitCommitResult>;
/**
 * Create and check out a new branch in the target repo.
 *
 * The branch name MUST match `^story/[a-z0-9-]+$` — a defence-in-depth
 * check that guards against callers bypassing `buildBranchSlug`. Throws
 * `GitBranchNameMalformedError` BEFORE any spawn on regex failure.
 *
 * Runs `git -C <root> checkout -b <branchName>`.
 *
 * (Story 4.4 Task 2.1)
 */
export declare function gitCreateBranch(opts: {
    targetRepoRoot: string;
    branchName: string;
    execaImpl?: typeof defaultExeca;
    /** Test seam for the lock-contention retry backoff (production omits this). */
    sleepImpl?: (ms: number) => Promise<void>;
}): Promise<void>;
/**
 * Push the given branch to `origin` with `-u` (set-upstream).
 *
 * The v1 signature is CLOSED — there is no `args` passthrough. This is
 * structural prevention of `--force-with-lease` / `--no-verify` injection
 * (belt-and-braces alongside the wrapper-level `assertNoNegativeFlags`
 * check). (Story 4.4 Task 2.2 / AC1e)
 *
 * Runs `git -C <root> push -u origin <branchName>`.
 * Throws `GitPushFailedError` on non-zero exit.
 */
export declare function gitPush(opts: {
    targetRepoRoot: string;
    branchName: string;
    role: string;
    execaImpl?: typeof defaultExeca;
    /** Test seam for the lock-contention retry backoff (production omits this). */
    sleepImpl?: (ms: number) => Promise<void>;
}): Promise<void>;
/**
 * Fetch the latest refs from `origin`.
 *
 * The v1 signature is CLOSED — there is no `args` passthrough. This is
 * structural prevention of flag injection (belt-and-braces alongside the
 * wrapper-level `assertNoNegativeFlags` check), mirroring `gitPush`. The fixed
 * arg list is routed through `assertNoNegativeFlags` so the same negative-flag
 * refusal applies even though the closed signature already admits no flags.
 *
 * Runs `git -C <root> fetch origin`. The fetch updates the remote-tracking ref
 * in the shared `.git`; under concurrent drains that ref update can lose a lock
 * race, so the spawn is wrapped in `retryGitOnLockContention` (a non-lock
 * failure is re-thrown unchanged).
 *
 * Used by `runDevTerminalAction` to bring `origin/main` up to date right before
 * the rebase-onto step, so the rebase integrates against the latest trunk.
 *
 * (Story native:01KT40THFTS10F9PT37KCW9PF4)
 */
export declare function gitFetch(opts: {
    targetRepoRoot: string;
    role: string;
    execaImpl?: typeof defaultExeca;
    /** Test seam for the lock-contention retry backoff (production omits this). */
    sleepImpl?: (ms: number) => Promise<void>;
}): Promise<void>;
/**
 * Rebase the current branch onto `origin/main`.
 *
 * The v1 signature is CLOSED — there is no `args` passthrough, so a destructive
 * overwrite instruction (e.g. `--force` family / `--no-verify`) can never be
 * threaded in. The fixed arg list is routed through `assertNoNegativeFlags`
 * (throwing `NegativeCapabilityDeniedError` BEFORE any subprocess spawn) so the
 * same negative-flag refusal applies as a defence-in-depth invariant.
 *
 * Runs `git -C <root> rebase origin/main`. On a non-zero exit — a genuine
 * content conflict between the story's changes and trunk work that landed first
 * — this function runs `git -C <root> rebase --abort` to leave the working tree
 * clean (no half-applied rebase), THEN throws `RebaseConflictError` carrying a
 * readable reason (the conflicting paths parsed from the rebase output, plus the
 * abbreviated stderr). The caller stops BEFORE pushing, so no doomed PR is
 * opened.
 *
 * The spawn is wrapped in `retryGitOnLockContention` (a transient lock
 * collision is retried; a non-lock failure surfaces as the conflict path above).
 * The retried thunk is idempotent on a lock-failed attempt because a lock
 * collision means the rebase did not start.
 *
 * SAFETY: this is only ever run on a freshly-created, never-pushed branch (the
 * push site in `runDevTerminalAction` creates the branch then pushes it exactly
 * once). Rebasing a never-pushed branch then pushing is a normal fast-forward
 * from origin's view — a force-push is never needed or attempted — so this is
 * safe precisely because shared history is never rewritten.
 *
 * (Story native:01KT40THFTS10F9PT37KCW9PF4)
 */
export declare function gitRebaseOnto(opts: {
    targetRepoRoot: string;
    role: string;
    /** Upstream ref to rebase onto. Defaults to `origin/main` (flow's trunk). */
    onto?: string;
    execaImpl?: typeof defaultExeca;
    /** Test seam for the lock-contention retry backoff (production omits this). */
    sleepImpl?: (ms: number) => Promise<void>;
}): Promise<void>;
/**
 * Initialise a fresh git repo at `cwd` with a deterministic default branch
 * name (`main`) and create an initial empty commit so `rev-parse HEAD` is
 * always resolvable.
 *
 * Two commands in order:
 *  1. `git init -b main` — create the repo; `-b main` makes the default
 *     branch deterministic regardless of the operator's `init.defaultBranch`
 *     setting.
 *  2. `git -c user.email=… -c user.name=… commit --allow-empty -m "chore: initial empty commit for smoke scratch repo"` —
 *     inline identity scoped to this single `commit` invocation so the call
 *     succeeds on fresh CI containers / containers with no global git config;
 *     the `-c` flag does NOT persist identity to repo config.
 *
 * Lives here so the `canonical-fs-guard.test.ts` AC6f static guard (which
 * forbids any file other than `lib/git.ts` from spawning `git`) stays
 * satisfied.
 */
export declare function gitInitWithEmptyCommit(opts: {
    cwd: string;
    execaImpl?: typeof defaultExeca;
}): Promise<void>;
/**
 * Read up to `limit` recent commit titles from the target repo via
 * `git log -<limit> --pretty=%s`. Best-effort: on non-zero exit (no
 * git, no commits, not a repo, etc.) returns `[]`. Used by
 * `readRepoSignals` (Story 2.4 FR85).
 *
 * Lives here so the `canonical-fs-guard.test.ts` AC6f static guard
 * (which forbids any file under `src/**` other than `lib/git.ts` from
 * spawning `git`) stays satisfied.
 */
export declare function readRecentCommitTitles(opts: {
    cwd: string;
    limit?: number;
    execaImpl?: typeof defaultExeca;
}): Promise<string[]>;
/**
 * Resolve the orchestrating checkout root from a working directory that may be a
 * git worktree.
 *
 * Story 8.20: the drain's dev edits inside its OWN worktree (cwd = worktree),
 * but the session ledger (`.flow/state/sessions/<sessionUlid>/dev-outcome.json`,
 * read by `processDevTranscript` against the orchestrating checkout) lives in the
 * orchestrating checkout, NOT the worktree's separate working tree. A worktree
 * shares the main checkout's `.git`, so `git rev-parse --git-common-dir` from
 * inside the worktree points at `<orchestrating-checkout>/.git`; its parent is
 * the orchestrating checkout root. From the orchestrating checkout itself this
 * returns that same root, so callers can use it uniformly in both modes.
 *
 * Best-effort: on any git failure (not a repo, etc.) returns `cwd` unchanged, so
 * a degraded git state degrades to "write the ledger where I am" rather than
 * throwing.
 *
 * Lives here so the `canonical-fs-guard.test.ts` AC6f static guard stays
 * satisfied (only `lib/git.ts` may spawn `git`).
 */
export declare function resolveSessionLedgerRoot(opts: {
    cwd: string;
    execaImpl?: typeof defaultExeca;
}): Promise<string>;
/**
 * Return the repo-relative paths that are dirty (modified, added, deleted,
 * untracked, renamed) in the working tree at `cwd`, parsed from
 * `git status --porcelain -z`.
 *
 * Story 8.20: the drain's dev now edits *inside* its own worktree, so the dev's
 * own changes are exactly the dirty set of that worktree (a worktree cut clean
 * from `base` contains nothing else). `runDevTerminalAction` stages this
 * explicit set rather than `git add .` — defence in depth so a `.flow/state`
 * artefact or any unexpected untracked file is never swept into the story
 * commit even inside the worktree.
 *
 * `.flow/state/**` is dropped unconditionally: the backlog ledger is the tools'
 * domain and must never ride along in a story commit.
 *
 * Best-effort: a non-zero `git status` (not a repo, etc.) returns `[]`.
 *
 * Lives here so the `canonical-fs-guard.test.ts` AC6f static guard (which
 * forbids any file under `src/**` other than `lib/git.ts` from spawning `git`)
 * stays satisfied.
 */
export declare function listDirtyPaths(opts: {
    cwd: string;
    execaImpl?: typeof defaultExeca;
}): Promise<string[]>;
/**
 * Stash the working-tree changes at `cwd` onto the stash stack, non-destructively.
 *
 * Used by the drain's clean-root guard (`guardCleanRoot`): when the orchestrating
 * root checkout is unexpectedly dirty after a story — the `bgIsolation: "none"`
 * leak, where the dev's edits land in the shared root instead of its own worktree
 * (Epic 10 drain retro, Issue B) — the guard stashes the leaked edits so the NEXT
 * story's worktree is still cut from a clean base. A stash is fully recoverable
 * (`git stash list` / `git stash pop`), so this turns a silent leak into a
 * visible, safe one rather than discarding work.
 *
 * When `paths` is given, ONLY those pathspecs are stashed (`git stash push -- <p>`),
 * leaving everything else untouched. `-u` includes untracked files so a leaked new
 * file is captured too. (`.flow/**` is gitignored in this repo, so operational
 * state — ledger, telemetry, sessions — is never seen by `git status` and never
 * stashed; the caller's `listDirtyPaths` additionally drops `.flow/state/**`.)
 *
 * A `git stash` in the root operates on the root's own index/working-tree only —
 * sibling git worktrees keep their separate state — so a guard call is safe to run
 * between concurrent stories.
 *
 * Returns `{ stashed }` — false when git reports nothing to stash (a benign race
 * where the dirty set cleared between detection and the stash, or a transient
 * index-lock collision). Best-effort: a non-zero exit returns `stashed: false` so
 * a guard call can never break the drain.
 *
 * Lives here so the `canonical-fs-guard.test.ts` AC6f static guard (only
 * `lib/git.ts` may spawn `git`) stays satisfied.
 */
export declare function stashWorkingTree(opts: {
    cwd: string;
    paths?: readonly string[];
    message?: string;
    execaImpl?: typeof defaultExeca;
}): Promise<{
    stashed: boolean;
    stdout: string;
    stderr: string;
}>;
/**
 * Pre-PR leak gate: check whether the builder's own committed edits escaped its
 * worktree and dirtied the orchestrating shared master copy.
 *
 * In worktree-isolated mode the dev's `targetRepoRoot` (the worktree) is a
 * SEPARATE working tree from the orchestrating checkout. A builder that edits
 * via an ABSOLUTE shared-copy path bypasses the worktree boundary and dirties the
 * orchestrating root instead of its own worktree. This check detects that by:
 *
 *   1. Resolving the orchestrating root from inside the worktree via
 *      `resolveSessionLedgerRoot` (uses `git --git-common-dir`).
 *   2. If the resolved root equals the worktree cwd (the builder is NOT running
 *      inside a worktree — e.g. legacy `worktree: false` mode), there is nothing
 *      to check; returns `{ leaked: false, paths: [] }`.
 *   3. Otherwise calls `listDirtyPaths` on the orchestrating root, then intersects
 *      the result with `committedPaths` — only paths the builder actually committed
 *      count as a leak. Pre-existing stray edits in OTHER files are not the builder's
 *      concern and are left untouched (the clean-root guard handles them separately).
 *
 * Returns `{ leaked: true, paths: [...] }` when the builder's own committed paths
 * appear dirty in the shared root; `{ leaked: false, paths: [] }` when clean,
 * when running in non-worktree mode, or when committedPaths is empty.
 *
 * Best-effort: any git failure degrades to `leaked: false` (never breaks the
 * build). Only `run-dev-terminal-action.ts` should call this — the gate runs
 * AFTER the build/test gates and BEFORE the push so no PR is ever opened on a
 * leaking story.
 *
 * Lives here so the `canonical-fs-guard.test.ts` AC6f static guard (only
 * `lib/git.ts` may spawn `git`) stays satisfied.
 */
export declare function checkSharedRootLeak(opts: {
    worktreeCwd: string;
    /** The paths the builder committed — only these are tested for leakage. */
    committedPaths: readonly string[];
    execaImpl?: typeof defaultExeca;
}): Promise<{
    leaked: boolean;
    paths: string[];
    sharedRootPath: string;
}>;
