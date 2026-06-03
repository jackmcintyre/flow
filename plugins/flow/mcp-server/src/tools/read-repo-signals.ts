import { promises as fs, type Dirent } from "node:fs";
import * as path from "node:path";
import { readRecentCommitTitles } from "../lib/git.js";
import {
  detectDependencyManifests,
  detectLanguagesFromLayout,
  truncateReadmeExcerpt,
} from "../lib/repo-signal-detectors.js";
import {
  RepoSignalsSchema,
  type RepoSignals,
} from "../schemas/repo-signals.js";

export interface ReadRepoSignalsOptions {
  targetRepoRoot: string;
}

/**
 * Return a typed `RepoSignals` payload describing the target repo at a
 * high level (Story 2.4, FR85). The hiring manager subagent consumes
 * this as initial context to drive a project-shaped team proposal.
 *
 * Best-effort downgrades: missing README (ENOENT) → `readmeExcerpt = ""`;
 * `git log` non-zero exit (no git, no commits, not a repo) →
 * `recentCommitTitles = []`. Other IO errors propagate — they indicate a
 * misconfigured repo, not "no signal."
 *
 * No telemetry — `readRepoSignals` is a synchronous read-only diagnostic
 * (NFR21).
 */
export async function readRepoSignals(
  opts: ReadRepoSignalsOptions,
): Promise<RepoSignals> {
  const dirents = await fs.readdir(opts.targetRepoRoot, {
    withFileTypes: true,
  });
  // Filter out dotfiles except `.flow` (operator-observable plugin marker).
  const topLevelLayout = dirents
    .map((d) => d.name)
    .filter((name) => !name.startsWith(".") || name === ".flow")
    .sort();

  // Primary language scan from top-level entries. If it returns [] (common for
  // monorepos where manifests live under src/ or packages/), do a depth-1 scan
  // of immediate subdirectories and retry — capped at one level, no recursion.
  let languages = detectLanguagesFromLayout(topLevelLayout);
  if (languages.length === 0) {
    const subEntries = await collectDepthOneManifests(opts.targetRepoRoot, dirents);
    if (subEntries.length > 0) {
      languages = detectLanguagesFromLayout(subEntries);
    }
  }
  const dependencyManifests = detectDependencyManifests(topLevelLayout);

  const readmePath = path.join(opts.targetRepoRoot, "README.md");
  let readmeExcerpt = "";
  try {
    const raw = await fs.readFile(readmePath, "utf8");
    readmeExcerpt = truncateReadmeExcerpt(raw);
  } catch (err) {
    if (!isEnoent(err)) {
      throw err;
    }
    // ENOENT → leave readmeExcerpt as "".
  }

  const recentCommitTitles = await readRecentCommitTitles({
    cwd: opts.targetRepoRoot,
    limit: 5,
  });

  const payload: RepoSignals = {
    targetRepoRoot: opts.targetRepoRoot,
    languages,
    topLevelLayout,
    readmeExcerpt,
    recentCommitTitles,
    dependencyManifests,
  };

  return RepoSignalsSchema.parse(payload);
}

/**
 * Scan immediate subdirectories (depth 1 only) for recognisable manifest
 * filenames and return a flat list of those filenames. Used as a fallback
 * when the root scan yields no languages (monorepo with source under src/).
 * Errors from individual subdirectory reads are silently skipped — this is
 * a best-effort signal, not a hard requirement.
 */
async function collectDepthOneManifests(
  repoRoot: string,
  rootDirents: Dirent[],
): Promise<string[]> {
  const found: string[] = [];
  for (const dirent of rootDirents) {
    if (!dirent.isDirectory()) continue;
    // Skip hidden directories and the node_modules / .git noise.
    if (dirent.name.startsWith(".") || dirent.name === "node_modules") continue;
    try {
      const children = await fs.readdir(path.join(repoRoot, dirent.name));
      for (const child of children) {
        found.push(child);
      }
    } catch {
      // Unreadable subdirectory — skip silently.
    }
  }
  return found;
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}
