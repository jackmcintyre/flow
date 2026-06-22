/**
 * `unhirePersona` — safely set aside a teammate reversibly.
 *
 * Moves `team/<role>/PERSONA.md` to `team/_archived/<role>/PERSONA.md`,
 * stamping `archived_at` via an injectable clock seam. Never deletes.
 *
 * Guard (Story native:01KVF66HWKXCM7GYNRR9YJFKB2):
 *   Before archiving, compute the post-unhire roster (current live roles minus
 *   the removed role) and run `resolveLensRoleBinding` over it. If any of the
 *   five judge-panel lens slots can no longer be staffed, the unhire is refused
 *   with `UnhireBelowJudgeMinimumError` naming the first uncovered lens. This
 *   reuses the exact same bipartite matcher the judge panel uses — NOT a
 *   hardcoded head-count — so the guard reflects the real structural floor.
 *
 * Idempotency:
 *   - Role absent from live team but present in team/_archived/<role>/PERSONA.md
 *     → clean no-op result.
 *   - Role absent from both live team and archive → `RoleNotHiredError`.
 *
 * Registration: 4-touch pattern (this file + tool-input-schemas.ts + register.ts
 * + cli.ts).
 *
 * (Story native:01KVF66HWKXCM7GYNRR9YJFKB2)
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parse as yamlParse } from "yaml";
import { RoleNotHiredError, UnhireBelowJudgeMinimumError } from "../errors.js";
import { writeManagedFile } from "../lib/managed-fs.js";
import { resolveLensRoleBinding, type RoleWithCapabilities } from "./judge-panel.js";
import { LensJudgeUnavailableError } from "../errors.js";
import { RoleCapabilitiesSchema } from "../schemas/catalogue.js";
import type { LensName } from "../schemas/lens-verdict.js";

export interface UnhirePersonaOptions {
  targetRepoRoot: string;
  role: string;
  /**
   * Test seam. Production callers omit; the default `() => new Date()` is the
   * v1 runtime clock. The stamp is written as `archived_at` into the relocated
   * PERSONA.md frontmatter line (appended at the end of the YAML front-matter).
   */
  clock?: () => Date;
}

export type UnhirePersonaResult =
  | { status: "archived"; archivedPath: string; archivedAt: string }
  | { status: "already-archived"; archivedPath: string };

/**
 * Read declared review-lens capabilities from a PERSONA.md frontmatter.
 *
 * Returns `undefined` when the file cannot be read, the frontmatter cannot be
 * parsed, or the capabilities block is absent — signalling the matcher to fall
 * back to LENS_CANDIDATES for this role (backward compatibility).
 */
async function readPersonaCapabilities(personaPath: string): Promise<LensName[] | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(personaPath, "utf8");
  } catch {
    return undefined;
  }

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
    return undefined;
  }

  const capResult = RoleCapabilitiesSchema.safeParse(
    (parsedYaml as Record<string, unknown>)["capabilities"],
  );
  if (!capResult.success) {
    return undefined;
  }

  return capResult.data.review_lenses as LensName[];
}

/**
 * Enumerate live hired roles from `<targetRepoRoot>/team/`, including their
 * declared capabilities read from each PERSONA.md frontmatter.
 *
 * Mirrors the enumeration logic in `resolveLensRoles` and `getTeamSnapshot`,
 * extended to also read capabilities for the guard check.
 */
async function enumerateHiredRolesWithCapabilities(
  targetRepoRoot: string,
): Promise<RoleWithCapabilities[]> {
  const teamDir = path.join(targetRepoRoot, "team");

  let dirEntries: string[];
  try {
    dirEntries = await fs.readdir(teamDir);
  } catch (err) {
    if (isEnoent(err)) {
      return [];
    }
    throw err;
  }

  const SKIP_DIRS = new Set(["custom", "_archived"]);
  const roleIds: string[] = [];

  for (const entry of dirEntries) {
    if (SKIP_DIRS.has(entry) || entry.startsWith(".")) {
      continue;
    }

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

    roleIds.push(entry);
  }

  roleIds.sort();

  // Read capabilities for each role.
  const roles: RoleWithCapabilities[] = await Promise.all(
    roleIds.map(async (id) => {
      const reviewLenses = await readPersonaCapabilities(
        path.join(teamDir, id, "PERSONA.md"),
      );
      return { id, reviewLenses };
    }),
  );

  return roles;
}

