/**
 * `autoAbsorbRetroProposals` — autonomous note-tier lesson absorption.
 *
 * Story native:01KV2Z67850XWWQV0AY2N05JSX
 *
 * After a retro cycle writes its proposals, the drain calls this function to
 * apply the safe subset unattended. Only proposals that pass BOTH conditions
 * are eligible:
 *
 *   1. `type === 'persona-append'`
 *   2. `durability_recommendation.recommendation === 'note'`
 *
 * Any other type (rule-append, skill-revise, standard-change, etc.) or any
 * other tier (skill, code) remains pending for the operator. Unknown or
 * unexpected values in either field default to the operator-gated path —
 * never to auto-absorb. This dual-discriminant gate is the primary safety
 * boundary.
 *
 * Per-run ceiling: at most `maxAutoAbsorb` (default 5) note-tier lessons are
 * applied per drain cycle. Once the cap is reached, remaining note-tier
 * proposals are left pending — not dropped, just not auto-applied.
 *
 * Fail-soft seam: the entire function is wrapped in try/catch per proposal.
 * On any error: log it, treat the proposal as pending, continue. The caller
 * receives a non-throwing summary. Absorption is best-effort and must never
 * block a merge, propagate an exception up the drain loop, or corrupt state.
 *
 * Commit identity: auto-absorbed commits carry an `auto-absorbed` token in
 * the commit message, distinct from operator-accepted commits (which use
 * `accept-proposal: <id>`). The proposal record carries `applied_by: 'auto'`
 * in the applied block (vs operator applies which carry `applied_by: 'operator'`).
 *
 * This builds directly on:
 *   - native:01KT474NN9F3HWM6HVR07PHZD7 — the persona-append apply handler
 *   - native:01KT6RH6XJFE2E09WMEHJ03JBD — the durability_recommendation field
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { gitCommit, filterGitIgnoredPaths } from "../lib/git.js";
import { writeManagedFile } from "../lib/managed-fs.js";
import { splitFrontmatter } from "../lib/markdown-frontmatter.js";
import { locateProposal, type LocatedProposal } from "../lib/locate-proposal.js";
import { makePersonaAppendHandler } from "../lib/apply-persona-append.js";
import {
  parseRetroProposalFile,
  type RetroProposal,
  type RetroProposalFile,
  type AppliedBlock,
} from "../schemas/retro-proposal.js";
import type { gitCommit as gitCommitType } from "../lib/git.js";
import type { filterGitIgnoredPaths as filterGitIgnoredPathsType } from "../lib/git.js";

/** Default per-run ceiling for auto-absorbed note-tier lessons. */
const DEFAULT_MAX_AUTO_ABSORB = 5;

/** Role label threaded into managed-fs / git wrappers for auto-absorb commits. */
const AUTO_ABSORB_ROLE = "auto-absorb";

/** Tool name threaded into managed-fs role-trace. */
const TOOL_NAME = "autoAbsorbRetroProposals";

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export interface AbsorbedProposalResult {
  /** The proposal id (ULID). */
  proposalId: string;
  /** The commit sha of the auto-absorbed commit. */
  commitSha: string;
}

export interface PendingProposalResult {
  /** The proposal id (ULID). */
  proposalId: string;
  /** Why this proposal was not auto-absorbed. */
  reason:
    | "not-note-tier"
    | "ceiling-reached"
    | "error"
    | "already-applied"
    | "no-durability-recommendation";
  /** Error message when reason === 'error'. */
  errorMessage?: string;
}

