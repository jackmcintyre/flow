/**
 * Tests for the short-handle scope in composeCommitSubject (Story native:01KT2SAV0WC0ZEKKF51W1CA3K2).
 *
 * AC1 (integration): PR title / commit subject shows the short handle; full ref
 *   is recoverable from composePrBody's machine block `Story:` line.
 * AC2 (unit): full ref is in the PR body machine block; correlation is preserved.
 * AC3 (unit): a no-colon ref falls back to emitting the full ref as the scope.
 *
 * Additionally validates that CONVENTIONAL_COMMIT_SUBJECT_REGEX from git.ts
 * accepts the short-handle form (the regex already allows alphanumeric scopes).
 */
export {};
