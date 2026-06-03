export interface LookupRoleByDomainOptions {
    targetRepoRoot: string;
    domain: string;
}
export interface LookupRoleByDomainResult {
    role: string | null;
}
/**
 * Exact-match domain routing over hired personas (FR99). Walks
 * `<targetRepoRoot>/team/`, parses every `<role>/PERSONA.md`, and
 * returns the role id whose `domain:` frontmatter is byte-equal to
 * the input. Returns `{ role: null }` when no team is hired, the
 * `team/` directory is absent, or no domain matches.
 *
 * Algorithm:
 *  1. If `team/` does not exist, return `{ role: null }` — no team hired
 *     is a valid state.
 *  2. List role subdirs. Filter out `custom` (Story 2.5's escape hatch
 *     — not in v1's lookup), `_archived` (FR107 — archived personas are
 *     not routing candidates), and any non-directory entry.
 *  3. For each role dir, call `readPersona`. Skip silently on
 *     `PersonaFileNotFoundError` (stray empty `team/<role>/` dir).
 *     Propagate `PersonaFileMalformedError` — a corrupt persona must
 *     not be invisibly excluded from routing.
 *  4. Exact-match `domain` — no fuzzy matching, no case-folding, no
 *     trimming. Return the first match.
 *
 * NOTE: Story 2.1 AC3 forbids domain collisions across the catalogue,
 * but a hand-edited persona could introduce one. v1 returns the first
 * encountered role on collision (filesystem traversal order, OS-
 * dependent). Epic 3 may add a routing-ambiguity diagnostic. (Story 2.3
 * FR99)
 */
export declare function lookupRoleByDomain(opts: LookupRoleByDomainOptions): Promise<LookupRoleByDomainResult>;
