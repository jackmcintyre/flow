/**
 * `formatDrainProgress` — Story 8.18.
 *
 * Renders the operator-facing progress lines the drain emits as it enters and
 * leaves each major per-story phase (dev-build, review, gate). The drain loop
 * runs a single long `agent()` call for the dev-build span and emits nothing
 * between `claimed <ref>` and `-> PR #<n>`; to an operator a long silent build
 * is indistinguishable from a hang. These lines bracket each phase with a
 * start line and a done line that carries the elapsed wall-clock time, so the
 * narrator shows progress is being made.
 *
 * Pure and deterministic — no I/O, no mutation of the input, no async, and it
 * never calls the wall clock itself. The caller supplies an elapsed-ms number
 * (the drain workflow derives it from the clock seam the Workflow runtime
 * allows, since workflow scripts cannot call `Date.now()`/`new Date()` for
 * resume-determinism). The returned string is always a single line (no `\n`).
 *
 * This module deliberately imports nothing from existing modules and returns a
 * plain `string`, so the story's diff is purely additive — no existing module
 * is touched and no control flow changes.
 *
 * Story 8.18
 */

/**
 * Inline short-handle helper — kept here rather than imported to preserve the
 * zero-import contract of this module (see file header). Logic is identical to
 * `shortHandle` in `./short-handle.ts`; the duplication is intentional.
 *
 * For `native:<ULID>` returns the first 8 characters of the ULID.
 * For any other ref returns the local part after the first `:`.
 */
function _shortHandle(ref: string): string {
  const colon = ref.indexOf(":");
  const localPart = colon === -1 ? ref : ref.slice(colon + 1);
  if (ref.startsWith("native:")) {
    return localPart.slice(0, 8);
  }
  return localPart;
}

/** The major per-story phases the drain brackets with progress lines. */
export type DrainPhase = "dev-build" | "review" | "gate";

/** Whether the line marks entering a phase or leaving it. */
export type DrainTransition = "start" | "done";

/**
 * The set of phases the helper treats as the long-running one. Only
 * `dev-build` carries the "longest phase" marker on its start line — it is the
 * single long agent call (roughly ten minutes in the first real drain) where a
 * multi-minute gap is expected, not a hang. `review` and `gate` are short.
 */
const LONG_PHASES: ReadonlySet<DrainPhase> = new Set<DrainPhase>(["dev-build"]);

/**
 * The marker text appended to the long phase's start line. Asserted present
 * for `dev-build` and absent for the short phases by the unit test (AC2).
 */
export const LONG_PHASE_MARKER = "(longest phase — a multi-minute gap here is expected)";

/**
 * Render an elapsed duration (in milliseconds) in a human-readable form.
 *
 * Sub-second durations render in milliseconds (`850ms`); from one second up to
 * one minute in seconds with one decimal (`4.2s`); a minute or more in whole
 * minutes and seconds (`10m 3s`). Pure and deterministic; never throws for any
 * finite, non-negative number. Negative or non-finite inputs are clamped to `0`.
 *
 * @param elapsedMs - The elapsed wall-clock time for the phase, in milliseconds.
 * @returns A compact, human-readable duration string (no whitespace at the ends).
 */
export function formatElapsed(elapsedMs: number): string {
  const ms = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${(Math.round(totalSeconds * 10) / 10).toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds - minutes * 60);
  // Carry a 60s rounding up into the minutes so we never render "9m 60s".
  if (seconds === 60) return `${minutes + 1}m 0s`;
  return `${minutes}m ${seconds}s`;
}

/**
 * Format a single drain progress line for the narrator.
 *
 * For a `start` transition:
 *   `<ref> <phase>: start` — and, for the long phase only, the
 *   `LONG_PHASE_MARKER` is appended so an operator knows a long gap is expected.
 *
 * For a `done` transition:
 *   `<ref> <phase>: done in <human-readable elapsed>` — the elapsed time is
 *   only meaningful on the leave-line, so `elapsedMs` is ignored for `start`.
 *
 * Pure and deterministic. Never throws for any input matching the declared
 * shape. Always returns a non-empty, single-line string with no newline
 * characters.
 *
 * @param ref - The story ref the phase ran for (e.g. `"bmad:8.18"`).
 * @param phase - Which major per-story phase this line is for.
 * @param transition - Whether the line marks entering (`start`) or leaving (`done`).
 * @param elapsedMs - The elapsed wall-clock time for the phase, in milliseconds.
 *   Only used (and only meaningful) for the `done` transition.
 * @returns A single-line, human-readable progress line.
 */
export function formatDrainProgress(
  ref: string,
  phase: DrainPhase,
  transition: DrainTransition,
  elapsedMs = 0,
): string {
  const handle = _shortHandle(ref);
  if (transition === "start") {
    const base = `${handle} ${phase}: start`;
    return LONG_PHASES.has(phase) ? `${base} ${LONG_PHASE_MARKER}` : base;
  }
  return `${handle} ${phase}: done in ${formatElapsed(elapsedMs)}`;
}
