/**
 * Unit tests for `listClaimableTodos` — Story 4.2 Task 7.2.
 *
 * Covers:
 *   (a) empty `to-do/` returns `{ todos: [], inProgressCount: 0 }`.
 *   (b) three claimable refs return them alphabetically.
 *   (c) a withdrawn ref is filtered out.
 *   (d) a ref with one unmet dep returns `depsReady: false`.
 *   (e) a ref with all deps in `done/` returns `depsReady: true`.
 *   (f) malformed manifest propagates `MalformedExecutionManifestError`.
 *   (g) `inProgressCount` reflects directory contents.
 *
 * Approach: real filesystem ops against a tmpdir. No node:fs mocking.
 */
export {};
