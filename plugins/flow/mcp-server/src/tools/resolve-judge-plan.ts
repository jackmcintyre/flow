/**
 * `resolveJudgePlan` tool — Story native:01KTKK2Y73EDDAXK470EZ3MHQ8.
 *
 * A pure deterministic function mapping (lane, detector_confirmed_dead) to a
 * lens plan. The decision is kept in this tool (not in workflow JS or agent
 * prose) so it is unit-testable WITHOUT executing the Workflow-runtime script.
 *
 * **Lane→plan mapping:**
 *
 * - `full` (or absent): the current five-lens LENS_MODEL tiering, verbatim.
 *   Structure+Discipline on Sonnet; Verifiability+Domain+Considered on Opus.
 *   { skip: false, lenses: [all five], perLensModel: {...} }
 *
 * - `fast` (and detector_confirmed_dead = false): one combined
 *   Structure+Verifiability lens on Sonnet — the two that catch malformed and
 *   hollow plans, the most common author errors.
 *   { skip: false, lenses: ['structure+verifiability'], perLensModel: { 'structure+verifiability': 'sonnet' } }
 *
 * - `fast` + detector_confirmed_dead = true: the judge is bypassed entirely —
 *   the reachability auditor already proved this is safe dead-code.
 *   { skip: true, lenses: [], perLensModel: {} }
 *
 * **Conservative-by-design:**
 * Any absent lane defaults to `full`. The function is pure (no I/O, no LLM).
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Constants — the current five-lens model tiering (operator decision 2026-06-02).
// Verbatim copy of the LENS_MODEL map in gate-1.workflow.js.
// AC1 pins a byte-identical regression: this map MUST NOT drift from the workflow.
// ---------------------------------------------------------------------------

export const FULL_LENS_MODEL: Record<string, "sonnet" | "opus"> = {
  structure: "sonnet",
  discipline: "sonnet",
  verifiability: "opus",
  domain: "opus",
  considered: "opus",
};

// The canonical lens execution order mirrors the LENSES constant in gate-1.workflow.js.
// This order (structure, verifiability, discipline, domain, considered) is load-bearing:
// the regression pin in AC1 asserts byte-identity with the original gate-1 constant.
export const FULL_LENSES: string[] = [
  "structure",
  "verifiability",
  "discipline",
  "domain",
  "considered",
];

// The single combined fast-lane lens name — combines Structure+Verifiability.
export const FAST_LENS_NAME = "structure+verifiability";

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

export const JudgePlanSchema = z
  .object({
    /**
     * When true, the judge is bypassed entirely (detector_confirmed_dead fast).
     * When false, spawn the planned lenses.
     */
    skip: z.boolean(),
    /**
     * The lens names to spawn. Empty when skip=true.
     * For full lane: the five standard names.
     * For fast lane: ['structure+verifiability'].
     */
    lenses: z.array(z.string()),
    /**
     * Model to use for each lens. Empty when skip=true.
     */
    perLensModel: z.record(z.string(), z.enum(["sonnet", "opus"])),
  })
  .strict();

export type JudgePlan = z.infer<typeof JudgePlanSchema>;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ResolveJudgePlanOptions {
  /**
   * The story ref — used only for logging / telemetry; not part of the plan.
   */
  storyId: string;
  /**
   * The judge lane persisted on the manifest by the lane classifier.
   * Absent or `full` → five-lens full panel.
   * `fast` → single cheap lens (or skip if detector_confirmed_dead).
   */
  lane?: "fast" | "full";
  /**
   * True iff the reachability auditor confirmed this is dead-code that is safe
   * to delete without any judge scrutiny. Only meaningful when lane='fast'.
   * Defaults to false.
   */
  detector_confirmed_dead?: boolean;
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the judge lens plan from (lane, detector_confirmed_dead).
 *
 * Pure function — no I/O, no LLM, no side effects.
 *
 * @returns JudgePlan with { skip, lenses, perLensModel }.
 */
export function resolveJudgePlan(opts: ResolveJudgePlanOptions): JudgePlan {
  const lane = opts.lane ?? "full";
  const confirmedDead = opts.detector_confirmed_dead ?? false;

  // full lane (or absent) → five-lens full panel, byte-identical tiering.
  if (lane === "full") {
    return {
      skip: false,
      lenses: [...FULL_LENSES],
      perLensModel: { ...FULL_LENS_MODEL },
    };
  }

  // fast + detector_confirmed_dead → skip entirely.
  if (lane === "fast" && confirmedDead) {
    return {
      skip: true,
      lenses: [],
      perLensModel: {},
    };
  }

  // fast (not confirmed dead) → one cheap combined Structure+Verifiability lens.
  return {
    skip: false,
    lenses: [FAST_LENS_NAME],
    perLensModel: { [FAST_LENS_NAME]: "sonnet" },
  };
}
