/**
 * Pure helpers for composing the PR review summary body and verdict line
 * from a persisted `reviewer-result.json` file.
 *
 * Both `composeSummaryBody` and `composeVerdictLine` are pure functions:
 * no I/O, no Date.now(), no env reads. Inputs are the parsed file shape only.
 *
 * The verdict line grammar is the load-bearing contract from Story 4.6b AC2:
 *   - "READY FOR MERGE"  → `**Verdict: READY FOR MERGE**`
 *   - "NEEDS CHANGES"    → `**Verdict: NEEDS CHANGES** [N issues, M questions]`
 *   - "BLOCKED"          → `**Verdict: BLOCKED** [no ACs declared | manual checks required]`
 *
 * Any other state throws `UnreachableBlockedReasonError` to prevent fabricating
 * an unknown reason string.
 *
 * Story 4.6b Task 3.1–3.2
 */
import type { ReviewerResultFileShape } from "./read-reviewer-result-file.js";
import type { RiskTierBlock } from "../tools/classify-risk-tier.js";
/**
 * Compose the single load-bearing verdict line from the persisted result.
 * Follows the closed table from Story 4.6b spec §2e.
 *
 * Throws `UnreachableBlockedReasonError` if `recommendedVerdict` is "BLOCKED"
 * but `acResults` is neither empty nor contains a `manual-check-required` entry —
 * indicating an out-of-band mutation of the persisted file.
 */
export declare function composeVerdictLine(result: ReviewerResultFileShape): string;
/**
 * Compose the verbatim `## Risk tier evidence` block for the PR review body.
 *
 * Story 4.9b — AC3 unpacked (3f). The block format is byte-exact:
 * tested in vitest for byte-equality.
 *
 * Returns `""` when `riskTier` is `undefined` (backward compat — legacy
 * session results without classification omit the block entirely).
 *
 * @param riskTier - The optional risk-tier block from the result file.
 */
export declare function composeRiskTierEvidenceBlock(riskTier: RiskTierBlock | undefined): string;
export interface ComposeSummaryBodyVersionInfo {
    /** Semver version of the standards doc used to produce this verdict. */
    standardsVersion: string;
    /** Semver version of the flow plugin (from getPluginVersion()). */
    pluginVersion: string;
}
/**
 * Compose the full PR review summary body from the persisted result.
 *
 * Body skeleton (Story 4.6b spec §2a, extended by Story 4.7, Story 4.9b):
 *   # Reviewer summary — ${ref}
 *   ## Acceptance criteria
 *   <per-AC lines>
 *   ## Standards check
 *   <per-criterion lines>
 *   [## Manual checks required before merge]  (only if any manual-check-required ACs)
 *   <verdict line>
 *
 *   `standards_version: <standardsVersion>` · `plugin_version: <pluginVersion>`
 *   [## Risk tier evidence]  (Story 4.9b — only when resultFile.riskTier is present)
 *   <!-- flow:verdict:<pluginVersion>:<ref> -->
 *
 * The footer marker is the absolute last line (no trailing newline).
 * The `## Risk tier evidence` block appears BEFORE the footer marker (Story 4.9b AC3f).
 */
export declare function composeSummaryBody(result: ReviewerResultFileShape, versionInfo: ComposeSummaryBodyVersionInfo): string;
