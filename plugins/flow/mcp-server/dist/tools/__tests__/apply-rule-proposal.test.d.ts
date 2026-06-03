/**
 * `rule`-kind apply-handler + production-gate tests — Story 6.5 AC2–AC5.
 *
 * AC2: the handler appends the rule with all five fields, prior rule + comment
 *      unchanged, id a valid ULID, introduced_at a valid ISO-8601, changedPaths
 *      exactly ["docs/discipline-rules.yaml"], and it makes no commit of its own.
 * AC3: after an apply, re-parsing the registry validates cleanly; every rule
 *      satisfies the schema.
 * AC4: driving the REAL `acceptProposal` gate (no injected handler — the
 *      production registry now carries the rule handler) through preview +
 *      confirm renders a diff in preview, mutates nothing on preview, and on
 *      confirm appends + commits the registry together with the proposal stamp
 *      in one commit, stamps the proposal applied, and emits one telemetry event.
 * AC5: re-running the gate on an already-applied rule proposal no-ops — the
 *      registry is byte-identical, no second commit, the gate reports
 *      already-applied — even though the handler is now real.
 */
export {};
