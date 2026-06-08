/**
 * `adjudicateQualityLead` MCP tool — Story 9.4 (Quality Lead, gate 1 adjudication).
 *
 * The adjudication half of gate 1. Story 9.3's judge panel emits a `PanelVerdict`
 * (the five lens results); the Quality Lead reads it, applies the rubric §5
 * synthesis rule, and decides `ready` / `rework` / `escalate`:
 *
 *   - all five lenses pass                         → `ready`   (bless the draft)
 *   - any lens fails                               → `rework`  (return the misses)
 *   - a split that persists after K rounds (def 2) → `escalate` (to the operator)
 *
 * **The deterministic seam (the key reuse).** The decision reduces to a pure
 * function over the `PanelVerdict` (`synthesiseDecision`) — the Lead's *judgment*
 * lives only on the close calls, never in prose narration of the obvious ones. The
 * resulting `AdjudicationVerdict` is validated against `AdjudicationVerdictSchema`
 * and persisted alongside the panel's per-lens files in the session dir, so it is
 * the canonical record the dashboard (Story 9.5) and the calibration loop
 * (Epic 6b, judge-the-judge) read — emitted even on `ready` so the loop can later
 * correlate `ready` verdicts with clean merges.
 *
 * **Bless ONLY through the brake.** On a `ready` decision the tool flips readiness
 * via Story 9.1's `markStoryReady` — never a direct manifest write, the one
 * chokepoint that keeps readiness operator-owned. A `rework` / `escalate` decision
 * leaves the draft not-ready (the brake is never called).
 *
 * **Never auto-pass a close call.** A split panel (some pass, some fail with no
 * lens able to break the tie within K rounds) escalates to the operator with a
 * populated `escalation_reason`; nothing is blessed. That ambiguity reaching a
 * human is the whole point of escalation.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { sanitiseRefForPathSegment } from "../lib/read-reviewer-result-file.js";
import { atomicWriteFile } from "../lib/managed-fs.js";
import { logTelemetryEvent } from "../lib/logger.js";
import {
  AdjudicationVerdictSchema,
  type AdjudicationDecision,
  type AdjudicationVerdict,
} from "../schemas/adjudication-verdict.js";
import { PanelVerdictSchema, type PanelVerdict } from "../schemas/lens-verdict.js";
import { markStoryReady, type MarkStoryReadyOutput } from "./mark-story-ready.js";
import { emitFriction } from "../lib/emit-friction.js";

/** Default escalation threshold (rubric §7 open question, proposed default 2). */
export const DEFAULT_ADJUDICATION_K = 2;

// ---------------------------------------------------------------------------
// The synthesis rule (rubric §5) — a pure function over the PanelVerdict
// ---------------------------------------------------------------------------

export interface SynthesisInput {
  /** The panel verdict (five lens results) being synthesised. */
  panel: PanelVerdict;
  /**
   * The current adjudication round (1-based). A split that persists at round ≥ K
   * escalates rather than looping forever.
   */
  round: number;
  /** Escalation threshold K (default 2). */
  k: number;
}

export interface SynthesisResult {
  decision: AdjudicationDecision;
  rationale: string;
  /** Present only for an `escalate` decision. */
  escalation_reason?: string;
}

/**
 * Apply the rubric §5 synthesis rule to a panel verdict.
 *
 * - All five lenses pass → `ready`.
 * - Any lens fails AND we are still inside the K-round window (round < K) →
 *   `rework`, carrying the failed lenses' `missed` strings so the author can fix
 *   the specific gaps.
 * - A panel that is still split (some fail) once round ≥ K → `escalate`: the close
 *   call has persisted across the allotted rounds and must reach the operator
 *   rather than auto-passing. The `escalation_reason` names the lenses that never
 *   resolved.
 *
 * Pure: no IO, no side effects. The Lead's judgment is expressed by what it writes
 * into the rationale on the close calls; the rule itself is deterministic.
 */
