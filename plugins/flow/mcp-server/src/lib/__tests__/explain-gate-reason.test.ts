/**
 * Unit tests for `explainGateReason` — Story 8.10.
 *
 * AC1 — every known gate reason maps to a non-empty, single-line explanation.
 * AC2 — unknown / empty inputs yield a non-empty generic fallback, never throw.
 */

import { describe, expect, it } from "vitest";
import { explainGateReason } from "../explain-gate-reason.js";

const KNOWN_REASONS = [
  "low-risk-met-threshold",
  "low-risk-sub-threshold",
  "low-risk-insufficient-data",
  "low-risk-provisional-trust",
  "medium-risk",
  "high-risk",
  "no-tier-no-signal",
  "ci-not-green",
] as const;

describe("explainGateReason", () => {
  describe("AC1 — known reasons", () => {
    for (const reason of KNOWN_REASONS) {
      describe(`reason: ${reason}`, () => {
        it("returns a non-empty string", () => {
          const explanation = explainGateReason(reason);
          expect(typeof explanation).toBe("string");
          expect(explanation.length).toBeGreaterThan(0);
        });

        it("returns a single line (no newline characters)", () => {
          const explanation = explainGateReason(reason);
          expect(explanation).not.toMatch(/[\r\n]/);
        });

        it("does not return the generic fallback", () => {
          const explanation = explainGateReason(reason);
          expect(explanation.toLowerCase()).not.toContain("unrecognized reason");
        });
      });
    }

    it("gives a distinct explanation for each known reason", () => {
      const explanations = KNOWN_REASONS.map((r) => explainGateReason(r));
      const unique = new Set(explanations);
      expect(unique.size).toBe(KNOWN_REASONS.length);
    });

    it("reflects the auto-merge vs pause decision in the wording", () => {
      // Reasons that auto-merge should say so; the rest should mention pausing.
      const autoMerge = ["low-risk-met-threshold", "low-risk-provisional-trust"];
      for (const reason of KNOWN_REASONS) {
        const explanation = explainGateReason(reason).toLowerCase();
        if (autoMerge.includes(reason)) {
          expect(explanation).toContain("auto-merged");
        } else {
          expect(explanation).toContain("paused");
        }
      }
    });
  });

  describe("AC2 — unknown reasons and never throwing", () => {
    it("returns a non-empty fallback for the empty string", () => {
      const explanation = explainGateReason("");
      expect(explanation.length).toBeGreaterThan(0);
      expect(explanation.toLowerCase()).toContain("unrecognized reason");
    });

    it("returns a non-empty fallback for an unknown literal", () => {
      const explanation = explainGateReason("totally-made-up-reason");
      expect(explanation.length).toBeGreaterThan(0);
      expect(explanation.toLowerCase()).toContain("unrecognized reason");
    });

    it("returns a single-line fallback (no newline characters)", () => {
      const explanation = explainGateReason("nope");
      expect(explanation).not.toMatch(/[\r\n]/);
    });

    it("never throws for arbitrary string inputs", () => {
      const weirdInputs = [
        "",
        " ",
        "  low-risk-met-threshold  ", // whitespace-padded known literal
        "LOW-RISK-MET-THRESHOLD", // wrong case
        "\t",
        "🚀",
        "constructor",
        "__proto__",
        "toString",
        "low-risk-met-threshold\nextra",
        "a".repeat(10_000),
      ];
      for (const input of weirdInputs) {
        expect(() => explainGateReason(input)).not.toThrow();
        expect(explainGateReason(input).length).toBeGreaterThan(0);
      }
    });

    it("does not leak prototype-chain values for object-key-like inputs", () => {
      // Guards against the lookup accidentally resolving inherited members.
      expect(explainGateReason("toString").toLowerCase()).toContain(
        "unrecognized reason",
      );
      expect(explainGateReason("constructor").toLowerCase()).toContain(
        "unrecognized reason",
      );
    });
  });
});
