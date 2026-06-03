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
import { lookupRiskTieringSpec } from "../state/lookup-risk-tiering-spec.js";
import { detectChangeTypes, classifyPath } from "../lib/detect-change-types.js";
import { matchRule } from "../lib/match-rules.js";
import { ChangeTypeSchema } from "../schemas/risk-tiering-spec.js";
// ---------------------------------------------------------------------------
// Schemas (Pattern §11)
// ---------------------------------------------------------------------------
const RiskTierEvidenceSchema = z
    .object({
    paths: z.array(z.string()),
    change_types: z.array(ChangeTypeSchema),
    diff_size: z.number().int().nonnegative(),
})
    .strict();
/**
 * Pattern §11 full output shape including `story_id`.
 * Used as the tool's return value.
 */
export const RiskTierClassifierResultSchema = z
    .object({
    story_id: z.string(),
    tier: z.enum(["low", "medium", "high"]),
    matched_rule: z.string(),
    evidence: RiskTierEvidenceSchema,
})
    .strict();
/**
 * On-disk shape used inside `reviewer-result.json` — `story_id` is omitted
 * because the file already carries `ref` at its top level (single source of truth).
 *
 * Consumed by `read-reviewer-result-file.ts` (Task 6).
 */
export const RiskTierBlockSchema = RiskTierClassifierResultSchema.omit({ story_id: true });
// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------
/**
 * For a given set of detected `ChangeType` values, return the subset of
 * `changedPaths` that triggered any of those change types.
 *
 * Used to populate `evidence.paths` for `change_types`-only rule matches.
 *
 * @internal
 */
export function pathsContributingToChangeTypes(changedPaths, changeTypes) {
    const typeSet = new Set(changeTypes);
    return changedPaths.filter((p) => {
        const pathTypes = classifyPath(p);
        return pathTypes.some((t) => typeSet.has(t));
    });
}
// ---------------------------------------------------------------------------
// Main classifier
// ---------------------------------------------------------------------------
const TIER_ORDER = ["high", "medium", "low"];
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
export async function classifyRiskTier(opts) {
    const { targetRepoRoot, pluginRoot, storyId, changedPaths, commitMessages, diffSize } = opts;
    const additiveOnly = opts.additiveOnly ?? false;
    // Step 1: Load spec (propagates errors verbatim)
    const spec = await lookupRiskTieringSpec({ targetRepoRoot, pluginRoot });
    // Step 2: Detect change types
    const detectedChangeTypes = detectChangeTypes(changedPaths, commitMessages);
    // Step 3: Walk tiers highest → lowest
    for (const tier of TIER_ORDER) {
        const rules = spec.tiers[tier] ?? [];
        for (const rule of rules) {
            const { matched, matchedPaths } = matchRule(rule, {
                changedPaths,
                detectedChangeTypes,
                diffSize,
                additiveOnly,
            });
            if (!matched)
                continue;
            // Determine evidence.paths based on which signal matched
            let evidencePaths;
            if (rule.path_patterns !== undefined) {
                // Path-signal match: use the paths that matched the pattern
                evidencePaths = [...matchedPaths].sort();
            }
            else if (rule.change_types !== undefined) {
                // Change-type-signal match: paths that contributed to detected types
                // that are in the rule's change_types list
                const ruleTypes = rule.change_types.filter((ct) => detectedChangeTypes.includes(ct));
                evidencePaths = pathsContributingToChangeTypes(changedPaths, ruleTypes).sort();
            }
            else {
                // Size-only match
                evidencePaths = [];
            }
            return {
                story_id: storyId,
                tier,
                matched_rule: rule.id,
                evidence: {
                    paths: evidencePaths,
                    change_types: [...detectedChangeTypes].sort(),
                    diff_size: diffSize,
                },
            };
        }
    }
    // Step 4: Fallback — no rule matched
    return {
        story_id: storyId,
        tier: spec.fallback_tier,
        matched_rule: "fallback",
        evidence: {
            paths: [],
            change_types: [...detectedChangeTypes].sort(),
            diff_size: diffSize,
        },
    };
}
