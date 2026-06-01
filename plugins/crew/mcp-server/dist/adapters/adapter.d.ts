import type { z } from "zod";
/**
 * Planning-adapter contract.
 *
 * Story 1.1 ships the interface only (with an empty `BmadAdapter`).
 * Story 1.2 extends it with `defaultConfig()` and `adapterConfigSchema`
 * — used by the workspace resolver to synthesise a fresh config and to
 * validate the per-adapter `adapter_config` block from config.yaml.
 * Story 3.1 wires up the registry and `getActiveAdapter()`, and adds
 * the `validateAgainstDiscipline` method signature.
 * Story 3.3 lands the real `BmadAdapter` methods.
 */
export interface PlanningAdapter {
    name: string;
    detect(targetRepo: string): Promise<boolean>;
    listSourceStories(): Promise<SourceStory[]>;
    readSourceStory(ref: string): Promise<SourceStory>;
    resolveSourcePath(ref: string): string;
    watchForChanges?(): AsyncIterable<ChangeEvent>;
    /**
     * Default `adapter_config` block written into `.crew/config.yaml`
     * on first-run auto-detect (Story 1.2 AC2).
     */
    defaultConfig(): Record<string, unknown>;
    /**
     * Zod schema that validates the adapter's `adapter_config` block from
     * a loaded `.crew/config.yaml` (Story 1.2 AC1, AC3).
     */
    adapterConfigSchema: z.ZodTypeAny;
    /**
     * Validate a `SourceStory` against planning-discipline rules and return
     * either the original story (pass) or a structured `DisciplineViolation`
     * (fail).
     *
     * Adapters that have not yet implemented real discipline checks return the
     * input story unchanged. This is the default conformant behaviour. Story 3.5
     * lands the real validator for each adapter.
     *
     * The method is **synchronous** — discipline checks operate on already-
     * normalised `SourceStory` objects in memory; no I/O is required.
     *
     * @see _bmad-output/planning-artifacts/epics/epic-3-backlog-layer-planning-adapters-story-manifests-and-the-planning-conversation.md § Story 3.5
     */
    validateAgainstDiscipline(story: SourceStory): SourceStory | DisciplineViolation;
}
/**
 * A single acceptance criterion.
 *
 * `verification` (Story 10.1) is the structured, machine-readable directive for
 * *how* the AC is checked — `{ type: "vitest" | "artifact", target: "<path>" }`.
 * It is **optional at the type level on purpose**: only the native write/parse
 * path (`parseNativeStory` / `writeNativeStory`) requires it. BMad ACs and any
 * already-persisted manifest leave it `undefined`. (Extracting `verification`
 * from BMad prose markers is the 10.5 ingest seam; checking that `target`
 * resolves to a real file is Tier-0 check T0-6, added in 10.3.)
 */
export type AC = {
    text: string;
    kind: "integration" | "unit";
    verification?: {
        type: "vitest" | "artifact";
        target: string;
    };
};
/**
 * A single planning-discipline rule violation found by
 * `validateAgainstDiscipline`. Story 3.5 will widen `code` to cover its
 * full enforcement enumeration; the union is intentionally narrow here so
 * Story 3.5 can add new string-literal members without breaking existing
 * callers.
 */
export type DisciplineViolationReason = {
    code: "missing-integration-ac" | "implicit-depends-on" | "missing-ship-gate";
    field: string;
    detail: string;
};
/**
 * Returned by `validateAgainstDiscipline` when a story fails one or more
 * planning-discipline checks. The discriminant `kind: "discipline-violation"`
 * allows callers to distinguish pass (returned `SourceStory`) from fail
 * (returned `DisciplineViolation`) without a try/catch.
 *
 * Real enforcement logic lands in Story 3.5. Adapters in this story return
 * the input story unchanged (pass-through) as the conformant default.
 */
export type DisciplineViolation = {
    kind: "discipline-violation";
    ref: string;
    violations: DisciplineViolationReason[];
};
export type SourceStory = {
    ref: string;
    title: string;
    narrative: string;
    acceptance_criteria: AC[];
    depends_on: string[];
    implementation_notes?: string;
    raw_path: string;
    raw_frontmatter: Record<string, unknown>;
    source_hash: string;
};
export type ChangeEvent = {
    kind: "added";
    ref: string;
} | {
    kind: "edited";
    ref: string;
    new_hash: string;
} | {
    kind: "removed";
    ref: string;
};
