# Story 8.15: Isolate the reviewer-result file per story within a session

story_shape: substrate
Status: backlog

## Story

As a **plugin maintainer**,
I want **each story's reviewer verdict written to its own file within a drain session, instead of a single per-session file that later stories overwrite**,
So that **a multi-story drain can recover or re-process one story's verdict without it being clobbered by the next story, and a future parallel drain cannot corrupt verdicts across stories**.

This was surfaced by the first multi-story unattended drain (2026-05-30): all stories in a `crew-drain` run share one session ULID, and the reviewer verdict is stored at `.crew/state/sessions/<sessionUlid>/reviewer-result.json` — one file per session, not per story. When story 8.13's verdict seam failed, the verdict could not be re-processed because the next story (8.14) had already overwritten that file. Harmless in strictly-serial operation (each verdict is consumed immediately after it is written), but it makes failures unrecoverable and would corrupt verdicts outright under the deferred parallel multi-story drain.

## Dependencies

- None. Touches the reviewer-result write/read path only; no cross-story dependency.

## Acceptance Criteria

**AC1 — two stories in one session keep independent reviewer-result files (integration):**

Given a single session ULID and two distinct story refs, writing a reviewer result for ref A and then for ref B leaves ref A's result intact and independently readable — writing B does not overwrite or corrupt A. A vitest exercises the writer (`runReviewerSession`) and reader (`processReviewerTranscript`) end-to-end for two refs in one session and asserts that reading A after B still returns A's verdict.
vitest: plugins/crew/mcp-server/src/tools/__tests__/per-story-reviewer-result-isolation.test.ts

**AC2 — writer and reader agree on a per-ref, deterministic path:**

`runReviewerSession` writes the reviewer result to a path that is namespaced by the story ref within the session directory (e.g. a per-ref subdirectory or filename), and `processReviewerTranscript` reads from the same deterministically-derived path for the requested ref. The derivation safely handles refs that contain characters not valid in a single path segment (notably the colon in a BMad-style ref) by sanitising them into a path-safe component, and is covered by the test above.
vitest: plugins/crew/mcp-server/src/tools/__tests__/per-story-reviewer-result-isolation.test.ts

## Notes

The current single-file path is `.crew/state/sessions/<sessionUlid>/reviewer-result.json`. The writer is `plugins/crew/mcp-server/src/tools/run-reviewer-session.ts`; the reader is `plugins/crew/mcp-server/src/tools/process-reviewer-transcript.ts`. Pick a per-ref scheme (subdirectory `<sessionUlid>/<sanitised-ref>/reviewer-result.json` is the natural choice) and apply it in BOTH places — they must agree. Sanitise the colon in BMad refs (and any other path-unsafe characters) when deriving the path component. This is a code change: rebuild and commit `dist/` in the same change, and keep the diff scoped to the two tools + the new test. It is a `medium`-risk change (edits existing source) and is expected to pause the auto-merge gate for a human merge — that is correct.
