/**
 * Unit + integration tests for `classifyRiskTier` — AC4 sub-cases (4b)–(4f), (4l), (4m).
 *
 * Story 4.9b — FR40a, Pattern §11.
 *
 * Fixture convention: uses `await fs.mkdtemp(path.join(os.tmpdir(), "classify-risk-tier-"))`.
 * No mocking of `lookupRiskTieringSpec`, `picomatch`, or `logTelemetryEvent`.
 * The classifier runs against the real spec parser and real glob matcher.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { classifyRiskTier, RiskTierClassifierResultSchema, RiskTierBlockSchema } from "../classify-risk-tier.js";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Write a minimal valid risk-tiering spec as frontmatter + markdown body.
 * `tiers` is YAML (already stringified inline).
 */
async function seedSpec(pluginRoot, content) {
    const docsDir = path.join(pluginRoot, "docs");
    await fs.mkdir(docsDir, { recursive: true });
    await atomicWriteFile(path.join(docsDir, "risk-tiering.md"), content);
}
function makeSpec(tiersYaml) {
    return `---
version: "1.0.0"
fallback_tier: medium
tiers:
${tiersYaml}
---

# Risk-tiering rules
`;
}
// ---------------------------------------------------------------------------
// Fixture setup
// ---------------------------------------------------------------------------
let targetRepoRoot;
let pluginRoot;
beforeEach(async () => {
    targetRepoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "classify-risk-tier-"));
    pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), "classify-risk-tier-plugin-"));
});
afterEach(async () => {
    await fs.rm(targetRepoRoot, { recursive: true, force: true });
    await fs.rm(pluginRoot, { recursive: true, force: true });
});
// ---------------------------------------------------------------------------
// AC4 (4b): Path match — highest-tier-wins
// ---------------------------------------------------------------------------
describe("AC4 (4b): path match — highest-tier-wins", () => {
    it("returns high tier when high path_patterns matches, even with matching low rule", async () => {
        await seedSpec(pluginRoot, makeSpec(`  high:
    - id: high.migration
      path_patterns:
        - "**/migrations/**"
  low:
    - id: low.docs
      path_patterns:
        - "docs/**"
`));
        const result = await classifyRiskTier({
            targetRepoRoot,
            pluginRoot,
            storyId: "native:test-4b",
            changedPaths: ["db/migrations/0042_users.sql", "docs/README.md"],
            commitMessages: ["chore: add users migration"],
            diffSize: 50,
        });
        expect(result.tier).toBe("high");
        expect(result.matched_rule).toBe("high.migration");
        // Only the migration path contributed (docs matches low but we stopped at high)
        expect(result.evidence.paths).toEqual(["db/migrations/0042_users.sql"]);
        // change_types: migration detected from path (also schema via *.sql)
        expect(result.evidence.change_types).toContain("migration");
        expect(result.evidence.diff_size).toBe(50);
        // story_id preserved
        expect(result.story_id).toBe("native:test-4b");
    });
});
// ---------------------------------------------------------------------------
// AC4 (4c): Change-type match
// ---------------------------------------------------------------------------
describe("AC4 (4c): change-type match", () => {
    it("returns high tier when change_types rule matches schema detection", async () => {
        await seedSpec(pluginRoot, makeSpec(`  high:
    - id: high.schema-types
      change_types:
        - migration
        - schema
`));
        const result = await classifyRiskTier({
            targetRepoRoot,
            pluginRoot,
            storyId: "native:test-4c",
            changedPaths: ["db/schema.sql"],
            commitMessages: ["chore: rotate schema"],
            diffSize: 10,
        });
        expect(result.tier).toBe("high");
        expect(result.matched_rule).toBe("high.schema-types");
        // schema path detected, paths contributing to schema change type
        expect(result.evidence.paths).toEqual(["db/schema.sql"]);
        expect(result.evidence.change_types).toEqual(["schema"]);
        expect(result.evidence.diff_size).toBe(10);
    });
});
// ---------------------------------------------------------------------------
// AC4 (4d): Size match
// ---------------------------------------------------------------------------
describe("AC4 (4d): size match", () => {
    it("returns high tier on diff_size_thresholds only, with empty evidence.paths", async () => {
        await seedSpec(pluginRoot, makeSpec(`  high:
    - id: high.large-diff
      diff_size_thresholds:
        min_lines_changed: 1000
`));
        const result = await classifyRiskTier({
            targetRepoRoot,
            pluginRoot,
            storyId: "native:test-4d",
            changedPaths: ["src/foo.ts"],
            commitMessages: ["refactor: extract"],
            diffSize: 1500,
        });
        expect(result.tier).toBe("high");
        expect(result.matched_rule).toBe("high.large-diff");
        // size-only: no paths
        expect(result.evidence.paths).toEqual([]);
        // src/foo.ts doesn't trigger any change type
        expect(result.evidence.change_types).toEqual([]);
        expect(result.evidence.diff_size).toBe(1500);
    });
});
// ---------------------------------------------------------------------------
// AC4 (4e): Fallback
// ---------------------------------------------------------------------------
describe("AC4 (4e): fallback — no rule matches", () => {
    it("returns medium with matched_rule='fallback' when no rule matches", async () => {
        await seedSpec(pluginRoot, makeSpec(`  low:
    - id: low.docs
      path_patterns:
        - "docs/**"
`));
        const result = await classifyRiskTier({
            targetRepoRoot,
            pluginRoot,
            storyId: "native:test-4e",
            changedPaths: ["src/foo.ts"],
            commitMessages: ["feat: bar"],
            diffSize: 30,
        });
        expect(result.tier).toBe("medium");
        expect(result.matched_rule).toBe("fallback");
        expect(result.evidence.paths).toEqual([]);
        expect(result.evidence.change_types).toEqual([]);
        expect(result.evidence.diff_size).toBe(30);
    });
});
// ---------------------------------------------------------------------------
// AC4 (4f): Highest-tier-wins ordering
// ---------------------------------------------------------------------------
describe("AC4 (4f): highest-tier-wins ordering", () => {
    it("returns high over low even when low rule matches everything", async () => {
        await seedSpec(pluginRoot, makeSpec(`  low:
    - id: low.catch-all
      path_patterns:
        - "**"
  high:
    - id: high.migrations
      path_patterns:
        - "**/migrations/**"
`));
        const result = await classifyRiskTier({
            targetRepoRoot,
            pluginRoot,
            storyId: "native:test-4f",
            changedPaths: ["db/migrations/0001.sql"],
            commitMessages: [],
            diffSize: 5,
        });
        expect(result.tier).toBe("high");
        expect(result.matched_rule).toBe("high.migrations");
    });
});
// ---------------------------------------------------------------------------
// AC4 (4l): Determinism / byte-stability
// ---------------------------------------------------------------------------
describe("AC4 (4l): determinism and byte-stability", () => {
    beforeEach(async () => {
        await seedSpec(pluginRoot, makeSpec(`  high:
    - id: high.migration
      path_patterns:
        - "**/migrations/**"
  low:
    - id: low.docs
      path_patterns:
        - "docs/**"
`));
    });
    it("produces identical results for identical inputs", async () => {
        const opts = {
            targetRepoRoot,
            pluginRoot,
            storyId: "native:test-4l-1",
            changedPaths: ["db/migrations/001.sql", "docs/README.md"],
            commitMessages: [],
            diffSize: 20,
        };
        const r1 = await classifyRiskTier(opts);
        const r2 = await classifyRiskTier(opts);
        expect(r1).toEqual(r2);
    });
    it("produces identical evidence ordering regardless of changedPaths input order", async () => {
        const opts1 = {
            targetRepoRoot,
            pluginRoot,
            storyId: "native:test-4l-2",
            changedPaths: ["docs/README.md", "db/migrations/001.sql"],
            commitMessages: [],
            diffSize: 20,
        };
        const opts2 = {
            ...opts1,
            changedPaths: ["db/migrations/001.sql", "docs/README.md"],
        };
        const r1 = await classifyRiskTier(opts1);
        const r2 = await classifyRiskTier(opts2);
        // Both should return high (migration path matches first) with same sorted evidence
        expect(r1.evidence.paths).toEqual(r2.evidence.paths);
        expect(r1.evidence.change_types).toEqual(r2.evidence.change_types);
    });
});
// ---------------------------------------------------------------------------
// AC4 (4m): Schema-strict assertions
// ---------------------------------------------------------------------------
describe("AC4 (4m): schema-strict assertions", () => {
    it("RiskTierBlockSchema rejects an unknown extra key in evidence", () => {
        const bad = {
            tier: "high",
            matched_rule: "some-rule",
            evidence: {
                paths: [],
                change_types: [],
                diff_size: 10,
                unknown_field: "oops",
            },
        };
        const result = RiskTierBlockSchema.safeParse(bad);
        expect(result.success).toBe(false);
    });
    it("RiskTierBlockSchema rejects an unknown tier value", () => {
        const bad = {
            tier: "critical",
            matched_rule: "some-rule",
            evidence: { paths: [], change_types: [], diff_size: 10 },
        };
        const result = RiskTierBlockSchema.safeParse(bad);
        expect(result.success).toBe(false);
    });
    it("RiskTierClassifierResultSchema rejects unknown tier value", () => {
        const bad = {
            story_id: "native:foo",
            tier: "extreme",
            matched_rule: "x",
            evidence: { paths: [], change_types: [], diff_size: 0 },
        };
        const result = RiskTierClassifierResultSchema.safeParse(bad);
        expect(result.success).toBe(false);
        // Zod 4.x error format
        expect(JSON.stringify(result.error?.issues)).toContain("Invalid option");
    });
    it("RiskTierBlockSchema accepts a valid block", () => {
        const good = {
            tier: "medium",
            matched_rule: "fallback",
            evidence: { paths: [], change_types: [], diff_size: 5 },
        };
        const result = RiskTierBlockSchema.safeParse(good);
        expect(result.success).toBe(true);
    });
});
// ---------------------------------------------------------------------------
// Story 10.4 AC4 — author-time classification (declared paths, no git diff)
//
// Confirms `classifyRiskTier` is separable from a real PR diff: fed
// `commitMessages: []` and `diffSize: 0` (the author-time mode `scanSources`
// uses), it still matches `path_patterns` rules from the declared `changedPaths`
// and returns a meaningful tier — not just `fallback`.
// ---------------------------------------------------------------------------
describe("Story 10.4 AC4: author-time path-pattern classification (no diff)", () => {
    it("a path set matching a high-tier path_patterns rule returns high with the matched rule id, with commitMessages:[] and diffSize:0", async () => {
        await seedSpec(pluginRoot, makeSpec(`  high:
    - id: high.migration
      path_patterns:
        - "**/migrations/**"
  low:
    - id: low.docs
      path_patterns:
        - "docs/**"
`));
        const result = await classifyRiskTier({
            targetRepoRoot,
            pluginRoot,
            storyId: "native:test-10-4-high",
            // DECLARED paths only — no diff exists yet (author time).
            changedPaths: ["db/migrations/0042_users.sql"],
            commitMessages: [],
            diffSize: 0,
        });
        expect(result.tier).toBe("high");
        expect(result.matched_rule).toBe("high.migration");
        // The matched rule id is in the evidence (matched_rule) and the path that
        // triggered it is in evidence.paths.
        expect(result.evidence.paths).toEqual(["db/migrations/0042_users.sql"]);
        expect(result.evidence.diff_size).toBe(0);
    });
    it("a path set matching only a low-tier rule returns low (not fallback) at author time", async () => {
        await seedSpec(pluginRoot, makeSpec(`  high:
    - id: high.migration
      path_patterns:
        - "**/migrations/**"
  low:
    - id: low.docs
      path_patterns:
        - "docs/**"
`));
        const result = await classifyRiskTier({
            targetRepoRoot,
            pluginRoot,
            storyId: "native:test-10-4-low",
            changedPaths: ["docs/guide.md"],
            commitMessages: [],
            diffSize: 0,
        });
        expect(result.tier).toBe("low");
        expect(result.matched_rule).toBe("low.docs");
        // Author-time classification is meaningful — NOT the fallback tier.
        expect(result.matched_rule).not.toBe("fallback");
    });
    it("a path set matching no rule lands at the fallback tier (still correct with no signal)", async () => {
        await seedSpec(pluginRoot, makeSpec(`  high:
    - id: high.migration
      path_patterns:
        - "**/migrations/**"
  low:
    - id: low.docs
      path_patterns:
        - "docs/**"
`));
        const result = await classifyRiskTier({
            targetRepoRoot,
            pluginRoot,
            storyId: "native:test-10-4-fallback",
            changedPaths: ["src/some-feature.ts"],
            commitMessages: [],
            diffSize: 0,
        });
        expect(result.tier).toBe("medium");
        expect(result.matched_rule).toBe("fallback");
    });
});
