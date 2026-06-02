/**
 * Integration tests for `runReviewerSession` composite tool — Story 4.6 Task 9.
 *
 * Behavioural contract source:
 *   _bmad-output/implementation-artifacts/4-6-reviewer-subagent-read-sources-and-run-acs.md
 *
 * Fixture shape (spec §4a):
 *   <tmp>/.flow/config.yaml           — native adapter
 *   <tmp>/.flow/native-stories/<ULID>.md — spec with 3 ACs
 *     AC1: artifact: hello-a.txt
 *     AC2: vitest: fixture passing test
 *     AC3: no marker (manual-check-required)
 *   <tmp>/.flow/state/in-progress/<ref>.yaml — pre-claimed manifest
 *   <tmp>/docs/standards.md           — 4 criteria (matches standards-example.md)
 *   <tmp>/hello-a.txt                 — the artifact AC1 expects
 *   <tmp>/__tests__/fixture.test.ts   — a vitest test named "fixture passing test"
 *
 * Stubs:
 *   - `execaImpl` injected to avoid real `gh pr diff` network calls.
 *   - `__resetGhErrorMapCacheForTests` called in beforeEach.
 *
 * Story 4.6 Task 9.1–9.5.
 */
export {};
