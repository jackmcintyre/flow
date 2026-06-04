/**
 * `recordSkillInvoke` MCP tool — Story 6.8.
 *
 * The SINGLE write-path for the `skill.invoke` telemetry event. There is
 * exactly one place the event is shaped, regardless of which capture seam
 * triggers it (a plugin invocation hook on the preferred path, or an
 * instrumented SKILL.md first-step on the fallback path — see the story's
 * Implementation Notes). Both paths funnel through here so the event shape is
 * never duplicated.
 *
 * Behaviour:
 *   1. Validate the caller's `data` payload against `SkillInvokeDataSchema`
 *      (the closed-enum `data` block of `SkillInvokeEventSchema`). Closed
 *      enums on `skill_scope` / `invocation_source` mean an unknown value is
 *      REJECTED (`MalformedSkillInvokeInputError`), never coerced — the
 *      "no silent fallback" discipline (AC1).
 *   2. Emit EXACTLY ONE `skill.invoke` event via `logTelemetryEvent` (which
 *      stamps `ts` and appends one JSONL line). The base envelope carries
 *      `session_id`, `agent`, and optional `story_id`.
 *
 * Produces evidence (one telemetry line), never bookkeeping — it touches no
 * `.flow/state/**` manifest. Telemetry is append-only via the logger; this
 * tool never writes `.flow/telemetry` directly.
 *
 * Story 6.8 · Architecture: skill-calibration-loop.md.
 */

import { logTelemetryEvent } from "../lib/logger.js";
import { SkillInvokeEventSchema } from "../schemas/telemetry-events.js";
import { MalformedSkillInvokeInputError } from "../errors.js";

/**
 * The `data` block of a `skill.invoke` event, extracted from the canonical
 * `SkillInvokeEventSchema` so the write-path validates against exactly the
 * same closed-enum shape the union enforces (single source of truth — a drift
 * here would be a bug). `.strict()` is inherited from the source schema.
 */
const SkillInvokeDataSchema = SkillInvokeEventSchema.shape.data;

export interface RecordSkillInvokeOptions {
  /** Absolute path to the target repository root. */
  targetRepoRoot: string;
  /** Opaque caller-supplied session identifier (envelope `session_id`). */
  sessionUlid: string;
  /** Kebab-cased role label, or `user` for a user-slash-command (envelope `agent`). */
  agent: string;
  /** Optional story ref (`<adapter>:<source-id>`) when the skill fired inside a story flow. */
  storyId?: string;
  /** The `skill.invoke` data payload — validated against the closed-enum schema. */
  data: unknown;
  /**
   * Test seam: inject a clock for deterministic `ts` stamping. Production
   * callers do not pass this (the logger defaults to `new Date()`).
   */
  now?: () => Date;
}

/**
 * Record a single `skill.invoke` telemetry event.
 *
 * @returns `{ recorded: true }` once the event has been appended.
 *
 * @throws {MalformedSkillInvokeInputError} When `data` fails schema validation
 *   (missing field, or a closed-enum violation on `skill_scope` /
 *   `invocation_source`). No event is written in this case.
 * @throws {TelemetryEventInvalidError} When the assembled event fails the
 *   logger's union validation (structurally unreachable post-data-validation,
 *   but the logger is the final gate).
 */
export async function recordSkillInvoke(
  opts: RecordSkillInvokeOptions,
): Promise<{ recorded: true }> {
  const { targetRepoRoot, sessionUlid, agent, storyId, data, now } = opts;

  // Step 1: Validate the data payload at the Zod boundary (closed enums).
  const result = SkillInvokeDataSchema.safeParse(data);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const zodPath =
      firstIssue && firstIssue.path.length > 0
        ? firstIssue.path.join(".")
        : "<root>";
    const zodMessage = firstIssue?.message ?? "(no issue details)";
    throw new MalformedSkillInvokeInputError({ zodPath, zodMessage });
  }

  // Step 2: Emit exactly one skill.invoke event (logger stamps ts).
  await logTelemetryEvent({
    targetRepoRoot,
    now,
    event: {
      type: "skill.invoke",
      session_id: sessionUlid,
      agent,
      ...(storyId !== undefined ? { story_id: storyId } : {}),
      data: result.data,
    },
  });

  return { recorded: true };
}
