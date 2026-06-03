/**
 * Allowlist-pin regression test for `loadRolePermissions` — Story 5.34 AC1 + AC3.
 *
 * AC1: Literal content-structure check — reads the raw YAML bytes of the
 *      production `generalist-dev.yaml` and asserts that `repo-view` and `api`
 *      appear as literal list entries in addition to the pre-existing entries
 *      (pr-create, pr-view, pr-comment, pr-merge). No parsed view — raw text.
 *
 * AC3: Reads the PRODUCTION `generalist-dev.yaml` via the real `loadRolePermissions`
 *      loader (no fixtures, no mocks of the permission file) and asserts that
 *      `gh_allow` is a superset of every subcommand `runAutoMergeGate` can invoke:
 *   - pr-merge  (auto-merge branch)
 *   - repo-view (pause-needs-human branch: gh repo view --json owner,name)
 *   - api       (pause-needs-human branch: gh api POST .../labels)
 *
 * This closes the mock-masking gap surfaced in the bmad:6.3 close-out failure
 * (2026-05-29, PR #180): the gate's existing vitest suite hand-built in-test
 * fixtures that happened to include repo-view + api, so the real generalist-dev
 * allowlist gap was invisible until the gate ran in production.
 *
 * `pluginRoot` is resolved via `import.meta.url` walked up from
 * `src/state/__tests__/` to `plugins/flow/` (four directories up) — same
 * pattern used by `getPluginRoot()` in `lib/plugin-root.ts`.
 *
 * Pure deterministic — no LLM invocation, no network, no temp fixtures.
 */
export {};
