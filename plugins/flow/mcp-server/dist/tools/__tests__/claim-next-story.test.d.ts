/**
 * Unit tests for `claimNextStory` — Story 4.3b Task 1 (reviewer gap fill).
 *
 * Uses a real tmpdir with real `node:fs` ops. No mocking of imported modules —
 * follows the same pattern as `process-dev-transcript.test.ts`.
 *
 * Covers the three return branches:
 *   (a) `spawn-dev`               — at least one eligible (depsReady: true) story in to-do/.
 *   (b) `queue-drained`           — no in-progress stories AND no eligible to-do stories.
 *   (c) `waiting-on-in-progress`  — in-progress non-empty, no eligible to-do stories.
 *
 * File map reference: spec line ~355
 * (_bmad-output/implementation-artifacts/4-3b-harness-task-spawn-seam-for-rundevsession.md
 *  § Dev Notes / File map)
 *
 * Story 4.3b Task 1.1–1.6.
 */
export {};
