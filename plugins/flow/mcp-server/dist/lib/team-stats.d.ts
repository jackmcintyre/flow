/**
 * Pure JSONL aggregator for telemetry fire counts (Story 2.6 / FR108 /
 * NFR28).
 *
 * This is the FIRST reader of the `.flow/telemetry/<YYYY-MM>.jsonl` files
 * written by `lib/logger.ts`. The writer/reader split is intentional:
 *  - Writer: `logger.ts` (via `logTelemetryEvent`). Appends, emits
 *    `telemetry.invalid` on Zod failure.
 *  - Reader: this file. Reads, counts, reports malformation back to the
 *    caller. NEVER writes; NEVER emits `telemetry.invalid`.
 *
 * v1 template for Epic 6's `computeOutcomeStats` and `computeAgreement`
 * helpers — keep small and single-purpose.
 */
export interface TeamTelemetryStats {
    /** Per-agent invocation counts from `agent.invoke` events. */
    fireCountsByAgent: Record<string, number>;
    /** Total count of lines that failed JSON.parse or Zod validation. */
    malformedLines: number;
    /** Count of files that contained at least one malformed line. */
    malformedFiles: number;
}
/**
 * Read and aggregate `agent.invoke` telemetry from
 * `<targetRepoRoot>/.flow/telemetry/*.jsonl`.
 *
 * - Absent telemetry directory → `{ fireCountsByAgent: {}, malformedLines: 0, malformedFiles: 0 }`.
 * - Each file whose name matches `^\d{4}-\d{2}\.jsonl$` is read and
 *   every non-empty line is validated via `TelemetryEventSchema`.
 * - Valid `agent.invoke` events increment `fireCountsByAgent[agent]`.
 * - Other valid event types (e.g. `telemetry.invalid`) are counted as
 *   valid — they do NOT increment `malformedLines`.
 * - Lines that fail JSON.parse or Zod increment `malformedLines`.
 * - `malformedFiles` counts files with ≥1 malformed line.
 *
 * No writes. No network IO. No `execa`. No clock dependency.
 */
export declare function readTeamTelemetryStats(opts: {
    targetRepoRoot: string;
}): Promise<TeamTelemetryStats>;
