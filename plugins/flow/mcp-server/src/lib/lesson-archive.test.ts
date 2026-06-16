/**
 * Unit tests for `lesson-archive.ts`.
 *
 * Stories:
 *  - native:01KT6QSW4W7SMAHAT4EAKCCC65 (AC3) — original ranking + archive.
 *  - native:01KV7FHAER7497SWZVWMW8D53B (AC1–AC3) — helpfulness-first ranking.
 *
 * Covers:
 *  (a) `extractLessonsFromBody` returns all structured lessons from a body.
 *  (b) `extractLessonsFromBody` skips malformed JSON blocks silently.
 *  (c) `rankLessons` orders by proven helpfulness descending, with
 *      frequency then recency as tiebreaker.
 *  (d) `rankLessons` splits at the budget boundary.
 *  (e) `rankLessons` with fewer lessons than budget puts all in topLessons.
 *  (f) `demoteLessonsFromBody` removes overflow lessons from the body.
 *  (g) `demoteLessonsFromBody` preserves flat-bullet lines and blank lines.
 *  (h) Demoted lesson retains every original field plus archived_at.
 *  (i) Demoted lesson is never permanently deleted (archived file exists after demotion).
 *  (j) `archiveLessons` writes JSON files to team/<role>/_archived/<id>.json.
 *  (k) `findArchivedLessonById` returns the archived lesson when present.
 *  (l) `findArchivedLessonById` returns null when the archived file is absent.
 *  AC1 briefing-assembly: proven-helpful lesson stays in view; frequent-but-unhelpful pushed out.
 *  AC2 tiebreaker: equally-helpful lessons retain frequency/recency order.
 *  AC3 fairness: brand-new lesson with no track record is treated as neutral.
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
  selectRetirableLessons,
  serialiseLessonBlock,
  DEFAULT_AGE_FLOOR_MS,
  lessonHelpfulnessRatio,
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
    helpful_fire_count: overrides.helpful_fire_count,
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
//
// Helpfulness ratios (helpful_fire_count / use_count):
//   L5: 9/10 = 0.90 — highest, ranks first
//   L2: 4/5  = 0.80 — second (same ratio as L1, tiebreaker: more recent last_used_at)
//   L1: 4/5  = 0.80 — third (same ratio, older last_used_at)
//   L3: 2/5  = 0.40 — fourth (use_count=5 so it can be a tiebreaker reference)
//   L4: 1/5  = 0.20 — fifth (lowest, ranks last in the sorted set)
//
// This preserves the descending order L5 > L2 > L1 > L3 > L4 used by the
// existing budget-split tests, now driven by proven helpfulness rather than
// raw use_count.

const L1 = makeLesson({ id: "01KT0000000000000000000001", use_count: 5, helpful_fire_count: 4, last_used_at: "2026-06-01T12:00:00.000Z" });
const L2 = makeLesson({ id: "01KT0000000000000000000002", use_count: 5, helpful_fire_count: 4, last_used_at: "2026-06-02T12:00:00.000Z" });
const L3 = makeLesson({ id: "01KT0000000000000000000003", use_count: 5, helpful_fire_count: 2 });
const L4 = makeLesson({ id: "01KT0000000000000000000004", use_count: 5, helpful_fire_count: 1 });
const L5 = makeLesson({
  id: "01KT0000000000000000000005",
  kind: "pitfall",
  failure_class: "deploy-skip-test",
  use_count: 10,
  helpful_fire_count: 9,
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
  it("(c) orders by proven helpfulness descending (helpful_fire_count / use_count)", () => {
    // Ratios: L5=0.90, L2=0.80 (newer), L1=0.80 (older), L3=0.40, L4=0.20
    const body = makeBody([L3, L4, L1, L5]); // shuffled input
    const { topLessons } = rankLessons(body, 10);

    expect(topLessons[0]!.id).toBe(L5.id); // ratio=0.90
    expect(topLessons[1]!.id).toBe(L1.id); // ratio=0.80 (L2 absent, L1 is next)
    expect(topLessons[2]!.id).toBe(L3.id); // ratio=0.40
    expect(topLessons[3]!.id).toBe(L4.id); // ratio=0.20
  });

  it("(c) breaks helpfulness ties by use_count then last_used_at descending (most recent first)", () => {
    // L1 and L2 have equal helpfulness ratio (4/5 = 0.80); L2 has a later last_used_at.
    const body = makeBody([L1, L2]);
    const { topLessons } = rankLessons(body, 10);

    expect(topLessons[0]!.id).toBe(L2.id); // same ratio, last_used_at=2026-06-02 (more recent)
    expect(topLessons[1]!.id).toBe(L1.id); // same ratio, last_used_at=2026-06-01
  });

  it("(c) treats missing use_count as neutral (no track record = 0.5 ratio)", () => {
    // A brand-new lesson with no use_count is treated as neutral (0.5), which
    // ranks ABOVE a proven-unhelpful lesson (ratio 0.20) but BELOW a proven-helpful one.
    const noCount = makeLesson({ id: "01KT0000000000000000000010" });
    // noCount: ratio=0.5 (neutral). L4: ratio=0.20. L5: ratio=0.90.
    const body = makeBody([noCount, L4, L5]);
    const { topLessons } = rankLessons(body, 10);

    expect(topLessons[0]!.id).toBe(L5.id);     // 0.90 — proven helpful
    expect(topLessons[1]!.id).toBe(noCount.id); // 0.50 — neutral (no track record)
    expect(topLessons[2]!.id).toBe(L4.id);      // 0.20 — proven unhelpful
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

    // Sorted order: L5(0.90) > L2(0.80,newer) > L1(0.80,older) > L3(0.40) > L4(0.20)
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

// ---------------------------------------------------------------------------
// selectRetirableLessons — Story native:01KV7FGDTQ8FSJ2EEPHHGK0KRQ
// AC1: retro recommends retiring dead lessons (selector returns them)
// AC3: all-still-useful roles → selector returns empty
// AC4: mixed input → only dead lessons selected
// ---------------------------------------------------------------------------

describe("selectRetirableLessons", () => {
  // Fixed clock: 30 days after the reference date so age-floor checks pass.
  const REFERENCE_DATE = "2026-01-01T00:00:00.000Z";
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const NOW_DATE = new Date(new Date(REFERENCE_DATE).getTime() + THIRTY_DAYS_MS);
  const fixedNowFn = () => NOW_DATE;

  // A lesson old enough (30 days) and never recalled.
  const deadLesson = makeLesson({
    id: "01KV7FG00000000000000DEAD1",
    learned_at: REFERENCE_DATE,
    // use_count absent (never recalled)
  });

  // A lesson that HAS been recalled — still earning its keep.
  const recalledLesson = makeLesson({
    id: "01KV7FG00000000000000LIVE1",
    learned_at: REFERENCE_DATE,
    use_count: 3,
    last_used_at: "2026-01-15T00:00:00.000Z",
  });

  // A lesson with use_count=0 BUT a last_used_at stamp (double guard).
  const recentlyUsedLesson = makeLesson({
    id: "01KV7FG00000000000000LIVE2",
    learned_at: REFERENCE_DATE,
    use_count: 0,
    last_used_at: "2026-01-10T00:00:00.000Z",
  });

  // A dead lesson that is too NEW (within the age floor).
  const tooNewLesson = makeLesson({
    id: "01KV7FG00000000000000NEW01",
    // learned 1 day before NOW_DATE — within default 14-day floor
    learned_at: new Date(NOW_DATE.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    // use_count absent
  });

  it("(AC1) selects lessons that have never been recalled and are past the age floor", () => {
    const result = selectRetirableLessons(
      [deadLesson],
      { now: fixedNowFn },
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.lesson.id).toBe(deadLesson.id);
    expect(result[0]!.reason).toContain("Never recalled");
    expect(result[0]!.reason).toContain("use_count=0");
  });

  it("(AC3) returns empty when all lessons have been recalled", () => {
    // All lessons are still earning their keep.
    const result = selectRetirableLessons(
      [recalledLesson, recentlyUsedLesson],
      { now: fixedNowFn },
    );

    expect(result).toHaveLength(0);
  });

  it("(AC3) returns empty when the role has no lessons at all", () => {
    const result = selectRetirableLessons([], { now: fixedNowFn });
    expect(result).toHaveLength(0);
  });

  it("(AC4) selects only dead lessons when inputs mix recalled, recently-useful, and dead", () => {
    // deadLesson → retirable
    // recalledLesson → NOT retirable (use_count > 0)
    // recentlyUsedLesson → NOT retirable (last_used_at present)
    // tooNewLesson → NOT retirable (within age floor)
    const result = selectRetirableLessons(
      [deadLesson, recalledLesson, recentlyUsedLesson, tooNewLesson],
      { now: fixedNowFn },
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.lesson.id).toBe(deadLesson.id);
  });

  it("(AC4) does not select a lesson with use_count=0 but last_used_at set", () => {
    const result = selectRetirableLessons(
      [recentlyUsedLesson],
      { now: fixedNowFn },
    );
    expect(result).toHaveLength(0);
  });

  it("(AC4) does not select a lesson within the age floor even if never recalled", () => {
    const result = selectRetirableLessons(
      [tooNewLesson],
      { now: fixedNowFn },
    );
    expect(result).toHaveLength(0);
  });

  it("(AC4) selects multiple dead lessons from the same role", () => {
    const dead2 = makeLesson({
      id: "01KV7FG00000000000000DEAD2",
      learned_at: REFERENCE_DATE,
    });

    const result = selectRetirableLessons(
      [deadLesson, dead2],
      { now: fixedNowFn },
    );

    expect(result).toHaveLength(2);
    const ids = result.map((c) => c.lesson.id);
    expect(ids).toContain(deadLesson.id);
    expect(ids).toContain(dead2.id);
  });

  it("respects a custom ageFloorMs", () => {
    // tooNewLesson is 1 day old; with a 0-day floor it SHOULD be selected.
    const result = selectRetirableLessons(
      [tooNewLesson],
      { now: fixedNowFn, ageFloorMs: 0 },
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.lesson.id).toBe(tooNewLesson.id);
  });

  it("reason string mentions the lesson age in days", () => {
    const result = selectRetirableLessons(
      [deadLesson],
      { now: fixedNowFn },
    );
    // Approximately 30 days — the reason should contain a number of days.
    expect(result[0]!.reason).toMatch(/\d+ days ago/);
  });

  it("uses DEFAULT_AGE_FLOOR_MS (14 days) when ageFloorMs is not specified", () => {
    // A lesson exactly 15 days old should be selected (past the 14-day default floor).
    const FIFTEEN_DAYS_MS = 15 * 24 * 60 * 60 * 1000;
    const fifteenDayOld = makeLesson({
      id: "01KV7FG0000000000000015DAY",
      learned_at: new Date(NOW_DATE.getTime() - FIFTEEN_DAYS_MS).toISOString(),
    });

    const result = selectRetirableLessons(
      [fifteenDayOld],
      { now: fixedNowFn },
    );
    expect(result).toHaveLength(1);
    expect(DEFAULT_AGE_FLOOR_MS).toBe(14 * 24 * 60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// AC1 — Briefing-assembly: proven-helpful lesson kept in view; frequent-but-
//         unhelpful lesson pushed out of the always-shown set.
// Story native:01KV7FHAER7497SWZVWMW8D53B
// ---------------------------------------------------------------------------

describe("AC1 — briefing-assembly: helpful vs frequent-but-unhelpful", () => {
  it("keeps the proven-helpful lesson in view and pushes out the frequent-but-unhelpful one", () => {
    // A role has 3 lessons; the briefing budget is 2.
    //
    // FREQUENT-BUT-UNHELPFUL:
    //   recalled 10 times (high use_count) but never followed by a clean
    //   finish (helpful_fire_count=0) → ratio = 0/10 = 0.00
    //
    // PROVEN-HELPFUL:
    //   recalled only 3 times but always preceded a clean finish
    //   (helpful_fire_count=3) → ratio = 3/3 = 1.00
    //
    // THIRD:
    //   recalled 5 times, helped 2 times → ratio = 2/5 = 0.40
    //
    // Expected always-shown set (budget=2): PROVEN-HELPFUL + THIRD.
    // FREQUENT-BUT-UNHELPFUL must be in overflow (pushed out).
    const frequentUnhelpful = makeLesson({
      id: "01KV0000000000000000000001",
      use_count: 10,
      helpful_fire_count: 0,
      last_used_at: "2026-06-10T00:00:00.000Z",
    });
    const provenHelpful = makeLesson({
      id: "01KV0000000000000000000002",
      use_count: 3,
      helpful_fire_count: 3,
      last_used_at: "2026-06-05T00:00:00.000Z",
    });
    const third = makeLesson({
      id: "01KV0000000000000000000003",
      use_count: 5,
      helpful_fire_count: 2,
    });

    const body = makeBody([frequentUnhelpful, provenHelpful, third]);
    const { topLessons, overflow } = rankLessons(body, 2);

    const topIds = topLessons.map((l) => l.id);
    const overflowIds = overflow.map((l) => l.id);

    // Proven-helpful lesson must be in the always-shown set.
    expect(topIds).toContain(provenHelpful.id);
    // Frequent-but-unhelpful lesson must be pushed out.
    expect(overflowIds).toContain(frequentUnhelpful.id);
  });
});

// ---------------------------------------------------------------------------
// AC2 — Tiebreaker: equally-helpful lessons keep their frequency/recency order.
// Story native:01KV7FHAER7497SWZVWMW8D53B
// ---------------------------------------------------------------------------

describe("AC2 — equally-helpful lessons retain frequency/recency order as tiebreaker", () => {
  it("when two lessons share the same helpfulness ratio, the more frequently and recently consulted one stays ahead", () => {
    // Both lessons have ratio 3/6 = 0.50.
    // RECENT has more use_count AND a more recent last_used_at → ranks first.
    // OLDER has the same ratio but less use_count → ranks second.
    const recent = makeLesson({
      id: "01KV0000000000000000000010",
      use_count: 6,
      helpful_fire_count: 3,
      last_used_at: "2026-06-15T00:00:00.000Z",
    });
    const older = makeLesson({
      id: "01KV0000000000000000000011",
      use_count: 4,
      helpful_fire_count: 2, // 2/4 = 0.50 — same ratio
      last_used_at: "2026-06-10T00:00:00.000Z",
    });

    // Mix in a third lesson with a DIFFERENT ratio so we are only testing
    // the tiebreaker between RECENT and OLDER, not the primary sort.
    const high = makeLesson({
      id: "01KV0000000000000000000012",
      use_count: 5,
      helpful_fire_count: 5, // ratio=1.0 — will rank first regardless
    });

    const body = makeBody([older, high, recent]); // shuffled
    const { topLessons } = rankLessons(body, 10);

    // high ranks first (ratio=1.0).
    expect(topLessons[0]!.id).toBe(high.id);
    // Among tied lessons (both ratio=0.50), RECENT beats OLDER on use_count/last_used_at.
    expect(topLessons[1]!.id).toBe(recent.id);
    expect(topLessons[2]!.id).toBe(older.id);
  });
});

// ---------------------------------------------------------------------------
// AC3 — Fairness: brand-new lesson with no track record is neutral, not buried.
// Story native:01KV7FHAER7497SWZVWMW8D53B
// ---------------------------------------------------------------------------

describe("AC3 — brand-new lesson with no track record is treated as neutral", () => {
  it("lessonHelpfulnessRatio returns 0.5 (neutral) when use_count is absent", () => {
    const brandNew = makeLesson({ id: "01KV0000000000000000000020" });
    expect(lessonHelpfulnessRatio(brandNew)).toBe(0.5);
  });

  it("lessonHelpfulnessRatio returns 0.5 (neutral) when use_count is 0", () => {
    const neverUsed = makeLesson({ id: "01KV0000000000000000000021", use_count: 0 });
    expect(lessonHelpfulnessRatio(neverUsed)).toBe(0.5);
  });

  it("does not bury a brand-new lesson beneath older lessons that have proven unhelpful", () => {
    // PROVEN-UNHELPFUL: recalled 5 times, helped 0 times → ratio = 0/5 = 0.00
    // BRAND-NEW: no track record → neutral 0.50
    // PROVEN-HELPFUL: recalled 2 times, helped 2 times → ratio = 2/2 = 1.00
    const provenUnhelpful = makeLesson({
      id: "01KV0000000000000000000030",
      use_count: 5,
      helpful_fire_count: 0,
    });
    const brandNew = makeLesson({
      id: "01KV0000000000000000000031",
      // No use_count — no track record.
    });
    const provenHelpful = makeLesson({
      id: "01KV0000000000000000000032",
      use_count: 2,
      helpful_fire_count: 2,
    });

    const body = makeBody([provenUnhelpful, brandNew, provenHelpful]);
    const { topLessons } = rankLessons(body, 10);

    // provenHelpful (1.00) should lead.
    expect(topLessons[0]!.id).toBe(provenHelpful.id);
    // brandNew (0.50 neutral) should rank ABOVE provenUnhelpful (0.00).
    const brandNewIdx = topLessons.findIndex((l) => l.id === brandNew.id);
    const unhelpfulIdx = topLessons.findIndex((l) => l.id === provenUnhelpful.id);
    expect(brandNewIdx).toBeLessThan(unhelpfulIdx);
  });
});
