/**
 * Unit tests for `extractDepRefsFromSpecBody` — Story 5.13 AC4 + Test Plan.
 *
 * Covers all six edge cases from the spec:
 *   1. Empty body → empty set
 *   2. Single `Depends on: native:<ULID>` line → one element
 *   3. `> Depends on Story 5.10` blockquote → `bmad:5.10`
 *   4. Multiple lines, mixed patterns, deduplicated
 *   5. Malformed refs silently dropped
 *   6. Case sensitivity preserved (`depends on:` lowercase is NOT matched)
 */
export {};
