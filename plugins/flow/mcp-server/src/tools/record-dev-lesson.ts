/**
 * `recordDevLesson` MCP/CLI tool — Story native:01KTAWXSVFEDNRCZDNG76PJ1BD
 * (builder lesson capture — CAPTURE seam, parallel to `recordReviewerLesson`).
 *
 * The generalist-dev surfaces at most ONE reusable retro lesson per story.
 * When it does, it calls this tool exactly once — BEFORE emitting the handoff
 * phrase — to write (or update) the per-ref `dev-result.json` under the
 * session directory. The run's FORWARD half later reads the captured lesson
 * off that file and attaches it to the done manifest via `recordStoryRetro`,
 * before the merge gate runs.
 *
 * **Key difference from `recordReviewerLesson`:** there is no prior mandatory
 * writer for `dev-result.json` (unlike `reviewer-result.json` which is
 * pre-created by `runReviewerSession`). So `recordDevLesson` CREATES the file
 * when absent rather than throwing a MissingError — it is the sole writer.
 *
 * Behaviour:
 *   1. Validate `lesson` via `LessonSchema`. Throws
 *      `MalformedStoryRetroPayloadError` on failure.
 *   2. Read the EXISTING per-ref `dev-result.json` (if present). If absent,
 *      start from a fresh projection (create-on-first-call).
 *   3. MERGE only the `lesson` field onto the projection — never clobbering
 *      `sessionUlid`, `ref`, or any other field.
 *   4. Write back to the per-ref path via `atomicWriteFile`.
 *
 * **Fail-soft at the orchestration layer:** this tool itself fails loud on a
 * malformed lesson (a real validation bug), but the run invites the dev to
 * call it only OPTIONALLY and contains any failure so it never blocks the
 * build, the handoff, or the merge.
 *
 * **Idempotent:** merging the same lesson twice writes a byte-identical
 * projection.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { MalformedStoryRetroPayloadError } from "../errors.js";
import { atomicWriteFile } from "../lib/managed-fs.js";
import {
  devResultFilePath,
  readDevResultFile,
  type DevResultFileShape,
} from "../lib/read-dev-result-file.js";
import { LessonSchema } from "../schemas/story-retro.js";

export interface RecordDevLessonOptions {
  /** Absolute path to the target repository root. */
  targetRepoRoot: string;
  /** ULID of the calling (run) session. */
  sessionUlid: string;
  /** Story ref (e.g. `"native:01HZ..."`), used to derive the per-ref result path. */
  ref: string;
  /** The single reusable lesson — validated inside via `LessonSchema`. */
  lesson: unknown;
}

export interface RecordDevLessonResult {
  ok: true;
  ref: string;
  absPath: string;
}

/**
 * Merge one dev-surfaced lesson onto the per-ref `dev-result.json`, creating
 * the file if it does not yet exist.
 *
 * @returns `{ ok: true, ref, absPath }` — the ref and absolute path of the
 *   merged-into dev-result file.
 *
 * @throws {MalformedStoryRetroPayloadError} When `lesson` fails `LessonSchema`
 *   validation (closed-enum violation, missing `failure_class` on a `pitfall`,
 *   unknown key, etc.).
 */
export async function recordDevLesson(
  opts: RecordDevLessonOptions,
): Promise<RecordDevLessonResult> {
  const { targetRepoRoot, sessionUlid, ref, lesson } = opts;

  // Step 1: Validate the lesson against the ONE canonical schema. Map a Zod
  // failure to the same typed error recordStoryRetro raises, so callers see a
  // consistent boundary error for a bad lesson.
  const parsed = LessonSchema.safeParse(lesson);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const yamlPath = issue.path.length === 0 ? "(root)" : issue.path.join(".");
    throw new MalformedStoryRetroPayloadError({
      yamlPath,
      zodMessage: issue.message,
      schemaModule: "mcp-server/src/schemas/story-retro.ts",
    });
  }

  // Step 2: Read the EXISTING per-ref dev-result.json. Null → file not yet
  // created (the dev is calling this for the first time for this story/session).
  // Unlike recordReviewerLesson, we do NOT throw on null — we create instead.
  const existing = await readDevResultFile(targetRepoRoot, sessionUlid, ref);

  // Step 3: Build the merged projection. When no existing file was found, seed
  // the base fields so the file is consistent (same shape as ReviewerResultFileShape).
  const merged: DevResultFileShape = {
    sessionUlid,
    ref,
    ...(existing ?? {}),
    lesson: parsed.data,
  };

  // Step 4: Write to the per-ref path, creating intermediate directories if
  // the session directory does not yet exist.
  const absPath = devResultFilePath(targetRepoRoot, sessionUlid, ref);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await atomicWriteFile(absPath, JSON.stringify(merged, null, 2));

  return { ok: true, ref, absPath };
}
