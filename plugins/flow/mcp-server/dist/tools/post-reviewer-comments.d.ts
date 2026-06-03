/**
 * `postReviewerComments` MCP tool — Story 4.6b.
 *
 * Behavioural contract source:
 *   _bmad-output/implementation-artifacts/4-6b-reviewer-posts-inline-comments-and-summary-verdict.md
 *
 * Reads the persisted `reviewer-result.json` written by `runReviewerSession`,
 * composes a deterministic PR review summary body plus zero-or-more inline
 * comments, and posts them as a single PR review via `gh api` with event: COMMENT.
 *
 * The reviewer LLM's chat output is NOT consulted — the entire composition path
 * is: `reviewer-result.json` → pure composer functions → `gh api` POST.
 *
 * Invoked from SKILL.md prose AFTER the reviewer Task returns and BEFORE
 * `processReviewerTranscript` runs. It is a sibling of `processReviewerTranscript`,
 * not a wrapper.
 *
 * On ENOENT for `reviewer-result.json`: returns
 *   `{ next: "skipped-no-session-result", postedReviewId: null }` silently
 *   (the loud blocker is `processReviewerTranscript`'s job downstream).
 *
 * On malformed JSON / invalid shape: propagates `ReviewerResultFileMalformedError`.
 * On `GhRecoverableError`, `GhApiResponseShapeError`, `GhSubcommandDeniedError`:
 * propagates verbatim (no retry, no swallow).
 *
 * TODO(future): wire `reviewer.comments_posted` telemetry event here.
 *
 * Story 4.6b Task 4.
 */
import { execa as defaultExeca } from "execa";
export type PostReviewerCommentsResult = {
    /** File was absent — no verdict to post. processReviewerTranscript handles it. */
    next: "skipped-no-session-result";
    postedReviewId: null;
} | {
    /** Review successfully posted (first run) or PATCH-edited in place (rerun). */
    next: "posted";
    postedReviewId: number;
    /**
     * Number of inline comments submitted on POST. `null` on PATCH path —
     * signals "unknown / unchanged from prior pass", not zero.
     */
    inlineCommentCount: number | null;
    verdictLine: string;
    /** True when the prior verdict was PATCH-edited in place; false on first POST. */
    wasEdit: boolean;
    /** ID of the prior verdict review that was PATCH-edited. null on POST path. */
    priorReviewId: number | null;
};
export interface PostReviewerCommentsOptions {
    targetRepoRoot: string;
    sessionUlid: string;
    /**
     * Story ref (e.g. `"bmad:8.15"`). Required to derive the per-story
     * reviewer-result path (Story 8.15) so a multi-story drain reads THIS
     * story's verdict, not whichever story last ran in the shared session.
     */
    ref: string;
    role?: string;
    /** Test seam — production callers do not pass this. */
    execaImpl?: typeof defaultExeca;
    /** Plugin root override — test seam for loadRolePermissions. */
    pluginRootOverride?: string;
    /**
     * Test seam for the plugin version string. Uses `getPluginVersion()` when absent.
     * Named with `Override` suffix per project conventions (cf. `pluginRootOverride`).
     */
    pluginVersionOverride?: string;
    /**
     * When provided, use this body verbatim as the PR review summary instead of
     * composing from `composeSummaryBody`. All other behaviour (locked-marker grep,
     * edit-in-place idempotency) is unchanged. Used by `recordAgentInvoke` in the
     * 8-min reviewer hard-cap substitution path (AC3). Story 4.12 Task 4.
     */
    verdictBodyOverride?: string;
    /**
     * When provided, the emitted `reviewer.verdict` telemetry event carries this value
     * as its `verdict` field and `timed_out: true`. When absent, the verdict comes from
     * `resultFile.recommendedVerdict` and `timed_out: false`.
     * Only `"reviewer-failure"` is valid in v1. Story 4.12 Task 4.
     */
    reviewerVerdictOverride?: "reviewer-failure";
}
/**
 * Post the reviewer's verdict as a PR review with inline comments and a
 * summary body. Reads `reviewer-result.json` and composes everything
 * deterministically — no LLM step in the composition path.
 *
 * On rerun: GETs existing reviews, searches for a prior verdict footer marker,
 * and PATCH-edits the prior review body in place instead of posting a duplicate.
 *
 * @param opts.targetRepoRoot - Absolute path to the target repository root.
 * @param opts.sessionUlid - ULID of the calling reviewer session.
 * @param opts.role - Role name for gh permission lookup (default: "generalist-reviewer").
 * @param opts.execaImpl - Test seam for execa.
 * @param opts.pluginRootOverride - Test seam for plugin root path.
 * @param opts.pluginVersionOverride - Test seam for plugin version string.
 */
export declare function postReviewerComments(opts: PostReviewerCommentsOptions): Promise<PostReviewerCommentsResult>;
