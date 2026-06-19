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

/**
 * Map of catalogue domain string → specialist role id.
 *
 * Only specialist (non-generalist) roles appear here. Generalist-role
 * domains resolve to `undefined` so `specialistRoleForDomain` returns
 * `null` for them.
 */
const DOMAIN_TO_SPECIALIST: ReadonlyMap<string, string> = new Map([
  ["authentication authorization and secret handling", "security-specialist"],
  ["test design and coverage gaps", "test-specialist"],
  ["developer-facing documentation and READMEs", "docs-specialist"],
  ["failure-mode diagnosis and root-cause isolation", "debugger"],
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

/** All specialist roles this mapping tracks. */
export const ALL_SPECIALIST_ROLES: ReadonlyArray<string> = Array.from(
  DOMAIN_TO_SPECIALIST.values(),
);
