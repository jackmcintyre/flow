/**
 * Shared helper: read, parse, and validate the `reviewer-result.json` file
 * written by `runReviewerSession`.
 *
 * Extracted from `tools/process-reviewer-transcript.ts` (Story 4.6 revision 2)
 * into this shared module so both `processReviewerTranscript` and the new
 * `postReviewerComments` tool (Story 4.6b) can call the same parser without
 * duplicating the null-on-ENOENT / throw-on-malformed behaviour.
 *
 * Story 4.6b Task 1.1; extended Story 4.7 Task 1.2 to carry standardsVersion.
 */
import type { ReviewerResultFileShape } from "../tools/run-reviewer-session.js";
export type { ReviewerResultFileShape };
/**
 * Sanitise a story ref into a single path-safe directory segment (Story 8.15).
 *
 * A drain run shares ONE session ULID across every story it processes, so the
 * reviewer-result file must be namespaced per story ref to stop a later story
 * clobbering an earlier one's verdict. BMad refs carry a colon (`bmad:8.15`)
 * and native refs are ULIDs; the colon (and any other path-meaningful
 * character) is not safe as a raw path segment. We replace every character
 * outside `[A-Za-z0-9._-]` with `_`, then map the empty string and the
 * path-traversal sentinels (`.`/`..`) to a safe token so the segment can never
 * escape the session directory or be empty.
 *
 * Deterministic: the writer (`runReviewerSession`) and every reader derive the
 * same segment from the same ref, so they always agree on the on-disk path.
 *
 * @param ref - Story ref, e.g. `"bmad:8.15"` or `"native:01HZ..."`.
 */
export declare function sanitiseRefForPathSegment(ref: string): string;
/**
 * Deterministically derive the absolute path to a story's `reviewer-result.json`
 * within a session, namespaced per ref (Story 8.15).
 *
 * Layout: `<targetRepoRoot>/.flow/state/sessions/<sessionUlid>/<sanitised-ref>/reviewer-result.json`.
 *
 * Used by BOTH the writer (`runReviewerSession`) and every reader so they cannot
 * disagree on where a verdict lives.
 */
export declare function reviewerResultFilePath(targetRepoRoot: string, sessionUlid: string, ref: string): string;
/**
 * Read, parse, and validate the `reviewer-result.json` file written by
 * `runReviewerSession`. Returns `null` when the file is absent (ENOENT).
 * Throws `ReviewerResultFileMalformedError` on malformed JSON or unexpected shape.
 *
 * The `standardsVersion` field is optional with a default of `""` for backward
 * compatibility with files produced by pre-4.7 plugin builds.
 *
 * Story 8.15: now takes the story `ref` and reads from the per-ref namespaced
 * path so two stories sharing one session ULID keep independent verdicts.
 *
 * @param targetRepoRoot - Absolute path to the target repository root.
 * @param sessionUlid - ULID of the calling session.
 * @param ref - Story ref, used to derive the per-story result path.
 */
export declare function readReviewerResultFile(targetRepoRoot: string, sessionUlid: string, ref: string): Promise<ReviewerResultFileShape | null>;