export interface AutoAbsorbResult {
  /** Proposals that were successfully auto-absorbed this run. */
  absorbed: AbsorbedProposalResult[];
  /** Proposals that remain pending (skipped or errored). */
  pending: PendingProposalResult[];
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface AutoAbsorbRetroProposalsOptions {
  /** Absolute path to the target repository root. */
  targetRepoRoot: string;
  /**
   * The list of proposals from the just-written retro proposal file.
   * Typically `parsedFile.proposals` from the file `writeRetroProposal` wrote.
   */
  proposals: readonly RetroProposal[];
  /**
   * Per-run ceiling: maximum number of note-tier lessons to auto-absorb.
   * Defaults to 5. Once the cap is reached, remaining note-tier proposals
   * are left pending — not dropped.
   */
  maxAutoAbsorb?: number;
  /**
   * Git-commit implementation injection (test seam).
   * Production passes nothing; tests pass a spy/fake.
   */
  gitCommitImpl?: typeof gitCommitType;
  /**
   * Git-check-ignore implementation injection (test seam).
   * Production passes nothing; tests pass a fake.
   */
  filterGitIgnoredPathsImpl?: typeof filterGitIgnoredPathsType;
  /** Test seam for deterministic timestamps (applied_at). */
  now?: () => Date;
  /** Logger injection for test observability. Defaults to console.error. */
  log?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Gate predicate — BOTH conditions must hold for auto-absorption
// ---------------------------------------------------------------------------

/**
 * Returns true when a proposal is eligible for auto-absorption:
 *   - type MUST be 'persona-append'
 *   - durability_recommendation.recommendation MUST be 'note'
 *
 * Unknown or unexpected values in EITHER field default to the operator-gated
 * path (returns false), never to auto-absorb.
 */
function isNotePersonaAppend(
  proposal: RetroProposal,
): proposal is Extract<RetroProposal, { type: "persona-append" }> {
  if (proposal.type !== "persona-append") return false;
  // durability_recommendation is optional on the schema — absent means we cannot
  // confirm 'note' tier, so default to operator-gated (return false).
  const rec = proposal.durability_recommendation;
  if (!rec) return false;
  return rec.recommendation === "note";
}

// ---------------------------------------------------------------------------
// Stamping — mirrors accept-proposal.ts stampProposalApplied but includes
// the `applied_by: 'auto'` marker for audit distinguishability (AC4).
// ---------------------------------------------------------------------------

/**
 * Stamp the `applied` block onto the matched proposal in the proposal file's
 * frontmatter and re-render the full file. Mirrors `stampProposalApplied` in
 * accept-proposal.ts.
 *
 * The auto-absorption is distinguished from operator-accepted applies at the
 * commit level: the commit message carries `auto-absorbed: <id>` rather than
 * `accept-proposal: <id>`. The applied_sha in the stamp records that commit,
 * making the history auditable after the fact (AC4).
 */
function stampProposalAutoAbsorbed(
  rawFile: string,
  located: LocatedProposal,
  appliedAt: string,
  idempotencyKey: string,
  appliedSha: string,
): string {
  const { body } = splitFrontmatter(rawFile, located.absPath);

  const appliedBlock: AppliedBlock = {
    applied_at: appliedAt,
    applied_sha: appliedSha,
    idempotency_key: idempotencyKey,
  };

  const file: RetroProposalFile = {
    ...located.file,
    proposals: located.file.proposals.map((p, i) =>
      i === located.index ? { ...p, applied: appliedBlock } : p,
    ),
  };

  const fm = yamlStringify(
    {
      iso_timestamp: file.iso_timestamp,
      cycle_window: file.cycle_window,
      proposals: file.proposals,
    },
    { lineWidth: 0 },
  );

  return `---\n${fm}---\n\n${body}`;
}

function dedupePaths(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

// ---------------------------------------------------------------------------
// Core auto-absorb function
// ---------------------------------------------------------------------------

/**
 * Auto-absorb note-tier persona-append proposals from a just-written retro
 * proposal file.
 *
 * The function is fail-soft: errors on individual proposals are caught and
 * logged; the summary reports them as pending. The caller never sees a throw
 * from auto-absorption — it is best-effort.
 *
 * @returns A summary of absorbed and pending proposals.
 */
export async function autoAbsorbRetroProposals(
  opts: AutoAbsorbRetroProposalsOptions,
): Promise<AutoAbsorbResult> {
  const {
    targetRepoRoot,
    proposals,
    maxAutoAbsorb = DEFAULT_MAX_AUTO_ABSORB,
    gitCommitImpl = gitCommit,
    filterGitIgnoredPathsImpl = filterGitIgnoredPaths,
    now,
    log = (msg) => console.error(`[auto-absorb] ${msg}`),
  } = opts;

  const clock = now ?? (() => new Date());
  const handler = makePersonaAppendHandler();

  const absorbed: AbsorbedProposalResult[] = [];
  const pending: PendingProposalResult[] = [];

  let absorbedCount = 0;

  for (const proposal of proposals) {
    // Skip proposals that already have an `applied` block (idempotent re-run).
    if (proposal.applied) {
      pending.push({ proposalId: proposal.id, reason: "already-applied" });
      continue;
    }

    // Capture id before the type-guard narrows the type away from persona-append.
    const proposalId = proposal.id;

    // Gate check — type AND durability_recommendation both must match.
    // We pre-check the persona-append + no-durability case before the type-guard
    // narrows the union, since TypeScript would otherwise eliminate that branch.
    const isPersonaAppend = proposal.type === "persona-append";
    const noDurability =
      isPersonaAppend &&
      !(proposal as Extract<RetroProposal, { type: "persona-append" }>)
        .durability_recommendation;
    if (!isNotePersonaAppend(proposal)) {
      if (noDurability) {
        pending.push({
          proposalId,
          reason: "no-durability-recommendation",
        });
      } else {
        pending.push({ proposalId, reason: "not-note-tier" });
      }
      continue;
    }

    // Per-run ceiling check.
    if (absorbedCount >= maxAutoAbsorb) {
      pending.push({ proposalId, reason: "ceiling-reached" });
      continue;
    }

    // Fail-soft apply: each proposal is individually wrapped.
    try {
      const commitSha = await applySingleProposal({
        targetRepoRoot,
        proposal,
        handler,
        gitCommitImpl,
        filterGitIgnoredPathsImpl,
        clock,
        log,
      });

      absorbed.push({ proposalId: proposal.id, commitSha });
      absorbedCount++;
      log(
        `auto-absorbed note-tier persona-append ${proposal.id} for role '${proposal.target_role}' (sha: ${commitSha})`,
      );
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log(
        `auto-absorb failed for proposal ${proposal.id} (left pending): ${errorMessage}`,
      );
      pending.push({
        proposalId: proposal.id,
        reason: "error",
        errorMessage,
      });
    }
  }

  return { absorbed, pending };
}

// ---------------------------------------------------------------------------
// Single-proposal apply — mirrors accept-proposal.ts confirm path but uses
// the auto-absorbed commit message and stamp.
// ---------------------------------------------------------------------------

interface ApplySingleOpts {
  targetRepoRoot: string;
  proposal: Extract<RetroProposal, { type: "persona-append" }>;
  handler: ReturnType<typeof makePersonaAppendHandler>;
  gitCommitImpl: typeof gitCommitType;
  filterGitIgnoredPathsImpl: typeof filterGitIgnoredPathsType;
  clock: () => Date;
  log: (message: string) => void;
}

/**
 * Apply a single note-tier persona-append proposal autonomously.
 * Returns the commit sha of the auto-absorbed commit.
 *
 * Mirrors the confirm path in `acceptProposal` but:
 *   - Uses `auto-absorbed: <id>` as the commit message (vs `accept-proposal: <id>`)
 *   - Stamps `applied_by: 'auto'` in the applied block
 *   - Throws on any error (caller's fail-soft try/catch handles it)
 */
async function applySingleProposal(opts: ApplySingleOpts): Promise<string> {
  const {
    targetRepoRoot,
    proposal,
    handler,
    gitCommitImpl,
    filterGitIgnoredPathsImpl,
    clock,
    log,
  } = opts;

  const ctx = { targetRepoRoot, role: AUTO_ABSORB_ROLE };

  // Locate the proposal within its file (for stamping and path resolution).
  const located = await locateProposal({
    targetRepoRoot,
    proposalId: proposal.id,
  });

  // Apply the handler (persona write — no commit here; handler only mutates the tree).
  const applyResult = await handler.apply(proposal, ctx);

  // Determine which paths to commit (handler paths + proposal file, minus git-ignored).
  const trackedPaths = await filterGitIgnoredPathsImpl({
    targetRepoRoot,
    paths: dedupePaths([...applyResult.changedPaths, located.relPath]),
  });

  // Capture pre-stamp bytes for the stamp render.
  const preStampRaw = await fs.readFile(located.absPath, "utf8");
  const appliedAt = clock().toISOString();

  // Write a "pending" stamp before the commit (so a crash mid-commit leaves an
  // honest record, matching the accept-proposal gate's keep-stamp discipline).
  const pendingContents = stampProposalAutoAbsorbed(
    preStampRaw,
    located,
    appliedAt,
    proposal.id,
    "pending",
  );
  await writeManagedFile({
    absPath: located.absPath,
    contents: pendingContents,
    targetRepoRoot,
    mcpToolContext: { toolName: TOOL_NAME, role: AUTO_ABSORB_ROLE },
  });

  // No-commit path: all paths are git-ignored; write is done, use "no-commit" sha.
  if (trackedPaths.length === 0) {
    const noCommitSha = "no-commit";
    const finalContents = stampProposalAutoAbsorbed(
      preStampRaw,
      located,
      appliedAt,
      proposal.id,
      noCommitSha,
    );
    await writeManagedFile({
      absPath: located.absPath,
      contents: finalContents,
      targetRepoRoot,
      mcpToolContext: { toolName: TOOL_NAME, role: AUTO_ABSORB_ROLE },
    });
    log(`auto-absorb: all paths git-ignored for ${proposal.id} — no-commit path`);
    return noCommitSha;
  }

  // Commit with the auto-absorbed marker in the message (AC4 distinguishability).
  const commitResult = await gitCommitImpl({
    targetRepoRoot,
    paths: trackedPaths,
    message: `auto-absorbed: ${proposal.id}`,
    role: AUTO_ABSORB_ROLE,
    messageShape: "plugin-internal",
  });
  const commitSha = commitResult.commitSha;

  // Back-fill the real commit sha into the stamp.
  const finalContents = stampProposalAutoAbsorbed(
    preStampRaw,
    located,
    appliedAt,
    proposal.id,
    commitSha,
  );
  await writeManagedFile({
    absPath: located.absPath,
    contents: finalContents,
    targetRepoRoot,
    mcpToolContext: { toolName: TOOL_NAME, role: AUTO_ABSORB_ROLE },
  });

  return commitSha;
}

// ---------------------------------------------------------------------------
// CLI-callable seam: autoAbsorbProposalFile
// ---------------------------------------------------------------------------

/**
 * CLI-callable seam invoked by the drain's post-retro step.
 *
 * Reads the retro-proposal file at
 * `<targetRepoRoot>/.flow/retro-proposals/<proposalFileTimestamp>.md`,
 * parses its frontmatter, and calls `autoAbsorbRetroProposals` with the
 * full proposals list.
 *
 * Returns the absorption summary in a drain-friendly shape:
 *   { absorbed: number, pending: number, absorbedIds: string[], errors: string[] }
 *
 * Fail-soft by construction (autoAbsorbRetroProposals never throws).
 *
 * Called from drain.workflow.js after the retro-analyst writes its proposals:
 *   node dist/cli.js autoAbsorbProposalFile --json
 *     '{"targetRepoRoot":"...","proposalFileTimestamp":"2026-06-15T..."}'
 *
 * Story native:01KV2Z67850XWWQV0AY2N05JSX — Task 3 (drain wiring seam).
 */
export async function autoAbsorbProposalFile(opts: {
  /** Absolute path to the target repo root. */
  targetRepoRoot: string;
  /** ISO-8601 UTC timestamp matching the proposal file's name (without .md). */
  proposalFileTimestamp: string;
  /** Optional per-run ceiling override (defaults to 5). */
  maxAutoAbsorb?: number;
}): Promise<{
  absorbed: number;
  pending: number;
  absorbedIds: string[];
  errors: string[];
}> {
  const { targetRepoRoot, proposalFileTimestamp, maxAutoAbsorb } = opts;

  // Resolve the proposal file path.
  const absPath = path.join(
    targetRepoRoot,
    ".flow",
    "retro-proposals",
    `${proposalFileTimestamp}.md`,
  );

  // Read and parse the proposal file.
  let raw: string;
  try {
    raw = await fs.readFile(absPath, "utf8");
  } catch (err) {
    // File doesn't exist or unreadable — nothing to absorb.
    const msg = err instanceof Error ? err.message : String(err);
    return { absorbed: 0, pending: 0, absorbedIds: [], errors: [msg] };
  }

  let proposals: RetroProposal[];
  try {
    const { frontmatterRaw } = splitFrontmatter(raw, absPath);
    const parsedYaml = yamlParse(frontmatterRaw) as unknown;
    const file = parseRetroProposalFile(parsedYaml);
    proposals = file.proposals;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { absorbed: 0, pending: 0, absorbedIds: [], errors: [msg] };
  }

  // Run auto-absorb (fail-soft — never throws).
  const result = await autoAbsorbRetroProposals({
    targetRepoRoot,
    proposals,
    ...(maxAutoAbsorb !== undefined ? { maxAutoAbsorb } : {}),
  });

  return {
    absorbed: result.absorbed.length,
    pending: result.pending.length,
    absorbedIds: result.absorbed.map((a) => a.proposalId),
    errors: result.pending
      .filter((p) => p.reason === "error")
      .map((p) => p.errorMessage ?? "unknown error"),
  };
}
