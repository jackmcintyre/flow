/**
 * Deterministic domain → specialist-role mapping (Story native:01KVFAF2T7DPJ5T18PQ534D7XM).
 *
 * Keyed to the catalogue role `domain` strings (the same strings set in
 * each role's YAML frontmatter). When a signal (backlog risk tier, work
 * type, recurring stall) implies a missing area of expertise, this map
 * resolves which specialist should be hired to cover it.
 *
 * Rules:
 *  - Security coverage → `security-specialist`
 *    (domain: "authentication authorization and secret handling")
 *  - Test / quality coverage → `test-specialist`
 *    (domain: "test design and coverage gaps")
 *  - Documentation coverage → `docs-specialist`
 *    (domain: "developer-facing documentation and READMEs")
 *  - Failure-mode diagnosis → `debugger`
 *    (domain: "failure-mode diagnosis and root-cause isolation")
 *
 * Every entry maps a catalogue domain string to its owning specialist
 * role id. The mapping is deliberately narrow: generalist roles (dev,
 * reviewer, orchestrator, planner, retro-analyst, quality-lead,
 * hiring-manager, author) are NOT hiring targets — they form the team
 * backbone and are never the output of `analyzeTeamFit`.
 *
 * The `specialistRoleForDomain` helper returns `null` when the domain
 * belongs to a generalist role or is unknown — callers treat `null` as
 * "no specialist hire needed".
 */

/** The catalogue domain string for security work. */
export const DOMAIN_SECURITY = "authentication authorization and secret handling";

/** The catalogue domain string for test-specialist work. */
export const DOMAIN_TEST = "test design and coverage gaps";

/** The catalogue domain string for docs work. */
export const DOMAIN_DOCS = "developer-facing documentation and READMEs";

/** The catalogue domain string for debugger work. */
export const DOMAIN_DEBUG = "failure-mode diagnosis and root-cause isolation";

/**
 * Map of catalogue domain string → specialist role id.
 *
 * Only specialist (non-generalist) roles appear here. Generalist-role
 * domains resolve to `undefined` so `specialistRoleForDomain` returns
 * `null` for them.
 */
const DOMAIN_TO_SPECIALIST: ReadonlyMap<string, string> = new Map([
  [DOMAIN_SECURITY, "security-specialist"],
  [DOMAIN_TEST, "test-specialist"],
  [DOMAIN_DOCS, "docs-specialist"],
  [DOMAIN_DEBUG, "debugger"],
]);

/**
 * Resolve the specialist role that owns a given catalogue domain string.
 *
 * Returns `null` when:
 *  - The domain belongs to a generalist role (dev, reviewer, planner, …).
 *  - The domain string is unrecognised (not in the catalogue).
 *
 * Matching is exact (byte-equal, no case-folding, no trimming) to
 * mirror the routing discipline used throughout the codebase.
 */
export function specialistRoleForDomain(domain: string): string | null {
  return DOMAIN_TO_SPECIALIST.get(domain) ?? null;
}

/**
 * Return the catalogue domain string for a well-known specialist role.
 *
 * The inverse of `specialistRoleForDomain`. Used by the stall-gap rule to
 * resolve a stalled domain back to its owning role name for the
 * recommendation.
 *
 * Returns `null` when the role is not a specialist or is not in the map.
 */
export function domainForSpecialistRole(role: string): string | null {
  for (const [domain, r] of DOMAIN_TO_SPECIALIST) {
    if (r === role) return domain;
  }
  return null;
}

/** All specialist roles this mapping tracks. */
export const ALL_SPECIALIST_ROLES: ReadonlyArray<string> = Array.from(
  DOMAIN_TO_SPECIALIST.values(),
);
