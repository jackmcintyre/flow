/**
 * Unit tests for the per-AC `verification` directive — Story 10.1 AC2.
 *
 * `parseNativeStory` extracts the stored marker line (`vitest: <path>` or
 * `artifact: <path>`, immediately following the AC's Given/When/Then body)
 * into `verification: { type, target }`, requiring exactly one such line per
 * AC. It throws `MalformedNativeStoryError` (carrying `{ path, section,
 * reason }`) when the line is absent, when `type` is neither `vitest` nor
 * `artifact`, or when `target` is empty.
 *
 * Scope note: this story checks *presence and shape* of the line. Checking
 * that `target` *resolves to a real file* is Tier-0 check T0-6, added in
 * Story 10.3 — so a non-existent path still parses here.
 */

import { describe, it, expect } from "vitest";
import { parseNativeStory } from "../parse-native-story.js";
import { MalformedNativeStoryError } from "../../../errors.js";

const FAKE_PATH = "/repo/.crew/native-stories/01HZABC0000000000000000001.md";

/** Minimal valid native-story body with a replaceable AC section body. */
function storyWith(acBody: string): string {
  return [
    "# A native story",
    "",
    "## Narrative",
    "",
    "As a user, I want a thing so that I get value.",
    "",
    "## Acceptance Criteria",
    "",
    acBody,
    "",
    "## Dependencies",
    "",
  ].join("\n");
}

