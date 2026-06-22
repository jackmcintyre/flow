/**
 * Generalist-backbone exclusion and domain-routing helpers for
 * `analyzeTeamFit`.
 *
 * History:
 *  - Story native:01KVFAF2T7DPJ5T18PQ534D7XM introduced the original
 *    `specialistRoleForDomain` / `ALL_SPECIALIST_ROLES` hard-coded four-
 *    specialist map. Those exports are now removed.
 *  - Story native:01KVPQYRDWRSDCXD15XNJN0MC6 replaced the hard-coded map
 *    with a fully dynamic role set (built at runtime from the catalogue +
 *    operator custom roles). The only export this module retains is
 *    `GENERALIST_BACKBONE_ROLES` — the fixed exclusion set of roles that
 *    are NEVER hiring targets or set-aside candidates regardless of
 *    useful-work signals.
 *
 * The dynamic domain → role mapping is now built by
 * `buildAvailableRoleSet` in `analyze-team-fit.ts`, which reads the
 * catalogue and `team/custom/` at call time.
 */

/**
 * The generalist backbone: roles that form the permanent team core and
 * are NEVER hiring targets or set-aside (unhire) candidates, regardless
 * of useful-work signals. Applies to both built-in and operator teams.
 *
 * Used by `analyzeTeamFit` as the single exclusion set when deciding
 * whether a hired role can be recommended for set-aside. Any hired role
 * NOT in this set — whether a built-in specialist or an operator-authored
 * custom role — is a valid unhire candidate (subject to the
 * grading-panel guard).
 */
export const GENERALIST_BACKBONE_ROLES: ReadonlySet<string> = new Set([
  "generalist-dev",
  "generalist-reviewer",
  "orchestrator",
  "planner",
  "retro-analyst",
  "quality-lead",
  "hiring-manager",
  "author",
]);
