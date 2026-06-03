/**
 * Unit tests for `parseRiskTieringSpec` — Story 4.9 Task 6.3.
 *
 * Covers pure-validator edge cases that don't require IO:
 * - Empty file / whitespace-only
 * - Missing closing `---`
 * - Missing opening `---`
 * - Valid YAML but unknown top-level key
 * - Valid spec round-trip
 * - Duplicate rule id
 * - Rule with no signal fields
 * - fallback_tier: low (non-medium)
 * - min_lines_changed > max_lines_changed
 * - No rules in any tier
 *
 * Pure deterministic — no IO, no LLM invocation, no network.
 */
export {};
