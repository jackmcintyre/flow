import { promises as fs } from "node:fs";
import * as path from "node:path";
import { PersonaFileNotFoundError } from "../errors.js";
import { readPersona } from "./read-persona.js";

export interface LookupRoleByDomainOptions {
  targetRepoRoot: string;
  domain: string;
}

export interface LookupRoleByDomainResult {
  role: string | null;
}

/**
 * Exact-match domain routing over hired personas (FR99). Walks
 * `<targetRepoRoot>/team/`, parses every `<role>/PERSONA.md`, and
 * returns the role id whose `domain:` frontmatter is byte-equal to
 * the input. Returns `{ role: null }` when no team is hired, the
 * `team/` directory is absent, or no domain matches.
 *
 * Algorithm:
 *  1. If `team/` does not exist, return `{ role: null }` — no team hired
 *     is a valid state.
 *  2. List role subdirs. Filter out `custom` (Story 2.5's escape hatch
 *     — not in v1's lookup), `_archived` (FR107 — archived personas are
 *     not routing candidates), and any non-directory entry.
 *  3. For each role dir, call `readPersona`. Skip silently on
 *     `PersonaFileNotFoundError` (stray empty `team/<role>/` dir).
 *     Propagate `PersonaFileMalformedError` — a corrupt persona must
 *     not be invisibly excluded from routing.
 *  4. Exact-match `domain` — no fuzzy matching, no case-folding, no
 *     trimming. Return the first match.
 *
 * NOTE: Story 2.1 AC3 forbids domain collisions across the catalogue,
 * but a hand-edited persona could introduce one. v1 returns the first
 * encountered role on collision (filesystem traversal order, OS-
 * dependent). Epic 3 may add a routing-ambiguity diagnostic. (Story 2.3
 * FR99)
 */
export async function lookupRoleByDomain(
  opts: LookupRoleByDomainOptions,
): Promise<LookupRoleByDomainResult> {
  const teamDir = path.join(opts.targetRepoRoot, "team");

  try {
    await fs.stat(teamDir);
  } catch (err) {
    if (isEnoent(err)) {
      return { role: null };
    }
    throw err;
  }

  const entries = await fs.readdir(teamDir);
  for (const entry of entries) {
    if (entry === "custom" || entry === "_archived") continue;

    const subPath = path.join(teamDir, entry);
    let isDir = false;
    try {
      const stat = await fs.stat(subPath);
      isDir = stat.isDirectory();
    } catch (err) {
      if (isEnoent(err)) continue;
      throw err;
    }
    if (!isDir) continue;

    let persona;
    try {
      persona = await readPersona({
        targetRepoRoot: opts.targetRepoRoot,
        role: entry,
      });
    } catch (err) {
      if (err instanceof PersonaFileNotFoundError) {
        // Stray empty role directory with no PERSONA.md — silently
        // skip. Corrupt files (PersonaFileMalformedError) propagate.
        continue;
      }
      throw err;
    }

    if (persona.domain === opts.domain) {
      return { role: persona.role };
    }
  }

  return { role: null };
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}
