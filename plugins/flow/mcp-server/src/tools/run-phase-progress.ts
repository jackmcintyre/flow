/**
 * `runPhaseStart` / `runPhaseDone` CLI tools — Story 8.18.
 *
 * The run workflow (`plugins/flow/workflows/internal/run.workflow.js`) brackets each
 * major per-story phase (dev-build, review, gate) with an operator-facing
 * progress line: a `start` line as it enters the phase and a `done` line —
 * carrying the elapsed wall-clock time — as it leaves. These are emitted
 * through the existing narrator (`log()`) and change no control flow; they only
 * close the "is the run hung, or just in a long build?" gap surfaced by the
 * first real end-to-end run (the silent ~10-minute dev-build span).
 *
 * Why these are CLI tools and not in-script `Date.now()` + a direct helper call:
 *
 *  1. The Workflow runtime forbids the run script from reading the wall clock
 *     (`Date.now()`/`new Date()`) for resume-determinism. A seam result is
 *     recorded and replayed by the runtime, so reading the clock through a seam
 *     keeps the elapsed-time derivation deterministic across a crash-resume.
 *  2. The run workflow is plain `.js` with zero static imports — it reaches
 *     all logic through the one-shot CLI seam transport. Routing the progress
 *     lines through the same transport keeps that discipline intact (no new
 *     in-script import surface) and makes the lines stubbable in the run
 *     integration test exactly like every other seam.
 *
 * Both tools delegate the actual line formatting to the pure, unit-tested
 * `formatRunProgress` helper; the only thing they add is reading the wall
 * clock (in this fresh one-shot CLI process, never in the workflow sandbox) and
 * computing the elapsed delta. `runPhaseStart` returns the start line plus the
 * `atMs` the caller must hand back to `runPhaseDone` so it can compute elapsed.
 *
 * Story 8.18
 */

import {
  formatRunProgress,
  type RunPhase,
} from "../lib/format-run-progress.js";

/** The phases the run brackets — mirrors the pure helper's `RunPhase`. */
const KNOWN_PHASES: ReadonlySet<string> = new Set<RunPhase>([
  "dev-build",
  "review",
  "gate",
]);

function assertPhase(phase: unknown): RunPhase {
  if (typeof phase !== "string" || !KNOWN_PHASES.has(phase)) {
    throw new Error(
      `run-phase-progress: unknown phase ${JSON.stringify(phase)} (expected one of ${[...KNOWN_PHASES].join(", ")})`,
    );
  }
  return phase as RunPhase;
}

function assertRef(ref: unknown): string {
  if (typeof ref !== "string" || ref.length === 0) {
    throw new Error("run-phase-progress: `ref` is required and must be a non-empty string");
  }
  return ref;
}

export interface RunPhaseStartArgs {
  /** The story ref the phase ran for (e.g. `"bmad:8.18"`). */
  ref: string;
  /** Which major per-story phase is starting. */
  phase: RunPhase;
}

export interface RunPhaseStartResult {
  /** The formatted operator-facing start line. */
  line: string;
  /**
   * The wall-clock time (epoch ms) this phase started, read in this CLI
   * process. The caller hands this back to `runPhaseDone` to derive elapsed.
   */
  atMs: number;
}

/**
 * Emit the start of a run phase: read the wall clock and format the start
 * line via the pure helper. The returned `atMs` must be passed to
 * `runPhaseDone` so it can compute the elapsed wall-clock time.
 */
export function runPhaseStart(args: RunPhaseStartArgs): RunPhaseStartResult {
  const ref = assertRef(args?.ref);
  const phase = assertPhase(args?.phase);
  return { line: formatRunProgress(ref, phase, "start"), atMs: Date.now() };
}

export interface RunPhaseDoneArgs {
  /** The story ref the phase ran for (e.g. `"bmad:8.18"`). */
  ref: string;
  /** Which major per-story phase is finishing. */
  phase: RunPhase;
  /** The `atMs` returned by the matching `runPhaseStart` call. */
  startedAtMs: number;
}

export interface RunPhaseDoneResult {
  /** The formatted operator-facing done line, carrying elapsed time. */
  line: string;
  /** The elapsed wall-clock time for the phase, in milliseconds. */
  elapsedMs: number;
}

/**
 * Emit the completion of a run phase: read the wall clock, compute the
 * elapsed wall-clock time since `startedAtMs`, and format the done line via the
 * pure helper. A missing or non-finite `startedAtMs` yields an elapsed of `0`
 * (the helper renders `0ms`) rather than throwing — a missing timing input must
 * never break the additive observability line.
 */
export function runPhaseDone(args: RunPhaseDoneArgs): RunPhaseDoneResult {
  const ref = assertRef(args?.ref);
  const phase = assertPhase(args?.phase);
  const startedAtMs = args?.startedAtMs;
  const elapsedMs =
    typeof startedAtMs === "number" && Number.isFinite(startedAtMs)
      ? Math.max(0, Date.now() - startedAtMs)
      : 0;
  return { line: formatRunProgress(ref, phase, "done", elapsedMs), elapsedMs };
}
