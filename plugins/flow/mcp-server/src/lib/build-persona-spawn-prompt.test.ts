/**
 * Integration tests for `buildPersonaSpawnPrompt` — briefing budget cap
 * Story native:01KT6QSW4W7SMAHAT4EAKCCC65 (AC1).
 *
 * Covers:
 *  (AC1-a) When lessons <= budget, all lessons appear in the always-shown index.
 *  (AC1-b) When lessons > budget, only the top-budgeted lessons appear in the index.
 *  (AC1-c) The always-shown index is ordered by use_count descending then last_used_at desc.
 *  (AC1-d) Overflow lessons are moved to the archived store (not in the persona file).
 *  (AC1-e) The persona file Knowledge body is updated (overflow removed) after assembly.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile } from "./managed-fs.js";
import { buildPersonaSpawnPrompt } from "../tools/build-persona-spawn-prompt.js";
import { serialiseLessonBlock } from "./lesson-archive.js";
import { findArchivedLessonById } from "./lesson-archive.js";
import type { ParsedLesson } from "./lesson-archive.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const FIXED_HIRED_AT = "2026-01-01T00:00:00.000Z";
const FIXED_VERSION = "0.1.0";

function personaWithLessons(lessons: ParsedLesson[]): string {
  const knowledgeLines = lessons.map(serialiseLessonBlock).join("\n");
  return `---
role: generalist-dev
domain: "feature implementation in a story scope"
model_tier: sonnet
tools_allow:
  - Read
  - Edit
  - Bash
  - Task
gh_allow:
  - pr-create
  - pr-view
  - pr-comment
locked_phrases:
  handoff: "Handoff to reviewer — story <story-id> ready for review."
  yield: "This sits in <role>'s domain — handing off"
  verdict: "**Verdict: <SENTINEL>**"
hired_at: "${FIXED_HIRED_AT}"
catalogue_version: "${FIXED_VERSION}"
---

# Generalist Dev

## Domain

Implements one story at a time end-to-end.

## Mandate

- Implement the story.

## Out of mandate

- Reviewing the PR.

## Prompt

You are the generalist dev.

## Knowledge

${knowledgeLines}
`;
}

function makeLesson(id: string, useCount: number, lastUsedAt?: string): ParsedLesson {
  return {
    id,
    kind: "pattern",
    applies_when: `When rule ${id} applies`,
    detail: `Detail for lesson ${id}`,
    learned_at: "2026-01-01T00:00:00.000Z",
    use_count: useCount,
    ...(lastUsedAt ? { last_used_at: lastUsedAt } : {}),
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-briefing-budget-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function makePersonaFile(content: string): Promise<void> {
  const dir = path.join(tmpRoot, "team", "generalist-dev");
  await fs.mkdir(dir, { recursive: true });
  await atomicWriteFile(path.join(dir, "PERSONA.md"), content);
}

async function readPersonaFile(): Promise<string> {
  return fs.readFile(path.join(tmpRoot, "team", "generalist-dev", "PERSONA.md"), "utf8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date("2026-06-04T12:00:00.000Z");
const fixedNow = () => FIXED_NOW;

describe("buildPersonaSpawnPrompt — briefing budget cap (AC1)", () => {
  it("(AC1-a) when lessons <= budget, all lessons appear in the always-shown index", async () => {
    const lessons = [
      makeLesson("01KT0000000000000000000001", 5),
      makeLesson("01KT0000000000000000000002", 3),
    ];
    await makePersonaFile(personaWithLessons(lessons));

    const { systemPrompt } = await buildPersonaSpawnPrompt({
      targetRepoRoot: tmpRoot,
      role: "generalist-dev",
      briefingBudget: 5,
      now: fixedNow,
    });

    expect(systemPrompt).toContain("01KT0000000000000000000001");
    expect(systemPrompt).toContain("01KT0000000000000000000002");
  });

  it("(AC1-b) when lessons > budget, only top-budgeted lessons appear in the index", async () => {
    const lessons = [
      makeLesson("01KT0000000000000000000001", 10),
      makeLesson("01KT0000000000000000000002", 8),
      makeLesson("01KT0000000000000000000003", 1), // overflow with budget=2
    ];
    await makePersonaFile(personaWithLessons(lessons));

    const { systemPrompt } = await buildPersonaSpawnPrompt({
      targetRepoRoot: tmpRoot,
      role: "generalist-dev",
      briefingBudget: 2,
      now: fixedNow,
    });

    expect(systemPrompt).toContain("01KT0000000000000000000001"); // use_count=10 — stays
    expect(systemPrompt).toContain("01KT0000000000000000000002"); // use_count=8 — stays
    expect(systemPrompt).not.toContain("01KT0000000000000000000003"); // use_count=1 — demoted
  });

  it("(AC1-c) always-shown index is ordered by use_count descending then last_used_at descending (when overflow triggers rewrite)", async () => {
    // 4 lessons but budget=3: the overflow triggers a rewrite in ranked order.
    // After rewrite, the top-3 appear in ranked order in the persona file.
    const lessons = [
      makeLesson("01KT0000000000000000000001", 5, "2026-06-01T00:00:00.000Z"),
      makeLesson("01KT0000000000000000000002", 5, "2026-06-02T00:00:00.000Z"), // same count, more recent
      makeLesson("01KT0000000000000000000003", 10), // highest count
      makeLesson("01KT0000000000000000000004", 0),  // lowest — this one overflows
    ];
    await makePersonaFile(personaWithLessons(lessons));

    const { systemPrompt } = await buildPersonaSpawnPrompt({
      targetRepoRoot: tmpRoot,
      role: "generalist-dev",
      briefingBudget: 3,
      now: fixedNow,
    });

    // Top 3 appear: L3(10), L2(5,recent), L1(5,older). L4 is demoted.
    expect(systemPrompt).toContain("01KT0000000000000000000003");
    expect(systemPrompt).toContain("01KT0000000000000000000002");
    expect(systemPrompt).toContain("01KT0000000000000000000001");
    expect(systemPrompt).not.toContain("01KT0000000000000000000004");

    const idx3 = systemPrompt.indexOf("01KT0000000000000000000003");
    const idx2 = systemPrompt.indexOf("01KT0000000000000000000002");
    const idx1 = systemPrompt.indexOf("01KT0000000000000000000001");

    // Ordering: L3(count=10) < L2(count=5, recent) < L1(count=5, older)
    expect(idx3).toBeGreaterThan(-1);
    expect(idx2).toBeGreaterThan(-1);
    expect(idx1).toBeGreaterThan(-1);
    expect(idx3).toBeLessThan(idx2);
    expect(idx2).toBeLessThan(idx1);
  });

  it("(AC1-d) overflow lessons are moved to the archived store", async () => {
    const overflow = makeLesson("01KT0000000000000000000003", 1);
    const lessons = [
      makeLesson("01KT0000000000000000000001", 10),
      makeLesson("01KT0000000000000000000002", 8),
      overflow,
    ];
    await makePersonaFile(personaWithLessons(lessons));

    await buildPersonaSpawnPrompt({
      targetRepoRoot: tmpRoot,
      role: "generalist-dev",
      briefingBudget: 2,
      now: fixedNow,
    });

    const archived = await findArchivedLessonById(tmpRoot, "generalist-dev", overflow.id);
    expect(archived).not.toBeNull();
    expect(archived!.archived_at).toBe(FIXED_NOW.toISOString());
    // All original fields preserved.
    expect(archived!.id).toBe(overflow.id);
    expect(archived!.kind).toBe(overflow.kind);
    expect(archived!.detail).toBe(overflow.detail);
  });

  it("(AC1-e) persona file Knowledge body is updated (overflow removed) after assembly", async () => {
    const lessons = [
      makeLesson("01KT0000000000000000000001", 10),
      makeLesson("01KT0000000000000000000002", 1), // will be demoted
    ];
    await makePersonaFile(personaWithLessons(lessons));

    await buildPersonaSpawnPrompt({
      targetRepoRoot: tmpRoot,
      role: "generalist-dev",
      briefingBudget: 1,
      now: fixedNow,
    });

    const updatedContent = await readPersonaFile();
    expect(updatedContent).toContain("01KT0000000000000000000001"); // kept in live
    expect(updatedContent).not.toContain("01KT0000000000000000000002"); // demoted
  });

  it("does not rewrite the persona file when no overflow exists", async () => {
    const lessons = [makeLesson("01KT0000000000000000000001", 5)];
    await makePersonaFile(personaWithLessons(lessons));

    // Note the mtime before.
    const statBefore = await fs.stat(
      path.join(tmpRoot, "team", "generalist-dev", "PERSONA.md"),
    );

    await buildPersonaSpawnPrompt({
      targetRepoRoot: tmpRoot,
      role: "generalist-dev",
      briefingBudget: 10,
      now: fixedNow,
    });

    const statAfter = await fs.stat(
      path.join(tmpRoot, "team", "generalist-dev", "PERSONA.md"),
    );

    // mtime should be unchanged (no write happened).
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
  });
});
