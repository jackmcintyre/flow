/**
 * Drain observability-seam non-fatal integration test — Story 8.21.
 *
 * Story 8.18 added the progress heartbeat: a start line and an elapsed done line
 * bracketing each major per-story phase (dev-build, review, gate), emitted through
 * the same one-shot subagent courier the load-bearing steps use. The 8.18 wrappers
 * already degrade gracefully on a *garbled* (non-JSON) relay — they fall back to no
 * line — but neither the wrappers nor `processStory` caught a *hard rejection* from
 * the underlying courier call, and `processStory` is awaited with no surrounding
 * guard. So a hard failure on one of the six observability calls per story would
 * propagate and abort the entire drain — the opposite of what an observability-only
 * feature should be able to do.
 *
 * Story 8.21 makes the read-only / observability seams swallow their own hard
 * rejection (degrade to no line, exactly like the garble path), while keeping the
 * mutating seams (claim / verdict / gate) fail-loud so a real failure still pauses
 * or blocks that one story with no silent success.
 *
 *   AC1 — an observability seam that hard-fails (throws) does not propagate; the
 *         story proceeds to its normal outcome bucket.
 *   AC2 — a run where EVERY progress seam throws produces an IDENTICAL structured
 *         result (buckets + drain reason) to a run where they succeed, differing
 *         only in the absence of the progress lines (strengthening 8.18's
 *         equivalence guarantee from garble-only to hard-failure).
 *   AC3 — the swallow-guard is scoped to observability seams only: a load-bearing
 *         MUTATING step that hard-fails still surfaces — the story lands in a
 *         blocked outcome carrying the failure reason, never silently swallowed or
 *         treated as a success.
 *
 * How it runs the real workflow: `drain.workflow.js` is a plain script body that
 * reaches every decision through injected globals — `args` (a JSON string),
 * `agent` (the subagent/seam courier), `log` (the operator narrator), and `phase`
 * (the phase marker). It uses top-level `await` and top-level `return`. We read
 * the real workflow source and wrap it in an `AsyncFunction` whose parameters ARE
 * those globals, so the body runs verbatim with our stubs. Nothing in the workflow
 * is mocked — only its injected seam surface. The progress seams run the REAL
 * drain-phase tools so the asserted lines are the production lines.
 */
export {};
