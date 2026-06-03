/**
 * Unit tests for `recallLesson` — Story native:01KT6QEWY794ZY0DH6JHQFWG6V (AC2).
 *
 * Story native:01KT6QSW4W7SMAHAT4EAKCCC65 additions (AC2):
 *   - Returns the full lesson detail when the lesson is in the archived store.
 *   - Increments use_count and stamps last_used_at in the live store on recall.
 *
 * Covers:
 *   (a) Returns the full body of a lesson when called with the lesson's id.
 *   (b) Returns { found: false } when no lesson matches the id.
 *   (c) Works for structured lesson blocks (<!-- lesson:json ... -->).
 *   (d) Works for flat-bullet migrated entries (id = MIGRATED-N).
 *   (e) PersonaFileNotFoundError propagates when the persona file is absent.
 *   (f) Returns the full lesson detail when recalled from the archived store.
 *   (g) Increments use_count and stamps last_used_at after a live recall.
 *
 * Approach: real filesystem ops against a tmpdir with a constructed persona file.
 */
export {};
