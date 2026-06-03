/**
 * `recordReviewerLesson` MCP/CLI tool — Story native:01KT6GSV8KTTKKHPRGEJWJAGZV
 * (learning-loop producer — CAPTURE half).
 *
 * The reviewer surfaces at most ONE reusable retro lesson per story. When it
 * does, it calls this tool exactly once — AFTER its mandatory `runReviewerSession`
 * call — to MERGE that lesson onto the EXISTING per-ref `reviewer-result.json`
 * that `runReviewerSession` already wrote. The drain's FORWARD half later reads
 * the captured lesson off that file and attaches it to the done manifest via
 * `recordStoryRetro`, before the merge gate runs.
 *
 * **Why a named tool, not free prose?** The only previous "record a lesson"
 * instruction was prose to an agent, and prose mandates do not hold under load
 * (the keystone observation behind this story). The lesson SOURCE is the
 * reviewer's judgment (a deliberate product decision), but the WRITE is a
 * deterministic tool seam — exactly as `runReviewerSession` owns the verdict
 * file. The reviewer never hand-edits a `.flow/state` file; this tool owns this
 * one write.
 *
 * Behaviour:
 *   1. Validate `lesson` via `LessonSchema` (the existing canonical schema —
 *      no new lesson shape). Throws `MalformedStoryRetroPayloadError` on failure.
 *   2. Read the EXISTING per-ref `reviewer-result.json` via
 *      `readReviewerResultFile`. If absent (ENOENT → null), throw
 *      `ReviewerResultFileMissingError` — there is no verdict file to merge onto,
 *      which means `runReviewerSession` never ran (a caller-order bug).
 *   3. MERGE only the `lesson` field onto the existing projection — never
 *      clobbering `recommendedVerdict`, `acResults`, or any other field.
 *   4. Write it back to the SAME per-ref path (the derivation every
 *      reader/writer shares), via `atomicWriteFile`.
 *
 * **Fail-soft at the orchestration layer:** this tool itself fails loud on a
 * malformed lesson or a missing verdict file (a real caller bug), but the drain
 * invites the reviewer to call it only OPTIONALLY and contains any failure so it
 * never blocks review / build / merge.
 *
 * **Idempotent:** merging the same lesson twice writes a byte-identical
 * projection (the merge is a deterministic shallow overwrite; `JSON.stringify`
 * with a fixed indent is stable).
 */
export interface RecordReviewerLessonOptions {
    /** Absolute path to the target repository root. */
    targetRepoRoot: string;
    /** ULID of the calling (drain) session — the session the verdict file lives under. */
    sessionUlid: string;
    /** Story ref (e.g. `"native:01HZ..."`), used to derive the per-ref result path. */
    ref: string;
    /** The single reusable lesson — validated inside via `LessonSchema`. */
    lesson: unknown;
}
export interface RecordReviewerLessonResult {
    ok: true;
    ref: string;
    absPath: string;
}
/**
 * Merge one reviewer-surfaced lesson onto the existing per-ref
 * `reviewer-result.json`.
 *
 * @returns `{ ok: true, ref, absPath }` — the ref and absolute path of the
 *   merged-into reviewer-result file.
 *
 * @throws {MalformedStoryRetroPayloadError} When `lesson` fails `LessonSchema`
 *   validation (closed-enum violation, missing `failure_class` on a `pitfall`,
 *   unknown key, etc.).
 * @throws {ReviewerResultFileMissingError} When the per-ref `reviewer-result.json`
 *   does not exist (runReviewerSession never ran for this ref/session).
 * @throws {ReviewerResultFileMalformedError} When the existing file is malformed.
 */
export declare function recordReviewerLesson(opts: RecordReviewerLessonOptions): Promise<RecordReviewerLessonResult>;
