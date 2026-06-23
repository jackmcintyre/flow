/**
 * `resolveRunBase` — report the current local HEAD and whether it diverges from
 * `origin/<base>` on tracked config paths (Story native:01KVS1150C7H9HCGG07Y0XBT98
 * — each story is built from the operator's current local HEAD).
 *
 * Used by `run.workflow.js` in the pre-flight checklist to:
 *   1. Confirm the local HEAD SHA (the commit each story's worktree is cut from).
 *   2. Detect when root HEAD carries committed tracked-config (team/, docs/standards.md)
 *      that the remote base lacks, so the run can fail loud rather than silently
 *      sourcing config from one commit and code from another.
 *
 * Registered in `cli.ts` so it is callable on the no-MCP run path:
 *   node dist/cli.js resolveRunBase --json '{"targetRepoRoot":"...","baseBranch":"main"}'
 *
 * Config-divergence definition: at least one tracked file under `team/` or at
 * `docs/standards.md` is present on local HEAD but absent on `origin/<baseBranch>`,
 * OR is committed differently. Detected via `git diff --name-only <originRef> HEAD
 * -- team/ docs/standards.md`.
 */

import { execa } from "execa";

// Tracked config paths the run reads from the repo root — team/ and docs/standards.md.
// A diff between local HEAD and origin/<base> on these paths is a config divergence.
export const CONFIG_PATH_PREFIXES = ["team/", "docs/standards.md"];

export interface ResolveRunBaseOptions {
  /** Absolute path to the target repo root. */
  targetRepoRoot: string;
  /**
   * The trunk / base branch name. Defaults to "main".
   * Used to derive the remote ref (`origin/<baseBranch>`) to compare against.
   */
  baseBranch?: string;
  /** Test seam — injected by tests; production callers omit this. */
  execaImpl?: typeof execa;
}

export interface ResolveRunBaseResult {
  /**
   * The full SHA of the current local HEAD commit.
   * Each story's per-dev worktree will be cut from this commit when
   * `worktree.baseRef: "head"` is set in the project settings.
   */
  localHead: string;
  /**
   * The full SHA of `origin/<baseBranch>` — the remote ref the pre-PR
   * sync-gate rebases story branches onto. May be null when the remote
   * ref cannot be resolved (no remote, no fetch yet — the remote-check
   * pre-flight will already have caught this case).
   */
  originHead: string | null;
  /**
   * True when at least one tracked config path (team/ or docs/standards.md)
   * differs between local HEAD and `origin/<baseBranch>`. When true, the run
   * fails loud: it cannot safely source config from root (local HEAD) while
   * the dev's worktree is cut from an older `origin/<baseBranch>`, because
   * the two commits would give different config to the run vs the builder.
   *
   * Note: with `worktree.baseRef: "head"` set, both the root AND the worktree
   * are at local HEAD — diverges will be false for normal runs. This check is
   * a belt-and-braces guard for cases where the setting is absent or overridden.
   */
  configDiverges: boolean;
  /**
   * The tracked config paths that differ between local HEAD and
   * `origin/<baseBranch>`. Empty when `configDiverges` is false.
   */
  divergingPaths: string[];
}

async function runGit(
  args: string[],
  cwd: string,
  execaImpl: typeof execa,
): Promise<{ stdout: string; exitCode: number }> {
  const result = await execaImpl("git", args, { cwd, reject: false });
  return {
    stdout: typeof result.stdout === "string" ? result.stdout.trim() : "",
    exitCode: typeof result.exitCode === "number" ? result.exitCode : 1,
  };
}

/**
 * Resolve the current local HEAD SHA and check for config divergence against
 * `origin/<baseBranch>`.
 */
export async function resolveRunBase(
  opts: ResolveRunBaseOptions,
): Promise<ResolveRunBaseResult> {
  const { targetRepoRoot } = opts;
  const baseBranch = opts.baseBranch ?? "main";
  const execaImpl = opts.execaImpl ?? execa;
  const originRef = `origin/${baseBranch}`;

  // Step 1: Resolve local HEAD SHA.
  const headResult = await runGit(
    ["-C", targetRepoRoot, "rev-parse", "HEAD"],
    targetRepoRoot,
    execaImpl,
  );
  const localHead = headResult.exitCode === 0 ? headResult.stdout : "";

  // Step 2: Resolve origin/<baseBranch> SHA. Fail-soft: a missing remote or
  // un-fetched remote returns null (the remote-check pre-flight handles this).
  const originResult = await runGit(
    ["-C", targetRepoRoot, "rev-parse", originRef],
    targetRepoRoot,
    execaImpl,
  );
  const originHead =
    originResult.exitCode === 0 ? originResult.stdout : null;

  // Step 3: Detect config divergence. Only meaningful when both refs are known
  // and they differ (if they are the same commit, there can be no divergence).
  let configDiverges = false;
  let divergingPaths: string[] = [];

  if (localHead && originHead && localHead !== originHead) {
    // `git diff --name-only <originRef> HEAD -- team/ docs/standards.md`
    // lists tracked files under the config paths that differ between the two
    // commits. An empty result means no config divergence.
    const diffResult = await runGit(
      [
        "-C", targetRepoRoot,
        "diff",
        "--name-only",
        originRef,
        "HEAD",
        "--",
        ...CONFIG_PATH_PREFIXES,
      ],
      targetRepoRoot,
      execaImpl,
    );
    if (diffResult.exitCode === 0 && diffResult.stdout.length > 0) {
      divergingPaths = diffResult.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      configDiverges = divergingPaths.length > 0;
    }
  }

  return { localHead, originHead, configDiverges, divergingPaths };
}
