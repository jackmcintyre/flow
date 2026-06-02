/**
 * Pure helper: `explainGateReason` — Story 8.10.
 *
 * Turns an auto-merge gate reason *code* (the literal strings emitted by
 * `decideAutoMerge` / `runAutoMergeGate`) into a one-line, plain-language
 * explanation an operator can read without memorising the reason literals.
 *
 * The known reason codes mirror the `AutoMergeGateReason` union in
 * `auto-merge-gate.ts`. This module deliberately does NOT import that type:
 * it accepts a plain `string` and returns a plain `string` so the gate's
 * closed reason set can evolve without coupling, and so this story's diff is
 * purely additive (low.additive-only) — no existing module is touched.
 *
 * The function is pure and deterministic: no I/O, no mutation, no async. It
 * never throws for any string input — an unrecognized reason yields a safe,
 * non-empty generic fallback.
 *
 * Every explanation is a single line (no `\n`).
 *
 * Story 8.10
 */
/**
 * One-line, plain-language explanations keyed by the known gate reason codes.
 *
 * Keys mirror the `AutoMergeGateReason` union in `auto-merge-gate.ts`. If a new
 * reason literal is added there, add a matching entry here in the same change.
 */
const GATE_REASON_EXPLANATIONS = {
    "low-risk-met-threshold": "Auto-merged: this is a low-risk change and the team's recent agreement with the reviewer met the trust threshold.",
    "low-risk-sub-threshold": "Paused for a human: this is a low-risk change, but the team's recent agreement with the reviewer fell below the trust threshold.",
    "low-risk-insufficient-data": "Paused for a human: this is a low-risk change, but there isn't yet enough verdict history to measure whether the reviewer can be trusted to auto-merge.",
    "low-risk-provisional-trust": "Auto-merged: this is a low-risk change merged on cold-start provisional trust while the agreement history is still building.",
    "medium-risk": "Paused for a human: this is a medium-risk change, which always waits for a human regardless of reviewer agreement.",
    "high-risk": "Paused for a human: this is a high-risk change, which always waits for a human regardless of reviewer agreement.",
    "no-tier-no-signal": "Paused for a human: the change has no risk tier on its manifest, so the gate has no signal to act on and defers to a human.",
    "ci-not-green": "Paused for a human: the risk gate cleared this change to auto-merge, but its CI checks did not go green within the wait window.",
};
/**
 * Safe, non-empty generic fallback for any reason code that is not one of the
 * known literals (including the empty string).
 */
const UNKNOWN_REASON_EXPLANATION = "Paused for a human: the auto-merge gate returned an unrecognized reason, so the decision could not be explained automatically.";
/**
 * Map an auto-merge gate reason code to a one-line plain-language explanation.
 *
 * Pure and deterministic. Never throws. Always returns a non-empty string with
 * no newline characters.
 *
 * @param reason - A gate reason code (e.g. `"low-risk-met-threshold"`). Unknown
 *   or empty values yield a generic fallback explanation.
 * @returns A non-empty, single-line, human-readable explanation.
 */
export function explainGateReason(reason) {
    // Use `Object.hasOwn` so inherited members (`toString`, `constructor`, …)
    // never resolve to a non-explanation value via the prototype chain.
    const explanation = Object.hasOwn(GATE_REASON_EXPLANATIONS, reason)
        ? GATE_REASON_EXPLANATIONS[reason]
        : undefined;
    return explanation ?? UNKNOWN_REASON_EXPLANATION;
}
