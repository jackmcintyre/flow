# Story 1.9: Ship a pre-built `dist/` with the plugin

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an **end-user installing the crew plugin via `/plugin install crew@crew`**,
I want **the MCP server to start without me having to run any build step first**,
so that **the install path documented in the README actually works on a fresh clone, not just on a machine where `plugins/crew/mcp-server/dist/` happens to be built locally.**

### What this story fixes (and why it needs its own story)

`/plugin install` copies the plugin's working tree into `~/.claude/plugins/cache/`. Today, `mcp-server/dist/` is gitignored (top-level `.gitignore` line 2: `dist/`; `plugins/crew/.gitignore` line 2: `**/dist/`). A fresh clone has no build artefacts, so the install copies no `dist/`, the MCP server fails to start with `MODULE_NOT_FOUND` on `dist/index.js`, and `/crew:status` never reaches the server.

PR #61 was the canary: the install worked for Jack only because his local working tree happened to carry a stale `dist/` from a manual `pnpm build`. Eight bugs surfaced once that crutch was kicked out. v1 ships locally-installed; there is no `npm publish` step that could build at publish time.

**Trade-off picked (per epic context):** commit `dist/` to git. Cleaner-but-slower alternative (postinstall build via a `prepare` script) is explicitly deferred to a later revisit if the committed-artefacts pain shows up. Do not implement `prepare`-based postinstall in this story.

### What this story is, in one sentence

Un-gitignore and commit `plugins/crew/mcp-server/dist/`, add a CI step that fails the build when the committed artefact drifts from a fresh `pnpm build`, add a vitest harness that mirrors that drift check locally and a sentinel test that imports `dist/index.js` and `dist/tools/register.js` to catch partial-build regressions, and document the new "build-and-commit-dist" contract so a future dev agent doesn't quietly re-gitignore the directory.

### This story does NOT

- (a) Touch `_bmad-output/implementation-artifacts/sprint-status.yaml` — the orchestrator owns status transitions.
- (b) Introduce a `prepare`/postinstall build hook. The trade-off was explicitly made in the epic; the alternative is deferred work.
- (c) Publish or push artefacts anywhere outside the repo (no npm publish, no GitHub release).
- (d) Change the build itself (no `tsc` flag changes, no bundler swap). The output of `pnpm build` must be byte-identical before and after this story — what changes is whether that output is tracked.
- (e) Change any runtime behaviour of the MCP server, the `get-status` tool, or any skill. AC1 only asserts that the existing wired path now works on a fresh clone.
- (f) Backfill `dist/` into any historical commits or branches.
- (g) Modify the contents of `dist/` by hand. The committed `dist/` is always and only the output of a clean `pnpm build`.

---

## Acceptance Criteria

> **Verbatim from epic.** The four ACs below match `_bmad-output/planning-artifacts/epics/epic-1-plugin-foundation-target-repo-bootstrap.md` § Story 1.9 exactly. AC1 carries the `(user-surface)` tag because it names slash commands the operator types verbatim (`/plugin marketplace add ./`, `/plugin install crew@crew`, `/crew:status`) — satisfies rubric item (i) of `plugins/crew/docs/user-surface-acs.md`. AC2 (gitignore + working-tree state), AC3 (CI drift check), and AC4 (vitest harness) are infra/CI/test concerns — no user-invocable surface — and are therefore untagged.

**AC1 (user-surface):**
**Given** a freshly cloned repo with no prior `pnpm install` or `pnpm build` run,
**When** Jack (or any operator) runs `/plugin marketplace add ./` → `/plugin install crew@crew` → restarts Claude Code,
**Then** `/crew:status` dispatches to the MCP server and returns the expected typed pre-3.3 error (or, post-3.3, the rendered five-line block). Verified per Story 1.8's smoke gate.

**AC2:**
**Given** the gitignore configuration,
**When** I `git status` after a clean checkout,
**Then** `plugins/crew/mcp-server/dist/` is tracked and present (un-gitignored), the working tree is clean, and a `pnpm build` produces a byte-identical (or content-equivalent) `dist/` to what's committed.
<!-- Not user-surface: this AC governs gitignore state and rebuild equivalence — no slash command, no CLI literal the operator must memorise, no copy-by-name file. It's an infra contract verified by AC3/AC4. -->

