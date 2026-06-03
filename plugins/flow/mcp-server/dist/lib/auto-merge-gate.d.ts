/**
 * Pure helper: `decideAutoMerge` — Story 4.10b.
 *
 * Maps `(risk_tier, agreement_metric, threshold)` to a deterministic
 * `("auto-merge" | "pause-needs-human", reason)` outcome.
 *
 * Decision table (FR40 / FR41 / FR42; Stage-2 adds the provisional-trust row):
 *
 * | risk_tier | agreement_metric     | provisional_trust | decision          | reason                       |
 * |-----------|----------------------|-------------------|-------------------|------------------------------|
 * | "low"     | non-null >= threshold| any               | auto-merge        | low-risk-met-threshold       |
 * | "low"     | non-null < threshold | any               | pause-needs-human | low-risk-sub-threshold       |
 * | "low"     | null (insufficient)  | false             | pause-needs-human | low-risk-insufficient-data   |
 * | "low"     | null (insufficient)  | true              | auto-merge        | low-risk-provisional-trust   |
 * | "medium"  | any                  | any               | pause-needs-human | medium-risk                  |
 * | "high"    | any                  | any               | pause-needs-human | high-risk                    |
 * | undefined | any                  | any               | pause-needs-human | no-tier-no-signal            |
 *
 * provisional_trust ONLY relaxes the `low` + insufficient-data row. Medium, high,
 * and untiered PRs always pause regardless of the flag.
 *
 * This function is pure — no I/O, no async. It is the single source of truth
 * for the gate decision; downstream consumers (MCP tool, Epic 6 retro stats,
 * dashboard tools) MUST call this function rather than re-implementing the
 * mapping.
 *
 * Threshold comparison uses `>=` (FR40 verbatim). A ratio exactly equal to
 * the threshold qualifies for auto-merge.
 *
 * Story 4.10b · FR40 · FR41 · FR42
 */
import type { AgreementMetricResult } from "../tools/compute-agreement.js";
/**
 * Closed set of reason literals emitted by `decideAutoMerge`.
 * Matches the Zod enum declared in `AutoMergeGateResultSchema` exactly.
 * DO NOT add literals here without updating that schema.
 *
 * Story 4.10b (AC5c).
 */
export type AutoMergeGateReason = "low-risk-met-threshold" | "low-risk-sub-threshold" | "low-risk-insufficient-data" | "low-risk-provisional-trust" | "medium-risk" | "high-risk" | "no-tier-no-signal" | "ci-not-green";
export interface DecideAutoMergeInput {
    /** The manifest's `risk_tier` field. May be `undefined` for legacy manifests. */
    risk_tier: "low" | "medium" | "high" | undefined;
    /** Output of `computeAgreement`. `null` means insufficient data. */
    agreement_metric: AgreementMetricResult | null;
    /** Resolved threshold (0 <= n <= 1). Comparison is `>=` (FR40). */
    threshold: number;
    /**
     * Cold-start provisional trust (Stage-2). When `true`, a `low`-risk PR auto-
     * merges while the agreement metric is still `null` — i.e. the agreement
     * window has not yet filled (fewer than the window's worth of resolved
     * verdict pairs), which spans the whole ramp from zero history up to the
     * window size, not only the empty-history moment. This is the intended
     * bootstrap: low-risk merges must flow during the ramp so agreement history
     * can accrue. Default (undefined / false) preserves pause-for-human.
     * This flag ONLY affects the `low` + insufficient-data branch — medium, high,
     * and untiered always pause regardless of its value.
     */
    provisional_trust?: boolean;
}
export interface DecideAutoMergeOutput {
    decision: "auto-merge" | "pause-needs-human";
    reason: AutoMergeGateReason;
}
/**
 * Pure, synchronous gate function.
 *
 * Implements the six-branch decision table above. No I/O. No side-effects.
 *
 * @param input - `{ risk_tier, agreement_metric, threshold }`
 * @returns `{ decision, reason }`
 */
export declare function decideAutoMerge(input: DecideAutoMergeInput): DecideAutoMergeOutput;
