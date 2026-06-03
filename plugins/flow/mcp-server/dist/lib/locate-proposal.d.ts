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
import { type RetroProposal, type RetroProposalFile } from "../schemas/retro-proposal.js";
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
export declare function locateProposal(opts: {
    targetRepoRoot: string;
    proposalId: string;
}): Promise<LocatedProposal>;
