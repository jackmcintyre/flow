/**
 * Pre-PR full-build gate — Story 8.17.
 *
 * `runDevTerminalAction` runs the project's full build (the same whole-project
 * type-check CI runs) AFTER the commit and BEFORE `gh pr create`. A red build
 * raises `PrePrBuildFailedError` and NO pull request is opened; a green build
 * opens the PR exactly as before. This is the deterministic tool-layer seam that
 * replaces the prose-only "run the build green first" mandate — the #211 failure
 * class (a story broke an untouched sibling file, its story-scoped vitest passed
 * in isolation, and a red PR was opened).
 *
 * These tests drive the tool with a stubbed command runner (`execaImpl`) that
 * records the ordered command stream, so we can assert:
 *   AC1 — on a failing build: the build runs BEFORE any PR-create step, NO
 *         PR-create step is invoked, and a structured build-failure (the typed
 *         error carrying the build's exit code + captured output) surfaces.
 *   AC2 — on a passing build: the PR-create step is invoked exactly once with
 *         the same arguments shape it receives today.
 *   AC3 — the gate runs the project's FULL build (`pnpm build`) with its cwd set
 *         to the dev's working directory (`<targetRepoRoot>/plugins/flow`), so a
 *         future refactor cannot silently narrow it to a partial build.
 *
 * @see _bmad-output/implementation-artifacts/8-17-dev-runs-full-build-before-opening-pr.md
 */
export {};
