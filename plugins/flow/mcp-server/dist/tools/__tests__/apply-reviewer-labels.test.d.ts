/**
 * Integration tests for `applyReviewerLabels` — Story 4.8 (AC4).
 *
 * Covers:
 *   (4a) AC1 label branch: READY FOR MERGE → exactly one `gh api POST /labels` call with
 *        `{"labels":["reviewed-by-agent"]}`; no `needs-human` call.
 *   (4b) AC2 label branches: NEEDS CHANGES, BLOCKED, and verdictOverride: "reviewer-failure"
 *        each → exactly two `gh api POST /labels` calls in sequence.
 *   (4c) AC3 denial branches: gh({ subcommand: "pr-close" | "pr-merge" | "pr-review" | "pr-comment" })
 *        → GhSubcommandDeniedError before any execa call.
 *   (4d) Error propagation: GhRecoverableError on first label call propagates; second call NOT made.
 *   (4e) Missing-file path: no reviewer-result.json → returns { next: "skipped-no-session-result" }.
 *
 * Story 4.8 Task 6.
 */
export {};
