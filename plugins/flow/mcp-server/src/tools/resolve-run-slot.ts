/**
 * `resolveRunSlot` — read the live hired roster and return the role that fills
 * a given run job slot (build or review).
 *
 * Story native:01KVPQS1DVJE41KNG065D6X1X7 — dynamic builder/reviewer selection.
 *
 * Resolution algorithm (deterministic):
 *   1. Enumerate hired roles from `<targetRepoRoot>/team/`.
 *   2. For each role, read the `capabilities.run_jobs` field from PERSONA.md
 *      frontmatter. Roles without a capabilities block are treated as NOT
 *      qualified for any run job (back-compat — they cannot win a slot).
 *   3. Filter to roles that declare the requested job in their run_jobs array.
 *   4. **Generalist default wins**: if the built-in generalist for the slot is
 *      present and qualified (generalist-dev for 'build', generalist-reviewer
 *      for 'review'), return it regardless of other qualified roles.
 *   5. Otherwise, if exactly one other qualified role is found, return it.
 *   6. If no qualified role exists, throw `RunSlotUnstaffedError` naming the
 *      unstaffed slot — the run stops with a clear operator-facing message.
 *
 * The generalist names are the DEFAULT, not the only option. Any hired role that
 * declares `run_jobs: [build]` or `run_jobs: [review]` in its PERSONA.md
 * capabilities block can fill the slot when the corresponding generalist is absent.
 *
 * Registered in both the MCP server (tools/register.ts) and the CLI TOOLS map
 * (cli.ts) so it is callable on the no-MCP run path:
 *   node dist/cli.js resolveRunSlot --json '{"targetRepoRoot":"...","job":"build"}'
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parse as yamlParse } from "yaml";
import { RoleCapabilitiesSchema, type RunJob } from "../schemas/catalogue.js";
import { RunSlotUnstaffedError } from "../errors.js";

/** The built-in default role name for each run job. */
export const RUN_JOB_GENERALISTS: Record<RunJob, string> = {
  build: "generalist-dev",
  review: "generalist-reviewer",
};

export interface ResolveRunSlotOptions {
  targetRepoRoot: string;
  /** The run job slot to fill: 'build' (the dev slot) or 'review' (the reviewer slot). */
  job: RunJob;
}

export interface ResolveRunSlotResult {
  /** The role id that should fill this slot. */
  role: string;
  /**
   * True when the generalist default was chosen (either because it was the only
   * qualified role, or because it was present alongside other qualified roles).
   * False when a non-default qualified role won the slot.
   */
  isDefault: boolean;
}

/**
 * Enumerate hired roles from `<targetRepoRoot>/team/` and resolve the role that
 * fills the given run job slot.
 *
 * @throws {RunSlotUnstaffedError} When no hired role qualifies for the slot.
 */
export async function resolveRunSlot(
  opts: ResolveRunSlotOptions,
): Promise<ResolveRunSlotResult> {
  const { targetRepoRoot, job } = opts;
  const teamDir = path.join(targetRepoRoot, "team");
  const defaultRole = RUN_JOB_GENERALISTS[job];

  // Enumerate hired roles — mirrors resolveLensRoles / getTeamSnapshot.
  let dirEntries: string[];
  try {
    dirEntries = await fs.readdir(teamDir);
  } catch (err) {
    if (isEnoent(err)) {
      dirEntries = [];
    } else {
      throw err;
    }
  }

  const SKIP_DIRS = new Set(["custom", "_archived"]);
  const qualifiedRoles: string[] = [];

  for (const entry of dirEntries.sort()) {
    if (SKIP_DIRS.has(entry) || entry.startsWith(".")) {
      continue;
    }

    // Must be a directory with a PERSONA.md (same guard resolveLensRoles uses).
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(path.join(teamDir, entry));
    } catch {
      continue;
    }
    if (!stat.isDirectory()) {
      continue;
    }

    try {
      await fs.access(path.join(teamDir, entry, "PERSONA.md"));
    } catch {
      continue;
    }

    // Check whether this role declares the requested run job.
    const runJobs = await readRunJobs(teamDir, entry);
    if (runJobs !== undefined && runJobs.includes(job)) {
      qualifiedRoles.push(entry);
    } else if (runJobs === undefined && entry === defaultRole) {
      // Graceful default for built-in generalists hired before the catalogue
      // declared a capabilities block (e.g. teams hired at catalogue_version
      // 0.1.0 before the capabilities: block was added). The generalist-dev
      // default inherits the 'build' job; generalist-reviewer inherits 'review'.
      // Non-generalist roles without a capabilities block remain unqualified
      // (strict bias — no accidental slot mis-staffing).
      qualifiedRoles.push(entry);
    }
  }

  if (qualifiedRoles.length === 0) {
    throw new RunSlotUnstaffedError({ job });
  }

  // The generalist default wins whenever it is present and qualified —
  // this preserves backward-compatible behaviour for default teams.
  if (qualifiedRoles.includes(defaultRole)) {
    return { role: defaultRole, isDefault: true };
  }

  // No generalist — return the single other qualified role.
  // If multiple non-default roles are qualified, pick the first in lexicographic
  // order (deterministic, no guessing). The story does not require disambiguation
  // across multiple non-default roles — the generalist is the intended default;
  // operators who want a specific non-default role should ensure the generalist
  // is absent and only one non-default role declares the job.
  return { role: qualifiedRoles[0]!, isDefault: false };
}

/**
 * Read the declared `run_jobs` array from a PERSONA.md's frontmatter.
 *
 * Returns `undefined` when:
 *  - The file cannot be read.
 *  - The frontmatter cannot be parsed.
 *  - No capabilities block is present (back-compat: role not qualified by default).
 *
 * Returns an empty array (not undefined) when capabilities is declared but
 * `run_jobs` is absent or empty.
 */
async function readRunJobs(
  teamDir: string,
  roleId: string,
): Promise<RunJob[] | undefined> {
  const personaPath = path.join(teamDir, roleId, "PERSONA.md");

  let raw: string;
  try {
    raw = await fs.readFile(personaPath, "utf8");
  } catch {
    return undefined;
  }

  // Extract YAML frontmatter (between the opening and closing ---).
  const normalised = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (!normalised.startsWith("---\n")) {
    return undefined;
  }
  const closeIdx = normalised.indexOf("\n---", 4);
  if (closeIdx === -1) {
    return undefined;
  }
  const frontmatterRaw = normalised.slice(4, closeIdx);

  let parsedYaml: unknown;
  try {
    parsedYaml = yamlParse(frontmatterRaw);
  } catch {
    return undefined;
  }

  if (
    typeof parsedYaml !== "object" ||
    parsedYaml === null ||
    !("capabilities" in parsedYaml)
  ) {
    // No capabilities block — role is not qualified for any run job.
    return undefined;
  }

  const capResult = RoleCapabilitiesSchema.safeParse(
    (parsedYaml as Record<string, unknown>)["capabilities"],
  );
  if (!capResult.success) {
    // Malformed capabilities block — treat as no capabilities.
    return undefined;
  }

  return capResult.data.run_jobs as RunJob[];
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}
