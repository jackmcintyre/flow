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
export declare const NATIVE_REF_RE: RegExp;
/** Ref pattern for BMad adapter: `bmad:<epic>.<story>` e.g. `bmad:5.10`. */
export declare const BMAD_REF_RE: RegExp;
export declare function extractDepRefsFromSpecBody(body: string): Set<string>;
