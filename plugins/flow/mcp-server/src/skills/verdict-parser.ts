/**
 * @deprecated Story 4.6 revision 2 moved verdict transport to the persisted
 * `reviewer-result.json` file written by `runReviewerSession`. No runtime caller
 * remains after revision 2. This file is retained for documentation of the
 * historical grammar and as a structural-anchor for `parsers-content.test.ts`
 * (AC5(ii)). Remove in a future housekeeping story once the parsers-content
 * structural-anchor test is also retired.
 *
 * The `verdict` locked-phrase grammar defined here is now an **authoring
 * guideline** for humans writing reviewer personas, NOT a runtime parser
 * contract. The enforcement comment in `generalist-reviewer.md`'s
 * `locked_phrases: verdict` entry is marked `# enforcement: deprecated`.
 *
 * ---
 * Verdict parser — Story 4.3 Task 2.
 *
 * Parses the reviewer subagent's final-output transcript for the verbatim
 * locked verdict sentinel line that signals the review outcome.
 *
 * **Behavioural contract source:**
 * `_bmad-output/implementation-artifacts/4-3-dev-reviewer-handoff-reviewer-spawn-and-rework-signal.md § Behavioural contract`
 *
 * Parser invariants (historical — no longer load-bearing after Story 4.6 revision 2):
 *
 * - MUST match the verbatim sentinel grammar `**Verdict: <SENTINEL>**` where
 *   `<SENTINEL>` ∈ `{READY FOR MERGE, NEEDS CHANGES, BLOCKED}`, on the LAST
 *   non-empty line of the reviewer transcript.
 * - Optionally tolerates a trailing ` [<bracket-content>]` after the closing
 *   `**`. The bracket content is captured as `details` but is not consulted
 *   by this story's logic.
 * - Case-sensitive: lowercase sentinels do NOT match.
 * - Missing `**` bolding: does NOT match.
 * - Hyphenated sentinel (`READY-FOR-MERGE`): does NOT match.
 * - Unrecognised sentinel value: `{ ok: false, reason: "unknown-sentinel" }`.
 * - Empty or all-whitespace transcript → `{ ok: false, reason: "empty" }`.
 * - No match on last non-empty line → `{ ok: false, reason: "drift" }`.
 * - Pure function: no IO, no console.
 */

/** The three recognised verdict sentinel values. */
export const VERDICT_SENTINELS = [
  "READY FOR MERGE",
  "NEEDS CHANGES",
  "BLOCKED",
] as const;

export type VerdictSentinel = (typeof VERDICT_SENTINELS)[number];

export type VerdictParseResult =
  | { ok: true; sentinel: VerdictSentinel; details?: string }
  | { ok: false; reason: "drift" | "empty" | "unknown-sentinel" };

/**
 * Regex for the verdict grammar. Applied per-line (not multiline on the full
 * transcript) so embedded prose in earlier lines does not accidentally match.
 *
 * Captures:
 *   - Group 1: the sentinel value (e.g. `READY FOR MERGE`)
 *   - Group 2 (optional): the bracket content if present
 */
const VERDICT_REGEX =
  /^\*\*Verdict: (READY FOR MERGE|NEEDS CHANGES|BLOCKED)\*\*(?: \[([^\]]*)\])?$/;

/**
 * Parse the reviewer subagent's final-output transcript for the verbatim
 * locked verdict sentinel line.
 *
 * @param transcript - The full text of the reviewer subagent's terminal output.
 * @returns A typed parse result.
 */
export function parseVerdict(transcript: string): VerdictParseResult {
  // Split into lines and trim trailing whitespace per line.
  const lines = transcript.split("\n").map((l) => l.trimEnd());

  // Find the last non-empty line.
  let lastNonEmpty: string | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim().length > 0) {
      lastNonEmpty = lines[i]!;
      break;
    }
  }

  // Empty or all-whitespace transcript.
  if (lastNonEmpty === undefined) {
    return { ok: false, reason: "empty" };
  }

  // Attempt the verdict regex on the last non-empty line.
  const match = VERDICT_REGEX.exec(lastNonEmpty);

  if (!match) {
    return { ok: false, reason: "drift" };
  }

  const rawSentinel = match[1] as string;

  // Verify the sentinel is one of the known values (belt-and-suspenders — the
  // regex already restricts to the three values, but explicit narrowing keeps
  // TypeScript happy and makes future additions safe).
  if (!VERDICT_SENTINELS.includes(rawSentinel as VerdictSentinel)) {
    return { ok: false, reason: "unknown-sentinel" };
  }

  const sentinel = rawSentinel as VerdictSentinel;
  const details = match[2] !== undefined ? match[2] : undefined;

  return { ok: true, sentinel, ...(details !== undefined ? { details } : {}) };
}
