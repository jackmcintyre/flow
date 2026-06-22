/**
 * `matchStorySpecialist` CLI tool — Story native:01KVPSZ14HH48J9NEH7N6S6QDR.
 *
 * Derives the specialist (if any) that should be auto-engaged for a story,
 * based on its cited-source paths and the hired specialists' declared
 * `capabilities.path_patterns`.
 *
 * Algorithm:
 *  1. Read the execution manifest at `manifestPath` to obtain `cited_sources`.
 *  2. Call `matchSpecialistByCitedSources` to find the first hired specialist
 *     whose `path_patterns` match any cited source (via picomatch).
 *  3. Return `{ role, domain }` when a specialist is matched, or
 *     `{ role: null, domain: null }` when no specialist's patterns match.
 *
 * **No-match is the happy path for stories outside any specialist's declared
 * area** — returns `{ role: null, domain: null }` and the run proceeds
 * generalist-only, unchanged from before this story shipped.
 *
 * Registered in both `register.ts` (MCP transport) and `cli.ts` (run-path
 * seam) so it is callable on the no-MCP run path:
 *   node dist/cli.js matchStorySpecialist \
 *     --json '{"targetRepoRoot":"...","manifestPath":"..."}'
 */

import { promises as fs } from "node:fs";
import { parse as yamlParse } from "yaml";
import { parseExecutionManifest } from "../schemas/execution-manifest.js";
import { matchSpecialistByCitedSources } from "./classify-story-lane.js";

export interface MatchStorySpecialistOptions {
  targetRepoRoot: string;
  /** Absolute path to the execution manifest (in-progress/). */
  manifestPath: string;
}

export interface MatchStorySpecialistResult {
  /** Role id of the matched specialist, or null when no specialist matches. */
  role: string | null;
  /** Domain string of the matched specialist, or null when no specialist matches. */
  domain: string | null;
}

/**
 * Derive the specialist to auto-engage for a story from its cited-source paths.
 *
 * @param opts.targetRepoRoot - Absolute path to the target repository root.
 * @param opts.manifestPath   - Absolute path to the execution manifest.
 * @returns `{ role, domain }` for the matched specialist, or `{ role: null, domain: null }`.
 */
export async function matchStorySpecialist(
  opts: MatchStorySpecialistOptions,
): Promise<MatchStorySpecialistResult> {
  const { targetRepoRoot, manifestPath } = opts;

  // Read the execution manifest to obtain cited_sources.
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch {
    // Manifest unreadable — treat as no-match (fail-soft).
    return { role: null, domain: null };
  }

  let manifest;
  try {
    const parsed = yamlParse(raw);
    manifest = parseExecutionManifest(parsed, { absPath: manifestPath });
  } catch {
    // Malformed manifest — treat as no-match (fail-soft).
    return { role: null, domain: null };
  }

  const citedSources = manifest.cited_sources ?? [];
  if (citedSources.length === 0) {
    return { role: null, domain: null };
  }

  const match = await matchSpecialistByCitedSources(citedSources, targetRepoRoot);
  if (!match) {
    return { role: null, domain: null };
  }

  return { role: match.role, domain: match.domain };
}
