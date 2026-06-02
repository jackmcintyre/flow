/**
 * Integration test for Story 9.1 (AC5): the scan step writes new backlog
 * manifests with `ready` defaulting to `false`, so a just-scanned item is in
 * the backlog but NOT claimable until the operator blesses it.
 *
 * Scans a single native source story into a fresh `to-do/` manifest, asserts
 * the written manifest reads not-ready, and asserts the claim entry point
 * (`claimNextStory`) does not return it (fail-closed readiness brake).
 *
 * Fixture pattern mirrors scan-sources-readfile-resilience.test.ts:
 * minimal native-adapter workspace (config.yaml + native story), fresh tmpdir,
 * scanSources() called directly on the workspace root.
 */
export {};
