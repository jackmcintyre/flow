/**
 * Tests for `computeFailureClassFireCounts` — Story 6.6 AC1–AC3.
 *
 * AC1: A pure helper reads done manifests and telemetry, returns per-class
 *      fire counts. Same inputs → same output (deterministic). Handles zero-
 *      fire classes and classes with no registered rule.
 *
 * AC2: Classes crossing the promotion threshold AND with no registered rule
 *      are flagged as promotion candidates; a class with a rule is NOT flagged.
 *
 * AC3: Registered rules whose class is silent (zero fires) are flagged as
 *      `retire` candidates; non-zero-but-below-floor → `relax`; rules above
 *      the floor are NOT flagged. Each candidate carries target_rule_id,
 *      fire_count_over_window, and recommended_action.
 */
import { describe, expect, it } from "vitest";
import { computeFailureClassFireCounts, resolveFireCountConfig, SINGLE_WINDOW_SEAM, } from "../failure-class-fire-counts.js";
// ---------------------------------------------------------------------------
// Constants (exported from the module for doc purposes — re-import here)
// Re-define locally to keep tests self-contained and readable.
// ---------------------------------------------------------------------------
// These are the documented defaults from the helper module.
const PROMO_THRESHOLD = 3; // DEFAULT_PROMOTION_THRESHOLD
const RELAX_FLOOR = 1; // DEFAULT_RELAX_FLOOR
// ---------------------------------------------------------------------------
// Fixtures: minimal manifest + telemetry constructors
// ---------------------------------------------------------------------------
/** Build a minimal ExecutionManifest with an optional failure_class. */
function manifest(opts) {
    // Cast: ExecutionManifest has many required fields; for the fire-count helper
    // only `failure_class` matters. Other fields are irrelevant to the pure helper.
    return {
        ref: "native:test-ref",
        status: "done",
        adapter: "native",
        source_path: "stories/test.md",
        source_hash: "a".repeat(64),
        depends_on: [],
        acceptance_criteria: [{ text: "AC1", kind: "integration" }],
        title: "Test story",
        narrative: "As a tester, I want tests, so that things pass.",
        withdrawn: false,
        ready: true,
        failure_class: opts.failure_class,
    };
}
/** Build a minimal TelemetryEvent with a `data.failure_class`. */
function telemetryEvent(failureClass) {
    return {
        type: "reviewer.verdict",
        ts: "2026-05-31T10:00:00.000Z",
        session_id: "session-1",
        agent: "generalist-reviewer",
        data: { failure_class: failureClass },
    };
}
/** Build a minimal DisciplineRule. */
function rule(id, targetClass) {
    return {
        id,
        text: `Rule for ${targetClass}`,
        target_failure_class: targetClass,
        introduced_at: "2026-05-01T00:00:00.000Z",
        level: "must",
    };
}
const EMPTY_REGISTRY = { rules: [] };
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function emptyInputs() {
    return {
        doneManifests: [],
        telemetrySummary: { events: [], skipped_count: 0 },
        ruleRegistry: EMPTY_REGISTRY,
    };
}
// ---------------------------------------------------------------------------
// AC1 — per-class fire counts, determinism, zero-fire class, no-rule class
// ---------------------------------------------------------------------------
describe("computeFailureClassFireCounts — AC1: per-class counts and determinism", () => {
    it("returns empty maps when there are no manifests, events, or rules", () => {
        const result = computeFailureClassFireCounts(emptyInputs());
        expect(result.byClass.size).toBe(0);
        expect(result.promotionCandidates).toHaveLength(0);
        expect(result.retirementCandidates).toHaveLength(0);
    });
    it("counts failure_class occurrences from done manifests correctly", () => {
        const inputs = {
            ...emptyInputs(),
            doneManifests: [
                manifest({ failure_class: "handoff-grammar" }),
                manifest({ failure_class: "handoff-grammar" }),
                manifest({ failure_class: "rubber-stamp" }),
                manifest({}), // no failure_class — should not count
            ],
        };
        const result = computeFailureClassFireCounts(inputs);
        expect(result.byClass.get("handoff-grammar")?.fireCount).toBe(2);
        expect(result.byClass.get("rubber-stamp")?.fireCount).toBe(1);
        // Manifest with no failure_class contributes nothing.
        expect(result.byClass.size).toBe(2);
    });
    it("counts failure_class from telemetry events in data.failure_class", () => {
        const inputs = {
            ...emptyInputs(),
            telemetrySummary: {
                events: [
                    telemetryEvent("rubber-stamp"),
                    telemetryEvent("rubber-stamp"),
                    telemetryEvent("rubber-stamp"),
                ],
                skipped_count: 0,
            },
        };
        const result = computeFailureClassFireCounts(inputs);
        expect(result.byClass.get("rubber-stamp")?.fireCount).toBe(3);
    });
    it("accumulates counts from BOTH manifests AND telemetry for the same class", () => {
        const inputs = {
            ...emptyInputs(),
            doneManifests: [manifest({ failure_class: "rubber-stamp" })],
            telemetrySummary: {
                events: [telemetryEvent("rubber-stamp"), telemetryEvent("rubber-stamp")],
                skipped_count: 0,
            },
        };
        const result = computeFailureClassFireCounts(inputs);
        expect(result.byClass.get("rubber-stamp")?.fireCount).toBe(3);
    });
    it("is deterministic — same inputs produce the same output (AC1)", () => {
        const inputs = {
            ...emptyInputs(),
            doneManifests: [
                manifest({ failure_class: "a" }),
                manifest({ failure_class: "b" }),
                manifest({ failure_class: "a" }),
            ],
        };
        const r1 = computeFailureClassFireCounts(inputs);
        const r2 = computeFailureClassFireCounts(inputs);
        // byClass Maps are independently constructed but should have the same entries.
        expect(r1.byClass.get("a")?.fireCount).toBe(r2.byClass.get("a")?.fireCount);
        expect(r1.byClass.get("b")?.fireCount).toBe(r2.byClass.get("b")?.fireCount);
        expect(r1.promotionCandidates).toEqual(r2.promotionCandidates);
        expect(r1.retirementCandidates).toEqual(r2.retirementCandidates);
    });
    it("includes a class with zero fires when a registered rule guards it (AC1)", () => {
        const inputs = {
            doneManifests: [manifest({ failure_class: "other-class" })],
            telemetrySummary: { events: [], skipped_count: 0 },
            ruleRegistry: { rules: [rule("RULE01", "silent-class")] },
        };
        const result = computeFailureClassFireCounts(inputs);
        // silent-class should appear with fireCount=0 because a rule guards it.
        const entry = result.byClass.get("silent-class");
        expect(entry).toBeDefined();
        expect(entry.fireCount).toBe(0);
        expect(entry.registeredRuleIds).toContain("RULE01");
    });
    it("includes a class with no registered rule and reports empty registeredRuleIds (AC1)", () => {
        const inputs = {
            ...emptyInputs(),
            doneManifests: [manifest({ failure_class: "new-class" })],
        };
        const result = computeFailureClassFireCounts(inputs);
        const entry = result.byClass.get("new-class");
        expect(entry).toBeDefined();
        expect(entry.registeredRuleIds).toHaveLength(0);
    });
    it("reports registered rule ids for a class that appears in both manifests and registry", () => {
        const inputs = {
            doneManifests: [manifest({ failure_class: "rubber-stamp" })],
            telemetrySummary: { events: [], skipped_count: 0 },
            ruleRegistry: { rules: [rule("RULE_RS", "rubber-stamp")] },
        };
        const result = computeFailureClassFireCounts(inputs);
        const entry = result.byClass.get("rubber-stamp");
        expect(entry.registeredRuleIds).toContain("RULE_RS");
        expect(entry.fireCount).toBe(1);
    });
});
// ---------------------------------------------------------------------------
// AC2 — promotion candidates
// ---------------------------------------------------------------------------
describe("computeFailureClassFireCounts — AC2: promotion candidates", () => {
    it("flags a class as a promotion candidate when count >= threshold and no rule exists", () => {
        const inputs = {
            ...emptyInputs(),
            doneManifests: [
                manifest({ failure_class: "rubber-stamp" }),
                manifest({ failure_class: "rubber-stamp" }),
                manifest({ failure_class: "rubber-stamp" }), // exactly 3 = threshold
            ],
        };
        const result = computeFailureClassFireCounts(inputs, { promotionThreshold: PROMO_THRESHOLD });
        expect(result.promotionCandidates).toHaveLength(1);
        const cand = result.promotionCandidates[0];
        expect(cand.failureClass).toBe("rubber-stamp");
        expect(cand.fireCount).toBe(3);
    });
    it("does NOT flag a class as a promotion candidate when count is below threshold (AC2)", () => {
        const inputs = {
            ...emptyInputs(),
            doneManifests: [
                manifest({ failure_class: "rubber-stamp" }),
                manifest({ failure_class: "rubber-stamp" }), // 2 < 3
            ],
        };
        const result = computeFailureClassFireCounts(inputs, { promotionThreshold: PROMO_THRESHOLD });
        expect(result.promotionCandidates).toHaveLength(0);
    });
    it("does NOT flag a class as a promotion candidate when a rule already exists (AC2)", () => {
        // A class that crosses the threshold but already has a rule — NOT a promotion candidate.
        const inputs = {
            doneManifests: [
                manifest({ failure_class: "handoff-grammar" }),
                manifest({ failure_class: "handoff-grammar" }),
                manifest({ failure_class: "handoff-grammar" }),
                manifest({ failure_class: "handoff-grammar" }), // 4 >= threshold
            ],
            telemetrySummary: { events: [], skipped_count: 0 },
            ruleRegistry: { rules: [rule("RULE_HG", "handoff-grammar")] }, // rule exists
        };
        const result = computeFailureClassFireCounts(inputs, { promotionThreshold: PROMO_THRESHOLD });
        // No promotion candidate for handoff-grammar because it already has a rule.
        const hgCand = result.promotionCandidates.find((c) => c.failureClass === "handoff-grammar");
        expect(hgCand).toBeUndefined();
    });
    it("flags exactly the right classes when mixed above/below threshold, some with rules (AC2)", () => {
        // Setup:
        //   - "loud-class":   5 fires, no rule  → should be promotion candidate
        //   - "medium-class": 2 fires, no rule  → NOT promoted (below threshold)
        //   - "guarded-class": 4 fires, HAS rule → NOT promoted (rule exists)
        //   - "silent-class":  0 fires, HAS rule → retirement candidate (not promotion)
        const inputs = {
            doneManifests: [
                manifest({ failure_class: "loud-class" }),
                manifest({ failure_class: "loud-class" }),
                manifest({ failure_class: "loud-class" }),
                manifest({ failure_class: "loud-class" }),
                manifest({ failure_class: "loud-class" }),
                manifest({ failure_class: "medium-class" }),
                manifest({ failure_class: "medium-class" }),
                manifest({ failure_class: "guarded-class" }),
                manifest({ failure_class: "guarded-class" }),
                manifest({ failure_class: "guarded-class" }),
                manifest({ failure_class: "guarded-class" }),
            ],
            telemetrySummary: { events: [], skipped_count: 0 },
            ruleRegistry: {
                rules: [
                    rule("RULE_GC", "guarded-class"),
                    rule("RULE_SC", "silent-class"),
                ],
            },
        };
        const result = computeFailureClassFireCounts(inputs, { promotionThreshold: PROMO_THRESHOLD });
        const classes = result.promotionCandidates.map((c) => c.failureClass);
        expect(classes).toContain("loud-class");
        expect(classes).not.toContain("medium-class"); // below threshold
        expect(classes).not.toContain("guarded-class"); // has rule
        expect(classes).not.toContain("silent-class"); // has rule (and silent)
        expect(result.promotionCandidates).toHaveLength(1);
        expect(result.promotionCandidates[0].fireCount).toBe(5);
    });
    it("respects a custom promotionThreshold override (AC2)", () => {
        const inputs = {
            ...emptyInputs(),
            doneManifests: [
                manifest({ failure_class: "cls" }),
                manifest({ failure_class: "cls" }), // 2 fires
            ],
        };
        // With threshold=2, 2 fires should qualify.
        const result = computeFailureClassFireCounts(inputs, { promotionThreshold: 2 });
        expect(result.promotionCandidates).toHaveLength(1);
        expect(result.promotionCandidates[0].failureClass).toBe("cls");
    });
});
// ---------------------------------------------------------------------------
// AC3 — retirement candidates
// ---------------------------------------------------------------------------
describe("computeFailureClassFireCounts — AC3: retirement candidates", () => {
    it("flags a rule as 'retire' when its class fires zero times (AC3)", () => {
        const inputs = {
            ...emptyInputs(),
            ruleRegistry: { rules: [rule("RULE01", "silent-class")] },
        };
        const result = computeFailureClassFireCounts(inputs);
        expect(result.retirementCandidates).toHaveLength(1);
        const cand = result.retirementCandidates[0];
        expect(cand.targetRuleId).toBe("RULE01");
        expect(cand.failureClass).toBe("silent-class");
        expect(cand.fireCountOverWindow).toBe(0);
        expect(cand.recommendedAction).toBe("retire");
    });
    it("does NOT flag a rule as a retirement candidate when its class still fires (AC3)", () => {
        const inputs = {
            doneManifests: [
                manifest({ failure_class: "active-class" }),
                manifest({ failure_class: "active-class" }),
                manifest({ failure_class: "active-class" }),
            ],
            telemetrySummary: { events: [], skipped_count: 0 },
            ruleRegistry: { rules: [rule("RULE01", "active-class")] },
        };
        const result = computeFailureClassFireCounts(inputs);
        expect(result.retirementCandidates).toHaveLength(0);
    });
    it("flags a rule as 'relax' when its class fires [1, relaxFloor) times (AC3 relax boundary)", () => {
        // Default relaxFloor=1 means: zero fires → retire; >=1 fires → not retire.
        // To get a relax candidate we need relaxFloor > 1.
        const inputs = {
            doneManifests: [manifest({ failure_class: "low-fire-class" })], // 1 fire
            telemetrySummary: { events: [], skipped_count: 0 },
            ruleRegistry: { rules: [rule("RULE01", "low-fire-class")] },
        };
        // With relaxFloor=3: 1 fire is in [1, 3) → relax.
        const result = computeFailureClassFireCounts(inputs, { relaxFloor: 3, promotionThreshold: 5 });
        expect(result.retirementCandidates).toHaveLength(1);
        const cand = result.retirementCandidates[0];
        expect(cand.recommendedAction).toBe("relax");
        expect(cand.fireCountOverWindow).toBe(1);
        expect(cand.targetRuleId).toBe("RULE01");
    });
    it("boundary: exactly relaxFloor fires is NOT a retirement candidate (AC3 relax boundary)", () => {
        // relaxFloor=2: fires=2 means NOT a retirement candidate (the condition is fires < relaxFloor).
        const inputs = {
            doneManifests: [
                manifest({ failure_class: "border-class" }),
                manifest({ failure_class: "border-class" }),
            ],
            telemetrySummary: { events: [], skipped_count: 0 },
            ruleRegistry: { rules: [rule("RULE01", "border-class")] },
        };
        const result = computeFailureClassFireCounts(inputs, { relaxFloor: 2 });
        // fires=2 === relaxFloor → NOT quiet enough → NOT a retirement candidate
        expect(result.retirementCandidates).toHaveLength(0);
    });
    it("default config: 0 fires → retire, 1+ fires → not retired (AC3 default boundary)", () => {
        // Default relaxFloor=1: only zero-fire rules are retirement candidates.
        const inputs = {
            doneManifests: [manifest({ failure_class: "one-fire" })],
            telemetrySummary: { events: [], skipped_count: 0 },
            ruleRegistry: {
                rules: [
                    rule("RULE_ZERO", "zero-fire"), // 0 fires → retire
                    rule("RULE_ONE", "one-fire"), // 1 fire → NOT retired (at relaxFloor)
                ],
            },
        };
        const result = computeFailureClassFireCounts(inputs); // default config
        expect(result.retirementCandidates).toHaveLength(1);
        const cand = result.retirementCandidates[0];
        expect(cand.targetRuleId).toBe("RULE_ZERO");
        expect(cand.recommendedAction).toBe("retire");
    });
    it("flags only the silent rule when one rule is silent and another still fires (AC3)", () => {
        const inputs = {
            doneManifests: [
                manifest({ failure_class: "active-class" }),
                manifest({ failure_class: "active-class" }),
                manifest({ failure_class: "active-class" }),
            ],
            telemetrySummary: { events: [], skipped_count: 0 },
            ruleRegistry: {
                rules: [
                    rule("RULE_ACTIVE", "active-class"), // still fires → NOT retired
                    rule("RULE_SILENT", "silent-class"), // 0 fires → retire
                ],
            },
        };
        const result = computeFailureClassFireCounts(inputs);
        expect(result.retirementCandidates).toHaveLength(1);
        const cand = result.retirementCandidates[0];
        expect(cand.targetRuleId).toBe("RULE_SILENT");
        expect(cand.fireCountOverWindow).toBe(0);
        expect(cand.recommendedAction).toBe("retire");
    });
    it("a class with a rule AND high fire count is NOT a promotion candidate (edge case AC2+AC3)", () => {
        // Guards the edge case noted in the spec: guarded + high fire count ≠ promote.
        const inputs = {
            doneManifests: [
                manifest({ failure_class: "guarded-loud" }),
                manifest({ failure_class: "guarded-loud" }),
                manifest({ failure_class: "guarded-loud" }),
                manifest({ failure_class: "guarded-loud" }),
                manifest({ failure_class: "guarded-loud" }),
            ],
            telemetrySummary: { events: [], skipped_count: 0 },
            ruleRegistry: { rules: [rule("RULE_GL", "guarded-loud")] },
        };
        const result = computeFailureClassFireCounts(inputs, { promotionThreshold: PROMO_THRESHOLD });
        expect(result.promotionCandidates).toHaveLength(0); // rule exists → no promotion
        expect(result.retirementCandidates).toHaveLength(0); // still fires → no retirement
    });
});
// ---------------------------------------------------------------------------
// Config + defaults test
// ---------------------------------------------------------------------------
describe("resolveFireCountConfig — documented defaults", () => {
    it("uses DEFAULT_PROMOTION_THRESHOLD=3 when omitted", () => {
        const cfg = resolveFireCountConfig({});
        expect(cfg.promotionThreshold).toBe(3);
    });
    it("uses DEFAULT_RETIREMENT_WINDOWS=5 when omitted", () => {
        const cfg = resolveFireCountConfig({});
        expect(cfg.retirementWindows).toBe(5);
    });
    it("uses DEFAULT_RELAX_FLOOR=1 when omitted", () => {
        const cfg = resolveFireCountConfig({});
        expect(cfg.relaxFloor).toBe(1);
    });
    it("respects overrides", () => {
        const cfg = resolveFireCountConfig({ promotionThreshold: 10, relaxFloor: 5, retirementWindows: 3 });
        expect(cfg.promotionThreshold).toBe(10);
        expect(cfg.relaxFloor).toBe(5);
        expect(cfg.retirementWindows).toBe(3);
    });
});
// ---------------------------------------------------------------------------
// Windowing seam test
// ---------------------------------------------------------------------------
describe("SINGLE_WINDOW_SEAM — v1 windowing passthrough", () => {
    it("filterManifests returns all manifests unchanged", () => {
        const manifests = [manifest({ failure_class: "a" }), manifest({})];
        expect(SINGLE_WINDOW_SEAM.filterManifests(manifests)).toHaveLength(2);
    });
    it("isQuietEnoughForRetirement returns true only when count < relaxFloor", () => {
        expect(SINGLE_WINDOW_SEAM.isQuietEnoughForRetirement(0, 1, 5)).toBe(true);
        expect(SINGLE_WINDOW_SEAM.isQuietEnoughForRetirement(1, 1, 5)).toBe(false);
        expect(SINGLE_WINDOW_SEAM.isQuietEnoughForRetirement(0, 3, 5)).toBe(true);
        expect(SINGLE_WINDOW_SEAM.isQuietEnoughForRetirement(1, 3, 5)).toBe(true); // 1 < 3
        expect(SINGLE_WINDOW_SEAM.isQuietEnoughForRetirement(3, 3, 5)).toBe(false); // 3 >= 3
    });
});
