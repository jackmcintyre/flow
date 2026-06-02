/**
 * Slugify a standards criterion name into a stable lowercase identifier.
 *
 * Rule (Story 4.6 AC3 / Task 3.1):
 *   1. Lowercase the entire string.
 *   2. Replace any sequence of non-alphanumeric characters with a single `-`.
 *   3. Trim leading and trailing dashes.
 *
 * Examples:
 *   "story-aligned"                        → "story-aligned"
 *   "No Canonical FS Writes Outside MCP"   → "no-canonical-fs-writes-outside-mcp"
 *   "  leading/trailing spaces!  "         → "leading-trailing-spaces"
 *
 * Pure function — no I/O, no deps. Used by `runReviewerSession` to key
 * `standardsByCriterionId`.
 */
export declare function slugifyStandardsCriterion(name: string): string;
