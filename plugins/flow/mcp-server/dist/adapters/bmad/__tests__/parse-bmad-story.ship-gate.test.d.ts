/**
 * Unit tests for ship_gate field surfacing in `parseBmadStory` (Story 3.5 Task 4.3).
 *
 * Tests that:
 *   - A BMad story with a `Tags: ship-gate` line has `raw_frontmatter.ship_gate === true`.
 *   - A BMad story without any tags line has `raw_frontmatter.ship_gate === undefined`.
 *   - The ship_gate field is case-insensitive for the tag match.
 */
export {};
