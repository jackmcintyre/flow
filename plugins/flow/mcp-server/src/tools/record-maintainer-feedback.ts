/**
 * `recordMaintainerFeedback` MCP/CLI tool — Story native:01KV7FHZ41Z6CFPABW1B8J38BV.
 *
 * Capture seam for structured maintainer-feedback items. Any role on the team
 * (or the retrospective) can call this when it hits a structural limitation of
 * the tool itself. Each item describes:
 *   - `problem`            — What is wrong / what structural limitation was hit.
 *   - `tool_area`          — Which part of the tool the problem concerns.
 *   - `trigger`            — What surfaced it (role / phase / story).
 *   - `suggested_direction`— Optional: a concrete suggestion for how to fix it.
 *
 * Behaviour:
 *   1. Validate `item` via `parseMaintainerFeedbackInput` (throws
 *      `MalformedMaintainerFeedbackError` on failure — AC2).
 *   2. Stamp provenance: mint a ULID `id` and an ISO-8601 UTC `raised_at` timestamp.
 *   3. Write the complete item as a single JSON file under
 *      `.flow/maintainer-inbox/<raised_at_ts>-<id>.json` via `atomicWriteFile` so
 *      items ACCUMULATE as distinct entries rather than overwriting one another (AC3).
 *   4. Return `{ ok: true, id, absPath }`.
 *
 * **Isolation guarantee (AC1):** the write touches ONLY `.flow/maintainer-inbox/`.
 * That path is NOT in `CANONICAL_PATH_GLOBS` (`.flow/state/**`, `.flow/telemetry/**`,
 * etc.) — `atomicWriteFile` is sufficient and `writeManagedFile` is not required
 * here. The team's live working state and backlog are left completely unchanged.
 *
 * **Fail-closed validation (AC2):** `parseMaintainerFeedbackInput` is strict —
 * missing `problem`, `tool_area`, or `trigger` throws rather than storing an
 * incomplete item. Every item in the inbox is self-contained.
 *
 * **Accumulation (AC3):** one file per item, keyed by `<iso-ts>-<ulid>.json`.
 * Items are never merged or overwritten; the inbox grows monotonically until
 * a maintainer reviews and acts on it.
 *
 * **Out of scope:** surfacing the inbox to the maintainer, and turning an item
 * into a pre-filled GitHub issue, are follow-on stories (deliberately NOT here).
 */

import * as path from "node:path";
import { ulid } from "ulid";
import { atomicWriteFile } from "../lib/managed-fs.js";
import {
  parseMaintainerFeedbackInput,
} from "../schemas/maintainer-feedback.js";
import type { MaintainerFeedbackItem } from "../schemas/maintainer-feedback.js";

export interface RecordMaintainerFeedbackOptions {
  /** Absolute path to the target repository root. */
  targetRepoRoot: string;
  /**
   * The raw feedback item payload — validated inside via
   * `parseMaintainerFeedbackInput`. Must include `problem`, `tool_area`,
   * and `trigger`; `suggested_direction` is optional.
   */
  item: unknown;
}

export interface RecordMaintainerFeedbackResult {
  ok: true;
  /** The ULID minted for this item — uniquely identifies it in the inbox. */
  id: string;
  /** Absolute path of the written inbox entry. */
  absPath: string;
}

/**
 * Relative path (from `targetRepoRoot`) of the maintainer inbox directory.
 *
 * Deliberately outside `.flow/state/**`, `.flow/telemetry/**`, and any other
 * canonical-glob path so `atomicWriteFile` can write here without a
 * `writeManagedFile` context guard. The team never reads this directory to
 * drive its own behaviour — it is a write-once accumulator for the maintainer.
 */
const INBOX_SUBDIR = path.join(".flow", "maintainer-inbox");

/**
 * Derive the inbox file path for a given item (deterministic from provenance).
 *
 * Filename: `<iso-ts-safe>-<ulid>.json`. ISO-8601 colons are replaced with
 * hyphens so the filename is safe on all filesystems. Alphabetical sort of
 * the directory will produce chronological order (ISO prefixes sort correctly
 * after the colon replacement).
 */
export function maintainerInboxItemPath(
  targetRepoRoot: string,
  id: string,
  raisedAt: string,
): string {
  // Replace colons and periods with hyphens for filesystem safety.
  const safeTs = raisedAt.replace(/[:.]/g, "-");
  const filename = `${safeTs}-${id}.json`;
  return path.join(targetRepoRoot, INBOX_SUBDIR, filename);
}

/**
 * Record a structured maintainer-feedback item into the maintainer-only inbox.
 *
 * @returns `{ ok: true, id, absPath }` — the minted ULID and absolute path of
 *   the written inbox entry.
 *
 * @throws {MalformedMaintainerFeedbackError} When `item` fails schema
 *   validation (missing `problem`, `tool_area`, or `trigger`; non-empty-string
 *   constraint; unknown key).
 */
export async function recordMaintainerFeedback(
  opts: RecordMaintainerFeedbackOptions,
): Promise<RecordMaintainerFeedbackResult> {
  const { targetRepoRoot, item } = opts;

  // Step 1: Validate the caller-supplied payload at the Zod boundary.
  // parseMaintainerFeedbackInput throws MalformedMaintainerFeedbackError on failure.
  const validated = parseMaintainerFeedbackInput(item);

  // Step 2: Stamp provenance — mint a ULID and record the UTC timestamp.
  const id = ulid();
  const raisedAt = new Date().toISOString();

  // Step 3: Compose the complete, self-contained item.
  const fullItem: MaintainerFeedbackItem = {
    id,
    raised_at: raisedAt,
    problem: validated.problem,
    tool_area: validated.tool_area,
    trigger: validated.trigger,
    ...(validated.suggested_direction !== undefined
      ? { suggested_direction: validated.suggested_direction }
      : {}),
  };

  // Step 4: Write to the maintainer inbox as a distinct, accumulated entry.
  // atomicWriteFile creates parent dirs, writes to a unique temp, then renames
  // atomically — so concurrent calls targeting different items never interfere.
  const absPath = maintainerInboxItemPath(targetRepoRoot, id, raisedAt);
  await atomicWriteFile(absPath, JSON.stringify(fullItem, null, 2));

  return { ok: true, id, absPath };
}
