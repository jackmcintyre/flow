/**
 * `AdjudicationVerdict` schema — Story 9.4 (Quality Lead, gate 1 adjudication).
 *
 * The deterministic seam of the Quality Lead. The judge panel (Story 9.3) emits a
 * `PanelVerdict` (five `{ lens, role, pass, missed }` entries); the Quality Lead
 * synthesises it via the rubric §5 rule into ONE machine-checkable decision —
 * exactly the reviewer/panel posture (the load-bearing decision lives in a
 * validated artifact, never in a judge's narration).
 *
 * This verdict is the canonical record the dashboard (Story 9.5) renders and the
 * calibration loop (Epic 6b, judge-the-judge) reads — so it is emitted even on a
 * `ready` decision, so the loop can later correlate `ready` verdicts with clean
 * merges vs. rework.
 *
 * Rubric §5 synthesis rule:
 *   - all five lenses pass        → `ready`   (the draft may be blessed)
 *   - any lens fails              → `rework`  (the failed `missed` strings returned)
 *   - split / close call after K  → `escalate` (operator decides; never auto-pass)
 *
 * Hard rules baked into the schema:
 *   - `decision` is a closed enum over exactly the three outcomes.
 *   - `rationale` is required and non-empty — a verdict the operator / loop cannot
 *     read is itself malformed.
 *   - `escalation_reason` is required and non-empty WHEN (and only when) the
 *     decision is `escalate` — an escalation with no reason surfaced to the operator
 *     is the close-call-auto-pass failure in disguise. A non-escalate decision must
 *     NOT carry one.
 *   - `.strict()` so an unexpected key (e.g. a leaked prose blob) is rejected at the
 *     file boundary, mirroring the LensVerdict / telemetry-event posture.
 */
import { z } from "zod";
/** The three adjudication outcomes (rubric §5). Closed set. */
export const ADJUDICATION_DECISIONS = ["ready", "escalate", "rework"];
export const AdjudicationDecisionSchema = z.enum(ADJUDICATION_DECISIONS);
/**
 * The Quality Lead's machine-checkable verdict — the deterministic seam.
 *
 * - `ref`               — the draft this verdict adjudicates (`native:01HZ...` / `bmad:9.4`).
 * - `decision`          — `ready` | `escalate` | `rework` (rubric §5 synthesis).
 * - `rationale`         — why this decision was reached (non-empty). The Lead's
 *                         judgment lives here on the close calls; on the obvious
 *                         cases it is the short synthesis note.
 * - `escalation_reason` — present + non-empty IFF `decision === "escalate"`: the
 *                         reason the close call comes to the operator rather than
 *                         auto-passing. Withheld on `ready` / `rework`.
 * - `round`             — which adjudication round produced this (1-based). K (the
 *                         escalation threshold, default 2) is a parameter, not a
 *                         magic constant — a split that persists at round ≥ K
 *                         escalates.
 */
export const AdjudicationVerdictSchema = z
    .object({
    ref: z.string().min(1),
    decision: AdjudicationDecisionSchema,
    rationale: z.string().min(1),
    escalation_reason: z.string().min(1).optional(),
    round: z.number().int().positive(),
})
    .strict()
    .superRefine((v, ctx) => {
    if (v.decision === "escalate" && (v.escalation_reason === undefined || v.escalation_reason.trim() === "")) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["escalation_reason"],
            message: "an `escalate` decision must carry a non-empty `escalation_reason` — " +
                "an escalation with no reason surfaced to the operator is a close call " +
                "auto-passing in disguise",
        });
    }
    if (v.decision !== "escalate" && v.escalation_reason !== undefined) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["escalation_reason"],
            message: `a '${v.decision}' decision must NOT carry an escalation_reason — it is for escalations only`,
        });
    }
});
