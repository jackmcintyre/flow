/**
 * `summariseRetroProposal` — read-only summary tool for the `/flow:retro` skill.
 *
 * Story native:01KTZGEW6TSC6M84P9KJ7FD96S.
 *
 * The `/flow:retro` skill has no Read tool and only learns the proposal file
 * path from the retro-analyst subagent's locked handoff phrase:
 *   `Handoff to operator — retro proposal ready for review at <path>`.
 *
 * This tool accepts that absolute path, reads the file, splits its YAML
 * frontmatter via `splitFrontmatter`, parses it through the canonical
 * `parseRetroProposalFile` (the same reader `locate-proposal.ts` uses), and
 * returns a structured, renderable per-proposal summary so the skill can
 * surface the results inline without relying on subagent prose.
 *
 * **Deterministic seam.** The summary is derived entirely from the written
 * file — the frontmatter IS the source of truth. Because the retro skill
 * calls this tool after the analyst writes the file, the inline summary and
 * the file can never disagree. (Memory: `feedback_default_to_deterministic_seams`)
 *
 * **Empty-cycle handling.** When `proposals` is empty, the tool returns a
 * `noProposals: true` flag so the skill can render a plain "no recommended
 * changes this cycle" statement without implying recommendations exist.
 *
 * **No writes, no network.** This tool is strictly read-only. It never
 * writes, never mutates state, and never calls any external service.
 */

import { promises as fs } from "node:fs";
import { parse as yamlParse } from "yaml";
import { splitFrontmatter } from "../lib/markdown-frontmatter.js";
import {
  parseRetroProposalFile,
  type RetroProposal,
} from "../schemas/retro-proposal.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The structured result returned by `summariseRetroProposal`.
 *
 * When `noProposals` is true, `proposals` is empty and the skill MUST render
 * the no-changes statement rather than an empty table.
 *
 * Each entry in `proposals` carries:
 * - `type`      — the proposal's discriminator literal (e.g. "rule").
 * - `rationale` — the proposal's one-line rationale from the frontmatter.
 * - `id`        — the proposal's ULID (for traceability).
 */
export interface RetroProposalSummary {
  /** Absolute path of the proposal file that was read. */
  absPath: string;
  /** Total count of proposals in the file (may be 0). */
  totalCount: number;
  /**
   * True when `proposals` is empty (the cycle produced no recommendations).
   * The skill renders a plain "no recommended changes" statement in this case.
   */
  noProposals: boolean;
  /** Per-proposal summary entries (empty array when `noProposals` is true). */
  proposals: Array<{ type: RetroProposal["type"]; rationale: string; id: string }>;
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Read the proposal file at `absPath`, parse its frontmatter through
 * `parseRetroProposalFile`, and return a structured per-proposal summary.
 *
 * @param opts.absPath - Absolute path to the `.flow/retro-proposals/<ISO>.md` file.
 * @returns A structured summary for inline rendering by the retro skill.
 * @throws {MalformedRetroProposalError} When the file's frontmatter fails schema
 *   re-validation (propagated from `parseRetroProposalFile`).
 * @throws {Error} When the file cannot be read (e.g. ENOENT).
 */
export async function summariseRetroProposal(opts: {
  absPath: string;
}): Promise<RetroProposalSummary> {
  const { absPath } = opts;

  // Read the file — propagate ENOENT / permission errors to caller.
  const raw = await fs.readFile(absPath, "utf8");

  // Split frontmatter. splitFrontmatter throws CatalogueShapeError when
  // the frontmatter delimiters are missing; that propagates to the MCP
  // handler which surfaces it as an error response.
  const { frontmatterRaw } = splitFrontmatter(raw, absPath);

  // Parse via the canonical parser — throws MalformedRetroProposalError on failure.
  const parsedYaml = yamlParse(frontmatterRaw) as unknown;
  const file = parseRetroProposalFile(parsedYaml);

  // Build the per-proposal summary entries from the parsed frontmatter.
  // Each entry carries only type + rationale + id — enough for the skill
  // to render a concise inline summary.
  const proposals: RetroProposalSummary["proposals"] = file.proposals.map((p) => ({
    type: p.type,
    rationale: p.rationale,
    id: p.id,
  }));

  return {
    absPath,
    totalCount: proposals.length,
    noProposals: proposals.length === 0,
    proposals,
  };
}
