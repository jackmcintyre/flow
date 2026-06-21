/**
 * `buildFeedbackIssueUrl` — Story native:01KV7XXKZ0TBPYETZP2X81T40S.
 *
 * Deterministic seam that turns a captured maintainer-feedback item into a
 * GitHub new-issue URL with the title and full body pre-filled as query
 * parameters. The link opens GitHub's own form so the operator can review
 * and submit as themselves — NOTHING is ever filed automatically.
 *
 * URL shape:
 *   https://github.com/<owner>/<repo>/issues/new?title=<encoded-title>&body=<encoded-body>
 *
 * AC1 (primary path): capturing a feedback item immediately produces a
 *   pre-filled new-issue URL the operator can open in their browser.
 *
 * AC2 (no auto-submit): the link is a review-and-submit-yourself page —
 *   any user can follow it; it does not require write access to the repo
 *   and does not submit anything on the operator's behalf.
 *
 * AC3 (URL-length guard): when the encoded body would push the assembled
 *   URL past the practical ceiling (~8 KB), the body is truncated and a
 *   short "(body shortened — see full detail in the maintainer inbox)" note
 *   is appended inside the pre-fill. The structured item is still captured
 *   in full to the inbox, so nothing is lost by the truncation.
 *
 * Design invariants:
 * - Pure function — no filesystem I/O, no network calls. Testable in isolation.
 * - Owner/repo resolution is the CALLER'S responsibility (via `gh repo view`).
 * - Body composition mirrors the four feedback-item fields:
 *     problem / tool_area / suggested_direction (optional) / trigger.
 * - URL encoding uses `encodeURIComponent` — safe across browsers and GitHub.
 *
 * Story native:01KV7XXKZ0TBPYETZP2X81T40S
 */

import type { MaintainerFeedbackInput } from "../schemas/maintainer-feedback.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Practical URL ceiling GitHub reliably accepts in new-issue pre-fills.
 * Browsers and GitHub both reject very long URLs; 8 KB (8192 bytes) is a
 * safe upper bound that leaves headroom for GitHub's own query parameters.
 */
const MAX_URL_BYTES = 8192;

/**
 * Note appended to the shortened body inside the pre-fill so the operator
 * knows the full detail lives in the maintainer inbox.
 */
const SHORTENED_NOTE =
  "\n\n_(body shortened — see full detail in the maintainer inbox)_";

// ---------------------------------------------------------------------------
// Title and body composers
// ---------------------------------------------------------------------------

/**
 * Compose the issue title from a live-session feedback item.
 *
 * Format: `[tool-feedback] <tool_area>: <problem (first 120 chars)>`
 *
 * Exported so callers (e.g. the register.ts handler) can obtain the plain
 * title for the `gh issue create` command without re-decoding the URL.
 */
export function composeFeedbackIssueTitle(item: MaintainerFeedbackInput): string {
  return `[tool-feedback] ${item.tool_area}: ${item.problem.slice(0, 120)}`;
}

/**
 * Compose the human-readable issue body from a feedback item's fields.
 *
 * Exported for unit-testing the composition logic in isolation.
 */
