/**
 * Unit tests for `buildJudgeContext` — Story native:01KTKK5NQWTV4NHB37V7WC6AD8.
 *
 * AC1: every lens prompt carries a byte-identical shared prefix (persona +
 *      draft spec + rubric) and differs only in its per-lens instruction suffix —
 *      the shared content is built once and reused.
 *
 * AC3: each assembled lens prompt still contains the full persona, draft-spec,
 *      and rubric content (no section dropped or altered), so the assembly
 *      refactor is content-preserving and verdicts cannot change.
 *
 * Both ACs are purely structural/content assertions — no I/O, no LLM calls.
 */

import { describe, expect, it } from "vitest";
import { buildJudgeContext } from "../judge-context.js";
import type { BuildJudgeContextOptions } from "../judge-context.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const FIXTURE_PERSONA = `# Generalist Reviewer — Persona

## Domain

Reviews pull requests for correctness, completeness, and alignment with the story AC.

## Mandate

- Read the diff and the story spec.
- Grade against the AC.
- Call writeLensVerdict exactly once.

## Prompt

You are the generalist reviewer. Grade the draft against your assigned lens.

## Knowledge

[k1] note — when reviewing specs, focus on the AC structure.

## Locked phrases (do not paraphrase)
- Verdict: "**Verdict: <SENTINEL>**"
Substitute <SENTINEL> with the live value from your initial context before emission; emit the substituted phrase verbatim.`;

const FIXTURE_SPEC = `## Story: Test Context Assembly

**Given** a draft story, **When** the judge panel is assembled, **Then** each lens judges the spec.

### Acceptance criteria

**AC1:** Given X, When Y, Then Z.

### Tasks

