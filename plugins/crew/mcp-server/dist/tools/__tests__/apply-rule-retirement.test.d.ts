/**
 * `rule-retirement`-kind apply-handler + production-gate tests — Story 6.6 AC4.
 *
 * AC4: accepting a `rule-retirement` proposal:
 *   - For `recommended_action: retire`: removes the rule matching `target_rule_id`
 *     from `docs/discipline-rules.yaml`.
 *   - For `recommended_action: relax`: demotes the rule's `level` to `advisory`.
 *   - Either way: regenerates `docs/standards.md` to match the updated registry.
 *   - Returns both changed paths.
 *   - Comments on untouched rules survive.
 *   - The gate commits both files plus the proposal stamp in one commit.
 *   - An unknown `target_rule_id` raises `RuleNotFoundError` with no mutation.
 *   - Retiring the last rule raises `RetirementWouldEmptyRegistryError` before any write.
 *
 * Mirror of `apply-rule-proposal.test.ts` (Story 6.5) — same tmpRoot pattern,
 * same fake git seam, same telemetry reader.
 */
export {};
