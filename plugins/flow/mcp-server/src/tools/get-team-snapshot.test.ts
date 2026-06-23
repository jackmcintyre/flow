/**
 * Story native:01KT6Q8PSDZQKM57VFRHFJ3RP4 — structured lesson storage in
 * role PERSONA.md Knowledge sections.
 *
 * AC1 (integration): each lesson line shows its kind and source_ref in
 *   /flow:team — not just bare lesson text.
 *
 * AC2 (integration): pre-existing flat bullets are migrated to KnowledgeEntry
 *   with kind="pattern" and text intact — no lessons are lost.
 *
 * Both ACs exercise `extractKnowledgeEntries` and `renderTeamSnapshot` in
 * isolation (pure functions — no IO, no tmp dirs, no MCP transport).
 */

import { describe, expect, it } from "vitest";
import {
  extractKnowledgeEntries,
  renderTeamSnapshot,
} from "./get-team-snapshot.js";
import type { TeamSnapshot } from "../schemas/team-snapshot.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid TeamSnapshot for a single role. */
function makeSnapshot(
  knowledge: ReturnType<typeof extractKnowledgeEntries>,
): TeamSnapshot {
  return {
    roles: [
      {
        state: "ok",
        role: "generalist-dev",
        domain: "feature implementation in a story scope",
        fireCount: 0,
        knowledge,
        capabilitiesMissing: false,
      },
    ],
    knowledgeLimit: 10,
    malformedTelemetryLines: 0,
    malformedTelemetryFiles: 0,
  };
}

/** Serialise a single structured lesson block as it is written by the handler. */
function lessonBlock(fields: Record<string, string>): string {
  return `<!-- lesson:json ${JSON.stringify(fields)} -->`;
}

// ---------------------------------------------------------------------------
// AC1 — structured lesson shows kind and source_ref
// ---------------------------------------------------------------------------

describe("AC1 — structured lesson entries carry kind and source_ref", () => {
  it("extractKnowledgeEntries parses a structured lesson block and returns its kind, applies_when, and source_ref", () => {
    const block = lessonBlock({
      id: "01HZRETR0000000000000000A1",
      kind: "pitfall",
      applies_when: "When rebasing a branch cut from a stale base",
      detail: "Always run git fetch before rebasing to avoid silently dropping sibling commits.",
      failure_class: "stale-rebase-base",
      source_ref: "native:01KT6Q8PSDZQKM57VFRHFJ3RP4",
      learned_at: "2026-06-04T00:00:00.000Z",
    });

    const entries = extractKnowledgeEntries(block, 10);

    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.kind).toBe("pitfall");
    expect(entry.applies_when).toBe("When rebasing a branch cut from a stale base");
    expect(entry.source_ref).toBe("native:01KT6Q8PSDZQKM57VFRHFJ3RP4");
    expect(entry.detail).toBe(
      "Always run git fetch before rebasing to avoid silently dropping sibling commits.",
    );
  });

  it("renderTeamSnapshot renders each lesson as 'kind | applies_when [source_ref]'", () => {
    const block = lessonBlock({
      id: "01HZRETR0000000000000000A1",
      kind: "tool-quirk",
      applies_when: "When using git rebase --onto",
      detail: "Needs an explicit upstream when the branch was cut from a stale base.",
      source_ref: "native:01KT6Q8PSDZQKM57VFRHFJ3RP4",
      learned_at: "2026-06-04T00:00:00.000Z",
    });

    const entries = extractKnowledgeEntries(block, 10);
    const snapshot = makeSnapshot(entries);
    const output = renderTeamSnapshot(snapshot);

    expect(output).toContain(
      "    - tool-quirk | When using git rebase --onto [native:01KT6Q8PSDZQKM57VFRHFJ3RP4]",
    );
  });

  it("renderTeamSnapshot omits the [source_ref] bracket when source_ref is absent", () => {
    const block = lessonBlock({
      id: "01HZRETR0000000000000000B2",
      kind: "pattern",
      applies_when: "When opening a PR",
      detail: "Always green the build before opening the PR.",
      learned_at: "2026-06-04T00:00:00.000Z",
    });

    const entries = extractKnowledgeEntries(block, 10);
    const snapshot = makeSnapshot(entries);
    const output = renderTeamSnapshot(snapshot);

    expect(output).toContain("    - pattern | When opening a PR");
    // No trailing bracket.
    expect(output).not.toContain("[");
  });

  it("extractKnowledgeEntries parses multiple lesson blocks in file order (reversed for display)", () => {
    const block1 = lessonBlock({
      id: "01HZRETR0000000000000000A1",
      kind: "pattern",
      applies_when: "First lesson",
      detail: "detail 1",
      learned_at: "2026-06-04T00:00:00.000Z",
    });
    const block2 = lessonBlock({
      id: "01HZRETR0000000000000000B2",
      kind: "discipline",
      applies_when: "Second lesson",
      detail: "detail 2",
      learned_at: "2026-06-04T01:00:00.000Z",
    });
    const block3 = lessonBlock({
      id: "01HZRETR0000000000000000C3",
      kind: "tool-quirk",
      applies_when: "Third lesson",
      detail: "detail 3",
      learned_at: "2026-06-04T02:00:00.000Z",
    });

    // Three blocks in file order; limit=3 → all three, reversed.
    const body = [block1, block2, block3].join("\n");
    const entries = extractKnowledgeEntries(body, 3);

    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.applies_when)).toEqual([
      "Third lesson",
      "Second lesson",
      "First lesson",
    ]);
  });

  it("extractKnowledgeEntries respects the limit when there are more structured entries than the limit", () => {
    const blocks = ["First", "Second", "Third", "Fourth"].map((label, i) =>
      lessonBlock({
        id: `01HZRETR000000000000000${String(i).padStart(3, "0").slice(-2)}0${i}`,
        kind: "pattern",
        applies_when: `${label} lesson`,
        detail: `detail ${i}`,
        learned_at: "2026-06-04T00:00:00.000Z",
      }),
    );

    const body = blocks.join("\n");
    // limit=2 → last 2 in file order, reversed
    const entries = extractKnowledgeEntries(body, 2);

    expect(entries).toHaveLength(2);
    expect(entries[0]!.applies_when).toBe("Fourth lesson");
    expect(entries[1]!.applies_when).toBe("Third lesson");
  });
});

