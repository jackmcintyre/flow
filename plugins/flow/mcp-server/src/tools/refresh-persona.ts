/**
 * `refreshPersona` — re-materialise an existing hired persona from the current
 * catalogue while preserving its `hired_at` timestamp and its accrued
 * `## Knowledge` / lessons section.
 *
 * Root cause addressed (smoketest 2026-06-22, Finding 2): when a catalogue role
 * definition is updated (for example a `capabilities` block is added), the live
 * persona file at `team/<role>/PERSONA.md` goes stale. `instantiatePersona`
 * refuses with `PersonaAlreadyExistsError` (FR89), and `unhirePersona` may be
 * guarded by `UnhireBelowJudgeMinimumError` when exactly the minimum roster is
 * hired — leaving no supported recovery path. The only workaround before this
 * tool was to hand-edit the persona file, which the rules forbid.
 *
 * Behaviour:
 *  1. Resolve the role from the current catalogue (custom-first, catalogue
 *     fallback — same precedence as `instantiatePersona`).
 *  2. Read the existing persona to extract `hired_at` and the `## Knowledge`
 *     section body.
 *  3. Re-render the persona file from the current catalogue with the original
 *     `hired_at` and the current plugin version (so `catalogue_version` is
 *     bumped to reflect the refresh).
 *  4. Re-append the preserved `## Knowledge` content after the rendered
 *     `## Knowledge` heading.
 *  5. Write the refreshed file via `writeManagedFile`.
 *
 * Errors:
 *  - `CatalogueRoleNotFoundError` if the role is not in the catalogue.
 *  - `PersonaFileNotFoundError` if the role is not currently hired (no live
 *    `team/<role>/PERSONA.md`). This tool refreshes — it does not create fresh.
 *
 * The refresh does NOT require an unhire: it overwrites the persona in-place.
 * The `unhirePersona` guard (`UnhireBelowJudgeMinimumError`) is therefore never
 * triggered by this path. The `FR89` existing-persona refusal in
 * `instantiatePersona` remains intact for genuine non-force instantiation.
 *
 * Registration: 4-touch pattern (this file + tool-input-schemas.ts + register.ts
 * + cli.ts).
 *
 * (Story native:01KVS0YFNNFWFDP2EJT10FMV08)
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { CatalogueRoleNotFoundError, PersonaFileNotFoundError } from "../errors.js";
import { writeManagedFile } from "../lib/managed-fs.js";
import { renderPersonaFile } from "../lib/persona-file.js";
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
  /** The preserved `hired_at` timestamp (ISO-8601 UTC). */
  hiredAt: string;
  /** The new `catalogue_version` stamped after the refresh. */
  catalogueVersion: string;
}

/**
 * Re-materialise an existing hired persona from the current catalogue,
 * preserving its `hired_at` timestamp and its accrued `## Knowledge` section.
 */
export async function refreshPersona(
  opts: RefreshPersonaOptions,
): Promise<RefreshPersonaResult> {
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

  // Resolve the role from the catalogue (custom-first precedence — same as instantiatePersona).
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

  // The persona must already exist — this tool refreshes, not creates.
  let existingContents: string;
  try {
    existingContents = await fs.readFile(personaPath, "utf8");
  } catch (err) {
    if (isEnoent(err)) {
      throw new PersonaFileNotFoundError({
        role: opts.role,
        personaPath,
      });
    }
    throw err;
  }

  // Extract the preserved fields from the existing persona:
  //  - hired_at (frontmatter field)
  //  - ## Knowledge section body (accrued lessons)
  const { hiredAt, knowledgeBody } = extractPreservableFields(existingContents);

  // Re-render the persona from the current catalogue with the original hired_at.
  const rendered = renderPersonaFile({
    catalogue: source,
    hiredAt,
    catalogueVersion: pluginVersion,
  });

  // Re-append the preserved Knowledge body if non-empty.
  // `renderPersonaFile` always ends with `## Knowledge\n\n`, so we simply
  // append the preserved body after the trailing newlines.
  const finalContents =
    knowledgeBody.length > 0 ? `${rendered}${knowledgeBody}\n` : rendered;

  await writeManagedFile({
    absPath: personaPath,
    contents: finalContents,
    targetRepoRoot: opts.targetRepoRoot,
    mcpToolContext: { toolName: "refreshPersona", role: opts.role },
  });

  return { path: personaPath, hiredAt, catalogueVersion: pluginVersion };
}

/**
 * Extract the `hired_at` value and the `## Knowledge` section body from an
 * existing on-disk PERSONA.md.
 *
 * `hired_at` fallback: if the frontmatter is unparseable we use a sentinel
 * string that will fail `PersonaFrontmatterSchema` validation when the caller
 * re-reads — but the refresh still writes, which is preferable to aborting and
 * losing the accrued Knowledge. In practice this branch should never be reached
 * because the persona file was written by `instantiatePersona` or a previous
 * `refreshPersona` call.
 */
function extractPreservableFields(contents: string): {
  hiredAt: string;
  knowledgeBody: string;
} {
  const normalised = contents.replace(/\r\n/g, "\n");

  // --- Extract hired_at from YAML frontmatter ---
  let hiredAt = "";
  if (normalised.startsWith("---\n")) {
    const closeIdx = normalised.indexOf("\n---", 4);
    if (closeIdx !== -1) {
      const frontmatterBlock = normalised.slice(4, closeIdx);
      for (const line of frontmatterBlock.split("\n")) {
        const match = /^hired_at:\s*["']?([^"'\r\n]+)["']?\s*$/.exec(line);
        if (match) {
          hiredAt = match[1]!.trim();
          break;
        }
      }
    }
  }

  // --- Extract ## Knowledge section body ---
  // Walk lines after the frontmatter. Collect everything after `## Knowledge`
  // until the next `##`-level heading (or end of file).
  const lines = normalised.split("\n");
  let inKnowledge = false;
  const knowledgeLines: string[] = [];

  for (const line of lines) {
    if (/^##\s+Knowledge\s*$/.test(line)) {
      inKnowledge = true;
      continue;
    }
    if (inKnowledge) {
      // Stop at the next ## heading.
      if (/^##\s+/.test(line) && !/^###/.test(line)) {
        break;
      }
      knowledgeLines.push(line);
    }
  }

  // Trim surrounding blank lines from the captured body.
  const knowledgeBody = knowledgeLines
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");

  return { hiredAt, knowledgeBody };
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}
