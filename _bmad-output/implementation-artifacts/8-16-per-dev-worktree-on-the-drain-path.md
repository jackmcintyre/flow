# Story 8.16: Per-dev worktree on the drain path

story_shape: substrate
Status: ready-for-dev

## Story

As a **plugin maintainer**,
I want **the drain's dev subagent to build each story inside its own dedicated git worktree, committing only its own changes**,
So that **the dev never edits or stages files in the checkout the orchestrating session is running from, a story PR can never sweep in unrelated working-tree changes, and parallel multi-story drains become safe to build later**.

This was surfaced by the first real end-to-end drain (2026-05-30, story 8.15 / PR #211). The Stage-1 drain runs the generalist-dev subagent directly in `targetRepoRoot` with no worktree, and `runDevTerminalAction` commits via `gitCommit({ paths: ["."] })` (i.e. `git add .`). Two coupled problems result: (1) the dev edits files in the same checkout the orchestrating session uses — observed leaving work-in-progress in the shared tree when a run was interrupted; (2) `git add .` stages the entire working tree, so any stray uncommitted change present at commit time is swept into that story's PR. Epic 8 Story 8.5's own scope already specified "dev agent in its own worktree (cwd = repo root for `gh`)", but the shipped Stage-1 drain ran in the main checkout instead — this story closes the gap between that intent and what shipped, and unblocks the deferred parallel multi-story drain.

## Dependencies

- None. Builds on the existing worktree precedent `plugins/crew/mcp-server/src/lib/materialise-pr-branch-worktree.ts` (Story 5.26 — the reviewer already materialises the PR branch in an isolated worktree) and the existing `runDevTerminalAction` git seam; no other story is a prerequisite.

## Acceptance Criteria

**AC1 — the dev builds in a dedicated worktree, not the orchestrating checkout (integration):**

Given a drain claims a story, the dev's code changes, branch creation, commit, and PR are produced inside a git worktree distinct from `targetRepoRoot`, such that after the dev step the orchestrating checkout's working tree at `targetRepoRoot` shows no story files modified by the dev. A vitest exercises the drain's dev step (with the `gh`/network terminal action stubbed) against a temp git repo and asserts that (a) a worktree was created for the story, and (b) `git -C <targetRepoRoot> status --porcelain` is clean of the dev's changes while the worktree contains them.
vitest: plugins/crew/mcp-server/src/tools/__tests__/dev-worktree-isolation.test.ts

**AC2 — the commit stages only the dev's own changes, never unrelated working-tree files (integration):**

Given an unrelated, pre-existing uncommitted change is present when the dev commits, the resulting story commit/PR contains only the files the dev actually changed for the story and does not include the unrelated change. The dev's commit step no longer stages the entire tree indiscriminately: either the dev works in an isolated worktree that does not contain the unrelated change, or the commit stages an explicit changed-paths set rather than `git add .` — whichever the implementer chooses, the test asserts the unrelated file is absent from the commit. Covered by the test above (seed an unrelated tracked-but-modified file, run the dev step, assert it is not in the commit's file list).
vitest: plugins/crew/mcp-server/src/tools/__tests__/dev-worktree-isolation.test.ts

**AC3 — the worktree's repo context resolves correctly and the worktree is cleaned up (integration):**

`runDevTerminalAction` continues to resolve the correct repository when the dev operates in a worktree — the branch, commit, push, and `gh pr create` all target the intended repo and branch, not a mismatched root (the cwd-inference snag the 8.5 scope flagged). After the story completes (or the dev step fails), the worktree is removed so repeated drains do not accumulate orphaned worktrees, and a failure mid-build does not leave the worktree wedged. The test asserts the PR is opened against the expected branch and that no leftover worktree for the story remains registered after the step returns.
vitest: plugins/crew/mcp-server/src/tools/__tests__/dev-worktree-isolation.test.ts

## Notes

The drain loop is `plugins/crew/workflows/drain.workflow.js` (the dev is spawned in `processStory`; the comment there at the dev-spawn site documents why v1 ran in `targetRepoRoot` — that comment should be updated or removed by this change). The git seam is `plugins/crew/mcp-server/src/tools/run-dev-terminal-action.ts`, which today calls `gitCreateBranch` → `gitCommit({ paths: ["."] })` → `gitPush` → `gh pr create`, all via `git -C <targetRepoRoot>`.

Follow the existing worktree precedent rather than inventing one: `plugins/crew/mcp-server/src/lib/materialise-pr-branch-worktree.ts` (Story 5.26) already adds an isolated worktree under `.crew/state/sessions/<sessionUlid>/` via `git worktree add <path> <sha>`, returns `{ worktreePath, cleanup() }` with best-effort idempotent teardown, and is the model to mirror (a `dev-<ref>-worktree` sibling of its `pr-<prNumber>-worktree` is the natural path). Note: `git.ts` does NOT currently expose any worktree helper, and there is a static `canonical-fs-guard` test (see `plugins/crew/mcp-server/src/**/__tests__/canonical-fs-guard*.test.ts`) governing which files may spawn `git`; `materialise-pr-branch-worktree.ts` is the precedent for a non-`git.ts` file that spawns `git worktree` directly, so reconcile the new worktree code with that guard (extend the allowlist or route through the same module) — read the guard test before wiring, and do not assume git.ts must own the spawn.

Two viable implementation shapes — the implementer picks one and documents the choice: (a) **worktree-per-dev**: create a worktree for the story branch, run the dev (and `runDevTerminalAction`) with its cwd/repo pointed at the worktree so `gh` and git resolve correctly, then remove the worktree on completion/failure; or (b) **narrow staging**: keep the dev in `targetRepoRoot` but replace `git add .` with an explicit changed-paths stage so unrelated edits are never swept in. (a) is preferred because it also unblocks the deferred parallel multi-story drain and fully isolates the shared tree; (b) is the smaller fix if (a)'s cwd-inference plumbing proves too large for one story — if you fall back to (b), say so in the completion notes and leave worktree isolation as a named follow-up.

This is a code change touching the orchestration path and the git seam: rebuild and commit `dist/` in the same change (CI fails on `src`/`dist` drift), keep the diff scoped to the workflow + the dev terminal action + the new test (+ any small git.ts addition), and run the full `pnpm build` and `pnpm test` from `plugins/crew/mcp-server` green before opening the PR. It is a `medium`-risk change (edits existing orchestration source) and is expected to pause the auto-merge gate for a human merge — that is correct. Do not write or edit any execution manifest or `.crew/state` file; the tools own the ledger. Avoid naming literal state paths or `bmad:N.N` refs in the AC text above (kept here in Notes) so the planning-discipline scanner does not false-positive.
