/**
 * `materialisePrBranchWorktree` — Story 5.26, hardened in native:01KTSQQQ00PTHY7YP8XP5SX31G,
 * relocated outside project folder in native:01KTSR2GJ78FJY2RXRGH2D59HC.
 *
 * Fetches the PR's head ref via the existing `gh` wrapper (respecting
 * the reviewer role's `gh_allow` allowlist) and materialises it into a
 * temporary git worktree OUTSIDE the main project checkout. Returns the
 * worktree path and a cleanup callback per AC5.
 *
 * Behavioural contract:
 *   - Uses `gh pr view <prNumber> --json headRefName,headRefOid` via the
 *     existing `gh` wrapper (NOT raw execa — the wrapper enforces allowlists).
 *   - Runs `git fetch origin <headRefName>` to ensure the sha is in the
 *     local object DB (the PR's head may be newly pushed).
 *   - Worktree path: `<parent>/.flow-worktrees/<sessionUlid>/review-<sanitised-storyRef>-worktree`.
 *     Sits OUTSIDE targetRepoRoot (a sibling of the checkout), following the same
 *     convention as dev-story worktrees (native:01KTSR2GJ78FJY2RXRGH2D59HC AC1/AC4).
 *     Keyed on the story ref so two concurrent reviews for different stories
 *     resolve to distinct folders (native:01KTSQQQ00PTHY7YP8XP5SX31G).
 *   - Self-heal dangling registrations: if the worktree path is NOT on disk but
 *     git still has a stale registration pointing there (i.e. the folder was
 *     hand-deleted), runs `git worktree prune` to clear the dangling entry before
 *     `git worktree add` (native:01KTSR2GJ78FJY2RXRGH2D59HC AC3).
 *   - Stale-worktree reaping: if the per-story path already EXISTS on disk, attempts
 *     `git worktree remove <path> --force` first; only ever targets the
 *     requesting story's own folder, never a sibling's checkout or the
 *     shared parent directory.
 *   - `git worktree add <path> <headRefOid>` — uses the sha (immutable),
 *     not the branch name.
 *   - Returns `{ worktreePath, headRefName, headRefOid, setupLog, cleanup }`.
 *   - `cleanup()` does `git worktree remove <path> --force`, catches errors,
 *     returns them as warnings (per AC5) — cleanup failures are NOT fatal.
 *     cleanup() only ever removes the per-story folder, never the shared parent.
 *   - On any `gh` failure: throws `ReviewerPrBranchFetchError` (AC4).
 *     Never falls back silently to the local filesystem.
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { execa as defaultExeca } from "execa";
import { gh } from "./gh.js";
import { loadRolePermissions } from "../state/load-role-permissions.js";
import { getPluginRoot } from "./plugin-root.js";
import { ReviewerPrBranchFetchError } from "../errors.js";
import { sanitiseRefForPathSegment } from "./read-reviewer-result-file.js";
import type { RolePermissions } from "../schemas/role-permissions.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MateriaisePrBranchWorktreeResult {
  /** Absolute path to the materialised worktree. */
  worktreePath: string;
  /** Branch name of the PR head ref (informational). */
  headRefName: string;
  /** Commit sha materialised into the worktree (immutable). */
  headRefOid: string;
  /** Diagnostic log from the setup phase (stale-worktree reaping, etc.). */
  setupLog: string[];
  /** Unconditional cleanup: removes the worktree. Errors become warnings, NOT fatal. */
  cleanup: () => Promise<{ warnings: string[] }>;
}

