/**
 * `materialisePrBranchWorktree` — Story 5.26.
 *
 * Fetches the PR's head ref via the existing `gh` wrapper (respecting
 * the reviewer role's `gh_allow` allowlist) and materialises it into a
 * temporary git worktree under the session directory. Returns the
 * worktree path and a cleanup callback per AC5.
 *
 * Behavioural contract:
 *   - Uses `gh pr view <prNumber> --json headRefName,headRefOid` via the
 *     existing `gh` wrapper (NOT raw execa — the wrapper enforces allowlists).
 *   - Runs `git fetch origin <headRefName>` to ensure the sha is in the
 *     local object DB (the PR's head may be newly pushed).
 *   - Worktree path: `<targetRepoRoot>/.flow/state/sessions/<sessionUlid>/review-worktree/`.
 *   - Stale-worktree reaping: if the path already exists, attempts
 *     `git worktree remove <path> --force` first (AC3e).
 *   - `git worktree add <path> <headRefOid>` — uses the sha (immutable),
 *     not the branch name.
 *   - Returns `{ worktreePath, headRefName, headRefOid, setupLog, cleanup }`.
 *   - `cleanup()` does `git worktree remove <path> --force`, catches errors,
 *     returns them as warnings (per AC5) — cleanup failures are NOT fatal.
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
  // Step 4: Compute worktree path.
  // -------------------------------------------------------------------------
  const worktreePath = path.join(
    targetRepoRoot,
    ".flow",
    "state",
    "sessions",
    sessionUlid,
    "review-worktree",
  );

  // -------------------------------------------------------------------------
  // Step 5: Stale-worktree reaping (AC3e) — if path already exists, remove it.
  // -------------------------------------------------------------------------
  let staleExists = false;
  try {
    await fs.access(worktreePath);
    staleExists = true;
  } catch {
    // Path does not exist — nothing to reap.
  }

  if (staleExists) {
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
          `Worktree is left under ${worktreePath} — operator can run 'git worktree prune' to clean up.`,
      );
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
