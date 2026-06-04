/**
 * Proposal apply-handler registry — Story 6.4 (the `/accept-proposal` gate's
 * dispatch seam).
 *
 * The `acceptProposal` gate is **kind-agnostic**: it never reads kind-specific
 * proposal fields. It locates a proposal by id, asks the registered handler for
 * the proposal's `type` to render a diff (preview) or apply the change
 * (confirm), commits the handler's changed paths together with the proposal
 * stamp, and records telemetry. All kind-specific behaviour lives behind this
 * handler interface.
 *
 * **Story 6.4 shipped the gate machinery with an EMPTY production registry.**
 * Each kind's real handler is registered by its story; an unregistered kind
 * still fails closed via `ProposalKindNotApplicableYetError` (AC6). Status:
 *
 *   - `rule`                                          → Story 6.5 (REGISTERED)
 *   - `rule-retirement`                               → Story 6.6
 *   - `skill-create` / `skill-revise` /
 *     `skill-supersede` / `skill-retire`              → Story 6.7 (REGISTERED)
 *   - `team-change`                                   → Story 6.10
 *   - persona-append (when 6.9 routes through here)   → Story 6.9
 *
 * The gate is proven end-to-end in tests with a **test-injected fake handler**,
 * mirroring the `execaImpl` injection pattern used by the git wrapper: the tool
 * takes an optional `handlers` injection (defaulting to the empty production
 * registry); tests pass a fake handler, production passes nothing.
 *
 * (Story 6.4 — FR61, Architecture §Skill calibration loop)
 */

import type { RetroProposal } from "../schemas/retro-proposal.js";
import { makeRuleApplyHandler } from "./apply-rule-proposal.js";
import { makeRuleRetirementApplyHandler } from "./apply-rule-retirement.js";
import { createSkillProposalHandlers } from "./apply-skill-proposal.js";
import { makePersonaAppendHandler } from "./apply-persona-append.js";

/**
 * Context threaded into a handler's `previewDiff`/`apply` calls. The gate owns
 * the commit + stamp + telemetry — the handler only renders a diff and mutates
 * the repo working tree, returning the paths it changed so the gate can stage
 * and commit them.
 */
export interface HandlerContext {
  /** Absolute path to the target repository root. */
  targetRepoRoot: string;
  /** Role label threaded into managed-fs / git wrappers for the role-trace. */
  role: string;
}

/**
 * The result of a handler's `apply`: the repo-relative paths the handler
 * changed in the working tree. The gate commits exactly these paths plus the
 * proposal file (which the gate itself stamps). A handler MUST NOT commit —
 * committing is the gate's responsibility (single commit, one place).
 */
export interface ProposalApplyResult {
  /** Repo-relative paths the handler changed; the gate stages + commits these. */
  changedPaths: string[];
}

/**
 * A per-kind apply handler. Each handler owns two operations:
 *
 *  - `previewDiff` — render a human-readable diff of the proposed change. Pure
 *    with respect to the working tree: it MUST NOT write any file, make any
 *    commit, or emit telemetry (the gate's AC2 preview-only no-op depends on
 *    this).
 *  - `apply` — perform the kind-specific mutation against the working tree and
 *    return the repo-relative paths it changed. It MUST NOT commit.
 *
 * The gate calls exactly one of these per invocation: `previewDiff` on a
 * preview call, `apply` on a confirm call.
 */
export interface ProposalApplyHandler {
  readonly type: RetroProposal["type"];
  previewDiff(proposal: RetroProposal, ctx: HandlerContext): Promise<string>;
  apply(
    proposal: RetroProposal,
    ctx: HandlerContext,
  ): Promise<ProposalApplyResult>;
}

/**
 * The registry: a map keyed by `proposal.type`. The gate looks a handler up by
 * the located proposal's `type`; a miss is a fail-closed
 * `ProposalKindNotApplicableYetError`.
 */
export type ProposalApplyRegistry = Map<
  RetroProposal["type"],
  ProposalApplyHandler
>;

/**
 * The PRODUCTION registry. Story 6.4 shipped it EMPTY; Story 6.5 registers the
 * `rule` handler and Story 6.7 the `skill-*` handlers. Every OTHER kind still
 * fails closed via `ProposalKindNotApplicableYetError` until its handler lands
 * (see `KIND_TO_STORY`). The gate defaults to this registry when no `handlers`
 * injection is provided.
 *
 * Registered handlers:
 *   - `rule`                                          → Story 6.5
 *   - `rule-retirement`                               → Story 6.6
 *   - `skill-create` / `skill-revise` /
 *     `skill-supersede` / `skill-retire`              → Story 6.7
 *   - `persona-append`                                → Story 6.9
 *   - `lesson-to-skill`                               → Story DR2
 *
 * Still fail closed (no handler) until their story registers them:
 *   - `team-change`                                   → Story 6.10
 *
 * It is intentionally a fresh map (not a shared mutable singleton) per import so
 * a test that mutates a registry never leaks into production; the `rule` handler
 * is constructed fresh per call, and the `skill-*` handlers use the default
 * `Date` clock (tests that need a deterministic `introduced_at` / `retired_at`
 * build their own registry from `createSkillProposalHandlers({ now })` and
 * inject it).
 */
export function createProductionRegistry(): ProposalApplyRegistry {
  const registry: ProposalApplyRegistry = new Map();
  // Story 6.5 — the first real handler.
  registry.set("rule", makeRuleApplyHandler());
  // Story 6.6 — rule-retirement handler.
  registry.set("rule-retirement", makeRuleRetirementApplyHandler());
  // Story 6.7 — the skill-* handlers.
  for (const handler of createSkillProposalHandlers()) {
    registry.set(handler.type, handler);
  }
  // Story 6.9 — persona-append handler.
  registry.set("persona-append", makePersonaAppendHandler());
  return registry;
}

/**
 * Maps each proposal kind to the story that shipped (or will ship) its apply
 * handler. Used to build an actionable `ProposalKindNotApplicableYetError`
 * message. Closed over the nine retro-proposal kinds; a new kind would
 * require a schema-change story that also extends this map.
 */
export const KIND_TO_STORY: Readonly<Record<RetroProposal["type"], string>> = {
  rule: "Story 6.5",
  // Repointed from 6.5 → 6.6: the rule-retirement apply path lands in Story 6.6
  // (this story ships only the `rule` handler). Until 6.6 lands its handler,
  // accepting a `rule-retirement` proposal fails closed with this story pointer.
  "rule-retirement": "Story 6.6",
  "skill-create": "Story 6.7",
  "skill-revise": "Story 6.7",
  "skill-supersede": "Story 6.7",
  "skill-retire": "Story 6.7",
  "team-change": "Story 6.10",
  "persona-append": "Story 6.9",
  "lesson-to-skill": "Story DR2",
};
