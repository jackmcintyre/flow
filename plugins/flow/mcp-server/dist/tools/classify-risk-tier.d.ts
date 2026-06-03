/**
 * `classifyRiskTier` MCP tool — Story 4.9b.
 *
 * FR40a: risk-tier classifier that consumes the loaded risk-tiering spec from
 * Story 4.9 plus a PR's diff signals, returning the Pattern §11 output shape.
 *
 * **Highest-tier-wins contract (Pattern §11):**
 * The classifier walks tiers in `high → medium → low` order (NOT declaration
 * order). Within each tier, rules are walked in their declared array order.
 * The first matching rule stops the walk. This means any matching `high` rule
 * wins over any matching `low` or `medium` rule — false negatives on `high`
 * are dangerous (a migration auto-merged); false positives on `high` merely
 * pause-for-human.
 *
 * **No typed errors of its own:**
 * The tool propagates `lookupRiskTieringSpec`'s errors
 * (`MalformedRiskTieringSpecError`, `ShippedRiskTieringDefaultMissingError`)
 * verbatim. The caller (`runReviewerSession`) is responsible for surfacing them.
 *
 * **Fallback sentinel:**
 * When no rule matches across all tiers, returns `tier: spec.fallback_tier`
 * (structurally "medium") and `matched_rule: "fallback"`.
 */
import { z } from "zod";
import type { ChangeType } from "../schemas/risk-tiering-spec.js";
/**
 * Pattern §11 full output shape including `story_id`.
 * Used as the tool's return value.
 */
export declare const RiskTierClassifierResultSchema: z.ZodObject<{
    story_id: z.ZodString;
    tier: z.ZodEnum<{
        high: "high";
        low: "low";
        medium: "medium";
    }>;
    matched_rule: z.ZodString;
    evidence: z.ZodObject<{
        paths: z.ZodArray<z.ZodString>;
        change_types: z.ZodArray<z.ZodEnum<{
            "dep-bump": "dep-bump";
            migration: "migration";
            revert: "revert";
            schema: "schema";
        }>>;
        diff_size: z.ZodNumber;
    }, z.core.$strict>;
}, z.core.$strict>;
/**
 * On-disk shape used inside `reviewer-result.json` — `story_id` is omitted
 * because the file already carries `ref` at its top level (single source of truth).
 *
 * Consumed by `read-reviewer-result-file.ts` (Task 6).
 */
export declare const RiskTierBlockSchema: z.ZodObject<{
    matched_rule: z.ZodString;
    evidence: z.ZodObject<{
        paths: z.ZodArray<z.ZodString>;
        change_types: z.ZodArray<z.ZodEnum<{
            "dep-bump": "dep-bump";
            migration: "migration";
            revert: "revert";
            schema: "schema";
        }>>;
        diff_size: z.ZodNumber;
    }, z.core.$strict>;
    tier: z.ZodEnum<{
        high: "high";
        low: "low";
        medium: "medium";
    }>;
}, z.core.$strict>;
export type RiskTierClassifierResult = z.infer<typeof RiskTierClassifierResultSchema>;
export type RiskTierBlock = z.infer<typeof RiskTierBlockSchema>;
export interface ClassifyRiskTierOptions {
    targetRepoRoot: string;
    pluginRoot: string;
    storyId: string;
    /** POSIX-style relative paths, e.g. `["src/foo.ts", "docs/README.md"]` */
    changedPaths: string[];
    /** Verbatim commit subject lines */
    commitMessages: string[];
    /** Total lines added + removed across the PR */
    diffSize: number;
    /**
     * True iff every changed file in the PR is a brand-new file addition — no
     * existing file modified/deleted/renamed (Stage-2 part C). Defaults to
     * `false` when omitted (callers that cannot compute it stay conservative).
     */
    additiveOnly?: boolean;
}
/**
 * For a given set of detected `ChangeType` values, return the subset of
 * `changedPaths` that triggered any of those change types.
 *
 * Used to populate `evidence.paths` for `change_types`-only rule matches.
 *
 * @internal
 */
export declare function pathsContributingToChangeTypes(changedPaths: string[], changeTypes: ChangeType[]): string[];
/**
 * Classify a PR's risk tier from its diff signals.
 *
 * Algorithm:
 *  1. Load the risk-tiering spec (target-repo override, then shipped default).
 *  2. Detect change types from `changedPaths` and `commitMessages`.
 *  3. Walk tiers in `high → medium → low` order. Within each tier, walk rules
 *     in declaration order. On first match, return the result.
 *  4. No match → return fallback (spec.fallback_tier, matched_rule: "fallback").
 *
 * @param opts - Classification inputs (see `ClassifyRiskTierOptions`).
 * @returns Pattern §11 output shape with `story_id`.
 */
export declare function classifyRiskTier(opts: ClassifyRiskTierOptions): Promise<RiskTierClassifierResult>;
