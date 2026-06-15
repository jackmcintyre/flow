/**
 * Shared helper: read, parse, and validate the `dev-result.json` file written
 * by `recordDevLesson`.
 *
 * Mirrors `read-reviewer-result-file.ts` for the builder (generalist-dev) side.
 * Reuses `sanitiseRefForPathSegment` from the reviewer helper so the per-ref
 * directory segment is derived identically by both.
 *
 * Story native:01KTAWXSVFEDNRCZDNG76PJ1BD — builder lesson capture seam.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { sanitiseRefForPathSegment } from "./read-reviewer-result-file.js";
import type { Lesson } from "../schemas/story-retro.js";

/**
 * Shape of the per-ref `dev-result.json` file written (and updated) by
 * `recordDevLesson`. Unlike `reviewer-result.json` (pre-created by
 * `runReviewerSession`), this file is created on first write by
 * `recordDevLesson` — there is no prior mandatory dev-result writer.
 */
export interface DevResultFileShape {
  /** ULID of the run session that produced this file. */
  sessionUlid: string;
  /** Story ref (e.g. `"native:01HZ..."`). */
  ref: string;
  /** The single reusable lesson recorded by the dev, or absent when none was captured. */
  lesson?: Lesson;
}

/**
 * Deterministically derive the absolute path to a story's `dev-result.json`
 * within a session, namespaced per ref.
 *
 * Layout: `<targetRepoRoot>/.flow/state/sessions/<sessionUlid>/<sanitised-ref>/dev-result.json`.
 *
 * Mirrors `reviewerResultFilePath` so both helpers derive the session-dir path
 * identically (same `sanitiseRefForPathSegment` logic, same layout).
 */
export function devResultFilePath(
  targetRepoRoot: string,
  sessionUlid: string,
  ref: string,
): string {
  return path.join(
    targetRepoRoot,
    ".flow",
    "state",
    "sessions",
    sessionUlid,
    sanitiseRefForPathSegment(ref),
    "dev-result.json",
  );
}

/**
 * Read, parse, and validate the `dev-result.json` file written by
 * `recordDevLesson`. Returns `null` when the file is absent (ENOENT).
 * Throws a plain Error on malformed JSON.
 *
 * Unlike `readReviewerResultFile`, we do not have a strict shape validator
 * here — the file carries only `{ sessionUlid, ref, lesson? }` and the
 * caller (`readDevLesson`) extracts only the `lesson` field, so minimal
 * type-guard suffices.
 *
 * @param targetRepoRoot - Absolute path to the target repository root.
 * @param sessionUlid - ULID of the calling session.
 * @param ref - Story ref, used to derive the per-story result path.
 */
export async function readDevResultFile(
  targetRepoRoot: string,
  sessionUlid: string,
  ref: string,
): Promise<DevResultFileShape | null> {
  const filePath = devResultFilePath(targetRepoRoot, sessionUlid, ref);

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(
      `dev-result.json at ${filePath} contains invalid JSON. Cause: ${String(cause)}`,
    );
  }

  return parsed as DevResultFileShape;
}
