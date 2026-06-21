# Story 5.34: Auto-merge gate: grant generalist-dev the repo-view + api gh subcommands

story_shape: substrate

Status: ready-for-dev

<!-- Authored 2026-05-29 after the bmad:6.3 close-out failure: the reattached orphan reviewed READY FOR MERGE, then runAutoMergeGate died on a repo-view denial. Story 6.3 still landed in done/ and PR #180 was merged manually. Latent since the auto-merge gate shipped (PR #154), masked by the gate's mocked-gh tests whose in-test permission fixtures include repo-view. -->

## Story

As **the operator orchestrating `/crew:start` and the generalist-dev agent that runs the auto-merge gate**,
I want **`generalist-dev`'s gh allowlist to include the `repo-view` and `api` subcommands that `runAutoMergeGate` actually invokes**,
So that **the auto-merge gate stops throwing `GhSubcommandDeniedError (NFR17)` on its `pause-needs-human` branch and can complete the merge/label decision it was built to make, instead of dying silently after a clean review on every story**.

### What this story is, in one sentence

`runAutoMergeGate` defaults to role `generalist-dev` and loads that role's permissions via the production `loadRolePermissions` path, but `generalist-dev.yaml`'s `gh_allow` is missing two subcommands the gate calls (`repo-view` and `api`) — so the gate is denied and blocked for every story; the fix adds those two entries to the real allowlist and pins them to the call sites with regression tests that read the production permission file.

### Why this story is the right shape

This is a pure substrate permission-plumbing fix — an internal allowlist correction plus regression coverage. It is NOT a user-surface slash command and adds no new behaviour. The smallest correct fix is two new `gh_allow` entries on one YAML file. The risk in a one-line allowlist edit is that it can silently regress again (exactly how this defect stayed latent), so the load-bearing part of the story is the regression seam: a test that exercises the REAL loaded role allowlist, not a hand-built mock fixture.

### Why this blocks the dogfood path

