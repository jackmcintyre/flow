/**
 * Deterministic fire-count helper — Story 6.6 (FR64, FR64a).
 *
 * This is the **load-bearing seam** for the calibration loop's feedback arm.
 * It is a pure function (no LLM, no I/O): given the retro inputs and a config,
 * it returns:
 *
 *   1. Per-failure-class fire counts over the window.
 *   2. **Promotion candidates** — classes whose count is at or above the
 *      configurable `promotionThreshold` AND that have no rule already
 *      registered against them.
 *   3. **Retirement candidates** — registered rules whose `target_failure_class`
 *      has fired fewer than `relaxFloor` times (→ `retire` at zero fires, →
 *      `relax` at non-zero-but-below-floor).
 *
 * The retro-analyst MUST draft proposals from this helper's output. It MUST
 * NOT recount fires in its own prose (see `catalogue/retro-analyst.md`).
 *
 * ## Cycle-window approximation (pending Story 6.12)
 *
 * Story 6.12 will introduce real cycle boundaries. Until then, this helper
 * treats the full available manifest/telemetry history as a single "window".
 * The windowing logic is isolated in the `WindowingSeam` interface so 6.12
 * can inject real cycle-boundary partitioning without touching the candidate
 * derivation logic.
 *
 * The retirement criterion is "not fired for ≥ M windows". In the v1
 * approximation, M is irrelevant because there is exactly one window — a rule
 * is a retirement candidate if its class is silent across the ENTIRE available
 * history (and M >= 1 is satisfied trivially). When 6.12 injects real
 * boundaries, M will gate retirement over multiple consecutive quiet cycles.
 * This degradation is documented here and in the story's completion notes.
 *
 * ## Documented config defaults
 *
 *   - `promotionThreshold` = **3** fires — a class must fire at least 3 times
 *     in the window before it is flagged as a promotion candidate. This is a
 *     conservative default to avoid noisy single-fire proposals.
 *
 *   - `retirementWindows` (M) = **5** cycles — after 6.12 lands, a rule must
 *     be quiet for 5 consecutive cycles before it is flagged for retirement.
 *     In the v1 approximation, M is satisfied by having zero or below-floor
 *     fires in the single available window.
 *
 *   - `relaxFloor` = **1** fire — a rule that fires 0 times is a `retire`
 *     candidate; a rule that fires at least 1 time but fewer than
 *     `promotionThreshold` is a `relax` candidate (demote to advisory). Exactly
 *     zero fires → `retire`; [1, promotionThreshold) → `relax`.
 *
 * (Story 6.6 — FR64, FR64a, Architecture §Skill calibration loop)
 */
/** Resolved defaults — exported for tests and documentation; never magic numbers in the logic below. */
export const DEFAULT_PROMOTION_THRESHOLD = 3;
/** @see FireCountConfig.retirementWindows */
export const DEFAULT_RETIREMENT_WINDOWS = 5; // M; used as documentation, enforced by 6.12
/** @see FireCountConfig.relaxFloor */
export const DEFAULT_RELAX_FLOOR = 1; // 0 fires → retire; ≥1 → relax (unless ≥ promotionThreshold)
export function resolveFireCountConfig(config = {}) {
    return {
        promotionThreshold: config.promotionThreshold ?? DEFAULT_PROMOTION_THRESHOLD,
        retirementWindows: config.retirementWindows ?? DEFAULT_RETIREMENT_WINDOWS,
        relaxFloor: config.relaxFloor ?? DEFAULT_RELAX_FLOOR,
    };
}
/** Default v1 windowing: treat all available data as one window. */
export const SINGLE_WINDOW_SEAM = {
    filterManifests: (manifests) => manifests,
    filterEvents: (events) => events,
    isQuietEnoughForRetirement: (fireCount, relaxFloor) => fireCount < relaxFloor,
};
// ---------------------------------------------------------------------------
// Core pure helper
// ---------------------------------------------------------------------------
/**
 * Compute per-failure-class fire counts and derive promotion/retirement
 * candidates. **Pure** — no I/O, no LLM, no randomness. Same inputs → same
 * output (deterministic).
 *
 * @param inputs  The retro inputs bundle (done manifests + telemetry + registry).
 * @param config  Optional config overrides. Undocumented omissions use defaults.
 * @param windowing  Optional windowing seam. Defaults to the v1 single-window
 *   approximation. Story 6.12 will inject real cycle boundaries here.
 */
