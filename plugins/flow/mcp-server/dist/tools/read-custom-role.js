import { promises as fs } from "node:fs";
import * as path from "node:path";
import { CatalogueRoleNotFoundError, CatalogueShapeError } from "../errors.js";
import { parseCatalogueRole } from "../lib/markdown-frontmatter.js";
/**
 * Kebab-case role-id regex — mirrors `CatalogueRoleSchema.role`'s regex.
 * Rejecting non-matches at the function boundary prevents path-traversal
 * (e.g. `role: "../planner"`) before any file is opened.
 */
const KEBAB_CASE = /^[a-z0-9-]+$/;
/**
 * Read an operator-authored custom role file from
 * `<targetRepoRoot>/team/custom/<role>.md` and return its parsed
 * `CatalogueRole`. Used by `/flow:hire` to support the FR92 manual
 * escape hatch.
 *
 * Contract (mirrors `readCatalogue` for symmetry):
 *  - Throws `CatalogueRoleNotFoundError` if the file does not exist
 *    (ENOENT). Other IO errors propagate.
 *  - Throws `CatalogueShapeError` (via `parseCatalogueRole`) if the
 *    file exists but fails the parser.
 *  - Throws `CatalogueShapeError` with a filename-mismatch diagnostic
 *    if the frontmatter `role:` does NOT equal the filename's basename
 *    minus `.md` (Task 1.8 — catches the common "copy a catalogue file
 *    and rename only the filename" operator mistake).
 *  - Rejects role ids that fail the kebab-case regex BEFORE opening
 *    the file (path-traversal guard).
 *  - Emits no telemetry (NFR21 — synchronous read, not a runtime
 *    agent event). (Story 2.5 FR92)
 */
export async function readCustomRole(opts) {
    if (!KEBAB_CASE.test(opts.role)) {
        throw new CatalogueShapeError({
            sourcePath: `<custom-role:${opts.role}>`,
            zodMessage: `role id '${opts.role}' does not match the required kebab-case shape /^[a-z0-9-]+$/`,
        });
    }
    const customPath = path.join(opts.targetRepoRoot, "team", "custom", `${opts.role}.md`);
    let raw;
    try {
        raw = await fs.readFile(customPath, "utf8");
    }
    catch (err) {
        if (isEnoent(err)) {
            throw new CatalogueRoleNotFoundError({
                role: opts.role,
                cataloguePath: customPath,
            });
        }
        throw err;
    }
    const parsed = parseCatalogueRole(raw, customPath);
    if (parsed.role !== opts.role) {
        throw new CatalogueShapeError({
            sourcePath: customPath,
            zodMessage: `frontmatter role '${parsed.role}' does not match filename '${opts.role}'`,
        });
    }
    return parsed;
}
function isEnoent(err) {
    return (typeof err === "object" &&
        err !== null &&
        "code" in err &&
        err.code === "ENOENT");
}
