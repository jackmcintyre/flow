/**
 * `recallLesson` tool — Story native:01KT6QEWY794ZY0DH6JHQFWG6V
 * (Swap agent briefings from full lesson text to a one-line index with on-demand recall).
 *
 * The companion to the one-line index in `buildPersonaSpawnPrompt`. When an agent
 * receives a briefing with the compact knowledge index it can call this tool with
 * a lesson `id` to retrieve the full `detail` body of that single lesson.
 *
 * Behaviour:
 *  1. Read the persona file at `<targetRepoRoot>/team/<role>/PERSONA.md`.
 *     Throws `PersonaFileNotFoundError` when absent (propagated from `readPersona`).
 *  2. Scan the `## Knowledge` section body for a structured lesson block whose
 *     `id` field matches the supplied `id`.
 *  3. If found in the live store, increment `use_count` and stamp `last_used_at`,
 *     write the updated lesson block back to the persona file, and return the full
 *     lesson body.
 *  4. If NOT found in the live store, search the archived lesson store at
 *     `team/<role>/_archived/<id>.json`. If found there, return the full lesson
 *     body (archived lessons are retrievable but their use_count is also updated
 *     in the archive file).
 *  5. If not found in either store, return `{ id: null, detail: null }` — a soft
 *     miss (not an error, because the lesson might have been permanently removed or
 *     the id might be stale).
 *
 * Updating usage tracking: this tool performs a write-back when it returns a lesson.
 * The write-back is best-effort: if the write fails the lesson is still returned
 * (we never block a recall on a telemetry write failure).
 *
 * Story native:01KT6QSW4W7SMAHAT4EAKCCC65 additions:
 *  - Archived store fallback (step 4 above).
 *  - use_count / last_used_at write-back on hit.
 */
import { type ParsedLesson } from "../lib/lesson-archive.js";
import type { StructuredLesson } from "../schemas/story-retro.js";
export interface RecallLessonOptions {
    /** Absolute path to the target repository root. */
    targetRepoRoot: string;
    /** The role whose Knowledge section to search. */
    role: string;
    /** ULID of the lesson to retrieve. */
    id: string;
    /** Injectable clock seam (default: real Date). */
    now?: () => Date;
}
export interface RecallLessonHit {
    id: string;
    kind: StructuredLesson["kind"];
    applies_when: string;
    detail: string;
    failure_class?: string;
    source_ref?: string;
    source_pr?: string;
    learned_at: string;
    /** Whether the lesson was retrieved from the archived store. */
    archived?: true;
}
export type RecallLessonResult = {
    found: true;
    lesson: RecallLessonHit;
} | {
    found: false;
    lesson: null;
};
/**
 * Retrieve the full body of one structured lesson by id from a role's
 * `## Knowledge` section, falling back to the archived store when not found
 * in the live persona file.
 *
 * When a lesson is found, `use_count` is incremented and `last_used_at` is
 * stamped. The write-back is best-effort; a failed write does not prevent the
 * lesson from being returned.
 *
 * @throws {PersonaFileNotFoundError} When `team/<role>/PERSONA.md` is absent.
 * @throws {PersonaFileMalformedError} When the persona file fails the parser.
 */
export declare function recallLesson(opts: RecallLessonOptions): Promise<RecallLessonResult>;
/**
 * Scan the `## Knowledge` section body for the structured lesson block
 * whose `id` matches the supplied value.
 *
 * Returns the parsed `ParsedLesson` (which includes use_count/last_used_at)
 * or `null` when no match is found.
 *
 * Exported for unit testing.
 */
export declare function findLessonById(knowledgeBody: string, id: string): ParsedLesson | null;
/**
 * Replace the lesson block for a given lesson id in the Knowledge section body
 * with an updated block (reflecting new use_count / last_used_at).
 *
 * If the lesson id is not found, the body is returned unchanged.
 *
 * Exported for unit testing.
 */
export declare function updateLessonInBody(body: string, updatedLesson: ParsedLesson): string;
