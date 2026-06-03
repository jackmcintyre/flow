/**
 * `summariseDrainResult` — Story 8.7.
 *
 * Renders the stateless drain's structured return object as a single
 * human-readable line, so that after a drain run an operator can see at a
 * glance what happened without parsing the raw object.
 *
 * Pure and deterministic — no I/O, no mutation of the input. A missing
 * (undefined) optional array is treated as empty (count `0`).
 */
/**
 * Render a drain result as a one-line summary.
 *
 * Form:
 *   `drain <sessionUlid>: <C> completed, <M> merged, <P> paused-for-human, <B> blocked (drainedReason: <drainedReason>)`
 *
 * where each count is the corresponding array's length (a missing array
 * counts as `0`).
 */
export function summariseDrainResult(result) {
    const completed = result.completed?.length ?? 0;
    const merged = result.merged?.length ?? 0;
    const pausedForHuman = result.pausedForHuman?.length ?? 0;
    const blocked = result.blocked?.length ?? 0;
    return `drain ${result.sessionUlid}: ${completed} completed, ${merged} merged, ${pausedForHuman} paused-for-human, ${blocked} blocked (drainedReason: ${result.drainedReason})`;
}
