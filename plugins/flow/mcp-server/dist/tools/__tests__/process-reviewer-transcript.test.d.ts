/**
 * Unit tests for `processReviewerTranscript` — Story 4.6 Task 9.7 (revision 2).
 *
 * **Revision 2:** The suite is rewritten to cover the file-based verdict
 * transport. All tests that scanned the reviewer's chat for `**Verdict:**`
 * have been removed.
 *
 * Covers (per spec §4l, §4m):
 *   (a) reviewer-result.json present with READY FOR MERGE → done-ready-for-merge,
 *       completed: true, manifest moved to done/.
 *   (b) reviewer-result.json present with NEEDS CHANGES → done-blocked-reviewer-needs-changes,
 *       blocked_by: "reviewer-verdict-needs-changes".
 *   (c) reviewer-result.json present with BLOCKED → done-blocked-reviewer-blocked,
 *       blocked_by: "reviewer-verdict-blocked".
 *   (d) reviewer-result.json absent → done-blocked-no-session-result,
 *       blocked_by: "reviewer-no-session-result".
 *   (e) reviewer-result.json present but malformed JSON → ReviewerResultFileMalformedError thrown.
 *   (f) reviewer-result.json present but invalid shape (bad recommendedVerdict) →
 *       ReviewerResultFileMalformedError thrown.
 *
 * Story 4.6 Task 8b; Story 4.3b Task 9.1–9.2; Story 4.3c Task 5.1–5.5.
 */
export {};
