/**
 * Lesson archiving helpers for the role Knowledge store — Story native:01KT6QSW4W7SMAHAT4EAKCCC65.
 *
 * When a role's live lesson index grows beyond the briefing budget, overflow
 * lessons are demoted to the role's archived lesson store rather than deleted.
 * Archived lessons remain retrievable by id via `recallLesson` but are no
 * longer included in the agent's always-shown briefing index.
 *
 * ## Storage layout
 *
 * Live lessons:    stored as `<!-- lesson:json ... -->` blocks in the role's
 *                  `team/<role>/PERSONA.md` Knowledge section.
 *
 * Archived lessons: `team/<role>/_archived/lessons.json` — a JSON array of
 *                   `ArchivedLesson` objects. Each carries all original lesson
 *                   fields plus an `archived_at` ISO-8601 timestamp. No lesson
 *                   is ever deleted.
 *
 * ## Idempotency
 *
 * `appendArchivedLessons` reads the existing archive, merges by id (no
 * duplicates), and rewrites atomically. Demoting the same lesson twice is safe.
 *
 * ## Clock seam
 *
 * The `now` parameter defaults to `() => new Date()` so callers do not need
 * to pass it. Tests inject a fixed clock for deterministic assertions.
 *
 * (Story native:01KT6QSW4W7SMAHAT4EAKCCC65 — AC3, lesson-archive.test.ts)
 */
import type { ParsedLessonEntry } from "./parse-knowledge-section.js";
/**
 * An archived lesson entry. Carries every field from `ParsedLessonEntry` plus
 * the `archived_at` timestamp added at demotion time. No field is removed.
 *
 * The only REQUIRED extra field is `archived_at` — the rest are preserved
 * verbatim from the live entry.
 */
export interface ArchivedLesson extends ParsedLessonEntry {
    /** ISO-8601 UTC timestamp stamped at demotion time. */
    archived_at: string;
}
/**
 * Absolute path to the archived lessons file for a role.
 * Convention: `<targetRepoRoot>/team/<role>/_archived/lessons.json`
 */
export declare function archivedLessonsPath(targetRepoRoot: string, role: string): string;
/**
 * Read the archived lessons for a role. Returns an empty array when the
 * archive file does not exist (ENOENT → `[]`). Propagates other IO errors.
 *
 * Parses the JSON as an array, returning `[]` on any shape mismatch (graceful
 * corruption recovery).
 */
export declare function readArchivedLessons(targetRepoRoot: string, role: string): Promise<ArchivedLesson[]>;
/**
 * Append demoted lessons to the archived lesson store for a role, stamping
 * each with `archived_at = now()`. Existing entries are preserved — demotion
 * is idempotent (merges by id, never doubles an entry).
 *
 * Returns the final array written to disk (the merged archive).
 *
 * @param targetRepoRoot  - Absolute path to the repo root.
 * @param role            - Role id (e.g. `"generalist-dev"`).
 * @param lessons         - Lessons to demote. Must include all original fields.
 * @param now             - Injectable clock; defaults to `() => new Date()`.
 */
export declare function appendArchivedLessons(targetRepoRoot: string, role: string, lessons: ParsedLessonEntry[], now?: () => Date): Promise<ArchivedLesson[]>;
