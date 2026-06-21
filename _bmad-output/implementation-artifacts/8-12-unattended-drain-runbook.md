# Story 8.12: Operator runbook for an unattended multi-story drain

story_shape: substrate
Status: ready-for-dev

## Story

As a **plugin operator**,
I want **a runbook that walks me through queuing low-risk stories and running the drain unattended until the backlog is empty**,
So that **I can "walk away and come back to a stack of merged PRs" without re-deriving the invocation from the workflow source each time**.

This is an Epic 8 dogfood story for the multi-story unattended drain: a docs-only, purely-additive change. It creates exactly one new Markdown file. No code, no tests, nothing else changed.

## Dependencies

- None. Leaf story: one new documentation file. Does not touch source, build output, or any `.crew/state` file.

## Acceptance Criteria

**AC1 — a runbook exists covering how to queue and launch an unattended drain:**

A new Markdown file exists at `plugins/crew/docs/unattended-drain-runbook.md`. It explains the end-to-end operator flow: (1) author or confirm low-risk stories and run `/crew:scan` so they enter the claimable to-do queue; (2) launch the `crew-drain` workflow (`plugins/crew/workflows/drain.workflow.js`) via the Workflow tool, passing `targetRepoRoot`, `cli` (the absolute path to the plugin's compiled CLI entrypoint), and the optional `maxStories`. It states explicitly that the workflow `scriptPath` MUST be absolute (a relative path resolves against the plugin dir and doubles the prefix).
artifact: plugins/crew/docs/unattended-drain-runbook.md

**AC2 — the runbook explains drain-until-empty and the optional `maxStories` safety cap:**

The same file documents that, with `maxStories` omitted, the drain runs until the queue is empty — the unattended "walk away" mode — and that supplying a positive integer caps the run as a safety backstop. It notes that the queue strictly shrinks each story (claim is atomic), so an unbounded drain always terminates.
artifact: plugins/crew/docs/unattended-drain-runbook.md

**AC3 — the runbook explains how to reconcile after a run:**

The same file includes an "After the run" section: the drain runs the dev directly in `targetRepoRoot` (not an isolated worktree), so the local checkout is left on the last story's branch. The operator should `git checkout dev && git pull`, then mark the drained stories `done` in the sprint-status tracker and commit.
artifact: plugins/crew/docs/unattended-drain-runbook.md

## Notes

**Docs-only — do NOT write any code or tests.** Create exactly one new file, `plugins/crew/docs/unattended-drain-runbook.md`, with real, accurate prose covering all three ACs. The drain's invocation contract and tunables live in `plugins/crew/workflows/drain.workflow.js` (args header + the loop) — read it for ground truth. Do not modify any `.ts` file, the build output (`dist/`), the execution manifest, or any `.crew/state` file — the PR's diff must contain only the new `.md` file (this keeps it classified `low`-risk). No build step is needed for a docs-only change.
