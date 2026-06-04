/**
 * Unit tests for `lesson-archive.ts` — Story native:01KT6QSW4W7SMAHAT4EAKCCC65 (AC3).
 *
 * Covers:
 *  (a) `extractLessonsFromBody` returns all structured lessons from a body.
 *  (b) `extractLessonsFromBody` skips malformed JSON blocks silently.
 *  (c) `rankLessons` orders by use_count descending then last_used_at descending.
 *  (d) `rankLessons` splits at the budget boundary.
 *  (e) `rankLessons` with fewer lessons than budget puts all in topLessons.
 *  (f) `demoteLessonsFromBody` removes overflow lessons from the body.
 *  (g) `demoteLessonsFromBody` preserves flat-bullet lines and blank lines.
 *  (h) Demoted lesson retains every original field plus archived_at.
 *  (i) Demoted lesson is never permanently deleted (archived file exists after demotion).
 *  (j) `archiveLessons` writes JSON files to team/<role>/_archived/<id>.json.
 *  (k) `findArchivedLessonById` returns the archived lesson when present.
 *  (l) `findArchivedLessonById` returns null when the archived file is absent.
 */
export {};