`runAutoMergeGate` is the close-out step of every `/crew:start` story: after a clean review the gate either auto-merges (low risk, met threshold) or pauses for human (medium/high, or unmet threshold) by labelling the PR `needs-human`. The `pause-needs-human` branch resolves owner/repo via `gh repo view --json owner,name` (subcommand `repo-view`) then applies the label via `gh api POST /repos/<owner>/<repo>/issues/<prNumber>/labels` (subcommand `api`). Both are denied today. The `auto-merge` branch calls `gh pr merge` (subcommand `pr-merge`), which is already allowed. So any story that routes to `pause-needs-human` — which is the medium/high path the gate exists to handle — dies on the `repo-view` denial after a successful review, leaving the operator to merge or label by hand. Story 6.3 hit exactly this on 2026-05-29 (PR #180 was merged manually).

### Why the defect stayed latent

The gate's own vitest tests (`run-auto-merge-gate.test.ts`) mock the gh shell-out AND construct their own in-test permission fixtures whose `gh_allow` arrays already include `repo-view` and `api`. So the tests never load the production `generalist-dev.yaml` and never saw the real gap. `generalist-reviewer.yaml` has `[pr-diff, pr-view, api, repo-view]`, which is why reviewer-side tools (`postReviewerComments`, `applyReviewerLabels`) work — those run as the reviewer role, not generalist-dev. The regression seam in AC2/AC3 closes this masking gap by reading the production file.

---

## Acceptance Criteria

**AC1:**

`plugins/crew/permissions/generalist-dev.yaml`'s `gh_allow` list contains both `repo-view` and `api`, in addition to the existing `pr-create`, `pr-view`, `pr-comment`, and `pr-merge` entries. No existing entry is removed and no other field of the file (`role`, `tools_allow`, `gh_allow_args`) is changed. This is a deterministic content-structure check against the production permission file.
artifact: plugins/crew/permissions/generalist-dev.yaml

**AC2 (integration — regression):**

A vitest test drives `runAutoMergeGate` down BOTH the `pause-needs-human` branch and the `auto-merge` branch, loading the REAL `generalist-dev` role permissions via the production `loadRolePermissions` path (NOT a hand-built or mock `gh_allow` array), with the gh shell-out itself faked or run in dry-run. It asserts that neither path throws `GhSubcommandDeniedError` for `repo-view`, `api`, or `pr-merge`. This is the regression guard for the 2026-05-29 bmad:6.3 close-out failure.
vitest: plugins/crew/mcp-server/src/tools/__tests__/run-auto-merge-gate.test.ts

**AC3 (regression):**

A vitest test loads the real `generalist-dev.yaml` via `loadRolePermissions({ role: "generalist-dev" })` and asserts its `gh_allow` is a superset of every gh subcommand `runAutoMergeGate` can invoke (`pr-merge`, `repo-view`, `api`). The test reads the PRODUCTION permission file, not a fixture, so the mock-masking gap that hid this defect cannot recur.
vitest: plugins/crew/mcp-server/src/state/__tests__/load-role-permissions.test.ts

---

## Implementation Notes

### Recommended fix shape

1. **The one-line fix (AC1).** Append `repo-view` and `api` to the `gh_allow` list in `plugins/crew/permissions/generalist-dev.yaml`. The current list is `[pr-create, pr-view, pr-comment, pr-merge]`; the target list is `[pr-create, pr-view, pr-comment, pr-merge, repo-view, api]`. Keep all four existing entries and leave `role`, `tools_allow`, and `gh_allow_args` untouched. Mirror the YAML list style already used in the file (one `- entry` per line).

2. **Why these two and no more.** Trace the call sites in `plugins/crew/mcp-server/src/tools/run-auto-merge-gate.ts`:
   - `auto-merge` branch (~line 308): `gh pr merge <prNumber> --squash --delete-branch` → subcommand `pr-merge` (already allowed).
   - `pause-needs-human` branch (~line 333): `gh repo view --json owner,name` → subcommand `repo-view` (MISSING).
   - `pause-needs-human` branch (~line 360): `gh api POST /repos/<owner>/<repo>/issues/<prNumber>/labels` → subcommand `api` (MISSING).
   The role defaults to `generalist-dev` (`const role = opts.role ?? "generalist-dev"`, ~line 201) and permissions load via `loadRolePermissions({ role, pluginRoot })` (~line 301). Adding exactly `repo-view` and `api` closes the gap without over-granting.

3. **AC2 regression test.** The existing `run-auto-merge-gate.test.ts` already mocks the gh layer and builds in-test permission fixtures — that is precisely the masking pattern. Add (do not delete the existing cases) at least one test that loads the REAL `generalist-dev` permissions instead of a hand-built fixture. The cleanest seam: let the gate's `loadRolePermissions` run against the production `permissions/` dir by passing the real `pluginRoot` (the gate already accepts a `pluginRoot` test seam — see `gh-error-map`/`loadRolePermissions` wiring at ~line 129 and ~line 301), while still faking the actual gh shell-out (so no real `gh` runs). Drive one assertion through `pause-needs-human` (forces `repo-view` + `api` allowlist checks) and one through `auto-merge` (forces `pr-merge`). Assert no `GhSubcommandDeniedError` is thrown for any of the three subcommands on either path.

4. **AC3 allowlist-pin test.** This creates a NEW test file `plugins/crew/mcp-server/src/state/__tests__/load-role-permissions.test.ts` (it does not exist yet). Call `loadRolePermissions` for `generalist-dev` against the production `permissions/` directory and assert the parsed `gh_allow` is a superset of `["pr-merge", "repo-view", "api"]`. NOTE: the production `loadRolePermissions` signature is `loadRolePermissions({ role, pluginRoot })` and `pluginRoot` is REQUIRED (the loader does not derive it). The AC text writes `loadRolePermissions({ role: "generalist-dev" })` as shorthand; in the real test resolve `pluginRoot` to the repo's `plugins/crew` directory (e.g., from `import.meta.url` walked up to the package root, or the same plugin-root resolution helper the other state tests use) and pass it through. The intent — read the PRODUCTION yaml, not a fixture — is the load-bearing requirement.

### Files touched

**MODIFY:**

- `plugins/crew/permissions/generalist-dev.yaml` — add `repo-view` and `api` to `gh_allow` (AC1). Two new list lines, nothing else.
- `plugins/crew/mcp-server/src/tools/__tests__/run-auto-merge-gate.test.ts` — add the real-allowlist regression case(s) covering both gate branches (AC2). Do not remove existing coverage.

**NEW:**

- `plugins/crew/mcp-server/src/state/__tests__/load-role-permissions.test.ts` — allowlist-superset pin against the production permission file (AC3). This file does not exist today.

**UNTOUCHED (DO NOT modify):**

- `plugins/crew/mcp-server/src/tools/run-auto-merge-gate.ts` — the tool's logic is correct; the bug is purely a missing allowlist entry. Do not change the tool's call sites or its role default.
- `plugins/crew/permissions/generalist-reviewer.yaml` — already has `repo-view` and `api`; reviewer-side tools work today. Leave it.
- `plugins/crew/mcp-server/src/state/load-role-permissions.ts` — the loader is correct. AC3 tests it; it is not modified.
- `plugins/crew/mcp-server/src/errors.ts` — `GhSubcommandDeniedError` (NFR17) shape is unchanged; only the conditions under which it fires for `generalist-dev` change (it should now NOT fire for `repo-view`/`api`).

### Build artefacts

This story changes a permission YAML and two test files only — no `mcp-server/src/` runtime TypeScript (the loader and the gate are untouched). The permission YAMLs are read at runtime and are not part of the compiled `dist/` tree. If the dev nonetheless touches any file under `plugins/crew/mcp-server/src/` (it should not need to), it MUST run `pnpm -r build` and stage the resulting `plugins/crew/mcp-server/dist/` changes in the same commit — CI fails on `src/`↔`dist/` drift per project CLAUDE.md § "Plugin build output is tracked in git". Either way, run `pnpm -r test` and confirm green.

### Dependencies

None. Leaf story. The change is self-contained: one allowlist edit plus regression tests. No new MCP tools, no schema changes, no behaviour change to the gate's decision logic.

### Root cause summary

The auto-merge gate (PR #154) was built to run as `generalist-dev` and to call `gh repo view` + `gh api` on its `pause-needs-human` branch, but `generalist-dev.yaml`'s `gh_allow` was never widened past the four PR subcommands the dev agent already used (`pr-create`, `pr-view`, `pr-comment`, `pr-merge`). The mismatch was invisible because the gate's vitest suite mocked the gh layer and hand-built permission fixtures that happened to include `repo-view` — so the tests exercised a permissive fixture, never the production file. It surfaced 2026-05-29 on the bmad:6.3 close-out, when a reattached orphan reviewed READY FOR MERGE and the gate immediately died on the `repo-view` denial; the story was merged manually as PR #180. The fix is two allowlist entries plus a regression seam that reads the production permission file so the mock-masking gap cannot recur.

---

## Definition of Done

- [ ] `generalist-dev.yaml`'s `gh_allow` contains `repo-view` and `api` alongside the existing `pr-create`, `pr-view`, `pr-comment`, `pr-merge`; no other field changed.
- [ ] AC2 regression test lands: `runAutoMergeGate` driven down both `pause-needs-human` and `auto-merge` branches against the REAL `generalist-dev` permissions (faked gh shell-out) throws no `GhSubcommandDeniedError` for `repo-view`, `api`, or `pr-merge`.
- [ ] AC3 pin test lands (new file): `loadRolePermissions` for `generalist-dev` against the production yaml asserts `gh_allow ⊇ {pr-merge, repo-view, api}`.
- [ ] No change to `run-auto-merge-gate.ts` logic, `load-role-permissions.ts`, `errors.ts`, or `generalist-reviewer.yaml`.
- [ ] `pnpm -r test` passes (existing gate tests still green; the new/updated tests green).
- [ ] If any `mcp-server/src/` file was touched, `pnpm -r build` clean and `dist/` staged in the same commit.
