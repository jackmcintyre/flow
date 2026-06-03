/**
 * `recallLesson` tool — Story native:01KT6QEWY794ZY0DH6JHQFWG6V (original).
 * Updated in Story native:01KT6QSW4W7SMAHAT4EAKCCC65 to:
 *   - Increment `use_count` and stamp `last_used_at` on the recalled lesson.
 *   - Search the archived lesson store (`team/<role>/_archived/lessons.json`)
 *     when the lesson is not found in the live Knowledge section.
 *
 * Agents receive a compact one-line index of their role's lessons in their
 * briefing (built by `buildPersonaSpawnPrompt`). When an agent needs the full
 * body of a specific lesson, it calls this tool with the lesson id from the
 * index to retrieve the complete detail.
 *
 * Behaviour:
 *   1. Read the persona file at `<targetRepoRoot>/team/<role>/PERSONA.md` via
 *      `readPersona` (throws `PersonaFileNotFoundError` when absent).
 *   2. Parse the `## Knowledge` section via `parseKnowledgeSection` to extract
 *      all lessons including their stable ids.
 *   3a. If found in the live store: increment `use_count`, stamp `last_used_at`,
 *       write back via `updateLessonUsageInPersona`, return the full body.
 *   3b. If NOT found in the live store: search the role's archived lesson store
 *       (`team/<role>/_archived/lessons.json`). If found there, return the full
 *       body (archived lessons are NOT modified — no usage tracking on archive).
 *   4. If no entry matches in either store, return `{ found: false }`.
 *
 * (Story native:01KT6QEWY794ZY0DH6JHQFWG6V AC2,
 *  Story native:01KT6QSW4W7SMAHAT4EAKCCC65 AC2)
 */

import { readPersona } from "./read-persona.js";
import { parseKnowledgeSection } from "../lib/parse-knowledge-section.js";
import {
  readArchivedLessons,
} from "../lib/lesson-archive.js";
import { updateLessonUsageInPersona } from "../lib/update-knowledge-section.js";

export interface RecallLessonOptions {
  /** Absolute path to the target repository root. */
  targetRepoRoot: string;
  /** The role whose persona to read (kebab-case, e.g. `"generalist-dev"`). */
  role: string;
  /** The stable ULID id of the lesson from the index in the agent's briefing. */
  id: string;
  /**
   * Injectable clock for deterministic tests.
   * Defaults to `() => new Date()`.
   */
  now?: () => Date;
}

export type RecallLessonResult =
  | {
      found: true;
      id: string;
      kind: "pitfall" | "pattern" | "tool-quirk" | "discipline";
      applies_when: string;
      detail: string;
      source_ref?: string;
      /** True when the lesson was found in the archived store (not live). */
      from_archive: boolean;
    }
  | { found: false };

/**
 * Return the full body of one lesson by id from a role's Knowledge section
 * or archived lesson store.
 *
 * Increments `use_count` and stamps `last_used_at` when the lesson is found
 * in the live store. Archived lessons are returned as-is (read-only).
 *
 * @throws {PersonaFileNotFoundError} When the persona file is absent.
 * @throws {PersonaFileMalformedError} When the persona file fails the parser.
 */
export async function recallLesson(opts: RecallLessonOptions): Promise<RecallLessonResult> {
  const { targetRepoRoot, role, id } = opts;
  const now = opts.now ?? (() => new Date());

  // -------------------------------------------------------------------------
  // Step 1 + 2: Read persona and parse live Knowledge section.
  // -------------------------------------------------------------------------
  const persona = await readPersona({ targetRepoRoot, role });
  const liveLessons = parseKnowledgeSection(persona.sections["Knowledge"]);

  const liveMatch = liveLessons.find((l) => l.id === id);
  if (liveMatch !== undefined) {
    // -----------------------------------------------------------------------
    // Step 3a: Found in live store — increment usage and write back.
    // -----------------------------------------------------------------------
    const newUseCount = liveMatch.use_count + 1;
    const newLastUsedAt = now().toISOString();

    await updateLessonUsageInPersona(
      targetRepoRoot,
      role,
      id,
      newUseCount,
      newLastUsedAt,
    );

    return {
      found: true,
      id: liveMatch.id,
      kind: liveMatch.kind,
      applies_when: liveMatch.applies_when,
      detail: liveMatch.detail,
      ...(liveMatch.source_ref !== undefined ? { source_ref: liveMatch.source_ref } : {}),
      from_archive: false,
    };
  }

  // -------------------------------------------------------------------------
  // Step 3b: Not in live store — search the archived store.
  // -------------------------------------------------------------------------
  const archivedLessons = await readArchivedLessons(targetRepoRoot, role);
  const archivedMatch = archivedLessons.find((l) => l.id === id);

  if (archivedMatch !== undefined) {
    // Archived lessons are returned verbatim (no usage tracking on archive).
    return {
      found: true,
      id: archivedMatch.id,
      kind: archivedMatch.kind,
      applies_when: archivedMatch.applies_when,
      detail: archivedMatch.detail,
      ...(archivedMatch.source_ref !== undefined
        ? { source_ref: archivedMatch.source_ref }
        : {}),
      from_archive: true,
    };
  }

  // -------------------------------------------------------------------------
  // Step 4: Not found anywhere.
  // -------------------------------------------------------------------------
  return { found: false };
}
