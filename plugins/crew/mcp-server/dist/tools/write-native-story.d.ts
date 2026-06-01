import { z } from "zod";
/**
 * Input schema for `writeNativeStory`. Mirrors the four-section native-story
 * body shape (Story 3.4 Task 4.1).
 */
export declare const WriteNativeStoryInputSchema: z.ZodObject<{
    targetRepoRoot: z.ZodString;
    title: z.ZodString;
    narrative: z.ZodObject<{
        role: z.ZodString;
        want: z.ZodString;
        so_that: z.ZodString;
    }, z.core.$strip>;
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
    tasks: z.ZodArray<z.ZodObject<{
        text: z.ZodString;
        ac_refs: z.ZodArray<z.ZodString>;
    }, z.core.$strip>>;
    cited_sources: z.ZodArray<z.ZodString>;
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
 * Render the canonical narrative sentence from the structured parts (Story
 * 10.2). `parseNativeStory` parses exactly this grammar back into
 * `narrative_struct`, so the render here is the single source of the round-trip
 * contract.
 */
export declare function renderNarrativeSentence(narrative: WriteNativeStoryInput["narrative"]): string;
/**
 * Render a native-story file body from validated inputs.
 *
 * Produces the canonical section order:
 *   1. `## Narrative`
 *   2. `## Acceptance Criteria`
 *   3. `## Tasks`
 *   4. `## Cited Sources`
 *   5. `## Implementation Notes` (omitted if empty/absent)
 *   6. `## Dependencies`
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
/**
 * The shared native-write internal (Story 10.5): render → discipline-gate →
 * round-trip-parse → atomic-write, mints a fresh ULID, emits the
 * `draft.authored` telemetry event, returns `{ ref, path }`.
 *
 * Deliberately does NOT run the `WrongAdapterError` active-adapter guard — that
 * is `writeNativeStory`'s responsibility, applied before calling here. The BMad
 * → native ingest reuses this directly so it can write native stories while the
 * active adapter is still `bmad` (it ingests first, cuts over second).
 *
 * The Tier-0 gate (`validateStoryAgainstDiscipline` + `resolveDisciplinePaths`)
 * is the SOLE arbiter of whether the candidate is written: a violating candidate
 * throws `DisciplineViolationError` and NOTHING is written (no file, no
 * telemetry). For ingest this is load-bearing — the lossy LLM enrichment cannot
 * smuggle a non-compliant story through; the deterministic gate decides.
 *
 * @param input          a validated `WriteNativeStoryInput`.
 * @param targetRepoRoot the resolved repo root (already `path.resolve`d).
 * @param agent          telemetry `agent` field — "author" for the native write
 *                       path, "ingest" for the BMad→native seam.
 */
export declare function renderGateWriteNativeStory(input: WriteNativeStoryInput, targetRepoRoot: string, agent?: "author" | "ingest"): Promise<WriteNativeStoryOutput>;
