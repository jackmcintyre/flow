/**
 * Telemetry logger — the ONLY write path for structured JSONL
 * telemetry events under `<targetRepoRoot>/.flow/telemetry/<YYYY-MM>.jsonl`.
 *
 * Whitelisted in `tests/canonical-fs-guard.test.ts` to import a
 * write-shaped `node:fs` API. Every other code path that wants to
 * record an observable event MUST call `logTelemetryEvent`.
 *
 * **Why `fs.appendFile` rather than a logging library?**
 * This path emits a handful of events per story execution — throughput
 * is not the bottleneck. Using `fs.appendFile` directly:
 *   - keeps the writer synchronous-on-flush (a crash before flush
 *     doesn't lose events),
 *   - avoids a worker-thread + buffering dependency,
 *   - keeps the month-rollover code path one function long.
 * (`pino` was declared speculatively for a future SonicBoom swap that
 * never landed; removed in the 2026-05-30 de-cruft pass. A later story
 * can re-add it as a writer-only change without touching callers.)
 *
 * No module-level state — no cached handles, no in-memory queue, no
 * rollover registry. Each call resolves the month, ensures the
 * directory, appends, and returns.
 */
import { type TelemetryEvent } from "../schemas/telemetry-events.js";
/**
 * The caller's event minus `ts` — the logger stamps `ts` if absent.
 * If the caller supplies `ts`, the logger validates it as part of the
 * schema check and writes it verbatim (test seam for deterministic
 * round-trips).
 */
export type LogTelemetryEventInput = Omit<TelemetryEvent, "ts"> & {
    ts?: string;
};
export interface LogTelemetryEventOpts {
    targetRepoRoot: string;
    event: LogTelemetryEventInput;
    now?: () => Date;
}
/**
 * Single entrypoint for writing a structured telemetry event. Stamps
 * `ts` if absent, validates the event against its `type`-specific
 * schema, and appends a single JSON-encoded line (terminated by `\n`)
 * to the current month's JSONL file.
 *
 * On Zod failure, the original event is NOT written; a
 * `telemetry.invalid` failure event is written in its place AND a
 * `TelemetryEventInvalidError` is thrown (NFR6).
 */
export declare function logTelemetryEvent(opts: LogTelemetryEventOpts): Promise<void>;
