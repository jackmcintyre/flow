/**
 * Integration tests for `recallLesson` — archived store fallback
 * Story native:01KT6QSW4W7SMAHAT4EAKCCC65 (AC2).
 *
 * Covers:
 *  (AC2-a) recallLesson returns the full lesson detail for an archived lesson by id.
 *  (AC2-b) recallLesson searches the live store first, then falls back to the archive.
 *  (AC2-c) recallLesson returns { found: false } when the id is in neither store.
 *  (AC2-d) Archived lesson recall returns the lesson with archived: true flag.
 *  (AC2-e) use_count is incremented on recall from the live store.
 *  (AC2-f) use_count is incremented on recall from the archived store.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteFile } from "../lib/managed-fs.js";
import { recallLesson } from "./recall-lesson.js";
import {
  archiveLessons,
  demoteLessonsFromBody,
  serialiseLessonBlock,
} from "../lib/lesson-archive.js";
import type { ParsedLesson } from "../lib/lesson-archive.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const LESSON_ID = "01KT6QSW4W7SMAHAT4EAKCCC65";
const LESSON_KIND = "pitfall" as const;
const LESSON_APPLIES_WHEN = "When deploying without running tests first";
const LESSON_DETAIL =
  "Always run the full test suite before opening a PR — deploy-without-test PRs caused 3 rollbacks.";
const LESSON_FAILURE_CLASS = "deploy-skip-test";
const LESSON_SOURCE_REF = "native:01KT0001";
const LESSON_LEARNED_AT = "2026-06-01T00:00:00.000Z";

const FIXTURE_LESSON: ParsedLesson = {
  id: LESSON_ID,
  kind: LESSON_KIND,
  applies_when: LESSON_APPLIES_WHEN,
  detail: LESSON_DETAIL,
  failure_class: LESSON_FAILURE_CLASS,
  source_ref: LESSON_SOURCE_REF,
  learned_at: LESSON_LEARNED_AT,
  use_count: 2,
};

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
hired_at: "2026-01-01T00:00:00.000Z"
catalogue_version: "0.1.0"
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

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-recall-archived-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function makePersonaFile(content: string): Promise<void> {
  const dir = path.join(tmpRoot, "team", "generalist-dev");
  await fs.mkdir(dir, { recursive: true });
  await atomicWriteFile(path.join(dir, "PERSONA.md"), content);
}

async function makeEmptyPersonaFile(): Promise<void> {
  await makePersonaFile(personaWithLessons([]));
}

const FIXED_NOW = new Date("2026-06-04T12:00:00.000Z");
const fixedNow = () => FIXED_NOW;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("recallLesson — archived store fallback (AC2)", () => {
  it("(AC2-a) returns full lesson detail for an archived lesson by id", async () => {
    // Lesson is NOT in the live persona — it's only in the archived store.
    await makeEmptyPersonaFile();
    await archiveLessons(tmpRoot, "generalist-dev", [FIXTURE_LESSON], fixedNow);

    const result = await recallLesson({
      targetRepoRoot: tmpRoot,
      role: "generalist-dev",
      id: LESSON_ID,
      now: fixedNow,
    });

    expect(result.found).toBe(true);
    expect(result.lesson).not.toBeNull();
    expect(result.lesson!.id).toBe(LESSON_ID);
    expect(result.lesson!.detail).toBe(LESSON_DETAIL);
    expect(result.lesson!.applies_when).toBe(LESSON_APPLIES_WHEN);
    expect(result.lesson!.kind).toBe(LESSON_KIND);
    expect(result.lesson!.failure_class).toBe(LESSON_FAILURE_CLASS);
    expect(result.lesson!.source_ref).toBe(LESSON_SOURCE_REF);
    expect(result.lesson!.learned_at).toBe(LESSON_LEARNED_AT);
  });

  it("(AC2-b) searches the live store first — live lesson found without hitting archived store", async () => {
    // Lesson is in the live persona.
    await makePersonaFile(personaWithLessons([FIXTURE_LESSON]));

    const result = await recallLesson({
      targetRepoRoot: tmpRoot,
      role: "generalist-dev",
      id: LESSON_ID,
      now: fixedNow,
    });

    expect(result.found).toBe(true);
    // Live lessons do NOT carry the `archived` flag.
    expect(result.lesson!.archived).toBeUndefined();
  });

  it("(AC2-c) returns { found: false } when id is in neither the live nor archived store", async () => {
    await makeEmptyPersonaFile();

    const result = await recallLesson({
      targetRepoRoot: tmpRoot,
      role: "generalist-dev",
      id: "01NONEXISTENT0000000000000",
      now: fixedNow,
    });

    expect(result.found).toBe(false);
    expect(result.lesson).toBeNull();
  });

  it("(AC2-d) archived lesson recall returns the lesson with archived: true", async () => {
    await makeEmptyPersonaFile();
    await archiveLessons(tmpRoot, "generalist-dev", [FIXTURE_LESSON], fixedNow);

    const result = await recallLesson({
      targetRepoRoot: tmpRoot,
      role: "generalist-dev",
      id: LESSON_ID,
      now: fixedNow,
    });

    expect(result.found).toBe(true);
    expect(result.lesson!.archived).toBe(true);
  });

  it("(AC2-e) use_count is incremented in the persona file on live lesson recall", async () => {
    const lessonWithCount: ParsedLesson = { ...FIXTURE_LESSON, use_count: 3 };
    await makePersonaFile(personaWithLessons([lessonWithCount]));

    await recallLesson({
      targetRepoRoot: tmpRoot,
      role: "generalist-dev",
      id: LESSON_ID,
      now: fixedNow,
    });

    const updatedPersona = await fs.readFile(
      path.join(tmpRoot, "team", "generalist-dev", "PERSONA.md"),
      "utf8",
    );

    // use_count should be incremented from 3 to 4.
    expect(updatedPersona).toContain('"use_count":4');
    // last_used_at should be stamped.
    expect(updatedPersona).toContain(FIXED_NOW.toISOString());
  });

  it("(AC2-f) use_count is incremented in the archive file on archived lesson recall", async () => {
    const lessonWithCount: ParsedLesson = { ...FIXTURE_LESSON, use_count: 1 };
    await makeEmptyPersonaFile();
    await archiveLessons(tmpRoot, "generalist-dev", [lessonWithCount], fixedNow);

    const laterNow = new Date("2026-06-05T00:00:00.000Z");
    await recallLesson({
      targetRepoRoot: tmpRoot,
      role: "generalist-dev",
      id: LESSON_ID,
      now: () => laterNow,
    });

    const updatedArchive = await fs.readFile(
      path.join(tmpRoot, "team", "generalist-dev", "_archived", `${LESSON_ID}.json`),
      "utf8",
    );
    const parsed = JSON.parse(updatedArchive) as { use_count: number; last_used_at: string };
    expect(parsed.use_count).toBe(2); // incremented from 1 to 2
    expect(parsed.last_used_at).toBe(laterNow.toISOString());
  });
});

// ---------------------------------------------------------------------------
// retrieve-after-retirement — AC2 (Story native:01KV7FGDTQ8FSJ2EEPHHGK0KRQ)
//
// The apply path for lesson-retirement moves lessons out of the live
// Knowledge section and into _archived/. This suite proves that after
// retirement the lesson is:
//   (a) no longer findable in the live Knowledge section, AND
//   (b) still retrievable via recallLesson (archived-store fallback).
// ---------------------------------------------------------------------------

describe("recallLesson — retrieve-after-retirement (AC2)", () => {
  const RETIRE_ID = "01KV7FGDTQ8FSJ2EEPHHGK0RET";
  const RETIRE_DETAIL = "Never skip the pre-PR gate — it is the last safety net.";
  const RETIRE_APPLIES_WHEN = "Before opening any pull request";
  const RETIRE_LEARNED_AT = "2026-01-01T00:00:00.000Z";

  const retirableLesson: ParsedLesson = {
    id: RETIRE_ID,
    kind: "pitfall",
    applies_when: RETIRE_APPLIES_WHEN,
    detail: RETIRE_DETAIL,
    failure_class: "skip-pre-pr-gate",
    learned_at: RETIRE_LEARNED_AT,
    // use_count absent — never recalled (makes it retirable)
  };

  function personaWithLesson(lesson: ParsedLesson): string {
    const block = serialiseLessonBlock(lesson);
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
hired_at: "2026-01-01T00:00:00.000Z"
catalogue_version: "0.1.0"
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

${block}
`;
  }

  /**
   * Simulate the lesson-retirement apply path:
   *   1. Remove the lesson from the live Knowledge body.
   *   2. Write the updated persona file.
   *   3. Archive the lesson to team/<role>/_archived/<id>.json.
   *
   * This does NOT exercise the full apply handler (which requires the full
   * registry + proposal gate) — it exercises the underlying `demoteLessonsFromBody`
   * + `archiveLessons` primitives directly, which is what the handler delegates to.
   */
  async function simulateRetirement(
    repoRoot: string,
    lesson: ParsedLesson,
    now: () => Date,
  ): Promise<void> {
    const role = "generalist-dev";
    const personaPath = path.join(repoRoot, "team", role, "PERSONA.md");
    const rawPersona = await fs.readFile(personaPath, "utf8");

    // Strip the lesson from the live Knowledge body (mirrors the apply handler).
    const knowledgeStart = rawPersona.indexOf("\n## Knowledge\n");
    if (knowledgeStart === -1) throw new Error("No ## Knowledge section found");
    const beforeKnowledge = rawPersona.slice(0, knowledgeStart + "\n## Knowledge\n".length);
    const afterKnowledge = rawPersona.slice(knowledgeStart + "\n## Knowledge\n".length);

    const newKnowledge = demoteLessonsFromBody(afterKnowledge, new Set([lesson.id]));
    const newPersona = beforeKnowledge + newKnowledge;
    await atomicWriteFile(personaPath, newPersona);

    // Archive the lesson (mirrors archiveLessons in the apply handler).
    await archiveLessons(repoRoot, role, [lesson], now);
  }

  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-retire-recall-"));
    const dir = path.join(tmpRoot, "team", "generalist-dev");
    await fs.mkdir(dir, { recursive: true });
    await atomicWriteFile(
      path.join(dir, "PERSONA.md"),
      personaWithLesson(retirableLesson),
    );
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("(AC2) retired lesson is NOT in the live Knowledge section after retirement", async () => {
    const now = () => new Date("2026-06-10T00:00:00.000Z");
    await simulateRetirement(tmpRoot, retirableLesson, now);

    const personaPath = path.join(tmpRoot, "team", "generalist-dev", "PERSONA.md");
    const raw = await fs.readFile(personaPath, "utf8");

    // The lesson id must be gone from the live file.
    expect(raw).not.toContain(RETIRE_ID);
  });

  it("(AC2) retired lesson is still retrievable on demand via recallLesson", async () => {
    const retireNow = new Date("2026-06-10T00:00:00.000Z");
    await simulateRetirement(tmpRoot, retirableLesson, () => retireNow);

    const result = await recallLesson({
      targetRepoRoot: tmpRoot,
      role: "generalist-dev",
      id: RETIRE_ID,
    });

    expect(result.found).toBe(true);
    expect(result.lesson).not.toBeNull();
    expect(result.lesson!.id).toBe(RETIRE_ID);
    expect(result.lesson!.detail).toBe(RETIRE_DETAIL);
    expect(result.lesson!.applies_when).toBe(RETIRE_APPLIES_WHEN);
    // Archived lessons carry the archived flag.
    expect(result.lesson!.archived).toBe(true);
  });

  it("(AC2) recallLesson returns the full detail of the retired lesson", async () => {
    const retireNow = new Date("2026-06-10T00:00:00.000Z");
    await simulateRetirement(tmpRoot, retirableLesson, () => retireNow);

    const result = await recallLesson({
      targetRepoRoot: tmpRoot,
      role: "generalist-dev",
      id: RETIRE_ID,
    });

    expect(result.found).toBe(true);
    // The full detail is returned (not just applies_when).
    expect(result.lesson!.detail).toBe(RETIRE_DETAIL);
    expect(result.lesson!.detail.length).toBeGreaterThan(0);
  });
});
