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
import { execa as defaultExeca } from "execa";
import type { RolePermissions } from "../schemas/role-permissions.js";
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
    cleanup: () => Promise<{
        warnings: string[];
    }>;
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
export declare function materialisePrBranchWorktree(opts: MateriaisePrBranchWorktreeOpts): Promise<MateriaisePrBranchWorktreeResult>;