**AC3:**
**Given** a CI run on any branch,
**When** CI builds the plugin,
**Then** CI verifies that the committed `dist/` matches a fresh `pnpm build` output — drift between source and committed artefact fails CI. _(prevents the "shipped a stale dist" failure mode that bit us during 1.7)_
<!-- Not user-surface: CI internal. The failure surface is a red check on a PR, not a slash-command output. -->

**AC4 (integration):**
vitest harness covers: (a) the dist-vs-source-rebuild equivalence check that CI runs locally; (b) a sentinel test that imports `dist/index.js` and `dist/tools/register.js` and asserts the exports exist (catches partial-build / missing-tools-directory regressions like the one PR #61 fixed).

---

## Tasks / Subtasks

- [ ] **Task 1 — Un-gitignore `mcp-server/dist/` at every ignoring layer (AC: 2)**
  - [ ] 1.1 Edit `plugins/crew/.gitignore`: replace the broad `**/dist/` rule with a more targeted exclusion that keeps `node_modules/` and any nested build directories ignored EXCEPT `mcp-server/dist/`. Recommended pattern (verify with `git check-ignore -v` after editing):
    ```
    node_modules/
    *.tsbuildinfo
    .DS_Store
    # mcp-server build artefacts are committed (Story 1.9) — do NOT re-gitignore.
    # If you add another package with a dist/, ignore it explicitly here.
    ```
    The previous `**/dist/` line is removed entirely. Rationale: there is currently only one `dist/` in the workspace (`mcp-server/dist/`); a future package adding its own `dist/` will need an explicit ignore added at that time, with a comment explaining why mcp-server's is different.
  - [ ] 1.2 Edit the repo-root `/Users/jackmcintyre/projects/crew/.gitignore`: remove the bare `dist/` line (line 2). Leave every other rule (`node_modules/`, `coverage/`, `*.log`, `.DS_Store`, `.sprint-orchestrator/`, the BMad block, the Claude Code runtime block, `.worktrees/`) untouched. Verify with `git check-ignore -v plugins/crew/mcp-server/dist/index.js` — the file MUST NOT appear ignored after the edit.
  - [ ] 1.3 Confirm no `.gitignore` further down the tree (e.g. inside `plugins/crew/mcp-server/`) ignores `dist/`. None exists today; verify by `find plugins/crew/mcp-server -name .gitignore`. If one appears in a future change, that's a regression Task 5's documentation note must call out.

- [ ] **Task 2 — Produce a clean `dist/` and commit it (AC: 1, 2)**
  - [ ] 2.1 From `plugins/crew/mcp-server/`, run `pnpm install` (uses the existing `plugins/crew/pnpm-lock.yaml`; do NOT modify the lockfile in this story unless an existing dep needs no change).
  - [ ] 2.2 Delete any stale local `dist/` (`rm -rf plugins/crew/mcp-server/dist`) and run `pnpm build` from scratch. The build script is `tsc -p tsconfig.json` (see `plugins/crew/mcp-server/package.json`); output goes to `dist/`.
  - [ ] 2.3 `git add plugins/crew/mcp-server/dist/` and verify with `git status` that every file under `dist/` is now staged (specifically including `dist/index.js`, `dist/tools/register.js`, and the full subdir tree mirroring `src/`).
  - [ ] 2.4 Commit `dist/` in the same commit as the gitignore changes. Commit message convention follows recent commits (e.g. `27ac70c`, `27ebfa0`, `f581908`): short imperative `fix(1.9):` or `feat(1.9):` prefix with a one-liner explaining why `dist/` is now tracked. Reference: `feat(1.9): commit pre-built dist so /plugin install works on a fresh clone`.
  - [ ] 2.5 Sanity-check after commit: `git ls-files plugins/crew/mcp-server/dist | wc -l` returns a non-zero count matching the number of `.js`/`.d.ts` files emitted by `tsc`. If zero, the gitignore is still winning — debug with `git check-ignore -v`.

- [ ] **Task 3 — Vitest sentinel + drift harness (AC: 4)**
  - [ ] 3.1 Add `plugins/crew/mcp-server/tests/dist-shipping.test.ts`. The suite covers **both** AC4 sub-claims in one file. Existing test files use vitest's `describe`/`test`/`expect` shape (see `smoke.test.ts`, `install-contract`-style suites). Match that style. Imports use the `.js` extension convention (NodeNext ESM resolution — verify against `plugins/crew/tsconfig.base.json`'s `moduleResolution`; the file under test will be `../dist/index.js` from the test's perspective).
  - [ ] 3.2 **Sentinel block (AC4 case b):** dynamically `import("../dist/index.js")` and `import("../dist/tools/register.js")`. For each:
    - Assert the import resolves (no `ERR_MODULE_NOT_FOUND`).
    - Assert at least one expected export exists. For `dist/tools/register.js` the canonical export is `registerAllTools` (called from `dist/index.js` per `src/index.ts`). For `dist/index.js`, the module has top-level side-effects (the IIFE-style `main()` plus a `.catch`); the safest sentinel assertion is that the dynamic import resolves to a module object whose default/named shape is non-empty, OR refactor the assertion to `await import` succeeding without throwing. **Recommended:** assert `typeof registerImport.registerAllTools === "function"` for `register.js`, and for `index.js` use `expect(import("../dist/index.js")).resolves.toBeDefined()` (note: importing `index.js` will invoke `main()`; if `main()` has side effects that need suppression in tests, wrap with `vi.mock` of `@modelcontextprotocol/sdk/server/stdio.js` to no-op the transport. Confirm against `src/index.ts` behaviour before deciding.) The intent is to **catch partial-build / missing-tools-directory regressions like PR #61** — the test must FAIL if `dist/tools/` is missing or `dist/index.js` is absent.
    - The dev MAY choose to import via a child-process spawn (`execa("node", ["dist/index.js"])` with `stdin: "ignore"`) and assert the process starts without immediate exit, as an alternative sentinel that doesn't execute `main()` in-process. Pick whichever is cleaner; document the choice in a code comment.
  - [ ] 3.3 **Drift block (AC4 case a):** the test rebuilds `dist/` into a temporary directory and compares it to the committed `dist/`.
    - Implementation: use `execa` (already a dependency at `^9.6.1` — see `package.json`) to run `pnpm exec tsc -p tsconfig.json --outDir <tmp>` from `plugins/crew/mcp-server/`. Then walk the committed `dist/` and the temp dir in parallel and assert: (1) identical relative-path file sets, (2) byte-equal contents per file. Use `node:fs/promises` `readdir({recursive:true})` and `readFile`; do not introduce new deps.
    - On mismatch, the test failure message MUST enumerate the divergent file paths (first N=5 differences is fine) so a dev sees immediately what drifted. Do NOT diff contents in the assertion message (could be huge); name the files and exit.
    - This block is the **same logic CI runs in AC3** — keep them aligned by extracting the compare into a helper (`plugins/crew/mcp-server/tests/_helpers/dist-compare.ts` or inline within the test file if a single use suffices). If extracted, the CI script in Task 4 calls a separate small Node script that uses the same helper.
    - **Time budget:** the temp-dir rebuild runs `tsc` once. On the existing source size this is sub-10s locally; if it ever exceeds 30s, mark the test `test.slow` or split into a separate suite. Don't gate on this in v1.
  - [ ] 3.4 Add the test to whichever test selection `pnpm test` already runs (vitest auto-discovers `tests/*.test.ts`; no config change needed — confirm via `plugins/crew/mcp-server/vitest.config.ts`).
  - [ ] 3.5 Run `pnpm --dir plugins/crew test` and confirm the new suite passes alongside the existing ones (smoke, workspace-resolver, validate-active-adapter, standards-doc, permissions-enforcement, canonical-fs-guard, telemetry-logger, git-commit, manifest-state-machine, get-status, install-contract, acceptance, pre-pr-gate, user-surface-convention). Zero skips, zero new flakes.

- [ ] **Task 4 — CI drift-check step (AC: 3)**
  - [ ] 4.1 Edit `.github/workflows/ci.yml` to add a drift-verification step. The existing `build` job already runs `pnpm install --frozen-lockfile` and `pnpm build`; the new step runs **after** `pnpm build` and **before** `pnpm test`. Suggested step (verify the exact YAML against the existing file's indentation/quoting before committing):
    ```yaml
          - name: Verify committed dist/ matches fresh build
            run: |
              git diff --exit-code mcp-server/dist
    ```
    Rationale: `pnpm build` writes into `mcp-server/dist/`. If the committed `dist/` matches the fresh build, `git diff --exit-code` is clean (exit 0). If it drifts, the step fails with a diff in the log, naming the divergent files. This is the lightest-touch implementation; no new tooling.
  - [ ] 4.2 Confirm the existing `paths:` filter in `ci.yml` (`plugins/crew/**`) still catches the new `dist/` changes — it does, because `dist/` is under that prefix.
  - [ ] 4.3 Do NOT create a new workflow file. Add to the existing `ci.yml` as instructed by the epic implementation map.
  - [ ] 4.4 Verify locally: in a clean working tree, run `(cd plugins/crew && pnpm install --frozen-lockfile && pnpm build && git diff --exit-code mcp-server/dist)`. Must exit 0. Then introduce a deliberate `dist/` corruption (e.g. `echo "// drift" >> plugins/crew/mcp-server/dist/index.js`), re-run, confirm non-zero exit and a sensible diff. Revert the corruption before committing.
  - [ ] 4.5 **Determinism caveat to investigate:** `tsc` output is deterministic across runs on the same source + same tsc version + same lockfile, BUT can differ if any dev runs `pnpm install` against a newer transitive `typescript` version. The lockfile pin (`pnpm-lock.yaml`) protects us as long as devs use `--frozen-lockfile` locally. **If the CI step trips on a developer's machine due to a different `typescript` resolution**, the fix is to document `pnpm install --frozen-lockfile` as the canonical local install (Task 5.1), not to loosen the CI check. Do not add tolerance to the diff.

- [ ] **Task 5 — Document the build-and-commit-dist contract (AC: 2, prophylactic)**
  - [ ] 5.1 Add a `## Build artefacts` (or similar) section to `plugins/crew/docs/README-install.md` (or the closest existing maintainer-facing doc; verify by listing `plugins/crew/docs/`). The section explains: (a) `mcp-server/dist/` is committed by design (link to this story 1.9 spec for the why), (b) any change to `src/` requires running `pnpm install --frozen-lockfile && pnpm build` and committing the resulting `dist/` in the same commit, (c) CI fails any PR where committed `dist/` drifts from a fresh build, (d) the dev MUST NOT re-add `dist/` (or `**/dist/`) to any `.gitignore` — if they need to ignore a new package's `dist/`, name it explicitly.
  - [ ] 5.2 Add a short note to `CLAUDE.md` (project root) under a new bullet in the existing "Process notes" or "What Jack doesn't want" section, paraphrased for the PM voice: e.g. "Build output for the plugin (`plugins/crew/mcp-server/dist/`) is tracked in git. If you change `src/`, rebuild and commit `dist/` in the same change — CI fails otherwise. See `plugins/crew/docs/README-install.md` for the contract." Keep it terse (one bullet, two sentences max). This is the only line that lands in the PM-facing file.
  - [ ] 5.3 **MUST NOT** copy the contract into BMad skill files (those live under `.claude/skills/bmad-*/` which is gitignored — see top-level `.gitignore` line 11 — and is treated as a third-party dependency per the project conventions).

- [ ] **Manual smoke step (post-merge to feed Story 1.8's gate)**
  - [ ] M.1 **This story is `user-surface` via AC1.** Story 1.8's `pre-pr-gate` runs against this story before its PR opens. The orchestrator (ship-story Step 8/8.5, NOT the dev agent) is responsible for: on a clean machine OR in a clean worktree where `dist/` was NOT manually rebuilt outside the spec's flow, (1) `git clone`, (2) `cd` into the clone, (3) `/plugin marketplace add ./` in real Claude Code, (4) `/plugin install crew@crew`, (5) restart Claude Code, (6) run `/crew:status`, (7) capture the verbatim output (the expected pre-3.3 typed error or, post-3.3, the five-line block), (8) write a `user_surface_verified` event via `$SH record-verification <this-story-key> --type user_surface_verified --data '{"ac_refs":[1],"operator":"jack","observations":[{"ac_ref":1,"pasted_output":"<verbatim>"}]}'`. The dev agent does NOT produce this evidence; it is the orchestrator's responsibility per Story 1.8 § Task 5.5. Once recorded, `pre-pr-gate` passes and the PR opens.

---

## Dev Notes

### Why this story exists at all (and why a postinstall hook is NOT the fix)

The epic context is unambiguous: **Trade-off picked: commit `dist/` to git.** The cleaner-looking alternative — a `prepare` script in `mcp-server/package.json` that runs `tsc` on install — was considered and rejected for v1 because:

1. `/plugin install` does not run `npm install`/`pnpm install` in the copied tree. It copies the working tree as-is. A `prepare` hook would never fire.
2. Even if it did, requiring users to have `node`+`pnpm`+`typescript` resolved on a fresh clone re-introduces exactly the "build step before plugin works" failure mode this story exists to eliminate.
3. v1 ships locally-installed (no npm publish), so there is no publish-time hook to lean on.

Do not, in implementing this story, introduce a `prepare` script, a `postinstall` script, or any other build-on-install mechanism. The committed-artefact path is the v1 contract.

### What the dev needs to know about the existing source tree

- Entry point: `plugins/crew/mcp-server/src/index.ts` (compiles to `dist/index.js`). Top-level: calls `createServer()`, registers tools via `registerAllTools()` (imported from `./tools/register.js`), connects stdio transport. There is a top-level `main()` IIFE — be careful if the sentinel test imports `dist/index.js` directly; you may need to mock the SDK's stdio transport to avoid hanging the test process.
- Tool registry: `plugins/crew/mcp-server/src/tools/register.ts` → `dist/tools/register.js`. PR #61 fixed a regression where `dist/tools/` was absent because the build had been done partially / against an out-of-sync `src/`. The sentinel test exists to catch a recurrence.
- Build command: `pnpm build` → `tsc -p tsconfig.json`. The tsconfig (`plugins/crew/mcp-server/tsconfig.json`) extends `plugins/crew/tsconfig.base.json` with `outDir: dist`, `rootDir: src`, `noEmit: false`.
- Test command: `pnpm test` → `vitest run`. Config at `plugins/crew/mcp-server/vitest.config.ts`. Existing suites auto-discover via `tests/*.test.ts`.

### What the dev needs to know about gitignore precedence

- The repo-root `/Users/jackmcintyre/projects/crew/.gitignore` line 2 currently reads `dist/`. This catches `plugins/crew/mcp-server/dist/` because gitignore patterns without leading `/` match at any depth. Removing the line is necessary.
- `plugins/crew/.gitignore` line 2 currently reads `**/dist/`. Same effect, more explicit. Must be replaced — see Task 1.1.
- After both edits, run `git check-ignore -v plugins/crew/mcp-server/dist/index.js`. If the file is reported as ignored, name the rule that's still matching and remove or override it. A negation pattern (`!plugins/crew/mcp-server/dist/`) is a fallback if removing rules cleanly proves impossible, but **prefer removing** for clarity.

### What the dev needs to know about CI

- `.github/workflows/ci.yml` already pins `working-directory: plugins/crew` for the build job. The new `git diff --exit-code mcp-server/dist` step inherits that working directory — the path is correct as written.
- The CI job uses `pnpm install --frozen-lockfile`. This pins `typescript` to whatever `pnpm-lock.yaml` resolves, which is what makes the drift check stable.
- Branch protection / required-checks settings are out of scope. If `ci.yml`'s drift step starts failing, that's the visible signal; gating PR merge on it is the operator's call later.

### What's NEW vs UPDATE

**NEW files:**
- `plugins/crew/mcp-server/tests/dist-shipping.test.ts` — the AC4 vitest harness (sentinel imports + drift block).
- (Conditional) `plugins/crew/mcp-server/tests/_helpers/dist-compare.ts` — only if Task 3.3 extracts the compare into a shared helper. Optional; inline is fine.
- The committed contents of `plugins/crew/mcp-server/dist/` (many files; product of `pnpm build`). Treated as one file-list entry in the PR.

**UPDATE files:**
- `.gitignore` (repo root) — remove the `dist/` line.
- `plugins/crew/.gitignore` — remove `**/dist/`; add the explicit `node_modules/` + comment block per Task 1.1.
- `.github/workflows/ci.yml` — add the drift-verification step between `pnpm build` and `pnpm test`.
- `plugins/crew/docs/README-install.md` (or closest existing maintainer doc; verify by listing the dir) — add the `## Build artefacts` contract section per Task 5.1.
- `CLAUDE.md` (repo root) — one terse bullet per Task 5.2.

**MUST NOT TOUCH:**
- `_bmad-output/implementation-artifacts/sprint-status.yaml`.
- Any other story spec file under `_bmad-output/implementation-artifacts/`.
- `plugins/crew/.claude-plugin/plugin.json`, `marketplace.json`, or any plugin manifest.
- `plugins/crew/mcp-server/package.json` (no new deps unless `execa` somehow regressed — it's already there at `^9.6.1`).
- `plugins/crew/mcp-server/src/**` (no source changes; this story is purely about how source compiles, ships, and is verified).
- `plugins/crew/mcp-server/pnpm-lock.yaml` (must not be regenerated as a side effect; if `pnpm install` changes it, that's a separate concern surfaced to the operator).
- Any existing test file in `plugins/crew/mcp-server/tests/` (this story only ADDS one new test file).
- `.claude/skills/**` (BMad-installed skills are gitignored and treated as third-party).

### Testing standards

- vitest, run via `pnpm --dir plugins/crew test`. The new `dist-shipping.test.ts` joins the existing suites. All suites must remain green; zero new skips.
- The sentinel block (AC4 case b) is the highest-leverage assertion in this story — it's the regression test for PR #61. Write it first, confirm it would have failed on the pre-PR-#61 state (mental model: delete `dist/tools/` and re-run the test; it should fail), then implement the drift block.
- The drift block (AC4 case a) is intentionally a near-clone of the CI step. Keep them aligned. If the test passes but CI fails (or vice versa), the divergence is a bug — fix the comparator, not the symptom.
- Do NOT use snapshot testing for `dist/` contents. The artefact is byte-compared file-by-file; snapshots would either be unwieldy (every `.js` file) or lossy (file-list only).
- The drift block runs `tsc` on every test execution. If local test runtime becomes painful, the dev MAY tag the test with `test.slow` or move it behind a `RUN_DRIFT_CHECK=1` env gate **so long as CI's separate `git diff --exit-code` step still runs every PR**. Do not weaken CI to make tests faster.

### Project Structure Notes

- `plugins/crew/mcp-server/tests/` is the canonical vitest home for all crew suites; this story follows the established pattern.
- The committed `dist/` lives at `plugins/crew/mcp-server/dist/`. It is a one-to-one mirror of `src/`'s `.ts` → `.js` + `.d.ts` output produced by `tsc -p tsconfig.json`. No bundling, no minification.
- `pnpm-workspace.yaml` at `plugins/crew/pnpm-workspace.yaml` declares only `mcp-server` as a workspace package. No other package contributes `dist/` to the tree today.
- Recent commit history (`27ac70c`, `27ebfa0`, `f581908`, `b4dbaa6`, `bbdc10c`) shows the convention: short imperative subject with a story-tagged prefix (`fix(1.7a):`, `feat(1.7):`, `chore:`, `feat(1.6):`). Match that.

### References

- Epic: [Source: _bmad-output/planning-artifacts/epics/epic-1-plugin-foundation-target-repo-bootstrap.md § Story 1.9]
- Precursor failure analysis: [Source: epic-1 § Story 1.7a post-story note (2026-05-20)]
- User-surface AC rubric: [Source: plugins/crew/docs/user-surface-acs.md] — AC1 satisfies rubric item (i).
- Smoke gate that consumes AC1: [Source: _bmad-output/implementation-artifacts/1-8-user-surface-ac-type-and-smoke-gate-in-ship-story.md § Task 5.5, § "Verification event schemas"]
- Existing CI: [Source: .github/workflows/ci.yml]
- MCP server entry point: [Source: plugins/crew/mcp-server/src/index.ts]
- Build config: [Source: plugins/crew/mcp-server/tsconfig.json, plugins/crew/tsconfig.base.json]
- Existing vitest suites: [Source: plugins/crew/mcp-server/tests/*.test.ts]
- Top-level gitignore: [Source: /Users/jackmcintyre/projects/crew/.gitignore]
- Plugin-level gitignore: [Source: plugins/crew/.gitignore]

---

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
