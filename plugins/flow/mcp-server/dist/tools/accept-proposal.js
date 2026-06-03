/**
 * `acceptProposal` MCP tool — the `/accept-proposal <id>` diff-then-confirm
 * gate. Story 6.4 (the keystone of Epic 6b; FR61, NFR10).
 *
 * **One apply gate every other 6b story plugs into.** It is kind-agnostic — it
 * never reads kind-specific proposal fields. It:
 *   1. locates a proposal by id (`locateProposal`),
 *   2. short-circuits if the proposal already carries an `applied` block
 *      (idempotent no-op, AC4),
 *   3. dispatches by `proposal.type` to a handler registry — a miss fails
 *      closed via `ProposalKindNotApplicableYetError` BEFORE any preview or
 *      state touch (AC6),
 *   4. in preview mode (`confirm` absent/false) renders the handler's diff and
 *      returns `preview` — no write, no commit, no telemetry (AC2),
 *   5. in confirm mode (`confirm: true`) runs the handler, stamps the proposal
 *      `applied`, commits the handler's changed paths + the proposal stamp in a
 *      single commit through the git wrapper, emits one
 *      `retro.proposal.applied` telemetry event, and returns `applied` (AC3,
 *      AC5).
 *
 * **Two-phase, deterministic seam.** A subagent/CLI cannot hold an interactive
 * prompt, so the confirm gate is two tool calls, not a blocking prompt — the
 * load-bearing decision lives in the tool layer, not skill prose. The
 * `/flow:accept-proposal` skill orchestrates: preview → show diff → ask the
 * operator → on an explicit yes, call again with `confirm: true`. A declined
 * apply is simply "the operator never makes the confirm call" — nothing
 * changed, fully re-runnable.
 *
 * **Scope (Story 6.4).** This ships ONLY the gate machinery. The production
 * handler registry is EMPTY — every kind fails closed via AC6. The gate is
 * proven end-to-end with a test-injected fake handler. The first real handler
 * arrives in Story 6.5.
 *
 * **Atomicity (partial-failure).** Order on a confirmed apply:
 *   handler `apply` → stamp the proposal file `applied` → commit (handler paths
 *   + proposal file) in a single commit → emit telemetry → return.
 * The `applied_sha` stamped on disk is the sha of THIS commit. Because a commit
 * cannot name its own sha before it exists, the stamp is written, committed,
 * and then the on-disk file is re-stamped with the real sha (a managed write of
 * the canonical proposal file — NOT a second story commit). If the commit
 * throws, the stamp write is rolled back to the pre-stamp bytes so a re-run is
 * clean (a stamp with no commit would make a real change un-repeatable).
 * Telemetry is emitted only AFTER a successful commit.
 *
 * **`idempotency_key`** is the proposal's stable `id` (a ULID). The AC4 re-run
 * check keys on the PRESENCE of the persisted `applied` block (not on the sha),
 * so it is robust to the post-commit sha back-fill.
 */
