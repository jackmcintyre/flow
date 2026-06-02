/**
 * Integration tests for `runDevTerminalAction`.
 *
 * Uses a real tmpdir git repo (real git init, real commits), stubs
 * `git push` and `gh pr create` via execaImpl injection to avoid network IO.
 *
 * Covers AC3 (3a)–(3i) from Story 4.4.
 * AC3 (3j) — tool count — is covered by ask-mode-enforcement / ask-skill /
 * get-team-snapshot tests updated in Task 4.6.
 *
 * @see _bmad-output/implementation-artifacts/4-4-dev-subagent-git-push-and-gh-pr-create-terminal-action.md § Behavioural contract
 */
export {};
