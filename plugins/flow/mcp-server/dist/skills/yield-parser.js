/**
 * Yield parser — Story 4.11 Task 1.
 *
 * Parses the reviewer subagent's final-output transcript for the verbatim locked
 * yield phrase that triggers domain routing to a specialist reviewer.
 *
 * **Behavioural contract source:**
 * `_bmad-output/implementation-artifacts/4-11-yield-protocol-locked-phrase-domain-routing-in-domain-insistence.md § AC1 unpacked`
 *
 * Parser invariants (load-bearing — any change MUST be reviewed against
 * the § Acceptance Criteria section of that document):
 *
 * - MUST match the verbatim phrase `This sits in <domain>'s domain — handing off.`
 *   where `<domain>` is replaced with the target persona's domain string,
 *   on the LAST non-empty line of the transcript.
 * - The em-dash `—` (U+2014) is part of the literal. An en-dash or hyphen
 *   does NOT match.
 * - The trailing period `.` is part of the literal.
 * - Case-sensitive: `this sits in` (lowercase `t`) does NOT match.
 * - Trailing whitespace on each line is trimmed before comparison.
 * - Last-line semantics: if the correct phrase appears mid-transcript but the
 *   last non-empty line is different, the result is `no-yield` or `drift`.
 * - Empty or all-whitespace transcript → `{ ok: false, reason: "empty" }`.
 * - Last line contains `sits in` but doesn't match the full regex → `{ ok: false, reason: "drift" }`.
 * - Last line has no `sits in` substring and does NOT match → `{ ok: false, reason: "no-yield" }`.
 *
 * **Token-name correction (Story 4.11 AC1a):**
 * The epic AC uses `<role>` as the placeholder token name. This is a documentation
 * artefact — the value substituted at emission is the target persona's `domain:`
 * string, NOT its `role:` id. This parser pins `<domain>` as the operative token
 * name to match the actual runtime semantics (FR99, FR100).
 *
 * Pure function: no IO, no console.
 *
 * Story 4.11 Task 1.1–1.5. References: FR99, FR100.
 */
/** Verbatim locked yield phrase template — `<domain>` is the substitution token. */
export const YIELD_PHRASE_TEMPLATE = "This sits in <domain>'s domain — handing off.";
/**
 * Regex for matching the locked yield phrase.
 * Group 1 captures the domain string.
 * The em-dash `—` (U+2014) is literal. The trailing period is literal.
 * Case-sensitive on the leading `T`.
 */
export const YIELD_PHRASE_REGEX = /^This sits in (.+)'s domain — handing off\.$/;
/**
 * Parse the reviewer subagent's final-output transcript for the verbatim locked
 * yield phrase.
 *
 * @param transcript - The full text of the reviewer subagent's terminal output.
 * @returns `{ ok: true, domain }` on an exact match on the last non-empty line,
 *   where `domain` is the captured domain string. Or `{ ok: false, reason }` with:
 *   - `"empty"` — transcript is empty or all-whitespace.
 *   - `"drift"` — last line contains `sits in` but doesn't match the full phrase
 *     (e.g. wrong dash, missing period, lowercase `t`).
 *   - `"no-yield"` — last line does not contain `sits in` (the common no-yield path).
 */
export function parseYield(transcript) {
    // Split into lines and trim trailing whitespace per line.
    const lines = transcript.split("\n").map((l) => l.trimEnd());
    // Find the last non-empty line.
    let lastNonEmpty;
    for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].trim().length > 0) {
            lastNonEmpty = lines[i];
            break;
        }
    }
    // Empty or all-whitespace transcript.
    if (lastNonEmpty === undefined) {
        return { ok: false, reason: "empty" };
    }
    // Try the exact-match regex.
    const match = YIELD_PHRASE_REGEX.exec(lastNonEmpty);
    if (match !== null) {
        const domain = match[1];
        // Belt-and-suspenders: the regex's `.+` prevents empty captures,
        // but guard against it anyway.
        if (domain.length === 0) {
            return { ok: false, reason: "drift" };
        }
        return { ok: true, domain };
    }
    // Discriminate between drift (contains `sits in`) and no-yield (doesn't).
    if (lastNonEmpty.includes("sits in")) {
        return { ok: false, reason: "drift" };
    }
    return { ok: false, reason: "no-yield" };
}