// ---------------------------------------------------------------------------
// AC2 — flat-bullet migration preserves existing text with default kind
// ---------------------------------------------------------------------------

describe("AC2 — flat-bullet migration preserves pre-existing bullets", () => {
  it("extractKnowledgeEntries migrates a flat bullet to kind='pattern' with text intact", () => {
    const body = "- Always emit the handoff phrase on its own line.";
    const entries = extractKnowledgeEntries(body, 10);

    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.kind).toBe("pattern");
    expect(entry.applies_when).toBe("Always emit the handoff phrase on its own line.");
    expect(entry.detail).toBe("Always emit the handoff phrase on its own line.");
  });

  it("flat bullets have no source_ref (provenance unknown for pre-existing lessons)", () => {
    const body = "- Old flat lesson.";
    const entries = extractKnowledgeEntries(body, 10);

    expect(entries).toHaveLength(1);
    expect(entries[0]!.source_ref).toBeUndefined();
  });

  it("a Knowledge body with mixed structured blocks and flat bullets returns all entries with correct kinds", () => {
    const structuredBlock = lessonBlock({
      id: "01HZRETR0000000000000000A1",
      kind: "pitfall",
      applies_when: "Structured lesson",
      detail: "The structured lesson detail.",
      failure_class: "some-failure",
      source_ref: "native:01KT6Q8PSDZQKM57VFRHFJ3RP4",
      learned_at: "2026-06-04T00:00:00.000Z",
    });
    const body = `${structuredBlock}\n- Old flat lesson one.\n- Old flat lesson two.`;
    const entries = extractKnowledgeEntries(body, 10);

    // Three entries total; order: structured first then migrated (all reversed from bottom).
    expect(entries).toHaveLength(3);
    // Reversed order: migrated-2, migrated-1, structured (bottom-most first).
    expect(entries[0]!.applies_when).toBe("Old flat lesson two.");
    expect(entries[0]!.kind).toBe("pattern");
    expect(entries[1]!.applies_when).toBe("Old flat lesson one.");
    expect(entries[1]!.kind).toBe("pattern");
    expect(entries[2]!.applies_when).toBe("Structured lesson");
    expect(entries[2]!.kind).toBe("pitfall");
    expect(entries[2]!.source_ref).toBe("native:01KT6Q8PSDZQKM57VFRHFJ3RP4");
  });

  it("no lessons are dropped — a body with only flat bullets returns all of them migrated", () => {
    const body = "- Lesson alpha.\n- Lesson beta.\n- Lesson gamma.";
    const entries = extractKnowledgeEntries(body, 10);

    expect(entries).toHaveLength(3);
    // Reversed: gamma, beta, alpha.
    expect(entries.map((e) => e.applies_when)).toEqual([
      "Lesson gamma.",
      "Lesson beta.",
      "Lesson alpha.",
    ]);
    // All migrated to pattern.
    for (const entry of entries) {
      expect(entry.kind).toBe("pattern");
    }
  });

  it("an empty Knowledge body returns an empty array (no lessons lost or hallucinated)", () => {
    const entries = extractKnowledgeEntries("", 10);
    expect(entries).toHaveLength(0);
  });

  it("renderTeamSnapshot shows migrated flat bullets with their kind and applies_when text", () => {
    const body = "- Always green the CI before opening a PR.";
    const entries = extractKnowledgeEntries(body, 10);
    const snapshot = makeSnapshot(entries);
    const output = renderTeamSnapshot(snapshot);

    // Migrated bullet rendered as "pattern | <text>" with no source_ref bracket.
    expect(output).toContain(
      "    - pattern | Always green the CI before opening a PR.",
    );
    expect(output).not.toContain("[");
  });
});
