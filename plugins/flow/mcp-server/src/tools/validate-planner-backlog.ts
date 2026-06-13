/**
 * `validatePlannerBacklog` MCP tool (Story 3.5 Task 5).
 *
 * The planner subagent MUST call this tool before every `writeNativeStory`
 * invocation and before emitting the locked handoff phrase. The tool runs
 * all planning-discipline checks against the pending story batch and returns
 * a structured pass/fail result.
 *
 * Contract:
 *   - Returns `{ ok: true }` on full pass.
 *   - Returns `{ ok: false; violations: DisciplineViolation[] }` on any failure.
 *   - NEVER throws on discipline failure; throws only on wrong adapter,
 *     malformed input, or empty `pendingStories`.
 *   - Does NOT write any file. Write is `writeNativeStory`'s job.
 *
 * @see _bmad-output/implementation-artifacts/3-5-planning-discipline-validation-at-authoring-and-scan-time.md § Task 5
 */

import { createHash } from "node:crypto";
import * as path from "node:path";
import { z } from "zod";
import type { DisciplineViolation, SourceStory } from "../adapters/adapter.js";
import { WrongAdapterError } from "../errors.js";
import { resolveWorkspace } from "../state/workspace-resolver.js";
import {
  validateBacklogAgainstDiscipline,
  validateStoryAgainstDiscipline,
} from "../validators/planning-discipline.js";
import { resolveDisciplinePaths } from "../validators/discipline-resolvability.js";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const PendingStoryInputSchema = z.object({
  title: z.string().min(1),
  narrative: z.string().min(1),
  acceptance_criteria: z
    .array(
      z.object({
        text: z.string().min(1),
        kind: z.enum(["integration", "unit"]),
        /**
         * OPTIONAL — mirrors the enriched `verification` field from
         * `writeNativeStory`. When present, the pre-submit check engages the
         * shared resolvability checker (T0-6) against this target.
         * `vitest:` targets are shape-checked but NOT existence-checked (the
         * build creates the test file). `artifact:` targets must resolve on disk.
         *
         * Absent on a legacy planning batch — keeping it optional ensures a
         * batch with neither field validates exactly as it does today.
         */
        verification: z
          .object({
            type: z.enum(["vitest", "artifact"]),
            target: z.string().min(1),
          })
          .optional(),
      }),
    )
    .min(1),
  implementation_notes: z.string().optional(),
  depends_on: z.array(z.string()),
  ship_gate: z.boolean(),
  /**
   * `"auto"` — run the heuristic (default).
   * `true` — force state-mutating treatment (operator-declared exception).
   * `false` — suppress heuristic (operator dismissed a false positive).
   */
  state_mutating: z.union([z.boolean(), z.literal("auto")]),
  /**
   * OPTIONAL — mirrors the enriched `cited_sources` field from
   * `writeNativeStory`. When present and non-empty, the pre-submit check runs
   * the shared resolvability checker (T0-5) to verify each path resolves on
   * disk.
   *
   * Absent on a legacy planning batch — keeping it optional ensures a batch
   * with neither field validates exactly as it does today.
   */
  cited_sources: z.array(z.string().min(1)).optional(),
});

type PendingStoryInput = z.infer<typeof PendingStoryInputSchema>;

const ValidatePlannerBacklogInputSchema = z.object({
  targetRepoRoot: z.string().min(1),
  pendingStories: z.array(PendingStoryInputSchema).min(1, {
    message:
      "pendingStories must contain at least one story. Calling with an empty batch is a caller bug.",
  }),
});

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export type ValidatePlannerBacklogOutput =
  | { ok: true }
  | { ok: false; violations: DisciplineViolation[] };

// ---------------------------------------------------------------------------
// Synthesise SourceStory from PendingStoryInput
// ---------------------------------------------------------------------------

/**
 * Whether a pending story carries enriched fields (cited_sources and/or any
 * per-AC verification). When true, the pre-submit check engages the shared
 * resolvability pass in addition to the existing pure discipline rules.
 */
function hasEnrichedFields(pending: PendingStoryInput): boolean {
  if (pending.cited_sources && pending.cited_sources.length > 0) return true;
  return pending.acceptance_criteria.some((ac) => ac.verification !== undefined);
}

/**
 * Synthesise a `SourceStory` from a pending input for the PURE discipline
 * validator (`validateStoryAgainstDiscipline`).
 *
 * Uses a `pending:<n>` ref — deliberately NOT `native:` — so the Tier-0 §3
 * checks (T0-1/T0-2, gated to `isEnrichedStory`) do NOT fire here. The
 * pending schema carries neither `tasks` (T0-1) nor the full enriched field
 * set that T0-2 would require; those checks run at `writeNativeStory` time.
 * Running §3 here would falsely block every pre-write batch.
 */
function pendingToSourceStory(pending: PendingStoryInput, index: number): SourceStory {
  return {
    ref: `pending:${index}`,
    title: pending.title,
    narrative: pending.narrative,
    acceptance_criteria: pending.acceptance_criteria,
    depends_on: pending.depends_on,
    implementation_notes: pending.implementation_notes,
    raw_path: "",
    raw_frontmatter: { ship_gate: pending.ship_gate },
    source_hash: "",
  };
}

/**
 * Synthesise a `SourceStory` from an enriched pending input for the DISK-SIDE
 * resolvability validator (`resolveDisciplinePaths`).
 *
 * Uses a `native:pending:<n>` ref so `isEnrichedStory` returns `true` and
 * `resolveDisciplinePaths` actually runs the T0-5/T0-6 checks. Without the
 * `native:` prefix the resolvability pass silently returns `[]` — the key
 * gotcha the story's implementation notes call out.
 *
 * This story is ONLY passed to `resolveDisciplinePaths`, never to
 * `validateStoryAgainstDiscipline`: the pure validator would fire T0-1
 * (missing tasks) and T0-2 for any AC lacking a verification block on a
 * `native:`-prefixed story, producing false positives for fields that the
 * pending schema intentionally omits (tasks are not present at plan time;
 * ACs without verification are still valid at pre-submit time).
 */
