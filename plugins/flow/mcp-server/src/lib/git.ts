import * as path from "node:path";
import { execa as defaultExeca } from "execa";
import {
  GitCommitMessageMalformedError,
  NegativeCapabilityDeniedError,
  GitBranchNameMalformedError,
  GitPushFailedError,
  RebaseConflictError,
} from "../errors.js";

export interface GitCommitResult {
  commitSha: string;
  stdout: string;
  stderr: string;
}

/**
 * Required shape for plugin-side commit messages (Story 1.5 AC4 /
 * Epic-1 AC4): `<tool-name>: <ref-or-proposal-id>`. Lowercase tool
 * name (kebab allowed), colon, single space, non-whitespace body of
 * at least two characters.
 *
 * Matches `regenerateStandards: bmad:1.2.3` (architecture example)
 * and `appendPersonaKnowledge: <ulid>` (anticipated later usage).
 *
 * Note: `[a-z][a-z0-9-]*` is lowercase only — `regenerateStandards`
 * is rejected as written, but the architecture example uses that
 * exact string verbatim. We accept lowercase-letter-first plus
 * lowercase/digit/hyphen body to match the spec's stated regex
 * `/^[a-z][a-z0-9-]*: [^\s].+$/`. Tool names that happen to be
 * camelCase in code are written kebab-cased here.
 */
const PLUGIN_INTERNAL_COMMIT_REGEX = /^[a-z][a-z0-9-]*: [^\s].+$/;

/**
 * Required shape for conventional-commits subject lines (Story 4.4).
 * Format: `<type>(<ref>): <subject>` where type is one of the
 * CONVENTIONAL_COMMIT_TYPES set. The ref is the story ref (kebab/digits).
 * The subject is non-empty.
 */
export const CONVENTIONAL_COMMIT_TYPES = [
  "feat",
  "fix",
  "refactor",
  "test",
  "docs",
  "chore",
  "build",
  "ci",
  "perf",
  "style",
  "revert",
] as const;

const CONVENTIONAL_COMMIT_SUBJECT_REGEX =
  // Scope is the story ref `<adapter>:<id>` (e.g. `native:<ULID>`, `bmad:1.1`):
  // colon, uppercase (Crockford ULID), and dot are all valid in real refs. The
  // prior `[a-z0-9-]+` scope rejected every real ref (Story 8.1 / spike 2026-05-29).
  /^(feat|fix|refactor|test|docs|chore|build|ci|perf|style|revert)\([A-Za-z0-9._:-]+\): [^\s].+$/;

/**
 * Branch name pattern: `story/<kebab-alphanumeric>`. The slug-builder
 * in `pr-body.ts` always produces conforming names; this is a
 * defence-in-depth check in `gitCreateBranch`. (Story 4.4 Task 2.1)
 */
const STORY_BRANCH_REGEX = /^story\/[a-z0-9-]+$/;

// ---------------------------------------------------------------------------
// Negative-capability refusal helper (Story 4.4 AC2 / NFR16 / Pattern §9)
// ---------------------------------------------------------------------------

/**
 * The set of flags unconditionally refused by both the `git` and `gh`
 * wrappers in v1. No caller-supplied escape hatch exists in v1.
 *
 * - `--no-verify`: skips git hooks; forbidden globally.
 * - `--force`: bare force push; more dangerous than `--force-with-lease`.
 * - `--force-with-lease`: destructive; refused until an explicit
 *   operator-set escape hatch lands in a future story.
 * - `--force-with-lease=<ref>` (prefix form): same refusal.
 *
 * (Story 4.4 AC2 / NFR16 / Pattern §9)
 */
const NEGATIVE_FLAGS = new Set(["--no-verify", "--force", "--force-with-lease"]);

/**
 * Assert that `args` contains none of the unconditionally forbidden flags.
 * Throws `NegativeCapabilityDeniedError` BEFORE any subprocess spawn on
 * the first offending flag found.
 *
 * Exported so `lib/gh.ts` can re-use without duplicating the set.
 * (Story 4.4 Task 1.3)
 */
