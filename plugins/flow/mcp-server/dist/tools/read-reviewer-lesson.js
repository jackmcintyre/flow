/**
 * `readReviewerLesson` CLI read seam — Story native:01KT6GSV8KTTKKHPRGEJWJAGZV
 * (learning-loop producer — FORWARD half, read side).
 *
 * The drain's FORWARD step needs the lesson the reviewer captured (via
 * `recordReviewerLesson`) off the per-ref `reviewer-result.json`, so it can hand
 * it to `recordStoryRetro` and land it on the done manifest before the merge gate
 * runs. This is that read: a thin, read-only, idempotent seam over
 * `readReviewerResultFile` that returns ONLY the optional `lesson` field.
 *
 * Read-only by design — it never writes and never throws on a missing file:
 *   - No reviewer-result.json (ENOENT → null)        → `{ lesson: null }`
 *   - A result file with no captured lesson           → `{ lesson: null }`
 *   - A result file carrying a lesson                 → `{ lesson: <lesson> }`
 *
 * A malformed result file still throws `ReviewerResultFileMalformedError` from
 * `readReviewerResultFile` (a real corruption a human should see), but the drain
 * wraps this seam in the swallow/non-fatal variant so even that never blocks the
 * merge — the FORWARD is best-effort and fail-soft by contract.
 */
import { readReviewerResultFile } from "../lib/read-reviewer-result-file.js";
/**
 * Return the lesson captured on a story's `reviewer-result.json`, or `null`.
 *
 * @throws {ReviewerResultFileMalformedError} When the result file exists but is
 *   malformed (propagated from `readReviewerResultFile`).
 */
export async function readReviewerLesson(opts) {
    const { targetRepoRoot, sessionUlid, ref } = opts;
    const existing = await readReviewerResultFile(targetRepoRoot, sessionUlid, ref);
    const lesson = existing?.lesson ?? null;
    return { lesson };
}
