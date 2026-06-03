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
export type ApplyReviewerLabelsResult = {
    /** reviewer-result.json was absent — skip silently. */
    next: "skipped-no-session-result";
} | {
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
export declare function applyReviewerLabels(opts: ApplyReviewerLabelsOptions): Promise<ApplyReviewerLabelsResult>;
