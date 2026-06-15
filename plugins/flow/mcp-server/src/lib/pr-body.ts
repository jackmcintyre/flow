/**
 * Pure utility functions for composing branch slugs, commit bodies,
 * commit subjects, and PR bodies for the dev subagent's terminal action.
 *
 * @see _bmad-output/implementation-artifacts/4-4-dev-subagent-git-push-and-gh-pr-create-terminal-action.md § Behavioural contract
 *
 * All exports are pure (no I/O, no side effects). Deterministic output
 * for any given input.
 *
 * (Story 4.4 Task 3.1)
 */

import { BranchSlugUnrenderableError } from "../errors.js";
import { shortHandle } from "./short-handle.js";

// ---------------------------------------------------------------------------
// buildBranchSlug
// ---------------------------------------------------------------------------

/**
 * Compose a `story/<ref-slug>-<title-slug>` branch name from the story
 * ref and title, per Pattern §9 (AC1a).
 *
 * Rules:
 * - `ref-slug`: ref lowercased, non-`[a-z0-9-]` chars replaced by `-`,
 *   consecutive hyphens collapsed, leading/trailing hyphens stripped.
 * - `title-slug`: same normalisation applied to title, then trimmed to
 *   40 characters at a char boundary (not breaking a word — just
 *   truncating at exactly 40 chars from the normalised string), then
 *   leading/trailing hyphens stripped from the result.
 * - The title-slug MUST contain at least one alphanumeric character;
 *   if not, throws `BranchSlugUnrenderableError`.
 *
 * @throws {BranchSlugUnrenderableError} When the resulting title slug
 *   has no alphanumeric characters.
 */
export function buildBranchSlug(opts: { ref: string; title: string }): string {
  const refSlug = toKebab(opts.ref);
  const rawTitleSlug = toKebab(opts.title).slice(0, 40).replace(/-+$/, "");

  if (!/[a-z0-9]/.test(rawTitleSlug)) {
    throw new BranchSlugUnrenderableError({ ref: opts.ref, title: opts.title });
  }

  return `story/${refSlug}-${rawTitleSlug}`;
}

/**
 * Convert an arbitrary string to kebab-case suitable for branch slugs:
 * lowercase, replace non-`[a-z0-9]` chars with `-`, collapse consecutive
 * hyphens, strip leading/trailing hyphens.
 */
