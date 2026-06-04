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
 *  3. If found, return `{ id, kind, applies_when, detail, failure_class?, source_ref?,
 *     source_pr?, learned_at }` — the full lesson body.
 *  4. If not found, return `{ id: null, detail: null }` — a soft miss (not an
 *     error, because the lesson might have been pruned or the id might be stale).
 *
 * Read-only by design: this tool never writes and never throws on a missing lesson.
 * Only absent persona files or malformed persona files throw.
 */
import type { StructuredLesson } from "../schemas/story-retro.js";
export interface RecallLessonOptions {
    /** Absolute path to the target repository root. */
    targetRepoRoot: string;
    /** The role whose Knowledge section to search. */
    role: string;
    /** ULID of the lesson to retrieve. */
    id: string;
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
 * `## Knowledge` section.
 *
 * @throws {PersonaFileNotFoundError} When `team/<role>/PERSONA.md` is absent.
 * @throws {PersonaFileMalformedError} When the persona file fails the parser.
 */
export declare function recallLesson(opts: RecallLessonOptions): Promise<RecallLessonResult>;
/**
 * Scan the `## Knowledge` section body for the structured lesson block
 * whose `id` matches the supplied value.
 *
 * Returns the parsed `RecallLessonHit` or `null` when no match is found.
 *
 * Exported for unit testing.
 */
export declare function findLessonById(knowledgeBody: string, id: string): RecallLessonHit | null;
