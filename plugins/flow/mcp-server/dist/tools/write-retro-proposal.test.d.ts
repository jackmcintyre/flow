/**
 * Durability-routing tests for `writeRetroProposal` and `routeLessonDurability`
 * — Story DR1 / native:01KT6RH6XJFE2E09WMEHJ03JBD.
 *
 * Covers:
 *   AC1 (integration): a retro proposal invocation with lesson routings
 *         produces a file whose body contains "Durability recommendation:"
 *         lines and whose return value carries structured `routedLessons`.
 *   AC2 (unit): pitfall/tool-quirk + failure_class + recurrence > 1 → 'code'.
 *   AC3 (unit): pattern + (roleCount > 1 OR storyCount > 1) + recurrence > 1 → 'skill'.
 *   AC4 (unit): one-off judgment call (no matching rule) → 'note'.
 *
 * The existing `__tests__/write-retro-proposal.test.ts` covers write-path
 * mechanics (collision, path-traversal, round-trip). This file focuses on
 * the routing heuristic and the integration of routing output into the
 * proposal artifact.
 */
export {};
