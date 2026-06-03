/**
 * The `rule`-kind `ProposalApplyHandler` — Story 6.5 (FR62) + Story 6.5b (FR48).
 *
 * This is the **first real handler** registered into the Story 6.4
 * `/accept-proposal` gate. It takes an accepted `rule` proposal and appends (or
 * edits) a rule in `docs/discipline-rules.yaml`, then regenerates
 * `docs/standards.md` from the updated registry (Story 6.5b).
 *
 *  - `text` + `target_failure_class` are COPIED from the proposal.
 *  - `level` is mapped from the proposal's `recommended_promotion_level`.
 *  - `id` is a freshly minted ULID.
 *  - `introduced_at` is `now` (ISO-8601 UTC).
 *
 * **Append vs edit-in-place.** The epic wording is "append or edit". The chosen
 * match key is `target_failure_class`: if the registry already holds a rule for
 * the proposal's `target_failure_class`, the handler EDITS that rule in place
 * (replacing its `text`/`level`, keeping its existing `id` and `introduced_at`)
 * rather than appending a duplicate. This keeps the invariant that the registry
 * never holds two rules for one failure class. A new class is appended.
 *
 * **Cap-rollback ordering (Story 6.5b).** Order inside `apply`:
 *   1. Snapshot the current `docs/discipline-rules.yaml` bytes.
 *   2. Append/edit the rule (working-tree write).
 *   3. Call `regenerateStandards` against the post-append registry.
 *   4. If it raises `StandardsCapExceededError`: restore the registry snapshot
 *      (working-tree rollback) and re-raise. The gate sees the throw, commits
 *      nothing, stamps nothing, emits no telemetry.
 *   5. Otherwise: write the regenerated `docs/standards.md` and return BOTH
 *      changed paths `["docs/discipline-rules.yaml", "docs/standards.md"]`.
 *
 * **No commit.** The handler only mutates the working tree and returns the
 * repo-relative paths it changed — the gate (`acceptProposal`) owns the
 * commit + proposal stamp + telemetry.
 *
 * **Idempotency is the gate's, not the handler's.** The handler is not
 * re-entrant-safe on its own; the gate's persisted-`applied` no-op (Story 6.4
 * AC4) guards against a second apply.
 *
 * **Comment preservation** is delegated to the comment-preserving parse/serialize
 * seam in `schemas/discipline-rules.ts` (the `yaml` Document API). Existing rules
 * and human-authored comments survive the append/edit byte-for-byte.
 *
 * (Story 6.5 — FR62; Story 6.5b — FR48, Architecture §Skill calibration loop)
 */
import type { ProposalApplyHandler } from "./proposal-apply-registry.js";
/** The single repo-relative registry path this handler writes. */
export declare const REGISTRY_REL_PATH = "docs/discipline-rules.yaml";
/**
 * Test seams: a clock for `introduced_at` and a ULID minter for `id`, so
 * AC2/AC3 can assert deterministic field values. Production passes neither and
 * the real `new Date()` / `ulid` are used.
 *
 * Story 6.5b extends the seam with `standardsNow` (the clock injected into
 * `regenerateStandards`) so tests can assert byte-identical output across two
 * regenerations.
 */
export interface RuleApplyHandlerSeams {
    /** Returns "now" for `introduced_at`. Defaults to `() => new Date()`. */
    now?: () => Date;
    /** Mints a fresh ULID for `id`. Defaults to the `ulid` package. */
    mintUlid?: () => string;
    /**
     * Returns "now" as an ISO-8601 string for the `updated` field in the
     * regenerated `docs/standards.md`. Defaults to `() => new Date()`.
     * Distinct from `now` so tests can control the two clocks independently.
     */
    standardsNow?: () => Date;
}
/**
 * Construct the `rule`-kind apply handler. Seams are injectable for tests; the
 * production registry calls this with no args.
 */
export declare function makeRuleApplyHandler(seamsIn?: RuleApplyHandlerSeams): ProposalApplyHandler;
