/**
 * `openCycle` MCP tool — Story native:01KT484NY4HCBPBTT6VEY1Q0CS.
 *
 * Opens a new work cycle. Each cycle is identified by a ULID and has an
 * `opened_at` timestamp that the retro gathers against — done manifests and
 * telemetry events from BEFORE `opened_at` are excluded from the retro's input
 * bundle, so each retrospective reasons only over work completed in the current
 * cycle.
 *
 * Behaviour:
 *  1. Read the current cycle-state file (`.flow/cycle-state.json`).
 *  2. If a prior cycle is active, archive it first:
 *       - Gather the prior cycle's done-manifest refs and retro-proposal paths.
 *       - Build a brief telemetry summary (event count for the prior window).
 *       - Write a YAML archive record to
 *         `.flow/cycle-archive/<prior-cycle-id>-<iso>.yaml`.
 *  3. Mint a new cycle ULID and record `opened_at = now`.
 *  4. Write the new cycle state to `.flow/cycle-state.json` via `atomicWriteFile`
 *     (the canonical write seam for non-state-machine files).
 *  5. Emit a `cycle.opened` telemetry event.
 *  6. Return `{ ok: true, cycleId, openedAt, archivedPriorCycleId }`.
 *
 * Idempotency note: re-opening a cycle (calling again immediately) creates a
 * brand-new cycle ULID each time — there is no idempotency key.  The operator
 * is responsible for not opening unnecessary cycles.
 *
 * **Writes route through `atomicWriteFile`** (from `lib/managed-fs.ts`) rather
 * than raw fs write/rename APIs so the canonical-fs write guard
 * (tests/canonical-fs-guard.test.ts) stays green.
 */
export interface OpenCycleOptions {
    /** Absolute path to the target repository root. */
    targetRepoRoot: string;
    /** Caller's session ULID — stamped into the telemetry event. */
    sessionUlid: string;
    /** Optional clock override — test seam for deterministic timestamps. */
    now?: () => Date;
}
export interface OpenCycleResult {
    ok: true;
    /** The newly-minted cycle ULID. */
    cycleId: string;
    /** ISO-8601 UTC timestamp at which the cycle was opened. */
    openedAt: string;
    /**
     * The prior cycle's ULID if one was active and has been archived,
     * or `null` when this is the first cycle ever.
     */
    archivedPriorCycleId: string | null;
}
/**
 * Open a new work cycle.
 *
 * @throws When the archive write fails or the telemetry event cannot be logged.
 */
export declare function openCycle(opts: OpenCycleOptions): Promise<OpenCycleResult>;
