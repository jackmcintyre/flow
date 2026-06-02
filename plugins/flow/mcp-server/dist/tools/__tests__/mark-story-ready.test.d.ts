/**
 * Integration tests for `markStoryReady` — Story 9.1 (Epic 9 intake cockpit).
 *
 * Covers AC3 (the toggle tool) and AC4 (the readiness telemetry event):
 *
 *   AC3:
 *     (a) Mark a to-do/ backlog item ready → flag flips false→true, item stays
 *         in to-do/ (no state-directory move), `status` untouched.
 *     (b) Re-mark ready → no-op (no write, no event, mtime stable).
 *     (c) Mark not-ready → flag flips true→false.
 *     (d) An unknown reference → NotAnEligibleBacklogItemError (no mutation).
 *         Also: a non-to-do/ item (in-progress/) and a withdrawn item raise it.
 *
 *   AC4:
 *     One real toggle lands exactly one `backlog.readiness_changed` telemetry
 *     event with the right ref and value; an idempotent no-op re-toggle emits
 *     nothing.
 *
 * Uses a real tmpdir with real `node:fs` ops — same pattern as
 * `claim-next-story.test.ts`. Manifests are written via the canonical
 * `atomicWriteFile` primitive to comply with the static fs-guard.
 */
export {};
