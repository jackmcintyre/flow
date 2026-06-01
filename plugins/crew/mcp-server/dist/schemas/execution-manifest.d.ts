import { z } from "zod";
/**
 * Zod schema for execution manifests.
 *
 * **Producer:** `scan-sources.ts` creates manifests; Story 4.1 adds two more:
 *   - New source stories → `to-do/<ref>.yaml` with `status: "to-do"`.
 *   - Discipline violations → `blocked/<ref>.yaml` with `status: "blocked"`
 *     and the `blocked_by` / `discipline_violations` fields populated
 *     (Story 3.5 Task 6.2).
 *   - `claimStory` writes `"in-progress"` on the `to-do → in-progress`
 *     transition (Story 4.1 FR17).
 *   - `completeStory` writes `"done"` on the `in-progress → done` transition
 *     (Story 4.1 FR19).
 *
 * **Consumer:** Every future reader MUST go through `parseExecutionManifest`
 * rather than calling `ExecutionManifestSchema.parse` directly.
 *
 * **Status vocabulary (Story 4.1 widening):** This schema accepts `"to-do"`,
 * `"blocked"`, `"in-progress"`, and `"done"`. Previous stories asserted that
 * `"in-progress"` was rejected — those assertions MUST be flipped to assert
 * acceptance. The widening is additive: existing `to-do/` and `blocked/`
 * manifests parse unchanged.
 *
 * **Strict mode:** `.strict()` is intentional — unknown keys are rejected so
 * additive future fields force a coordinated schema bump rather than silent
 * acceptance via Zod's default `strip` mode. Story 4.1 added `claimed_by` and
 * widened the `status` enum; a `yaml.stringify(parseExecutionManifest(...))`
 * round-trip of an `in-progress/` or `done/` manifest preserves all fields.
 *
 * Field order mirrors the intended on-disk YAML field order so that a
 * `yaml.stringify(schema.parse(obj))` round-trip produces stable output.
 */
export declare const ExecutionManifestSchema: z.ZodObject<{
    ref: z.ZodString;
    status: z.ZodEnum<{
        blocked: "blocked";
        done: "done";
        "in-progress": "in-progress";
        "to-do": "to-do";
    }>;
    adapter: z.ZodString;
    source_path: z.ZodString;
    source_hash: z.ZodString;
    depends_on: z.ZodDefault<z.ZodArray<z.ZodString>>;
    acceptance_criteria: z.ZodArray<z.ZodObject<{
        text: z.ZodString;
        kind: z.ZodEnum<{
            integration: "integration";
            unit: "unit";
        }>;
        verification: z.ZodOptional<z.ZodObject<{
            type: z.ZodEnum<{
                artifact: "artifact";
                vitest: "vitest";
            }>;
            target: z.ZodString;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    title: z.ZodString;
    narrative: z.ZodString;
    implementation_notes: z.ZodOptional<z.ZodString>;
    withdrawn: z.ZodDefault<z.ZodBoolean>;
    ready: z.ZodDefault<z.ZodBoolean>;
    blocked_by: z.ZodOptional<z.ZodEnum<{
        "deps-drift": "deps-drift";
        "gh-defer": "gh-defer";
        "gh-needs-human": "gh-needs-human";
        "gh-retry": "gh-retry";
        "handoff-grammar": "handoff-grammar";
        "needs-human-decision": "needs-human-decision";
        "orphan-no-transcript": "orphan-no-transcript";
        "planning-discipline": "planning-discipline";
        "reviewer-grammar": "reviewer-grammar";
        "reviewer-no-session-result": "reviewer-no-session-result";
        "reviewer-verdict-blocked": "reviewer-verdict-blocked";
        "reviewer-verdict-needs-changes": "reviewer-verdict-needs-changes";
        "routing-failure": "routing-failure";
        "routing-self-yield": "routing-self-yield";
    }>>;
    discipline_violations: z.ZodOptional<z.ZodArray<z.ZodObject<{
        code: z.ZodString;
        field: z.ZodString;
        detail: z.ZodString;
    }, z.core.$strip>>>;
    claimed_by: z.ZodOptional<z.ZodString>;
    rework_count: z.ZodOptional<z.ZodNumber>;
    drain_resume_attempts: z.ZodOptional<z.ZodNumber>;
    risk_tier: z.ZodOptional<z.ZodEnum<{
        high: "high";
        low: "low";
        medium: "medium";
    }>>;
    risk_tier_evidence: z.ZodOptional<z.ZodObject<{
        matched_rule: z.ZodString;
        paths: z.ZodDefault<z.ZodArray<z.ZodString>>;
        change_types: z.ZodDefault<z.ZodArray<z.ZodEnum<{
            "dep-bump": "dep-bump";
            migration: "migration";
            revert: "revert";
            schema: "schema";
        }>>>;
        diff_size: z.ZodNumber;
    }, z.core.$strict>>;
    lessons: z.ZodOptional<z.ZodArray<z.ZodObject<{
        kind: z.ZodEnum<{
            discipline: "discipline";
            pattern: "pattern";
            pitfall: "pitfall";
            "tool-quirk": "tool-quirk";
        }>;
        text: z.ZodString;
        failure_class: z.ZodOptional<z.ZodString>;
        routed_to: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>;
    failure_class: z.ZodOptional<z.ZodString>;
    duration_seconds: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export type ExecutionManifest = z.infer<typeof ExecutionManifestSchema>;
/**
 * Canonical reader for execution manifests.
 *
 * **Every future reader MUST go through this helper.** Callers should never
 * call `ExecutionManifestSchema.parse` / `.safeParse` directly because this
 * helper is the only place that maps Zod validation failures to the typed
 * `MalformedExecutionManifestError` that downstream tooling (Story 3.5,
 * Story 4.x) pattern-matches against.
 *
 * @param input - The raw parsed YAML object (result of `yaml.parse(rawText)`).
 * @param opts.absPath - Absolute path to the manifest file, for error context.
 * @throws {MalformedExecutionManifestError} When `input` fails schema
 *   validation (missing required field, wrong type, unknown key, etc.).
 */
export declare function parseExecutionManifest(input: unknown, opts: {
    absPath: string;
}): ExecutionManifest;
