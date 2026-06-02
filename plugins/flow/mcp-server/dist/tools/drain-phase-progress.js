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
import { formatDrainProgress, } from "../lib/format-drain-progress.js";
/** The phases the drain brackets — mirrors the pure helper's `DrainPhase`. */
const KNOWN_PHASES = new Set([
    "dev-build",
    "review",
    "gate",
]);
function assertPhase(phase) {
    if (typeof phase !== "string" || !KNOWN_PHASES.has(phase)) {
        throw new Error(`drain-phase-progress: unknown phase ${JSON.stringify(phase)} (expected one of ${[...KNOWN_PHASES].join(", ")})`);
    }
    return phase;
}
function assertRef(ref) {
    if (typeof ref !== "string" || ref.length === 0) {
        throw new Error("drain-phase-progress: `ref` is required and must be a non-empty string");
    }
    return ref;
}
/**
 * Emit the start of a drain phase: read the wall clock and format the start
 * line via the pure helper. The returned `atMs` must be passed to
 * `drainPhaseDone` so it can compute the elapsed wall-clock time.
 */
export function drainPhaseStart(args) {
    const ref = assertRef(args?.ref);
    const phase = assertPhase(args?.phase);
    return { line: formatDrainProgress(ref, phase, "start"), atMs: Date.now() };
}
/**
 * Emit the completion of a drain phase: read the wall clock, compute the
 * elapsed wall-clock time since `startedAtMs`, and format the done line via the
 * pure helper. A missing or non-finite `startedAtMs` yields an elapsed of `0`
 * (the helper renders `0ms`) rather than throwing — a missing timing input must
 * never break the additive observability line.
 */
export function drainPhaseDone(args) {
    const ref = assertRef(args?.ref);
    const phase = assertPhase(args?.phase);
    const startedAtMs = args?.startedAtMs;
    const elapsedMs = typeof startedAtMs === "number" && Number.isFinite(startedAtMs)
        ? Math.max(0, Date.now() - startedAtMs)
        : 0;
    return { line: formatDrainProgress(ref, phase, "done", elapsedMs), elapsedMs };
}
