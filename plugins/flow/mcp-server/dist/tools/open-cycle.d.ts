/**
 * `openCycle` MCP/CLI tool — Story native:01KT484NY4HCBPBTT6VEY1Q0CS
 * (the cycle-boundary work deferred by Story 6.12).
 *
 * Opens a new work cycle: mints a fresh cycle ULID, archives the prior cycle's
 * record (if a cycle was active) BEFORE the active window resets, overwrites the
 * cycle-state file with the new cycle, and emits one `cycle.opened` telemetry
 * event. After this returns:
 *
 *   - `getStatus` reports the new cycle ULID instead of `"none"` (AC1).
 *   - `gatherRetroInputs` scopes its bundle to work completed at or after the
 *     new cycle's `opened_at` (AC2).
 *   - the prior cycle's done manifests, retro proposals, and a telemetry summary
 *     are preserved in `.flow/cycle-archive/<prior-ulid>-<iso>.yaml` (AC3) —
 *     history is not discarded.
 *
 * The cycle-state file lives at `.flow/cycle-state.json` and the archive under
 * `.flow/cycle-archive/` — both OUTSIDE `.flow/state/`, so the scanner never
 * mistakes them for execution manifests.
 *
 * **Ordering is load-bearing:** the prior cycle is archived FIRST (while
 * `cycle-state.json` still names it, so `gatherRetroInputs` windows correctly),
 * and only then is `cycle-state.json` overwritten. A crash between the two
 * leaves the archive written and the old cycle still active — re-running
 * `openCycle` simply archives again (idempotent in effect; the archive filename
 * carries a fresh ISO so a re-run writes a sibling rather than clobbering).
 */
export interface OpenCycleOptions {
    /** Absolute path to the target repository root. */
    targetRepoRoot: string;
    /**
     * Session ULID stamped onto the `cycle.opened` telemetry event's
     * `session_id`. Optional — when absent the new cycle ULID is reused so the
     * event is always well-formed (`session_id` requires min-1 length).
     */
    sessionUlid?: string;
    /**
     * Clock seam. Defaults to `() => new Date()`. Injected by tests for a
     * deterministic `opened_at` / archive filename.
     */
    now?: () => Date;
}
export interface OpenCycleResult {
    /** The freshly-minted, now-active cycle ULID. */
    cycleUlid: string;
    /** ISO-8601 UTC instant the cycle was opened (the window boundary). */
    openedAt: string;
    /** The cycle that was active before this open, or `null` on the first open. */
    priorCycleUlid: string | null;
    /**
     * Absolute path to the prior cycle's archive file, or `null` when there was
     * no prior cycle to archive (the first open).
     */
    archivePath: string | null;
}
/**
 * Open a new work cycle. See module JSDoc for full behaviour.
 *
 * @returns `{ cycleUlid, openedAt, priorCycleUlid, archivePath }`.
 */
export declare function openCycle(opts: OpenCycleOptions): Promise<OpenCycleResult>;
