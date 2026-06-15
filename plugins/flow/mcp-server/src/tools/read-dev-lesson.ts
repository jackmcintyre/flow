/**
 * `readDevLesson` CLI read seam — Story native:01KTAWXSVFEDNRCZDNG76PJ1BD
 * (builder lesson capture — FORWARD half, read side).
 *
 * The drain's FORWARD step needs the lesson the dev captured (via
 * `recordDevLesson`) off the per-ref `dev-result.json`, so it can hand
 * it to `recordStoryRetro` and land it on the done manifest before the merge
 * gate runs. This is that read: a thin, read-only, idempotent seam over
 * `readDevResultFile` that returns ONLY the optional `lesson` field.
 *
 * Mirrors `readReviewerLesson` exactly in contract:
 *   - No dev-result.json (ENOENT → null)         → `{ lesson: null }`
 *   - A result file with no captured lesson        → `{ lesson: null }`
 *   - A result file carrying a lesson              → `{ lesson: <lesson> }`
 *
 * Never throws on a missing file (the happy path when the dev recorded no
 * lesson). A malformed result file (unexpected JSON structure) propagates as
 * a plain Error — the drain wraps this seam in the swallow/non-fatal variant
 * so even that never blocks the merge.
 */

import { readDevResultFile } from "../lib/read-dev-result-file.js";
import type { Lesson } from "../schemas/story-retro.js";

export interface ReadDevLessonOptions {
  /** Absolute path to the target repository root. */
  targetRepoRoot: string;
  /** ULID of the calling (drain) session. */
  sessionUlid: string;
  /** Story ref, used to derive the per-ref result path. */
  ref: string;
}

export interface ReadDevLessonResult {
  /** The captured lesson, or `null` when none was recorded / no file exists. */
  lesson: Lesson | null;
}

/**
 * Return the lesson captured on a story's `dev-result.json`, or `null`.
 *
 * Read-only; never throws on a missing file — returns `{ lesson: null }`.
 */
export async function readDevLesson(
  opts: ReadDevLessonOptions,
): Promise<ReadDevLessonResult> {
  const { targetRepoRoot, sessionUlid, ref } = opts;
  const existing = await readDevResultFile(targetRepoRoot, sessionUlid, ref);
  const lesson = (existing?.lesson ?? null) as Lesson | null;
  return { lesson };
}
