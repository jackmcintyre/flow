import { z } from "zod";
/**
 * `docs/risk-tiering.md` schema — the externalised risk-tier rule set the
 * plugin reads on every reviewer verdict (Story 4.9b) to classify each PR
 * as `low | medium | high` risk.
 *
 * Architecture § "Risk-Tier Classification (FR40a) — Spec Format" pins the
 * format. FR40a (`prd-crew-v1/functional-requirements.md`) is the requirement.
 * Story 4.9 (this story) is where the schema, validator, and loader land.
 * Story 4.9b owns the classifier that consumes the parsed spec.
 *
 * `.strict()` is applied at every level — unknown keys indicate spec format
 * drift and must surface as hard errors at parse time rather than silent
 * mismatches at classifier time.
 */
export declare const ChangeTypeSchema: z.ZodEnum<{
    "dep-bump": "dep-bump";
    migration: "migration";
    revert: "revert";
    schema: "schema";
}>;
export declare const DiffSizeThresholdsSchema: z.ZodObject<{
    min_lines_changed: z.ZodOptional<z.ZodNumber>;
    max_lines_changed: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export declare const RuleSchema: z.ZodObject<{
    id: z.ZodString;
    path_patterns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    change_types: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        "dep-bump": "dep-bump";
        migration: "migration";
        revert: "revert";
        schema: "schema";
    }>>>;
    diff_size_thresholds: z.ZodOptional<z.ZodObject<{
        min_lines_changed: z.ZodOptional<z.ZodNumber>;
        max_lines_changed: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    path_excludes: z.ZodOptional<z.ZodArray<z.ZodString>>;
    additive_only: z.ZodOptional<z.ZodBoolean>;
    all_paths_match: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>;
export declare const RiskTieringSpecSchema: z.ZodObject<{
    version: z.ZodString;
    fallback_tier: z.ZodLiteral<"medium">;
    tiers: z.ZodObject<{
        low: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            path_patterns: z.ZodOptional<z.ZodArray<z.ZodString>>;
            change_types: z.ZodOptional<z.ZodArray<z.ZodEnum<{
                "dep-bump": "dep-bump";
                migration: "migration";
                revert: "revert";
                schema: "schema";
            }>>>;
            diff_size_thresholds: z.ZodOptional<z.ZodObject<{
                min_lines_changed: z.ZodOptional<z.ZodNumber>;
                max_lines_changed: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            path_excludes: z.ZodOptional<z.ZodArray<z.ZodString>>;
            additive_only: z.ZodOptional<z.ZodBoolean>;
            all_paths_match: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>>;
        medium: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            path_patterns: z.ZodOptional<z.ZodArray<z.ZodString>>;
            change_types: z.ZodOptional<z.ZodArray<z.ZodEnum<{
                "dep-bump": "dep-bump";
                migration: "migration";
                revert: "revert";
                schema: "schema";
            }>>>;
            diff_size_thresholds: z.ZodOptional<z.ZodObject<{
                min_lines_changed: z.ZodOptional<z.ZodNumber>;
                max_lines_changed: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            path_excludes: z.ZodOptional<z.ZodArray<z.ZodString>>;
            additive_only: z.ZodOptional<z.ZodBoolean>;
            all_paths_match: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>>;
        high: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            path_patterns: z.ZodOptional<z.ZodArray<z.ZodString>>;
            change_types: z.ZodOptional<z.ZodArray<z.ZodEnum<{
                "dep-bump": "dep-bump";
                migration: "migration";
                revert: "revert";
                schema: "schema";
            }>>>;
            diff_size_thresholds: z.ZodOptional<z.ZodObject<{
                min_lines_changed: z.ZodOptional<z.ZodNumber>;
                max_lines_changed: z.ZodOptional<z.ZodNumber>;
            }, z.core.$strict>>;
            path_excludes: z.ZodOptional<z.ZodArray<z.ZodString>>;
            additive_only: z.ZodOptional<z.ZodBoolean>;
            all_paths_match: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strict>>>;
    }, z.core.$strict>;
}, z.core.$strict>;
export type ChangeType = z.infer<typeof ChangeTypeSchema>;
export type Rule = z.infer<typeof RuleSchema>;
/**
 * The on-disk shape (`version`, `fallback_tier`, `tiers`) plus the
 * `sourcePath` stamp appended by `lookupRiskTieringSpec` after parsing.
 * `sourcePath` is NOT part of the YAML contract.
 */
export type RiskTieringSpec = z.infer<typeof RiskTieringSpecSchema> & {
    sourcePath: string;
};
