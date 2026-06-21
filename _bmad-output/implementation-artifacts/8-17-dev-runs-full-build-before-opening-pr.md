# Story 8.17: Dev runs the full project build before opening the PR

story_shape: substrate
Status: ready-for-dev

## Story

As a **plugin maintainer**,
I want **the dev's commit-and-open-PR step to run the project's full build (and surface a failure) before it opens the PR, instead of relying on the agent to have remembered to do so**,
So that **the drain never opens a pull request whose build is red, and a story that breaks an untouched sibling file is caught before a PR exists rather than after CI fails**.

This was surfaced by the first real end-to-end drain (2026-05-30, story 8.15 / PR #211). The dev's pre-PR "run the build/test gates green" instruction lives only in agent prose (the `generalist-dev` persona and the drain's dev prompt), and `runDevTerminalAction` — the tool that actually opens the PR — runs no build or test at all. The dev added a new helper and a now-required parameter, which broke existing sibling test files it did not update; its own story-scoped test passed in isolation, so it opened the PR, and the full `tsc` build failed in CI. The dev then self-corrected across follow-up commits, but a red PR should never have been opened. Per crew's deterministic-seam discipline, a load-bearing check must live in the tool layer, not in a prose mandate the agent can skip under load.

## Dependencies

- None required. Composes with story 8.16 (per-dev worktree): the build must run in the dev's working directory, so if 8.16 has landed it runs in the worktree, otherwise in the target repo root — keep it working-directory-relative so the two stories compose in either order.

## Acceptance Criteria

**AC1 — the pre-PR build gate is a tool-layer step that blocks PR creation on failure (integration):**

Given the dev's commit-and-open-PR tool action runs with a build that exits non-zero, the tool runs the project's full build BEFORE attempting to open the PR, and on a failing build it does NOT open the PR — it returns/raises a structured failure carrying the build's exit code and captured output, so the caller can surface it. A vitest drives the tool with a stubbed command runner that makes the build step fail and asserts (a) the build was invoked before any PR-create step, and (b) no PR-create step was invoked and a structured build-failure result is returned.
vitest: plugins/crew/mcp-server/src/tools/__tests__/dev-prepr-build-gate.test.ts

**AC2 — a green build opens the PR exactly as before (integration, no regression):**

Given the same tool action runs with a build that exits zero, the build runs first and then the existing branch → commit → push → PR-create sequence proceeds unchanged, opening the PR as it does today. The vitest asserts that on a passing build the PR-create step is invoked once with the same arguments shape it receives today.
vitest: plugins/crew/mcp-server/src/tools/__tests__/dev-prepr-build-gate.test.ts

**AC3 — the gate runs the project's real full build in the dev's working directory (unit):**

The build the gate runs is the project's full build command (the one that performs the whole-project type-check, i.e. the same command CI runs), executed with its working directory set to the dev's working directory so it catches breakage in files the story did not touch — not a story-scoped subset. The command and its working directory are covered by the test above; the derivation is asserted so a future refactor cannot silently narrow the gate to a partial build.
vitest: plugins/crew/mcp-server/src/tools/__tests__/dev-prepr-build-gate.test.ts

## Notes

The PR-opening tool is `plugins/crew/mcp-server/src/tools/run-dev-terminal-action.ts`, which today runs `gitCreateBranch` → `gitCommit` → `gitPush` → `gh pr create` and performs no build or test. The full build is `pnpm build` at `plugins/crew` (which runs `pnpm -r build` → `tsc -p tsconfig.json && node scripts/normalise-dist.mjs` for the mcp-server) — this is the command that catches the cross-file `tsc` breakage #211 hit; a story-scoped vitest does not. Insert the build step after the commit (so `dist/` is rebuilt and the commit reflects it) but BEFORE `gh pr create`, and abort with a typed error (mirror the existing typed-error pattern in this file, e.g. `GitPushFailedError`) on non-zero exit so no PR is opened. Spawn the build through the project's existing command-runner seam (the same `execaImpl` injection this tool already uses for git) so the vitest can stub it — do NOT add a second spawn mechanism.

The prose mandate stays as belt-and-braces but is no longer load-bearing: optionally update the `generalist-dev` persona (`plugins/crew/catalogue/generalist-dev.md`) and the drain dev prompt (`plugins/crew/workflows/drain.workflow.js`) to say the build gate is now enforced by the tool. Running the full test suite (`vitest run`) in addition to the build is a reasonable extension but the binding gate for this story is the full build (the #211 failure class); if you add the test run, make it a documented, separately-skippable step so a slow suite cannot wedge the drain — and say so in the completion notes.

This is a code change touching the dev/orchestration seam: rebuild and commit `dist/` in the same change (CI fails on `src`/`dist` drift), keep the diff scoped to the dev terminal action + the new test (+ optional persona/prompt prose), and run the full `pnpm build` and `pnpm test` from `plugins/crew/mcp-server` green before opening the PR. It is a `medium`-risk change (edits existing orchestration source) and is expected to pause the auto-merge gate for a human merge — that is correct. Do not write or edit any execution manifest or `.crew/state` file; the tools own the ledger.
