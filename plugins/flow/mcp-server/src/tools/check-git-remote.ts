/**
 * `checkGitRemote` — check whether the target repo has at least one configured
 * git remote (Story native:01KVS0ZW2GYSN25VC45GWNA4MG — run pre-flight checklist).
 *
 * Used by `run.workflow.js` during the pre-flight check so a workspace with no
 * configured remote is surfaced BEFORE the run claims and attempts to push a PR
 * (which would only fail at the push step, after a full dev build).
 *
 * Registered in `cli.ts` so it is callable on the no-MCP run path:
 *   node dist/cli.js checkGitRemote --json '{"targetRepoRoot":"..."}'
 */

import { execa } from "execa";

export interface CheckGitRemoteOptions {
  targetRepoRoot: string;
  /** Test seam — injected by tests; production callers omit this. */
  execaImpl?: typeof execa;
}

export interface CheckGitRemoteResult {
  /** True when `git remote` lists at least one remote name. */
  hasRemote: boolean;
}

/**
 * Run `git -C <targetRepoRoot> remote` and return whether any remote is
 * configured. Best-effort: any git exit-code other than 0 (e.g. not a git
 * repo) is treated as no remote (hasRemote = false) rather than throwing —
 * the pre-flight checklist surfaces this as an actionable item.
 */
export async function checkGitRemote(
  opts: CheckGitRemoteOptions,
): Promise<CheckGitRemoteResult> {
  const { targetRepoRoot } = opts;
  const execaImpl = opts.execaImpl ?? execa;

  let stdout = "";
  try {
    const result = await execaImpl("git", ["-C", targetRepoRoot, "remote"]);
    stdout = result.stdout ?? "";
  } catch {
    // Non-zero exit (not a git repo, git not installed, etc.) → no remote.
    return { hasRemote: false };
  }

  const hasRemote = stdout.trim().length > 0;
  return { hasRemote };
}
