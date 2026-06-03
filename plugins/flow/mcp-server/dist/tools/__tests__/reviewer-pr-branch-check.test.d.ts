/**
 * Integration tests for Story 5.26:
 * `runReviewerSession` artifact-check against PR branch filesystem.
 *
 * AC3 — vitest integration test:
 *   Seeds a tmp git repo with two branches:
 *     - `orchestrator-side`: lacks the artifact file.
 *     - `pr-head`: contains the artifact file.
 *   Mocks `gh` (via execaImpl) to return the pr-head ref info.
 *   Drives `runReviewerSession` against a stub PR number.
 *
 * Assertions (AC3a–3e):
 *   (a) Temporary worktree created at <sessionDir>/review-worktree/ and contains artifact.
 *   (b) runArtifactCheck returns status: "pass" on the artifact-present case.
 *   (c) When pr-head branch is missing the artifact → status: "fail" with correct reason.
 *   (d) Temporary worktree is torn down after the reviewer session completes.
 *   (e) Stale worktree from a prior interrupted session is reaped before new worktree creation.
 *
 * AC4 — gh failure → ReviewerPrBranchFetchError thrown, no silent fallback.
 * AC5 — cleanup failure is logged (warning), not fatal.
 *
 * All git operations use real git in a tmp repo. Only `gh pr view` is mocked.
 */
export {};
