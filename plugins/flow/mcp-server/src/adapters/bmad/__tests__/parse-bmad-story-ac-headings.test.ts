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

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { parseBmadStory } from "../parse-bmad-story.js";
import { atomicWriteFile } from "../../../lib/managed-fs.js";
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
        "**When** the user runs /flow:start,",
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

// ---------------------------------------------------------------------------
// Story native:01KW5W081X3TJPQBCYF3WAK9RZ — per-AC verification derivation.
//
// When `parseBmadStory` is given a `repoRoot`, each AC for which a real test or
// artifact target can be derived from the story's own signals carries that
// derived marker (AC1); an AC whose candidate target does NOT resolve on disk
// falls back to manual verification (verification undefined) rather than emitting
// a non-existent path (AC2).
// ---------------------------------------------------------------------------

describe("parseBmadStory — derived per-AC verification (Story native:01KW5W081X3TJPQBCYF3WAK9RZ)", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeRepoRoot(): string {
    const dir = mkdtempSync(nodePath.join(os.tmpdir(), "bmad-derive-"));
    tmpDirs.push(dir);
    return dir;
  }

  /** Write a file (creating parent dirs) under `repoRoot` at repo-relative `rel`. */
  async function writeRepoFile(repoRoot: string, rel: string, contents = "x"): Promise<void> {
    const abs = nodePath.join(repoRoot, rel);
    mkdirSync(nodePath.dirname(abs), { recursive: true });
    await atomicWriteFile(abs, contents);
  }

  /** Build a 1.3 story whose AC section and Dev Notes are supplied by the caller. */
  function makeStory13(acSection: string, devNotes: string): string {
    return [
      "# Story 1.3: Derive markers",
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
      "## Dev Notes",
      "",
      devNotes,
      "",
    ].join("\n");
  }

  const STORY_13_PATH = "/repo/_bmad-output/planning-artifacts/stories/1-3-derive-markers.md";

  it("AC1: a unit AC whose Dev Notes cite an existing test file derives a vitest marker", async () => {
    const repoRoot = makeRepoRoot();
    const testRel = "plugins/flow/mcp-server/src/foo/__tests__/foo.test.ts";
    await writeRepoFile(repoRoot, testRel);

    const content = makeStory13(
      [
        "**AC1:**",
        "**Given** a repo,",
        "**When** the user runs the command,",
        "**Then** the build passes.",
      ].join("\n"),
      `Add coverage in \`${testRel}\` for the new branch.`,
    );

    const result = parseBmadStory(STORY_13_PATH, content, { repoRoot });
    expect(result.acceptance_criteria).toHaveLength(1);
    expect(result.acceptance_criteria[0]!.verification).toEqual({
      type: "vitest",
      target: testRel,
    });
  });

  it("AC1: a test path cited in the AC prose itself is derived as a vitest marker", async () => {
    const repoRoot = makeRepoRoot();
    const testRel = "plugins/flow/mcp-server/src/bar/bar.spec.ts";
    await writeRepoFile(repoRoot, testRel);

    const content = makeStory13(
      [
        "**AC1:**",
        "**Given** a repo,",
        `**When** \`${testRel}\` runs,`,
        "**Then** it passes.",
      ].join("\n"),
      "No extra notes.",
    );

    const result = parseBmadStory(STORY_13_PATH, content, { repoRoot });
    expect(result.acceptance_criteria[0]!.verification).toEqual({
      type: "vitest",
      target: testRel,
    });
  });

  it("AC1: an integration AC with no test reference derives an artifact marker from the implementation-artifact convention", async () => {
    const repoRoot = makeRepoRoot();
    const artifactRel = "_bmad-output/implementation-artifacts/1-3-derive-markers.md";
    await writeRepoFile(repoRoot, artifactRel, "# impl doc");

    const content = makeStory13(
      [
        "**AC1 (integration):**",
        "**Given** a live MCP server,",
        "**When** the adapter scans stories,",
        "**Then** the manifest is populated.",
      ].join("\n"),
      "No test references here.",
    );

    const result = parseBmadStory(STORY_13_PATH, content, { repoRoot });
    expect(result.acceptance_criteria[0]!.kind).toBe("integration");
    expect(result.acceptance_criteria[0]!.verification).toEqual({
      type: "artifact",
      target: artifactRel,
    });
  });

  it("AC2: a cited test path that does NOT resolve on disk falls back to manual (verification undefined)", () => {
    const repoRoot = makeRepoRoot();
    // Deliberately do NOT create the referenced file.
    const content = makeStory13(
      [
        "**AC1:**",
        "**Given** a repo,",
        "**When** the user runs the command,",
        "**Then** the build passes.",
      ].join("\n"),
      "Add coverage in `plugins/flow/mcp-server/src/ghost/__tests__/ghost.test.ts`.",
    );

    const result = parseBmadStory(STORY_13_PATH, content, { repoRoot });
    expect(result.acceptance_criteria[0]!.verification).toBeUndefined();
  });

  it("AC2: an AC with no derivable signal at all falls back to manual (verification undefined)", () => {
    const repoRoot = makeRepoRoot();
    const content = makeStory13(
      [
        "**AC1:**",
        "**Given** a repo,",
        "**When** the user runs the command,",
        "**Then** the build passes.",
      ].join("\n"),
      "Nothing mechanical to check here.",
    );

    const result = parseBmadStory(STORY_13_PATH, content, { repoRoot });
    expect(result.acceptance_criteria[0]!.verification).toBeUndefined();
  });

  it("AC2: an integration AC whose implementation-artifact doc is absent falls back to manual", () => {
    const repoRoot = makeRepoRoot();
    // No implementation-artifact doc written and no test reference.
    const content = makeStory13(
      [
        "**AC1 (integration):**",
        "**Given** a live MCP server,",
        "**When** the adapter scans stories,",
        "**Then** the manifest is populated.",
      ].join("\n"),
      "No test references here.",
    );

    const result = parseBmadStory(STORY_13_PATH, content, { repoRoot });
    expect(result.acceptance_criteria[0]!.verification).toBeUndefined();
  });

  it("does not derive a marker (verification undefined) when no repoRoot is supplied — pure mode", () => {
    // The referenced test file would resolve under cwd, but without repoRoot the
    // parser must not perform any I/O or derivation.
    const content = makeStory13(
      [
        "**AC1:**",
        "**Given** a repo,",
        "**When** the user runs the command,",
        "**Then** the build passes.",
      ].join("\n"),
      "Add coverage in `plugins/flow/mcp-server/src/foo/__tests__/foo.test.ts`.",
    );
    const result = parseBmadStory(STORY_13_PATH, content);
    expect(result.acceptance_criteria[0]!.verification).toBeUndefined();
  });

  it("prefers a test cited in the integration AC's own prose over the artifact convention", async () => {
    const repoRoot = makeRepoRoot();
    const testRel = "plugins/flow/mcp-server/src/baz/__tests__/baz.integration.test.ts";
    await writeRepoFile(repoRoot, testRel);
    await writeRepoFile(repoRoot, "_bmad-output/implementation-artifacts/1-3-derive-markers.md", "# doc");

    // The test path is cited in the integration AC's OWN body — the precise,
    // per-AC signal — so it wins over the artifact-doc convention fallback.
    const content = makeStory13(
      [
        "**AC1 (integration):**",
        "**Given** a live system,",
        `**When** \`${testRel}\` runs,`,
        "**Then** results are produced.",
      ].join("\n"),
      "No notes here.",
    );

    const result = parseBmadStory(STORY_13_PATH, content, { repoRoot });
    expect(result.acceptance_criteria[0]!.verification).toEqual({
      type: "vitest",
      target: testRel,
    });
  });

  it("an integration AC does NOT borrow a notes-only test reference (notes apply to unit ACs)", async () => {
    const repoRoot = makeRepoRoot();
    const testRel = "plugins/flow/mcp-server/src/qux/__tests__/qux.test.ts";
    await writeRepoFile(repoRoot, testRel);
    const artifactRel = "_bmad-output/implementation-artifacts/1-3-derive-markers.md";
    await writeRepoFile(repoRoot, artifactRel, "# doc");

    // The only test reference is in the notes; an integration AC must fall through
    // to the artifact convention rather than spraying the notes test onto it.
    const content = makeStory13(
      [
        "**AC1 (integration):**",
        "**Given** a live system,",
        "**When** integration runs,",
        "**Then** results are produced.",
      ].join("\n"),
      `All coverage lives in \`${testRel}\`.`,
    );

    const result = parseBmadStory(STORY_13_PATH, content, { repoRoot });
    expect(result.acceptance_criteria[0]!.verification).toEqual({
      type: "artifact",
      target: artifactRel,
    });
  });
});
