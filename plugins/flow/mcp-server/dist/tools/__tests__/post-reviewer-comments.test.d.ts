/**
 * Integration tests for `postReviewerComments` — Story 4.6b Task 8 (AC4);
 * extended Story 4.7 Task 5 (AC3 two-run, PATCH path, idempotent rerun).
 *
 * Fixture: tmpdir with `.flow/config.yaml` and optional
 * `.flow/state/sessions/<sessionUlid>/reviewer-result.json`.
 *
 * The `gh` stub routes by cmd / args[0..1] per the pattern established in
 * `run-reviewer-session.test.ts` (Story 4.6 Issue 2). The shared helper
 * `gh-execa-stub.ts` provides the routing logic.
 *
 * Story 4.6b Task 8.1–8.5; Story 4.7 Task 5.0–5.2.
 */
export {};