export function synthesiseDecision(input: SynthesisInput): SynthesisResult {
  const { panel, round, k } = input;

  const failed = panel.lenses.filter((l) => !l.pass);

  // Clean sweep — every lens passed.
  if (failed.length === 0) {
    return {
      decision: "ready",
      rationale: `All ${panel.lenses.length} Tier-1 lenses passed (tier0=${panel.tier0}); the draft clears the quality bar.`,
    };
  }

  const misses = failed.map((l) => `[${l.lens}] ${l.missed}`).join("; ");

  // A split that has persisted to (or past) the K-round threshold escalates — the
  // close call has not resolved in the allotted rounds, so it goes to the operator
  // rather than auto-passing or looping forever.
  if (round >= k) {
    return {
      decision: "escalate",
      rationale: `Panel still split after ${round} round(s) (K=${k}); ${failed.length} of ${panel.lenses.length} lens(es) unresolved.`,
      escalation_reason:
        `A split panel persisted after K=${k} rounds and must not auto-pass. ` +
        `Unresolved lens(es): ${misses}. Operator adjudication required.`,
    };
  }

  // Inside the K-round window: bounce back to the author with the specific misses.
  return {
    decision: "rework",
    rationale: `${failed.length} of ${panel.lenses.length} lens(es) failed (round ${round} of K=${k}); returned to the author. Misses: ${misses}.`,
  };
}

// ---------------------------------------------------------------------------
// The adjudication verdict file (persisted alongside the panel's per-lens files)
// ---------------------------------------------------------------------------

/**
 * Deterministically derive the absolute path to a draft's adjudication-verdict
 * file within a session — the SAME `<sessionUlid>/<sanitised-ref>/` dir the panel
 * writes its `judge-<lens>.json` files to (judge-panel.ts `lensVerdictFilePath`),
 * so the verdict is the canonical record the dashboard / calibration loop read
 * "alongside the panel verdict".
 *
 * Layout: `<targetRepoRoot>/.flow/state/sessions/<sessionUlid>/<sanitised-ref>/adjudication-verdict.json`
 */
