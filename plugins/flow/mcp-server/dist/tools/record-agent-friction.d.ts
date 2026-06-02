/**
 * `recordAgentFriction` MCP tool — Story native:01KT2RAXBSQ91Y80Z51DD26KPX.
 *
 * Persists a structured `agent.friction` telemetry event when an agent
 * compensates for a surprising or broken input. This is the write-path for the
 * recurring-friction signal the retro-analyst reads at cycle end via
 * `gatherRetroInputs`'s `recurringFriction` field.
 *
 * The only write surface is `logTelemetryEvent` — the same path used by every
 * other telemetry event in the system. No new write paths.
 *
 * Behaviour:
 *   1. Validate opts via Zod (closed `kind` enum, min(1) strings).
 *   2. Construct an `agent.friction` event with all structured fields.
 *   3. Persist via `logTelemetryEvent` (appends to the cycle's JSONL file).
 *   4. Return a lightweight confirmation `{ ok: true, kind, agent, session_id }`.
 *
 * **Why structured, not free-prose?**
 * Free-prose friction notes inside transcripts rot silently — they are never
 * read by the retro loop. A structured `kind` field lets `gatherRetroInputs`
 * group friction by kind, count recurrences, and promote the signal into the
 * retro proposal bundle. A broken seam that agents are silently compensating
 * for only surfaces if the signal is machine-readable.
 */
import { z } from "zod";
/** Closed enum of recognised agent friction categories (mirrors the Zod schema). */
export declare const FRICTION_KINDS: readonly ["empty-input", "missing-cited-source", "forced-fallback", "repeated-retry"];
export type FrictionKind = (typeof FRICTION_KINDS)[number];
declare const RecordAgentFrictionOptionsSchema: z.ZodObject<{
    targetRepoRoot: z.ZodString;
    agent: z.ZodString;
    story_id: z.ZodOptional<z.ZodString>;
    session_id: z.ZodString;
    kind: z.ZodEnum<{
        "empty-input": "empty-input";
        "forced-fallback": "forced-fallback";
        "missing-cited-source": "missing-cited-source";
        "repeated-retry": "repeated-retry";
    }>;
    expected: z.ZodString;
    observed: z.ZodString;
    role: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type RecordAgentFrictionOptions = z.infer<typeof RecordAgentFrictionOptionsSchema>;
export interface RecordAgentFrictionResult {
    ok: true;
    kind: FrictionKind;
    agent: string;
    session_id: string;
}
/**
 * Persist a structured `agent.friction` telemetry event.
 *
 * @returns `{ ok: true, kind, agent, session_id }` — lightweight confirmation.
 * @throws {z.ZodError} When `opts` fails schema validation.
 * @throws {TelemetryEventInvalidError} When the constructed event fails its
 *   own Zod schema (defensive — should be unreachable given validated opts).
 */
export declare function recordAgentFriction(opts: RecordAgentFrictionOptions): Promise<RecordAgentFrictionResult>;
export {};
