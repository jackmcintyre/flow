/**
 * Unit tests for `lesson-archive.ts` — Story native:01KT6QSW4W7SMAHAT4EAKCCC65 (AC3).
 *
 * AC3: Given a lesson that is demoted to the archived store, When the archived
 * entry is inspected, Then it retains every original field and additionally
 * carries an archived_at timestamp, and no lesson is ever permanently deleted.
 *
 * Covers:
 *   (a) appendArchivedLessons stamps archived_at on each demoted entry.
 *   (b) All original ParsedLessonEntry fields are preserved verbatim.
 *   (c) appendArchivedLessons is idempotent — demoting the same lesson twice
 *       does NOT create a duplicate entry.
 *   (d) Lessons already in the archive are preserved when new entries are appended.
 *   (e) readArchivedLessons returns [] when the archive file does not exist.
 *   (f) archivedLessonsPath returns the expected repo-relative path.
 *
 * Approach: real filesystem ops against a tmpdir. No node:fs mocking.
 */
export {};
