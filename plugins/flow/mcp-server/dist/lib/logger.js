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
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { TelemetryEventInvalidError } from "../errors.js";
import { TelemetryEventSchema, TelemetryInvalidEventSchema, } from "../schemas/telemetry-events.js";
function toIsoMillisUtc(d) {
    // Date#toISOString() always produces ms-precise UTC ending in `Z`.
    return d.toISOString();
}
function monthBucket(ts) {
    const month = ts.slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) {
        // Defensive — should be unreachable post-schema-validation.
        throw new Error(`Telemetry: invalid month bucket derived from ts='${ts}'.`);
    }
    return month;
}
async function appendJsonlLine(targetRepoRoot, ts, validated) {
    const month = monthBucket(ts);
    const filePath = path.join(targetRepoRoot, ".flow", "telemetry", `${month}.jsonl`);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, JSON.stringify(validated) + "\n", "utf8");
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
export async function logTelemetryEvent(opts) {
    const { targetRepoRoot, event } = opts;
    const now = opts.now ?? (() => new Date());
    const stamped = {
        ...event,
        ts: event.ts ?? toIsoMillisUtc(now()),
    };
    const result = TelemetryEventSchema.safeParse(stamped);
    if (result.success) {
        await appendJsonlLine(targetRepoRoot, stamped.ts, result.data);
        return;
    }
    const firstIssue = result.error.issues[0];
    const zodPath = firstIssue && firstIssue.path.length > 0 ? firstIssue.path.join(".") : "<root>";
    const zodMessage = firstIssue?.message ?? "(no issue details)";
    const attemptedType = String(stamped.type ?? "<missing>");
    const failureEvent = TelemetryInvalidEventSchema.parse({
        ts: stamped.ts,
        type: "telemetry.invalid",
        session_id: stamped.session_id,
        agent: stamped.agent,
        ...(stamped.story_id !== undefined ? { story_id: stamped.story_id } : {}),
        data: {
            attempted_type: attemptedType,
            zod_path: zodPath,
            zod_message: zodMessage,
        },
    });
    await appendJsonlLine(targetRepoRoot, stamped.ts, failureEvent);
    throw new TelemetryEventInvalidError({
        attemptedType,
        zodPath,
        zodMessage,
    });
}
