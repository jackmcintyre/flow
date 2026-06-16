/**
 * Lesson ranking, budget cap, and archive helpers.
 *
 * Stories:
 *  - native:01KT6QSW4W7SMAHAT4EAKCCC65 — original ranking + archive.
 *  - native:01KV7FHAER7497SWZVWMW8D53B — helpfulness-first ranking.
 *
 * This module provides three concerns:
 *
 *   1. **Ranking** — `rankLessons(body, budget)` parses structured lesson
 *      blocks from a Knowledge section, orders them by proven helpfulness
 *      (`helpful_fire_count / use_count`) descending first, then by `use_count`
 *      descending then `last_used_at` descending as tiebreakers, and returns
 *      the top-budgeted "always-shown" set plus the overflow that should be
 *      demoted. Lessons with no track record (`use_count` absent or 0) are
 *      treated as neutral (ratio = 0.5) — neither auto-promoted nor buried.
 *
 *   2. **Demotion** — `demoteLessonsFromBody(body, overflowIds)` removes the
 *      overflow lessons from the live Knowledge body. The caller is responsible
 *      for writing the demoted lessons to the archived store — see below.
 *
 *   3. **Archive-store write** — `archiveLessons(targetRepoRoot, role, lessons,
 *      now, deps)` writes each demoted lesson to the role's per-lesson archived
 *      store at `team/<role>/_archived/<id>.json`, adding an `archived_at`
 *      timestamp. Nothing is ever permanently deleted; the archived store is an
 *      append-only graveyard of demoted lessons.
 *
 * ## Why a separate archive store?
 *
 * The live PERSONA.md Knowledge section is the always-shown index. Archived
 * lessons are written to `team/<role>/_archived/<id>.json` rather than back
 * into PERSONA.md because:
 *  - We don't want the persona file to grow unboundedly.
 *  - Archived lessons remain retrievable by id (AC2 search path in
 *    `recallLesson`).
 *  - The `_archived/` convention mirrors the skill-archive layout already in
 *    `apply-skill-proposal.ts`.
 *
 * ## No permanent deletion
 *
 * Demoted lessons are NEVER deleted. Once a lesson is in the archived store it
 * stays there. A future story could re-promote an archived lesson back into the
 * live index, but that is out of scope for this story.
 *
 * ## Clock seam
 *
 * All callers that need the current timestamp receive an injectable `now`
 * function defaulting to `() => new Date()`. This keeps the logic
 * deterministically testable.
 *
 * (Story native:01KT6QSW4W7SMAHAT4EAKCCC65 — FR AC1, AC3)
 */

import * as path from "node:path";
import { writeManagedFile } from "./managed-fs.js";

// ---------------------------------------------------------------------------
// Lesson block constants (mirrors build-persona-spawn-prompt.ts)
// ---------------------------------------------------------------------------

export const LESSON_BLOCK_PREFIX = "<!-- lesson:json ";
export const LESSON_BLOCK_SUFFIX = " -->";

/** Default briefing budget — the maximum number of lessons shown in a briefing. */
export const DEFAULT_BRIEFING_BUDGET = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A structured lesson parsed from the Knowledge section, with optional
 * usage tracking fields (`use_count`, `last_used_at`, `helpful_fire_count`)
 * added progressively.
 *
 * `helpful_fire_count` tracks how many times this lesson's use went
 * hand-in-hand with work landing cleanly (a READY FOR MERGE verdict in the
 * same story flow). It is the numerator in the per-lesson helpfulness ratio;
 * `use_count` is the denominator.
 *
 * Lessons with no track record (use_count absent or 0) are treated as
 * neutral — neither auto-promoted nor auto-buried (see `lessonHelpfulnessRatio`).
 */
export interface ParsedLesson {
  id: string;
  kind: string;
  applies_when: string;
  detail: string;
  learned_at: string;
  /** How many times an agent recalled this lesson via `recallLesson`. */
  use_count?: number;
  /** ISO-8601 timestamp of the most recent `recallLesson` call for this lesson. */
  last_used_at?: string;
  /**
   * How many of those recalls were followed by a READY FOR MERGE verdict in
   * the same story flow — the "proven helpful" counter.
   *
   * Story native:01KV7FHAER7497SWZVWMW8D53B.
   */
  helpful_fire_count?: number;
  /** Optional pitfall failure class. */
  failure_class?: string;
  /** Optional source story ref. */
  source_ref?: string;
  /** Optional source PR URL. */
  source_pr?: string;
}

