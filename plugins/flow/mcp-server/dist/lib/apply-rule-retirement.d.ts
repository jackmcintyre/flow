/**
 * The `rule-retirement`-kind `ProposalApplyHandler` — Story 6.6 (FR64a).
 *
 * Accepts a `rule-retirement` proposal and either:
 *   - **`retire`**: removes the matching rule from `docs/discipline-rules.yaml`.
 *   - **`relax`**: demotes the matching rule's `level` to `"advisory"` in place.
 *
 * After either mutation, the handler regenerates `docs/standards.md` via
 * Story 6.5b's `regenerateStandards` (REUSED — no second projection
 * implementation). Returns both changed paths so the gate commits them together.
 *
 * ## Working-tree-atomic posture (mirroring the `rule` handler from 6.5)
 *
 *   1. Snapshot the current registry bytes.
 *   2. Validate `target_rule_id` exists BEFORE any write.
 *   3. For `retire`: guard against removing the last rule (→ empty standards doc).
 *   4. Mutate the registry in memory + write.
 *   5. Call `regenerateStandards`. If it throws, restore the snapshot and re-raise.
 *   6. Return both changed paths.
 *
 * ## No commit
 *
 * The handler only mutates the working tree and returns the repo-relative paths
 * it changed. The gate (`acceptProposal`) owns the commit + proposal stamp +
 * telemetry.
 *
 * ## Comment preservation
 *
 * Removal and demotion both go through the `yaml` Document API
 * (removeRuleNode, replaceRuleNode) so comments on untouched rules survive.
 *
 * (Story 6.6 — FR64a, Architecture §Skill calibration loop)
 */
import type { ProposalApplyHandler } from "./proposal-apply-registry.js";
/** The single repo-relative registry path this handler writes. */
export declare const REGISTRY_REL_PATH = "docs/discipline-rules.yaml";
/**
 * Injectable seams for tests (mirroring the `rule` handler's seams shape so
 * tests can assert byte-stable standards-doc output).
 */
export interface RuleRetirementApplyHandlerSeams {
    /** Returns "now" for the regenerated standards `updated` field. */
    standardsNow?: () => Date;
}
/**
 * Construct the `rule-retirement`-kind apply handler. Seams are injectable for
 * tests; the production registry calls this with no args.
 */
export declare function makeRuleRetirementApplyHandler(seamsIn?: RuleRetirementApplyHandlerSeams): ProposalApplyHandler;
