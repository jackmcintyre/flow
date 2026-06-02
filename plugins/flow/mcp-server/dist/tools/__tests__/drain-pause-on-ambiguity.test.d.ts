/**
 * Drain pause-on-ambiguity integration test — Story 8.19 AC2 + AC3.
 *
 * AC2: a story paused for a human decision lands in the human-needed result
 *      bucket (pausedForHuman) carrying its question text and ref; the dev does
 *      NOT open a PR or guess an implementation for it; and the drain continues
 *      to the next claimable story rather than halting the whole run. This drain
 *      integration test (seams stubbed) drives one ambiguous story and one
 *      normal story and asserts the ambiguous one appears in the human-needed
 *      bucket with its question and the normal one still completes.
 *
 * AC3: when a story pauses for a human decision, the drain emits an operator
 *      notification naming the ref and the question through the notification
 *      seam the run supports. The test injects a notifier seam and asserts a
 *      notification carrying the ref and question is emitted when a story pauses,
 *      and that NO notification is emitted for a story that completes normally.
 *
 * Harness shape (mirrors drain-progress-heartbeat.test.ts): `drain.workflow.js`
 * is a plain script body that reaches every decision through injected globals.
 * We read the real workflow source and wrap it in an `AsyncFunction` whose
 * parameters ARE those globals, so the body runs verbatim against our stubs.
 * Nothing in the workflow is mocked — only its injected seam surface. We
 * additionally inject a `notify` global (the notification seam the run supports)
 * and capture every notification it receives.
 */
export {};