/**
 * Safely set aside a teammate reversibly.
 *
 * Steps:
 *  1. Enumerate the live roster from `team/`, reading each role's capabilities.
 *  2. Check if the role is in the live roster.
 *     - If absent and archived → no-op result.
 *     - If absent in both → `RoleNotHiredError`.
 *  3. Compute the post-unhire roster (live roster minus the target role).
 *  4. Run `resolveLensRoleBinding` over the post-unhire roster (with capabilities).
 *     - If any lens goes uncovered → `UnhireBelowJudgeMinimumError` naming the lens.
 *  5. Read the live `PERSONA.md`.
 *  6. Write the file to `team/_archived/<role>/PERSONA.md` with `archived_at`
 *     appended to the YAML frontmatter, via `writeManagedFile`.
 *  7. Remove the live `team/<role>/PERSONA.md` and the now-empty `team/<role>/` dir.
 */
export async function unhirePersona(
  opts: UnhirePersonaOptions,
): Promise<UnhirePersonaResult> {
  const { targetRepoRoot, role } = opts;
  const clock = opts.clock ?? (() => new Date());

  const livePersonaPath = path.join(targetRepoRoot, "team", role, "PERSONA.md");
  const archivedPersonaPath = path.join(
    targetRepoRoot,
    "team",
    "_archived",
    role,
    "PERSONA.md",
  );

  // --- Step 1: enumerate live roster with capabilities ---
  const hiredRolesWithCaps = await enumerateHiredRolesWithCapabilities(targetRepoRoot);
  const isHired = hiredRolesWithCaps.some((r) => r.id === role);

  // --- Step 2: handle absent cases ---
  if (!isHired) {
    // Check if already archived (idempotent no-op).
    let alreadyArchived = false;
    try {
      await fs.access(archivedPersonaPath);
      alreadyArchived = true;
    } catch {
      /* not in archive either */
    }

    if (alreadyArchived) {
      return { status: "already-archived", archivedPath: archivedPersonaPath };
    }

    throw new RoleNotHiredError({ role });
  }

  // --- Step 3: compute post-unhire roster ---
  const postUnhireRoster = hiredRolesWithCaps.filter((r) => r.id !== role);

  // --- Step 4: judge-panel guard (bipartite matching with capabilities) ---
  let unstaffedLens: string | null = null;
  try {
    resolveLensRoleBinding(postUnhireRoster);
  } catch (err) {
    if (err instanceof LensJudgeUnavailableError) {
      // Extract the lens name from the error message.
      // The error always names the lens that is uncovered.
      unstaffedLens = err.lens;
    } else {
      throw err;
    }
  }

  if (unstaffedLens !== null) {
    throw new UnhireBelowJudgeMinimumError({ role, unstaffedLens });
  }

  // --- Step 5: read the live PERSONA.md ---
  const liveContents = await fs.readFile(livePersonaPath, "utf8");

  // --- Step 6: write to archive location, stamping archived_at ---
  const archivedAt = clock().toISOString();
  const archivedContents = stampArchivedAt(liveContents, archivedAt);

  await writeManagedFile({
    absPath: archivedPersonaPath,
    contents: archivedContents,
    targetRepoRoot,
    mcpToolContext: { toolName: "unhirePersona", role },
  });

  // --- Step 7: remove the live persona file and its directory ---
  await fs.unlink(livePersonaPath);
  // Remove the (now-empty) role directory if it has no other contents.
  const roleDirPath = path.join(targetRepoRoot, "team", role);
  try {
    const remaining = await fs.readdir(roleDirPath);
    if (remaining.length === 0) {
      await fs.rmdir(roleDirPath);
    }
  } catch {
    // Non-fatal: directory may already be gone or contain other files.
  }

  return { status: "archived", archivedPath: archivedPersonaPath, archivedAt };
}

/**
 * Append `archived_at: "<iso>"` to the YAML frontmatter of a PERSONA.md.
 *
 * If the file begins with `---` (YAML front-matter), the stamp is inserted
 * just before the closing `---` line. If there is no front-matter, the stamp
 * is prepended as a minimal YAML block.
 *
 * Exported for unit testing.
 */
export function stampArchivedAt(contents: string, archivedAt: string): string {
  const stamp = `archived_at: "${archivedAt}"`;

  const lines = contents.split("\n");

  // Find opening and closing frontmatter delimiters.
  if (lines[0]?.trim() === "---") {
    // Find the closing ---
    let closeIdx = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]?.trim() === "---") {
        closeIdx = i;
        break;
      }
    }
    if (closeIdx !== -1) {
      // Insert stamp before the closing ---.
      const before = lines.slice(0, closeIdx);
      const after = lines.slice(closeIdx);
      return [...before, stamp, ...after].join("\n");
    }
  }

  // No front-matter — prepend a minimal YAML block.
  return `---\n${stamp}\n---\n\n${contents}`;
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}
