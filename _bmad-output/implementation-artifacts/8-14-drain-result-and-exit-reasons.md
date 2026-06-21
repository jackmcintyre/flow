# Story 8.14: Reference for the drain result shape and exit reasons

story_shape: substrate
Status: ready-for-dev

## Story

As a **plugin operator**,
I want **a reference that explains what the drain reports when it finishes — the per-story outcome buckets and the run-level exit reason**,
So that **I can read a drain result and immediately tell whether the queue fully drained, whether anything paused for me, and whether anything was blocked**.

This is an Epic 8 dogfood story for the multi-story unattended drain: a docs-only, purely-additive change. It creates exactly one new Markdown file. No code, no tests, nothing else changed.

## Dependencies

- None. Leaf story: one new documentation file. Does not touch source, build output, or any `.crew/state` file.

## Acceptance Criteria

**AC1 — a reference doc exists for the drain's per-story outcome buckets:**

A new Markdown file exists at `plugins/crew/docs/drain-result-and-exit-reasons.md`. It documents the four buckets the drain reports — `completed`, `merged`, `pausedForHuman`, and `blocked` — and the no-silent-failures contract that every claimed story lands in exactly one of them. It explains the difference between `completed` (a green verdict) and `merged` (the auto-merge gate actually merged it) versus `pausedForHuman` (gate applied a `needs-human` label) and `blocked` (the story could not finish).
artifact: plugins/crew/docs/drain-result-and-exit-reasons.md

**AC2 — the doc documents the run-level exit reasons and the `drained` flag:**

The same file documents the `drainedReason` values the run reports: `queue-drained` (the queue emptied — a genuine full drain), `max-stories-reached` (the optional `maxStories` safety cap was hit), `waiting-on-in-progress`, and the claim/blocked failure reasons surfaced verbatim. It states that the boolean `drained` is `true` only when `drainedReason === 'queue-drained'`, so hitting the cap or stopping on an error is correctly reported as not-a-full-drain.
artifact: plugins/crew/docs/drain-result-and-exit-reasons.md

## Notes

**Docs-only — do NOT write any code or tests.** Create exactly one new file, `plugins/crew/docs/drain-result-and-exit-reasons.md`, with real, accurate prose covering both ACs. The return shape and exit reasons are defined at the bottom of `plugins/crew/workflows/drain.workflow.js` (the `return { ... }` object and the loop's `drainedReason` assignments) — read it for ground truth. Do not modify any `.ts` file, the build output (`dist/`), the execution manifest, or any `.crew/state` file — the PR's diff must contain only the new `.md` file (this keeps it classified `low`-risk). No build step is needed for a docs-only change.
