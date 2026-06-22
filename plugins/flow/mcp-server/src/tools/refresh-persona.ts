/**
 * `refreshPersona` — re-materialise a hired persona from the current catalogue
 * without losing accrued knowledge.
 *
 * Reads the existing persona file to extract `hired_at` and the `## Knowledge`
 * section body, then overwrites it with a freshly-rendered persona drawn from
 * the current catalogue (same custom-first precedence as `instantiatePersona`),
 * injecting the preserved `hired_at` and knowledge body back in.
 *
 * This is the supported recovery seam when a catalogue update leaves hired
 * personas stale (e.g. missing a new `capabilities` block). Because it does NOT
 * route through `unhirePersona`, it works even when exactly the minimum roster
 * is hired and `unhirePersona` would refuse with `UnhireBelowJudgeMinimumError`.
 *
 * Contract:
 *  - Throws `PersonaFileNotFoundError` if the role is not currently hired.
 *  - Throws `PersonaFileMalformedError` if the existing persona file cannot be
 *    parsed (the file is corrupt; fix by hand or git-revert).
 *  - Throws `CatalogueRoleNotFoundError` if the role is absent from both
 *    `team/custom/<role>.md` and the shipped catalogue.
 *  - The FR89 `PersonaAlreadyExistsError` guard in `instantiatePersona` is NOT
 *    triggered — refresh does an in-place overwrite, not a create.
 *
 * (Story native:01KVQSCP87NMRZM0C2CTAF31DJ)
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { CatalogueRoleNotFoundError, PersonaFileNotFoundError } from "../errors.js";
import { writeManagedFile } from "../lib/managed-fs.js";
import { parsePersonaFile, renderPersonaFile } from "../lib/persona-file.js";
import { getPluginVersion } from "../lib/plugin-version.js";
import type { CatalogueRole } from "../schemas/catalogue.js";
import { readCatalogue } from "./read-catalogue.js";
import { readCustomRole } from "./read-custom-role.js";

export interface RefreshPersonaOptions {
  pluginRoot: string;
  targetRepoRoot: string;
  role: string;
  /**
   * Test seam. Production callers omit; the default `getPluginVersion()`
   * reads from the plugin manifest.
   */
  pluginVersion?: string;
}

export interface RefreshPersonaResult {
  path: string;
  hiredAt: string;
}

/**
 * Re-materialise a hired persona from the current catalogue while preserving
 * the role's `hired_at` timestamp and accrued `## Knowledge` section.
 *
 * Steps:
 *  1. Stat the live persona file at `team/<role>/PERSONA.md` — throws
 *     `PersonaFileNotFoundError` if the role is not hired.
 *  2. Read and parse the existing persona (to extract `hired_at` + Knowledge).
 *  3. Load the role from the catalogue (custom-first precedence, same as
 *     `instantiatePersona`).
 *  4. Render a fresh persona file from the catalogue with the preserved
 *     `hired_at` and updated `catalogue_version`, then re-inject the
 *     preserved Knowledge body.
 *  5. Overwrite the live persona file via `writeManagedFile`.
 */
export async function refreshPersona(
  opts: RefreshPersonaOptions,
): Promise<RefreshPersonaResult> {
  const pluginVersion = opts.pluginVersion ?? getPluginVersion();

  const personaPath = path.join(
    opts.targetRepoRoot,
    "team",
    opts.role,
    "PERSONA.md",
  );

  // --- Step 1: verify the role is currently hired ---
  try {
    await fs.stat(personaPath);
  } catch (err) {
    if (isEnoent(err)) {
      throw new PersonaFileNotFoundError({
        role: opts.role,
        personaPath,
      });
    }
    throw err;
  }

  // --- Step 2: read and parse the existing persona ---
  const existingRaw = await fs.readFile(personaPath, "utf8");
  const existingPersona = parsePersonaFile(existingRaw, personaPath);

  const hiredAt = existingPersona.hired_at;
  const preservedKnowledge = existingPersona.sections.Knowledge;

  // --- Step 3: load role from catalogue (custom-first precedence) ---
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

  // --- Step 4: render fresh persona and inject preserved Knowledge ---
  const freshContents = renderPersonaFile({
    catalogue: source,
    hiredAt,
    catalogueVersion: pluginVersion,
  });

  // Inject preserved Knowledge body. The rendered persona always ends with
  // `## Knowledge\n\n` (empty knowledge body). We splice the preserved body
  // in after that marker.
  const contentsWithKnowledge = injectKnowledge(freshContents, preservedKnowledge);

  // --- Step 5: overwrite the live persona file ---
  await writeManagedFile({
    absPath: personaPath,
    contents: contentsWithKnowledge,
    targetRepoRoot: opts.targetRepoRoot,
    mcpToolContext: { toolName: "refreshPersona", role: opts.role },
  });

  return { path: personaPath, hiredAt };
}

/**
 * Inject a preserved Knowledge body into a freshly-rendered persona string.
 *
 * The rendered persona from `renderPersonaFile` always ends with:
 *   `## Knowledge\n\n`
 * (an empty knowledge section). When `preservedKnowledge` is non-empty, we
 * append it after that trailing blank line.
 */
function injectKnowledge(rendered: string, knowledge: string): string {
  if (!knowledge) {
    return rendered;
  }
  // The rendered file ends with `## Knowledge\n\n` (two newlines: one after the
  // heading line, one blank line before the section body that extractSections
  // trims to ""). Append the body followed by a final newline.
  return rendered + knowledge + "\n";
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}
