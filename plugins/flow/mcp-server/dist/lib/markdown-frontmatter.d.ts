import { type CatalogueRole } from "../schemas/catalogue.js";
/**
 * Split a Markdown file into its YAML frontmatter head and the body.
 *
 * Frontmatter must be the first non-empty content, delimited by `---`
 * lines at the file start and the next `---` line. CRLF / BOM are
 * normalised. Reused across catalogue (Story 2.1) and future persona
 * (Story 2.3) parsing.
 *
 * Throws `CatalogueShapeError` when delimiters are missing — the
 * catalogue is the only v1 caller, so error specificity is acceptable;
 * Story 2.3 can introduce a sibling helper / error if persona parsing
 * needs a distinct surface.
 */
export declare function splitFrontmatter(raw: string, sourcePath: string): {
    frontmatterRaw: string;
    body: string;
};
/**
 * Pure catalogue file parser — no IO. The caller supplies the file
 * contents and a `sourcePath` for error reporting (mirrors
 * `parseStandardsDoc`).
 *
 * Validates:
 *  - YAML frontmatter delimited by `---` lines parses cleanly.
 *  - Frontmatter matches `CatalogueRoleSchema`.
 *  - Body contains all four required `##` sections (`Domain`,
 *    `Mandate`, `Out of mandate`, `Prompt`) in canonical order.
 *
 * Throws `CatalogueShapeError` on any failure.
 */
export declare function parseCatalogueRole(raw: string, sourcePath: string): CatalogueRole;
