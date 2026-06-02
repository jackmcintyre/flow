/**
 * Unit tests for slugify-standards-criterion.ts.
 * (Story 4.6 Task 3.2 / AC3b)
 */
import { describe, expect, it } from "vitest";
import { slugifyStandardsCriterion } from "../slugify-standards-criterion.js";
describe("slugifyStandardsCriterion", () => {
    it("already-lowercase hyphenated name is unchanged", () => {
        expect(slugifyStandardsCriterion("story-aligned")).toBe("story-aligned");
    });
    it("uppercased words are lowercased and spaces become hyphens", () => {
        expect(slugifyStandardsCriterion("No Canonical FS Writes Outside MCP")).toBe("no-canonical-fs-writes-outside-mcp");
    });
    it("punctuation characters are replaced by hyphens", () => {
        expect(slugifyStandardsCriterion("errors-are-typed!")).toBe("errors-are-typed");
    });
    it("leading and trailing whitespace is trimmed (via hyphen trim)", () => {
        expect(slugifyStandardsCriterion("  leading trailing  ")).toBe("leading-trailing");
    });
    it("multiple consecutive non-alnum chars collapse to a single hyphen", () => {
        expect(slugifyStandardsCriterion("foo   bar")).toBe("foo-bar");
        expect(slugifyStandardsCriterion("foo/bar/baz")).toBe("foo-bar-baz");
    });
    it("all-non-alnum string returns empty string (edge case)", () => {
        // Documented edge case: caller must handle empty id specially.
        expect(slugifyStandardsCriterion("!!!")).toBe("");
    });
    it("mixed case with punctuation produces correct slug", () => {
        expect(slugifyStandardsCriterion("Story Aligned")).toBe("story-aligned");
    });
    it("story-aligned criterion from standards-example.md slugifies to 'story-aligned'", () => {
        expect(slugifyStandardsCriterion("story-aligned")).toBe("story-aligned");
    });
    it("tests-cover-acs slugifies correctly", () => {
        expect(slugifyStandardsCriterion("tests-cover-acs")).toBe("tests-cover-acs");
    });
    it("no-canonical-fs-writes-outside-mcp slugifies correctly", () => {
        expect(slugifyStandardsCriterion("no-canonical-fs-writes-outside-mcp")).toBe("no-canonical-fs-writes-outside-mcp");
    });
    it("errors-are-typed slugifies correctly", () => {
        expect(slugifyStandardsCriterion("errors-are-typed")).toBe("errors-are-typed");
    });
});
