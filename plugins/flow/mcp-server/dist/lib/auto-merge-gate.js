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
// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------
/**
 * Pure, synchronous gate function.
 *
 * Implements the six-branch decision table above. No I/O. No side-effects.
 *
 * @param input - `{ risk_tier, agreement_metric, threshold }`
 * @returns `{ decision, reason }`
 */
export function decideAutoMerge(input) {
    const { risk_tier, agreement_metric, threshold } = input;
    const provisional_trust = input.provisional_trust ?? false;
    // Branch: no risk_tier on manifest (legacy / classifier-skipped)
    if (risk_tier === undefined) {
        return { decision: "pause-needs-human", reason: "no-tier-no-signal" };
    }
    // Branch: medium or high tier — always pause regardless of agreement.
    // provisional_trust deliberately does NOT relax these — it only ever bootstraps
    // trust on `low`-risk changes.
    if (risk_tier === "medium") {
        return { decision: "pause-needs-human", reason: "medium-risk" };
    }
    if (risk_tier === "high") {
        return { decision: "pause-needs-human", reason: "high-risk" };
    }
    // risk_tier === "low" from here on
    // Branch: low risk, insufficient data
    if (agreement_metric === null) {
        // Cold-start provisional trust (Stage-2): with the flag on, bootstrap by
        // auto-merging the lowest-risk change while the agreement window is still
        // filling (metric === null). Intended to relax across the whole ramp, not
        // just the empty-history moment, so history can accrue.
        if (provisional_trust) {
            return { decision: "auto-merge", reason: "low-risk-provisional-trust" };
        }
        return { decision: "pause-needs-human", reason: "low-risk-insufficient-data" };
    }
    // Branch: low risk, ratio >= threshold → auto-merge (FR40 uses >=)
    if (agreement_metric.ratio >= threshold) {
        return { decision: "auto-merge", reason: "low-risk-met-threshold" };
    }
    // Branch: low risk, sub-threshold
    return { decision: "pause-needs-human", reason: "low-risk-sub-threshold" };
}
