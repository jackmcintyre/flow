/**
 * `summariseGateOutcome` — Story 8.11.
 *
 * Renders an auto-merge gate outcome as a single human-readable line, so that
 * after the gate runs an operator can see at a glance whether a PR was
 * auto-merged or paused, and why, without inspecting the raw result object.
 *
 * Pure and deterministic — no I/O, no mutation of the input, no async. It never
 * throws for any input matching the declared shape. The returned string is
 * always a single line (no `\n`).
 *
 * This module deliberately accepts a plain object and returns a plain `string`,
 * importing nothing from existing modules, so the story's diff is purely
 * additive (low.additive-only) — no existing module is touched.
 *
 * Story 8.11
 */
/**
 * Render an auto-merge gate outcome as a one-line summary.
 *
 * Form:
 *   `<ref> PR#<prNumber>: <auto-merged|paused for human> (<reason>)`
 *
 * The human word is `auto-merged` when `outcome.merged` is true, otherwise
 * `paused for human`.
 *
 * Pure and deterministic. Never throws for any input matching `GateOutcome`.
 * Always returns a non-empty, single-line string with no newline characters.
 *
 * @param outcome - The structured gate outcome to render.
 * @returns A single-line, human-readable summary of the outcome.
 */
export function summariseGateOutcome(outcome) {
    const word = outcome.merged ? "auto-merged" : "paused for human";
    return `${outcome.ref} PR#${outcome.prNumber}: ${word} (${outcome.reason})`;
}
