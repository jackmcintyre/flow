/**
 * Unit tests for AC-heading regex widening (Story 5.17 AC1).
 *
 * Covers the four canonical AC heading shapes (strict, tagged, descriptive,
 * descriptive+tagged) plus regressions for (user-surface) tag mapping and
 * a real-world punctuation example, plus a negative case pinning the
 * intentional strictness around the em-dash separator.
 *
 * The em-dash used throughout is U+2014 (`—`), NOT a hyphen-minus (U+002D),
 * en-dash (U+2013), or double-hyphen.
 */

import { describe, it, expect } from "vitest";
import { parseBmadStory } from "../parse-bmad-story.js";
import { MalformedBmadStoryError } from "../../../errors.js";

/** Minimal valid story file skeleton. Accepts a replacement AC section body. */
function makeStory(acSection: string): string {
  return [
    "# Story 1.1: Test story",
    "",
    "Status: ready-for-dev",
    "",
    "## Story",
    "",
    "As a user, I want something, so that I get value.",
    "",
    "## Acceptance Criteria",
    "",
    acSection,
    "",
  ].join("\n");
}

const FAKE_PATH = "/repo/_bmad-output/implementation-artifacts/1-1-test-story.md";

describe("parseBmadStory — AC heading shapes (Story 5.17 AC1)", () => {
  it("(a) strict shape **AC1:** parses with kind: unit (regression)", () => {
    const content = makeStory(
      [
        "**AC1:**",
        "**Given** a repo,",
        "**When** the user runs the command,",
        "**Then** the build passes.",
      ].join("\n"),
    );
    const result = parseBmadStory(FAKE_PATH, content);
    expect(result.acceptance_criteria).toHaveLength(1);
    expect(result.acceptance_criteria[0]!.kind).toBe("unit");
  });

  it("(b) tagged shape **AC2 (integration):** parses with kind: integration (regression)", () => {
    const content = makeStory(
      [
        "**AC2 (integration):**",
        "**Given** a live MCP server,",
        "**When** the adapter scans stories,",
        "**Then** the manifest is populated.",
      ].join("\n"),
    );
    // Use a story file matching AC2 numbering (filename must be 1.2)
    const fakePath = "/repo/_bmad-output/implementation-artifacts/1-2-test-tagged.md";
    const storyContent = content.replace("# Story 1.1:", "# Story 1.2:");
    const result = parseBmadStory(fakePath, storyContent);
    expect(result.acceptance_criteria).toHaveLength(1);
    expect(result.acceptance_criteria[0]!.kind).toBe("integration");
  });

  it("(c) user-surface shape **AC1 (user-surface):** maps to kind: integration (regression)", () => {
    const content = makeStory(
      [
        "**AC1 (user-surface):**",
        "**Given** the plugin is installed,",
        "**When** the user runs /crew:start,",
        "**Then** the story is claimed.",
      ].join("\n"),
    );
    const result = parseBmadStory(FAKE_PATH, content);
    expect(result.acceptance_criteria).toHaveLength(1);
    expect(result.acceptance_criteria[0]!.kind).toBe("integration");
  });

  it("(d) descriptive shape **AC1 — Some title:** parses with kind: unit", () => {
    const content = makeStory(
      [
        "**AC1 — Some title:**",
        "**Given** a thing,",
        "**When** something happens,",
        "**Then** a result follows.",
      ].join("\n"),
    );
    const result = parseBmadStory(FAKE_PATH, content);
    expect(result.acceptance_criteria).toHaveLength(1);
    expect(result.acceptance_criteria[0]!.kind).toBe("unit");
  });

  it("(e) descriptive + tagged shape **AC1 — Some title (integration):** parses with kind: integration", () => {
    const content = makeStory(
      [
        "**AC1 — Some title (integration):**",
        "**Given** a live system,",
        "**When** integration runs,",
        "**Then** results are produced.",
      ].join("\n"),
    );
    const result = parseBmadStory(FAKE_PATH, content);
    expect(result.acceptance_criteria).toHaveLength(1);
    expect(result.acceptance_criteria[0]!.kind).toBe("integration");
  });

  it("(f) real-world canonical: **AC1 — Install & build pass cleanly:** parses with kind: unit", () => {
    // This is the exact shape from 1-1-scaffold-the-plugin-skeleton.md line 17.
    // The & character and internal punctuation must NOT trip the regex.
    const content = makeStory(
      [
        "**AC1 — Install & build pass cleanly:**",
        "`pnpm install && pnpm build` completes with exit code 0 in the",
        "scaffold's initial state.",
      ].join("\n"),
    );
    const result = parseBmadStory(FAKE_PATH, content);
    expect(result.acceptance_criteria).toHaveLength(1);
    expect(result.acceptance_criteria[0]!.kind).toBe("unit");
  });

  it("(g) negative: double-hyphen **AC1 -- Some title:** does NOT parse (intentional strictness)", () => {
    // Double-hyphen is NOT the em-dash. This must NOT match the heading regex.
    // The AC section will have no recognisable headings and must throw.
    const content = makeStory(
      [
        "**AC1 -- Some title:**",
        "**Given** a thing,",
        "**When** something happens,",
        "**Then** a result follows.",
      ].join("\n"),
    );
    expect(() => parseBmadStory(FAKE_PATH, content)).toThrow(MalformedBmadStoryError);
  });

  it("multi-AC: all four shapes in one section parse as four distinct ACs", () => {
    const content = makeStory(
      [
        "**AC1:**",
        "Strict shape body.",
        "",
        "**AC2 (integration):**",
        "Tagged shape body.",
        "",
        "**AC3 — Descriptive title:**",
        "Descriptive shape body.",
        "",
        "**AC4 — Descriptive with tag (user-surface):**",
        "Descriptive plus tagged body.",
      ].join("\n"),
    );
    const fakePath = "/repo/_bmad-output/implementation-artifacts/1-4-multi-ac.md";
    const storyContent = content.replace("# Story 1.1:", "# Story 1.4:");
    const result = parseBmadStory(fakePath, storyContent);
    expect(result.acceptance_criteria).toHaveLength(4);
    expect(result.acceptance_criteria[0]!.kind).toBe("unit");
    expect(result.acceptance_criteria[1]!.kind).toBe("integration");
    expect(result.acceptance_criteria[2]!.kind).toBe("unit");
    expect(result.acceptance_criteria[3]!.kind).toBe("integration");
  });

  // -------------------------------------------------------------------------
  // Story 10.1 AC4 — the shared AC type gained an optional `verification`
  // field. The BMad parser compiles against the updated type and its existing
  // AC extraction is unchanged: BMad ACs parse with `verification` left
  // `undefined`. (Extracting verification from BMad prose markers is the 10.5
  // ingest seam.)
  // -------------------------------------------------------------------------
  it("(Story 10.1) BMad ACs parse with verification left undefined", () => {
    const content = makeStory(
      [
        "**AC1:**",
        "**Given** a repo,",
        "**When** the user runs the command,",
        "**Then** the build passes.",
        "",
        "**AC2 (integration):**",
        "**Given** a live MCP server,",
        "**When** the adapter scans stories,",
        "**Then** the manifest is populated.",
      ].join("\n"),
    );
    const fakePath = "/repo/_bmad-output/implementation-artifacts/1-2-bmad-verification.md";
    const storyContent = content.replace("# Story 1.1:", "# Story 1.2:");
    const result = parseBmadStory(fakePath, storyContent);
    expect(result.acceptance_criteria).toHaveLength(2);
    for (const ac of result.acceptance_criteria) {
      expect(ac.verification).toBeUndefined();
    }
  });
});
