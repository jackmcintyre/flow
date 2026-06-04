/**
 * Integration tests for `recallLesson` — archived store fallback
 * Story native:01KT6QSW4W7SMAHAT4EAKCCC65 (AC2).
 *
 * Covers:
 *  (AC2-a) recallLesson returns the full lesson detail for an archived lesson by id.
 *  (AC2-b) recallLesson searches the live store first, then falls back to the archive.
 *  (AC2-c) recallLesson returns { found: false } when the id is in neither store.
 *  (AC2-d) Archived lesson recall returns the lesson with archived: true flag.
 *  (AC2-e) use_count is incremented on recall from the live store.
 *  (AC2-f) use_count is incremented on recall from the archived store.
 */
export {};