export function adjudicationVerdictFilePath(
  targetRepoRoot: string,
  sessionUlid: string,
  ref: string,
): string {
  return path.join(
    targetRepoRoot,
    ".flow",
    "state",
    "sessions",
    sessionUlid,
    sanitiseRefForPathSegment(ref),
    "adjudication-verdict.json",
  );
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export interface AdjudicateQualityLeadOptions {
  targetRepoRoot: string;
  sessionUlid: string;
  /** The draft's ref (`native:01HZ...` / `bmad:9.4`). */
  ref: string;
  /** The panel verdict to synthesise (validated against PanelVerdictSchema). */
  panel: PanelVerdict;
  /** The current adjudication round (1-based). Defaults to 1. */
  round?: number;
  /** Escalation threshold K. Defaults to DEFAULT_ADJUDICATION_K (2). */
  k?: number;
  /**
   * Test seam: override the readiness-brake call. Production wires Story 9.1's
   * `markStoryReady`; tests inject a spy that records it was called. The brake is
   * the ONLY path that flips readiness — never a direct manifest write.
   */
  markReady?: (opts: {
    targetRepoRoot: string;
    ref: string;
    ready: boolean;
    sessionUlid?: string;
  }) => Promise<MarkStoryReadyOutput>;
}

export interface AdjudicateQualityLeadResult {
  /** The persisted, schema-validated adjudication verdict (the canonical record). */
  verdict: AdjudicationVerdict;
  /** Absolute path the verdict was written to. */
  verdictFilePath: string;
  /** The brake-tool output when the decision was `ready`; undefined otherwise. */
  blessed?: MarkStoryReadyOutput;
}

/**
 * Adjudicate a panel verdict: synthesise the decision, bless via the brake on
 * `ready`, persist the `AdjudicationVerdict`, and emit one telemetry event.
 *
 * Steps:
 *  1. Validate the incoming panel verdict against `PanelVerdictSchema` (the panel
 *     is the input; a malformed one is a hard failure, not a silent pass).
 *  2. Apply the rubric §5 synthesis rule (`synthesiseDecision`).
 *  3. On `ready` ONLY, bless the draft through `markStoryReady` (Story 9.1's
 *     brake — never a direct manifest write). `rework` / `escalate` leave the
 *     draft not-ready (the brake is never called).
 *  4. Assemble + validate the `AdjudicationVerdict`, persist it alongside the
 *     panel's per-lens files, and emit one `quality.adjudicated` telemetry event
 *     (the calibration loop's judge-the-judge input — emitted even on `ready`).
 */
export async function adjudicateQualityLead(
  opts: AdjudicateQualityLeadOptions,
): Promise<AdjudicateQualityLeadResult> {
  const targetRepoRoot = path.resolve(opts.targetRepoRoot);
  const { sessionUlid, ref } = opts;
  const round = opts.round ?? 1;
  const k = opts.k ?? DEFAULT_ADJUDICATION_K;
  const markReady = opts.markReady ?? markStoryReady;

  // Step 1 — the panel verdict is the input; a malformed one is a hard failure.
  const panel = PanelVerdictSchema.parse(opts.panel);

  // Step 2 — synthesise (rubric §5). Pure; no side effects.
  const synthesis = synthesiseDecision({ panel, round, k });

  // Emit friction on escalate — a panel that persists split after K rounds is a
  // planning-phase friction event. The emit must occur before the verdict is
  // assembled (and before the quality.adjudicated telemetry event), but must not
  // change the returned verdict. emitFriction is fail-soft; it swallows its own
  // errors so a telemetry failure cannot alter the decision.
  if (synthesis.decision === "escalate") {
    await emitFriction({
      targetRepoRoot,
      kind: "forced-fallback",
      role: "quality-lead",
      session_id: sessionUlid,
      story_id: ref,
      expected: `panel reaches unanimous pass within K rounds`,
      observed: `Panel still split after round ${round} of K=${k}; escalating`,
    });
  }

  // Step 3 — bless ONLY on `ready`, ONLY through the brake. A close call (escalate)
  // and a fail (rework) leave the draft not-ready: the brake is never called.
  let blessed: MarkStoryReadyOutput | undefined;
  if (synthesis.decision === "ready") {
    blessed = await markReady({
      targetRepoRoot,
      ref,
      ready: true,
      sessionUlid,
    });
  }

  // Step 4 — assemble + validate the canonical verdict. The schema enforces a
  // non-empty rationale and the escalation_reason ⇔ escalate invariant.
  const verdict: AdjudicationVerdict = AdjudicationVerdictSchema.parse({
    ref,
    decision: synthesis.decision,
    rationale: synthesis.rationale,
    ...(synthesis.escalation_reason !== undefined
      ? { escalation_reason: synthesis.escalation_reason }
      : {}),
    round,
  });

  // Persist alongside the panel's per-lens files in the session dir.
  const verdictFilePath = adjudicationVerdictFilePath(targetRepoRoot, sessionUlid, ref);
  await fs.mkdir(path.dirname(verdictFilePath), { recursive: true });
  await atomicWriteFile(verdictFilePath, JSON.stringify(verdict, null, 2));

  // One `quality.adjudicated` event per adjudication — the judge-the-judge input.
  // Emitted on every decision (including `ready`) so the loop can later correlate.
  // No `missed`/rationale strings leaked into telemetry (NFR14).
  await logTelemetryEvent({
    targetRepoRoot,
    event: {
      type: "quality.adjudicated",
      session_id: sessionUlid,
      agent: "quality-lead",
      story_id: ref,
      data: {
        ref,
        decision: verdict.decision,
        round: verdict.round,
        escalated: verdict.decision === "escalate",
      },
    },
  });

  return {
    verdict,
    verdictFilePath,
    ...(blessed !== undefined ? { blessed } : {}),
  };
}

