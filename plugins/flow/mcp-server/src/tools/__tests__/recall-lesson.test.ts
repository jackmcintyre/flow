/**
 * Unit / integration tests for `recallLesson` and `findLessonById`
 * — Story native:01KT6QEWY794ZY0DH6JHQFWG6V (AC2).
 *
 * Covers:
 *  (a) `findLessonById` returns the full lesson body when the id matches.
 *  (b) `findLessonById` returns null when no match (soft miss).
 *  (c) `findLessonById` skips malformed JSON blocks silently.
 *  (d) `recallLesson` returns { found: true, lesson } for a real persona
 *      file with a structured lesson.
 *  (e) `recallLesson` returns { found: false, lesson: null } for an id
 *      that is not in the Knowledge section.
 *  (f) `recallLesson` propagates PersonaFileNotFoundError when the persona
 *      file is absent.
 *  (g) Full-body detail is returned (the full `detail` text, not just the
 *      trigger), confirming the recall delivers more than the one-line index.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PersonaFileNotFoundError } from "../../errors.js";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { recallLesson, findLessonById } from "../recall-lesson.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LESSON_ID = "01KT6QEWY794ZY0DH6JHQFWG6V";
const LESSON_KIND = "pitfall";
const LESSON_APPLIES_WHEN = "When deploying without running tests first";
const LESSON_DETAIL =
  "Always run the full test suite before opening a PR — deploy-without-test PRs caused 3 rollbacks in a row.";
const LESSON_FAILURE_CLASS = "deploy-skip-test";
const LESSON_SOURCE_REF = "native:01KT0001";
const LESSON_LEARNED_AT = "2026-06-01T00:00:00.000Z";

const STRUCTURED_LESSON_LINE = `<!-- lesson:json ${JSON.stringify({
  id: LESSON_ID,
  kind: LESSON_KIND,
  applies_when: LESSON_APPLIES_WHEN,
  detail: LESSON_DETAIL,
  failure_class: LESSON_FAILURE_CLASS,
  source_ref: LESSON_SOURCE_REF,
  learned_at: LESSON_LEARNED_AT,
})} -->`;

// A second lesson to ensure we match by id, not just first-found.
const LESSON_ID_2 = "01KT6QEWY794ZY0DH6JHQFWG6X";
const STRUCTURED_LESSON_LINE_2 = `<!-- lesson:json ${JSON.stringify({
  id: LESSON_ID_2,
  kind: "pattern",
  applies_when: "When running CI on a new branch",
  detail: "Always create the branch from main, not from a feature branch.",
  learned_at: "2026-06-02T00:00:00.000Z",
})} -->`;

const FIXTURE_PERSONA_MD = `---
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

${STRUCTURED_LESSON_LINE}
${STRUCTURED_LESSON_LINE_2}
`;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-recall-lesson-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// findLessonById — pure unit tests (no IO)
// ---------------------------------------------------------------------------

describe("findLessonById (pure)", () => {
  it("(a) returns the full lesson body when the id matches", () => {
    const body = `${STRUCTURED_LESSON_LINE}\n${STRUCTURED_LESSON_LINE_2}`;
    const result = findLessonById(body, LESSON_ID);

    expect(result).not.toBeNull();
    expect(result!.id).toBe(LESSON_ID);
    expect(result!.kind).toBe(LESSON_KIND);
    expect(result!.applies_when).toBe(LESSON_APPLIES_WHEN);
    expect(result!.detail).toBe(LESSON_DETAIL);
    expect(result!.failure_class).toBe(LESSON_FAILURE_CLASS);
    expect(result!.source_ref).toBe(LESSON_SOURCE_REF);
    expect(result!.learned_at).toBe(LESSON_LEARNED_AT);
  });

  it("(b) returns null when no lesson matches the id", () => {
    const body = `${STRUCTURED_LESSON_LINE}`;
    const result = findLessonById(body, "01NONEXISTENT0000000000000");

    expect(result).toBeNull();
  });

  it("(b2) returns null on empty knowledge body", () => {
    expect(findLessonById("", LESSON_ID)).toBeNull();
  });

  it("(c) skips malformed JSON blocks silently and continues scanning", () => {
    // A malformed block followed by a valid block — should find the valid one.
    const body = [
      `<!-- lesson:json {not-valid-json} -->`,
      STRUCTURED_LESSON_LINE_2,
    ].join("\n");

    const result = findLessonById(body, LESSON_ID_2);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(LESSON_ID_2);
  });

  it("finds the second lesson when asked for it by id", () => {
    const body = `${STRUCTURED_LESSON_LINE}\n${STRUCTURED_LESSON_LINE_2}`;
    const result = findLessonById(body, LESSON_ID_2);

    expect(result).not.toBeNull();
    expect(result!.id).toBe(LESSON_ID_2);
    expect(result!.kind).toBe("pattern");
    expect(result!.applies_when).toBe("When running CI on a new branch");
  });

  it("(g) returns the full detail body (not just the trigger/applies_when)", () => {
    const body = STRUCTURED_LESSON_LINE;
    const result = findLessonById(body, LESSON_ID);

    expect(result).not.toBeNull();
    // detail is the full lesson text, which is much longer than applies_when
    expect(result!.detail).toBe(LESSON_DETAIL);
    expect(result!.detail).not.toBe(result!.applies_when);
    expect(result!.detail.length).toBeGreaterThan(result!.applies_when.length);
  });
});

// ---------------------------------------------------------------------------
// recallLesson — integration tests (real filesystem + persona file)
// ---------------------------------------------------------------------------

describe("recallLesson (integration)", () => {
  async function makePersonaFile(content: string): Promise<void> {
    const dir = path.join(tmpRoot, "team", "generalist-dev");
    await fs.mkdir(dir, { recursive: true });
    await atomicWriteFile(path.join(dir, "PERSONA.md"), content);
  }

  it("(d) returns { found: true, lesson } for a known lesson id", async () => {
    await makePersonaFile(FIXTURE_PERSONA_MD);

    const result = await recallLesson({
      targetRepoRoot: tmpRoot,
      role: "generalist-dev",
      id: LESSON_ID,
    });

    expect(result.found).toBe(true);
    expect(result.lesson).not.toBeNull();
    expect(result.lesson!.id).toBe(LESSON_ID);
    expect(result.lesson!.detail).toBe(LESSON_DETAIL);
    expect(result.lesson!.kind).toBe(LESSON_KIND);
    expect(result.lesson!.applies_when).toBe(LESSON_APPLIES_WHEN);
    expect(result.lesson!.failure_class).toBe(LESSON_FAILURE_CLASS);
    expect(result.lesson!.source_ref).toBe(LESSON_SOURCE_REF);
    expect(result.lesson!.learned_at).toBe(LESSON_LEARNED_AT);
  });

  it("(e) returns { found: false, lesson: null } for an unknown id", async () => {
    await makePersonaFile(FIXTURE_PERSONA_MD);

    const result = await recallLesson({
      targetRepoRoot: tmpRoot,
      role: "generalist-dev",
      id: "01NONEXISTENT0000000000000",
    });

    expect(result.found).toBe(false);
    expect(result.lesson).toBeNull();
  });

  it("(f) propagates PersonaFileNotFoundError when the persona file is absent", async () => {
    // No persona file created.
    await expect(
      recallLesson({
        targetRepoRoot: tmpRoot,
        role: "generalist-dev",
        id: LESSON_ID,
      }),
    ).rejects.toThrow(PersonaFileNotFoundError);
  });

  it("(g-integration) full detail is returned — more text than the one-line trigger", async () => {
    await makePersonaFile(FIXTURE_PERSONA_MD);

    const result = await recallLesson({
      targetRepoRoot: tmpRoot,
      role: "generalist-dev",
      id: LESSON_ID,
    });

    expect(result.found).toBe(true);
    expect(result.lesson!.detail.length).toBeGreaterThan(
      result.lesson!.applies_when.length,
    );
    expect(result.lesson!.detail).toBe(LESSON_DETAIL);
  });
});
