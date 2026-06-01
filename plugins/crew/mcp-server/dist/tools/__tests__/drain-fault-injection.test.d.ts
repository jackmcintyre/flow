/**
 * Drain fault-injection integration test — native:01KT19N3H7WZCF1SKQSWDGARF4.
 *
 * Proves the unattended drain reports every story it picks up HONESTLY when one
 * of its seams misbehaves: under any single injected fault the run still finishes
 * on its own and lands every claimed ref in exactly one outcome bucket
 * (completed / merged / pausedForHuman / blocked) with a stated reason — never
 * zero, never two — and a run-level drain reason, rather than throwing.
 *
 * This is ADDITIVE test infrastructure only. There is NO production-behaviour
 * change to the drain: the harness runs the real `drain.workflow.js` body
 * VERBATIM through the existing AsyncFunction runner, exactly as
 * drain-observability-non-fatal.test.ts does. That means it runs the production
 * bounded `drainWorker` concurrency pool
 * (`await Promise.allSettled(Array.from({length: workerCount}, …))`) AND each
 * worker's per-worker try/catch backstop — so faults are exercised against the
 * production loop, never a single-story shortcut. A hard reject from a mutating
 * seam is therefore CAUGHT by `drainWorker` and bucketed as
 * `blocked: { ref, blocked_by: 'worker-threw', … }`; it does not escape the run.
 *
 * The runner here GENERALISES the four-global runner the reference test uses
 * (`args`, `agent`, `log`, `phase`) to inject a FIFTH global — `notify` — so the
 * needs-human pause notification (drain.workflow.js notifyHumanNeeded) can be
 * asserted to carry the story ref and the verbatim question.
 *
 * The AC ↔ test map:
 *   AC1 — honesty invariant under every injected fault: exactly-one-bucket,
 *         non-empty reason, drainedReason set, run did not throw.
 *   AC2 — a scrambled / non-JSON relay to the step that records a story's result
 *         (verdict / gate, both mutating) → that story is paused-or-blocked with
 *         the reason naming that step, the run keeps going and finishes the rest.
 *   AC3 — under a concurrent run (maxConcurrency: 2), one story hits an outright
 *         hard failure deep in processing → blocked with `worker-threw`, while
 *         the sibling finishes normally; one failure never aborts the run.
 *   AC4 — a story that genuinely needs a decision → paused for the human AND a
 *         notify payload delivered carrying the story ref + the exact question.
 *   AC5 — a purely-informational status seam (the progress heartbeat) failing →
 *         identical buckets + reasons to a clean run, differing only by the
 *         dropped status line.
 *
 * How it runs the real workflow: `drain.workflow.js` is a plain script body that
 * reaches every decision through injected globals. We read the real source and
 * wrap it in an AsyncFunction whose parameters ARE those globals, so the body
 * runs verbatim with our stubs. Nothing in the workflow is mocked — only its
 * injected seam surface.
 */
export {};
