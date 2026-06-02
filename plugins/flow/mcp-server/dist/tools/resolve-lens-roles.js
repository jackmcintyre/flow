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
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { resolveLensRoleBinding } from "./judge-panel.js";
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
export async function resolveLensRoles(opts) {
    const { targetRepoRoot } = opts;
    const teamDir = path.join(targetRepoRoot, "team");
    // Enumerate hired roles — mirrors getTeamSnapshot's roster enumeration.
    let dirEntries;
    try {
        dirEntries = await fs.readdir(teamDir);
    }
    catch (err) {
        if (isEnoent(err)) {
            // No team directory → no hired roles → matching will throw LensJudgeUnavailableError.
            dirEntries = [];
        }
        else {
            throw err;
        }
    }
    const SKIP_DIRS = new Set(["custom", "_archived"]);
    const hiredRoles = [];
    for (const entry of dirEntries) {
        if (SKIP_DIRS.has(entry) || entry.startsWith(".")) {
            continue;
        }
        // Must be a directory with a PERSONA.md (same guard getTeamSnapshot uses).
        let stat;
        try {
            stat = await fs.stat(path.join(teamDir, entry));
        }
        catch {
            continue;
        }
        if (!stat.isDirectory()) {
            continue;
        }
        // Check PERSONA.md exists — a directory without it is not a hired role.
        try {
            await fs.access(path.join(teamDir, entry, "PERSONA.md"));
        }
        catch {
            continue;
        }
        hiredRoles.push(entry);
    }
    // Lexicographic sort for output stability.
    hiredRoles.sort();
    // Throws LensJudgeUnavailableError when the roster cannot staff all five lenses.
    const lensRoles = resolveLensRoleBinding(hiredRoles);
    return { lensRoles, hiredRoles };
}
function isEnoent(err) {
    return (typeof err === "object" &&
        err !== null &&
        "code" in err &&
        err.code === "ENOENT");
}
