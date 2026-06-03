/**
 * `extractDepRefsFromSpecBody` — Story 5.13, AC1.
 *
 * Extracts dependency ref tokens from a spec file's raw body text using
 * exactly two patterns:
 *
 *   (i)  `Depends on: <token[, token...]>` — explicit inline declaration.
 *   (ii) `> Depends on [Story] <token>` — blockquote convention used in
 *        Stories 5.10 / 5.11 / 5.12 source-note blocks.
 *
 * Token grammar: a token is valid if it matches either
 *   - `NATIVE_REF_RE` → `native:<ULID>` (Crockford Base32, 26 chars)
 *   - `BMAD_REF_RE`   → `bmad:<epic>.<story>` (e.g. `bmad:5.10`)
 *
 * Tokens from pattern (ii) that match `^\d+\.\d+$` are normalised to
 * `bmad:<id>` (e.g. the blockquote `> Depends on Story 5.10` yields
 * `bmad:5.10`). This covers the convention where story keys are cited in
 * human-readable form without the `bmad:` prefix.
 *
 * Tokens that fail both regexes are silently dropped (no stderr warning in
 * v1 — false-positive avoidance takes priority over warning chatter).
 *
 * Same-ref duplicates across patterns are deduplicated via `Set`.
 *
 * @param body - Raw UTF-8 text of the spec file.
 * @returns Set of valid ref strings extracted from the body.
 */
/** Ref pattern for native adapter: `native:<ULID>` (Crockford Base32 26 chars). */
export const NATIVE_REF_RE = /^native:[0-9A-HJKMNP-TV-Z]{26}$/;
/** Ref pattern for BMad adapter: `bmad:<epic>.<story>` e.g. `bmad:5.10`. */
export const BMAD_REF_RE = /^bmad:\d+\.\d+$/;
/** Numeric story-id pattern used in blockquote convention: `5.10`, `1.2`, etc. */
const NUMERIC_STORY_ID_RE = /^\d+\.\d+$/;
/**
 * Split a capture string on commas or whitespace and return individual tokens.
 */
function splitTokens(capture) {
    return capture
        .split(/[\s,]+/)
        .map((t) => t.trim())
        .filter(Boolean);
}
/**
 * Return the canonical ref string for a token, or `null` if the token
 * cannot be resolved to a valid ref.
 *
 * - Already-valid `native:` or `bmad:` refs are returned as-is.
 * - A bare numeric id like `5.10` is promoted to `bmad:5.10`.
 * - Everything else is dropped (returns `null`).
 */
function resolveToken(token) {
    if (NATIVE_REF_RE.test(token) || BMAD_REF_RE.test(token)) {
        return token;
    }
    if (NUMERIC_STORY_ID_RE.test(token)) {
        const candidate = `bmad:${token}`;
        if (BMAD_REF_RE.test(candidate)) {
            return candidate;
        }
    }
    return null;
}
export function extractDepRefsFromSpecBody(body) {
    const refs = new Set();
    // Pattern (i): lines matching `Depends on: <token[, token...]>` (anywhere in line, anchored at start).
    const patternI = /^Depends on:\s*(.+)$/gm;
    let match;
    while ((match = patternI.exec(body)) !== null) {
        const capture = match[1];
        for (const token of splitTokens(capture)) {
            const ref = resolveToken(token);
            if (ref !== null)
                refs.add(ref);
        }
    }
    // Pattern (ii): blockquote lines matching `> Depends on [Story] <token>`.
    const patternII = /^>\s*Depends on (?:Story\s+)?(.+)$/gm;
    while ((match = patternII.exec(body)) !== null) {
        const capture = match[1].trim();
        // Pattern (ii) is designed for a single ref per blockquote line.
        // Still split to be safe in case of comma-separated refs.
        for (const token of splitTokens(capture)) {
            const ref = resolveToken(token);
            if (ref !== null)
                refs.add(ref);
        }
    }
    return refs;
}
