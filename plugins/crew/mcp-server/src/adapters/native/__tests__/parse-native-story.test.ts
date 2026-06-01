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
