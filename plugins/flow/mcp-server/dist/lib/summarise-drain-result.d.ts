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
/** The structured return shape of a stateless drain run. */
export interface DrainResult {
    sessionUlid: string;
    drainedReason: string;
    completed?: string[];
    merged?: Array<{
        ref: string;
        prNumber: number;
    }>;
    pausedForHuman?: Array<{
        ref: string;
        prNumber: number;
        reason: string;
    }>;
    blocked?: Array<{
        ref: string;
        blocked_by: string;
    }>;
}
/**
 * Render a drain result as a one-line summary.
 *
 * Form:
 *   `drain <sessionUlid>: <C> completed, <M> merged, <P> paused-for-human, <B> blocked (drainedReason: <drainedReason>)`
 *
 * where each count is the corresponding array's length (a missing array
 * counts as `0`).
 */
export declare function summariseDrainResult(result: DrainResult): string;
