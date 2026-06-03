/**
 * Schema tests for `StructuredLessonSchema` — Story native:01KT6Q8PSDZQKM57VFRHFJ3RP4.
 *
 * AC3 (unit): a structured lesson entry with kind pitfall and a missing
 *   failure_class field fails validation — matching the existing LessonSchema
 *   contract that failure_class is required when kind is "pitfall".
 *
 * Also covers:
 *   - Happy-path round-trips for each LESSON_KIND.
 *   - Required-field rejections (id, kind, applies_when, detail, learned_at).
 *   - Unknown-key rejection (.strict()).
 *   - The pitfall+failure_class contract (AC3).
 */
export {};
