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
import { logTelemetryEvent } from "../lib/logger.js";

/** Closed enum of recognised agent friction categories (mirrors the Zod schema). */
const FRICTION_KINDS = [
  "empty-input",
  "missing-cited-source",
  "forced-fallback",
  "repeated-retry",
] as const;

export type FrictionKind = (typeof FRICTION_KINDS)[number];

const RecordAgentFrictionOptionsSchema = z
  .object({
    /** Absolute path to the target repository root. */
    targetRepoRoot: z.string().min(1),
    /** Role name of the agent experiencing the friction (kebab-cased). */
    agent: z
      .string()
      .min(1)
      .regex(/^[a-z0-9-]+$/),
    /**
     * Optional story ref (`<adapter>:<source-id>`) when friction occurred
     * inside a story flow.
     */
    story_id: z.string().min(1).optional(),
    /** Run-session ULID (or any opaque caller-supplied identifier). */
    session_id: z.string().min(1),
    /** The closed-enum friction category. */
    kind: z.enum([
      "empty-input",
      "missing-cited-source",
      "forced-fallback",
      "repeated-retry",
    ]),
    /** What the agent expected to receive. Keep short and structural (NFR14). */
    expected: z.string().min(1),
    /** What the agent actually received / had to compensate for (NFR14). */
    observed: z.string().min(1),
    /**
     * Optional role label for downstream correlation. Defaults to the
     * value of `agent` when omitted (they are the same in most callers).
     */
    role: z.string().optional(),
  })
  .strict();

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
export async function recordAgentFriction(
  opts: RecordAgentFrictionOptions,
): Promise<RecordAgentFrictionResult> {
  // Step 1: Validate at the Zod boundary (throws ZodError on failure).
  const validated = RecordAgentFrictionOptionsSchema.parse(opts);

  const {
    targetRepoRoot,
    agent,
    story_id,
    session_id,
    kind,
    expected,
    observed,
  } = validated;

  // Step 2 + 3: Construct the event and persist via the single telemetry write path.
  await logTelemetryEvent({
    targetRepoRoot,
    event: {
      type: "agent.friction",
      session_id,
      agent,
      ...(story_id !== undefined ? { story_id } : {}),
      data: { kind, expected, observed },
    },
  });

  // Step 4: Return lightweight confirmation.
  return { ok: true, kind, agent, session_id };
}