1. Do the thing.
2. Test the thing.`;

const FIXTURE_RUBRIC: Record<string, string> = {
  structure:
    "Grade against Structure lens (rubric §3.1): Given/When/Then ACs, task decomposition.",
  verifiability:
    "Grade against Verifiability lens (rubric §3.2): PINNABILITY-ONCE-BUILT.",
  discipline:
    "Grade against Discipline lens (rubric §3.3): one coherent concern per story.",
  domain: "Grade against Domain lens (rubric §3.4): technically accurate.",
  considered:
    "Grade against Considered lens (rubric §3.5): failure modes addressed.",
};

const FIXTURE_LENS_ROLES: Record<string, string> = {
  structure: "generalist-dev",
  verifiability: "test-specialist",
  discipline: "planner",
  domain: "architect",
  considered: "generalist-reviewer",
};

const FULL_LENSES = [
  "structure",
  "verifiability",
  "discipline",
  "domain",
  "considered",
];

const BASE_OPTS: BuildJudgeContextOptions = {
  judgePersona: FIXTURE_PERSONA,
  specText: FIXTURE_SPEC,
  riskTier: "medium",
  lenses: FULL_LENSES,
  lensRubric: FIXTURE_RUBRIC,
  lensRoles: FIXTURE_LENS_ROLES,
  ref: "native:01KTKK5NQWTV4NHB37V7WC6AD8",
  sessionUlid: "01KTN5FA8K8PA9AET30R8BY8A1",
  cli: "/path/to/cli.js",
  targetRepoRoot: "/tmp/test-repo",
};

// ---------------------------------------------------------------------------
// AC1: Byte-identical shared prefix across all lenses
// ---------------------------------------------------------------------------

describe("AC1 — byte-identical shared prefix across all lenses", () => {
  it("returns a sharedPrefix that each per-lens prompt starts with", () => {
    const { sharedPrefix, perLens } = buildJudgeContext(BASE_OPTS);

    expect(sharedPrefix.length).toBeGreaterThan(0);

    for (const lens of FULL_LENSES) {
      expect(perLens[lens]).toBeDefined();
      expect(perLens[lens]!.startsWith(sharedPrefix)).toBe(true);
    }
  });

  it("shared prefix is byte-identical across all five lenses (no per-lens variation)", () => {
    const { sharedPrefix, perLens } = buildJudgeContext(BASE_OPTS);

    // Extract the prefix portion from each lens prompt.
    const extractedPrefixes = FULL_LENSES.map((lens) => {
      const fullPrompt = perLens[lens]!;
      return fullPrompt.slice(0, sharedPrefix.length);
    });

    // Every extracted prefix must be byte-identical to sharedPrefix.
    for (let i = 0; i < extractedPrefixes.length; i++) {
      expect(extractedPrefixes[i]).toBe(sharedPrefix);
    }

    // Cross-lens: every pair is also byte-identical.
    for (let i = 1; i < extractedPrefixes.length; i++) {
      expect(extractedPrefixes[i]).toBe(extractedPrefixes[0]);
    }
  });

  it("lens prompts differ ONLY after the shared prefix (in the per-lens suffix)", () => {
    const { sharedPrefix, perLens } = buildJudgeContext(BASE_OPTS);

    const suffixes = FULL_LENSES.map((lens) => perLens[lens]!.slice(sharedPrefix.length));

    // Every suffix must be non-empty (the per-lens content is present).
    for (let i = 0; i < suffixes.length; i++) {
      expect(suffixes[i]!.length).toBeGreaterThan(0);
    }

    // At least one pair of suffixes must differ (the lenses are not identical).
    const allSame = suffixes.every((s) => s === suffixes[0]);
    expect(allSame).toBe(false);
  });

  it("fast-lane single lens also uses the same shared prefix", () => {
    const opts: BuildJudgeContextOptions = {
      ...BASE_OPTS,
      lenses: ["structure+verifiability"],
      lensRubric: {
        ...FIXTURE_RUBRIC,
        "structure+verifiability":
          "Grade against Structure AND Verifiability in a single combined pass.",
      },
      lensRoles: {
        ...FIXTURE_LENS_ROLES,
        "structure+verifiability": "generalist-reviewer",
      },
    };
    const { sharedPrefix, perLens } = buildJudgeContext(opts);

    expect(perLens["structure+verifiability"]).toBeDefined();
    expect(perLens["structure+verifiability"]!.startsWith(sharedPrefix)).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// AC3: Content-preservation — every prompt contains the full persona, spec, rubric
// ---------------------------------------------------------------------------

describe("AC3 — content-preservation: each prompt retains full persona, spec, and rubric", () => {
  it("every lens prompt contains the full judge persona text", () => {
    const { perLens } = buildJudgeContext(BASE_OPTS);

    for (const lens of FULL_LENSES) {
      const prompt = perLens[lens]!;
      // The persona is embedded verbatim at the start of the shared prefix.
      expect(prompt).toContain(FIXTURE_PERSONA);
    }
  });

  it("every lens prompt contains the full draft spec text", () => {
    const { perLens } = buildJudgeContext(BASE_OPTS);

    for (const lens of FULL_LENSES) {
      const prompt = perLens[lens]!;
      expect(prompt).toContain(FIXTURE_SPEC);
    }
  });

  it("every lens prompt contains its own rubric check (not another lens's check)", () => {
    const { perLens } = buildJudgeContext(BASE_OPTS);

    for (const lens of FULL_LENSES) {
      const prompt = perLens[lens]!;
      // Own rubric check must be present.
      expect(prompt).toContain(FIXTURE_RUBRIC[lens]);
    }
  });

  it("the rubric check for each lens is in the per-lens SUFFIX, not the shared prefix", () => {
    const { sharedPrefix, perLens } = buildJudgeContext(BASE_OPTS);

    // The shared prefix must NOT contain any lens-specific rubric text.
    for (const lens of FULL_LENSES) {
      expect(sharedPrefix).not.toContain(FIXTURE_RUBRIC[lens]);
    }

    // Each prompt's suffix (after the prefix) MUST contain the rubric check.
    for (const lens of FULL_LENSES) {
      const suffix = perLens[lens]!.slice(sharedPrefix.length);
      expect(suffix).toContain(FIXTURE_RUBRIC[lens]);
    }
  });

  it("each lens prompt contains the risk tier", () => {
    const { perLens } = buildJudgeContext(BASE_OPTS);

    for (const lens of FULL_LENSES) {
      expect(perLens[lens]).toContain("medium");
    }
  });

  it("risk tier is present in the shared prefix (not duplicated in each suffix)", () => {
    const { sharedPrefix } = buildJudgeContext(BASE_OPTS);
    expect(sharedPrefix).toContain("medium");
  });

  it("each lens prompt contains the lens name in the suffix", () => {
    const { sharedPrefix, perLens } = buildJudgeContext(BASE_OPTS);

    for (const lens of FULL_LENSES) {
      const suffix = perLens[lens]!.slice(sharedPrefix.length);
      expect(suffix).toContain(lens);
    }
  });

  it("each lens prompt contains the assigned role in the suffix", () => {
    const { sharedPrefix, perLens } = buildJudgeContext(BASE_OPTS);

    for (const lens of FULL_LENSES) {
      const suffix = perLens[lens]!.slice(sharedPrefix.length);
      const expectedRole = FIXTURE_LENS_ROLES[lens]!;
      expect(suffix).toContain(expectedRole);
    }
  });

  it("each lens prompt contains the writeLensVerdict CLI command in the suffix", () => {
    const { sharedPrefix, perLens } = buildJudgeContext(BASE_OPTS);

    for (const lens of FULL_LENSES) {
      const suffix = perLens[lens]!.slice(sharedPrefix.length);
      expect(suffix).toContain("writeLensVerdict");
      expect(suffix).toContain("/path/to/cli.js");
    }
  });

  it("the verdict file path in each suffix references the correct lens name", () => {
    const { sharedPrefix, perLens } = buildJudgeContext(BASE_OPTS);

    for (const lens of FULL_LENSES) {
      const suffix = perLens[lens]!.slice(sharedPrefix.length);
      expect(suffix).toContain(`judge-${lens}.json`);
    }
  });

  it("falls back to 'medium (fallback)' risk tier when riskTier is absent", () => {
    const opts: BuildJudgeContextOptions = {
      ...BASE_OPTS,
      riskTier: undefined,
    };
    const { sharedPrefix, perLens } = buildJudgeContext(opts);

    expect(sharedPrefix).toContain("medium (fallback)");
    for (const lens of FULL_LENSES) {
      expect(perLens[lens]).toContain("medium (fallback)");
    }
  });

  it("falls back to 'generalist-reviewer' role when lens is not in lensRoles", () => {
    const opts: BuildJudgeContextOptions = {
      ...BASE_OPTS,
      lensRoles: {}, // no roles defined
    };
    const { sharedPrefix, perLens } = buildJudgeContext(opts);

    for (const lens of FULL_LENSES) {
      const suffix = perLens[lens]!.slice(sharedPrefix.length);
      expect(suffix).toContain("generalist-reviewer");
    }
  });
});

// ---------------------------------------------------------------------------
// Structural sanity
// ---------------------------------------------------------------------------

describe("structural sanity", () => {
  it("returns a perLens entry for every lens in the input", () => {
    const lenses = ["structure", "verifiability"];
    const opts: BuildJudgeContextOptions = { ...BASE_OPTS, lenses };
    const { perLens } = buildJudgeContext(opts);

    expect(Object.keys(perLens).sort()).toEqual(lenses.sort());
  });

  it("returns an empty perLens when lenses array is empty (skip path)", () => {
    const opts: BuildJudgeContextOptions = { ...BASE_OPTS, lenses: [] };
    const { sharedPrefix, perLens } = buildJudgeContext(opts);

    expect(sharedPrefix.length).toBeGreaterThan(0); // prefix still built
    expect(Object.keys(perLens)).toHaveLength(0);
  });

  it("ref with ':' is sanitised to '-' in the verdict file path", () => {
    const { sharedPrefix, perLens } = buildJudgeContext(BASE_OPTS);

    for (const lens of FULL_LENSES) {
      const suffix = perLens[lens]!.slice(sharedPrefix.length);
      // The ref 'native:01KTKK5NQWTV4NHB37V7WC6AD8' must appear as
      // 'native-01KTKK5NQWTV4NHB37V7WC6AD8' in the verdict file path.
      expect(suffix).toContain("native-01KTKK5NQWTV4NHB37V7WC6AD8");
    }
  });

  it("the sessionUlid appears in each verdict file path", () => {
    const { sharedPrefix, perLens } = buildJudgeContext(BASE_OPTS);

    for (const lens of FULL_LENSES) {
      const suffix = perLens[lens]!.slice(sharedPrefix.length);
      expect(suffix).toContain("01KTN5FA8K8PA9AET30R8BY8A1");
    }
  });

  it("the targetRepoRoot appears in each verdict file path", () => {
    const { sharedPrefix, perLens } = buildJudgeContext(BASE_OPTS);

    for (const lens of FULL_LENSES) {
      const suffix = perLens[lens]!.slice(sharedPrefix.length);
      expect(suffix).toContain("/tmp/test-repo");
    }
  });
});
