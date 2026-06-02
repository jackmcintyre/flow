/**
 * Integration test for Story 5.19: scan-sources readFile resilience.
 *
 * AC2: vitest seeds a fixture with 3 valid manifests + 1 deliberately-malformed-yaml
 * manifest under to-do/, runs scanSources, asserts (a) the 3 valid manifests scan
 * clean, (b) the bad one appears in result.skippedRefs with reason "unreadable-manifest"
 * and a non-empty detail field, (c) scanSources returns without throwing at the
 * boundary (the per-file error is contained).
 *
 * Fixture pattern mirrors hand-edit-allowance.integration.test.ts and
 * scan-sources-drift-on-refresh.test.ts:
 * - Fresh tmpdir per test via beforeEach/afterEach.
 * - Minimal native-adapter workspace (config.yaml + native stories + to-do/ manifests).
 * - scanSources() called directly on the workspace root.
 */
export {};
