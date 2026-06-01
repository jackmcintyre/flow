import { z } from "zod";
/**
 * Input schema for `writeNativeStory`. Mirrors the four-section native-story
 * body shape (Story 3.4 Task 4.1).
 */
export declare const WriteNativeStoryInputSchema: z.ZodObject<{
    targetRepoRoot: z.ZodString;
    title: z.ZodString;
    narrative: z.ZodString;
    acceptance_criteria: z.ZodArray<z.ZodObject<{
        text: z.ZodString;
        kind: z.ZodEnum<{
            integration: "integration";
            unit: "unit";
        }>;
        verification: z.ZodObject<{
            type: z.ZodEnum<{
                artifact: "artifact";
                vitest: "vitest";
            }>;
            target: z.ZodString;
        }, z.core.$strip>;
    }, z.core.$strip>>;
    implementation_notes: z.ZodOptional<z.ZodString>;
    depends_on: z.ZodArray<z.ZodString>;
    sessionUlid: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type WriteNativeStoryInput = z.infer<typeof WriteNativeStoryInputSchema>;
export interface WriteNativeStoryOutput {
    ref: string;
    path: string;
}
/**
 * Render a native-story file body from validated inputs.
 *
 * Produces the canonical four-section order:
 *   1. `## Narrative`
 *   2. `## Acceptance Criteria`
 *   3. `## Implementation Notes` (omitted if empty/absent)
 *   4. `## Dependencies`
 */
export declare function renderNativeStoryBody(input: WriteNativeStoryInput): string;
/**
 * Write a new native-story file under `<targetRepoRoot>/.crew/native-stories/`.
 *
 * Steps:
 *   1. Resolve workspace; throw `WrongAdapterError` if not `native`.
 *   2. Generate a fresh ULID.
 *   3. Render the four-section body.
 *   4. Round-trip through `parseNativeStory()` — throw if invalid.
 *   5. Write atomically (`.tmp` + rename).
 *   6. Return `{ ref, path }`.
 *
 * @see _bmad-output/implementation-artifacts/3-4-native-adapter-planner-subagent-and-plan-skill.md § Task 4
 */
export declare function writeNativeStory(rawInput: unknown): Promise<WriteNativeStoryOutput>;
