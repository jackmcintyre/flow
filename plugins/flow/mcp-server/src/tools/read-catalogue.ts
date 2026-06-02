import { promises as fs } from "node:fs";
import * as path from "node:path";
import { CatalogueRoleNotFoundError } from "../errors.js";
import { parseCatalogueRole } from "../lib/markdown-frontmatter.js";
import type { CatalogueRole } from "../schemas/catalogue.js";

export interface ReadCatalogueOptions {
  pluginRoot: string;
  role: string;
}

/**
 * Read a catalogue role file from `<pluginRoot>/catalogue/<role>.md`
 * and return its parsed `CatalogueRole`.
 *
 * - Throws `CatalogueRoleNotFoundError` if the file does not exist
 *   (ENOENT). Other IO errors propagate.
 * - Throws `CatalogueShapeError` (via `parseCatalogueRole`) if the
 *   file exists but fails the parser.
 * - Emits no telemetry (NFR21 — telemetry is for runtime agent events,
 *   not synchronous reads). Story 1.5's logger is not invoked here.
 *
 * Pure parameterised IO — `pluginRoot` flows in from the caller,
 * mirroring `loadRolePermissions`'s contract. (Story 2.3 FR82, FR83)
 */
export async function readCatalogue(opts: ReadCatalogueOptions): Promise<CatalogueRole> {
  const cataloguePath = path.join(opts.pluginRoot, "catalogue", `${opts.role}.md`);
  let raw: string;
  try {
    raw = await fs.readFile(cataloguePath, "utf8");
  } catch (err) {
    if (isEnoent(err)) {
      throw new CatalogueRoleNotFoundError({
        role: opts.role,
        cataloguePath,
      });
    }
    throw err;
  }
  return parseCatalogueRole(raw, cataloguePath);
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}
