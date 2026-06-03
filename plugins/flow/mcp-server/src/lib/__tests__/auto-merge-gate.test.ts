/**
 * Unit tests for `decideAutoMerge` — Story 4.10b (Task 1.5).
 *
 * Covers each of the six decision branches plus the boundary case (ratio ===
 * threshold) and the no-tier defensive branch.
 */

import { describe, expect, it } from "vitest";
import { decideAutoMerge } from "../auto-merge-gate.js";
import type { AgreementMetricResult } from "../../tools/compute-agreement.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMetric(ratio: number): AgreementMetricResult {
  return {
    ratio,
    distribution: { "READY FOR MERGE": 0, "NEEDS CHANGES": 0, BLOCKED: 0 },
    window_size: 50,
    sample_size: 50,
    skipped_unresolved: 0,
    skipped_excluded: 0,
    malformed_lines: 0,
  };
}

const DEFAULT_THRESHOLD = 0.8;

// ---------------------------------------------------------------------------
// Branch 1: auto-merge (low, met threshold)
// ---------------------------------------------------------------------------

describe("Branch 1 — low risk, met threshold → auto-merge", () => {
  it("ratio === threshold (boundary, >=) → auto-merge", () => {
    const result = decideAutoMerge({
      risk_tier: "low",
      agreement_metric: makeMetric(DEFAULT_THRESHOLD),
      threshold: DEFAULT_THRESHOLD,
    });
    expect(result.decision).toBe("auto-merge");
    expect(result.reason).toBe("low-risk-met-threshold");
  });

  it("ratio strictly above threshold → auto-merge", () => {
    const result = decideAutoMerge({
      risk_tier: "low",
      agreement_metric: makeMetric(0.9),
      threshold: DEFAULT_THRESHOLD,
    });
    expect(result.decision).toBe("auto-merge");
    expect(result.reason).toBe("low-risk-met-threshold");
  });

  it("ratio === 1.0 → auto-merge", () => {
    const result = decideAutoMerge({
      risk_tier: "low",
      agreement_metric: makeMetric(1.0),
      threshold: DEFAULT_THRESHOLD,
    });
    expect(result.decision).toBe("auto-merge");
    expect(result.reason).toBe("low-risk-met-threshold");
  });
});

// ---------------------------------------------------------------------------
// Branch 2: pause — low risk, sub-threshold
// ---------------------------------------------------------------------------

describe("Branch 2 — low risk, sub-threshold → pause", () => {
  it("ratio below threshold → pause with low-risk-sub-threshold", () => {
    const result = decideAutoMerge({
      risk_tier: "low",
      agreement_metric: makeMetric(0.7),
      threshold: DEFAULT_THRESHOLD,
    });
    expect(result.decision).toBe("pause-needs-human");
    expect(result.reason).toBe("low-risk-sub-threshold");
  });

  it("ratio === 0.0 → pause with low-risk-sub-threshold", () => {
    const result = decideAutoMerge({
      risk_tier: "low",
      agreement_metric: makeMetric(0.0),
      threshold: DEFAULT_THRESHOLD,
    });
    expect(result.decision).toBe("pause-needs-human");
    expect(result.reason).toBe("low-risk-sub-threshold");
  });

  it("ratio 0.7999 just below threshold 0.8 → pause", () => {
    const result = decideAutoMerge({
      risk_tier: "low",
      agreement_metric: makeMetric(0.7999),
      threshold: 0.8,
    });
    expect(result.decision).toBe("pause-needs-human");
    expect(result.reason).toBe("low-risk-sub-threshold");
  });
});

// ---------------------------------------------------------------------------
// Branch 3: pause — low risk, insufficient data (null metric)
// ---------------------------------------------------------------------------

describe("Branch 3 — low risk, insufficient data → pause", () => {
  it("null agreement_metric → pause with low-risk-insufficient-data", () => {
    const result = decideAutoMerge({
      risk_tier: "low",
      agreement_metric: null,
      threshold: DEFAULT_THRESHOLD,
    });
    expect(result.decision).toBe("pause-needs-human");
    expect(result.reason).toBe("low-risk-insufficient-data");
  });

  it("null metric with threshold 0.0 (always-pass threshold) still pauses", () => {
    const result = decideAutoMerge({
      risk_tier: "low",
      agreement_metric: null,
      threshold: 0.0,
    });
    expect(result.decision).toBe("pause-needs-human");
    expect(result.reason).toBe("low-risk-insufficient-data");
  });
});

// ---------------------------------------------------------------------------
// Branch 4: pause — medium risk (regardless of agreement)
// ---------------------------------------------------------------------------

describe("Branch 4 — medium risk → pause regardless of agreement", () => {
  it("medium risk with perfect agreement → still pauses", () => {
    const result = decideAutoMerge({
      risk_tier: "medium",
      agreement_metric: makeMetric(1.0),
      threshold: DEFAULT_THRESHOLD,
    });
    expect(result.decision).toBe("pause-needs-human");
    expect(result.reason).toBe("medium-risk");
  });

  it("medium risk with null agreement → pauses", () => {
    const result = decideAutoMerge({
      risk_tier: "medium",
      agreement_metric: null,
      threshold: DEFAULT_THRESHOLD,
    });
    expect(result.decision).toBe("pause-needs-human");
    expect(result.reason).toBe("medium-risk");
  });
});

// ---------------------------------------------------------------------------
// Branch 5: pause — high risk (regardless of agreement)
// ---------------------------------------------------------------------------

