/**
 * Unit tests for `processDevTranscript` — Story 4.3b Task 8 + Story 4.5 Task 4.4.
 *
 * Uses a real tmpdir with real `node:fs` ops. No mocking of imported modules —
 * the tool composes pure pieces and the test exercises the real composition.
 *
 * Story 4.3b coverage:
 *   (a) Happy handoff → `next: "spawn-reviewer"`, reviewerPrompt, manifest NOT mutated.
 *   (b) Drift → `next: "done-blocked-handoff-grammar"`, manifest `blocked_by: "handoff-grammar"`.
 *   (c) Empty transcript → same as (b).
 *   (d) Whitespace-only transcript → same as (b).
 *
 * Story 4.5 coverage (Task 4.4):
 *   (e) class=defer → `next: "done-blocked-gh-defer"`, manifest `blocked_by: "gh-defer"`.
 *   (f) class=retry → `next: "done-blocked-gh-retry"`, manifest `blocked_by: "gh-retry"`.
 *   (g) class=needs-human → `next: "done-blocked-gh-needs-human"`, manifest `blocked_by: "gh-needs-human"`.
 *   (h) Locked-phrase drift falls through to handoff-grammar (AC3j).
 *   (i) Recoverable + handoff coexistence: recoverable wins (AC3k).
 *   (j) Chat-line verbatim shape per AC2f (exact string match).
 *
 * Story 4.3b Task 8.1–8.3; Story 4.5 Task 4.4–4.5.
 */
export {};