export function assertNoNegativeFlags(
  args: readonly string[],
  role: string,
  callSite: "gh" | "git",
): void {
  for (const arg of args) {
    if (
      NEGATIVE_FLAGS.has(arg) ||
      arg.startsWith("--force-with-lease=")
    ) {
      throw new NegativeCapabilityDeniedError({
        attempted_flag: NEGATIVE_FLAGS.has(arg) ? arg : "--force-with-lease",
        role,
        callSite,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Concurrent git-lock contention retry (concurrent drains — Story 8.20/8.22).
//
// Concurrent dev workers run mutating git ops (checkout -b, commit, push)
// against the SAME shared `.git`: drain worktrees share the common dir, and they
// push to one origin. Git does NOT fully serialise these — two workers can
// collide on the config/index/ref/packed-refs locks and the loser exits non-zero
// with a transient lock error. (Surfaced as a flaky `concurrent-drains-isolation`
// test that reds CI under load.) These helpers retry the transient lock failures
// with a short backoff; a non-lock failure (bad ref, malformed message, remote
// rejection, …) is re-thrown UNCHANGED on the first attempt, so every existing
// failure mode is preserved exactly. The same pattern guards `git worktree add`
// in dev-story-worktree.ts, which imports the constants below.
// ---------------------------------------------------------------------------

/** stderr substrings that mark a transient git-lock collision worth retrying. */
export const GIT_LOCK_CONTENTION =
  /could not lock|cannot lock|\.lock\b|update_ref failed|another git process/i;

/** Total attempts (initial + retries) before surfacing a git-lock failure. */
export const GIT_LOCK_MAX_ATTEMPTS = 8;

/** Base unit for the jittered backoff window (see `gitLockBackoffMs`). */
const GIT_LOCK_BACKOFF_BASE_MS = 25;

/**
 * Ceiling on a single backoff window. Bounds the worst-case stall on any one
 * retry so a slow/contended CI runner cannot park a worker for seconds.
 */
const GIT_LOCK_BACKOFF_CAP_MS = 500;

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
export function gitLockBackoffMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const window = Math.min(
    GIT_LOCK_BACKOFF_CAP_MS,
    GIT_LOCK_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1),
  );
  return Math.floor(random() * window);
}

/** Default backoff sleep (real timer); overridable via a `sleepImpl` test seam. */
export function defaultGitLockSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True if `value` (an Error, an execa result, or a string) carries a transient git-lock signature. */
function isGitLockContention(value: unknown): boolean {
  const stderr =
    typeof value === "string"
      ? value
      : String(
          (value as { stderr?: unknown })?.stderr ??
            (value as { message?: unknown })?.message ??
            "",
        );
  return GIT_LOCK_CONTENTION.test(stderr);
}

/**
 * Invoke a git-spawning thunk, retrying transient lock-contention failures with a
 * short backoff. The thunk MUST throw on failure (execa's default reject, or the
 * helper's own typed error) and MUST be idempotent on a lock-failed attempt — a
 * lock collision means the op did not mutate. On a non-lock error, or once the
 * attempt budget is exhausted, the ORIGINAL error is re-thrown UNCHANGED, so the
 * caller sees exactly the failure it did before this retry existed.
 */
async function retryGitOnLockContention<T>(
  thunk: () => Promise<T>,
  sleepImpl: (ms: number) => Promise<void>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await thunk();
    } catch (err) {
      if (attempt >= GIT_LOCK_MAX_ATTEMPTS || !isGitLockContention(err)) throw err;
      await sleepImpl(gitLockBackoffMs(attempt));
    }
  }
}

// ---------------------------------------------------------------------------
// gitCommit (Story 1.5 AC4, extended by Story 4.4 Task 2.3)
// ---------------------------------------------------------------------------

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
export async function gitCommit(opts: {
  targetRepoRoot: string;
  paths: readonly string[];
  message: string;
  role: string;
  messageShape?: "plugin-internal" | "conventional";
  body?: string;
  execaImpl?: typeof defaultExeca;
  /** Test seam for the lock-contention retry backoff (production omits this). */
  sleepImpl?: (ms: number) => Promise<void>;
}): Promise<GitCommitResult> {
  const { targetRepoRoot, paths, message } = opts;
  const messageShape = opts.messageShape ?? "plugin-internal";
  const execaImpl = opts.execaImpl ?? defaultExeca;
  const sleep = opts.sleepImpl ?? defaultGitLockSleep;

  if (paths.length === 0) {
    throw new GitCommitMessageMalformedError({
      message,
      paths,
      reason: "paths must not be empty",
    });
  }

  if (messageShape === "plugin-internal") {
    if (!PLUGIN_INTERNAL_COMMIT_REGEX.test(message)) {
      throw new GitCommitMessageMalformedError({
        message,
        paths,
        reason: "message does not match required shape",
      });
    }
  } else {
    // "conventional"
    if (!CONVENTIONAL_COMMIT_SUBJECT_REGEX.test(message)) {
      throw new GitCommitMessageMalformedError({
        message,
        paths,
        reason:
          "conventional-commits subject does not match required shape " +
          "`<type>(<ref>): <subject>` with recognised type",
      });
    }
  }

  await execaImpl("git", ["-C", targetRepoRoot, "add", ...paths]);

  const commitArgs: string[] = ["-C", targetRepoRoot, "commit", "-m", message];
  if (messageShape === "conventional" && opts.body) {
    commitArgs.push("-m", opts.body);
  }

  // The commit updates the branch ref in the shared `.git`; under concurrent
  // drains that ref update can lose a lock race. Retry on transient contention.
  const commitResult = await retryGitOnLockContention(
    () => execaImpl("git", commitArgs),
    sleep,
  );

  const revResult = await execaImpl("git", [
    "-C",
    targetRepoRoot,
    "rev-parse",
    "HEAD",
  ]);

  return {
    commitSha: (revResult.stdout ?? "").trim(),
    stdout: commitResult.stdout ?? "",
    stderr: commitResult.stderr ?? "",
  };
}

// ---------------------------------------------------------------------------
// gitCreateBranch (Story 4.4 Task 2.1)
// ---------------------------------------------------------------------------

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
export async function gitCreateBranch(opts: {
  targetRepoRoot: string;
  branchName: string;
  execaImpl?: typeof defaultExeca;
  /** Test seam for the lock-contention retry backoff (production omits this). */
  sleepImpl?: (ms: number) => Promise<void>;
}): Promise<void> {
  const { targetRepoRoot, branchName } = opts;
  const execaImpl = opts.execaImpl ?? defaultExeca;
  const sleep = opts.sleepImpl ?? defaultGitLockSleep;

  if (!STORY_BRANCH_REGEX.test(branchName)) {
    throw new GitBranchNameMalformedError({ branchName });
  }

  // `checkout -b` creates a ref in the shared `.git`; under concurrent drains
  // that ref creation can lose a lock race. Retry on transient contention.
  await retryGitOnLockContention(
    () => execaImpl("git", ["-C", targetRepoRoot, "checkout", "-b", branchName]),
    sleep,
  );
}

// ---------------------------------------------------------------------------
// gitPush (Story 4.4 Task 2.2)
// ---------------------------------------------------------------------------

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
export async function gitPush(opts: {
  targetRepoRoot: string;
  branchName: string;
  role: string;
  execaImpl?: typeof defaultExeca;
  /** Test seam for the lock-contention retry backoff (production omits this). */
  sleepImpl?: (ms: number) => Promise<void>;
}): Promise<void> {
  const { targetRepoRoot, branchName } = opts;
  const execaImpl = opts.execaImpl ?? defaultExeca;
  const sleep = opts.sleepImpl ?? defaultGitLockSleep;

  // Concurrent drains push different branches to ONE origin; the origin's ref
  // transaction can lose a lock race. The thunk throws GitPushFailedError on any
  // non-zero exit; the retry wrapper retries it only when the stderr signals
  // lock contention, and re-throws the same GitPushFailedError otherwise.
  await retryGitOnLockContention(async () => {
    const result = await execaImpl(
      "git",
      ["-C", targetRepoRoot, "push", "-u", "origin", branchName],
      { reject: false },
    );
    if ((result.exitCode ?? 0) !== 0) {
      throw new GitPushFailedError({
        branchName,
        stderr: (result as unknown as { stderr?: string }).stderr ?? "",
      });
    }
  }, sleep);
}

// ---------------------------------------------------------------------------
// gitFetch (Story native:01KT40THFTS10F9PT37KCW9PF4 — pre-PR sync gate)
// ---------------------------------------------------------------------------

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
export async function gitFetch(opts: {
  targetRepoRoot: string;
  role: string;
  execaImpl?: typeof defaultExeca;
  /** Test seam for the lock-contention retry backoff (production omits this). */
  sleepImpl?: (ms: number) => Promise<void>;
}): Promise<void> {
  const { targetRepoRoot, role } = opts;
  const execaImpl = opts.execaImpl ?? defaultExeca;
  const sleep = opts.sleepImpl ?? defaultGitLockSleep;

  const args = ["fetch", "origin"];
  // Belt-and-braces: the closed signature admits no caller flags, but route the
  // fixed args through the same negative-flag refusal anyway (Pattern §9 / NFR16).
  assertNoNegativeFlags(args, role, "git");

  await retryGitOnLockContention(
    () => execaImpl("git", ["-C", targetRepoRoot, ...args]),
    sleep,
  );
}

// ---------------------------------------------------------------------------
// gitRebaseOnto (Story native:01KT40THFTS10F9PT37KCW9PF4 — pre-PR sync gate)
// ---------------------------------------------------------------------------

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
export async function gitRebaseOnto(opts: {
  targetRepoRoot: string;
  role: string;
  /** Upstream ref to rebase onto. Defaults to `origin/main` (flow's trunk). */
  onto?: string;
  execaImpl?: typeof defaultExeca;
  /** Test seam for the lock-contention retry backoff (production omits this). */
  sleepImpl?: (ms: number) => Promise<void>;
}): Promise<void> {
  const { targetRepoRoot, role } = opts;
  const onto = opts.onto ?? "origin/main";
  const execaImpl = opts.execaImpl ?? defaultExeca;
  const sleep = opts.sleepImpl ?? defaultGitLockSleep;

  const args = ["rebase", onto];
  // Belt-and-braces: refuse a destructive overwrite instruction before any spawn.
  assertNoNegativeFlags(args, role, "git");

  await retryGitOnLockContention(async () => {
    const result = await execaImpl("git", ["-C", targetRepoRoot, ...args], {
      reject: false,
    });
    if ((result.exitCode ?? 0) === 0) return;

    const stdout = (result as unknown as { stdout?: string }).stdout ?? "";
    const stderr = (result as unknown as { stderr?: string }).stderr ?? "";

    // A non-zero rebase exit on a freshly-created never-pushed branch is a
    // genuine content conflict. Leave the tree clean before surfacing it.
    await execaImpl("git", ["-C", targetRepoRoot, "rebase", "--abort"], {
      reject: false,
    });

    throw new RebaseConflictError({
      reason: summariseRebaseConflict(stdout, stderr),
      conflictingPaths: parseConflictingPaths(stdout, stderr),
      stderr,
    });
  }, sleep);
}

/** Conflicting-path lines look like `CONFLICT (content): Merge conflict in <path>`. */
const REBASE_CONFLICT_PATH_REGEX = /Merge conflict in (.+)/g;

/** Extract the conflicting repo-relative paths from the rebase output. */
function parseConflictingPaths(stdout: string, stderr: string): string[] {
  const haystack = `${stdout}\n${stderr}`;
  const paths = new Set<string>();
  for (const match of haystack.matchAll(REBASE_CONFLICT_PATH_REGEX)) {
    const p = match[1]?.trim();
    if (p) paths.add(p);
  }
  return [...paths];
}

/**
 * Build a short, readable reason from the rebase output: the conflicting paths
 * if any were parsed, else an abbreviated stderr (first non-empty line).
 */
function summariseRebaseConflict(stdout: string, stderr: string): string {
  const paths = parseConflictingPaths(stdout, stderr);
  if (paths.length > 0) {
    return `rebase onto origin/main hit a content conflict in: ${paths.join(", ")}`;
  }
  const firstStderrLine = stderr
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return firstStderrLine
    ? `rebase onto origin/main failed: ${firstStderrLine}`
    : "rebase onto origin/main failed with a content conflict";
}

// ---------------------------------------------------------------------------
// gitInitWithEmptyCommit (Story 1.13 — smoke-harness scratch repo setup)
// ---------------------------------------------------------------------------

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
export async function gitInitWithEmptyCommit(opts: {
  cwd: string;
  execaImpl?: typeof defaultExeca;
}): Promise<void> {
  const { cwd } = opts;
  const execaImpl = opts.execaImpl ?? defaultExeca;

  await execaImpl("git", ["init", "-b", "main"], { cwd });
  await execaImpl(
    "git",
    [
      "-c",
      "user.email=flow-smoke@localhost",
      "-c",
      "user.name=flow-smoke",
      "commit",
      "--allow-empty",
      "-m",
      "chore: initial empty commit for smoke scratch repo",
    ],
    { cwd },
  );
}

// ---------------------------------------------------------------------------
// readRecentCommitTitles (Story 2.4 FR85)
// ---------------------------------------------------------------------------

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
export async function readRecentCommitTitles(opts: {
  cwd: string;
  limit?: number;
  execaImpl?: typeof defaultExeca;
}): Promise<string[]> {
  const limit = opts.limit ?? 5;
  const execaImpl = opts.execaImpl ?? defaultExeca;
  const result = await execaImpl("git", ["log", `-${limit}`, "--pretty=%s"], {
    cwd: opts.cwd,
    reject: false,
  });
  if (result.exitCode !== 0) return [];
  return (result.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// resolveSessionLedgerRoot (Story 8.20 — ledger root from inside a worktree)
// ---------------------------------------------------------------------------

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
export async function resolveSessionLedgerRoot(opts: {
  cwd: string;
  execaImpl?: typeof defaultExeca;
}): Promise<string> {
  const execaImpl = opts.execaImpl ?? defaultExeca;
  const result = await execaImpl(
    "git",
    ["-C", opts.cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { reject: false },
  );
  if ((result.exitCode ?? 1) !== 0) return opts.cwd;
  const commonDir = (typeof result.stdout === "string" ? result.stdout : "").trim();
  if (!commonDir) return opts.cwd;
  // `<root>/.git` → `<root>`. A bare repo would return the repo dir itself; the
  // drain never runs against a bare repo, so the simple parent-of-.git holds.
  return path.dirname(commonDir);
}

// ---------------------------------------------------------------------------
// listDirtyPaths (Story 8.20 — explicit per-worktree stage set)
// ---------------------------------------------------------------------------

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
export async function listDirtyPaths(opts: {
  cwd: string;
  execaImpl?: typeof defaultExeca;
}): Promise<string[]> {
  const execaImpl = opts.execaImpl ?? defaultExeca;
  const result = await execaImpl(
    "git",
    ["-C", opts.cwd, "status", "--porcelain", "-z"],
    { reject: false },
  );
  if ((result.exitCode ?? 1) !== 0) return [];
  const stdout = typeof result.stdout === "string" ? result.stdout : "";

  const out: string[] = [];
  const records = stdout.split("\0").filter((r) => r.length > 0);
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    // Each record: XY<space>PATH. A rename/copy emits the destination path as
    // the NEXT NUL-record.
    const xy = rec.slice(0, 2);
    const p = rec.slice(3);
    if (xy[0] === "R" || xy[0] === "C") {
      const dest = records[i + 1];
      if (dest !== undefined) {
        out.push(dest);
        i++;
        continue;
      }
    }
    out.push(p);
  }
  return out.filter(
    (p) => !p.startsWith(".flow/state/") && p !== ".flow/state" && p !== ".flow",
  );
}

// ---------------------------------------------------------------------------
// stashWorkingTree (Epic 10 drain fix-plan — Fix 2b, clean-root guard)
// ---------------------------------------------------------------------------

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
export async function stashWorkingTree(opts: {
  cwd: string;
  paths?: readonly string[];
  message?: string;
  execaImpl?: typeof defaultExeca;
}): Promise<{ stashed: boolean; stdout: string; stderr: string }> {
  const execaImpl = opts.execaImpl ?? defaultExeca;
  const args = ["-C", opts.cwd, "stash", "push", "-u"];
  if (opts.message) args.push("-m", opts.message);
  if (opts.paths && opts.paths.length > 0) args.push("--", ...opts.paths);

  const result = await execaImpl("git", args, { reject: false });
  const exitCode = result.exitCode ?? 1;
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  // `git stash push` exits 0 and prints "No local changes to save" when there is
  // nothing to stash; a real stash prints "Saved working directory ...".
  const stashed = exitCode === 0 && !/No local changes to save/i.test(stdout);
  return { stashed, stdout, stderr };
}