export function composeFeedbackIssueBody(item: MaintainerFeedbackInput): string {
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
// URL builder
// ---------------------------------------------------------------------------

export interface FeedbackIssueUrlOptions {
  /** Resolved GitHub repo owner login (e.g. `"octocat"`). */
  owner: string;
  /** Resolved GitHub repo name (e.g. `"my-repo"`). */
  repo: string;
  /** The validated feedback-item payload (before provenance stamping). */
  item: MaintainerFeedbackInput;
}

export interface FeedbackIssueUrlResult {
  /** The assembled pre-filled GitHub new-issue URL. */
  url: string;
  /**
   * `true` when the body was truncated to keep the URL under the practical
   * ceiling. The full item is still in the maintainer inbox.
   */
  bodyShortened: boolean;
}

/**
 * Build a pre-filled GitHub new-issue URL for a captured feedback item.
 *
 * The URL opens GitHub's own new-issue form with `title` and `body` already
 * filled from the item's details. The operator reviews and submits
 * themselves — nothing is filed automatically, and the link works for any
 * user regardless of repo ownership.
 *
 * Applies the URL-length guard (AC3): when the assembled URL exceeds
 * `MAX_URL_BYTES`, the encoded body is shortened and a note is appended
 * so the link always opens cleanly.
 *
 * @returns `{ url, bodyShortened }` — the URL and whether the body was cut.
 */
export function buildFeedbackIssueUrl(
  opts: FeedbackIssueUrlOptions,
): FeedbackIssueUrlResult {
  const { owner, repo, item } = opts;

  const title = composeFeedbackIssueTitle(item);
  const body = composeFeedbackIssueBody(item);

  const base = `https://github.com/${owner}/${repo}/issues/new`;
  const encodedTitle = encodeURIComponent(title);

  // Try the full body first.
  const fullUrl = `${base}?title=${encodedTitle}&body=${encodeURIComponent(body)}`;
  if (Buffer.byteLength(fullUrl, "utf8") <= MAX_URL_BYTES) {
    return { url: fullUrl, bodyShortened: false };
  }

  // Body is too long — find the largest prefix that fits within the budget
  // after appending the shortened note.
  const encodedNote = encodeURIComponent(SHORTENED_NOTE);
  const fixedPartLength = Buffer.byteLength(
    `${base}?title=${encodedTitle}&body=${encodedNote}`,
    "utf8",
  );
  const bodyBudget = MAX_URL_BYTES - fixedPartLength;

  // Binary-search for the longest encoded body chunk that fits.
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
// Link-block renderer
// ---------------------------------------------------------------------------

/**
 * Render a three-element link block for a pre-filled GitHub issue URL.
 *
 * Produces:
 *   [Open in GitHub](<url>)
 *   <url>
 *   gh issue create --title '<escaped-title>' --body '<escaped-body>'
 *
 * The three elements give the operator three independent paths to act on the
 * feedback regardless of whether their terminal renders clickable hyperlinks:
 *   (1) Markdown hyperlink — renders as a clickable link in supporting terminals.
 *   (2) Plain bare URL — can be copy-pasted into any browser.
 *   (3) gh issue create command — works entirely in the terminal without a browser.
 *
 * When `issueUrl` is absent (gh unavailable), returns `null` so callers can
 * degrade cleanly to the existing no-link message with no blank or malformed lines.
 *
 * Shell escaping: single-quote the title and body values; replace any embedded
 * `'` with `'\''` (close quote, literal single-quote, reopen quote).
 *
 * @param issueUrl - The assembled pre-filled GitHub new-issue URL (or undefined/null).
 * @param title    - The plain (un-encoded) issue title text.
 * @param body     - The plain (un-encoded) issue body text.
 * @returns The formatted three-element block string, or `null` when issueUrl is absent.
 */
export function renderFeedbackLinkBlock(
  issueUrl: string | null | undefined,
  title: string,
  body: string,
): string | null {
  if (!issueUrl) return null;

  // Escape embedded single quotes for safe shell interpolation.
  const escapedTitle = title.replace(/'/g, "'\\''");
  const escapedBody = body.replace(/'/g, "'\\''");

  return [
    `[Open in GitHub](${issueUrl})`,
    issueUrl,
    `gh issue create --title '${escapedTitle}' --body '${escapedBody}'`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Repo-identity resolver (thin wrapper over `gh repo view`)
// ---------------------------------------------------------------------------

/**
 * Resolve the GitHub repo owner login and repo name once via
 * `gh repo view --json owner,name`.
 *
 * This mirrors the pattern in `applyNeedsHumanLabel` inside
 * `run-auto-merge-gate.ts` and the shape asserted by
 * `gh-base-repo.integration.test.ts`.
 *
 * The caller is responsible for providing an `execSyncImpl` seam (defaults
 * to Node's built-in `execSync`) so tests can stub the subprocess without
 * spawning a real `gh` process.
 *
 * Returns `null` when `gh` is unavailable or not authenticated so callers
 * can degrade gracefully (the inbox write is the primary side-effect;
 * the URL is a bonus for live sessions).
 */
export function resolveGhRepoIdentity(
  execSyncImpl?: (cmd: string, opts: { encoding: "utf-8" }) => string,
): { owner: string; repo: string } | null {
  try {
    const impl =
      execSyncImpl ??
      ((cmd: string, opts: { encoding: "utf-8" }) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { execSync } = require("node:child_process") as {
          execSync: (cmd: string, opts: { encoding: "utf-8" }) => string;
        };
        return execSync(cmd, opts);
      });

    const stdout = impl("gh repo view --json owner,name", {
      encoding: "utf-8",
    });
    const parsed = JSON.parse(stdout) as {
      name?: string;
      owner?: { login?: string };
    };
    const owner = parsed.owner?.login ?? "";
    const repo = parsed.name ?? "";
    if (!owner || !repo) return null;
    return { owner, repo };
  } catch {
    return null;
  }
}
