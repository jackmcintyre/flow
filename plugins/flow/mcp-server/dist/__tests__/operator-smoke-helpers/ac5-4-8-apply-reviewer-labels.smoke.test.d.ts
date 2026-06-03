/**
 * AC5 (user-surface) operator-smoke extension for Story 4.8 — Task 7.
 *
 * @description
 * Extends the Story 4.6b / 4.7 operator-smoke harness with the
 * `applyReviewerLabels` step after `processReviewerTranscript`:
 *   1. Same scratch repo — one ready story with `artifact: target-file.txt`.
 *   2. Dev handoffs without creating the artifact (rubber-stamp).
 *   3. `runReviewerSession` executes — finds artifact missing, returns NEEDS CHANGES.
 *   4. `postReviewerComments` is called AFTER runReviewerSession returns.
 *   5. `processReviewerTranscript` is called — manifest stays in in-progress/
 *      with `blocked_by: reviewer-verdict-needs-changes`.
 *   6. `applyReviewerLabels` is called — asserts two sequential `gh api POST /labels`
 *      calls: first for `reviewed-by-agent`, second for `needs-human`.
 *   7. Return value is `{ next: "applied", labelsApplied: ["reviewed-by-agent", "needs-human"] }`.
 *   8. Story 4.6b / 4.7 invariants still hold per AC5 (5c): manifest stays in in-progress/.
 *
 * AC5 smoke-gate: per `plugins/flow/docs/user-surface-acs.md` § Pre-PR gate,
 * this test provides CI-level evidence for AC5 (user-surface) of Story 4.8.
 *
 * Story 4.8 Task 7.1–7.4.
 */
export {};
