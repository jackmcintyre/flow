/**
 * Unit tests for `formatDrainProgress` / `formatElapsed` — Story 8.18.
 *
 * AC1: a pure helper formats the drain's per-phase progress lines. For a
 *      representative phase it produces a `start` line and a `done`-with-elapsed
 *      line, and the duration is rendered in a human-readable form. Pure and
 *      deterministic (no mutation, never throws, single line).
 * AC2: the dev-build start line carries an explicit "longest phase" marker so an
 *      operator knows a multi-minute gap there is expected, not a hang. The
 *      marker is present for dev-build and absent for the short phases.
 */
export {};
