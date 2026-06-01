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
import { WrongAdapterError } from "../errors.js";
import { resolveWorkspace } from "../state/workspace-resolver.js";
import { validateBacklogAgainstDiscipline, validateStoryAgainstDiscipline, } from "../validators/planning-discipline.js";
// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------
export const PendingStoryInputSchema = z.object({
    title: z.string().min(1),
    narrative: z.string().min(1),
    acceptance_criteria: z
        .array(z.object({
        text: z.string().min(1),
        kind: z.enum(["integration", "unit"]),
    }))
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
});
export const ValidatePlannerBacklogInputSchema = z.object({
    targetRepoRoot: z.string().min(1),
    pendingStories: z.array(PendingStoryInputSchema).min(1, {
        message: "pendingStories must contain at least one story. Calling with an empty batch is a caller bug.",
    }),
});
// ---------------------------------------------------------------------------
// Synthesise SourceStory from PendingStoryInput
// ---------------------------------------------------------------------------
function pendingToSourceStory(pending, index) {
    return {
        // A `pending:<n>` pseudo-ref — deliberately NOT `native:` so the Story 10.3
        // Tier-0 §3 checks (T0-1/T0-2, gated to native/enriched stories via
        // `isEnrichedStory`) do NOT fire here. This pre-write planning batch carries
        // only the legacy discipline-rule fields (the PendingStoryInput schema has
        // no `verification`/`tasks`/`cited_sources`); the §3 fields are present and
        // enforced at `writeNativeStory` (which builds a real `native:` ref from the
        // enriched input). Running §3 here would falsely block every pre-write batch.
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
// ---------------------------------------------------------------------------
// Main implementation
// ---------------------------------------------------------------------------
/**
 * Validate a batch of pending stories against planning-discipline rules.
 *
 * The planner subagent calls this before every `writeNativeStory` and before
 * emitting the locked handoff phrase.
 */
export async function validatePlannerBacklog(rawInput) {
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
    const allViolations = [];
    // Synthesise SourceStory objects from pending inputs.
    const pendingStories = input.pendingStories.map((p, i) => pendingToSourceStory(p, i));
    // Per-story discipline checks.
    for (let i = 0; i < input.pendingStories.length; i++) {
        const pending = input.pendingStories[i];
        const story = pendingStories[i];
        const stateMutatingOverride = pending.state_mutating === "auto" ? undefined : pending.state_mutating;
        const result = validateStoryAgainstDiscipline(story, {
            stateMutating: stateMutatingOverride,
        });
        if ("kind" in result && result.kind === "discipline-violation") {
            allViolations.push(result);
        }
    }
    // Backlog-level ship-gate check.
    // Read already-on-disk native stories to include in the ship-gate search.
    // If listing fails we proceed with an empty existing-stories list (best-effort)
    // so that per-story violations already accumulated are not discarded. The I/O
    // error is recorded as a detail on the missing-ship-gate violation that the
    // backlog check will produce (if no ship-gate story exists in the pending batch
    // alone), giving the operator enough context to diagnose the problem.
    let existingStories = [];
    let listStoriesErrorDetail;
    try {
        existingStories = await workspace.activeAdapter.listSourceStories();
    }
    catch (err) {
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
                    r.detail =
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
