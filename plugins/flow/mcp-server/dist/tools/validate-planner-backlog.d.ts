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
import { z } from "zod";
import type { DisciplineViolation } from "../adapters/adapter.js";
export declare const PendingStoryInputSchema: z.ZodObject<{
    title: z.ZodString;
    narrative: z.ZodString;
    acceptance_criteria: z.ZodArray<z.ZodObject<{
        text: z.ZodString;
        kind: z.ZodEnum<{
            integration: "integration";
            unit: "unit";
        }>;
    }, z.core.$strip>>;
    implementation_notes: z.ZodOptional<z.ZodString>;
    depends_on: z.ZodArray<z.ZodString>;
    ship_gate: z.ZodBoolean;
    state_mutating: z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"auto">]>;
}, z.core.$strip>;
export type PendingStoryInput = z.infer<typeof PendingStoryInputSchema>;
export declare const ValidatePlannerBacklogInputSchema: z.ZodObject<{
    targetRepoRoot: z.ZodString;
    pendingStories: z.ZodArray<z.ZodObject<{
        title: z.ZodString;
        narrative: z.ZodString;
        acceptance_criteria: z.ZodArray<z.ZodObject<{
            text: z.ZodString;
            kind: z.ZodEnum<{
                integration: "integration";
                unit: "unit";
            }>;
        }, z.core.$strip>>;
        implementation_notes: z.ZodOptional<z.ZodString>;
        depends_on: z.ZodArray<z.ZodString>;
        ship_gate: z.ZodBoolean;
        state_mutating: z.ZodUnion<readonly [z.ZodBoolean, z.ZodLiteral<"auto">]>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type ValidatePlannerBacklogOutput = {
    ok: true;
} | {
    ok: false;
    violations: DisciplineViolation[];
};
/**
 * Validate a batch of pending stories against planning-discipline rules.
 *
 * The planner subagent calls this before every `writeNativeStory` and before
 * emitting the locked handoff phrase.
 */
export declare function validatePlannerBacklog(rawInput: unknown): Promise<ValidatePlannerBacklogOutput>;
