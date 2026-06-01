/**
 * Schema tests for `ExecutionManifestSchema` — Story 4.3 Task 7.3 + Story 5.13.
 *
 * Tests the `rework_count` field added in Story 4.3 and the closed `blocked_by`
 * enum introduced in Story 5.13 (thirteen members; no free-string fallback).
 */

import { describe, expect, it } from "vitest";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { parseExecutionManifest } from "../execution-manifest.js";
import { MalformedExecutionManifestError } from "../../errors.js";

// ---------------------------------------------------------------------------
// Base fixture — a valid minimal manifest
// ---------------------------------------------------------------------------

const BASE_MANIFEST = {
  ref: "native:01HZABC0000000000000000001",
  status: "in-progress" as const,
  adapter: "native",
  source_path: ".crew/native-stories/01HZABC0000000000000000001.md",
  source_hash: "a".repeat(64),
  depends_on: [],
  acceptance_criteria: [{ text: "Given x, when y, then z.", kind: "integration" as const }],
  title: "Test Story",
  narrative: "As a dev, I want to test.",
  withdrawn: false,
  claimed_by: "01HZSESSION00000000000001",
};

// ---------------------------------------------------------------------------
// rework_count tests
// ---------------------------------------------------------------------------

describe("rework_count field (Story 4.3)", () => {
  it("parses successfully when rework_count is omitted (undefined → 0 semantics)", () => {
    const manifest = parseExecutionManifest(BASE_MANIFEST, { absPath: "/fake/path.yaml" });
    expect(manifest.rework_count).toBeUndefined();
  });

  it("parses successfully when rework_count is 0", () => {
    const manifest = parseExecutionManifest(
      { ...BASE_MANIFEST, rework_count: 0 },
      { absPath: "/fake/path.yaml" },
    );
    expect(manifest.rework_count).toBe(0);
  });

  it("parses successfully when rework_count is 1", () => {
    const manifest = parseExecutionManifest(
      { ...BASE_MANIFEST, rework_count: 1 },
      { absPath: "/fake/path.yaml" },
    );
    expect(manifest.rework_count).toBe(1);
  });

  it("parses successfully when rework_count is 3", () => {
    const manifest = parseExecutionManifest(
      { ...BASE_MANIFEST, rework_count: 3 },
      { absPath: "/fake/path.yaml" },
    );
    expect(manifest.rework_count).toBe(3);
  });

  it("throws MalformedExecutionManifestError when rework_count is negative (-1)", () => {
    expect(() =>
      parseExecutionManifest(
        { ...BASE_MANIFEST, rework_count: -1 },
        { absPath: "/fake/path.yaml" },
      ),
    ).toThrow(MalformedExecutionManifestError);
  });

  it("throws MalformedExecutionManifestError when rework_count is a float", () => {
    expect(() =>
      parseExecutionManifest(
        { ...BASE_MANIFEST, rework_count: 1.5 },
        { absPath: "/fake/path.yaml" },
      ),
    ).toThrow(MalformedExecutionManifestError);
  });
});

// ---------------------------------------------------------------------------
// blocked_by extension tests (Story 4.3)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// blocked_by closed enum tests (Story 5.13 — thirteen members, no fallback)
// ---------------------------------------------------------------------------

const ALL_BLOCKED_BY_MEMBERS = [
  "handoff-grammar",
  "gh-defer",
  "gh-retry",
  "gh-needs-human",
  "reviewer-no-session-result",
  "reviewer-verdict-needs-changes",
  "reviewer-verdict-blocked",
  "routing-failure",
  "routing-self-yield",
  "planning-discipline",
  "orphan-no-transcript",
  "reviewer-grammar",
  "deps-drift",
] as const;

describe("blocked_by field — closed enum (Story 5.13)", () => {
  for (const member of ALL_BLOCKED_BY_MEMBERS) {
    it(`parses successfully with blocked_by: '${member}'`, () => {
      const manifest = parseExecutionManifest(
        { ...BASE_MANIFEST, blocked_by: member },
        { absPath: "/fake/path.yaml" },
      );
      expect(manifest.blocked_by).toBe(member);
    });
  }

  it("parses successfully when blocked_by is omitted", () => {
    const manifest = parseExecutionManifest(BASE_MANIFEST, { absPath: "/fake/path.yaml" });
    expect(manifest.blocked_by).toBeUndefined();
  });

  it("throws MalformedExecutionManifestError for out-of-enum value 'some-future-value' (closed enum — AC5 flip)", () => {
    // Story 5.13 AC5: the string fallback is REMOVED. Out-of-enum values must now
    // fail at the Zod boundary. This test was previously asserting acceptance;
    // it is flipped to assert Zod throw.
    expect(() =>
      parseExecutionManifest(
        { ...BASE_MANIFEST, blocked_by: "some-future-value" },
        { absPath: "/fake/path.yaml" },
      ),
    ).toThrow(MalformedExecutionManifestError);
  });

  it("throws MalformedExecutionManifestError for removed 'source-drift' value (no live writer)", () => {
    // 'source-drift' was in the previous union but has no live writer; removed in v1 enum.
    expect(() =>
      parseExecutionManifest(
        { ...BASE_MANIFEST, blocked_by: "source-drift" },
        { absPath: "/fake/path.yaml" },
      ),
    ).toThrow(MalformedExecutionManifestError);
  });
});

