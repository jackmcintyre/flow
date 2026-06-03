import type { CatalogueRole } from "../schemas/catalogue.js";
import { type PersonaFile } from "../schemas/persona.js";
/**
 * Pure persona file parser — no IO. Reuses `splitFrontmatter` and
 * `assertCatalogueBodySections` from Story 2.1.
 *
 * Validates:
 *  - YAML frontmatter parses cleanly.
 *  - Frontmatter matches `PersonaFrontmatterSchema` (catalogue shape
 *    plus `hired_at` and `catalogue_version`).
 *  - Body contains the four required catalogue sections in canonical
 *    order (via `assertCatalogueBodySections`).
 *  - Body contains a `## Knowledge` section appearing strictly AFTER
 *    `## Prompt`.
 *
 * Throws `PersonaFileMalformedError` on any failure. Catalogue-side
 * errors (e.g. CatalogueShapeError from the shared body-section
 * assertion) are caught and re-thrown as PersonaFileMalformedError so
 * persona/catalogue failure surfaces stay distinct downstream.
 */
export declare function parsePersonaFile(raw: string, sourcePath: string): PersonaFile;
/**
 * Pure renderer — no IO, no clock. Produces the full on-disk file
 * contents (frontmatter `---` block + five sections in canonical order)
 * for a freshly-instantiated persona. The `Knowledge` body is the empty
 * string. `Domain`, `Mandate`, `Out of mandate`, `Prompt` are copied
 * verbatim from the catalogue.
 *
 * The renderer is the ONLY place persona-file YAML is serialised in
 * v1. `instantiatePersona` calls it.
 */
export declare function renderPersonaFile(opts: {
    catalogue: CatalogueRole;
    hiredAt: string;
    catalogueVersion: string;
}): string;