import { promises as fs } from "node:fs";
import { stringify as yamlStringify } from "yaml";
import { gitCommit, filterGitIgnoredPaths } from "../lib/git.js";
import { logTelemetryEvent } from "../lib/logger.js";
import { writeManagedFile } from "../lib/managed-fs.js";
import { splitFrontmatter } from "../lib/markdown-frontmatter.js";
import { locateProposal } from "../lib/locate-proposal.js";
import { ProposalKindNotApplicableYetError } from "../errors.js";
import { createProductionRegistry, KIND_TO_STORY, } from "../lib/proposal-apply-registry.js";
const TOOL_NAME = "acceptProposal";
const DEFAULT_ROLE = "operator";
// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------
export async function acceptProposal(opts) {
    const { targetRepoRoot, proposalId, confirm = false, role = DEFAULT_ROLE, handlers = createProductionRegistry(), gitCommitImpl = gitCommit, filterGitIgnoredPathsImpl = filterGitIgnoredPaths, now, } = opts;
    const clock = now ?? (() => new Date());
    // 1. Locate. Throws ProposalNotFoundError / AmbiguousProposalIdError /
    //    MalformedRetroProposalError verbatim.
    const located = await locateProposal({ targetRepoRoot, proposalId });
    const { proposal } = located;
    // 2. Idempotency check on the PERSISTED `applied` block (survives process
    //    boundaries). No handler call, no write, no commit, no telemetry. (AC4)
    if (proposal.applied) {
        return {
            status: "already-applied",
            proposalId,
            type: proposal.type,
            appliedSha: proposal.applied.applied_sha,
            appliedAt: proposal.applied.applied_at,
        };
    }
    // 3. Dispatch by kind. A miss fails closed BEFORE any preview render or state
    //    touch. In Story 6.4 the production registry is empty, so every kind
    //    fails here unless a handler is injected (tests). (AC6)
    const handler = handlers.get(proposal.type);
    if (!handler) {
        throw new ProposalKindNotApplicableYetError({
            kind: proposal.type,
            story: KIND_TO_STORY[proposal.type] ?? "a later story",
        });
    }
    const ctx = { targetRepoRoot, role };
    // 4. Preview mode — render the handler's diff. No mutation, no commit, no
    //    telemetry; the working tree is byte-identical after this call. (AC2)
    if (!confirm) {
        const diff = await handler.previewDiff(proposal, ctx);
        return { status: "preview", proposalId, type: proposal.type, diff };
    }
    // 5. Confirm mode — apply, stamp, commit (single commit), telemetry. (AC3/AC5)
    const applyResult = await handler.apply(proposal, ctx);
    // Filter the handler's changed paths: exclude git-ignored paths so we never
    // try to commit a file git doesn't track (e.g. files under .gitignore'd dirs).
    // The proposal file itself is always tracked (it lives under .flow/retro-proposals
    // which is NOT ignored in this repo), so it is not filtered.
    // (Story native:01KT6QF3V113W7GTG69B2RPVH0 — AC2)
    const trackedHandlerPaths = await filterGitIgnoredPathsImpl({
        targetRepoRoot,
        paths: applyResult.changedPaths,
    });
    // Capture pre-stamp bytes so a failed commit can be rolled back, leaving the
    // proposal un-stamped (atomicity: a stamp with no commit is un-repeatable).
    const preStampRaw = await fs.readFile(located.absPath, "utf8");
    const appliedAt = clock().toISOString();
    // Stamp the proposal file with the applied block (sha back-filled after the
    // commit — see module JSDoc). Write through the managed-fs guard.
    // The stamp is written unconditionally here — BEFORE any git ops — so that
    // a re-run (after a crash or all-ignored no-commit path) detects the stamp
    // and exits as a no-op. (Story native:01KT6QF3V113W7GTG69B2RPVH0 — AC1)
    const stampedContents = stampProposalApplied(preStampRaw, located, appliedAt, proposal.id, "pending");
    await writeManagedFile({
        absPath: located.absPath,
        contents: stampedContents,
        targetRepoRoot,
        mcpToolContext: { toolName: TOOL_NAME, role },
    });
    // When all handler paths are git-ignored and there are no tracked changes,
    // skip the commit entirely — the disk write has already happened and the
    // proposal is stamped. Use "no-commit" as the applied sha sentinel.
    // (Story native:01KT6QF3V113W7GTG69B2RPVH0 — AC1/AC2)
    if (trackedHandlerPaths.length === 0) {
        const noCommitSha = "no-commit";
        const finalContents = stampProposalApplied(preStampRaw, located, appliedAt, proposal.id, noCommitSha);
        await writeManagedFile({
            absPath: located.absPath,
            contents: finalContents,
            targetRepoRoot,
            mcpToolContext: { toolName: TOOL_NAME, role },
        });
        await logTelemetryEvent({
            targetRepoRoot,
            event: {
                type: "retro.proposal.applied",
                session_id: proposal.id,
                agent: role,
                data: {
                    id: proposal.id,
                    proposal_type: proposal.type,
                    applied_sha: noCommitSha,
                    idempotency_key: proposal.id,
                },
            },
            ...(now ? { now } : {}),
        });
        return {
            status: "applied",
            proposalId,
            type: proposal.type,
            appliedSha: noCommitSha,
            idempotencyKey: proposal.id,
        };
    }
    // Commit the tracked handler paths + the proposal file in a SINGLE commit
    // through the git wrapper (no direct shell git, no force/no-verify).
    let commitSha;
    try {
        const commitPaths = dedupePaths([
            ...trackedHandlerPaths,
            located.relPath,
        ]);
        const result = await gitCommitImpl({
            targetRepoRoot,
            paths: commitPaths,
            message: `accept-proposal: ${proposal.id}`,
            role,
            messageShape: "plugin-internal",
        });
        commitSha = result.commitSha;
    }
    catch (err) {
        // Commit failed — roll the stamp back so a re-run is clean (no half-applied
        // stamp). The handler's working-tree changes are left for operator
        // recovery; the proposal is NOT marked applied, and NO telemetry is emitted.
        await writeManagedFile({
            absPath: located.absPath,
            contents: preStampRaw,
            targetRepoRoot,
            mcpToolContext: { toolName: TOOL_NAME, role },
        });
        throw err;
    }
    // Back-fill the real commit sha into the on-disk stamp so the persisted block
    // names the commit that carried the apply.
    const finalContents = stampProposalApplied(preStampRaw, located, appliedAt, proposal.id, commitSha);
    await writeManagedFile({
        absPath: located.absPath,
        contents: finalContents,
        targetRepoRoot,
        mcpToolContext: { toolName: TOOL_NAME, role },
    });
    // Emit exactly one telemetry event — only AFTER a successful commit. (AC5)
    await logTelemetryEvent({
        targetRepoRoot,
        event: {
            type: "retro.proposal.applied",
            session_id: proposal.id,
            agent: role,
            data: {
                id: proposal.id,
                proposal_type: proposal.type,
                applied_sha: commitSha,
                idempotency_key: proposal.id,
            },
        },
        ...(now ? { now } : {}),
    });
    return {
        status: "applied",
        proposalId,
        type: proposal.type,
        appliedSha: commitSha,
        idempotencyKey: proposal.id,
    };
}
// ---------------------------------------------------------------------------
// Stamping — set proposals[i].applied, re-render byte-stably, preserve body
// ---------------------------------------------------------------------------
/**
 * Stamp the `applied` block onto the matched proposal in the proposal file's
 * frontmatter and re-render the full file. The body is preserved byte-for-byte;
 * the OTHER proposals in the file round-trip stably (`yaml.stringify` with
 * `lineWidth: 0`, matching `writeRetroProposal`'s renderer).
 *
 * Works from the located parse (already schema-validated) rather than a raw
 * yaml re-parse so the field order is identical to what `writeRetroProposal`
 * emits — untouched proposals stay byte-stable.
 */
function stampProposalApplied(rawFile, located, appliedAt, idempotencyKey, appliedSha) {
    const { body } = splitFrontmatter(rawFile, located.absPath);
    const appliedBlock = {
        applied_at: appliedAt,
        applied_sha: appliedSha,
        idempotency_key: idempotencyKey,
    };
    const file = {
        ...located.file,
        proposals: located.file.proposals.map((p, i) => i === located.index ? { ...p, applied: appliedBlock } : p),
    };
    const fm = yamlStringify({
        iso_timestamp: file.iso_timestamp,
        cycle_window: file.cycle_window,
        proposals: file.proposals,
    }, { lineWidth: 0 });
    return `---\n${fm}---\n\n${body}`;
}
function dedupePaths(paths) {
    return [...new Set(paths)];
}
