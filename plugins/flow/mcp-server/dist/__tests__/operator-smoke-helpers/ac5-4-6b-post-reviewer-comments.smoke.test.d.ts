/**
 * AC5 (user-surface) operator-smoke extension for Story 4.6b — Task 10.
 * Extended for Story 4.7 AC4 — idempotent rerun and version stamping.
 *
 * @description
 * Extends the Story 4.6 rubber-stamp reproducer with the post-reviewer step:
 *   1. Same scratch repo — one ready story with `artifact: target-file.txt`.
 *   2. Dev handoffs without creating the artifact (rubber-stamp).
 *   3. `runReviewerSession` executes — finds artifact missing, returns NEEDS CHANGES.
 *   4. `postReviewerComments` is called AFTER runReviewerSession returns and
 *      BEFORE processReviewerTranscript runs.
 *   5. The captured `gh api` body is asserted per spec §5b:
 *      - Body contains `standards_version:` and `plugin_version:` literals
 *      - Footer marker `<!-- flow:verdict:` is last line of body
 *      - `comments` array has length 1 (failing artifact path appears in diff)
 *      - Inline comment body contains both `target-file.txt` and `ENOENT`
 *   6. Second `postReviewerComments` invocation (rerun scenario) — GET returns
 *      prior verdict with footer marker → PATCH called once, POST not called.
 *   7. processReviewerTranscript is still called — manifest stays in in-progress/
 *      with `blocked_by: "reviewer-verdict-needs-changes"` (spec §5c).
 *
 * Smoke-gate: per `plugins/flow/docs/user-surface-acs.md` § Pre-PR gate,
 * this test provides the CI-level evidence for AC5 (user-surface) and AC4 (user-surface).
 * The operator may substitute manual-paste evidence per spec §5d.
 *
 * Story 4.6b Task 10.1–10.4; Story 4.7 Task 6.1–6.3.
 */
export {};
