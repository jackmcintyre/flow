/**
 * Lesson ranking, budget cap, and archive helpers — Story native:01KT6QSW4W7SMAHAT4EAKCCC65.
 *
 * This module provides three concerns:
 *
 *   1. **Ranking** — `rankLessons(body, budget)` parses structured lesson
 *      blocks from a Knowledge section, orders them by `use_count` descending
 *      then `last_used_at` descending (most-recently-used as tiebreaker), and
 *      returns the top-budgeted "always-shown" set plus the overflow that
 *      should be demoted.
 *
 *   2. **Demotion** — `demoteLessonsFromBody(body, overflowIds)` removes the
 *      overflow lessons from the live Knowledge body. The caller is responsible
 *      for writing the demoted lessons to the archived store — see below.
 *
 *   3. **Archive-store write** — `archiveLessons(targetRepoRoot, role, lessons,
 *      now, deps)` writes each demoted lesson to the role's per-lesson archived
 *      store at `team/<role>/_archived/<id>.json`, adding an `archived_at`
 *      timestamp. Nothing is ever permanently deleted; the archived store is an
 *      append-only graveyard of demoted lessons.
 *
 * ## Why a separate archive store?
 *
 * The live PERSONA.md Knowledge section is the always-shown index. Archived
 * lessons are written to `team/<role>/_archived/<id>.json` rather than back
 * into PERSONA.md because:
 *  - We don't want the persona file to grow unboundedly.
 *  - Archived lessons remain retrievable by id (AC2 search path in
 *    `recallLesson`).
 *  - The `_archived/` convention mirrors the skill-archive layout already in
 *    `apply-skill-proposal.ts`.
 *
 * ## No permanent deletion
 *
 * Demoted lessons are NEVER deleted. Once a lesson is in the archived store it
 * stays there. A future story could re-promote an archived lesson back into the
 * live index, but that is out of scope for this story.
 *
 * ## Clock seam
 *
 * All callers that need the current timestamp receive an injectable `now`
 * function defaulting to `() => new Date()`. This keeps the logic
 * deterministically testable.
 *
 * (Story native:01KT6QSW4W7SMAHAT4EAKCCC65 — FR AC1, AC3)
 */
export declare const LESSON_BLOCK_PREFIX = "<!-- lesson:json ";
export declare const LESSON_BLOCK_SUFFIX = " -->";
/** Default briefing budget — the maximum number of lessons shown in a briefing. */
export declare const DEFAULT_BRIEFING_BUDGET = 10;
/**
 * A structured lesson parsed from the Knowledge section, with optional
 * usage tracking fields (`use_count`, `last_used_at`) added by this story.
 * The fields are optional so old lessons without them rank at the bottom
 * (treated as use_count=0, last_used_at=epoch).
 */
export interface ParsedLesson {
    id: string;
    kind: string;
    applies_when: string;
    detail: string;
    learned_at: string;
    /** How many times an agent recalled this lesson via `recallLesson`. */
    use_count?: number;
    /** ISO-8601 timestamp of the most recent `recallLesson` call for this lesson. */
    last_used_at?: string;
    /** Optional pitfall failure class. */
    failure_class?: string;
    /** Optional source story ref. */
    source_ref?: string;
    /** Optional source PR URL. */
    source_pr?: string;
}
/**
 * An archived lesson — same as `ParsedLesson` but with a required
 * `archived_at` timestamp added at demotion time.
 */
export interface ArchivedLesson extends ParsedLesson {
    archived_at: string;
}
/** Result of `rankLessons`. */
export interface RankedLessons {
    /** Top-budgeted lessons to keep in the always-shown index. */
    topLessons: ParsedLesson[];
    /** Lessons beyond the budget, ordered (most deserving of demotion last). */
    overflow: ParsedLesson[];
}
/**
 * Extract all structured lesson blocks from a Knowledge section body.
 * Skips malformed JSON blocks silently (mirrors `findLessonById` behaviour).
 *
 * Exported for unit testing.
 */
export declare function extractLessonsFromBody(body: string): ParsedLesson[];
/**
 * Rank the structured lessons from a Knowledge section body and apply the
 * budget cap. Returns the top-budgeted lessons (always-shown) and the
 * overflow to demote.
 *
 * When `body` has fewer lessons than `budget`, all lessons are in `topLessons`
 * and `overflow` is empty.
 *
 * Exported for unit testing.
 */
export declare function rankLessons(body: string, budget?: number): RankedLessons;
/**
 * Serialise a `ParsedLesson` (or a subset of its fields) as the `<!-- lesson:json ... -->`
 * format used in the Knowledge section.
 *
 * Only fields with defined values are included. Preserves the usage-tracking
 * fields `use_count` and `last_used_at` if present.
 *
 * Exported for unit testing (mirrors `serialiseStructuredLesson` in
 * apply-persona-append.ts, but also handles use_count/last_used_at).
 */
export declare function serialiseLessonBlock(lesson: ParsedLesson): string;
/**
 * Remove lessons with the given ids from a Knowledge section body.
 *
 * Only lesson block lines are removed; flat-bullet lines, blank lines, and
 * other text are preserved. The returned body has any trailing blank lines
 * collapsed to a single trailing newline.
 *
 * Exported for unit testing.
 */
export declare function demoteLessonsFromBody(body: string, overflowIds: Set<string>): string;
/**
 * Write each demoted lesson to the role's archived lesson store at
 * `team/<role>/_archived/<id>.json`, adding an `archived_at` timestamp.
 *
 * The file is written as a single JSON object (not JSONL). If the file already
 * exists it is overwritten — this is idempotent since the same overflow set is
 * produced on every briefing assembly until the lesson is removed from the live
 * store.
 *
 * @param targetRepoRoot - Absolute path to the target repo root.
 * @param role           - The role whose archived store to write to.
 * @param lessons        - The lessons to archive.
 * @param now            - Injectable clock seam.
 * @param role           - The role for managed-fs context.
 */
export declare function archiveLessons(targetRepoRoot: string, role: string, lessons: ParsedLesson[], now?: () => Date): Promise<string[]>;
/**
 * Rebuild the Knowledge section body from the ranked top-lessons list.
 *
 * The body is reconstructed in ranked order (most-useful lessons first):
 *  1. Ranked top-lesson blocks are written in ranked order.
 *  2. Non-lesson lines (flat bullets, blank lines, other text) from the
 *     original body are preserved and appended AFTER the ranked blocks.
 *
 * This ensures the always-shown index is ordered by use_count desc / last_used_at
 * desc as required by AC1.
 *
 * Exported for unit testing.
 */
export declare function rebuildBodyWithTopLessons(originalBody: string, topLessons: ParsedLesson[]): string;
export declare function findArchivedLessonById(targetRepoRoot: string, role: string, id: string): Promise<ArchivedLesson | null>;
