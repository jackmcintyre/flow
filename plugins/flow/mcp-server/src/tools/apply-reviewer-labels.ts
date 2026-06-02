/**
 * `applyReviewerLabels` MCP tool — Story 4.8.
 *
 * Behavioural contract source:
 *   _bmad-output/implementation-artifacts/4-8-reviewer-labels-and-negative-capability-enforcement.md
 *
 * Reads the persisted `reviewer-result.json` written by `runReviewerSession`,
 * resolves owner/repo via `gh repo view --json owner,name`, and applies
 * GitHub labels to the PR via `gh api POST /issues/{prNumber}/labels`.
 *
 * Label logic:
 *   - Any verdict (including reviewer-failure): adds `reviewed-by-agent`
 *   - Non-green verdict (NEEDS CHANGES, BLOCKED, reviewer-failure): also adds `needs-human`
 *   - READY FOR MERGE: adds only `reviewed-by-agent`
 *
 * The two calls for non-green outcomes are sequential, not batched.
 * If the first call fails, the second is NOT made.
 *
 * On ENOENT for `reviewer-result.json`: returns `{ next: "skipped-no-session-result" }`.
 * On malformed JSON: propagates `ReviewerResultFileMalformedError` uncaught.
 * On `GhRecoverableError`, `GhApiResponseShapeError`: propagates uncaught.
 *
 * TODO(future): wire `reviewer.labels_applied` telemetry event here.
 *
 * Story 4.8.
 */

import { execa as defaultExeca } from "execa";
import { loadRolePermissions } from "../state/load-role-permissions.js";
import { gh } from "../lib/gh.js";
import { getPluginRoot } from "../lib/plugin-root.js";
import { readReviewerResultFile } from "../lib/read-reviewer-result-file.js";
import { GhApiResponseShapeError } from "../errors.js";
import type { execa } from "execa";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApplyReviewerLabelsResult =
  | {
      /** reviewer-result.json was absent — skip silently. */
      next: "skipped-no-session-result";
    }
  | {
      /** Labels were successfully applied to the PR. */
      next: "applied";
      labelsApplied: string[];
    };

export interface ApplyReviewerLabelsOptions {
  targetRepoRoot: string;
  sessionUlid: string;
  /**
   * Story ref (e.g. `"bmad:8.15"`). Required to derive the per-story
   * reviewer-result path (Story 8.15) so a multi-story drain reads THIS
   * story's verdict, not whichever story last ran in the shared session.
   */
  ref: string;
  /**
   * When set to `"reviewer-failure"`, forces non-green label treatment
   * regardless of what `reviewer-result.json` says. Used in the SKILL.md
   * error handler when the reviewer cycle fails before writing a verdict.
   */
  verdictOverride?: "reviewer-failure";
  role?: string;
  /** Test seam — production callers do not pass this. */
  execaImpl?: typeof defaultExeca;
  /** Plugin root override — test seam for loadRolePermissions. */
  pluginRootOverride?: string;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Apply `reviewed-by-agent` (always) and `needs-human` (non-green) labels
 * to the PR associated with the given session.
 *
 * @param opts.targetRepoRoot - Absolute path to the target repository root.
 * @param opts.sessionUlid - ULID of the calling reviewer session.
 * @param opts.verdictOverride - When `"reviewer-failure"`, treats the outcome
 *   as non-green regardless of `reviewer-result.json`.
 * @param opts.role - Role name for gh permission lookup (default: "generalist-reviewer").
 * @param opts.execaImpl - Test seam for execa.
 * @param opts.pluginRootOverride - Test seam for plugin root path.
 */
export async function applyReviewerLabels(
  opts: ApplyReviewerLabelsOptions,
): Promise<ApplyReviewerLabelsResult> {
  const role = opts.role ?? "generalist-reviewer";
  const pluginRoot = opts.pluginRootOverride ?? getPluginRoot();
  const execaImpl = opts.execaImpl ?? defaultExeca;

  // Step 1: Read the persisted reviewer-result.json file (Story 8.15: per-ref path).
  const resultFile = await readReviewerResultFile(opts.targetRepoRoot, opts.sessionUlid, opts.ref);

  if (resultFile === null) {
    // File absent — skip silently. processReviewerTranscript surfaces the loud blocker.
    return { next: "skipped-no-session-result" };
  }

  const permissions = await loadRolePermissions({ role, pluginRoot });

  // Step 2: Resolve prNumber from the result file.
  const prNumber = resultFile.prNumber;

  // Step 3: Resolve owner/repo via `gh repo view --json owner,name`.
  const repoViewResult = await gh({
    role,
    permissions,
    subcommand: "repo-view",
    args: ["--json", "owner,name"],
    execaImpl,
    pluginRootOverride: pluginRoot,
  });

  let owner: string;
  let repo: string;
  try {
    const repoViewJson = JSON.parse(repoViewResult.stdout) as {
      name?: string;
      owner?: { login?: string };
    };
    owner = repoViewJson.owner?.login ?? "";
    repo = repoViewJson.name ?? "";
    if (!owner || !repo) {
      throw new Error("missing owner or repo in repo-view shape");
    }
  } catch (cause) {
    throw new GhApiResponseShapeError({ subcommand: "repo-view", cause });
  }

  // Step 4: Determine verdict and labels to apply.
  const effectiveVerdict = opts.verdictOverride ?? resultFile.recommendedVerdict;

  let labelsToApply: string[];
  if (effectiveVerdict === "READY FOR MERGE") {
    labelsToApply = ["reviewed-by-agent"];
  } else {
    // NEEDS CHANGES | BLOCKED | reviewer-failure
    labelsToApply = ["reviewed-by-agent", "needs-human"];
  }

  // Step 5: Apply each label sequentially via `gh api POST /issues/{prNumber}/labels`.
  // One label per call to keep error attribution clear.
  const labelsUrl = `/repos/${owner}/${repo}/issues/${prNumber}/labels`;

  const labelsApplied: string[] = [];
  for (const labelName of labelsToApply) {
    const labelResult = await gh({
      role,
      permissions,
      subcommand: "api",
      args: [labelsUrl, "--method", "POST", "--input", "-"],
      input: JSON.stringify({ labels: [labelName] }),
      execaImpl,
      pluginRootOverride: pluginRoot,
    });

    // Parse response — labels endpoint returns the updated label list (array).
    try {
      const parsed: unknown = JSON.parse(labelResult.stdout);
      if (!Array.isArray(parsed)) {
        throw new Error(`expected array, got ${typeof parsed}`);
      }
    } catch (cause) {
      throw new GhApiResponseShapeError({ subcommand: "api", url: labelsUrl, cause });
    }

    labelsApplied.push(labelName);
  }

  // Step 6: Return success with the list of labels sent.
  return { next: "applied", labelsApplied };
}
