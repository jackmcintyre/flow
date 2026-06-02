/**
 * Unit tests for `matchRule` — AC4 sub-case (4k).
 *
 * Story 4.9b — Pattern §11 rule-matching primitive.
 */
import { describe, it, expect } from "vitest";
import { matchRule } from "../match-rules.js";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makePathRule(patterns) {
    return { id: "test-path-rule", path_patterns: patterns };
}
function makeChangeTypeRule(types) {
    return { id: "test-ct-rule", change_types: types };
}
function makeSizeRule(opts) {
    return {
        id: "test-size-rule",
        diff_size_thresholds: {
            ...(opts.min !== undefined ? { min_lines_changed: opts.min } : {}),
            ...(opts.max !== undefined ? { max_lines_changed: opts.max } : {}),
        },
    };
}
// ---------------------------------------------------------------------------
// path_patterns signal
// ---------------------------------------------------------------------------
describe("matchRule — path_patterns", () => {
    it("matches when at least one path hits a pattern", () => {
        const rule = makePathRule(["**/migrations/**"]);
        const result = matchRule(rule, {
            changedPaths: ["db/migrations/0001.sql", "src/foo.ts"],
            detectedChangeTypes: [],
            diffSize: 10,
        });
        expect(result.matched).toBe(true);
        expect(result.matchedPaths).toEqual(["db/migrations/0001.sql"]);
    });
    it("does not match when no path hits any pattern", () => {
        const rule = makePathRule(["docs/**"]);
        const result = matchRule(rule, {
            changedPaths: ["src/foo.ts"],
            detectedChangeTypes: [],
            diffSize: 5,
        });
        expect(result.matched).toBe(false);
        expect(result.matchedPaths).toEqual([]);
    });
    it("returns all matched paths (multiple hits)", () => {
        const rule = makePathRule(["**/*.md"]);
        const result = matchRule(rule, {
            changedPaths: ["docs/a.md", "docs/b.md", "src/foo.ts"],
            detectedChangeTypes: [],
            diffSize: 3,
        });
        expect(result.matched).toBe(true);
        expect(result.matchedPaths).toEqual(["docs/a.md", "docs/b.md"]);
    });
    it("picomatch POSIX: forward-slash paths match **/*.md regardless of OS", () => {
        const rule = makePathRule(["**/*.md"]);
        const result = matchRule(rule, {
            changedPaths: ["a/b/c/README.md"],
            detectedChangeTypes: [],
            diffSize: 1,
        });
        expect(result.matched).toBe(true);
    });
});
// ---------------------------------------------------------------------------
// change_types signal
// ---------------------------------------------------------------------------
describe("matchRule — change_types", () => {
    it("matches when at least one detected type is in the rule's array", () => {
        const rule = makeChangeTypeRule(["migration", "schema"]);
        const result = matchRule(rule, {
            changedPaths: [],
            detectedChangeTypes: ["schema"],
            diffSize: 10,
        });
        expect(result.matched).toBe(true);
        expect(result.matchedPaths).toEqual([]);
    });
    it("does not match when no detected type is in the rule's array", () => {
        const rule = makeChangeTypeRule(["migration"]);
        const result = matchRule(rule, {
            changedPaths: [],
            detectedChangeTypes: ["dep-bump"],
            diffSize: 10,
        });
        expect(result.matched).toBe(false);
    });
});
// ---------------------------------------------------------------------------
// diff_size_thresholds signal
// ---------------------------------------------------------------------------
describe("matchRule — diff_size_thresholds", () => {
    it("matches diffSize within [min, max] range", () => {
        const rule = makeSizeRule({ min: 100, max: 200 });
        expect(matchRule(rule, { changedPaths: [], detectedChangeTypes: [], diffSize: 150 }).matched).toBe(true);
    });
    it("does not match diffSize below min", () => {
        const rule = makeSizeRule({ min: 100, max: 200 });
        expect(matchRule(rule, { changedPaths: [], detectedChangeTypes: [], diffSize: 99 }).matched).toBe(false);
    });
    it("does not match diffSize above max", () => {
        const rule = makeSizeRule({ min: 100, max: 200 });
        expect(matchRule(rule, { changedPaths: [], detectedChangeTypes: [], diffSize: 201 }).matched).toBe(false);
    });
    it("matches with only min declared (no upper bound)", () => {
        const rule = makeSizeRule({ min: 1000 });
        expect(matchRule(rule, { changedPaths: [], detectedChangeTypes: [], diffSize: 9999 }).matched).toBe(true);
    });
    it("matches with only max declared (no lower bound)", () => {
        const rule = makeSizeRule({ max: 50 });
        expect(matchRule(rule, { changedPaths: [], detectedChangeTypes: [], diffSize: 0 }).matched).toBe(true);
    });
    it("does not match when diffSize exceeds max-only rule", () => {
        const rule = makeSizeRule({ max: 50 });
        expect(matchRule(rule, { changedPaths: [], detectedChangeTypes: [], diffSize: 51 }).matched).toBe(false);
    });
});
// ---------------------------------------------------------------------------
// AND-combination
// ---------------------------------------------------------------------------
describe("matchRule — AND-combination", () => {
    it("rule with path_patterns + change_types: matches only when BOTH hold", () => {
        const rule = {
            id: "and-rule",
            path_patterns: ["**/migrations/**"],
            change_types: ["migration"],
        };
        // Both hold
        expect(matchRule(rule, {
            changedPaths: ["db/migrations/0001.sql"],
            detectedChangeTypes: ["migration"],
            diffSize: 10,
        }).matched).toBe(true);
        // Only path matches, no change_type match
        expect(matchRule(rule, {
            changedPaths: ["db/migrations/0001.sql"],
            detectedChangeTypes: ["dep-bump"],
            diffSize: 10,
        }).matched).toBe(false);
        // Only change_type matches, no path match
        expect(matchRule(rule, {
            changedPaths: ["src/foo.ts"],
            detectedChangeTypes: ["migration"],
            diffSize: 10,
        }).matched).toBe(false);
    });
});
// ---------------------------------------------------------------------------
// additive_only signal (Stage-2 part C)
// ---------------------------------------------------------------------------
describe("matchRule — additive_only", () => {
    const rule = { id: "low.additive-only", additive_only: true };
    it("matches when the diff is additive-only", () => {
        const result = matchRule(rule, {
            changedPaths: ["src/new.ts"],
            detectedChangeTypes: [],
            diffSize: 10,
            additiveOnly: true,
        });
        expect(result.matched).toBe(true);
    });
    it("does NOT match when the diff is not additive-only", () => {
        const result = matchRule(rule, {
            changedPaths: ["src/existing.ts"],
            detectedChangeTypes: [],
            diffSize: 10,
            additiveOnly: false,
        });
        expect(result.matched).toBe(false);
    });
    it("does NOT match when additiveOnly is unknown (undefined → conservative)", () => {
        const result = matchRule(rule, {
            changedPaths: ["src/x.ts"],
            detectedChangeTypes: [],
            diffSize: 10,
        });
        expect(result.matched).toBe(false);
    });
    it("AND-combines with diff_size_thresholds — additive AND within size matches", () => {
        const combo = {
            id: "low.additive-bounded",
            additive_only: true,
            diff_size_thresholds: { max_lines_changed: 300 },
        };
        expect(matchRule(combo, { changedPaths: ["a.ts"], detectedChangeTypes: [], diffSize: 200, additiveOnly: true }).matched).toBe(true);
        // additive but over the size cap → no match
        expect(matchRule(combo, { changedPaths: ["a.ts"], detectedChangeTypes: [], diffSize: 400, additiveOnly: true }).matched).toBe(false);
    });
});
// ---------------------------------------------------------------------------
// path_excludes guard (subtractive)
// ---------------------------------------------------------------------------
describe("matchRule — all_paths_match (low-tier strictness)", () => {
    const rule = {
        id: "low.docs-only",
        path_patterns: ["docs/**", "**/*.md"],
        all_paths_match: true,
    };
    it("matches when EVERY changed file matches a pattern", () => {
        expect(matchRule(rule, {
            changedPaths: ["docs/a.md", "README.md", "docs/sub/b.md"],
            detectedChangeTypes: [],
            diffSize: 10,
        }).matched).toBe(true);
    });
    it("does NOT match when even one file is outside the patterns (code alongside docs)", () => {
        expect(matchRule(rule, {
            changedPaths: ["docs/a.md", "src/index.ts"],
            detectedChangeTypes: [],
            diffSize: 10,
        }).matched).toBe(false);
    });
    it("does NOT match an empty changed-path set", () => {
        expect(matchRule(rule, { changedPaths: [], detectedChangeTypes: [], diffSize: 0 }).matched).toBe(false);
    });
    it("without the flag, the same patterns match on ANY single file (default semantic)", () => {
        const anyRule = { id: "x", path_patterns: ["docs/**", "**/*.md"] };
        expect(matchRule(anyRule, {
            changedPaths: ["docs/a.md", "src/index.ts"],
            detectedChangeTypes: [],
            diffSize: 10,
        }).matched).toBe(true);
    });
});
describe("matchRule — path_excludes", () => {
    const rule = {
        id: "low.additive-only",
        additive_only: true,
        path_excludes: [".github/**", "**/package.json"],
    };
    it("does NOT match when a changed path hits an exclude, even if additive", () => {
        expect(matchRule(rule, {
            changedPaths: [".github/workflows/release.yml"],
            detectedChangeTypes: [],
            diffSize: 10,
            additiveOnly: true,
        }).matched).toBe(false);
    });
    it("does NOT match when ANY of several paths is excluded", () => {
        expect(matchRule(rule, {
            changedPaths: ["src/safe.ts", "tools/foo/package.json"],
            detectedChangeTypes: [],
            diffSize: 10,
            additiveOnly: true,
        }).matched).toBe(false);
    });
    it("matches when no changed path is excluded", () => {
        expect(matchRule(rule, {
            changedPaths: ["src/new-helper.ts", "src/new-helper.test.ts"],
            detectedChangeTypes: [],
            diffSize: 10,
            additiveOnly: true,
        }).matched).toBe(true);
    });
});
