/**
 * `resolveLensRoles` — read the live hired roster and return the deterministic
 * lens→role binding via `resolveLensRoleBinding` (Story FU2 / native:01KT2Q51E24XKMM4YEF0ADRKNG).
 *
 * This is a PURE READ tool. It scans `<targetRepoRoot>/team/<role>/PERSONA.md`
 * existence — the same source `getTeamSnapshot` uses — to enumerate hired roles,
 * then passes that list to `resolveLensRoleBinding` and returns `{ lensRoles }`.
 *
 * Consumers:
 *  - `/flow:judge` SKILL.md step 3 (interactive judge path)
 *  - `gate-1.workflow.js` (unattended gate-1 path, via the CLI seam)
 *
 * Registered in both the MCP server (tools/register.ts) and the CLI TOOLS map
 * (cli.ts) so it is callable on the no-MCP drain/gate path:
 *   node dist/cli.js resolveLensRoles --json '{"targetRepoRoot":"..."}'
 */
import { type LensRoleBinding } from "./judge-panel.js";
export interface ResolveLensRolesOptions {
    targetRepoRoot: string;
}
export interface ResolveLensRolesResult {
    /** The deterministic lens→role binding derived from the live hired roster. */
    lensRoles: LensRoleBinding;
    /** The list of hired role ids that were found in the team directory. */
    hiredRoles: string[];
}
/**
 * Read the live hired roster and return the deterministic lens→role binding.
 *
 * Algorithm (mirrors `getTeamSnapshot`'s roster enumeration):
 *  1. List `<targetRepoRoot>/team/` directories.
 *  2. Skip `custom`, `_archived`, and hidden entries.
 *  3. For each candidate directory, check that `<role>/PERSONA.md` exists.
 *  4. Sort surviving role ids lexicographically (output stability).
 *  5. Pass the sorted list to `resolveLensRoleBinding`.
 *
 * Throws `LensJudgeUnavailableError` (from `resolveLensRoleBinding`) when the
 * hired roster is too small or too narrow to staff all five distinct lens judges.
 */
export declare function resolveLensRoles(opts: ResolveLensRolesOptions): Promise<ResolveLensRolesResult>;
