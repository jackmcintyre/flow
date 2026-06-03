/**
 * Schema tests for `RiskTieringSpecSchema` — Story 4.9 Task 6.4.
 *
 * Tests each rule-shape constraint, the `fallback_tier` literal, the
 * `version` regex, and the tier non-empty refinement directly against
 * Zod's `safeParse`. No IO — pure schema validation.
 */

import { describe, expect, it } from "vitest";
import {
  RiskTieringSpecSchema,
  RuleSchema,
  DiffSizeThresholdsSchema,
  ChangeTypeSchema,
} from "../risk-tiering-spec.js";

// ---------------------------------------------------------------------------
// Base fixtures
// ---------------------------------------------------------------------------

const BASE_LOW_RULE = {
  id: "low.docs-only",
  path_patterns: ["docs/**"],
};

const BASE_HIGH_RULE = {
  id: "high.schema-or-migration",
  change_types: ["migration", "schema"],
};

const BASE_SPEC = {
  version: "1.0.0",
  fallback_tier: "medium" as const,
  tiers: {
    low: [BASE_LOW_RULE],
    high: [BASE_HIGH_RULE],
  },
};

// ---------------------------------------------------------------------------
// ChangeTypeSchema
// ---------------------------------------------------------------------------

describe("ChangeTypeSchema", () => {
  it("accepts all valid change types", () => {
    for (const t of ["revert", "migration", "schema", "dep-bump"]) {
      expect(ChangeTypeSchema.safeParse(t).success).toBe(true);
    }
  });

  it("rejects unknown change types", () => {
    const result = ChangeTypeSchema.safeParse("foobar");
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DiffSizeThresholdsSchema
// ---------------------------------------------------------------------------

describe("DiffSizeThresholdsSchema", () => {
  it("accepts when only min_lines_changed is present", () => {
    expect(DiffSizeThresholdsSchema.safeParse({ min_lines_changed: 10 }).success).toBe(true);
  });

  it("accepts when only max_lines_changed is present", () => {
    expect(DiffSizeThresholdsSchema.safeParse({ max_lines_changed: 100 }).success).toBe(true);
  });

  it("accepts when both are present and min <= max", () => {
    expect(
      DiffSizeThresholdsSchema.safeParse({ min_lines_changed: 10, max_lines_changed: 100 }).success,
    ).toBe(true);
  });

  it("rejects when neither field is present", () => {
    const result = DiffSizeThresholdsSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/at least one of/);
    }
  });

  it("rejects negative integers", () => {
    const result = DiffSizeThresholdsSchema.safeParse({ min_lines_changed: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects floats", () => {
    const result = DiffSizeThresholdsSchema.safeParse({ min_lines_changed: 1.5 });
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    const result = DiffSizeThresholdsSchema.safeParse({
      min_lines_changed: 10,
      unknown_key: true,
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RuleSchema
// ---------------------------------------------------------------------------

describe("RuleSchema", () => {
  it("accepts a rule with only path_patterns", () => {
    expect(RuleSchema.safeParse({ id: "r1", path_patterns: ["src/**"] }).success).toBe(true);
  });

  it("accepts a rule with only change_types", () => {
    expect(RuleSchema.safeParse({ id: "r1", change_types: ["migration"] }).success).toBe(true);
  });

  it("accepts a rule with only diff_size_thresholds", () => {
    expect(
      RuleSchema.safeParse({ id: "r1", diff_size_thresholds: { min_lines_changed: 100 } }).success,
    ).toBe(true);
  });

  it("accepts a rule with all three signal fields", () => {
    expect(
      RuleSchema.safeParse({
        id: "r1",
        path_patterns: ["src/**"],
        change_types: ["migration"],
        diff_size_thresholds: { max_lines_changed: 500 },
      }).success,
    ).toBe(true);
  });

  it("rejects a rule with no signal fields (just id)", () => {
    const result = RuleSchema.safeParse({ id: "r1" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/no signal fields/);
    }
  });

  it("rejects empty id", () => {
    const result = RuleSchema.safeParse({ id: "", path_patterns: ["src/**"] });
    expect(result.success).toBe(false);
  });

  it("rejects empty path_patterns array", () => {
    const result = RuleSchema.safeParse({ id: "r1", path_patterns: [] });
    expect(result.success).toBe(false);
  });

  it("rejects path_patterns with empty string element", () => {
    const result = RuleSchema.safeParse({ id: "r1", path_patterns: [""] });
    expect(result.success).toBe(false);
  });

  it("rejects empty change_types array", () => {
    const result = RuleSchema.safeParse({ id: "r1", change_types: [] });
    expect(result.success).toBe(false);
  });

  it("rejects invalid change_type enum value", () => {
    const result = RuleSchema.safeParse({ id: "r1", change_types: ["foobar"] });
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    const result = RuleSchema.safeParse({ id: "r1", path_patterns: ["src/**"], unknown: true });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RiskTieringSpecSchema
// ---------------------------------------------------------------------------

describe("RiskTieringSpecSchema", () => {
  it("accepts a valid minimal spec", () => {
    const result = RiskTieringSpecSchema.safeParse(BASE_SPEC);
    expect(result.success).toBe(true);
  });

  it("accepts version in semver format", () => {
    const result = RiskTieringSpecSchema.safeParse({ ...BASE_SPEC, version: "2.10.3" });
    expect(result.success).toBe(true);
  });

  it("rejects version without patch component", () => {
    const result = RiskTieringSpecSchema.safeParse({ ...BASE_SPEC, version: "1.0" });
    expect(result.success).toBe(false);
  });

  it("rejects version with non-numeric components", () => {
    const result = RiskTieringSpecSchema.safeParse({ ...BASE_SPEC, version: "1.0.0-beta" });
    expect(result.success).toBe(false);
  });

  it("accepts fallback_tier: medium", () => {
    const result = RiskTieringSpecSchema.safeParse(BASE_SPEC);
    expect(result.success).toBe(true);
  });

  it("rejects fallback_tier: low with the v1 invariant message", () => {
    const result = RiskTieringSpecSchema.safeParse({ ...BASE_SPEC, fallback_tier: "low" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/fallback_tier must be 'medium'/);
    }
  });

  it("rejects fallback_tier: high", () => {
    const result = RiskTieringSpecSchema.safeParse({ ...BASE_SPEC, fallback_tier: "high" });
    expect(result.success).toBe(false);
  });

  it("accepts tiers with only a low tier", () => {
    const result = RiskTieringSpecSchema.safeParse({
      ...BASE_SPEC,
      tiers: { low: [BASE_LOW_RULE] },
    });
    expect(result.success).toBe(true);
  });

  it("accepts tiers with only a high tier", () => {
    const result = RiskTieringSpecSchema.safeParse({
      ...BASE_SPEC,
      tiers: { high: [BASE_HIGH_RULE] },
    });
    expect(result.success).toBe(true);
  });

  it("accepts tiers with only a medium tier", () => {
    const result = RiskTieringSpecSchema.safeParse({
      ...BASE_SPEC,
      tiers: { medium: [{ id: "med.large-diff", diff_size_thresholds: { min_lines_changed: 500 } }] },
    });
    expect(result.success).toBe(true);
  });

  it("rejects tiers with no rules at all (all keys absent)", () => {
    const result = RiskTieringSpecSchema.safeParse({ ...BASE_SPEC, tiers: {} });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/no rules declared in any tier/);
    }
  });

  it("rejects tiers where all arrays are empty", () => {
    const result = RiskTieringSpecSchema.safeParse({
      ...BASE_SPEC,
      tiers: { low: [], medium: [], high: [] },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/no rules declared in any tier/);
    }
  });

  it("rejects unknown top-level keys (strict)", () => {
    const result = RiskTieringSpecSchema.safeParse({ ...BASE_SPEC, unknown_field: true });
    expect(result.success).toBe(false);
  });

  it("rejects unknown tiers keys (strict)", () => {
    const result = RiskTieringSpecSchema.safeParse({
      ...BASE_SPEC,
      tiers: { low: [BASE_LOW_RULE], extreme: [] },
    });
    expect(result.success).toBe(false);
  });
});