// ---------------------------------------------------------------------------
// retro fields (Story 6.1) — AC4
// ---------------------------------------------------------------------------

describe("retro fields (Story 6.1)", () => {
  it("parses successfully when retro fields are omitted (all three resolve to undefined)", () => {
    const manifest = parseExecutionManifest(BASE_MANIFEST, {
      absPath: "/fake/path.yaml",
    });
    expect(manifest.lessons).toBeUndefined();
    expect(manifest.failure_class).toBeUndefined();
    expect(manifest.duration_seconds).toBeUndefined();
  });

  it("round-trips a populated lessons array unchanged", () => {
    const lessons = [
      {
        kind: "pattern" as const,
        text: "Use parseExecutionManifest as the single seam for manifest reads.",
      },
      {
        kind: "pitfall" as const,
        text: "Don't add z.string() fallbacks to closed enums.",
        failure_class: "schema-erosion",
        routed_to: "rule",
      },
    ];
    const manifest = parseExecutionManifest(
      { ...BASE_MANIFEST, lessons },
      { absPath: "/fake/path.yaml" },
    );
    expect(manifest.lessons).toEqual(lessons);
  });

  it("round-trips a story-level failure_class", () => {
    const manifest = parseExecutionManifest(
      { ...BASE_MANIFEST, failure_class: "ac-marker-gap" },
      { absPath: "/fake/path.yaml" },
    );
    expect(manifest.failure_class).toBe("ac-marker-gap");
  });

  it("accepts duration_seconds = 0 (non-negative integer)", () => {
    const manifest = parseExecutionManifest(
      { ...BASE_MANIFEST, duration_seconds: 0 },
      { absPath: "/fake/path.yaml" },
    );
    expect(manifest.duration_seconds).toBe(0);
  });

  it("accepts duration_seconds = 3600 (non-negative integer)", () => {
    const manifest = parseExecutionManifest(
      { ...BASE_MANIFEST, duration_seconds: 3600 },
      { absPath: "/fake/path.yaml" },
    );
    expect(manifest.duration_seconds).toBe(3600);
  });

  it("throws MalformedExecutionManifestError when duration_seconds is negative (-1)", () => {
    expect(() =>
      parseExecutionManifest(
        { ...BASE_MANIFEST, duration_seconds: -1 },
        { absPath: "/fake/path.yaml" },
      ),
    ).toThrow(MalformedExecutionManifestError);
  });

  it("throws MalformedExecutionManifestError when duration_seconds is a float (1.5)", () => {
    expect(() =>
      parseExecutionManifest(
        { ...BASE_MANIFEST, duration_seconds: 1.5 },
        { absPath: "/fake/path.yaml" },
      ),
    ).toThrow(MalformedExecutionManifestError);
  });
});

// ---------------------------------------------------------------------------
// ready field (Story 9.1 — AC2: orthogonal operator readiness brake)
// ---------------------------------------------------------------------------

describe("ready field (Story 9.1)", () => {
  // A to-do/ manifest is the realistic carrier of `ready`. Build a base that
  // predates the field (no `ready` key, no `claimed_by`) to prove backward-compat.
  const TODO_MANIFEST_WITHOUT_READY = {
    ref: "native:01HZABC0000000000000000002",
    status: "to-do" as const,
    adapter: "native",
    source_path: ".crew/native-stories/01HZABC0000000000000000002.md",
    source_hash: "b".repeat(64),
    depends_on: [],
    acceptance_criteria: [{ text: "Given x, when y, then z.", kind: "integration" as const }],
    title: "Readiness Test Story",
    narrative: "As a dev, I want to test the readiness brake.",
    withdrawn: false,
  };

  it("parses a manifest authored before the field existed and reads ready as false (default-closed)", () => {
    const manifest = parseExecutionManifest(TODO_MANIFEST_WITHOUT_READY, {
      absPath: "/fake/path.yaml",
    });
    expect(manifest.ready).toBe(false);
  });

  it("parses a manifest carrying ready: true and reads it as true", () => {
    const manifest = parseExecutionManifest(
      { ...TODO_MANIFEST_WITHOUT_READY, ready: true },
      { absPath: "/fake/path.yaml" },
    );
    expect(manifest.ready).toBe(true);
  });

  it("parses a manifest carrying ready: false and reads it as false", () => {
    const manifest = parseExecutionManifest(
      { ...TODO_MANIFEST_WITHOUT_READY, ready: false },
      { absPath: "/fake/path.yaml" },
    );
    expect(manifest.ready).toBe(false);
  });

  it("ready is orthogonal to withdrawn — both can be true on the same manifest", () => {
    const manifest = parseExecutionManifest(
      { ...TODO_MANIFEST_WITHOUT_READY, ready: true, withdrawn: true },
      { absPath: "/fake/path.yaml" },
    );
    expect(manifest.ready).toBe(true);
    expect(manifest.withdrawn).toBe(true);
  });

  it("preserves the strict posture — an unknown key is still rejected (Story 9.1 must not weaken the schema)", () => {
    expect(() =>
      parseExecutionManifest(
        { ...TODO_MANIFEST_WITHOUT_READY, ready: true, not_a_real_field: 1 },
        { absPath: "/fake/path.yaml" },
      ),
    ).toThrow(MalformedExecutionManifestError);
  });

  it("throws MalformedExecutionManifestError when ready is a non-boolean", () => {
    expect(() =>
      parseExecutionManifest(
        { ...TODO_MANIFEST_WITHOUT_READY, ready: "yes" },
        { absPath: "/fake/path.yaml" },
      ),
    ).toThrow(MalformedExecutionManifestError);
  });
});

