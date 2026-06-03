/**
 * Story 5.21: Reviewer first-tool-call deterministic seam.
 *
 * Seam choice: post-spawn fail-loud guard (approach b) — when the reviewer
 * subagent's session produces no `reviewer-result.json` (i.e. it skipped the
 * mandatory `runReviewerSession` first call), `processReviewerTranscript`
 * stamps the manifest and throws `ReviewerFirstCallSkippedError`.
 *
 * This is a stronger structural guarantee than the previous soft
 * `done-blocked-no-session-result` return variant, which the inner cycle
 * could silently continue past. A thrown `DomainError` propagates through
 * `register.ts`'s `isError: true` path and the SKILL.md step-10 error
 * handler MUST surface and halt rather than loop.
 *
 * **AC3 (vitest, integration):** Seed a reviewer-spawn fixture where the
 * simulated subagent's `agent_invokes` record is empty (i.e. the persona
 * skipped the mandated call — modelled by the absence of reviewer-result.json).
 * Assert the orchestration fails-loud with `ReviewerFirstCallSkippedError`
 * that names the missing call. Assert the manifest does NOT progress to a
 * verdict without `runReviewerSession` having been invoked.
 *
 * **AC4 (vitest, regression):** Seed a reviewer-spawn fixture where the
 * simulated subagent called `runReviewerSession` as its first action (the
 * happy path — modelled by a valid reviewer-result.json being present).
 * Assert no double-call, no fail-loud, no behavioural drift from the
 * passing reviewer cycle.
 *
 * `vitest: plugins/flow/mcp-server/src/tools/__tests__/reviewer-first-call-seam.test.ts`
 */
export {};
