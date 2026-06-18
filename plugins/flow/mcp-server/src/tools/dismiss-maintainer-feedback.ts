/**
 * `dismissMaintainerFeedback` MCP/CLI tool — Story
 * native:01KVDXX (surface-maintainer-findings-in-run).
 *
 * Operator-facing dismiss seam for the maintainer-only inbox. When a finding
 * surfaces in the `/flow:run` closing summary that the operator will NOT file
 * as a GitHub issue, they can dismiss it so it stops re-appearing in every
 * subsequent run's closing summary.
 *
 * Behaviour:
 *   1. Validate `id` is a 26-char Crockford base32 ULID (throws
 *      `InvalidMaintainerFeedbackIdError` on a malformed id — never silently
 *      no-ops on garbage input).
 *   2. Scan `.flow/maintainer-inbox/` (top level ONLY) for the active `.json`
 *      file whose name ends with `-<id>.json`. The filename is
 *      `<iso-ts-safe>-<id>.json`, so the trailing `-<id>.json` uniquely
 *      identifies one item.
 *   3. If found: ensure `.flow/maintainer-inbox/dismissed/` exists and MOVE the
 *      file there, preserving the filename. The file content is left intact —
 *      a dismiss is an ARCHIVE (move), not an edit or delete. Return
 *      `{ ok: true, dismissed: true, id, archivedPath }`.
 *   4. If no active file matches that id (already dismissed, or never existed):
 *      return `{ ok: true, dismissed: false, id, noop: true }`. Idempotent —
 *      dismissing the same id twice never throws.
 *
 * **Why `reviewMaintainerInbox` naturally ignores dismissed items:** that tool
 * filters its `readdir` to `.json` FILES at the inbox top level — a
 * `dismissed/` SUBDIRECTORY is never read as an item. Moving a file into
 * `dismissed/` therefore removes it from every future review without any change
 * to `reviewMaintainerInbox`.
 *
 * **Isolation guarantee:** the move touches ONLY `.flow/maintainer-inbox/`,
 * which is deliberately OUTSIDE `.flow/state/**` and every other canonical-fs
 * glob (see record-maintainer-feedback.ts). The team's live working state and
 * backlog are left completely unchanged.
 *
 * **Canonical-fs guard compliance:** the static guard forbids the raw rename
 * and write-shaped fs bindings outside the sanctioned write layers. The move
 * here is therefore implemented as read -> `atomicWriteFile` (the sanctioned
 * write seam) into `dismissed/` -> `fs.rm` of the original (delete is not a
 * banned binding), rather than a single raw directory rename syscall.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { atomicWriteFile } from "../lib/managed-fs.js";
import { InvalidMaintainerFeedbackIdError } from "../errors.js";

/**
 * Relative path (from `targetRepoRoot`) of the maintainer inbox directory.
 * Mirrors `record-maintainer-feedback.ts` so both tools agree on the location.
 */
const INBOX_SUBDIR = path.join(".flow", "maintainer-inbox");

/** Subdirectory under the inbox where dismissed items are archived. */
const DISMISSED_SUBDIR = "dismissed";

/** 26-char Crockford base32 ULID — same shape the item schema enforces. */
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export interface DismissMaintainerFeedbackOptions {
  /** Absolute path to the target repository root. */
  targetRepoRoot: string;
  /** The ULID of the inbox item to dismiss. */
  id: string;
}

export interface DismissMaintainerFeedbackResult {
  ok: true;
  /** `true` when an active item was found and moved into `dismissed/`. */
  dismissed: boolean;
  /** The id that was requested (echoed back). */
  id: string;
  /** Absolute path of the archived file (present only when `dismissed` is true). */
  archivedPath?: string;
  /** `true` when no active item matched the id (idempotent no-op). */
  noop?: boolean;
}

/**
 * Dismiss (archive) one stored maintainer-feedback item by id.
 *
 * @returns `{ ok: true, dismissed: true, id, archivedPath }` on a successful
 *   move, or `{ ok: true, dismissed: false, id, noop: true }` when no active
 *   item matched (already dismissed or never existed) — idempotent.
 *
 * @throws {InvalidMaintainerFeedbackIdError} When `id` is not a 26-char ULID.
 */
export async function dismissMaintainerFeedback(
  opts: DismissMaintainerFeedbackOptions,
): Promise<DismissMaintainerFeedbackResult> {
  const { targetRepoRoot, id } = opts;

  // Step 1: Validate the id at the boundary — refuse garbage rather than no-op.
  if (typeof id !== "string" || !ULID_PATTERN.test(id)) {
    throw new InvalidMaintainerFeedbackIdError({ id: String(id) });
  }

  const inboxDir = path.join(targetRepoRoot, INBOX_SUBDIR);

  // Step 2: Find the active top-level .json file ending in `-<id>.json`.
  let filenames: string[];
  try {
    filenames = await fs.readdir(inboxDir);
  } catch (err) {
    // ENOENT: inbox never created → nothing to dismiss (idempotent no-op).
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") {
      return { ok: true, dismissed: false, id, noop: true };
    }
    throw err;
  }

  const suffix = `-${id}.json`;
  const match = filenames.find(
    (f) => f.endsWith(suffix) && f.endsWith(".json"),
  );

  if (match === undefined) {
    // No active item with this id — already dismissed or never existed.
    return { ok: true, dismissed: false, id, noop: true };
  }

  // Step 3: Move the file into dismissed/ (read → atomicWrite → rm). The move
  // keeps the filename and the byte content intact.
  const sourcePath = path.join(inboxDir, match);
  const archivedPath = path.join(inboxDir, DISMISSED_SUBDIR, match);

  let contents: string;
  try {
    contents = await fs.readFile(sourcePath, "utf8");
  } catch (err) {
    // File disappeared between readdir and readFile — treat as already gone.
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") {
      return { ok: true, dismissed: false, id, noop: true };
    }
    throw err;
  }

  // atomicWriteFile creates parent dirs (including dismissed/) and writes
  // atomically. The destination is outside any canonical-fs glob, so the
  // plain atomic write is sufficient (no writeManagedFile context needed).
  await atomicWriteFile(archivedPath, contents);

  // Remove the original so the item no longer surfaces at the inbox top level.
  await fs.rm(sourcePath, { force: true });

  return { ok: true, dismissed: true, id, archivedPath };
}