describe("parseNativeStory — per-AC verification directive (Story 10.1 AC2)", () => {
  it("extracts a vitest directive into verification: { type, target }", () => {
    const story = parseNativeStory(
      FAKE_PATH,
      storyWith(
        [
          "**AC1:**",
          "**Given** a state, **When** an action, **Then** an outcome.",
          "vitest: src/foo/__tests__/foo.test.ts",
        ].join("\n"),
      ),
    );

    expect(story.acceptance_criteria).toHaveLength(1);
    expect(story.acceptance_criteria[0]!.verification).toEqual({
      type: "vitest",
      target: "src/foo/__tests__/foo.test.ts",
    });
    // The marker line is stripped from the AC prose text.
    expect(story.acceptance_criteria[0]!.text).not.toContain("vitest:");
    expect(story.acceptance_criteria[0]!.text).toContain("**Given**");
  });

  it("extracts an artifact directive into verification: { type, target }", () => {
    const story = parseNativeStory(
      FAKE_PATH,
      storyWith(
        [
          "**AC1:**",
          "**Given** a state, **When** an action, **Then** an outcome.",
          "artifact: docs/generated/report.md",
        ].join("\n"),
      ),
    );

    expect(story.acceptance_criteria[0]!.verification).toEqual({
      type: "artifact",
      target: "docs/generated/report.md",
    });
  });

  it("extracts verification per AC across multiple ACs", () => {
    const story = parseNativeStory(
      FAKE_PATH,
      storyWith(
        [
          "**AC1:**",
          "**Given** a, **When** b, **Then** c.",
          "vitest: src/__tests__/a.test.ts",
          "",
          "**AC2 (integration):**",
          "**Given** d, **When** e, **Then** f.",
          "artifact: build/out.json",
        ].join("\n"),
      ),
    );

    expect(story.acceptance_criteria).toHaveLength(2);
    expect(story.acceptance_criteria[0]!.verification).toEqual({
      type: "vitest",
      target: "src/__tests__/a.test.ts",
    });
    expect(story.acceptance_criteria[0]!.kind).toBe("unit");
    expect(story.acceptance_criteria[1]!.verification).toEqual({
      type: "artifact",
      target: "build/out.json",
    });
    expect(story.acceptance_criteria[1]!.kind).toBe("integration");
  });

  it("does NOT require the target to resolve to a real file (resolvability is T0-6 / Story 10.3)", () => {
    const story = parseNativeStory(
      FAKE_PATH,
      storyWith(
        [
          "**AC1:**",
          "**Given** a, **When** b, **Then** c.",
          "vitest: src/this/path/does/not/exist.test.ts",
        ].join("\n"),
      ),
    );

    // Shape only — the non-existent path still parses cleanly.
    expect(story.acceptance_criteria[0]!.verification).toEqual({
      type: "vitest",
      target: "src/this/path/does/not/exist.test.ts",
    });
  });

  it("throws MalformedNativeStoryError when the verification line is absent", () => {
    let caught: unknown;
    try {
      parseNativeStory(
        FAKE_PATH,
        storyWith(
          ["**AC1:**", "**Given** a, **When** b, **Then** c."].join("\n"),
        ),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MalformedNativeStoryError);
    const e = caught as MalformedNativeStoryError;
    expect(e.path).toBe(FAKE_PATH);
    expect(e.section).toContain("AC1");
    expect(e.reason).toMatch(/missing its verification directive/);
  });

  it("throws MalformedNativeStoryError when the type is neither vitest nor artifact", () => {
    let caught: unknown;
    try {
      parseNativeStory(
        FAKE_PATH,
        storyWith(
          [
            "**AC1:**",
            "**Given** a, **When** b, **Then** c.",
            "jest: src/__tests__/a.test.ts",
          ].join("\n"),
        ),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MalformedNativeStoryError);
    const e = caught as MalformedNativeStoryError;
    expect(e.section).toContain("AC1");
    expect(e.reason).toMatch(/type 'jest' is invalid/);
  });

  it("throws MalformedNativeStoryError when the target is empty", () => {
    let caught: unknown;
    try {
      parseNativeStory(
        FAKE_PATH,
        storyWith(
          ["**AC1:**", "**Given** a, **When** b, **Then** c.", "vitest:"].join(
            "\n",
          ),
        ),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MalformedNativeStoryError);
    const e = caught as MalformedNativeStoryError;
    expect(e.section).toContain("AC1");
    expect(e.reason).toMatch(/empty target path/);
  });

  it("rejects more than one verification line per AC (one AC, one check)", () => {
    let caught: unknown;
    try {
      parseNativeStory(
        FAKE_PATH,
        storyWith(
          [
            "**AC1:**",
            "**Given** a, **When** b, **Then** c.",
            "vitest: src/__tests__/a.test.ts",
            "artifact: build/out.json",
          ].join("\n"),
        ),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MalformedNativeStoryError);
    const e = caught as MalformedNativeStoryError;
    expect(e.section).toContain("AC1");
    expect(e.reason).toMatch(/expected exactly one/);
  });
});

// ---------------------------------------------------------------------------
// Story 10.2 — full-story fixtures carrying the three new fields. Used by the
// Tasks / Cited Sources / structured-narrative tests below.
// ---------------------------------------------------------------------------

/**
 * A full native story body with replaceable `## Narrative`, `## Tasks`, and
 * `## Cited Sources` section bodies. The Acceptance Criteria section declares
 * two ACs (AC1, AC2), each with a verification line, so task `ac_refs` of `1`
 * and `2` resolve.
 */
function story10_2(opts: {
  narrative?: string;
  tasks?: string | null;
  cited?: string | null;
}): string {
  const lines: string[] = [
    "# A native story",
    "",
    "## Narrative",
    "",
    opts.narrative ?? "As a user, I want a thing, so that I get value.",
    "",
    "## Acceptance Criteria",
    "",
    "**AC1:**",
    "**Given** a state, **When** an action, **Then** an outcome.",
    "vitest: src/__tests__/a.test.ts",
    "",
    "**AC2 (integration):**",
    "**Given** a system, **When** integrated, **Then** an artifact.",
    "artifact: build/out.json",
    "",
  ];
  if (opts.tasks !== null) {
    lines.push("## Tasks", "", opts.tasks ?? "- Build the thing (AC: 1, 2)", "");
  }
  if (opts.cited !== null) {
    lines.push("## Cited Sources", "", opts.cited ?? "- src/thing.ts", "");
  }
  lines.push("## Dependencies", "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Story 10.2 AC2 — `## Tasks` parsing + intra-story ref integrity
// ---------------------------------------------------------------------------

describe("parseNativeStory — ## Tasks section (Story 10.2 AC2)", () => {
  it("parses a task bullet `- <text> (AC: 1, 3)` into { text, ac_refs: ['AC1', 'AC2'] }", () => {
    const story = parseNativeStory(
      FAKE_PATH,
      story10_2({ tasks: "- Wire the seam (AC: 1, 2)" }),
    );
    expect(story.tasks).toEqual([{ text: "Wire the seam", ac_refs: ["AC1", "AC2"] }]);
  });

  it("parses multiple task bullets, each carrying its own ac_refs", () => {
    const story = parseNativeStory(
      FAKE_PATH,
      story10_2({ tasks: ["- First task (AC: 1)", "- Second task (AC: 2)"].join("\n") }),
    );
    expect(story.tasks).toEqual([
      { text: "First task", ac_refs: ["AC1"] },
      { text: "Second task", ac_refs: ["AC2"] },
    ]);
  });

  it("leaves tasks undefined when the section is absent (presence is T0-1 / Story 10.3)", () => {
    const story = parseNativeStory(FAKE_PATH, story10_2({ tasks: null }));
    expect(story.tasks).toBeUndefined();
  });

  it("throws MalformedNativeStoryError when a task carries no AC ref", () => {
    let caught: unknown;
    try {
      parseNativeStory(FAKE_PATH, story10_2({ tasks: "- A task with no ac clause" }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MalformedNativeStoryError);
    const e = caught as MalformedNativeStoryError;
    expect(e.section).toContain("Tasks");
    expect(e.reason).toMatch(/no AC ref/);
  });

  it("throws MalformedNativeStoryError when an ac_ref does not resolve to a parsed AC id", () => {
    let caught: unknown;
    try {
      // The story declares only AC1 and AC2; AC9 dangles.
      parseNativeStory(FAKE_PATH, story10_2({ tasks: "- Dangling task (AC: 9)" }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MalformedNativeStoryError);
    const e = caught as MalformedNativeStoryError;
    expect(e.section).toContain("Tasks");
    expect(e.reason).toMatch(/AC9.*does not resolve/);
  });

  it("throws MalformedNativeStoryError on an empty AC clause '(AC: )'", () => {
    let caught: unknown;
    try {
      parseNativeStory(FAKE_PATH, story10_2({ tasks: "- An empty-clause task (AC: )" }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MalformedNativeStoryError);
    expect((caught as MalformedNativeStoryError).reason).toMatch(/empty AC ref clause/);
  });

  it("throws MalformedNativeStoryError on a non-numeric AC ref", () => {
    let caught: unknown;
    try {
      parseNativeStory(FAKE_PATH, story10_2({ tasks: "- A bad-ref task (AC: one)" }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MalformedNativeStoryError);
    expect((caught as MalformedNativeStoryError).reason).toMatch(/non-numeric AC ref/);
  });
});

// ---------------------------------------------------------------------------
// Story 10.2 AC3 — `## Cited Sources` parsing
// ---------------------------------------------------------------------------

describe("parseNativeStory — ## Cited Sources section (Story 10.2 AC3)", () => {
  it("parses a bullet list of repo-relative paths into cited_sources: string[]", () => {
    const story = parseNativeStory(
      FAKE_PATH,
      story10_2({ cited: ["- src/a.ts", "- docs/design.md"].join("\n") }),
    );
    expect(story.cited_sources).toEqual(["src/a.ts", "docs/design.md"]);
  });

  it("leaves cited_sources undefined when the section is absent", () => {
    const story = parseNativeStory(FAKE_PATH, story10_2({ cited: null }));
    expect(story.cited_sources).toBeUndefined();
  });

  it("throws MalformedNativeStoryError when the section is present but empty", () => {
    let caught: unknown;
    try {
      // Section header with no bullets under it.
      parseNativeStory(FAKE_PATH, story10_2({ cited: "" }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MalformedNativeStoryError);
    const e = caught as MalformedNativeStoryError;
    expect(e.section).toContain("Cited Sources");
    expect(e.reason).toMatch(/present but empty/);
  });

  it("does NOT check that each cited path resolves on disk (resolvability is T0-5 / Story 10.3)", () => {
    const story = parseNativeStory(
      FAKE_PATH,
      story10_2({ cited: "- src/this/does/not/exist.ts" }),
    );
    expect(story.cited_sources).toEqual(["src/this/does/not/exist.ts"]);
  });
});

// ---------------------------------------------------------------------------
// Story 10.2 AC3 — structured narrative parsing
// ---------------------------------------------------------------------------

describe("parseNativeStory — structured narrative (Story 10.2 AC3)", () => {
  it("parses 'As a {role}, I want {want}, so that {so_that}.' into narrative_struct and retains the raw narrative", () => {
    const story = parseNativeStory(
      FAKE_PATH,
      story10_2({ narrative: "As a developer, I want a parser, so that fields are typed." }),
    );
    expect(story.narrative_struct).toEqual({
      role: "developer",
      want: "a parser",
      so_that: "fields are typed",
    });
    // The raw narrative string is retained verbatim.
    expect(story.narrative).toBe("As a developer, I want a parser, so that fields are typed.");
  });

  it("accepts the 'As an' article and the comma-less 'so that' form", () => {
    const story = parseNativeStory(
      FAKE_PATH,
      story10_2({ narrative: "As an operator, I want a brake so that I stay in control." }),
    );
    expect(story.narrative_struct).toEqual({
      role: "operator",
      want: "a brake",
      so_that: "I stay in control",
    });
  });

  it("throws MalformedNativeStoryError when the narrative is not in role/want/so_that shape", () => {
    let caught: unknown;
    try {
      parseNativeStory(
        FAKE_PATH,
        story10_2({ narrative: "This is a free-form description with no structure." }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MalformedNativeStoryError);
    const e = caught as MalformedNativeStoryError;
    expect(e.section).toContain("Narrative");
    expect(e.reason).toMatch(/As a \{role\}, I want \{want\}, so that \{so_that\}/);
  });
});
