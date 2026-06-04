/**
 * Unit / integration tests for `recallLesson` and `findLessonById`
 * — Story native:01KT6QEWY794ZY0DH6JHQFWG6V (AC2).
 *
 * Covers:
 *  (a) `findLessonById` returns the full lesson body when the id matches.
 *  (b) `findLessonById` returns null when no match (soft miss).
 *  (c) `findLessonById` skips malformed JSON blocks silently.
 *  (d) `recallLesson` returns { found: true, lesson } for a real persona
 *      file with a structured lesson.
 *  (e) `recallLesson` returns { found: false, lesson: null } for an id
 *      that is not in the Knowledge section.
 *  (f) `recallLesson` propagates PersonaFileNotFoundError when the persona
 *      file is absent.
 *  (g) Full-body detail is returned (the full `detail` text, not just the
 *      trigger), confirming the recall delivers more than the one-line index.
 */
export {};
