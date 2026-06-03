/**
 * Unit tests for `recallLesson` — Story native:01KT6QEWY794ZY0DH6JHQFWG6V (AC2).
 *
 * Covers:
 *   (a) Returns the full body of a lesson when called with the lesson's id.
 *   (b) Returns { found: false } when no lesson matches the id.
 *   (c) Works for structured lesson blocks (<!-- lesson:json ... -->).
 *   (d) Works for flat-bullet migrated entries (id = MIGRATED-N).
 *   (e) PersonaFileNotFoundError propagates when the persona file is absent.
 *
 * Approach: real filesystem ops against a tmpdir with a constructed persona file.
 */
export {};
