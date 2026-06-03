/**
 * Unit tests for `summariseDrainResult` — Story 8.7.
 *
 * AC1: formats a populated drain result into a one-line summary.
 * AC2: handles an all-empty result (and missing optional arrays) gracefully.
 */
import { describe, expect, it } from "vitest";
import { summariseDrainResult, } from "../summarise-drain-result.js";
describe("summariseDrainResult", () => {
    // AC1 — populated result.
    it("formats a populated drain result into a one-line summary", () => {
        const result = {
            sessionUlid: "01KST0WDFQRHWQ9B54X1M7K387",
            drainedReason: "queue-drained",
            completed: ["bmad:8.5", "bmad:8.6", "bmad:8.7"],
            merged: [
                { ref: "bmad:8.5", prNumber: 201 },
                { ref: "bmad:8.6", prNumber: 202 },
            ],
            pausedForHuman: [
                { ref: "bmad:8.4", prNumber: 200, reason: "reviewer-verdict-blocked" },
            ],
            blocked: [],
        };
        expect(summariseDrainResult(result)).toBe("drain 01KST0WDFQRHWQ9B54X1M7K387: 3 completed, 2 merged, 1 paused-for-human, 0 blocked (drainedReason: queue-drained)");
    });
    it("reflects each count from its corresponding array's length", () => {
        const result = {
            sessionUlid: "S1",
            drainedReason: "r",
            completed: ["a"],
            merged: [
                { ref: "a", prNumber: 1 },
                { ref: "b", prNumber: 2 },
            ],
            pausedForHuman: [
                { ref: "c", prNumber: 3, reason: "x" },
                { ref: "d", prNumber: 4, reason: "y" },
                { ref: "e", prNumber: 5, reason: "z" },
            ],
            blocked: [
                { ref: "f", blocked_by: "deps-drift" },
                { ref: "g", blocked_by: "routing-failure" },
                { ref: "h", blocked_by: "gh-defer" },
                { ref: "i", blocked_by: "gh-retry" },
            ],
        };
        expect(summariseDrainResult(result)).toBe("drain S1: 1 completed, 2 merged, 3 paused-for-human, 4 blocked (drainedReason: r)");
    });
    it("is a single line (contains no newline)", () => {
        const result = {
            sessionUlid: "S",
            drainedReason: "queue-drained",
            completed: [],
            merged: [],
            pausedForHuman: [],
            blocked: [],
        };
        expect(summariseDrainResult(result)).not.toContain("\n");
    });
    it("does not mutate the input", () => {
        const result = {
            sessionUlid: "S",
            drainedReason: "queue-drained",
            completed: ["a"],
            merged: [{ ref: "a", prNumber: 1 }],
            pausedForHuman: [],
            blocked: [],
        };
        const snapshot = JSON.parse(JSON.stringify(result));
        summariseDrainResult(result);
        expect(result).toEqual(snapshot);
    });
    // AC2 — all-empty arrays.
    it("renders the same shape with every count 0 for an all-empty result", () => {
        const result = {
            sessionUlid: "01KST0WDFQRHWQ9B54X1M7K387",
            drainedReason: "queue-drained",
            completed: [],
            merged: [],
            pausedForHuman: [],
            blocked: [],
        };
        expect(summariseDrainResult(result)).toBe("drain 01KST0WDFQRHWQ9B54X1M7K387: 0 completed, 0 merged, 0 paused-for-human, 0 blocked (drainedReason: queue-drained)");
    });
    // AC2 — missing optional arrays treated as empty, not thrown.
    it("treats missing (undefined) optional arrays as empty and does not throw", () => {
        const result = {
            sessionUlid: "01KST0WDFQRHWQ9B54X1M7K387",
            drainedReason: "queue-drained",
        };
        expect(() => summariseDrainResult(result)).not.toThrow();
        expect(summariseDrainResult(result)).toBe("drain 01KST0WDFQRHWQ9B54X1M7K387: 0 completed, 0 merged, 0 paused-for-human, 0 blocked (drainedReason: queue-drained)");
    });
});
