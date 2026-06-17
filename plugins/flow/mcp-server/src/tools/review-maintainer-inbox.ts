/**
 * `reviewMaintainerInbox` — Story native:01KV9QR3VK11RDD1ZDPVJ7SEYA.
 *
 * On-demand review surface for the maintainer-only inbox. Reads ALL stored
 * inbox items (files under `.flow/maintainer-inbox/`) and returns each one
 * with a pre-filled GitHub new-issue URL so the operator can choose which
 * items to file without copying details by hand.
 *
 * This is the unattended / after-the-fact counterpart to the live-session
 * path (`native:01KV7XXKZ0TBPYETZP2X81T40S`), which hands the user a URL
 * the moment feedback is raised mid-session. This feature covers feedback
 * that accrued while the operator was away.
 *
 * Behaviour:
 *   1. Read every `.json` file from `.flow/maintainer-inbox/` in alphabetical
 *      (chronological) order.
 *   2. Parse each file against `MaintainerFeedbackItemSchema`. Malformed files
 *      are skipped with a warning rather than crashing the whole review.
 *   3. Resolve the GitHub repo identity once (via `gh repo view`) and build a
 *      pre-filled new-issue URL for each valid item using the defaulted
 *      field-to-issue mapping (see below). When `gh` is unavailable, the
 *      items are still listed but without `issueUrl`.
 *   4. Return `{ ok: true, items: ReviewedInboxItem[], emptyInbox: boolean }`.
 *      When the inbox is empty, `items` is an empty array and `emptyInbox`
 *      is `true`.
 *
 * FIELD-TO-ISSUE MAPPING (stored items have a DIFFERENT shape from the
 * live-session payload — only the URL-construction mechanism is shared):
 *   - ISSUE TITLE: `[<tool_area>] <problem>` trimmed to a single line.
 *   - ISSUE BODY: labelled sections covering problem statement, suggested
 *     direction (when present), and trigger.
 *
 * Empty-inbox case: return a plain empty-state result (`emptyInbox: true`,
 * `items: []`) — never emit a blank or malformed URL.
 *
 * Design invariants:
 *   - Pure URL composition via the proven `buildFeedbackIssueUrl` length-guard.
 *   - Repo identity resolved once; absent `gh` is fail-soft per-URL.
 *   - Read-only: writes nothing to the inbox or any state directory.
 *   - Malformed inbox files are skipped with a per-item warning.
 *
 * Story native:01KV9QR3VK11RDD1ZDPVJ7SEYA
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { MaintainerFeedbackItemSchema } from "../schemas/maintainer-feedback.js";
import type { MaintainerFeedbackItem } from "../schemas/maintainer-feedback.js";
import {
  resolveGhRepoIdentity,
} from "./build-feedback-issue-url.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INBOX_SUBDIR = path.join(".flow", "maintainer-inbox");

/** Practical title length ceiling for a GitHub issue title. */
const MAX_TITLE_LENGTH = 120;

/** Maximum URL byte length (mirrors the live-session builder). */
const MAX_URL_BYTES = 8192;

/** Note appended when the body is shortened to fit URL limits. */
const SHORTENED_NOTE =
  "\n\n_(body shortened — see full detail in the maintainer inbox)_";

// ---------------------------------------------------------------------------
// Body and title composers for stored inbox items
// ---------------------------------------------------------------------------

/**
 * Compose the issue title from a stored inbox item.
 *
 * Format: `[<tool_area>] <problem>` — the tool area as a bracketed prefix
 * followed by the problem statement, trimmed to a single-line length.
 */
export function composeStoredItemIssueTitle(item: MaintainerFeedbackItem): string {
  const raw = `[${item.tool_area}] ${item.problem}`;
  // Trim to single line (take first newline-delimited part, then truncate).
  const firstLine = raw.split("\n")[0]!;
  return firstLine.slice(0, MAX_TITLE_LENGTH);
}

/**
 * Compose the issue body from a stored inbox item.
 *
 * Sections: Problem, Suggested direction (optional), Trigger.
 * Exported for unit-testing the composition logic in isolation.
 */
