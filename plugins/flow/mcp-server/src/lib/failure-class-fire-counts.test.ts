/**
 * Tests for the foundational-guardrail guard in `computeFailureClassFireCounts`.
 *
 * Story native:01KVHEYCN5W61NY67DQZC9N2FN — Stop the retrospective recommending
 * a never-triggered foundational guardrail for removal.
 *
 * AC1: A foundational, must-level quality guardrail that has never been triggered
 *      does NOT appear as a recommendation to retire it.
 * AC2: A guardrail with genuine evidence of being obsolete that goes beyond merely
 *      never having been triggered CAN still be recommended for retirement.
 */

import { describe, expect, it } from "vitest";
import {
  computeFailureClassFireCounts,
} from "./failure-class-fire-counts.js";
import type { ExecutionManifest } from "../schemas/execution-manifest.js";
import type { TelemetryEvent } from "../schemas/telemetry-events.js";

// ---------------------------------------------------------------------------
// Minimal fixture helpers (local to this test file)
// ---------------------------------------------------------------------------

function manifest(opts: { failure_class?: string }): ExecutionManifest {
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
  } as unknown as ExecutionManifest;
}

function emptyInputs() {
  return {
    doneManifests: [] as ExecutionManifest[],
    telemetrySummary: { events: [] as TelemetryEvent[], skipped_count: 0 },
    ruleRegistry: { rules: [] },
  };
}

// ---------------------------------------------------------------------------
// Foundational-guardrail guard tests (AC1 and AC2)
// ---------------------------------------------------------------------------

describe("computeFailureClassFireCounts — foundational-guardrail guard (Story native:01KVHEYCN5W61NY67DQZC9N2FN)", () => {
  it("AC1: does NOT flag a must-level rule as a retirement candidate when its class fires zero times", () => {
    // A foundational, must-level guardrail that has never been triggered.
    // The retro must NOT recommend retiring it on a zero-trigger count alone.
    const inputs = {
      ...emptyInputs(),
      ruleRegistry: {
        rules: [
          {
            id: "01KVHFOUNDATIONAL0000000001",
            text: "The dev handoff phrase must be emitted verbatim.",
            target_failure_class: "handoff-grammar",
            introduced_at: "2026-01-01T00:00:00.000Z",
            level: "must" as const,
          },
        ],
      },
    };
    const result = computeFailureClassFireCounts(inputs);
    // The must-level rule is guarding against "handoff-grammar" which has fired
    // zero times — this is the guardrail doing its job, not a dead rule.
    expect(result.retirementCandidates).toHaveLength(0);
  });

  it("AC1: non-must rules still retire on zero fires (guard is scoped to must-level only)", () => {
    // A should-level rule at zero fires should still be a retirement candidate.
    const inputs = {
      ...emptyInputs(),
      ruleRegistry: {
        rules: [
          {
            id: "01KVHSHOULDRULE00000000001",
            text: "The reviewer should not rubber-stamp without evidence.",
            target_failure_class: "rubber-stamp",
            introduced_at: "2026-01-01T00:00:00.000Z",
            level: "should" as const,
          },
        ],
      },
    };
    const result = computeFailureClassFireCounts(inputs);
    // A should-level rule at zero fires is a normal retirement candidate.
    expect(result.retirementCandidates).toHaveLength(1);
    expect(result.retirementCandidates[0]!.targetRuleId).toBe("01KVHSHOULDRULE00000000001");
    expect(result.retirementCandidates[0]!.recommendedAction).toBe("retire");
  });

  it("AC1: a rule with no level at zero fires is still a retirement candidate (backward compat)", () => {
    // A rule without a level field at zero fires is unchanged — still retires.
    const inputs = {
      ...emptyInputs(),
      ruleRegistry: {
        rules: [
          {
            id: "01KVHNOLEVELRULE0000000001",
            text: "Some legacy rule with no level set.",
            target_failure_class: "legacy-class",
            introduced_at: "2026-01-01T00:00:00.000Z",
            // level omitted — undefined
          },
        ],
      },
    };
    const result = computeFailureClassFireCounts(inputs);
    expect(result.retirementCandidates).toHaveLength(1);
    expect(result.retirementCandidates[0]!.recommendedAction).toBe("retire");
  });

  it("AC2: a must-level rule CAN still be a retirement candidate when it has non-zero fires (genuine evidence)", () => {
    // A must-level rule that HAS fired (evidence beyond zero-trigger count) and
    // the fire count is within the relax band — this is genuine evidence of
    // possible obsolescence (the rule fires rarely, not never).
    const inputs = {
      doneManifests: [manifest({ failure_class: "handoff-grammar" })], // 1 fire
      telemetrySummary: { events: [] as TelemetryEvent[], skipped_count: 0 },
      ruleRegistry: {
        rules: [
          {
            id: "01KVHFOUNDATIONAL0000000002",
            text: "The dev handoff phrase must be emitted verbatim.",
            target_failure_class: "handoff-grammar",
            introduced_at: "2026-01-01T00:00:00.000Z",
            level: "must" as const,
          },
        ],
      },
    };
    // With relaxFloor=3: 1 fire is in [1, 3) → relax — genuine evidence beyond
    // "never triggered" (the class HAS fired, just rarely).
    const result = computeFailureClassFireCounts(inputs, { relaxFloor: 3, promotionThreshold: 5 });
    expect(result.retirementCandidates).toHaveLength(1);
    const cand = result.retirementCandidates[0]!;
    expect(cand.targetRuleId).toBe("01KVHFOUNDATIONAL0000000002");
    expect(cand.recommendedAction).toBe("relax");
    expect(cand.fireCountOverWindow).toBe(1);
  });

  it("AC1+AC3: guard holds when mixed must-level and non-must rules exist with zero fires", () => {
    // A mixed registry: one must-level rule (zero fires) and one should-level rule
    // (zero fires). Only the should-level rule should be a retirement candidate.
    const inputs = {
      ...emptyInputs(),
      ruleRegistry: {
        rules: [
          {
            id: "01KVHFOUNDATIONAL0000000003",
            text: "Must-level foundational guardrail — never triggered.",
            target_failure_class: "foundational-guardrail",
            introduced_at: "2026-01-01T00:00:00.000Z",
            level: "must" as const,
          },
          {
            id: "01KVHSHOULDRULE00000000002",
            text: "Should-level rule — also never triggered.",
            target_failure_class: "advisory-guardrail",
            introduced_at: "2026-01-01T00:00:00.000Z",
            level: "should" as const,
          },
        ],
      },
    };
    const result = computeFailureClassFireCounts(inputs);
    // Only the should-level rule appears as a retirement candidate.
    expect(result.retirementCandidates).toHaveLength(1);
    expect(result.retirementCandidates[0]!.targetRuleId).toBe("01KVHSHOULDRULE00000000002");
    expect(result.retirementCandidates[0]!.recommendedAction).toBe("retire");
  });
});
