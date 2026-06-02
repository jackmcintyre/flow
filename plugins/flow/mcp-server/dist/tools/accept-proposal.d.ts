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
import { gitCommit } from "../lib/git.js";
import { type ProposalApplyRegistry } from "../lib/proposal-apply-registry.js";
export type AcceptProposalResult = {
    status: "preview";
    proposalId: string;
    type: string;
    diff: string;
} | {
    status: "applied";
    proposalId: string;
    type: string;
    appliedSha: string;
    idempotencyKey: string;
} | {
    status: "already-applied";
    proposalId: string;
    type: string;
    appliedSha: string;
    appliedAt: string;
};
export interface AcceptProposalOptions {
    /** Absolute path to the target repository root. */
    targetRepoRoot: string;
    /** The proposal id to accept (a ULID). */
    proposalId: string;
    /** When true, applies + commits + stamps. When absent/false, preview-only. */
    confirm?: boolean;
    /** Role label threaded into git / managed-fs / telemetry. Defaults to "operator". */
    role?: string;
    /**
     * Handler registry injection (mirrors the git wrapper's `execaImpl` seam).
     * Tests pass a fake handler; production passes nothing (empty registry).
     */
    handlers?: ProposalApplyRegistry;
    /**
     * Git-commit implementation injection. Tests pass a spy/fake; production
     * passes nothing and the real `gitCommit` wrapper is used.
     */
    gitCommitImpl?: typeof gitCommit;
    /** Test seam for deterministic timestamps (applied_at + telemetry ts). */
    now?: () => Date;
}
export declare function acceptProposal(opts: AcceptProposalOptions): Promise<AcceptProposalResult>;
