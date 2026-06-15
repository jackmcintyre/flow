/**
 * `resolveBuildPlan` tool — Story native:01KTKK3HQYNFS1M1ZR9TG02G1F.
 *
 * A pure deterministic function mapping a story's lane to a build plan:
 *   { devReviewerModel, reviewDepth }
 *
 * **Lane→plan mapping:**
 *
 * - `fast` lane: cheap model tier (haiku) + light review.
 *   { devReviewerModel: 'haiku', reviewDepth: 'light' }
 *
 * - `full` (or absent) lane: the current Sonnet default + full review.
 *   { devReviewerModel: 'sonnet', reviewDepth: 'full' }
 *
 * **Conservative-by-default:**
 * Any absent or unknown lane defaults to `full`. When called with a
 * `manifestPath`, the tool reads the lane from the persisted execution
 * manifest (written at scan time by the lane classifier). When called with
 * `lane` directly it is a pure function with no I/O. The dev's pre-PR
 * build+test gate (runDevTerminalAction) and the merge gate
 * (runAutoMergeGate) are unchanged — the cheaper path sits entirely in
 * front of the same hard gates.
 *
 * **Why these models?**
 * The run's existing `devReviewerModel` arg already accepts any model string
 * as an override channel (Story FU6). `resolveBuildPlan` is the authoritative
 * mapping from lane → model for per-story routing; operators can still override
 * the whole run via the launch arg (which takes precedence over any per-story
 * lane in practice if set explicitly).
 *
 * Per the run cost-reduction plan (Phase 3), this subsumes the previously-
 * deferred risk-tier model routing.
 */

import { z } from "zod";
import { readFile } from "node:fs/promises";
import { parse as yamlParse } from "yaml";

// ---------------------------------------------------------------------------
// Constants — the fast-lane model tier.
// The full-lane default matches the FU6 Sonnet pin in run.workflow.js.
// ---------------------------------------------------------------------------

/** Model used for both dev and reviewer on the fast lane. */
export const FAST_LANE_MODEL = "haiku" as const;

/** Model used for both dev and reviewer on the full lane (the current default). */
export const FULL_LANE_MODEL = "sonnet" as const;

/** Review depth for the fast lane (light review). */
export const FAST_REVIEW_DEPTH = "light" as const;

/** Review depth for the full lane (the current default). */
export const FULL_REVIEW_DEPTH = "full" as const;

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

export const BuildPlanSchema = z
  .object({
    /**
     * Model string for both the dev and reviewer subagents.
     * Routed into the existing `devReviewerModel` arg / `model` option on
     * agent() calls — same channel as the FU6 per-run override.
     */
    devReviewerModel: z.string().min(1),
    /**
     * Review depth directive for the reviewer step.
     * 'light' → the reviewer performs a targeted check (no deep five-lens judge);
     * 'full'  → the current full review behaviour (unchanged).
     */
    reviewDepth: z.enum(["light", "full"]),
  })
  .strict();

export type BuildPlan = z.infer<typeof BuildPlanSchema>;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ResolveBuildPlanOptions {
  /**
   * The story ref — used only for logging / telemetry; not part of the plan.
   */
  storyId: string;
  /**
   * The judge lane persisted on the manifest by the lane classifier (Story
   * native:01KTKJXP6DWN5YHKVG96DH16V0). Absent or 'full' → full defaults.
   *
   * When `manifestPath` is also provided, the lane read from the manifest
   * takes precedence over this field.
   */
  lane?: "fast" | "full";
  /**
   * Absolute path to the execution manifest. When provided, the tool reads
   * the `lane` field from the manifest (written at scan time by the lane
   * classifier); callers that already have the lane value in memory can omit
   * this and pass `lane` directly for a pure no-I/O call.
   */
  manifestPath?: string;
}

// ---------------------------------------------------------------------------
// Internal: read the lane from a manifest file
// ---------------------------------------------------------------------------

/**
 * Read the `lane` field from a persisted execution manifest.
 * Returns `undefined` (→ full defaults) when the field is absent, the file
 * is missing, or the value is not a recognised lane string.
 *
 * @internal
 */
async function readLaneFromManifest(
  manifestPath: string,
): Promise<"fast" | "full" | undefined> {
  try {
    const raw = await readFile(manifestPath, "utf8");
    const parsed = yamlParse(raw) as Record<string, unknown> | null;
    const lane = parsed?.lane;
    if (lane === "fast" || lane === "full") return lane;
    return undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the build plan (dev/reviewer model + review depth) from a story's lane.
 *
 * When `manifestPath` is provided: reads the lane from the manifest (I/O).
 * When only `lane` is provided: pure function, no I/O.
 *
 * @returns BuildPlan with { devReviewerModel, reviewDepth }.
 */
export async function resolveBuildPlan(opts: ResolveBuildPlanOptions): Promise<BuildPlan> {
  let lane: "fast" | "full";

  if (opts.manifestPath) {
    const manifestLane = await readLaneFromManifest(opts.manifestPath);
    lane = manifestLane ?? opts.lane ?? "full";
  } else {
    lane = opts.lane ?? "full";
  }

  if (lane === "fast") {
    return {
      devReviewerModel: FAST_LANE_MODEL,
      reviewDepth: FAST_REVIEW_DEPTH,
    };
  }

  // full (or absent/unknown) → current Sonnet defaults.
  return {
    devReviewerModel: FULL_LANE_MODEL,
    reviewDepth: FULL_REVIEW_DEPTH,
  };
}
