/**
 * Handoff parser — Story 4.3 Task 1.
 *
 * Parses the dev subagent's final-output transcript for the verbatim locked
 * handoff phrase required to trigger a reviewer spawn.
 *
 * **Behavioural contract source:**
 * `_bmad-output/implementation-artifacts/4-3-dev-reviewer-handoff-reviewer-spawn-and-rework-signal.md § Behavioural contract`
 *
 * Parser invariants (load-bearing — any change to this function MUST be
 * reviewed against the § Handoff parser invariants section of that document):
 *
 * - MUST match the verbatim phrase `Handoff to reviewer — story <story-id> ready for review.`
 *   where `<story-id>` is replaced with the live story ref, on the LAST
 *   non-empty line of the transcript.
 * - The em-dash `—` (U+2014) is part of the literal. An en-dash or hyphen
 *   does NOT match.
 * - Case-sensitive: `handoff` (lower-case first word) does NOT match.
 * - Trailing whitespace on each line is trimmed before comparison.
 * - Last-line semantics: if the correct phrase appears mid-transcript but the
 *   last non-empty line is different, the result is `drift`.
 * - Empty or all-whitespace transcript → `{ ok: false, reason: "empty" }`.
 * - Any other mismatch → `{ ok: false, reason: "drift" }`.
 * - Pure function: no IO, no console.
 */

/** Verbatim locked handoff phrase template — `<story-id>` is the substitution token. */
export const HANDOFF_PHRASE_TEMPLATE = "Handoff to reviewer — story <story-id> ready for review.";

export type HandoffParseResult =
  | { ok: true }
  | { ok: false; reason: "drift" | "empty" };

/**
 * Parse the dev subagent's final-output transcript for the verbatim locked
 * handoff phrase.
 *
 * @param transcript - The full text of the dev subagent's terminal output.
 * @param expectedRef - The live story ref (substituted for `<story-id>` in
 *   the template before comparison).
 * @returns `{ ok: true }` on an exact match on the last non-empty line, or
 *   `{ ok: false, reason: "empty" | "drift" }` otherwise.
 */
export function parseHandoff(
  transcript: string,
  expectedRef: string,
): HandoffParseResult {
  // Build the expected literal by substituting the live ref.
  const expectedLiteral = HANDOFF_PHRASE_TEMPLATE.replace("<story-id>", expectedRef);

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

  // Strict equality on the last non-empty line.
  if (lastNonEmpty === expectedLiteral) {
    return { ok: true };
  }

  // Any other case (paraphrase, wrong ref, mid-transcript match, etc.) is drift.
  return { ok: false, reason: "drift" };
}
