/**
 * Unit tests for `parseRiskTieringSpec` — Story 4.9 Task 6.3.
 *
 * Covers pure-validator edge cases that don't require IO:
 * - Empty file / whitespace-only
 * - Missing closing `---`
 * - Missing opening `---`
 * - Valid YAML but unknown top-level key
 * - Valid spec round-trip
 * - Duplicate rule id
 * - Rule with no signal fields
 * - fallback_tier: low (non-medium)
 * - min_lines_changed > max_lines_changed
 * - No rules in any tier
 *
 * Pure deterministic — no IO, no LLM invocation, no network.
 */
import { describe, expect, it } from "vitest";
import { parseRiskTieringSpec } from "../risk-tiering-spec.js";
import { MalformedRiskTieringSpecError } from "../../errors.js";
const SOURCE_PATH = "/fake/docs/risk-tiering.md";
const COPY_TARGET = "/plugin/docs/risk-tiering.md";
// ---------------------------------------------------------------------------
// Helper to build a minimal valid YAML frontmatter string
// ---------------------------------------------------------------------------
const VALID_FRONTMATTER = `---
version: "1.0.0"
fallback_tier: medium
tiers:
  low:
    - id: low.docs-only
      path_patterns:
        - "docs/**"
  high:
    - id: high.schema-or-migration
      change_types:
        - migration
        - schema
---

# Risk-tiering rules

Some body text.
`;
// ---------------------------------------------------------------------------
// Frontmatter delimiter tests
// ---------------------------------------------------------------------------
describe("parseRiskTieringSpec — frontmatter delimiters", () => {
    it("rejects an empty file", () => {
        expect(() => parseRiskTieringSpec("", SOURCE_PATH, COPY_TARGET)).toThrow(MalformedRiskTieringSpecError);
        expect(() => parseRiskTieringSpec("", SOURCE_PATH, COPY_TARGET)).toThrow(/empty or whitespace-only/);
    });
    it("rejects a whitespace-only file", () => {
        expect(() => parseRiskTieringSpec("   \n  \n", SOURCE_PATH, COPY_TARGET)).toThrow(/empty or whitespace-only/);
    });
    it("rejects a file that does not start with ---", () => {
        expect(() => parseRiskTieringSpec("version: 1.0.0\n", SOURCE_PATH, COPY_TARGET)).toThrow(/missing YAML frontmatter opener/);
    });
    it("rejects a file with opening --- but no closing ---", () => {
        expect(() => parseRiskTieringSpec("---\nversion: \"1.0.0\"\n", SOURCE_PATH, COPY_TARGET)).toThrow(/missing YAML frontmatter closer/);
    });
    it("accepts leading blank lines before the opening ---", () => {
        const raw = "\n\n" + VALID_FRONTMATTER;
        const result = parseRiskTieringSpec(raw, SOURCE_PATH, COPY_TARGET);
        expect(result.version).toBe("1.0.0");
    });
});
// ---------------------------------------------------------------------------
// YAML parse errors
// ---------------------------------------------------------------------------
describe("parseRiskTieringSpec — YAML errors", () => {
    it("rejects invalid YAML syntax", () => {
        const raw = "---\n: invalid: yaml: {\n---\n";
        expect(() => parseRiskTieringSpec(raw, SOURCE_PATH, COPY_TARGET)).toThrow(MalformedRiskTieringSpecError);
    });
});
// ---------------------------------------------------------------------------
// Zod schema validation
// ---------------------------------------------------------------------------
describe("parseRiskTieringSpec — schema validation", () => {
    it("rejects unknown top-level key", () => {
        const raw = `---
version: "1.0.0"
fallback_tier: medium
unknown_field: true
tiers:
  low:
    - id: low.docs-only
      path_patterns:
        - "docs/**"
---
`;
        expect(() => parseRiskTieringSpec(raw, SOURCE_PATH, COPY_TARGET)).toThrow(MalformedRiskTieringSpecError);
    });
    it("rejects fallback_tier: low", () => {
        const raw = `---
version: "1.0.0"
fallback_tier: low
tiers:
  low:
    - id: low.docs-only
      path_patterns:
        - "docs/**"
---
`;
        expect(() => parseRiskTieringSpec(raw, SOURCE_PATH, COPY_TARGET)).toThrow(/fallback_tier must be 'medium'/);
    });
    it("rejects tiers with no rules (empty object)", () => {
        const raw = `---
version: "1.0.0"
fallback_tier: medium
tiers: {}
---
`;
        expect(() => parseRiskTieringSpec(raw, SOURCE_PATH, COPY_TARGET)).toThrow(/no rules declared in any tier/);
    });
    it("rejects rule with invalid change_type", () => {
        const raw = `---
version: "1.0.0"
fallback_tier: medium
tiers:
  high:
    - id: high.bad
      change_types:
        - foobar
---
`;
        expect(() => parseRiskTieringSpec(raw, SOURCE_PATH, COPY_TARGET)).toThrow(MalformedRiskTieringSpecError);
    });
});
// ---------------------------------------------------------------------------
// Post-Zod invariants
// ---------------------------------------------------------------------------
describe("parseRiskTieringSpec — post-Zod invariants", () => {
    it("rejects duplicate rule id across tiers", () => {
        const raw = `---
version: "1.0.0"
fallback_tier: medium
tiers:
  low:
    - id: shared.id
      path_patterns:
        - "docs/**"
  high:
    - id: shared.id
      change_types:
        - migration
---
`;
        expect(() => parseRiskTieringSpec(raw, SOURCE_PATH, COPY_TARGET)).toThrow(/duplicate rule id/);
    });
    it("rejects duplicate rule id within the same tier", () => {
        const raw = `---
version: "1.0.0"
fallback_tier: medium
tiers:
  low:
    - id: dup.id
      path_patterns:
        - "docs/**"
    - id: dup.id
      path_patterns:
        - "src/**"
---
`;
        expect(() => parseRiskTieringSpec(raw, SOURCE_PATH, COPY_TARGET)).toThrow(/duplicate rule id/);
    });
    it("rejects rule with no signal fields", () => {
        const raw = `---
version: "1.0.0"
fallback_tier: medium
tiers:
  low:
    - id: no-signals
---
`;
        expect(() => parseRiskTieringSpec(raw, SOURCE_PATH, COPY_TARGET)).toThrow(/no signal fields/);
    });
    it("rejects min_lines_changed > max_lines_changed", () => {
        const raw = `---
version: "1.0.0"
fallback_tier: medium
tiers:
  high:
    - id: high.large-diff
      diff_size_thresholds:
        min_lines_changed: 100
        max_lines_changed: 50
---
`;
        expect(() => parseRiskTieringSpec(raw, SOURCE_PATH, COPY_TARGET)).toThrow(/exceeds max_lines_changed/);
    });
});
// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------
describe("parseRiskTieringSpec — round-trip", () => {
    it("parses a valid spec and returns the correct shape", () => {
        const result = parseRiskTieringSpec(VALID_FRONTMATTER, SOURCE_PATH, COPY_TARGET);
        expect(result.version).toBe("1.0.0");
        expect(result.fallback_tier).toBe("medium");
        expect(result.sourcePath).toBe(SOURCE_PATH);
        expect(result.tiers.low).toHaveLength(1);
        expect(result.tiers.low[0].id).toBe("low.docs-only");
        expect(result.tiers.high).toHaveLength(1);
        expect(result.tiers.high[0].id).toBe("high.schema-or-migration");
    });
    it("error includes sourcePath and copyTarget", () => {
        let caught;
        try {
            parseRiskTieringSpec("", SOURCE_PATH, COPY_TARGET);
        }
        catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(MalformedRiskTieringSpecError);
        expect(caught?.sourcePath).toBe(SOURCE_PATH);
        expect(caught?.copyTarget).toBe(COPY_TARGET);
    });
});
