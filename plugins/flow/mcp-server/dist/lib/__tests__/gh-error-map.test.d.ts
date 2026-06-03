/**
 * Unit tests for `lib/gh-error-map.ts`.
 *
 * Covers:
 *   (a) Parser happy path — shipped v1 rows (AC1f)
 *   (b) Each malformed case from AC3h:
 *       - unknown top-level key (AC1e)
 *       - unknown per-entry key (AC1e)
 *       - `class` not in the literal set (AC1b)
 *       - `stderr_regex` that fails to compile (AC1c)
 *       - `exit_code` missing (AC1b)
 *   (c) `classifyGhError` returns first match in order (AC3f / AC1d)
 *   (d) `classifyGhError` matches on exit_code alone when no regex (AC3g)
 *   (e) `classifyGhError` returns `null` on unmapped result (AC3e)
 *   (f) Cache memoisation — two calls → one parse (AC1h)
 *   (g) `__resetGhErrorMapCacheForTests` resets (AC1h / AC3i)
 *   (h) Spot-check: shipped `gh-error-map.yaml` parses cleanly (Task 2.2)
 *
 * Story 4.5 Task 1.4
 */
export {};
