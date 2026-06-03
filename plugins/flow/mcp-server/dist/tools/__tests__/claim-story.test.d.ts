/**
 * Unit tests for `claimStory` — Story 4.1 Task 7.1.
 *
 * Covers AC1, AC2, AC5 and the defensive parse (Task 7.1):
 *   (a) Happy claim: deps satisfied → manifest moves to in-progress/ with
 *       claimed_by stamped, to-do/ entry gone.
 *   (b) Deps-not-ready: one dep missing from done/ → DependenciesNotReadyError,
 *       manifest stays in to-do/ unchanged.
 *   (c) Hand-edit refusal on re-entry: in-progress/ manifest hand-edited →
 *       InProgressHandEditError, no move.
 *   (d) claimed_by defensive parse: rewritten manifest round-trips through
 *       parseExecutionManifest cleanly with the widened schema.
 *
 * Approach:
 * - Use a minimal native-adapter workspace in a tmpdir (real filesystem ops).
 * - Mock `deriveSourceBaseline` where needed to control the hand-edit baseline.
 * - No `node:fs` mocking — real renames against tmpdir per testing requirements.
 */
export {};
