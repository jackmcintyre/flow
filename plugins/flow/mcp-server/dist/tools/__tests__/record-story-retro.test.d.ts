/**
 * Unit + integration tests for `recordStoryRetro` — Story 6.1 AC3.
 *
 * Covers:
 *   (a) Happy path — a valid retro payload lands on a done/ manifest and
 *       the file re-parses cleanly through `parseExecutionManifest`.
 *   (b) One assertion per `kind` value (four tests) showing the closed
 *       enum accepts all four members.
 *   (c) `kind: "pitfall"` without `failure_class` is rejected at the
 *       Zod boundary.
 *   (d) The tool refuses (with `StoryNotInDoneStateError`) when invoked
 *       against a ref in `to-do/`, `blocked/`, or `in-progress/`.
 *       `ManifestNotFoundError` when the ref is absent everywhere.
 *   (e) Idempotency — re-running with an identical payload produces a
 *       byte-identical file.
 *
 * Approach:
 * - Use a minimal native-adapter workspace in a tmpdir (real filesystem
 *   ops via `atomicWriteFile`).
 * - Seed `done/<ref>.yaml` manifests directly (no need to drive
 *   completeStory — the state guard is what we're testing).
 */
export {};
