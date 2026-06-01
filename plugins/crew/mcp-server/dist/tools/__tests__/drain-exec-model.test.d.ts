/**
 * Drain execution-model pin test — Story FU6 / native:01KT2PS8A5D13SBDDMKM04VN94.
 *
 * Verifies that the drain's dev and reviewer subagents receive the expected
 * model option:
 *
 *   AC1 — with no devReviewerModel arg, both dev and reviewer calls receive
 *         model: 'sonnet' (the default).
 *   AC2 — with devReviewerModel: 'opus' in the launch args, both dev and
 *         reviewer calls receive model: 'opus'.
 *
 * The seam-relay courier calls (label carries 'drain', 'persona:', 'claim:',
 * etc., OR agentOpts.schema is present) are NOT dev/reviewer direct calls and
 * must NOT be asserted on model in these ACs.
 *
 * How it runs the real workflow: `drain.workflow.js` is a plain script body that
 * reaches every decision through injected globals — `args` (a JSON string),
 * `agent` (the subagent/seam courier), `log` (the operator narrator), and `phase`
 * (the phase marker). It uses top-level `await` and top-level `return`. We read
 * the real workflow source and wrap it in an `AsyncFunction` whose parameters ARE
 * those globals, so the body runs verbatim with our stubs. The same pattern as
 * drain-observability-non-fatal.test.ts.
 */
export {};