function toKebab(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// ---------------------------------------------------------------------------
// wrapCommitBody
// ---------------------------------------------------------------------------

/**
 * Hard-wrap a commit body string at `width` characters (default 72).
 *
 * Rules (AC1d / Implementation strategy):
 * - Split on `\n` to process each line independently.
 * - Lines containing `http://` or `https://` are left untouched (URLs
 *   must not be broken).
 * - Lines ≤ `width` chars are passed through unchanged.
 * - Lines > `width` chars are wrapped at the nearest preceding space
 *   boundary at or before `width`. If no space is found, the line is
 *   left as-is (no break on un-breakable content).
 *
 * The output is joined back with `\n`.
 */
export function wrapCommitBody(body: string, width = 72): string {
  return body
    .split("\n")
    .map((line) => wrapLine(line, width))
    .join("\n");
}

function wrapLine(line: string, width: number): string {
  // Leave URL-containing lines untouched.
  if (/https?:\/\//.test(line)) return line;

  if (line.length <= width) return line;

  const parts: string[] = [];
  let remaining = line;

  while (remaining.length > width) {
    // Find the last space at or before width.
    const slice = remaining.slice(0, width + 1);
    const lastSpace = slice.lastIndexOf(" ");
    if (lastSpace <= 0) {
      // No space found — cannot break this segment; emit as-is.
      parts.push(remaining);
      remaining = "";
      break;
    }
    parts.push(remaining.slice(0, lastSpace));
    remaining = remaining.slice(lastSpace + 1);
  }

  if (remaining.length > 0) {
    parts.push(remaining);
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// composeCommitSubject
// ---------------------------------------------------------------------------

/**
 * Compose a conventional-commits subject line `<type>(<shortHandle>): <title>`.
 * The scope is the human-friendly short handle derived from the story ref via
 * `shortHandle()`, so operator-visible surfaces (PR title, commit log) show a
 * concise identifier instead of the full 26-character ULID.
 *
 * **Full-ref preservation (AC2):** the full story ref is NOT lost — it is written
 * verbatim into the PR body's machine block by `composePrBody` via the `Story:`
 * line. `runDevTerminalAction` passes the unshortened `ref` to `composePrBody`
 * directly (see `run-dev-terminal-action.ts` lines ~257–262), so no correlation
 * information is dropped by shortening the scope here.
 *
 * **Reviewer correlation (AC1, AC2):** `runReviewerSession` correlates stories
 * via the `ref` parameter passed directly to `runReviewerSession` — it does NOT
 * parse the ref from the commit subject or PR title. Shortening the scope here is
 * therefore safe: the reviewer's correlation path is unaffected.
 *
 * **Safe fallback (AC3):** `shortHandle()` returns the full input string unchanged
 * when the ref contains no colon separator (unrecognised shape). In that case this
 * function emits the full ref as the scope, so the subject is never left without a
 * usable story identifier. No extra guard is required here.
 */
export function composeCommitSubject(opts: {
  type: string;
  ref: string;
  title: string;
}): string {
  // Use the short human-friendly handle in the scope for operator readability.
  // The full ref is preserved in the PR body's `Story:` line (see composePrBody).
  const handle = shortHandle(opts.ref);
  return `${opts.type}(${handle}): ${opts.title.trim()}`;
}

// ---------------------------------------------------------------------------
// composePrBody
// ---------------------------------------------------------------------------

/**
 * Compose the three-section PR body:
 *
 * **Section 1 — Approver summary (LEADING):**
 * Five plain-language sections in fixed order, assembled from what the
 * developer holds at PR-open time:
 *   1. What changed — story title + AC summaries
 *   2. Why — story narrative / user pain
 *   3. How to check it yourself — AC text
 *   4. Risk and blast radius — caller-supplied risk tier
 *   5. Evidence — per-AC covering check + pre-PR gate result
 *
 * **Section 2 (machine block):**
 * ```
 * <!-- flow:pr:machine -->
 * Story: <ref>
 * Spec: <specPath>
 * ACs:
 * - [ ] AC1: <full criterion text>
 * ...
 * <!-- /flow:pr:machine -->
 * ```
 *
 * **Section 3 (free-form summary):**
 * The caller's `summary` string verbatim (no wrap applied).
 *
 * Sections are separated by a single blank line each.
 *
 * The approver summary is built solely from handoff-available inputs:
 * - `title` and `narrative` — from the story spec / manifest.
 * - `acs[].firstLine` — the full criterion text of each AC (untruncated), so
 *   the approver sees the complete Given/When/Then assertion.
 * - `acs[].coveringCheck` — the AC's verification target, carried from the
 *   manifest's `acceptance_criteria[].verification.target`. If absent, the
 *   evidence section notes the AC by text only.
 * - `acs[].verificationType` — the AC's verification kind, carried from the
 *   manifest's `acceptance_criteria[].verification.type`: `"vitest"` is a
 *   runnable test, `"artifact"` is a state location. A "Run X" instruction is
 *   shown ONLY for runnable (`vitest`) targets; a non-runnable target shows the
 *   criterion text alone with no false automated-check claim.
 * - `riskTier` — the story's classified risk tier, passed in by the caller
 *   (`run-dev-terminal-action.ts`). `composePrBody` does NOT compute risk.
 * - The pre-PR build-and-test gate result: always stated as "passed" here
 *   because `runDevTerminalAction` refuses to call `composePrBody` until
 *   both gates have exited 0.
 */
export function composePrBody(opts: {
  ref: string;
  specPath: string;
  acs: Array<{
    index: number;
    firstLine: string;
    coveringCheck?: string;
    verificationType?: "vitest" | "artifact";
  }>;
  summary: string;
  /** Story title — assembled into the "What changed" section. */
  title?: string;
  /** Story narrative ("As a / I want / so that") — assembled into the "Why" section. */
  narrative?: string;
  /** Caller-supplied risk tier — assembled into the "Risk and blast radius" section. */
  riskTier?: string;
}): string {
  // ---------------------------------------------------------------------------
  // Section 1: Approver summary (five plain-language sections)
  // ---------------------------------------------------------------------------
  const approverSummary = buildApproverSummary({
    title: opts.title,
    narrative: opts.narrative,
    acs: opts.acs,
    riskTier: opts.riskTier,
  });

  // ---------------------------------------------------------------------------
  // Section 2: Machine block
  // ---------------------------------------------------------------------------
  const acLines = opts.acs
    .map((ac) => `- [ ] AC${ac.index}: ${ac.firstLine}`)
    .join("\n");

  const machineBlock = [
    "<!-- flow:pr:machine -->",
    `Story: ${opts.ref}`,
    `Spec: ${opts.specPath}`,
    "ACs:",
    acLines,
    "<!-- /flow:pr:machine -->",
  ].join("\n");

  // ---------------------------------------------------------------------------
  // Assemble: approver summary → machine block → free-form summary
  // ---------------------------------------------------------------------------
  return `${approverSummary}\n\n${machineBlock}\n\n${opts.summary}`;
}

/**
 * Build the five-section plain-language approver summary.
 * Each section is a level-2 markdown heading followed by its body.
 *
 * All five sections are always emitted (even when the caller omits optional
 * fields) so the approver can rely on a fixed, predictable shape. If a
 * field is absent the section falls back to a minimal but honest placeholder.
 */
/**
 * An AC carries a *runnable* check only when its verification kind is `vitest`
 * AND a target string is present. An `artifact` (state-location) target, or any
 * AC with no recorded target, is NOT runnable: the PR body must not tell the
 * approver to "Run" it, nor claim it is covered by an automated check.
 *
 * A missing/undefined `verificationType` is treated as non-runnable — the safe,
 * honest default (we cannot promise a runnable check we cannot identify).
 */
function isRunnableCheck(ac: {
  coveringCheck?: string;
  verificationType?: "vitest" | "artifact";
}): boolean {
  return ac.verificationType === "vitest" && Boolean(ac.coveringCheck);
}

function buildApproverSummary(opts: {
  title?: string;
  narrative?: string;
  acs: Array<{
    index: number;
    firstLine: string;
    coveringCheck?: string;
    verificationType?: "vitest" | "artifact";
  }>;
  riskTier?: string;
}): string {
  const { title, narrative, acs, riskTier } = opts;

  // --- Section 1: What changed ---
  const whatChangedLines: string[] = [];
  if (title) {
    whatChangedLines.push(title);
    whatChangedLines.push("");
  }
  if (acs.length > 0) {
    whatChangedLines.push("This change delivers the following acceptance criteria:");
    for (const ac of acs) {
      whatChangedLines.push(`- AC${ac.index}: ${ac.firstLine}`);
    }
  } else {
    whatChangedLines.push("No acceptance criteria were listed for this change.");
  }
  const whatChanged = whatChangedLines.join("\n");

  // --- Section 2: Why ---
  const why = narrative
    ? narrative
    : "No narrative was provided for this story.";

  // --- Section 3: How to check it yourself ---
  const howLines: string[] = [];
  if (acs.length > 0) {
    howLines.push("To verify each acceptance criterion:");
    for (const ac of acs) {
      if (isRunnableCheck(ac)) {
        howLines.push(`- AC${ac.index}: Run \`${ac.coveringCheck}\``);
      } else {
        // Non-runnable target (a state location / artifact) or no recorded
        // check: show the criterion text alone. Never print "Run X" for
        // something the approver cannot run, and make no automated-check claim.
        howLines.push(`- AC${ac.index}: ${ac.firstLine}`);
      }
    }
    howLines.push("");
    howLines.push(
      "You can also read the change in the diff below and compare it against each criterion above.",
    );
  } else {
    howLines.push("No acceptance criteria were listed for this change.");
  }
  const howToCheck = howLines.join("\n");

  // --- Section 4: Risk and blast radius ---
  const riskLines: string[] = [];
  if (riskTier) {
    riskLines.push(`**Risk tier:** ${riskTier}`);
    riskLines.push("");
  }
  riskLines.push(
    "The change is scoped to the files in the diff below. Review the diff to " +
    "judge its actual blast radius — including any effect on shared state, data " +
    "schemas, or authentication paths — before approving.",
  );
  riskLines.push("");
  riskLines.push(
    "**What is explicitly not covered:** reviewer verification of this summary's accuracy " +
    "is handled by a separate companion story.",
  );
  const riskAndBlastRadius = riskLines.join("\n");

  // --- Section 5: Evidence ---
  const evidenceLines: string[] = [];
  evidenceLines.push(
    "The pre-pull-request build-and-test gate passed before this pull request was opened. " +
    "No pull request can be opened by the automated flow unless both `pnpm build` and `pnpm test` " +
    "exit 0 in the developer's working directory.",
  );
  evidenceLines.push("");
  if (acs.length > 0) {
    evidenceLines.push("Per-criterion covering checks:");
    for (const ac of acs) {
      if (isRunnableCheck(ac)) {
        evidenceLines.push(`- AC${ac.index} → \`${ac.coveringCheck}\` (automated test)`);
      } else if (ac.coveringCheck) {
        // A recorded but non-runnable target (e.g. an artifact / state path):
        // point at it for manual inspection, but do not call it an automated test.
        evidenceLines.push(
          `- AC${ac.index} → verify at \`${ac.coveringCheck}\` (not an automated test)`,
        );
      } else {
        evidenceLines.push(`- AC${ac.index} → no structured verification target recorded`);
      }
    }
  }
  const evidence = evidenceLines.join("\n");

  return [
    "## What changed",
    "",
    whatChanged,
    "",
    "## Why",
    "",
    why,
    "",
    "## How to check it yourself",
    "",
    howToCheck,
    "",
    "## Risk and blast radius",
    "",
    riskAndBlastRadius,
    "",
    "## Evidence",
    "",
    evidence,
  ].join("\n");
}
