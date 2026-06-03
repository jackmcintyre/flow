/**
 * Cycle-boundary tests — Story native:01KT484NY4HCBPBTT6VEY1Q0CS.
 *
 * Covers all four ACs from the execution manifest:
 *
 *   AC1 — After openCycle, getStatus reports the cycle ULID (not 'none').
 *   AC2 — gatherRetroInputs includes only done manifests / telemetry events
 *          that fall on or after the cycle's opened_at timestamp.
 *   AC3 — When a prior cycle is active, openCycle archives it to
 *          .flow/cycle-archive/<prior-cycle-id>-<iso>.yaml before activating
 *          the new one.
 *   AC4 — When no cycle has ever been opened, getStatus reports 'none' and
 *          gatherRetroInputs returns all available history (baseline behaviour).
 *
 * No LLM invocation, no network, no snapshot.  Every test seeds a tmpdir
 * and cleans up on exit.
 */
export {};
