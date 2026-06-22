/**
 * Fail-soft story-blocked emitter — Story native:01KVP72SR857S3RY7CMQ8E2BK6 (AC2).
 *
 * A thin wrapper around `logTelemetryEvent` that writes a `story.blocked` event
 * and swallows (and logs to stderr) any error so a telemetry write failure can
 * NEVER change a verdict, re-break a run, or alter a thrown error.
 *
 * The trap this closes: `logTelemetryEvent` validates the event against the
 * CLOSED discriminated union in `TelemetryEventSchema`. If `"story.blocked"`
 * were not registered in that union, the schema-validation error would be
 * swallowed here and no event would be written — the project's exact anti-goal.
 * The AC2 integration test asserts the event PERSISTS (reads back from the JSONL
 * file), not merely that emit was attempted, so a missing registration fails the
 * test loudly rather than silently no-ops.
 *
 * Mirrors the `emitFriction` pattern in `lib/emit-friction.ts`.
 */

import { logTelemetryEvent } from "./logger.js";

export interface EmitStoryBlockedOpts {
  /** Absolute path to the target repo root — forwarded to logTelemetryEvent. */
  targetRepoRoot: string;
  /** Story reference (`<adapter>:<source-id>`). */
  ref: string;
  /** One-word closed-enum blocked_by reason (e.g. `"worker-threw"`). */
  blockedBy: string;
  /** Human-readable error detail captured at the throw point (max 500 chars). */
  blockDetail: string;
  /** Run-session ULID. */
  sessionUlid: string;
  /** Role name of the emitting agent (kebab-cased). */
  agent: string;
}

/**
 * Emit one `story.blocked` telemetry event; swallow any error so this call
 * can never alter control flow. Logs the suppressed error to stderr for
 * diagnosability without surfacing it to the caller.
 */
export async function emitStoryBlocked(opts: EmitStoryBlockedOpts): Promise<void> {
  try {
    await logTelemetryEvent({
      targetRepoRoot: opts.targetRepoRoot,
      event: {
        type: "story.blocked",
        session_id: opts.sessionUlid,
        agent: opts.agent,
        story_id: opts.ref,
        data: {
          ref: opts.ref,
          blocked_by: opts.blockedBy,
          // Truncate to 500 chars to stay within NFR14's spirit (no long
          // body/diff/contents strings in telemetry).
          block_detail: opts.blockDetail.slice(0, 500),
        },
      },
    });
  } catch (err) {
    // Telemetry failure is non-fatal. Log to stderr for diagnosability.
    process.stderr.write(
      `[emitStoryBlocked] suppressed error emitting story.blocked (ref=${opts.ref}): ${String(err)}\n`,
    );
  }
}
