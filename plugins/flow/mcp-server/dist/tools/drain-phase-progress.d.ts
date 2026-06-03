/**
 * `drainPhaseStart` / `drainPhaseDone` CLI tools — Story 8.18.
 *
 * The drain workflow (`plugins/flow/workflows/drain.workflow.js`) brackets each
 * major per-story phase (dev-build, review, gate) with an operator-facing
 * progress line: a `start` line as it enters the phase and a `done` line —
 * carrying the elapsed wall-clock time — as it leaves. These are emitted
 * through the existing narrator (`log()`) and change no control flow; they only
 * close the "is the run hung, or just in a long build?" gap surfaced by the
 * first real end-to-end drain (the silent ~10-minute dev-build span).
 *
 * Why these are CLI tools and not in-script `Date.now()` + a direct helper call:
 *
 *  1. The Workflow runtime forbids the drain script from reading the wall clock
 *     (`Date.now()`/`new Date()`) for resume-determinism. A seam result is
 *     recorded and replayed by the runtime, so reading the clock through a seam
 *     keeps the elapsed-time derivation deterministic across a crash-resume.
 *  2. The drain workflow is plain `.js` with zero static imports — it reaches
 *     all logic through the one-shot CLI seam transport. Routing the progress
 *     lines through the same transport keeps that discipline intact (no new
 *     in-script import surface) and makes the lines stubbable in the drain
 *     integration test exactly like every other seam.
 *
 * Both tools delegate the actual line formatting to the pure, unit-tested
 * `formatDrainProgress` helper; the only thing they add is reading the wall
 * clock (in this fresh one-shot CLI process, never in the workflow sandbox) and
 * computing the elapsed delta. `drainPhaseStart` returns the start line plus the
 * `atMs` the caller must hand back to `drainPhaseDone` so it can compute elapsed.
 *
 * Story 8.18
 */
import { type DrainPhase } from "../lib/format-drain-progress.js";
export interface DrainPhaseStartArgs {
    /** The story ref the phase ran for (e.g. `"bmad:8.18"`). */
    ref: string;
    /** Which major per-story phase is starting. */
    phase: DrainPhase;
}
export interface DrainPhaseStartResult {
    /** The formatted operator-facing start line. */
    line: string;
    /**
     * The wall-clock time (epoch ms) this phase started, read in this CLI
     * process. The caller hands this back to `drainPhaseDone` to derive elapsed.
     */
    atMs: number;
}
/**
 * Emit the start of a drain phase: read the wall clock and format the start
 * line via the pure helper. The returned `atMs` must be passed to
 * `drainPhaseDone` so it can compute the elapsed wall-clock time.
 */
export declare function drainPhaseStart(args: DrainPhaseStartArgs): DrainPhaseStartResult;
export interface DrainPhaseDoneArgs {
    /** The story ref the phase ran for (e.g. `"bmad:8.18"`). */
    ref: string;
    /** Which major per-story phase is finishing. */
    phase: DrainPhase;
    /** The `atMs` returned by the matching `drainPhaseStart` call. */
    startedAtMs: number;
}
export interface DrainPhaseDoneResult {
    /** The formatted operator-facing done line, carrying elapsed time. */
    line: string;
    /** The elapsed wall-clock time for the phase, in milliseconds. */
    elapsedMs: number;
}
/**
 * Emit the completion of a drain phase: read the wall clock, compute the
 * elapsed wall-clock time since `startedAtMs`, and format the done line via the
 * pure helper. A missing or non-finite `startedAtMs` yields an elapsed of `0`
 * (the helper renders `0ms`) rather than throwing — a missing timing input must
 * never break the additive observability line.
 */
export declare function drainPhaseDone(args: DrainPhaseDoneArgs): DrainPhaseDoneResult;
