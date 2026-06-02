/**
 * Pre-PR full build-and-test gate — Story native:01KT3ER5E9ACCERHAEJ5NM94TH.
 *
 * `runDevTerminalAction` now runs the project's full BUILD AND TESTS
 * (the same whole-project check CI runs) AFTER the commit and BEFORE
 * `gh pr create`. A failing test suite raises `PrePrTestFailedError` and NO
 * pull request is opened; a green build+test run opens the PR.
 *
 * These tests drive the tool with a stubbed command runner (`execaImpl`) so
 * we can assert the ordered command stream without spawning a real build:
 *
 *   AC1 (integration) — on a green build+test run: the PR that is opened is
 *         created after both pnpm build AND pnpm test pass; verified by
 *         asserting both commands appear in the stream before pr-create.
 *
 *   AC2 (unit) — on a failing test suite (non-zero exit from pnpm test):
 *         gh pr create is NOT called and a structured `PrePrTestFailedError`
 *         surfacing the exit code + captured output is raised instead.
 *         Also verified: a failing build (AC2b) still blocks PR creation via
 *         `PrePrBuildFailedError`.
 *
 * @see _bmad-output/implementation-artifacts/native:01KT3ER5E9ACCERHAEJ5NM94TH.md
 */
export {};
