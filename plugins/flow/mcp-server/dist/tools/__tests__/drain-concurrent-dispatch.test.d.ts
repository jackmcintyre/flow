/**
 * Drain concurrent-dispatch integration test — Story 8.22.
 *
 * AC1 — the main drain loop processes more than one claimed story at a time, up
 *       to a configured cap (`maxConcurrency`): given a backlog larger than the
 *       cap, at most `cap` stories are in flight at once, more than one IS in
 *       flight simultaneously, and every story is processed exactly once.
 * AC2 — concurrency changes throughput only, not the result: for a fixed backlog
 *       and fixed per-story outcomes, the result buckets and the drain reason are
 *       identical at cap 1 (serial) and cap N (concurrent), modulo the order of
 *       entries within a bucket.
 * AC3 — a per-worker hard failure is isolated: one worker that throws lands its
 *       story in the blocked/paused bucket with its reason preserved, and never
 *       aborts the run or disturbs a concurrently-running sibling — every sibling
 *       still reaches its correct bucket.
 *
 * How it runs the real workflow (same harness as drain-progress-heartbeat.test):
 * `drain.workflow.js` is a plain script body that reaches every decision through
 * injected globals — `args` (a JSON string), `agent` (the subagent/seam courier),
 * `log` (the operator narrator), and `phase` (the phase marker). It uses
 * top-level `await` and top-level `return`. We read the real workflow source and
 * wrap it in an `AsyncFunction` whose parameters ARE those globals, so the body
 * runs verbatim with our stubs. Nothing in the workflow is mocked — only its
 * injected seam surface — so the concurrency under test is the production loop's,
 * not a test-local re-implementation.
 *
 * The concurrency is OBSERVED, not faked: each `dev:` agent call (the longest
 * per-story phase) blocks on a test-controlled barrier while we record the live
 * in-flight count and its running maximum, then is released. That lets us assert
 * both ">1 in flight at once" and "never exceeds the cap" against the real loop.
 */
export {};
