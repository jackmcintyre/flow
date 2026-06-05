/**
 * Fail-soft friction emitter — Story native:01KTAP1N6DEF181646EW3RJH8W.
 *
 * A thin wrapper around `recordAgentFriction` that swallows (and logs) any
 * error so a telemetry write failure can NEVER change a verdict, block a merge,
 * or alter a thrown error.
 *
 * Usage:
 *   await emitFriction({ targetRepoRoot, kind: "empty-input", role: "generalist-reviewer", ... });
 *
 * Mirrors the fail-soft telemetry pattern already used for yield.handoff in
 * process-reviewer-yield.ts (lines 176-197).
 */

import { recordAgentFriction } from "../tools/record-agent-friction.js";

export interface EmitFrictionOpts {
  /** Absolute path to the target repo root — forwarded to recordAgentFriction. */
  targetRepoRoot: string;
  /** Closed-enum friction kind. */
  kind: "empty-input" | "missing-cited-source" | "forced-fallback" | "repeated-retry";
  /** Role name of the agent experiencing the friction (kebab-cased). */
  role: string;
  /** Drain-session ULID. */
  session_id: string;
  /** Story ref (e.g. "native:01HZ..."). */
  story_id: string;
  /** What the agent expected to receive — short structural description. */
  expected: string;
  /** What the agent actually received / had to compensate for. */
  observed: string;
}

/**
 * Emit one `agent.friction` telemetry event; swallow any error so this call
 * can never alter control flow. Logs the suppressed error to stderr for
 * diagnosability without surfacing it to the caller.
 */
export async function emitFriction(opts: EmitFrictionOpts): Promise<void> {
  try {
    await recordAgentFriction({
      targetRepoRoot: opts.targetRepoRoot,
      agent: opts.role,
      role: opts.role,
      session_id: opts.session_id,
      story_id: opts.story_id,
      kind: opts.kind,
      expected: opts.expected,
      observed: opts.observed,
    });
  } catch (err) {
    // Telemetry failure is non-fatal. Log to stderr for diagnosability.
    process.stderr.write(
      `[emitFriction] suppressed error emitting agent.friction (kind=${opts.kind}): ${String(err)}\n`,
    );
  }
}
