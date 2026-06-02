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
 * Map an auto-merge gate reason code to a one-line plain-language explanation.
 *
 * Pure and deterministic. Never throws. Always returns a non-empty string with
 * no newline characters.
 *
 * @param reason - A gate reason code (e.g. `"low-risk-met-threshold"`). Unknown
 *   or empty values yield a generic fallback explanation.
 * @returns A non-empty, single-line, human-readable explanation.
 */
export declare function explainGateReason(reason: string): string;
