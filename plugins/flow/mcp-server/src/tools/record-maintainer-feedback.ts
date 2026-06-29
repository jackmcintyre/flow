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
 *   4. Attempt to resolve the GitHub repo identity via `gh repo view --json owner,name`
 *      and build a pre-filled new-issue URL from the item details. On success the URL
 *      is included in the result as `issueUrl` so the operator can open it immediately
 *      in their browser to review and submit the issue themselves (Story native:01KV7XXKZ0TBPYETZP2X81T40S).
 *      Nothing is ever filed automatically — the link is always a review-and-submit page.
 *      When `gh` is unavailable or the repo identity cannot be resolved, `issueUrl` is
 *      omitted from the result (fail-soft: the inbox write is the primary side-effect).
 *   5. Return `{ ok: true, id, absPath, issueUrl? }`.
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
 * **Pre-filled issue URL (Story native:01KV7XXKZ0TBPYETZP2X81T40S):** on a
 * successful write, this tool also attempts to build a pre-filled GitHub
 * new-issue URL (owner/name resolved once via `gh repo view`). The URL is
 * fail-soft — absence is not an error. The full item is in the inbox regardless.
 * Surfacing/reviewing stored inbox items is a separate follow-up story.
 */

import * as path from "node:path";
import { ulid } from "ulid";
import { atomicWriteFile } from "../lib/managed-fs.js";
import {
  parseMaintainerFeedbackInput,
} from "../schemas/maintainer-feedback.js";
import type { MaintainerFeedbackItem } from "../schemas/maintainer-feedback.js";
import {
  buildFeedbackIssueUrl,
  composeFeedbackIssueTitle,
  composeFeedbackIssueBody,
  resolvePluginRepoIdentity,
} from "./build-feedback-issue-url.js";

export interface RecordMaintainerFeedbackOptions {
  /** Absolute path to the target repository root. */
  targetRepoRoot: string;
  /**
   * The raw feedback item payload — validated inside via
   * `parseMaintainerFeedbackInput`. Must include `problem`, `tool_area`,
   * and `trigger`; `suggested_direction` is optional.
   */
  item: unknown;
  /**
   * Test seam: inject a function that returns the raw content of the plugin's
   * own `package.json` (or `null` to simulate the field being absent / the
   * file being unreadable). Used to resolve the plugin's repo identity for the
   * pre-filled GitHub issue URL. Production callers omit this; the real
   * `mcp-server/package.json` is located automatically via `import.meta.url`.
   */
  readPluginPkgJsonImpl?: () => string | null;
}

export interface RecordMaintainerFeedbackResult {
  ok: true;
  /** The ULID minted for this item — uniquely identifies it in the inbox. */
  id: string;
  /** Absolute path of the written inbox entry. */
  absPath: string;
  /**
   * Pre-filled GitHub new-issue URL for this item.
   *
   * Present when `gh repo view` succeeded and the URL could be assembled.
   * Absent when `gh` is unavailable, not authenticated, or owner/name
   * could not be resolved — the inbox write succeeds either way.
   *
   * The link opens GitHub's own new-issue form so the operator can review
   * and submit as themselves. NOTHING is ever filed automatically.
   * (Story native:01KV7XXKZ0TBPYETZP2X81T40S AC1/AC2)
   */
  issueUrl?: string;
  /**
   * Plain (un-encoded) issue title used to compose `issueUrl`.
   * Present when `issueUrl` is present; used by the handler to build the
   * `gh issue create` command without re-decoding the URL.
   */
  issueTitle?: string;
  /**
   * Plain (un-encoded) issue body used to compose `issueUrl`.
   * Present when `issueUrl` is present; used by the handler to build the
   * `gh issue create` command without re-decoding the URL.
   */
  issueBody?: string;
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
 * @returns `{ ok: true, id, absPath, issueUrl? }` — the minted ULID, absolute
 *   path of the written inbox entry, and (when `gh` is available and the repo
 *   identity resolves) a pre-filled GitHub new-issue URL for this item.
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
    ...(validated.dedup_key !== undefined
      ? { dedup_key: validated.dedup_key }
      : {}),
  };

  // Step 4: Write to the maintainer inbox as a distinct, accumulated entry.
  // atomicWriteFile creates parent dirs, writes to a unique temp, then renames
  // atomically — so concurrent calls targeting different items never interfere.
  const absPath = maintainerInboxItemPath(targetRepoRoot, id, raisedAt);
  await atomicWriteFile(absPath, JSON.stringify(fullItem, null, 2));

  // Step 5: Build a pre-filled GitHub new-issue URL for the operator to open
  // immediately in their browser (Story native:01KV7XXKZ0TBPYETZP2X81T40S).
  // This is fail-soft: when gh is unavailable or the repo identity cannot be
  // resolved, the inbox write above is the primary result; issueUrl is simply
  // omitted. Nothing is ever filed automatically.
  //
  // Also compute the plain title and body strings so the handler can produce
  // the `gh issue create` command fallback without re-decoding the URL.
  let issueUrl: string | undefined;
  let issueTitle: string | undefined;
  let issueBody: string | undefined;
  // Resolve the plugin's own repo identity from its package.json `repository`
  // field. Maintainer-feedback items are Flow bugs — they must always link to
  // the Flow plugin's repo, not whatever cwd project the operator is running
  // Flow inside (Story native:01KW5WMS33XC463QM60AXDGK81).
  const repoIdentity = resolvePluginRepoIdentity(opts.readPluginPkgJsonImpl);
  if (repoIdentity !== null) {
    issueTitle = composeFeedbackIssueTitle(validated);
    issueBody = composeFeedbackIssueBody(validated);
    const urlResult = buildFeedbackIssueUrl({
      owner: repoIdentity.owner,
      repo: repoIdentity.repo,
      item: validated,
    });
    issueUrl = urlResult.url;
  }

  return {
    ok: true,
    id,
    absPath,
    ...(issueUrl !== undefined ? { issueUrl, issueTitle, issueBody } : {}),
  };
}
