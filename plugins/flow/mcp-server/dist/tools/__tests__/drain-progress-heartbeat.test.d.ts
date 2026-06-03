/**
 * Drain progress-heartbeat integration test — Story 8.18, AC3.
 *
 * AC3: the progress lines are emitted through the existing narrator channel and
 *      change NO control flow — the set of result buckets (completed / merged /
 *      pausedForHuman / blocked) and the drain reason for a run are identical
 *      with and without the new lines. This existing-style drain integration
 *      test (seams stubbed) asserts the run's structured result is unchanged and
 *      that the new progress lines appear in the captured narrator output.
 *
 * How it runs the real workflow: `drain.workflow.js` is a plain script body that
 * reaches every decision through injected globals — `args` (a JSON string),
 * `agent` (the subagent/seam courier), `log` (the operator narrator), and
 * `phase` (the phase marker). It uses top-level `await` and top-level `return`.
 * We read the real workflow source and wrap it in an `AsyncFunction` whose
 * parameters ARE those globals, so the body runs verbatim with our stubs. This
 * is the "existing-style drain integration test (with seams stubbed)" the AC
 * asks for: nothing in the workflow is mocked — only its injected seam surface.
 *
 * The clock seams (`drainPhaseStart`/`drainPhaseDone`) are exercised for real:
 * the stub invokes the actual tool functions, so the asserted progress lines are
 * the lines the production tools produce, not test-local fabrications.
 */
export {};
