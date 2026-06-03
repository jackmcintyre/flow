import { promises as fs } from "node:fs";
import * as path from "node:path";
import { CatalogueRoleNotFoundError, PersonaAlreadyExistsError } from "../errors.js";
import { writeManagedFile } from "../lib/managed-fs.js";
import { renderPersonaFile } from "../lib/persona-file.js";
import { getPluginVersion } from "../lib/plugin-version.js";
import type { CatalogueRole } from "../schemas/catalogue.js";
import { readCatalogue } from "./read-catalogue.js";
import { readCustomRole } from "./read-custom-role.js";

export interface InstantiatePersonaOptions {
  pluginRoot: string;
  targetRepoRoot: string;
  role: string;
  /**
   * Test seam. Production callers omit; the default `() => new Date()`
   * is the v1 runtime clock.
   */
  clock?: () => Date;
  /**
   * Test seam. Production callers omit; the default `getPluginVersion()`
   * reads from the plugin manifest.
   */
  pluginVersion?: string;
}

export interface InstantiatePersonaResult {
  path: string;
}

/**
 * Materialise a persona file at `<targetRepoRoot>/team/<role>/PERSONA.md`
 * by copying the role's frontmatter + four canonical sections verbatim
 * and stamping `hired_at` (ISO-8601 UTC) and `catalogue_version` (plugin
 * semver). The `## Knowledge` section is written empty at hire time
 * (FR89); Epic 3's `appendPersonaKnowledge` is the only authorised path
 * to mutate it.
 *
 * Role-source precedence (Story 2.5 fix — operator-smoke gate defect):
 *  1. `<targetRepoRoot>/team/custom/<role>.md` (the FR92 escape hatch).
 *  2. `<pluginRoot>/catalogue/<role>.md` (the shipped roster).
 * Custom wins so an operator can override a shipped role without
 * needing to edit the plugin tree. Both paths share the same
 * `parseCatalogueRole` shape (Story 2.5 design rationale).
 *
 * Contract:
 *  - Throws `CatalogueRoleNotFoundError` if neither location has the
 *    role. The error message names both checked paths.
 *  - Throws `PersonaAlreadyExistsError` if a persona file already exists
 *    at the target path. **Does NOT silently overwrite** — re-hire-on-
 *    existing-team is `/hire`'s mandate (FR90), not this tool's.
 *  - `CatalogueShapeError` from a malformed custom file propagates
 *    verbatim (caller surfaces the diagnostic).
 *  - Routes the write through `writeManagedFile` with an MCP tool
 *    context — `team/**` is in `CANONICAL_PATH_GLOBS`, so without the
 *    context the write would refuse.
 *
 * No telemetry emit in v1 — persona creation is not a runtime agent
 * event. The architecture's `persona.append` event type is Epic 3's.
 * (Story 2.3 FR89, FR98; Story 2.5 FR92)
 */
export async function instantiatePersona(
  opts: InstantiatePersonaOptions,
): Promise<InstantiatePersonaResult> {
  const clock = opts.clock ?? (() => new Date());
  const pluginVersion = opts.pluginVersion ?? getPluginVersion();

  const customPath = path.join(
    opts.targetRepoRoot,
    "team",
    "custom",
    `${opts.role}.md`,
  );
  const cataloguePath = path.join(
    opts.pluginRoot,
    "catalogue",
    `${opts.role}.md`,
  );

  // Custom-first precedence (FR92 escape hatch).
  let source: CatalogueRole | null = null;
  try {
    source = await readCustomRole({
      targetRepoRoot: opts.targetRepoRoot,
      role: opts.role,
    });
  } catch (err) {
    if (!(err instanceof CatalogueRoleNotFoundError)) {
      throw err;
    }
    // Custom file absent — fall through to catalogue.
  }

  if (source === null) {
    try {
      source = await readCatalogue({
        pluginRoot: opts.pluginRoot,
        role: opts.role,
      });
    } catch (err) {
      if (err instanceof CatalogueRoleNotFoundError) {
        throw new CatalogueRoleNotFoundError({
          role: opts.role,
          cataloguePath: `${customPath} or ${cataloguePath}`,
        });
      }
      throw err;
    }
  }

  const personaPath = path.join(
    opts.targetRepoRoot,
    "team",
    opts.role,
    "PERSONA.md",
  );

  // Pre-flight existence check. Pure create-or-fail contract — see
  // Task 4.3 / FR90.
  let exists = false;
  try {
    await fs.stat(personaPath);
    exists = true;
  } catch (err) {
    if (!isEnoent(err)) {
      throw err;
    }
  }
  if (exists) {
    throw new PersonaAlreadyExistsError({
      role: opts.role,
      personaPath,
    });
  }

  const hiredAt = clock().toISOString();
  const contents = renderPersonaFile({
    catalogue: source,
    hiredAt,
    catalogueVersion: pluginVersion,
  });

  await writeManagedFile({
    absPath: personaPath,
    contents,
    targetRepoRoot: opts.targetRepoRoot,
    mcpToolContext: { toolName: "instantiatePersona", role: opts.role },
  });

  return { path: personaPath };
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}