export interface MateriaisePrBranchWorktreeOpts {
  targetRepoRoot: string;
  sessionUlid: string;
  prNumber: number;
  /**
   * The story ref being reviewed (e.g. `"native:01HZ..."`).
   *
   * Used to key the review-checkout folder so two concurrent reviews for
   * different stories resolve to distinct folders and neither can trample the
   * other's in-flight copy (native:01KTSQQQ00PTHY7YP8XP5SX31G).
   *
   * Required.  The colon and any other path-unsafe characters are sanitised
   * the same way as the reviewer-result file path (see `sanitiseRefForPathSegment`).
   */
  storyRef: string;
  role?: string;
  /** Test seam — production callers do not pass this. */
  execaImpl?: typeof defaultExeca;
  /** Plugin root override — test seam for loadRolePermissions. */
  pluginRootOverride?: string;
  /**
   * Test seam: pre-loaded permissions. If provided, skips the
   * `loadRolePermissions` file read so tests can inject a minimal stub.
   */
  permissionsOverride?: RolePermissions;
}

// ---------------------------------------------------------------------------
// Path helpers (exported so tests and future reapers can resolve the path
// deterministically without calling the full materialise function).
// ---------------------------------------------------------------------------

/**
 * The base directory that holds ALL of a session's review worktrees — a sibling
 * of the checkout under `<parent>/.flow-worktrees/<sessionUlid>`.
 *
 * Mirrors `devStoryWorktreesRoot` from `dev-story-worktree.ts` so both
 * builder and reviewer checkouts follow one location family.
 *
 * @internal — use `reviewWorktreePath` for the full per-story path.
 */
function reviewWorktreesRoot(
  targetRepoRoot: string,
  sessionUlid: string,
): string {
  return path.join(
    path.dirname(targetRepoRoot),
    ".flow-worktrees",
    sessionUlid,
  );
}

/**
 * The worktree path for one story review in one session.
 *
 * Lives OUTSIDE `targetRepoRoot` so the review's test run resolves the PR's
 * own tools and dependencies, never those of the main project folder.
 *
 * Exported for tests and future stale-reap tooling.
 */
export function reviewWorktreePath(
  targetRepoRoot: string,
  sessionUlid: string,
  storyRef: string,
): string {
  const storySlug = sanitiseRefForPathSegment(storyRef);
  return path.join(
    reviewWorktreesRoot(targetRepoRoot, sessionUlid),
    `review-${storySlug}-worktree`,
  );
}

// ---------------------------------------------------------------------------
// Internal: run a git subcommand via execa (NOT the gh wrapper — git
// operations bypass the allowlist, per the spec note in Implementation Notes).
// ---------------------------------------------------------------------------

