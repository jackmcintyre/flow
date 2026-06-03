/**
 * Schema extension tests for the three new telemetry event types — Story 4.12 Task 8.4.
 *
 * AC5 coverage:
 *   (f) Schema-strict assertions: unknown extra key in data fails (5f)
 *   (g) Round-trip parseability: all new event types parse cleanly (5g)
 *
 * Tests the new schemas independently of the logger and tool layer.
 */
import { describe, expect, it } from "vitest";
import { TelemetryEventSchema, ReviewerVerdictEventSchema, ReviewerVerdictMergeActionEventSchema, DevBudgetExceededEventSchema, YieldHandoffEventSchema, } from "../telemetry-events.js";
const BASE_TS = "2026-05-26T12:00:00.000Z";
const BASE_FIELDS = {
    ts: BASE_TS,
    session_id: "SESSION-SCHEMA-TEST",
    agent: "generalist-reviewer",
};
// ---------------------------------------------------------------------------
// ReviewerVerdictEventSchema
// ---------------------------------------------------------------------------
describe("ReviewerVerdictEventSchema", () => {
    it("accepts a valid reviewer.verdict event", () => {
        const result = ReviewerVerdictEventSchema.safeParse({
            ...BASE_FIELDS,
            type: "reviewer.verdict",
            story_id: "bmad:4.12",
            data: {
                pr_number: 42,
                verdict: "READY FOR MERGE",
                standards_version: "1.0.0",
                plugin_version: "0.5.3",
                timed_out: false,
            },
        });
        expect(result.success).toBe(true);
    });
    it("accepts reviewer-failure verdict with timed_out: true", () => {
        const result = ReviewerVerdictEventSchema.safeParse({
            ...BASE_FIELDS,
            type: "reviewer.verdict",
            data: {
                pr_number: 7,
                verdict: "reviewer-failure",
                standards_version: "2.1.0",
                plugin_version: "1.0.0",
                timed_out: true,
            },
        });
        expect(result.success).toBe(true);
    });
    it("rejects unknown extra key in data (.strict())", () => {
        const result = ReviewerVerdictEventSchema.safeParse({
            ...BASE_FIELDS,
            type: "reviewer.verdict",
            data: {
                pr_number: 42,
                verdict: "NEEDS CHANGES",
                standards_version: "1.0.0",
                plugin_version: "0.5.3",
                timed_out: false,
                extra_field: "should-fail",
            },
        });
        expect(result.success).toBe(false);
    });
    it("rejects unknown extra key at event level (.strict())", () => {
        const result = ReviewerVerdictEventSchema.safeParse({
            ...BASE_FIELDS,
            type: "reviewer.verdict",
            data: {
                pr_number: 42,
                verdict: "BLOCKED",
                standards_version: "1.0.0",
                plugin_version: "0.5.3",
                timed_out: false,
            },
            extra_top_level: "bad",
        });
        expect(result.success).toBe(false);
    });
    it("rejects invalid verdict literal", () => {
        const result = ReviewerVerdictEventSchema.safeParse({
            ...BASE_FIELDS,
            type: "reviewer.verdict",
            data: {
                pr_number: 42,
                verdict: "APPROVED",
                standards_version: "1.0.0",
                plugin_version: "0.5.3",
                timed_out: false,
            },
        });
        expect(result.success).toBe(false);
    });
    it("rejects standards_version that is not semver", () => {
        const result = ReviewerVerdictEventSchema.safeParse({
            ...BASE_FIELDS,
            type: "reviewer.verdict",
            data: {
                pr_number: 42,
                verdict: "READY FOR MERGE",
                standards_version: "v1.0",
                plugin_version: "0.5.3",
                timed_out: false,
            },
        });
        expect(result.success).toBe(false);
    });
});
// ---------------------------------------------------------------------------
// ReviewerVerdictMergeActionEventSchema
// ---------------------------------------------------------------------------
describe("ReviewerVerdictMergeActionEventSchema", () => {
    it("accepts a valid reviewer.verdict.merge_action event", () => {
        const result = ReviewerVerdictMergeActionEventSchema.safeParse({
            ...BASE_FIELDS,
            type: "reviewer.verdict.merge_action",
            story_id: "bmad:4.10",
            data: {
                pr_number: 55,
                merge_action: "merged",
                resolved_at: "2026-05-26T11:00:00.000Z",
            },
        });
        expect(result.success).toBe(true);
    });
    it("rejects unknown extra key in data (.strict())", () => {
        const result = ReviewerVerdictMergeActionEventSchema.safeParse({
            ...BASE_FIELDS,
            type: "reviewer.verdict.merge_action",
            data: {
                pr_number: 55,
                merge_action: "merged",
                resolved_at: "2026-05-26T11:00:00.000Z",
                extra: "bad",
            },
        });
        expect(result.success).toBe(false);
    });
    it("rejects non-UTC resolved_at", () => {
        const result = ReviewerVerdictMergeActionEventSchema.safeParse({
            ...BASE_FIELDS,
            type: "reviewer.verdict.merge_action",
            data: {
                pr_number: 55,
                merge_action: "merged",
                resolved_at: "2026-05-26T11:00:00+01:00",
            },
        });
        expect(result.success).toBe(false);
    });
    it("rejects invalid merge_action", () => {
        const result = ReviewerVerdictMergeActionEventSchema.safeParse({
            ...BASE_FIELDS,
            type: "reviewer.verdict.merge_action",
            data: {
                pr_number: 55,
                merge_action: "force-pushed",
                resolved_at: "2026-05-26T11:00:00.000Z",
            },
        });
        expect(result.success).toBe(false);
    });
});
// ---------------------------------------------------------------------------
// DevBudgetExceededEventSchema
// ---------------------------------------------------------------------------
describe("DevBudgetExceededEventSchema", () => {
    it("accepts a valid dev.budget_exceeded event", () => {
        const result = DevBudgetExceededEventSchema.safeParse({
            ...BASE_FIELDS,
            agent: "generalist-dev",
            type: "dev.budget_exceeded",
            story_id: "bmad:1.2",
            data: {
                cumulative_runtime_ms: 1_800_000,
                budget_ms: 1_800_000,
                triggering_invocation_runtime_ms: 600_000,
            },
        });
        expect(result.success).toBe(true);
    });
    it("rejects unknown extra key in data (.strict())", () => {
        const result = DevBudgetExceededEventSchema.safeParse({
            ...BASE_FIELDS,
            agent: "generalist-dev",
            type: "dev.budget_exceeded",
            story_id: "bmad:1.2",
            data: {
                cumulative_runtime_ms: 1_800_000,
                budget_ms: 1_800_000,
                triggering_invocation_runtime_ms: 600_000,
                extra_field: "bad",
            },
        });
        expect(result.success).toBe(false);
    });
    it("rejects negative cumulative_runtime_ms", () => {
        const result = DevBudgetExceededEventSchema.safeParse({
            ...BASE_FIELDS,
            agent: "generalist-dev",
            type: "dev.budget_exceeded",
            data: {
                cumulative_runtime_ms: -1,
                budget_ms: 1_800_000,
                triggering_invocation_runtime_ms: 600_000,
            },
        });
        expect(result.success).toBe(false);
    });
});
// ---------------------------------------------------------------------------
// Discriminated union: TelemetryEventSchema
// ---------------------------------------------------------------------------
describe("TelemetryEventSchema discriminated union — new types", () => {
    it("routes reviewer.verdict to the correct schema branch", () => {
        const result = TelemetryEventSchema.safeParse({
            ...BASE_FIELDS,
            type: "reviewer.verdict",
            data: {
                pr_number: 1,
                verdict: "READY FOR MERGE",
                standards_version: "1.0.0",
                plugin_version: "0.5.0",
                timed_out: false,
            },
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.type).toBe("reviewer.verdict");
        }
    });
    it("routes reviewer.verdict.merge_action to the correct schema branch", () => {
        const result = TelemetryEventSchema.safeParse({
            ...BASE_FIELDS,
            type: "reviewer.verdict.merge_action",
            data: {
                pr_number: 2,
                merge_action: "closed-unmerged",
                resolved_at: "2026-05-26T10:00:00.000Z",
            },
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.type).toBe("reviewer.verdict.merge_action");
        }
    });
    it("routes dev.budget_exceeded to the correct schema branch", () => {
        const result = TelemetryEventSchema.safeParse({
            ...BASE_FIELDS,
            agent: "generalist-dev",
            type: "dev.budget_exceeded",
            story_id: "bmad:1.1",
            data: {
                cumulative_runtime_ms: 2_000_000,
                budget_ms: 1_800_000,
                triggering_invocation_runtime_ms: 300_000,
            },
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.type).toBe("dev.budget_exceeded");
        }
    });
    it("routes yield.handoff to the correct schema branch", () => {
        const result = TelemetryEventSchema.safeParse({
            ...BASE_FIELDS,
            type: "yield.handoff",
            story_id: "native:01HZTEST",
            data: {
                from_role: "generalist-reviewer",
                to_role: "security-specialist",
                domain: "authentication authorization and secret handling",
            },
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.type).toBe("yield.handoff");
        }
    });
    it("rejects an unknown event type", () => {
        const result = TelemetryEventSchema.safeParse({
            ...BASE_FIELDS,
            type: "unknown.event",
            data: {},
        });
        expect(result.success).toBe(false);
    });
});
// ---------------------------------------------------------------------------
// YieldHandoffEventSchema
// ---------------------------------------------------------------------------
describe("YieldHandoffEventSchema", () => {
    it("accepts a valid yield.handoff event", () => {
        const result = YieldHandoffEventSchema.safeParse({
            ...BASE_FIELDS,
            type: "yield.handoff",
            story_id: "native:01HZTEST",
            data: {
                from_role: "generalist-reviewer",
                to_role: "security-specialist",
                domain: "authentication authorization and secret handling",
            },
        });
        expect(result.success).toBe(true);
    });
    it("rejects unknown extra key in data (.strict())", () => {
        const result = YieldHandoffEventSchema.safeParse({
            ...BASE_FIELDS,
            type: "yield.handoff",
            data: {
                from_role: "generalist-reviewer",
                to_role: "security-specialist",
                domain: "authentication authorization and secret handling",
                extra_field: "bad",
            },
        });
        expect(result.success).toBe(false);
    });
    it("rejects unknown extra key at event level (.strict())", () => {
        const result = YieldHandoffEventSchema.safeParse({
            ...BASE_FIELDS,
            type: "yield.handoff",
            data: {
                from_role: "generalist-reviewer",
                to_role: "security-specialist",
                domain: "authentication authorization and secret handling",
            },
            extra_top_level: "bad",
        });
        expect(result.success).toBe(false);
    });
    it("rejects empty string for from_role", () => {
        const result = YieldHandoffEventSchema.safeParse({
            ...BASE_FIELDS,
            type: "yield.handoff",
            data: {
                from_role: "",
                to_role: "security-specialist",
                domain: "authentication authorization and secret handling",
            },
        });
        expect(result.success).toBe(false);
    });
    it("rejects empty string for to_role", () => {
        const result = YieldHandoffEventSchema.safeParse({
            ...BASE_FIELDS,
            type: "yield.handoff",
            data: {
                from_role: "generalist-reviewer",
                to_role: "",
                domain: "authentication authorization and secret handling",
            },
        });
        expect(result.success).toBe(false);
    });
    it("rejects empty string for domain", () => {
        const result = YieldHandoffEventSchema.safeParse({
            ...BASE_FIELDS,
            type: "yield.handoff",
            data: {
                from_role: "generalist-reviewer",
                to_role: "security-specialist",
                domain: "",
            },
        });
        expect(result.success).toBe(false);
    });
});
