/**
 * Story 5.27: `runVitestCheck` workspace-aware cwd resolution.
 *
 * Tests for `findPackageRoot` (unit) and workspace-aware cwd logic exercised
 * through `runReviewerSession` (integration). Seeds three fixture trees (AC3)
 * and exercises both pre-5.26 and post-5.26 paths (AC4).
 *
 * AC3 fixtures:
 *   A (workspace shape)   — outer dir with no package.json + inner package with package.json
 *   B (no manifest)       — outer dir with no package.json anywhere; walk exhausts checkRoot
 *   C (root-level manifest) — outer dir with root package.json; test at tests/root.test.ts
 *
 * AC4 paths:
 *   Path 1 (pre-5.26)  — checkRoot === targetRepoRoot (or fixtureRoot); asserted by fixture A
 *   Path 2 (post-5.26) — checkRoot === a separate worktree-shaped directory
 *
 * Integration tests (AC3-A(b/c), AC3-B fail-reason, AC3-C cwd, AC4) drive
 * `runReviewerSession` with seeded fixtures and capture real `execa` stub calls —
 * same pattern as `run-reviewer-session.test.ts:456`.
 *
 * `vitest: plugins/flow/mcp-server/src/tools/__tests__/reviewer-vitest-cwd.test.ts`
 */
export {};
