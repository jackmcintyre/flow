/**
 * Integration tests for Story 5.16: deps-drift gate on to-do source-hash refresh.
 *
 * Covers AC2 cases (a), (b), (c):
 *   (a) drift introduced on refresh — spec edited to add a prose `Depends on:` ref
 *       that the manifest's `depends_on` omits (AND changes source_hash).
 *       Expects: to-do/ manifest NOT overwritten, blocked/ manifest written with
 *       blocked_by: "deps-drift", result.depsDriftRefs populated, result.blockedRefs
 *       populated, result.updatedRefs does NOT contain the ref.
 *   (b) no-drift-on-refresh (idempotency control) — spec body edited (changing hash)
 *       WITHOUT adding a new prose dep. Expects: to-do/ manifest rewritten with new
 *       source_hash, result.updatedRefs populated, no blocked/ manifest, depsDriftRefs
 *       empty for this ref.
 *   (c) drift-already-present-pre-refresh (symmetric drift) — prose adds a dep AND
 *       manifest already has an extra dep simultaneously. Expects: same blocked/
 *       outcome as (a) with both proseRefs and manifestRefs reflecting the symmetric
 *       difference.
 *
 * Fixture pattern mirrors hand-edit-allowance.integration.test.ts:
 * - Fresh tmpdir per test via beforeEach/afterEach.
 * - Minimal native-adapter workspace (config.yaml + native story + to-do/ manifest).
 * - scanSources() called directly on the workspace root.
 * - Assertions on the returned ScanResult AND on the post-scan filesystem state.
 */
export {};