export function composeStoredItemIssueBody(item: MaintainerFeedbackItem): string {
  const lines: string[] = [
    `**Problem**`,
    item.problem,
    ``,
    `**Tool area**`,
    item.tool_area,
  ];

  if (item.suggested_direction) {
    lines.push(``, `**Suggested direction**`, item.suggested_direction);
  }

  lines.push(``, `**Trigger**`, item.trigger);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// URL builder for stored inbox items
// ---------------------------------------------------------------------------

/**
 * Build a pre-filled GitHub new-issue URL for a stored inbox item.
 *
 * Reuses the same URL-length guard as the live-session builder
 * (`buildFeedbackIssueUrl`), but with the stored-item field mapping.
 *
 * Returns `{ url, bodyShortened }`.
 */
export function buildStoredItemIssueUrl(
  owner: string,
  repo: string,
  item: MaintainerFeedbackItem,
): { url: string; bodyShortened: boolean } {
  const title = composeStoredItemIssueTitle(item);
  const body = composeStoredItemIssueBody(item);

  const base = `https://github.com/${owner}/${repo}/issues/new`;
  const encodedTitle = encodeURIComponent(title);

  // Try the full body first.
  const fullUrl = `${base}?title=${encodedTitle}&body=${encodeURIComponent(body)}`;
  if (Buffer.byteLength(fullUrl, "utf8") <= MAX_URL_BYTES) {
    return { url: fullUrl, bodyShortened: false };
  }

  // Body is too long — binary-search for the largest prefix that fits.
  const encodedNote = encodeURIComponent(SHORTENED_NOTE);
  const fixedPartLength = Buffer.byteLength(
    `${base}?title=${encodedTitle}&body=${encodedNote}`,
    "utf8",
  );
  const bodyBudget = MAX_URL_BYTES - fixedPartLength;

  let lo = 0;
  let hi = body.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    const candidate = encodeURIComponent(body.slice(0, mid));
    if (Buffer.byteLength(candidate, "utf8") <= bodyBudget) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  const shortenedBody = body.slice(0, lo) + SHORTENED_NOTE;
  const shortenedUrl = `${base}?title=${encodedTitle}&body=${encodeURIComponent(shortenedBody)}`;
  return { url: shortenedUrl, bodyShortened: true };
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ReviewedInboxItem {
  /** The item's ULID identifier. */
  id: string;
  /** ISO-8601 UTC timestamp when the item was recorded. */
  raised_at: string;
  /** Which part of the tool the problem concerns. */
  tool_area: string;
  /** What is wrong / what structural limitation was hit. */
  problem: string;
  /** Optional concrete suggestion for how to fix it. */
  suggested_direction?: string;
  /** What surfaced this item. */
  trigger: string;
  /**
   * Pre-filled GitHub new-issue URL for this item.
   * Present when `gh repo view` succeeded and the URL could be assembled.
   * Absent when `gh` is unavailable — the item is still listed.
   */
  issueUrl?: string;
  /**
   * `true` when the body was truncated to keep the URL under the practical
   * ceiling. The full detail is still in the inbox file.
   */
  bodyShortened?: boolean;
}

export interface ReviewMaintainerInboxOptions {
  /** Absolute path to the target repository root. */
  targetRepoRoot: string;
  /**
   * Test seam: inject a stub for `execSync("gh repo view ...")` so tests
   * can control the owner/name without spawning a real `gh` process.
   * Production callers omit this.
   */
  execSyncImpl?: (cmd: string, opts: { encoding: "utf-8" }) => string;
}

export interface ReviewMaintainerInboxResult {
  ok: true;
  /**
   * `true` when the inbox contained no items. When `true`, `items` is
   * an empty array.
   */
  emptyInbox: boolean;
  /** All valid inbox items in chronological (filename-alphabetical) order. */
  items: ReviewedInboxItem[];
  /**
   * Count of inbox files that could not be parsed (malformed JSON or
   * schema failure). Normally 0.
   */
  malformedCount: number;
}

// ---------------------------------------------------------------------------
// Main implementation
// ---------------------------------------------------------------------------

/**
 * Read the maintainer inbox on demand and return each stored item with a
 * pre-filled GitHub new-issue URL for the operator to open in their browser.
 *
 * Read-only: writes nothing. Items are returned in chronological order
 * (alphabetical by filename, which is `<iso-ts-safe>-<ulid>.json`).
 *
 * @returns `{ ok: true, emptyInbox, items, malformedCount }`
 */
export async function reviewMaintainerInbox(
  opts: ReviewMaintainerInboxOptions,
): Promise<ReviewMaintainerInboxResult> {
  const { targetRepoRoot } = opts;
  const inboxDir = path.join(targetRepoRoot, INBOX_SUBDIR);

  // Step 1: List inbox files. If the directory does not exist, the inbox is empty.
  let filenames: string[];
  try {
    const entries = await fs.readdir(inboxDir);
    // Keep only .json files, sorted alphabetically (= chronologically).
    filenames = entries.filter((f) => f.endsWith(".json")).sort();
  } catch (err) {
    // ENOENT: inbox directory never created (no feedback filed yet).
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") {
      return { ok: true, emptyInbox: true, items: [], malformedCount: 0 };
    }
    throw err;
  }

  if (filenames.length === 0) {
    return { ok: true, emptyInbox: true, items: [], malformedCount: 0 };
  }

  // Step 2: Resolve GitHub repo identity once (fail-soft when gh unavailable).
  const repoIdentity = resolveGhRepoIdentity(opts.execSyncImpl);

  // Step 3: Parse each file and build the per-item result.
  const items: ReviewedInboxItem[] = [];
  let malformedCount = 0;

  for (const filename of filenames) {
    const absPath = path.join(inboxDir, filename);
    let raw: string;
    try {
      raw = await fs.readFile(absPath, "utf8");
    } catch {
      // File disappeared between readdir and readFile — skip.
      malformedCount++;
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Not valid JSON.
      malformedCount++;
      continue;
    }

    const schemaResult = MaintainerFeedbackItemSchema.safeParse(parsed);
    if (!schemaResult.success) {
      // Schema validation failed — skip this file.
      malformedCount++;
      continue;
    }

    const item = schemaResult.data;

    // Step 4: Build a pre-filled new-issue URL for this item (fail-soft).
    let issueUrl: string | undefined;
    let bodyShortened: boolean | undefined;

    if (repoIdentity !== null) {
      const urlResult = buildStoredItemIssueUrl(
        repoIdentity.owner,
        repoIdentity.repo,
        item,
      );
      issueUrl = urlResult.url;
      bodyShortened = urlResult.bodyShortened;
    }

    const reviewed: ReviewedInboxItem = {
      id: item.id,
      raised_at: item.raised_at,
      tool_area: item.tool_area,
      problem: item.problem,
      trigger: item.trigger,
      ...(item.suggested_direction !== undefined
        ? { suggested_direction: item.suggested_direction }
        : {}),
      ...(issueUrl !== undefined ? { issueUrl } : {}),
      ...(bodyShortened === true ? { bodyShortened: true } : {}),
    };

    items.push(reviewed);
  }

  return {
    ok: true,
    emptyInbox: items.length === 0 && malformedCount === 0,
    items,
    malformedCount,
  };
}