async function runGit(
  args: string[],
  cwd: string,
  execaImpl: typeof defaultExeca,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await execaImpl("git", args, { cwd, reject: false });
  return {
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    exitCode: typeof result.exitCode === "number" ? result.exitCode : 1,
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function materialisePrBranchWorktree(
  opts: MateriaisePrBranchWorktreeOpts,
): Promise<MateriaisePrBranchWorktreeResult> {
  const {
    targetRepoRoot,
    sessionUlid,
    prNumber,
    storyRef,
    role = "generalist-reviewer",
    pluginRootOverride,
  } = opts;
  const execaImpl = opts.execaImpl ?? defaultExeca;
  const pluginRoot = pluginRootOverride ?? getPluginRoot();
  const setupLog: string[] = [];

  // -------------------------------------------------------------------------
  // Step 1: Load role permissions (or use override from test seam).
  // -------------------------------------------------------------------------
  const permissions =
    opts.permissionsOverride ??
    (await loadRolePermissions({ role, pluginRoot }));

  // -------------------------------------------------------------------------
  // Step 2: Fetch headRefName + headRefOid via the gh wrapper (respects
  // the reviewer role's gh_allow: pr-view allowlist entry).
  // -------------------------------------------------------------------------
  let headRefName: string;
  let headRefOid: string;

  try {
    const result = await gh({
      role,
      permissions,
      subcommand: "pr-view",
      args: [String(prNumber), "--json", "headRefName,headRefOid"],
      execaImpl,
      pluginRootOverride: pluginRoot,
    });

    const parsed = JSON.parse(result.stdout) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>).headRefName !== "string" ||
      typeof (parsed as Record<string, unknown>).headRefOid !== "string"
    ) {
      throw new Error(
        `gh pr view --json headRefName,headRefOid returned unexpected shape: ${result.stdout}`,
      );
    }
    headRefName = (parsed as { headRefName: string; headRefOid: string }).headRefName;
    headRefOid = (parsed as { headRefName: string; headRefOid: string }).headRefOid;
  } catch (err) {
    // Wrap ANY error from the gh call as ReviewerPrBranchFetchError (AC4).
    throw new ReviewerPrBranchFetchError({
      prNumber,
      ghSubcommand: "pr-view",
      underlyingMessage: err instanceof Error ? err.message : String(err),
    });
  }

  // -------------------------------------------------------------------------
  // Step 3: git fetch origin <headRefName> so the sha is in the local object DB.
  // -------------------------------------------------------------------------
  const fetchResult = await runGit(
    ["fetch", "origin", headRefName],
    targetRepoRoot,
    execaImpl,
  );
  if (fetchResult.exitCode !== 0) {
    setupLog.push(
      `[materialise-pr-branch-worktree] git fetch origin ${headRefName} failed ` +
        `(exit ${fetchResult.exitCode}): ${fetchResult.stderr}`,
    );
    // Non-fatal: the sha may already be present locally. Proceed; worktree add
    // will fail with a clear message if the sha truly isn't available.
  }

  // -------------------------------------------------------------------------
  // Step 4: Compute worktree path — per-story, OUTSIDE targetRepoRoot.
  //
  // Lives in `<parent>/.flow-worktrees/<sessionUlid>/review-<slug>-worktree`
  // alongside dev-story worktrees (native:01KTSR2GJ78FJY2RXRGH2D59HC AC1/AC4),
  // so the review's test run resolves the PR's own tools and dependencies and
  // never those of the main project folder.
  //
  // Keyed on the sanitised story ref so two reviews running at the same time
  // resolve to two distinct folders and neither can trample the other's
  // in-flight checkout (native:01KTSQQQ00PTHY7YP8XP5SX31G).
  // -------------------------------------------------------------------------
  const worktreePath = reviewWorktreePath(targetRepoRoot, sessionUlid, storyRef);

  // Ensure the parent directory exists before we attempt worktree add (mirrors
  // dev-story-worktree.ts which also mkdir -p's before the add).
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });

  // -------------------------------------------------------------------------
  // Step 5: Stale-worktree reaping + dangling-registration self-heal.
  //
  // Two distinct cases:
  //
  // Case A (folder EXISTS on disk): a previous run left the path populated.
  //   → git worktree remove --force, fall back to fs.rm.
  //
  // Case B (folder MISSING but git registration PRESENT — "dangling"): the
  //   folder was hand-deleted but git still has a record pointing there.
  //   `git worktree add` would fail with "already registered".
  //   → git worktree prune so git removes the dangling entry (native:01KTSR2GJ78FJY2RXRGH2D59HC AC3).
  //
  // Both cases are checked before proceeding to `git worktree add`.
  // -------------------------------------------------------------------------
  let staleExists = false;
  try {
    await fs.access(worktreePath);
    staleExists = true;
  } catch {
    // Path does not exist — check for a dangling registration (Case B).
  }

  if (staleExists) {
    // Case A: folder is on disk — try to remove it via git, then fs.rm.
    setupLog.push(
      `[materialise-pr-branch-worktree] stale worktree detected at ${worktreePath}; reaping.`,
    );
    // Attempt 1: git worktree remove (handles registered worktrees cleanly).
    const reapResult = await runGit(
      ["worktree", "remove", worktreePath, "--force"],
      targetRepoRoot,
      execaImpl,
    );
    if (reapResult.exitCode !== 0) {
      setupLog.push(
        `[materialise-pr-branch-worktree] git worktree remove failed ` +
          `(exit ${reapResult.exitCode}): ${reapResult.stderr}. ` +
          `Falling back to fs.rm for unregistered stale path.`,
      );
      // Attempt 2: plain fs.rm (handles manually-created or crashed-mid-add paths).
      try {
        await fs.rm(worktreePath, { recursive: true, force: true });
        // Prune any dangling registration left after fs.rm.
        await runGit(["worktree", "prune"], targetRepoRoot, execaImpl);
        setupLog.push(
          `[materialise-pr-branch-worktree] stale path removed via fs.rm.`,
        );
      } catch (rmErr) {
        setupLog.push(
          `[materialise-pr-branch-worktree] fs.rm also failed: ${rmErr instanceof Error ? rmErr.message : String(rmErr)}. ` +
            `Attempting worktree add anyway.`,
        );
      }
    } else {
      setupLog.push(
        `[materialise-pr-branch-worktree] stale worktree removed successfully.`,
      );
    }
  } else {
    // Case B: folder is absent — prune any dangling git registration that may
    // remain from a previous hand-delete, so `git worktree add` does not fail
    // with "already registered" (native:01KTSR2GJ78FJY2RXRGH2D59HC AC3).
    // `git worktree prune` is idempotent and safe to run when there is nothing
    // to prune; the only risk is collateral over-reach, but git only prunes
    // registrations whose paths no longer exist — live sibling worktrees are
    // never disturbed.
    const pruneResult = await runGit(
      ["worktree", "prune"],
      targetRepoRoot,
      execaImpl,
    );
    if (pruneResult.exitCode !== 0) {
      setupLog.push(
        `[materialise-pr-branch-worktree] git worktree prune failed ` +
          `(exit ${pruneResult.exitCode}): ${pruneResult.stderr}. ` +
          `Proceeding — add may still succeed if no dangling registration existed.`,
      );
    } else {
      setupLog.push(
        `[materialise-pr-branch-worktree] git worktree prune completed (cleared any dangling registrations).`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Step 6: git worktree add <worktreePath> <headRefOid> (use sha, not branch name).
  // -------------------------------------------------------------------------
  const addResult = await runGit(
    ["worktree", "add", worktreePath, headRefOid],
    targetRepoRoot,
    execaImpl,
  );
  if (addResult.exitCode !== 0) {
    throw new ReviewerPrBranchFetchError({
      prNumber,
      ghSubcommand: "pr-view",
      underlyingMessage:
        `git worktree add ${worktreePath} ${headRefOid} failed ` +
        `(exit ${addResult.exitCode}): ${addResult.stderr}`,
    });
  }

  // -------------------------------------------------------------------------
  // Step 7: Build cleanup callback (AC5).
  // -------------------------------------------------------------------------
  async function cleanup(): Promise<{ warnings: string[] }> {
    const warnings: string[] = [];
    const removeResult = await runGit(
      ["worktree", "remove", worktreePath, "--force"],
      targetRepoRoot,
      execaImpl,
    );
    if (removeResult.exitCode !== 0) {
      warnings.push(
        `[materialise-pr-branch-worktree] cleanup: git worktree remove ${worktreePath} --force ` +
          `failed (exit ${removeResult.exitCode}): ${removeResult.stderr}. ` +
          `Worktree is left at ${worktreePath} — operator can run 'git worktree prune' to clean up.`,
      );
      // Belt-and-braces: fs.rm + prune so the path does not accumulate across runs.
      try {
        await fs.rm(worktreePath, { recursive: true, force: true });
        await runGit(["worktree", "prune"], targetRepoRoot, execaImpl);
      } catch {
        // Already reported above — don't shadow with a secondary error.
      }
    }
    return { warnings };
  }

  return {
    worktreePath,
    headRefName,
    headRefOid,
    setupLog,
    cleanup,
  };
}
