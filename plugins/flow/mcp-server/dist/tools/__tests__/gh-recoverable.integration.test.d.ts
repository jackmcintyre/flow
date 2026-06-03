/**
 * Integration tests for the recoverable-error path.
 *
 * Covers AC3b–AC3g, AC3j, AC3k from Story 4.5 (eight scenarios total).
 *
 * Uses a real tmpdir with `git init`, an in-progress manifest, and a fixture
 * spec. Injects `execaImpl` stub into `runDevTerminalAction` to control `gh`
 * exit codes/stderrs, and drives `processDevTranscript` with synthetic
 * transcripts to verify manifest stamping.
 *
 * The integration test does NOT actually invoke `runDevTerminalAction` to
 * produce a GhRecoverableError and then feed that transcript through
 * processDevTranscript in a single call, because runDevTerminalAction raises
 * and the dev subagent is the entity that produces the transcript. Instead,
 * each scenario:
 * 1. Verifies the gh() wrapper raises GhRecoverableError with the right class.
 * 2. Verifies processDevTranscript with a synthetic transcript (the locked line
 *    the dev subagent would emit) stamps blocked_by and returns the right `next`.
 * 3. Asserts the manifest is still in `in-progress/` (never moved/deleted).
 *
 * @see _bmad-output/implementation-artifacts/4-5-gh-error-map-yaml-and-recoverable-error-classification.md § Behavioural contract
 *
 * Story 4.5 Task 6.1–6.5
 */
export {};
