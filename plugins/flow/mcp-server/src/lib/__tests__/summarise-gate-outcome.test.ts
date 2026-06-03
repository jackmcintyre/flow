/**
 * Unit tests for `summariseGateOutcome` — Story 8.11.
 *
 * AC1: renders an auto-merged outcome as a one-line summary that includes the
 *      ref, `PR#<prNumber>`, the `auto-merged` wording, and the reason; pure
 *      and deterministic (no mutation).
 * AC2: renders a paused outcome with the `paused for human` wording and the
 *      given reason, never throws, and is a single line.
 */

import { describe, expect, it } from "vitest";
import {
  summariseGateOutcome,
  type GateOutcome,
} from "../summarise-gate-outcome.js";

describe("summariseGateOutcome", () => {
  // AC1 — auto-merged outcome.
  it("renders an auto-merged outcome as a one-line summary", () => {
    const outcome: GateOutcome = {
      ref: "bmad:8.11",
      prNumber: 211,
      decision: "auto-merge",
      reason: "low-risk-met-threshold",
      merged: true,
    };

    expect(summariseGateOutcome(outcome)).toBe(
      "bmad:8.11 PR#211: auto-merged (low-risk-met-threshold)",
    );
  });

  it("includes the ref, PR#<prNumber>, the outcome word, and the reason", () => {
    const outcome: GateOutcome = {
      ref: "bmad:8.11",
      prNumber: 211,
      decision: "auto-merge",
      reason: "low-risk-met-threshold",
      merged: true,
    };

    const line = summariseGateOutcome(outcome);

    expect(line).toContain("bmad:8.11");
    expect(line).toContain("PR#211");
    expect(line).toContain("auto-merged");
    expect(line).toContain("low-risk-met-threshold");
  });

  it("is a single line (contains no newline) for an auto-merged outcome", () => {
    const outcome: GateOutcome = {
      ref: "bmad:8.11",
      prNumber: 211,
      decision: "auto-merge",
      reason: "low-risk-met-threshold",
      merged: true,
    };

    expect(summariseGateOutcome(outcome)).not.toContain("\n");
  });

  it("does not mutate the input", () => {
    const outcome: GateOutcome = {
      ref: "bmad:8.11",
      prNumber: 211,
      decision: "auto-merge",
      reason: "low-risk-met-threshold",
      merged: true,
    };
    const snapshot = JSON.parse(JSON.stringify(outcome));

    summariseGateOutcome(outcome);

    expect(outcome).toEqual(snapshot);
  });

  // AC2 — paused outcome.
  it("renders a paused outcome with the 'paused for human' wording", () => {
    const outcome: GateOutcome = {
      ref: "bmad:8.4",
      prNumber: 200,
      decision: "pause-needs-human",
      reason: "ci-not-green",
      merged: false,
    };

    expect(summariseGateOutcome(outcome)).toBe(
      "bmad:8.4 PR#200: paused for human (ci-not-green)",
    );
  });

  it("never throws for a paused outcome and surfaces the given reason", () => {
    const outcome: GateOutcome = {
      ref: "bmad:8.4",
      prNumber: 200,
      decision: "pause-needs-human",
      reason: "ci-not-green",
      merged: false,
    };

    expect(() => summariseGateOutcome(outcome)).not.toThrow();
    expect(summariseGateOutcome(outcome)).toContain("paused for human");
    expect(summariseGateOutcome(outcome)).toContain("ci-not-green");
  });

  it("is a single line (contains no newline) for a paused outcome", () => {
    const outcome: GateOutcome = {
      ref: "bmad:8.4",
      prNumber: 200,
      decision: "pause-needs-human",
      reason: "ci-not-green",
      merged: false,
    };

    expect(summariseGateOutcome(outcome)).not.toContain("\n");
  });

  it("uses the outcome word from `merged`, independent of the decision field", () => {
    // A defensive shape check: the rendered word follows `merged`, not
    // `decision`. Never throws for any input matching the declared shape.
    const outcome: GateOutcome = {
      ref: "bmad:8.99",
      prNumber: 0,
      decision: "auto-merge",
      reason: "",
      merged: false,
    };

    expect(() => summariseGateOutcome(outcome)).not.toThrow();
    expect(summariseGateOutcome(outcome)).toBe(
      "bmad:8.99 PR#0: paused for human ()",
    );
  });
});