describe("Branch 5 — high risk → pause regardless of agreement", () => {
  it("high risk with perfect agreement → still pauses", () => {
    const result = decideAutoMerge({
      risk_tier: "high",
      agreement_metric: makeMetric(1.0),
      threshold: DEFAULT_THRESHOLD,
    });
    expect(result.decision).toBe("pause-needs-human");
    expect(result.reason).toBe("high-risk");
  });

  it("high risk with null agreement → pauses", () => {
    const result = decideAutoMerge({
      risk_tier: "high",
      agreement_metric: null,
      threshold: DEFAULT_THRESHOLD,
    });
    expect(result.decision).toBe("pause-needs-human");
    expect(result.reason).toBe("high-risk");
  });
});

// ---------------------------------------------------------------------------
// Branch 6: pause — no tier (legacy manifest / classifier-skipped)
// ---------------------------------------------------------------------------

describe("Branch 6 — undefined risk_tier → no-tier-no-signal pause", () => {
  it("undefined risk_tier with perfect agreement → no-tier-no-signal", () => {
    const result = decideAutoMerge({
      risk_tier: undefined,
      agreement_metric: makeMetric(1.0),
      threshold: DEFAULT_THRESHOLD,
    });
    expect(result.decision).toBe("pause-needs-human");
    expect(result.reason).toBe("no-tier-no-signal");
  });

  it("undefined risk_tier with null agreement → no-tier-no-signal", () => {
    const result = decideAutoMerge({
      risk_tier: undefined,
      agreement_metric: null,
      threshold: DEFAULT_THRESHOLD,
    });
    expect(result.decision).toBe("pause-needs-human");
    expect(result.reason).toBe("no-tier-no-signal");
  });
});

// ---------------------------------------------------------------------------
// Boundary: ratio exactly equals threshold (>= semantics, not >)
// ---------------------------------------------------------------------------

describe("Boundary — ratio exactly equals threshold uses >= (not >)", () => {
  it("ratio 0.8 with threshold 0.8 → auto-merge (pinned against regression to >)", () => {
    const result = decideAutoMerge({
      risk_tier: "low",
      agreement_metric: makeMetric(0.8),
      threshold: 0.8,
    });
    expect(result.decision).toBe("auto-merge");
    expect(result.reason).toBe("low-risk-met-threshold");
  });

  it("ratio 0.5 with threshold 0.5 → auto-merge", () => {
    const result = decideAutoMerge({
      risk_tier: "low",
      agreement_metric: makeMetric(0.5),
      threshold: 0.5,
    });
    expect(result.decision).toBe("auto-merge");
    expect(result.reason).toBe("low-risk-met-threshold");
  });

  it("ratio 0.0 with threshold 0.0 → auto-merge", () => {
    const result = decideAutoMerge({
      risk_tier: "low",
      agreement_metric: makeMetric(0.0),
      threshold: 0.0,
    });
    expect(result.decision).toBe("auto-merge");
    expect(result.reason).toBe("low-risk-met-threshold");
  });
});

// ---------------------------------------------------------------------------
// Stage-2: cold-start provisional trust
// ---------------------------------------------------------------------------

describe("Stage-2 — provisional_trust relaxes ONLY low + insufficient-data", () => {
  it("low + null metric + provisional_trust → auto-merge with low-risk-provisional-trust", () => {
    const result = decideAutoMerge({
      risk_tier: "low",
      agreement_metric: null,
      threshold: DEFAULT_THRESHOLD,
      provisional_trust: true,
    });
    expect(result.decision).toBe("auto-merge");
    expect(result.reason).toBe("low-risk-provisional-trust");
  });

  it("low + null metric + provisional_trust:false → pauses (insufficient-data)", () => {
    const result = decideAutoMerge({
      risk_tier: "low",
      agreement_metric: null,
      threshold: DEFAULT_THRESHOLD,
      provisional_trust: false,
    });
    expect(result.decision).toBe("pause-needs-human");
    expect(result.reason).toBe("low-risk-insufficient-data");
  });

  it("low + null metric + provisional_trust omitted → defaults to pause", () => {
    const result = decideAutoMerge({
      risk_tier: "low",
      agreement_metric: null,
      threshold: DEFAULT_THRESHOLD,
    });
    expect(result.decision).toBe("pause-needs-human");
    expect(result.reason).toBe("low-risk-insufficient-data");
  });

  it("medium + provisional_trust → STILL pauses (flag never relaxes medium)", () => {
    const result = decideAutoMerge({
      risk_tier: "medium",
      agreement_metric: null,
      threshold: DEFAULT_THRESHOLD,
      provisional_trust: true,
    });
    expect(result.decision).toBe("pause-needs-human");
    expect(result.reason).toBe("medium-risk");
  });

  it("high + provisional_trust → STILL pauses (flag never relaxes high)", () => {
    const result = decideAutoMerge({
      risk_tier: "high",
      agreement_metric: null,
      threshold: DEFAULT_THRESHOLD,
      provisional_trust: true,
    });
    expect(result.decision).toBe("pause-needs-human");
    expect(result.reason).toBe("high-risk");
  });

  it("undefined tier + provisional_trust → STILL pauses (no-tier-no-signal)", () => {
    const result = decideAutoMerge({
      risk_tier: undefined,
      agreement_metric: null,
      threshold: DEFAULT_THRESHOLD,
      provisional_trust: true,
    });
    expect(result.decision).toBe("pause-needs-human");
    expect(result.reason).toBe("no-tier-no-signal");
  });

  it("low + sufficient history (met threshold) + provisional_trust → normal met-threshold path", () => {
    const result = decideAutoMerge({
      risk_tier: "low",
      agreement_metric: makeMetric(0.9),
      threshold: DEFAULT_THRESHOLD,
      provisional_trust: true,
    });
    expect(result.decision).toBe("auto-merge");
    expect(result.reason).toBe("low-risk-met-threshold");
  });
});
