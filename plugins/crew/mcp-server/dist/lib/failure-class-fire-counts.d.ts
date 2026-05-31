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
import type { ExecutionManifest } from "../schemas/execution-manifest.js";
import type { TelemetryEvent } from "../schemas/telemetry-events.js";
import type { DisciplineRule } from "../schemas/discipline-rules.js";
/**
 * Configuration for the fire-count helper. Every field has a documented
 * default so callers on the retro path can omit the config entirely and get
 * sensible behaviour.
 */
export interface FireCountConfig {
    /**
     * Minimum number of fires a failure class must accumulate in the window
     * before it is flagged as a promotion candidate.
     *
     * Default: **3**. Chosen to filter single-incident noise while still
     * flagging persistent patterns. Lower values increase proposal volume;
     * higher values suppress emerging patterns.
     */
    promotionThreshold?: number;
    /**
     * Number of consecutive quiet windows required before a rule is flagged
     * as a retirement candidate (M in the epic wording). Post-6.12 only.
     *
     * Default: **5**. In v1 the single-window approximation makes this a
     * no-op in the retirement decision (any rule with below-floor fires is
     * flagged); the value is preserved in the config as the documented seam
     * for 6.12.
     */
    retirementWindows?: number;
    /**
     * Fire count below which a rule is a retirement candidate. A rule that
     * fires exactly 0 times receives `recommended_action: "retire"`;
     * a rule that fires [1, relaxFloor) times receives `recommended_action: "relax"`.
     * A rule at or above `relaxFloor` is NOT a retirement candidate.
     *
     * Default: **1** (zero fires → `retire`; anything ≥ 1 → not `retire`).
     * Setting `relaxFloor` to a higher value creates a relax band. For example,
     * `relaxFloor: 3` makes rules with 1–2 fires `relax` candidates.
     */
    relaxFloor?: number;
}
/** Resolved defaults — exported for tests and documentation; never magic numbers in the logic below. */
export declare const DEFAULT_PROMOTION_THRESHOLD = 3;
/** @see FireCountConfig.retirementWindows */
export declare const DEFAULT_RETIREMENT_WINDOWS = 5;
/** @see FireCountConfig.relaxFloor */
export declare const DEFAULT_RELAX_FLOOR = 1;
export declare function resolveFireCountConfig(config?: FireCountConfig): Required<FireCountConfig>;
/**
 * A windowing seam. In v1 this is the identity — every manifest and event is
 * part of the single available window. Story 6.12 will inject a seam that
 * partitions by real cycle boundaries and evaluates the M-consecutive-windows
 * retirement criterion across them.
 *
 * The seam is typed here so 6.12 can swap the implementation without touching
 * `computeFailureClassFireCounts`.
 */
export interface WindowingSeam {
    /**
     * Filter manifests to those within the evaluation window.
     * Default (v1): return all.
     */
    filterManifests(manifests: ExecutionManifest[]): ExecutionManifest[];
    /**
     * Filter telemetry events to those within the evaluation window.
     * Default (v1): return all.
     */
    filterEvents(events: TelemetryEvent[]): TelemetryEvent[];
    /**
     * Given a fire count for a registered rule's class, decide whether the
     * quiet-window threshold has been met. Default (v1): any fire count below
     * `relaxFloor` qualifies (single-window approximation).
     *
     * 6.12 implementation: compare actual quiet-cycle count to `retirementWindows`.
     */
    isQuietEnoughForRetirement(fireCount: number, relaxFloor: number, retirementWindows: number): boolean;
}
/** Default v1 windowing: treat all available data as one window. */
export declare const SINGLE_WINDOW_SEAM: WindowingSeam;
/**
 * Per-failure-class aggregation returned by the helper.
 */
export interface FailureClassEntry {
    /** Total fire count over the evaluated window. */
    fireCount: number;
    /**
     * Ids of registered rules whose `target_failure_class` matches this class.
     * Empty when the class has no registered rule.
     */
    registeredRuleIds: string[];
}
/**
 * A promotion candidate: a failure class that crossed the threshold AND has
 * no registered rule yet.
 */
export interface PromotionCandidate {
    /** The failure class that fired frequently enough to warrant a rule. */
    failureClass: string;
    /** How many times it fired in the evaluation window. */
    fireCount: number;
}
/**
 * A retirement candidate: a registered rule whose class has gone quiet.
 */
export interface RetirementCandidate {
    /** The rule to retire or relax. */
    targetRuleId: string;
    /** The failure class this rule guards. */
    failureClass: string;
    /** How many times the class fired in the evaluation window. */
    fireCountOverWindow: number;
    /**
     * `"retire"` when fire count is exactly 0;
     * `"relax"` when fire count is in [1, relaxFloor).
     */
    recommendedAction: "retire" | "relax";
}
/**
 * The full output of `computeFailureClassFireCounts`.
 */
export interface FireCountResult {
    /**
     * Per-failure-class breakdown. All classes that appeared in any manifest
     * or telemetry event are present here, plus all classes from registered
     * rules (with fireCount=0 when they never fired).
     */
    byClass: Map<string, FailureClassEntry>;
    /**
     * Classes to promote to new rules (count ≥ threshold, no rule registered).
     */
    promotionCandidates: PromotionCandidate[];
    /**
     * Registered rules to retire or relax (class is quiet per the windowing seam).
     */
    retirementCandidates: RetirementCandidate[];
}
/**
 * The subset of the retro inputs bundle that the fire-count helper needs.
 * Allows the helper to be called with a subset of `RetroInputs` without
 * importing the full type.
 */
export interface FireCountInputs {
    /** Done manifests carrying optional `failure_class` fields. */
    doneManifests: ExecutionManifest[];
    /** Telemetry summary for the window. */
    telemetrySummary: {
        events: TelemetryEvent[];
        skipped_count: number;
    };
    /** Parsed discipline-rules registry, or null when absent. */
    ruleRegistry: {
        rules: DisciplineRule[];
    } | null;
}
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
export declare function computeFailureClassFireCounts(inputs: FireCountInputs, config?: FireCountConfig, windowing?: WindowingSeam): FireCountResult;