function pendingToEnrichedSourceStory(pending: PendingStoryInput, index: number): SourceStory {
  return {
    ref: `native:pending:${index}`,
    title: pending.title,
    narrative: pending.narrative,
    acceptance_criteria: pending.acceptance_criteria,
    depends_on: pending.depends_on,
    implementation_notes: pending.implementation_notes,
    cited_sources: pending.cited_sources,
    raw_path: "",
    raw_frontmatter: { ship_gate: pending.ship_gate },
    source_hash: "",
  };
}

// ---------------------------------------------------------------------------
// Main implementation
// ---------------------------------------------------------------------------

/**
 * Validate a batch of pending stories against planning-discipline rules.
 *
 * The planner subagent calls this before every `writeNativeStory` and before
 * emitting the locked handoff phrase.
 */
export async function validatePlannerBacklog(
  rawInput: unknown,
): Promise<ValidatePlannerBacklogOutput> {
  const input = ValidatePlannerBacklogInputSchema.parse(rawInput);
  const targetRepoRoot = path.resolve(input.targetRepoRoot);

  // Guard: native-only tool.
  const workspace = await resolveWorkspace({ targetRepoRoot });
  if (workspace.activeAdapterName !== "native") {
    throw new WrongAdapterError({
      expectedAdapter: "native",
      actualAdapter: workspace.activeAdapterName,
      targetRepoRoot,
      toolName: "validatePlannerBacklog",
    });
  }

  const allViolations: DisciplineViolation[] = [];

  // Synthesise SourceStory objects from pending inputs.
  const pendingStories: SourceStory[] = input.pendingStories.map((p, i) =>
    pendingToSourceStory(p, i),
  );

  // Per-story discipline checks.
  for (let i = 0; i < input.pendingStories.length; i++) {
    const pending = input.pendingStories[i]!;
    const story = pendingStories[i]!;

    const stateMutatingOverride =
      pending.state_mutating === "auto" ? undefined : pending.state_mutating;

    const result = validateStoryAgainstDiscipline(story, {
      stateMutating: stateMutatingOverride,
    });

    if ("kind" in result && result.kind === "discipline-violation") {
      allViolations.push(result);
    }

    // Resolvability pass — only when the pending story carries enriched fields
    // (cited_sources and/or per-AC verification). The shared `resolveDisciplinePaths`
    // implementation is the SAME one the save gate (`writeNativeStory`) calls, so
    // both gates enforce identically (AC3 parity guarantee).
    //
    // IMPORTANT: `resolveDisciplinePaths` gates on `isEnrichedStory`, which
    // checks the `native:` ref prefix. We synthesise a SEPARATE enriched story
    // under a `native:pending:<n>` ref for this call. We do NOT pass this
    // enriched story to `validateStoryAgainstDiscipline` — the pure validator
    // would fire T0-1 (no tasks) and T0-2 (ACs without verification) producing
    // false positives for fields the pending schema intentionally omits.
    if (hasEnrichedFields(pending)) {
      const enrichedStory = pendingToEnrichedSourceStory(pending, i);
      const resolvabilityReasons = await resolveDisciplinePaths(enrichedStory, targetRepoRoot);
      if (resolvabilityReasons.length > 0) {
        // Merge resolvability violations into a DisciplineViolation envelope for
        // this story, matching the shape the pure validator produces.
        allViolations.push({
          kind: "discipline-violation",
          ref: enrichedStory.ref,
          violations: resolvabilityReasons,
        });
      }
    }
  }

  // Backlog-level ship-gate check.
  // Read already-on-disk native stories to include in the ship-gate search.
  // If listing fails we proceed with an empty existing-stories list (best-effort)
  // so that per-story violations already accumulated are not discarded. The I/O
  // error is recorded as a detail on the missing-ship-gate violation that the
  // backlog check will produce (if no ship-gate story exists in the pending batch
  // alone), giving the operator enough context to diagnose the problem.
  let existingStories: SourceStory[] = [];
  let listStoriesErrorDetail: string | undefined;
  try {
    existingStories = await workspace.activeAdapter.listSourceStories();
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    console.error(`[validatePlannerBacklog] Could not list existing stories: ${errMessage}`);
    listStoriesErrorDetail = `Could not list existing stories: ${errMessage}; ship-gate check skipped for on-disk stories`;
    // Continue with existingStories = [] — best-effort behaviour that preserves
    // per-story violations already collected above.
  }

  const backlogViolations = validateBacklogAgainstDiscipline(pendingStories, {
    existingStories,
    backlogPseudoRef: `backlog:${createHash("sha256").update(targetRepoRoot).digest("hex").slice(0, 8)}`,
  });

  // If listing on-disk stories failed, annotate any missing-ship-gate violation
  // with the I/O error context so the operator understands why the check may be
  // incomplete. If no missing-ship-gate violation was produced (pending batch
  // already contains a ship-gate story), no annotation is needed.
  if (listStoriesErrorDetail !== undefined) {
    for (const v of backlogViolations) {
      for (const r of v.violations) {
        if (r.code === "missing-ship-gate") {
          (r as { code: string; field: string; detail: string }).detail =
            `${r.detail} (Note: ${listStoriesErrorDetail})`;
        }
      }
    }
  }

  allViolations.push(...backlogViolations);

  if (allViolations.length === 0) {
    return { ok: true };
  }

  return { ok: false, violations: allViolations };
}
