/**
 * Tests for `computeFailureClassFireCounts` — Story 6.6 AC1–AC3.
 *
 * AC1: A pure helper reads done manifests and telemetry, returns per-class
 *      fire counts. Same inputs → same output (deterministic). Handles zero-
 *      fire classes and classes with no registered rule.
 *
 * AC2: Classes crossing the promotion threshold AND with no registered rule
 *      are flagged as promotion candidates; a class with a rule is NOT flagged.
 *
 * AC3: Registered rules whose class is silent (zero fires) are flagged as
 *      `retire` candidates; non-zero-but-below-floor → `relax`; rules above
 *      the floor are NOT flagged. Each candidate carries target_rule_id,
 *      fire_count_over_window, and recommended_action.
 */
export {};
