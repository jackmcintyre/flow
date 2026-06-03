/**
 * Unit tests for `recallLesson` — Story native:01KT6QEWY794ZY0DH6JHQFWG6V (AC2).
 *
 * Story native:01KT6QSW4W7SMAHAT4EAKCCC65 additions (AC2):
 *   - Returns the full lesson detail when the lesson is in the archived store.
 *   - Increments use_count and stamps last_used_at in the live store on recall.
 *
 * Covers:
 *   (a) Returns the full body of a lesson when called with the lesson's id.
 *   (b) Returns { found: false } when no lesson matches the id.
 *   (c) Works for structured lesson blocks (<!-- lesson:json ... -->).
 *   (d) Works for flat-bullet migrated entries (id = MIGRATED-N).
 *   (e) PersonaFileNotFoundError propagates when the persona file is absent.
 *   (f) Returns the full lesson detail when recalled from the archived store.
 *   (g) Increments use_count and stamps last_used_at after a live recall.
 *
 * Approach: real filesystem ops against a tmpdir with a constructed persona file.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PersonaFileNotFoundError } from "../../errors.js";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { recallLesson } from "../recall-lesson.js";
import {
  appendArchivedLessons,
  type ArchivedLesson,
} from "../../lib/lesson-archive.js";
import { parseKnowledgeSection } from "../../lib/parse-knowledge-section.js";

let tmpRoot: string;

// ---------------------------------------------------------------------------
// Fixture persona file
// ---------------------------------------------------------------------------

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

Implements one story at a time.

## Mandate

Claim and build.

## Out of mandate

Not reviewing.

## Prompt

You are the generalist dev.

## Knowledge

<!-- lesson:json {"id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","kind":"pattern","applies_when":"use atomic writes for file ops","detail":"Always use atomic write patterns to avoid partial file corruption under concurrent access. Applies to any file that might be written by multiple processes.","source_ref":"native:01KT1234","learned_at":"2026-01-01T00:00:00.000Z"} -->
<!-- lesson:json {"id":"01ARZ3NDEKTSV4RRFFQ69G5FAW","kind":"pitfall","applies_when":"avoid race conditions in tests","detail":"Test isolation failures cause flaky results. Always use unique temp directories per test.","failure_class":"test-quality","source_ref":"native:01KT5678","learned_at":"2026-01-02T00:00:00.000Z"} -->
`;

const FIXTURE_WITH_FLAT_BULLET = `---
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

Implements one story at a time.

## Mandate

Claim and build.

## Out of mandate

Not reviewing.

## Prompt

You are the generalist dev.

## Knowledge

- Always double-check the test setup before running.
- Prefer explicit over implicit in API design.
`;

async function makePersonaDir(root: string, role: string): Promise<string> {
  const dir = path.join(root, "team", role);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-recall-lesson-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("recallLesson", () => {
  it("(a) returns found:true and the full lesson detail for a known id", async () => {
    const dir = await makePersonaDir(tmpRoot, "generalist-dev");
    await atomicWriteFile(path.join(dir, "PERSONA.md"), FIXTURE_PERSONA_MD);

    const result = await recallLesson({
      targetRepoRoot: tmpRoot,
      role: "generalist-dev",
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    });

    expect(result.found).toBe(true);
    if (!result.found) return; // type narrowing
    expect(result.id).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(result.kind).toBe("pattern");
    expect(result.applies_when).toBe("use atomic writes for file ops");
    expect(result.detail).toContain("atomic write patterns");
    expect(result.source_ref).toBe("native:01KT1234");
  });

  it("(a) returns the second lesson when called with its id", async () => {
    const dir = await makePersonaDir(tmpRoot, "generalist-dev");
    await atomicWriteFile(path.join(dir, "PERSONA.md"), FIXTURE_PERSONA_MD);

    const result = await recallLesson({
      targetRepoRoot: tmpRoot,
      role: "generalist-dev",
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    });

    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.id).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAW");
    expect(result.kind).toBe("pitfall");
    expect(result.applies_when).toBe("avoid race conditions in tests");
    expect(result.detail).toContain("Test isolation failures");
  });

  it("(b) returns found:false when no lesson matches the id", async () => {
    const dir = await makePersonaDir(tmpRoot, "generalist-dev");
    await atomicWriteFile(path.join(dir, "PERSONA.md"), FIXTURE_PERSONA_MD);

    const result = await recallLesson({
      targetRepoRoot: tmpRoot,
      role: "generalist-dev",
      id: "NO-SUCH-ID",
    });

    expect(result.found).toBe(false);
  });

  it("(d) returns the full detail for a flat-bullet migrated entry using MIGRATED-N id", async () => {
    const dir = await makePersonaDir(tmpRoot, "generalist-dev");
    await atomicWriteFile(path.join(dir, "PERSONA.md"), FIXTURE_WITH_FLAT_BULLET);

    // Flat bullets are migrated with MIGRATED-0, MIGRATED-1, etc.
    const result0 = await recallLesson({
      targetRepoRoot: tmpRoot,
      role: "generalist-dev",
      id: "MIGRATED-0",
    });

    expect(result0.found).toBe(true);
    if (!result0.found) return;
    expect(result0.kind).toBe("pattern");
    expect(result0.applies_when).toBe("Always double-check the test setup before running.");
    expect(result0.detail).toBe("Always double-check the test setup before running.");

    const result1 = await recallLesson({
      targetRepoRoot: tmpRoot,
      role: "generalist-dev",
      id: "MIGRATED-1",
    });
    expect(result1.found).toBe(true);
    if (!result1.found) return;
    expect(result1.applies_when).toBe("Prefer explicit over implicit in API design.");
  });

  it("(e) PersonaFileNotFoundError propagates when the persona file is absent", async () => {
    await expect(
      recallLesson({
        targetRepoRoot: tmpRoot,
        role: "generalist-dev",
        id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      }),
    ).rejects.toThrow(PersonaFileNotFoundError);
  });

  // -------------------------------------------------------------------------
  // Story native:01KT6QSW4W7SMAHAT4EAKCCC65 — AC2: recall from archived store
  // -------------------------------------------------------------------------

  it("(f) returns full lesson detail when recalled from the archived store", async () => {
    // Set up the live persona (no matching lesson).
    const dir = await makePersonaDir(tmpRoot, "generalist-dev");
    await atomicWriteFile(path.join(dir, "PERSONA.md"), FIXTURE_PERSONA_MD);

    // Manually add an archived lesson.
    const archivedLesson: ArchivedLesson = {
      id: "ARCHIVED-01ARZ3NDEKTSV4RRFFQ69G5FAZ",
      kind: "tool-quirk",
      applies_when: "use the recall tool for archived knowledge",
      detail: "Archived lessons are retrievable by id via recallLesson.",
      source_ref: "native:01KT9999",
      use_count: 0,
      last_used_at: null,
      archived_at: "2026-06-01T00:00:00.000Z",
    };
    await appendArchivedLessons(
      tmpRoot,
      "generalist-dev",
      [archivedLesson],
      () => new Date("2026-06-01T00:00:00.000Z"),
    );

    const result = await recallLesson({
      targetRepoRoot: tmpRoot,
      role: "generalist-dev",
      id: "ARCHIVED-01ARZ3NDEKTSV4RRFFQ69G5FAZ",
    });

    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.id).toBe("ARCHIVED-01ARZ3NDEKTSV4RRFFQ69G5FAZ");
    expect(result.kind).toBe("tool-quirk");
    expect(result.applies_when).toBe("use the recall tool for archived knowledge");
    expect(result.detail).toContain("Archived lessons are retrievable by id");
    expect(result.source_ref).toBe("native:01KT9999");
    expect(result.from_archive).toBe(true);
  });

  it("(f) returns { found: false } when id is absent from both live and archived stores", async () => {
    const dir = await makePersonaDir(tmpRoot, "generalist-dev");
    await atomicWriteFile(path.join(dir, "PERSONA.md"), FIXTURE_PERSONA_MD);

    const result = await recallLesson({
      targetRepoRoot: tmpRoot,
      role: "generalist-dev",
      id: "NO-SUCH-ID-ANYWHERE",
    });

    expect(result.found).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Story native:01KT6QSW4W7SMAHAT4EAKCCC65 — AC2: usage tracking on recall
  // -------------------------------------------------------------------------

  it("(g) increments use_count and stamps last_used_at after a live recall", async () => {
    const dir = await makePersonaDir(tmpRoot, "generalist-dev");
    await atomicWriteFile(path.join(dir, "PERSONA.md"), FIXTURE_PERSONA_MD);

    const fixedNow = new Date("2026-06-04T12:00:00.000Z");

    // Recall a lesson that is in the live store.
    const result = await recallLesson({
      targetRepoRoot: tmpRoot,
      role: "generalist-dev",
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      now: () => fixedNow,
    });

    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.from_archive).toBe(false);

    // Re-parse the persona file to verify the lesson block was updated.
    const updatedRaw = await fs.readFile(
      path.join(dir, "PERSONA.md"),
      "utf8",
    );
    // Extract the Knowledge section.
    const kStart = updatedRaw.indexOf("## Knowledge");
    const kSection = updatedRaw.slice(kStart);
    const lessons = parseKnowledgeSection(kSection);

    const updated = lessons.find((l) => l.id === "01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(updated).toBeDefined();
    expect(updated!.use_count).toBe(1);
    expect(updated!.last_used_at).toBe("2026-06-04T12:00:00.000Z");
  });

  it("(g) increments use_count on a second recall (cumulative)", async () => {
    const dir = await makePersonaDir(tmpRoot, "generalist-dev");
    await atomicWriteFile(path.join(dir, "PERSONA.md"), FIXTURE_PERSONA_MD);

    const now1 = new Date("2026-06-04T12:00:00.000Z");
    const now2 = new Date("2026-06-04T13:00:00.000Z");

    // First recall.
    await recallLesson({
      targetRepoRoot: tmpRoot,
      role: "generalist-dev",
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      now: () => now1,
    });

    // Second recall.
    await recallLesson({
      targetRepoRoot: tmpRoot,
      role: "generalist-dev",
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      now: () => now2,
    });

    // Re-parse — use_count should be 2, last_used_at should be the second recall time.
    const updatedRaw = await fs.readFile(
      path.join(dir, "PERSONA.md"),
      "utf8",
    );
    const kStart = updatedRaw.indexOf("## Knowledge");
    const kSection = updatedRaw.slice(kStart);
    const lessons = parseKnowledgeSection(kSection);

    const updated = lessons.find((l) => l.id === "01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(updated!.use_count).toBe(2);
    expect(updated!.last_used_at).toBe("2026-06-04T13:00:00.000Z");
  });
});
