/**
 * Unit tests for `lesson-archive.ts` — Story native:01KT6QSW4W7SMAHAT4EAKCCC65 (AC3).
 *
 * Covers:
 *  (a) `extractLessonsFromBody` returns all structured lessons from a body.
 *  (b) `extractLessonsFromBody` skips malformed JSON blocks silently.
 *  (c) `rankLessons` orders by use_count descending then last_used_at descending.
 *  (d) `rankLessons` splits at the budget boundary.
 *  (e) `rankLessons` with fewer lessons than budget puts all in topLessons.
 *  (f) `demoteLessonsFromBody` removes overflow lessons from the body.
 *  (g) `demoteLessonsFromBody` preserves flat-bullet lines and blank lines.
 *  (h) Demoted lesson retains every original field plus archived_at.
 *  (i) Demoted lesson is never permanently deleted (archived file exists after demotion).
 *  (j) `archiveLessons` writes JSON files to team/<role>/_archived/<id>.json.
 *  (k) `findArchivedLessonById` returns the archived lesson when present.
 *  (l) `findArchivedLessonById` returns null when the archived file is absent.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  extractLessonsFromBody,
  rankLessons,
  demoteLessonsFromBody,
  archiveLessons,
  findArchivedLessonById,
  serialiseLessonBlock,
  type ParsedLesson,
} from "./lesson-archive.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLesson(overrides: Partial<ParsedLesson> & { id: string }): ParsedLesson {
  return {
    id: overrides.id,
    kind: overrides.kind ?? "pattern",
    applies_when: overrides.applies_when ?? `When rule ${overrides.id} applies`,
    detail: overrides.detail ?? `Detail for lesson ${overrides.id}`,
    learned_at: overrides.learned_at ?? "2026-01-01T00:00:00.000Z",
    use_count: overrides.use_count,
    last_used_at: overrides.last_used_at,
    failure_class: overrides.failure_class,
    source_ref: overrides.source_ref,
    source_pr: overrides.source_pr,
  };
}

function makeBody(lessons: ParsedLesson[]): string {
  return lessons.map(serialiseLessonBlock).join("\n");
}

// ---------------------------------------------------------------------------
// Fixture lessons
// ---------------------------------------------------------------------------

const L1 = makeLesson({ id: "01KT0000000000000000000001", use_count: 5, last_used_at: "2026-06-01T12:00:00.000Z" });
const L2 = makeLesson({ id: "01KT0000000000000000000002", use_count: 5, last_used_at: "2026-06-02T12:00:00.000Z" });
const L3 = makeLesson({ id: "01KT0000000000000000000003", use_count: 3 });
const L4 = makeLesson({ id: "01KT0000000000000000000004", use_count: 0 });
const L5 = makeLesson({
  id: "01KT0000000000000000000005",
  kind: "pitfall",
  failure_class: "deploy-skip-test",
  use_count: 10,
});

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-lesson-archive-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// extractLessonsFromBody
// ---------------------------------------------------------------------------

describe("extractLessonsFromBody", () => {
  it("(a) returns all structured lessons from a body", () => {
    const body = makeBody([L1, L2, L3]);
    const result = extractLessonsFromBody(body);

    expect(result).toHaveLength(3);
    expect(result[0]!.id).toBe(L1.id);
    expect(result[1]!.id).toBe(L2.id);
    expect(result[2]!.id).toBe(L3.id);
  });

  it("(b) skips malformed JSON blocks silently", () => {
    const body = [
      "<!-- lesson:json {not-valid-json} -->",
      serialiseLessonBlock(L1),
      "<!-- lesson:json {} -->", // missing required fields
    ].join("\n");

    const result = extractLessonsFromBody(body);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe(L1.id);
  });

  it("returns an empty array for an empty body", () => {
    expect(extractLessonsFromBody("")).toHaveLength(0);
  });

  it("preserves use_count and last_used_at fields", () => {
    const body = makeBody([L1]);
    const [lesson] = extractLessonsFromBody(body);
    expect(lesson!.use_count).toBe(5);
    expect(lesson!.last_used_at).toBe("2026-06-01T12:00:00.000Z");
  });

  it("preserves optional fields (failure_class, source_ref, source_pr)", () => {
    const l = makeLesson({
      id: "01KT0000000000000000000099",
      kind: "pitfall",
      failure_class: "my-class",
      source_ref: "native:01KT0001",
      source_pr: "https://github.com/foo/bar/pull/1",
    });
    const body = serialiseLessonBlock(l);
    const [parsed] = extractLessonsFromBody(body);
    expect(parsed!.failure_class).toBe("my-class");
    expect(parsed!.source_ref).toBe("native:01KT0001");
    expect(parsed!.source_pr).toBe("https://github.com/foo/bar/pull/1");
  });
});

// ---------------------------------------------------------------------------
// rankLessons — ordering and budget cap
// ---------------------------------------------------------------------------

describe("rankLessons", () => {
  it("(c) orders by use_count descending", () => {
    const body = makeBody([L3, L4, L1, L5]); // shuffled: counts 3, 0, 5, 10
    const { topLessons } = rankLessons(body, 10);

    expect(topLessons[0]!.id).toBe(L5.id); // use_count=10
    expect(topLessons[1]!.id).toBe(L1.id); // use_count=5
    expect(topLessons[2]!.id).toBe(L3.id); // use_count=3
    expect(topLessons[3]!.id).toBe(L4.id); // use_count=0
  });

  it("(c) breaks use_count ties by last_used_at descending (most recent first)", () => {
    // L1 and L2 both have use_count=5; L2 has a later last_used_at.
    const body = makeBody([L1, L2]);
    const { topLessons } = rankLessons(body, 10);

    expect(topLessons[0]!.id).toBe(L2.id); // last_used_at=2026-06-02 (more recent)
    expect(topLessons[1]!.id).toBe(L1.id); // last_used_at=2026-06-01
  });

  it("(c) treats missing use_count as 0", () => {
    const noCount = makeLesson({ id: "01KT0000000000000000000010" });
    const body = makeBody([noCount, L3]); // L3 has use_count=3
    const { topLessons } = rankLessons(body, 10);

    expect(topLessons[0]!.id).toBe(L3.id);   // use_count=3 wins
    expect(topLessons[1]!.id).toBe(noCount.id); // use_count=0 (absent)
  });

  it("(d) splits at the budget boundary", () => {
    const body = makeBody([L1, L2, L3, L4, L5]);
    const { topLessons, overflow } = rankLessons(body, 3);

    expect(topLessons).toHaveLength(3);
    expect(overflow).toHaveLength(2);
  });

  it("(d) top lessons are the highest-ranked ones", () => {
    const body = makeBody([L1, L2, L3, L4, L5]);
    const { topLessons, overflow } = rankLessons(body, 3);

    // Sorted order: L5(10) > L2(5, 2026-06-02) > L1(5, 2026-06-01) > L3(3) > L4(0)
    expect(topLessons.map((l) => l.id)).toEqual([L5.id, L2.id, L1.id]);
    expect(overflow.map((l) => l.id)).toEqual([L3.id, L4.id]);
  });

  it("(e) puts all lessons in topLessons when fewer than budget", () => {
    const body = makeBody([L1, L2]);
    const { topLessons, overflow } = rankLessons(body, 10);

    expect(topLessons).toHaveLength(2);
    expect(overflow).toHaveLength(0);
  });

  it("returns empty sets for an empty body", () => {
    const { topLessons, overflow } = rankLessons("", 10);
    expect(topLessons).toHaveLength(0);
    expect(overflow).toHaveLength(0);
  });

  it("uses DEFAULT_BRIEFING_BUDGET (10) when no budget is specified", () => {
    const lessons = Array.from({ length: 15 }, (_, i) =>
      makeLesson({ id: `01KT000000000000000000${String(i).padStart(4, "0")}`, use_count: i }),
    );
    const body = makeBody(lessons);
    const { topLessons, overflow } = rankLessons(body);

    expect(topLessons).toHaveLength(10);
    expect(overflow).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// demoteLessonsFromBody
// ---------------------------------------------------------------------------

describe("demoteLessonsFromBody", () => {
  it("(f) removes overflow lesson blocks from the body", () => {
    const body = makeBody([L1, L2, L3]);
    const overflowIds = new Set([L2.id]);
    const result = demoteLessonsFromBody(body, overflowIds);

    expect(result).toContain(L1.id);
    expect(result).not.toContain(L2.id);
    expect(result).toContain(L3.id);
  });

  it("(g) preserves flat-bullet lines verbatim", () => {
    const bullet = "- always check this first";
    const body = [bullet, makeBody([L1, L2])].join("\n");
    const result = demoteLessonsFromBody(body, new Set([L2.id]));

    expect(result).toContain(bullet);
    expect(result).toContain(L1.id);
    expect(result).not.toContain(L2.id);
  });

  it("(g) preserves blank lines between kept lessons", () => {
    // Blank line between L1 and L3 (L2 is demoted; blank lines around it are preserved).
    const body = [
      serialiseLessonBlock(L1),
      "",
      serialiseLessonBlock(L2),
      "",
      serialiseLessonBlock(L3),
    ].join("\n");
    const result = demoteLessonsFromBody(body, new Set([L2.id]));

    // Blank lines around L2 are preserved in the output.
    expect(result).toContain("\n\n"); // at least one blank line survives
    expect(result).toContain(L1.id);
    expect(result).not.toContain(L2.id);
    expect(result).toContain(L3.id);
  });

  it("returns the body unchanged when overflowIds is empty", () => {
    const body = makeBody([L1, L2]);
    expect(demoteLessonsFromBody(body, new Set())).toBe(body);
  });

  it("returns the body unchanged when no overflow id matches", () => {
    const body = makeBody([L1]);
    const result = demoteLessonsFromBody(body, new Set(["01NONEXISTENT0000000000000"]));
    expect(result).toBe(body);
  });
});

// ---------------------------------------------------------------------------
// archiveLessons + findArchivedLessonById — filesystem integration tests
// ---------------------------------------------------------------------------

describe("archiveLessons + findArchivedLessonById (integration)", () => {
  const FIXED_NOW = new Date("2026-06-04T12:00:00.000Z");
  const fixedNow = () => FIXED_NOW;

  it("(h) archived entry retains every original field and carries archived_at", async () => {
    await archiveLessons(tmpRoot, "generalist-dev", [L5], fixedNow);

    const archived = await findArchivedLessonById(tmpRoot, "generalist-dev", L5.id);

    expect(archived).not.toBeNull();
    expect(archived!.id).toBe(L5.id);
    expect(archived!.kind).toBe(L5.kind);
    expect(archived!.applies_when).toBe(L5.applies_when);
    expect(archived!.detail).toBe(L5.detail);
    expect(archived!.learned_at).toBe(L5.learned_at);
    expect(archived!.failure_class).toBe(L5.failure_class);
    expect(archived!.archived_at).toBe(FIXED_NOW.toISOString());
  });

  it("(i) archived lesson is never permanently deleted — file persists on disk", async () => {
    await archiveLessons(tmpRoot, "generalist-dev", [L3], fixedNow);

    const archivePath = path.join(tmpRoot, "team", "generalist-dev", "_archived", `${L3.id}.json`);
    const stat = await fs.stat(archivePath);
    expect(stat.isFile()).toBe(true);

    // The lesson is still retrievable.
    const retrieved = await findArchivedLessonById(tmpRoot, "generalist-dev", L3.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.detail).toBe(L3.detail);
  });

  it("(j) writes JSON files to team/<role>/_archived/<id>.json", async () => {
    await archiveLessons(tmpRoot, "generalist-dev", [L1, L2], fixedNow);

    for (const lesson of [L1, L2]) {
      const archivePath = path.join(
        tmpRoot,
        "team",
        "generalist-dev",
        "_archived",
        `${lesson.id}.json`,
      );
      const raw = await fs.readFile(archivePath, "utf8");
      const parsed = JSON.parse(raw) as { id: string; archived_at: string };
      expect(parsed.id).toBe(lesson.id);
      expect(parsed.archived_at).toBe(FIXED_NOW.toISOString());
    }
  });

  it("(k) findArchivedLessonById returns the lesson when present", async () => {
    await archiveLessons(tmpRoot, "generalist-dev", [L4], fixedNow);

    const result = await findArchivedLessonById(tmpRoot, "generalist-dev", L4.id);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(L4.id);
    expect(result!.archived_at).toBe(FIXED_NOW.toISOString());
  });

  it("(l) findArchivedLessonById returns null when absent (soft miss)", async () => {
    const result = await findArchivedLessonById(
      tmpRoot,
      "generalist-dev",
      "01NONEXISTENT0000000000000",
    );
    expect(result).toBeNull();
  });

  it("archiveLessons returns the list of changed paths", async () => {
    const paths = await archiveLessons(tmpRoot, "generalist-dev", [L1, L2], fixedNow);
    expect(paths).toHaveLength(2);
    expect(paths[0]).toBe(`team/generalist-dev/_archived/${L1.id}.json`);
    expect(paths[1]).toBe(`team/generalist-dev/_archived/${L2.id}.json`);
  });
});