/**
 * An archived lesson — same as `ParsedLesson` but with a required
 * `archived_at` timestamp added at demotion time.
 */
export interface ArchivedLesson extends ParsedLesson {
  archived_at: string;
}

/** Result of `rankLessons`. */
export interface RankedLessons {
  /** Top-budgeted lessons to keep in the always-shown index. */
  topLessons: ParsedLesson[];
  /** Lessons beyond the budget, ordered (most deserving of demotion last). */
  overflow: ParsedLesson[];
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Extract all structured lesson blocks from a Knowledge section body.
 * Skips malformed JSON blocks silently (mirrors `findLessonById` behaviour).
 *
 * Exported for unit testing.
 */
export function extractLessonsFromBody(body: string): ParsedLesson[] {
  const lessons: ParsedLesson[] = [];

  for (const line of body.split("\n")) {
    const trimmed = line.trimStart();

    if (
      !trimmed.startsWith(LESSON_BLOCK_PREFIX) ||
      !trimmed.endsWith(LESSON_BLOCK_SUFFIX)
    ) {
      continue;
    }

    const jsonStr = trimmed
      .slice(LESSON_BLOCK_PREFIX.length, trimmed.length - LESSON_BLOCK_SUFFIX.length)
      .trim();

    let raw: unknown;
    try {
      raw = JSON.parse(jsonStr);
    } catch {
      continue;
    }

    if (
      raw === null ||
      typeof raw !== "object" ||
      !("id" in raw) ||
      !("kind" in raw) ||
      !("applies_when" in raw) ||
      !("detail" in raw) ||
      !("learned_at" in raw)
    ) {
      continue;
    }

    const obj = raw as Record<string, unknown>;
    if (
      typeof obj["id"] !== "string" ||
      typeof obj["kind"] !== "string" ||
      typeof obj["applies_when"] !== "string" ||
      typeof obj["detail"] !== "string" ||
      typeof obj["learned_at"] !== "string"
    ) {
      continue;
    }

    const lesson: ParsedLesson = {
      id: obj["id"] as string,
      kind: obj["kind"] as string,
      applies_when: obj["applies_when"] as string,
      detail: obj["detail"] as string,
      learned_at: obj["learned_at"] as string,
    };

    if (typeof obj["use_count"] === "number") {
      lesson.use_count = obj["use_count"] as number;
    }
    if (typeof obj["last_used_at"] === "string") {
      lesson.last_used_at = obj["last_used_at"] as string;
    }
    if (typeof obj["helpful_fire_count"] === "number") {
      lesson.helpful_fire_count = obj["helpful_fire_count"] as number;
    }
    if (typeof obj["failure_class"] === "string") {
      lesson.failure_class = obj["failure_class"] as string;
    }
    if (typeof obj["source_ref"] === "string") {
      lesson.source_ref = obj["source_ref"] as string;
    }
    if (typeof obj["source_pr"] === "string") {
      lesson.source_pr = obj["source_pr"] as string;
    }

    lessons.push(lesson);
  }

  return lessons;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * Derive the per-lesson helpfulness ratio for ranking purposes.
 *
 * The ratio measures how often a lesson's recall went hand-in-hand with work
 * landing cleanly (READY FOR MERGE), using `helpful_fire_count / use_count`.
 *
 * Deliberate default for lessons with no track record yet (AC3):
 *   - If `use_count` is 0 or absent, we cannot compute a meaningful ratio.
 *     We return 0.5 (neutral) so new lessons are neither auto-promoted above
 *     proven helpers nor auto-buried beneath them purely for lack of history.
 *     The existing frequency/recency tiebreaker then decides their relative
 *     position among equally-neutral lessons.
 *
 * Exported for unit testing.
 *
 * Story native:01KV7FHAER7497SWZVWMW8D53B.
 */
export function lessonHelpfulnessRatio(lesson: ParsedLesson): number {
  const uses = lesson.use_count ?? 0;
  if (uses === 0) {
    // No track record — neutral, not worst-case (AC3).
    return 0.5;
  }
  return (lesson.helpful_fire_count ?? 0) / uses;
}

/**
 * Compare two lessons for ranking:
 *
 *   1. Proven helpfulness descending (`helpful_fire_count / use_count`).
 *      Lessons with no track record are treated as neutral (ratio = 0.5),
 *      so they are neither auto-promoted nor auto-buried (AC3).
 *   2. use_count descending (frequency — existing tiebreaker, AC2).
 *   3. last_used_at descending (recency — existing tiebreaker, AC2).
 *   4. learned_at descending (newest lesson first — final tiebreaker, AC2).
 *
 * Story native:01KV7FHAER7497SWZVWMW8D53B — primary order changed from
 * use_count to proven helpfulness; frequency/recency retained as tiebreaker.
 */
function compareLessons(a: ParsedLesson, b: ParsedLesson): number {
  // Primary: proven helpfulness descending.
  const aRatio = lessonHelpfulnessRatio(a);
  const bRatio = lessonHelpfulnessRatio(b);
  if (bRatio !== aRatio) return bRatio - aRatio;

  // Tiebreaker 1: use_count descending.
  const aCount = a.use_count ?? 0;
  const bCount = b.use_count ?? 0;
  if (bCount !== aCount) return bCount - aCount;

  // Tiebreaker 2: last_used_at descending (most recently used first).
  const aUsed = a.last_used_at ?? "1970-01-01T00:00:00.000Z";
  const bUsed = b.last_used_at ?? "1970-01-01T00:00:00.000Z";
  if (bUsed !== aUsed) return bUsed > aUsed ? 1 : -1;

  // Final tiebreaker: learned_at descending (newer lesson preferred).
  return b.learned_at > a.learned_at ? 1 : -1;
}

/**
 * Rank the structured lessons from a Knowledge section body and apply the
 * budget cap. Returns the top-budgeted lessons (always-shown) and the
 * overflow to demote.
 *
 * Primary order: proven helpfulness (`helpful_fire_count / use_count`) descending.
 * Tiebreaker: use_count descending, then last_used_at descending, then learned_at descending.
 * Lessons with no track record are treated as neutral (ratio = 0.5).
 *
 * When `body` has fewer lessons than `budget`, all lessons are in `topLessons`
 * and `overflow` is empty.
 *
 * Exported for unit testing.
 */
export function rankLessons(
  body: string,
  budget: number = DEFAULT_BRIEFING_BUDGET,
): RankedLessons {
  const all = extractLessonsFromBody(body);
  const sorted = [...all].sort(compareLessons);
  const topLessons = sorted.slice(0, budget);
  const overflow = sorted.slice(budget);
  return { topLessons, overflow };
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

/**
 * Serialise a `ParsedLesson` (or a subset of its fields) as the `<!-- lesson:json ... -->`
 * format used in the Knowledge section.
 *
 * Only fields with defined values are included. Preserves the usage-tracking
 * fields `use_count` and `last_used_at` if present.
 *
 * Exported for unit testing (mirrors `serialiseStructuredLesson` in
 * apply-persona-append.ts, but also handles use_count/last_used_at).
 */
export function serialiseLessonBlock(lesson: ParsedLesson): string {
  const obj: Record<string, string | number> = {
    id: lesson.id,
    kind: lesson.kind,
    applies_when: lesson.applies_when,
    detail: lesson.detail,
    learned_at: lesson.learned_at,
  };
  if (lesson.use_count !== undefined) obj["use_count"] = lesson.use_count;
  if (lesson.last_used_at !== undefined) obj["last_used_at"] = lesson.last_used_at;
  if (lesson.helpful_fire_count !== undefined) obj["helpful_fire_count"] = lesson.helpful_fire_count;
  if (lesson.failure_class !== undefined) obj["failure_class"] = lesson.failure_class;
  if (lesson.source_ref !== undefined) obj["source_ref"] = lesson.source_ref;
  if (lesson.source_pr !== undefined) obj["source_pr"] = lesson.source_pr;
  return `${LESSON_BLOCK_PREFIX}${JSON.stringify(obj)}${LESSON_BLOCK_SUFFIX}`;
}

// ---------------------------------------------------------------------------
// Live-body demotion
// ---------------------------------------------------------------------------

/**
 * Remove lessons with the given ids from a Knowledge section body.
 *
 * Only lesson block lines are removed; flat-bullet lines, blank lines, and
 * other text are preserved. The returned body has any trailing blank lines
 * collapsed to a single trailing newline.
 *
 * Exported for unit testing.
 */
export function demoteLessonsFromBody(
  body: string,
  overflowIds: Set<string>,
): string {
  if (overflowIds.size === 0) return body;

  const keptLines: string[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trimStart();
    if (
      trimmed.startsWith(LESSON_BLOCK_PREFIX) &&
      trimmed.endsWith(LESSON_BLOCK_SUFFIX)
    ) {
      const jsonStr = trimmed
        .slice(LESSON_BLOCK_PREFIX.length, trimmed.length - LESSON_BLOCK_SUFFIX.length)
        .trim();
      try {
        const raw = JSON.parse(jsonStr) as unknown;
        if (
          raw !== null &&
          typeof raw === "object" &&
          "id" in raw &&
          typeof (raw as Record<string, unknown>)["id"] === "string"
        ) {
          const id = (raw as Record<string, unknown>)["id"] as string;
          if (overflowIds.has(id)) continue; // Demote — skip this line.
        }
      } catch {
        // Malformed block — keep it (don't demote something we can't parse).
      }
    }
    keptLines.push(line);
  }

  return keptLines.join("\n");
}

// ---------------------------------------------------------------------------
// Archive-store write
// ---------------------------------------------------------------------------

/** Tool name threaded into managed-fs for the archived lesson write. */
const ARCHIVE_TOOL_NAME = "buildPersonaSpawnPrompt";

/**
 * Write each demoted lesson to the role's archived lesson store at
 * `team/<role>/_archived/<id>.json`, adding an `archived_at` timestamp.
 *
 * The file is written as a single JSON object (not JSONL). If the file already
 * exists it is overwritten — this is idempotent since the same overflow set is
 * produced on every briefing assembly until the lesson is removed from the live
 * store.
 *
 * @param targetRepoRoot - Absolute path to the target repo root.
 * @param role           - The role whose archived store to write to.
 * @param lessons        - The lessons to archive.
 * @param now            - Injectable clock seam.
 * @param role           - The role for managed-fs context.
 */
export async function archiveLessons(
  targetRepoRoot: string,
  role: string,
  lessons: ParsedLesson[],
  now: () => Date = () => new Date(),
): Promise<string[]> {
  const changedPaths: string[] = [];
  const archivedAt = now().toISOString();

  for (const lesson of lessons) {
    const archived: ArchivedLesson = { ...lesson, archived_at: archivedAt };
    const relPath = `team/${role}/_archived/${lesson.id}.json`;
    const absPath = path.join(targetRepoRoot, relPath);

    await writeManagedFile({
      absPath,
      contents: JSON.stringify(archived, null, 2) + "\n",
      targetRepoRoot,
      mcpToolContext: { toolName: ARCHIVE_TOOL_NAME, role },
    });

    changedPaths.push(relPath);
  }

  return changedPaths;
}

// ---------------------------------------------------------------------------
// Ranked body rebuild (used by buildPersonaSpawnPrompt when lessons are demoted)
// ---------------------------------------------------------------------------

/**
 * Rebuild the Knowledge section body from the ranked top-lessons list.
 *
 * The body is reconstructed in ranked order (most-useful lessons first):
 *  1. Ranked top-lesson blocks are written in ranked order.
 *  2. Non-lesson lines (flat bullets, blank lines, other text) from the
 *     original body are preserved and appended AFTER the ranked blocks.
 *
 * This ensures the always-shown index is ordered by proven helpfulness desc /
 * use_count desc / last_used_at desc as required by AC1.
 *
 * Exported for unit testing.
 */
export function rebuildBodyWithTopLessons(
  originalBody: string,
  topLessons: ParsedLesson[],
): string {
  const nonLessonLines: string[] = [];

  // Collect only NON-lesson lines from the original body (flat bullets, blank
  // lines, other text). ALL structured lesson blocks are skipped here — top
  // lessons will be re-emitted in ranked order below; overflow lessons are
  // excluded entirely.
  for (const line of originalBody.split("\n")) {
    const trimmed = line.trimStart();
    if (
      trimmed.startsWith(LESSON_BLOCK_PREFIX) &&
      trimmed.endsWith(LESSON_BLOCK_SUFFIX)
    ) {
      const jsonStr = trimmed
        .slice(LESSON_BLOCK_PREFIX.length, trimmed.length - LESSON_BLOCK_SUFFIX.length)
        .trim();
      try {
        const raw = JSON.parse(jsonStr) as unknown;
        if (
          raw !== null &&
          typeof raw === "object" &&
          "id" in raw &&
          typeof (raw as Record<string, unknown>)["id"] === "string"
        ) {
          // Parseable structured lesson block — skip from nonLessonLines.
          // Top lessons are re-added in ranked order; overflow lessons are dropped.
          continue;
        }
      } catch {
        // Malformed lesson-block-shaped line — preserve as a non-lesson line.
      }
    }
    nonLessonLines.push(line);
  }

  // Build the ranked blocks (top lessons in ranked order).
  const rankedBlocks = topLessons.map(serialiseLessonBlock);

  // Trim trailing blank lines from nonLessonLines to avoid a double-blank at
  // the boundary between ranked blocks and non-lesson content.
  while (nonLessonLines.length > 0 && nonLessonLines[nonLessonLines.length - 1]!.trim() === "") {
    nonLessonLines.pop();
  }

  const parts: string[] = [...rankedBlocks];
  if (nonLessonLines.length > 0) {
    parts.push(...nonLessonLines);
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Retirement selector (Story native:01KV7FGDTQ8FSJ2EEPHHGK0KRQ)
// ---------------------------------------------------------------------------

/**
 * A lesson flagged by `selectRetirableLessons` as a candidate for retirement.
 * Carries the lesson itself plus a human-readable reason string so the retro
 * analyst can emit it verbatim in the proposal rationale.
 */
export interface RetirableLessonCandidate {
  lesson: ParsedLesson;
  /** One-sentence explanation of why this lesson earned no keep. */
  reason: string;
}

/**
 * Options for `selectRetirableLessons`.
 *
 * @param now            - Injectable clock seam (default: real Date).
 * @param ageFloorMs     - Minimum age in milliseconds a lesson must be before it
 *                         can be retired. Prevents brand-new lessons from being
 *                         flagged prematurely (default: 14 days).
 * @param cycleCount     - How many cycles (for the "never tied to a good outcome
 *                         over several cycles" wording in the rationale).
 *                         Informational only — does not affect the selection
 *                         logic beyond what `ageFloorMs` already encodes.
 */
export interface SelectRetirableLessonsOptions {
  /** Injectable clock seam. Default: `() => new Date()`. */
  now?: () => Date;
  /**
   * Minimum lesson age in milliseconds before it is eligible for retirement.
   * Default: 14 days (1_209_600_000 ms).
   */
  ageFloorMs?: number;
  /**
   * How many cycles the age floor roughly represents (for rationale wording).
   * Default: 3.
   */
  cycleCount?: number;
}

/** Default age floor: 14 days. */
export const DEFAULT_AGE_FLOOR_MS = 14 * 24 * 60 * 60 * 1000;

/** Default cycle count used in rationale wording. */
const DEFAULT_CYCLE_COUNT = 3;

/**
 * Select lessons that have never earned their keep and are old enough to have
 * had a fair chance to do so.
 *
 * A lesson is retirable when ALL of the following are true:
 *   1. `use_count` is 0 or absent — never recalled by any agent.
 *   2. `last_used_at` is absent — never recalled (double-check guard).
 *   3. `learned_at` predates `now - ageFloorMs` — old enough to have been used.
 *
 * "Tied to a good outcome" is encoded via the existing provenance fields:
 * `source_ref` and `source_pr` record where the lesson was authored but do NOT
 * constitute a "good outcome" signal by themselves (every lesson has provenance;
 * the learning loop does not yet write a `good_outcome` boolean onto lesson
 * blocks). The functional signal for "earned keep" is **recall** — if a lesson
 * was recalled (`use_count > 0` or `last_used_at` present), it earned its keep.
 * This matches the story's definition ("never recalled and never tied to a good
 * outcome"), since recall IS the proxy for "tied to a good outcome" in this
 * version of the signal.
 *
 * Lessons with a `use_count` of 0 AND no `last_used_at` AND old enough are
 * selected. Brand-new lessons (within `ageFloorMs`) are excluded so a newly
 * recorded lesson is not immediately flagged.
 *
 * This function is **pure** and **clock-injectable** for deterministic testing.
 * It does NOT read the filesystem.
 *
 * Exported for unit testing.
 */
export function selectRetirableLessons(
  lessons: ParsedLesson[],
  opts: SelectRetirableLessonsOptions = {},
): RetirableLessonCandidate[] {
  const {
    now = () => new Date(),
    ageFloorMs = DEFAULT_AGE_FLOOR_MS,
    cycleCount = DEFAULT_CYCLE_COUNT,
  } = opts;

  const currentMs = now().getTime();
  const candidates: RetirableLessonCandidate[] = [];

  for (const lesson of lessons) {
    // 1. Has it ever been recalled?
    const useCount = lesson.use_count ?? 0;
    if (useCount > 0) {
      continue; // Earned its keep via recall.
    }

    // 2. Does it have a last_used_at? (belt-and-suspenders guard)
    if (lesson.last_used_at !== undefined) {
      continue; // Earned its keep via recall.
    }

    // 3. Is it old enough to have had a fair chance?
    let learnedAtMs: number;
    try {
      learnedAtMs = Date.parse(lesson.learned_at);
    } catch {
      // Unparseable learned_at — skip (don't retire something we can't date).
      continue;
    }
    if (isNaN(learnedAtMs)) {
      continue; // Unparseable date — skip.
    }
    if (currentMs - learnedAtMs < ageFloorMs) {
      continue; // Too new — give it more time.
    }

    const ageMs = currentMs - learnedAtMs;
    const ageDays = Math.round(ageMs / (24 * 60 * 60 * 1000));
    const reason =
      `Never recalled and never tied to a good outcome over ${cycleCount} cycles ` +
      `(learned ${ageDays} days ago, use_count=0, last_used_at absent).`;

    candidates.push({ lesson, reason });
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Archived-store lookup (used by recallLesson fallback path)
// ---------------------------------------------------------------------------

/**
 * Look up a lesson by id in the role's archived lesson store.
 *
 * Reads `team/<role>/_archived/<id>.json` if it exists and returns the parsed
 * `ArchivedLesson`, or `null` when absent (soft miss — not an error).
 *
 * Pure read: no writes.
 */
import { promises as fs } from "node:fs";

export async function findArchivedLessonById(
  targetRepoRoot: string,
  role: string,
  id: string,
): Promise<ArchivedLesson | null> {
  const absPath = path.join(targetRepoRoot, "team", role, "_archived", `${id}.json`);
  let raw: string;
  try {
    raw = await fs.readFile(absPath, "utf8");
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "ENOENT"
    ) {
      return null;
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // Silently ignore malformed archive files.
  }

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("id" in parsed) ||
    !("kind" in parsed) ||
    !("applies_when" in parsed) ||
    !("detail" in parsed) ||
    !("learned_at" in parsed) ||
    !("archived_at" in parsed)
  ) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj["id"] !== "string" ||
    typeof obj["kind"] !== "string" ||
    typeof obj["applies_when"] !== "string" ||
    typeof obj["detail"] !== "string" ||
    typeof obj["learned_at"] !== "string" ||
    typeof obj["archived_at"] !== "string"
  ) {
    return null;
  }

  const archived: ArchivedLesson = {
    id: obj["id"] as string,
    kind: obj["kind"] as string,
    applies_when: obj["applies_when"] as string,
    detail: obj["detail"] as string,
    learned_at: obj["learned_at"] as string,
    archived_at: obj["archived_at"] as string,
  };

  if (typeof obj["use_count"] === "number") archived.use_count = obj["use_count"] as number;
  if (typeof obj["last_used_at"] === "string") archived.last_used_at = obj["last_used_at"] as string;
  if (typeof obj["helpful_fire_count"] === "number") archived.helpful_fire_count = obj["helpful_fire_count"] as number;
  if (typeof obj["failure_class"] === "string") archived.failure_class = obj["failure_class"] as string;
  if (typeof obj["source_ref"] === "string") archived.source_ref = obj["source_ref"] as string;
  if (typeof obj["source_pr"] === "string") archived.source_pr = obj["source_pr"] as string;

  return archived;
}
