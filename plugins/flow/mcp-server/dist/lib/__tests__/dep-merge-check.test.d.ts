/**
 * Unit tests for the build-blind dependency-merge check.
 *
 * `isDependencyPrMerged` reproduces a dependency's PR head branch from its
 * {ref, title} and asks `gh pr list --head <branch> --state merged`. It returns
 * true iff a merged PR exists, and FAIL-SAFE false on any gh/parse failure.
 *
 * `areDependenciesMerged` reads each dep's `done/` manifest for its title, then
 * defers to a (mockable) per-dep merge probe; it short-circuits false on the
 * first unmerged / missing / malformed dependency.
 */
export {};
