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
import { type AdjudicationDecision, type AdjudicationVerdict } from "../schemas/adjudication-verdict.js";
import { type PanelVerdict } from "../schemas/lens-verdict.js";
import { type MarkStoryReadyOutput } from "./mark-story-ready.js";
/** Default escalation threshold (rubric §7 open question, proposed default 2). */
export declare const DEFAULT_ADJUDICATION_K = 2;
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
export declare function synthesiseDecision(input: SynthesisInput): SynthesisResult;
/**
 * Deterministically derive the absolute path to a draft's adjudication-verdict
 * file within a session — the SAME `<sessionUlid>/<sanitised-ref>/` dir the panel
 * writes its `judge-<lens>.json` files to (judge-panel.ts `lensVerdictFilePath`),
 * so the verdict is the canonical record the dashboard / calibration loop read
 * "alongside the panel verdict".
 *
 * Layout: `<targetRepoRoot>/.flow/state/sessions/<sessionUlid>/<sanitised-ref>/adjudication-verdict.json`
 */
export declare function adjudicationVerdictFilePath(targetRepoRoot: string, sessionUlid: string, ref: string): string;
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
export declare function adjudicateQualityLead(opts: AdjudicateQualityLeadOptions): Promise<AdjudicateQualityLeadResult>;
export type { AdjudicationVerdict, AdjudicationDecision };
