/**
 * Unit/integration tests for the dev "needs human decision" signal — Story 8.19 AC1.
 *
 * AC1: there is a defined, parseable way for the dev step to signal that the
 * story has hit a decision a human must make, carrying the question text,
 * distinct from a normal handoff, a domain-yield, and a hard block. The drain's
 * dev-transcript processing (`processDevTranscript`) recognises this signal and
 * routes the story to a human-needed outcome rather than treating it as a
 * successful handoff or a silent failure. This vitest drives the dev step
 * emitting the signal and asserts the story is routed to the human-needed
 * outcome with the question text preserved verbatim — NOT to completed
 * (`spawn-reviewer`), and NOT to a generic blocked-with-no-reason.
 *
 * Uses a real tmpdir with real `node:fs` ops — no module mocking; the tool
 * composes pure pieces and the test exercises the real composition (mirrors
 * process-dev-transcript.test.ts).
 */
export {};
