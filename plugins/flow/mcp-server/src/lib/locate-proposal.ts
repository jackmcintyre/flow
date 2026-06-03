/**
 * Proposal id locator — Story 6.4 AC1.
 *
 * Resolves a proposal id to the single `.flow/retro-proposals/<ISO>.md` file
 * that contains a proposal with that id. Scans every proposal file in the
 * directory, splits the YAML frontmatter, and re-reads each through the
 * canonical `parseRetroProposalFile` parser — NEVER the rendered Markdown
 * body (the frontmatter is the source of truth, per Story 6.3).
 *
 * Returns the file's absolute path, the parsed file, and the matched proposal
 * object. The matched proposal is returned with its array index so the gate can
 * stamp the right element in-place when applying.
 *
 * Failure modes:
 *  - No match across all files               → `ProposalNotFoundError`
 *    (names the id and how many files were scanned). An empty or absent
 *    `.flow/retro-proposals/` directory is treated as "zero files scanned" and
 *    surfaces the same clean error rather than crashing.
 *  - Same id matched in two distinct files   → `AmbiguousProposalIdError`
 *    (ids are minted unique; a collision is a bug, not a silent pick-first).
 *
 * Mirrors the done-manifest scan pattern in `gather-retro-inputs.ts` (list a
 * dir, parse each file, collect).
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parse as yamlParse } from "yaml";
import { ProposalNotFoundError, AmbiguousProposalIdError } from "../errors.js";
import { splitFrontmatter } from "./markdown-frontmatter.js";
import {
  parseRetroProposalFile,
  type RetroProposal,
  type RetroProposalFile,
} from "../schemas/retro-proposal.js";

/**
 * The located proposal plus the context the gate needs to stamp and commit it.
 */
export interface LocatedProposal {
  /** Absolute path to the proposal markdown file the id resolved to. */
  absPath: string;
  /** Repo-relative path (used as the commit-stage path for the proposal file). */
  relPath: string;
  /** The parsed, schema-validated file the proposal lives in. */
  file: RetroProposalFile;
  /** The matched proposal object. */
  proposal: RetroProposal;
  /** The matched proposal's index in `file.proposals` (for in-place stamping). */
  index: number;
}

/**
 * Locate a proposal by id. See module JSDoc.
 *
 * @throws {ProposalNotFoundError}   When no proposal across all files matches.
 * @throws {AmbiguousProposalIdError} When the id matches in two distinct files.
 * @throws {MalformedRetroProposalError} When a proposal file fails schema
 *   re-validation (propagated from `parseRetroProposalFile`).
 */
export async function locateProposal(opts: {
  targetRepoRoot: string;
  proposalId: string;
}): Promise<LocatedProposal> {
  const { targetRepoRoot, proposalId } = opts;
  const proposalsDir = path.join(
    targetRepoRoot,
    ".flow",
    "retro-proposals",
  );

  let entries: string[];
  try {
    entries = await fs.readdir(proposalsDir);
  } catch (err) {
    if (isEnoent(err)) {
      // Empty/absent dir → zero files scanned → clean not-found, never a crash.
      throw new ProposalNotFoundError({ proposalId, filesScanned: 0 });
    }
    throw err;
  }

  // Deterministic alphabetical scan order so the ambiguity message is stable.
  const files = entries.filter((f) => f.endsWith(".md")).sort();

  const matches: LocatedProposal[] = [];

  for (const file of files) {
    const absPath = path.join(proposalsDir, file);
    const raw = await fs.readFile(absPath, "utf8");

    // The frontmatter (not the rendered body) is the source of truth.
    const { frontmatterRaw } = splitFrontmatter(raw, absPath);
    const parsedYaml = yamlParse(frontmatterRaw) as unknown;
    // Re-validate through the canonical parser — throws MalformedRetroProposalError.
    const parsedFile = parseRetroProposalFile(parsedYaml);

    parsedFile.proposals.forEach((proposal, index) => {
      if (proposal.id === proposalId) {
        matches.push({
          absPath,
          relPath: path.relative(targetRepoRoot, absPath),
          file: parsedFile,
          proposal,
          index,
        });
      }
    });
  }

  if (matches.length === 0) {
    throw new ProposalNotFoundError({
      proposalId,
      filesScanned: files.length,
    });
  }

  // A duplicated id ACROSS distinct files is an ambiguity bug. (A single file
  // cannot carry two proposals with the same id and round-trip through the
  // writer, but if a hand-authored file did, two matches in one file would also
  // surface here — both are bugs the operator must fix.)
  const distinctFiles = new Set(matches.map((m) => m.absPath));
  if (matches.length > 1 || distinctFiles.size > 1) {
    throw new AmbiguousProposalIdError({
      proposalId,
      matchingFiles: matches.map((m) => m.absPath),
    });
  }

  return matches[0]!;
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}
