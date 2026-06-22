/**
 * `resolveLensRoles` — read the live hired roster and return the deterministic
 * lens→role binding via `resolveLensRoleBinding` (Story FU2 / native:01KT2Q51E24XKMM4YEF0ADRKNG).
 *
 * This is a PURE READ tool. It scans `<targetRepoRoot>/team/<role>/PERSONA.md`
 * existence — the same source `getTeamSnapshot` uses — to enumerate hired roles,
 * then reads each persona's declared capabilities and passes the enriched roster
 * to `resolveLensRoleBinding`, which staffs the panel from declared capabilities
 * (falling back to the built-in LENS_CANDIDATES for roles with no declaration).
 *
 * Consumers:
 *  - `/flow:judge` SKILL.md step 3 (interactive judge path)
 *  - `gate-1.workflow.js` (unattended gate-1 path, via the CLI seam)
 *
 * Registered in both the MCP server (tools/register.ts) and the CLI TOOLS map
 * (cli.ts) so it is callable on the no-MCP run/gate path:
 *   node dist/cli.js resolveLensRoles --json '{"targetRepoRoot":"..."}'
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parse as yamlParse } from "yaml";
import { resolveLensRoleBinding, type LensRoleBinding, type RoleWithCapabilities } from "./judge-panel.js";
import { RoleCapabilitiesSchema } from "../schemas/catalogue.js";
import type { LensName } from "../schemas/lens-verdict.js";

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
 *  5. For each role, attempt to read declared capabilities from PERSONA.md
 *     frontmatter (`capabilities.review_lenses`). Roles without a capabilities
 *     block fall back to the built-in LENS_CANDIDATES list inside the matcher.
 *  6. Pass the enriched roster to `resolveLensRoleBinding`.
 *
 * Throws `LensJudgeUnavailableError` (from `resolveLensRoleBinding`) when the
 * hired roster is too small or too narrow to staff all five distinct lens judges.
 */
export async function resolveLensRoles(
  opts: ResolveLensRolesOptions,
): Promise<ResolveLensRolesResult> {
  const { targetRepoRoot } = opts;
  const teamDir = path.join(targetRepoRoot, "team");

  // Enumerate hired roles — mirrors getTeamSnapshot's roster enumeration.
  let dirEntries: string[];
  try {
    dirEntries = await fs.readdir(teamDir);
  } catch (err) {
    if (isEnoent(err)) {
      // No team directory → no hired roles → matching will throw LensJudgeUnavailableError.
      dirEntries = [];
    } else {
      throw err;
    }
  }

  const SKIP_DIRS = new Set(["custom", "_archived"]);
  const hiredRoles: string[] = [];

  for (const entry of dirEntries) {
    if (SKIP_DIRS.has(entry) || entry.startsWith(".")) {
      continue;
    }

    // Must be a directory with a PERSONA.md (same guard getTeamSnapshot uses).
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(path.join(teamDir, entry));
    } catch {
      continue;
    }
    if (!stat.isDirectory()) {
      continue;
    }

    // Check PERSONA.md exists — a directory without it is not a hired role.
    try {
      await fs.access(path.join(teamDir, entry, "PERSONA.md"));
    } catch {
      continue;
    }

    hiredRoles.push(entry);
  }

  // Lexicographic sort for output stability.
  hiredRoles.sort();

  // Read declared capabilities from each PERSONA.md.
  const rolesWithCapabilities: RoleWithCapabilities[] = await Promise.all(
    hiredRoles.map((roleId) => readRoleCapabilities(teamDir, roleId)),
  );

  // Throws LensJudgeUnavailableError when the roster cannot staff all five lenses.
  const lensRoles = resolveLensRoleBinding(rolesWithCapabilities);

  return { lensRoles, hiredRoles };
}

/**
 * Read the declared review-lens capabilities for a single role from its PERSONA.md.
 *
 * Parses only the YAML frontmatter (not the full persona body) to extract
 * `capabilities.review_lenses`. Silently falls back to `reviewLenses: undefined`
 * when:
 *  - The file cannot be read.
 *  - The frontmatter cannot be parsed.
 *  - The capabilities block is absent.
 *
 * `undefined` signals the matcher to fall back to LENS_CANDIDATES for this role,
 * preserving backward compatibility for pre-keystone PERSONA.md files.
 */
async function readRoleCapabilities(teamDir: string, roleId: string): Promise<RoleWithCapabilities> {
  const personaPath = path.join(teamDir, roleId, "PERSONA.md");

  let raw: string;
  try {
    raw = await fs.readFile(personaPath, "utf8");
  } catch {
    return { id: roleId, reviewLenses: undefined };
  }

  // Extract YAML frontmatter (between the opening and closing ---).
  const normalised = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (!normalised.startsWith("---\n")) {
    return { id: roleId, reviewLenses: undefined };
  }
  const closeIdx = normalised.indexOf("\n---", 4);
  if (closeIdx === -1) {
    return { id: roleId, reviewLenses: undefined };
  }
  const frontmatterRaw = normalised.slice(4, closeIdx);

  let parsedYaml: unknown;
  try {
    parsedYaml = yamlParse(frontmatterRaw);
  } catch {
    return { id: roleId, reviewLenses: undefined };
  }

  // Extract capabilities.review_lenses via the shared schema.
  if (
    typeof parsedYaml !== "object" ||
    parsedYaml === null ||
    !("capabilities" in parsedYaml)
  ) {
    // No capabilities block — fall back to LENS_CANDIDATES for this role.
    return { id: roleId, reviewLenses: undefined };
  }

  const capResult = RoleCapabilitiesSchema.safeParse(
    (parsedYaml as Record<string, unknown>)["capabilities"],
  );
  if (!capResult.success) {
    // Malformed capabilities block — fail safe to undefined (LENS_CANDIDATES fallback).
    return { id: roleId, reviewLenses: undefined };
  }

  return {
    id: roleId,
    reviewLenses: capResult.data.review_lenses as LensName[],
  };
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}
