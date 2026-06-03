/**
 * Unit tests for `lesson-archive.ts` — Story native:01KT6QSW4W7SMAHAT4EAKCCC65 (AC3).
 *
 * AC3: Given a lesson that is demoted to the archived store, When the archived
 * entry is inspected, Then it retains every original field and additionally
 * carries an archived_at timestamp, and no lesson is ever permanently deleted.
 *
 * Covers:
 *   (a) appendArchivedLessons stamps archived_at on each demoted entry.
 *   (b) All original ParsedLessonEntry fields are preserved verbatim.
 *   (c) appendArchivedLessons is idempotent — demoting the same lesson twice
 *       does NOT create a duplicate entry.
 *   (d) Lessons already in the archive are preserved when new entries are appended.
 *   (e) readArchivedLessons returns [] when the archive file does not exist.
 *   (f) archivedLessonsPath returns the expected repo-relative path.
 *
 * Approach: real filesystem ops against a tmpdir. No node:fs mocking.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendArchivedLessons,
  readArchivedLessons,
  archivedLessonsPath,
  type ArchivedLesson,
} from "./lesson-archive.js";
import type { ParsedLessonEntry } from "./parse-knowledge-section.js";

let tmpRoot: string;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date("2026-06-04T10:00:00.000Z");
const FIXED_NOW_STR = "2026-06-04T10:00:00.000Z";

function makeLesson(overrides: Partial<ParsedLessonEntry> = {}): ParsedLessonEntry {
  return {
    id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    kind: "pattern",
    applies_when: "use atomic writes for file ops",
    detail: "Always use atomic write patterns to avoid partial file corruption.",
    source_ref: "native:01KT1234",
    use_count: 3,
    last_used_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-lesson-archive-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("archivedLessonsPath", () => {
  it("(f) returns the expected path", () => {
    const result = archivedLessonsPath("/repo", "generalist-dev");
    expect(result).toBe("/repo/team/generalist-dev/_archived/lessons.json");
  });
});

describe("readArchivedLessons", () => {
  it("(e) returns [] when archive file does not exist", async () => {
    const result = await readArchivedLessons(tmpRoot, "generalist-dev");
    expect(result).toEqual([]);
  });

  it("returns parsed entries from an existing archive", async () => {
    const archivePath = archivedLessonsPath(tmpRoot, "generalist-dev");
    await fs.mkdir(path.dirname(archivePath), { recursive: true });
    const lesson = makeLesson();
    const archived: ArchivedLesson = { ...lesson, archived_at: FIXED_NOW_STR };
    await fs.writeFile(archivePath, JSON.stringify([archived], null, 2));

    const result = await readArchivedLessons(tmpRoot, "generalist-dev");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: lesson.id, archived_at: FIXED_NOW_STR });
  });
});

describe("appendArchivedLessons", () => {
  it("(a) stamps archived_at on each demoted lesson", async () => {
    const lesson = makeLesson();
    const result = await appendArchivedLessons(
      tmpRoot,
      "generalist-dev",
      [lesson],
      () => FIXED_NOW,
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.archived_at).toBe(FIXED_NOW_STR);
  });

  it("(b) preserves all original ParsedLessonEntry fields verbatim", async () => {
    const lesson = makeLesson({
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      kind: "pitfall",
      applies_when: "avoid race conditions",
      detail: "Race conditions cause flaky tests.",
      source_ref: "native:01KT5678",
      use_count: 5,
      last_used_at: "2026-05-01T00:00:00.000Z",
    });

    const result = await appendArchivedLessons(
      tmpRoot,
      "generalist-dev",
      [lesson],
      () => FIXED_NOW,
    );

    const entry = result[0]!;
    expect(entry.id).toBe(lesson.id);
    expect(entry.kind).toBe(lesson.kind);
    expect(entry.applies_when).toBe(lesson.applies_when);
    expect(entry.detail).toBe(lesson.detail);
    expect(entry.source_ref).toBe(lesson.source_ref);
    expect(entry.use_count).toBe(lesson.use_count);
    expect(entry.last_used_at).toBe(lesson.last_used_at);
    // Plus the new timestamp.
    expect(entry.archived_at).toBe(FIXED_NOW_STR);
  });

  it("(c) is idempotent — demoting the same lesson twice does NOT duplicate", async () => {
    const lesson = makeLesson();

    await appendArchivedLessons(tmpRoot, "generalist-dev", [lesson], () => FIXED_NOW);
    const secondResult = await appendArchivedLessons(
      tmpRoot,
      "generalist-dev",
      [lesson],
      () => FIXED_NOW,
    );

    // The archive must contain only ONE copy.
    expect(secondResult).toHaveLength(1);
    expect(secondResult[0]!.id).toBe(lesson.id);

    // Verify persisted file also has one entry.
    const persisted = await readArchivedLessons(tmpRoot, "generalist-dev");
    expect(persisted).toHaveLength(1);
  });

  it("(d) preserves existing entries when appending new ones", async () => {
    const lesson1 = makeLesson({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" });
    const lesson2 = makeLesson({
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      applies_when: "second lesson",
    });

    await appendArchivedLessons(tmpRoot, "generalist-dev", [lesson1], () => FIXED_NOW);
    const result = await appendArchivedLessons(
      tmpRoot,
      "generalist-dev",
      [lesson2],
      () => FIXED_NOW,
    );

    expect(result).toHaveLength(2);
    expect(result.map((e) => e.id)).toContain(lesson1.id);
    expect(result.map((e) => e.id)).toContain(lesson2.id);
  });

  it("creates the _archived directory when it does not exist", async () => {
    const lesson = makeLesson();
    await appendArchivedLessons(tmpRoot, "generalist-dev", [lesson], () => FIXED_NOW);

    const archivePath = archivedLessonsPath(tmpRoot, "generalist-dev");
    const stat = await fs.stat(archivePath);
    expect(stat.isFile()).toBe(true);
  });

  it("no lesson is ever permanently deleted — overflow is archived, not dropped", async () => {
    // This test is the AC3 proof: demoting moves lessons, never destroys them.
    const lessons: ParsedLessonEntry[] = [
      makeLesson({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", applies_when: "first" }),
      makeLesson({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAW", applies_when: "second" }),
      makeLesson({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAX", applies_when: "third" }),
    ];

    const archived = await appendArchivedLessons(
      tmpRoot,
      "generalist-dev",
      lessons,
      () => FIXED_NOW,
    );

    // All three are present in the archive.
    expect(archived).toHaveLength(3);
    const ids = archived.map((e) => e.id);
    expect(ids).toContain("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(ids).toContain("01ARZ3NDEKTSV4RRFFQ69G5FAW");
    expect(ids).toContain("01ARZ3NDEKTSV4RRFFQ69G5FAX");

    // Every entry carries archived_at.
    for (const entry of archived) {
      expect(entry.archived_at).toBe(FIXED_NOW_STR);
    }
  });
});
