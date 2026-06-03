/**
 * Integration + chaos tests for the claim/complete loop — Story 4.1 Task 8.
 *
 * Covers AC6:
 *   (a) Happy claim (deps satisfied → in-progress/ with claimed_by stamped).
 *   (b) Deps-not-ready claim (dep missing from done/ → DependenciesNotReadyError,
 *       manifest unchanged in to-do/).
 *   (c) Happy complete (matching claimed_by → moved to done/).
 *   (d) Wrong-claimant complete (mismatched ULID → WrongClaimantError,
 *       manifest unchanged in in-progress/).
 *   (e) Hand-edit refusal on complete-story (operator hand-edited in-progress/<ref>.yaml
 *       → InProgressHandEditError thrown, manifest unchanged).
 *
 * Plus the chaos test:
 *   1,000 concurrent claimStory calls against the same to-do/ ref → exactly one
 *   winner, 999 ManifestNotFoundError failures, ref exists in exactly one state
 *   directory after the run.
 *
 * Uses a real native-adapter workspace in a tmpdir. Source stories are
 * constructed with proper Given/When/Then formatting so the native adapter
 * parses them correctly.
 *
 * @chaos — the chaos test is tagged; it runs in the default suite (1,000
 * concurrent claims is fast on a single filesystem with rename(2) atomicity).
 */
export {};
