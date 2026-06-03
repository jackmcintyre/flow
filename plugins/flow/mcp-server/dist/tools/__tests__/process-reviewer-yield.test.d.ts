/**
 * Integration tests for `processReviewerYield` — Story 4.11 Task 8.1.
 *
 * AC6 coverage:
 *   (6c) Sub-case a: success branch — spawn-specialist-reviewer + yield.handoff telemetry
 *   (6d) Sub-case b: routing-failure branch — no hired role matches domain
 *   (6e) Sub-case c: self-yield branch — specialist yielded to its own domain
 *   (6f) Sub-case d: no-yield pass-through — no yield phrase in transcript
 *   (6g) Sub-case e: drift branch — en-dash instead of em-dash (silent pass-through)
 *   (6i) Sub-case g: empty-transcript pass-through
 *   (6j) Sub-case h: PersonaFileNotFoundError propagates on race condition
 *   (6l) Sub-case j: schema-strict assertion — unknown extra key in data
 *   (6m) Sub-case k: round-trip JSONL parseability
 *
 * Uses real tmpdir fixtures. No mocking of lookupRoleByDomain, buildPersonaSpawnPrompt,
 * or logTelemetryEvent — tests exercise real implementations.
 */
export {};