// ---------------------------------------------------------------------------
// per-AC verification field (Story 10.1 — AC3: optional + additive on the
// manifest AC object; native carries it, legacy / BMad omit it)
// ---------------------------------------------------------------------------

describe("acceptance_criteria.verification field (Story 10.1)", () => {
  // A legacy manifest whose ACs predate the verification field — exactly the
  // BASE_MANIFEST shape (no `verification` key on the AC).
  const LEGACY_AC_MANIFEST = {
    ...BASE_MANIFEST,
    acceptance_criteria: [
      { text: "Given x, when y, then z.", kind: "integration" as const },
    ],
  };

  // A native-scanned manifest carrying the verification field through from the
  // SourceStory.
  const NATIVE_AC_MANIFEST = {
    ...BASE_MANIFEST,
    acceptance_criteria: [
      {
        text: "Given x, when y, then z.",
        kind: "integration" as const,
        verification: { type: "vitest" as const, target: "src/__tests__/x.test.ts" },
      },
    ],
  };

  it("parses a legacy manifest whose AC omits verification (additive — no regression)", () => {
    const manifest = parseExecutionManifest(LEGACY_AC_MANIFEST, {
      absPath: "/fake/path.yaml",
    });
    expect(manifest.acceptance_criteria[0]!.verification).toBeUndefined();
  });

  it("parses a native manifest whose AC carries verification and preserves type + target", () => {
    const manifest = parseExecutionManifest(NATIVE_AC_MANIFEST, {
      absPath: "/fake/path.yaml",
    });
    expect(manifest.acceptance_criteria[0]!.verification).toEqual({
      type: "vitest",
      target: "src/__tests__/x.test.ts",
    });
  });

  it("accepts an artifact verification type as well as vitest", () => {
    const manifest = parseExecutionManifest(
      {
        ...BASE_MANIFEST,
        acceptance_criteria: [
          {
            text: "Given x, when y, then z.",
            kind: "integration" as const,
            verification: { type: "artifact" as const, target: "build/out.json" },
          },
        ],
      },
      { absPath: "/fake/path.yaml" },
    );
    expect(manifest.acceptance_criteria[0]!.verification).toEqual({
      type: "artifact",
      target: "build/out.json",
    });
  });

  it("rejects an unknown verification type (strict enum)", () => {
    expect(() =>
      parseExecutionManifest(
        {
          ...BASE_MANIFEST,
          acceptance_criteria: [
            {
              text: "Given x, when y, then z.",
              kind: "integration" as const,
              verification: { type: "jest", target: "src/__tests__/x.test.ts" },
            },
          ],
        },
        { absPath: "/fake/path.yaml" },
      ),
    ).toThrow(MalformedExecutionManifestError);
  });

  it("rejects an empty verification target (min(1))", () => {
    expect(() =>
      parseExecutionManifest(
        {
          ...BASE_MANIFEST,
          acceptance_criteria: [
            {
              text: "Given x, when y, then z.",
              kind: "integration" as const,
              verification: { type: "vitest", target: "" },
            },
          ],
        },
        { absPath: "/fake/path.yaml" },
      ),
    ).toThrow(MalformedExecutionManifestError);
  });

  it("round-trips through yaml.stringify with the verification field intact", () => {
    const parsed = parseExecutionManifest(NATIVE_AC_MANIFEST, {
      absPath: "/fake/path.yaml",
    });
    const reparsed = parseExecutionManifest(yamlParse(yamlStringify(parsed)), {
      absPath: "/fake/path.yaml",
    });
    expect(reparsed.acceptance_criteria[0]!.verification).toEqual({
      type: "vitest",
      target: "src/__tests__/x.test.ts",
    });
  });

  it("round-trips through yaml.stringify with the verification field absent (legacy)", () => {
    const parsed = parseExecutionManifest(LEGACY_AC_MANIFEST, {
      absPath: "/fake/path.yaml",
    });
    const reparsed = parseExecutionManifest(yamlParse(yamlStringify(parsed)), {
      absPath: "/fake/path.yaml",
    });
    expect(reparsed.acceptance_criteria[0]!.verification).toBeUndefined();
  });
});