export function computeFailureClassFireCounts(inputs, config = {}, windowing = SINGLE_WINDOW_SEAM) {
    const { promotionThreshold, retirementWindows, relaxFloor } = resolveFireCountConfig(config);
    // Step 1: collect all fire-class occurrences from the windowed data.
    const windowedManifests = windowing.filterManifests(inputs.doneManifests);
    const windowedEvents = windowing.filterEvents(inputs.telemetrySummary.events);
    const rawCounts = new Map();
    // Count from done manifests.
    for (const manifest of windowedManifests) {
        if (manifest.failure_class) {
            rawCounts.set(manifest.failure_class, (rawCounts.get(manifest.failure_class) ?? 0) + 1);
        }
    }
    // Count from telemetry events. Only events with a `failure_class`-shaped field
    // count here. We look for events whose `data` object carries a `failure_class`
    // string — this covers `reviewer.verdict` and `story.retro` event types that
    // carry failure classifications.
    for (const event of windowedEvents) {
        const data = event.data;
        if (data && typeof data.failure_class === "string" && data.failure_class.length > 0) {
            rawCounts.set(data.failure_class, (rawCounts.get(data.failure_class) ?? 0) + 1);
        }
    }
    // Step 2: build the registered-rule index: class → rule ids.
    const registeredRules = inputs.ruleRegistry?.rules ?? [];
    const rulesByClass = new Map();
    for (const rule of registeredRules) {
        const existing = rulesByClass.get(rule.target_failure_class) ?? [];
        existing.push(rule.id);
        rulesByClass.set(rule.target_failure_class, existing);
    }
    // Step 3: ensure every class that has a registered rule appears in the map
    // (with 0 fire count if it never appeared in manifests/telemetry).
    for (const ruleClass of rulesByClass.keys()) {
        if (!rawCounts.has(ruleClass)) {
            rawCounts.set(ruleClass, 0);
        }
    }
    // Step 4: assemble the byClass map.
    const byClass = new Map();
    for (const [cls, count] of rawCounts) {
        byClass.set(cls, {
            fireCount: count,
            registeredRuleIds: rulesByClass.get(cls) ?? [],
        });
    }
    // Step 5: derive promotion candidates.
    // A class is a promotion candidate if:
    //   - its fire count >= promotionThreshold, AND
    //   - it has NO registered rule (registeredRuleIds is empty).
    const promotionCandidates = [];
    for (const [cls, entry] of byClass) {
        if (entry.fireCount >= promotionThreshold && entry.registeredRuleIds.length === 0) {
            promotionCandidates.push({ failureClass: cls, fireCount: entry.fireCount });
        }
    }
    // Sort by fireCount descending for deterministic output.
    promotionCandidates.sort((a, b) => b.fireCount - a.fireCount || a.failureClass.localeCompare(b.failureClass));
    // Step 6: derive retirement candidates.
    // A registered rule is a retirement candidate if its class is quiet enough
    // per the windowing seam.
    const retirementCandidates = [];
    for (const rule of registeredRules) {
        const entry = byClass.get(rule.target_failure_class);
        const fireCount = entry?.fireCount ?? 0;
        if (windowing.isQuietEnoughForRetirement(fireCount, relaxFloor, retirementWindows)) {
            // Determine recommended action.
            // Boundary: exactly 0 fires → retire; [relaxFloor > fires > 0] → relax.
            // (relaxFloor default is 1, so the range [1, 1) is empty; only 0 → retire
            //  with default config. Higher relaxFloor values open a relax band.)
            const recommendedAction = fireCount === 0 ? "retire" : "relax";
            retirementCandidates.push({
                targetRuleId: rule.id,
                failureClass: rule.target_failure_class,
                fireCountOverWindow: fireCount,
                recommendedAction,
            });
        }
    }
    // Sort by rule id for deterministic output.
    retirementCandidates.sort((a, b) => a.targetRuleId.localeCompare(b.targetRuleId));
    return { byClass, promotionCandidates, retirementCandidates };
}
