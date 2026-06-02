import type { CatalogueRole } from "../schemas/catalogue.js";
export interface ReadCustomRoleOptions {
    targetRepoRoot: string;
    role: string;
}
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
export declare function readCustomRole(opts: ReadCustomRoleOptions): Promise<CatalogueRole>;
