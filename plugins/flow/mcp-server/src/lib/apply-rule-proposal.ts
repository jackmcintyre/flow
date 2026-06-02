/**
 * The `rule`-kind `ProposalApplyHandler` — Story 6.5 (FR62) + Story 6.5b (FR48).
 *
 * This is the **first real handler** registered into the Story 6.4
 * `/accept-proposal` gate. It takes an accepted `rule` proposal and appends (or
 * edits) a rule in `docs/discipline-rules.yaml`, then regenerates
 * `docs/standards.md` from the updated registry (Story 6.5b).
 *
 *  - `text` + `target_failure_class` are COPIED from the proposal.
 *  - `level` is mapped from the proposal's `recommended_promotion_level`.
 *  - `id` is a freshly minted ULID.
 *  - `introduced_at` is `now` (ISO-8601 UTC).
 *
 * **Append vs edit-in-place.** The epic wording is "append or edit". The chosen
 * match key is `target_failure_class`: if the registry already holds a rule for
 * the proposal's `target_failure_class`, the handler EDITS that rule in place
 * (replacing its `text`/`level`, keeping its existing `id` and `introduced_at`)
 * rather than appending a duplicate. This keeps the invariant that the registry
 * never holds two rules for one failure class. A new class is appended.
 *
 * **Cap-rollback ordering (Story 6.5b).** Order inside `apply`:
 *   1. Snapshot the current `docs/discipline-rules.yaml` bytes.
 *   2. Append/edit the rule (working-tree write).
 *   3. Call `regenerateStandards` against the post-append registry.
 *   4. If it raises `StandardsCapExceededError`: restore the registry snapshot
 *      (working-tree rollback) and re-raise. The gate sees the throw, commits
 *      nothing, stamps nothing, emits no telemetry.
 *   5. Otherwise: write the regenerated `docs/standards.md` and return BOTH
 *      changed paths `["docs/discipline-rules.yaml", "docs/standards.md"]`.
 *
 * **No commit.** The handler only mutates the working tree and returns the
 * repo-relative paths it changed — the gate (`acceptProposal`) owns the
 * commit + proposal stamp + telemetry.
 *
 * **Idempotency is the gate's, not the handler's.** The handler is not
 * re-entrant-safe on its own; the gate's persisted-`applied` no-op (Story 6.4
 * AC4) guards against a second apply.
 *
 * **Comment preservation** is delegated to the comment-preserving parse/serialize
 * seam in `schemas/discipline-rules.ts` (the `yaml` Document API). Existing rules
 * and human-authored comments survive the append/edit byte-for-byte.
 *
 * (Story 6.5 — FR62; Story 6.5b — FR48, Architecture §Skill calibration loop)
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { ulid as generateUlid } from "ulid";
import { writeManagedFile } from "./managed-fs.js";
import {
  regenerateStandards,
  bumpPatchVersion,
  STANDARDS_REL_PATH,
  STANDARDS_SEED_VERSION,
} from "./regenerate-standards.js";
import { lookupStandards } from "../state/lookup-standards.js";
import { StandardsDocMissingError } from "../errors.js";
import type {
  HandlerContext,
  ProposalApplyHandler,
  ProposalApplyResult,
} from "./proposal-apply-registry.js";
import type { RetroProposal } from "../schemas/retro-proposal.js";
import {
  DisciplineRuleSchema,
  parseRuleRegistry,
  serializeRuleRegistry,
  appendRuleNode,
  replaceRuleNode,
  type DisciplineRule,
} from "../schemas/discipline-rules.js";

/** The single repo-relative registry path this handler writes. */
export const REGISTRY_REL_PATH = "docs/discipline-rules.yaml";

/** Tool name threaded into the managed-fs role-trace for the registry write. */
const TOOL_NAME = "acceptProposal";

/**
 * Test seams: a clock for `introduced_at` and a ULID minter for `id`, so
 * AC2/AC3 can assert deterministic field values. Production passes neither and
 * the real `new Date()` / `ulid` are used.
 *
 * Story 6.5b extends the seam with `standardsNow` (the clock injected into
 * `regenerateStandards`) so tests can assert byte-identical output across two
 * regenerations.
 */
export interface RuleApplyHandlerSeams {
  /** Returns "now" for `introduced_at`. Defaults to `() => new Date()`. */
  now?: () => Date;
  /** Mints a fresh ULID for `id`. Defaults to the `ulid` package. */
  mintUlid?: () => string;
  /**
   * Returns "now" as an ISO-8601 string for the `updated` field in the
   * regenerated `docs/standards.md`. Defaults to `() => new Date()`.
   * Distinct from `now` so tests can control the two clocks independently.
   */
  standardsNow?: () => Date;
}

/**
 * Read the registry file at `<targetRepoRoot>/docs/discipline-rules.yaml`,
 * returning the raw contents or `null` when absent (matching
 * `gatherRuleRegistry()`'s null-tolerance — absence is not an error).
 */
async function readRegistryRaw(targetRepoRoot: string): Promise<string | null> {
  const abs = path.join(targetRepoRoot, REGISTRY_REL_PATH);
  try {
    return await fs.readFile(abs, "utf8");
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "ENOENT"
    ) {
      return null;
    }
    throw err;
  }
}

/**
 * Build the new rule's fields from the proposal. `id` and `introduced_at` are
 * always freshly minted (never copied from the proposal). The result is
 * validated against `DisciplineRuleSchema` so a malformed rule never reaches
 * the registry.
 */
function buildRuleFromProposal(
  proposal: Extract<RetroProposal, { type: "rule" }>,
  seams: Required<RuleApplyHandlerSeams>,
): DisciplineRule {
  const candidate = {
    id: seams.mintUlid(),
    text: proposal.text,
    target_failure_class: proposal.target_failure_class,
    introduced_at: seams.now().toISOString(),
    level: proposal.recommended_promotion_level,
  };
  // Validate before it touches the registry. A throw here is a programming
  // error (the proposal schema already guarantees these fields), but the guard
  // keeps the deterministic-seam invariant: only schema-valid rules are written.
  return DisciplineRuleSchema.parse(candidate);
}

/**
 * Render a human-readable before/after diff for the preview phase. Pure —
 * reads the registry but writes NOTHING (the gate's AC2 preview no-op depends
 * on this).
 */
async function renderRuleDiff(
  proposal: Extract<RetroProposal, { type: "rule" }>,
  ctx: HandlerContext,
  seams: Required<RuleApplyHandlerSeams>,
): Promise<string> {
  const raw = await readRegistryRaw(ctx.targetRepoRoot);
  const { data } = parseRuleRegistry(raw, REGISTRY_REL_PATH);
  const existingIdx = data.rules.findIndex(
    (r) => r.target_failure_class === proposal.target_failure_class,
  );
  const verb = existingIdx >= 0 ? "edit" : "append";
  const lines: string[] = [];
  lines.push(`# rule proposal ${proposal.id} → ${verb} in ${REGISTRY_REL_PATH}`);
  lines.push("");
  if (existingIdx >= 0) {
    const prior = data.rules[existingIdx]!;
    lines.push(`Existing rule for failure class '${proposal.target_failure_class}':`);
    lines.push(`-   text: ${prior.text}`);
    if (prior.level !== undefined) lines.push(`-   level: ${prior.level}`);
    lines.push("");
    lines.push("Would become:");
    lines.push(`+   text: ${proposal.text}`);
    lines.push(`+   level: ${proposal.recommended_promotion_level}`);
    lines.push(`    (id ${prior.id} and introduced_at preserved)`);
  } else {
    lines.push(`Would append a new rule for failure class '${proposal.target_failure_class}':`);
    lines.push(`+   text: ${proposal.text}`);
    lines.push(`+   target_failure_class: ${proposal.target_failure_class}`);
    lines.push(`+   level: ${proposal.recommended_promotion_level}`);
    lines.push(`+   id: <freshly-minted ULID>`);
    lines.push(`+   introduced_at: <now, ISO-8601 UTC>`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Construct the `rule`-kind apply handler. Seams are injectable for tests; the
 * production registry calls this with no args.
 */
export function makeRuleApplyHandler(
  seamsIn: RuleApplyHandlerSeams = {},
): ProposalApplyHandler {
  const seams: Required<RuleApplyHandlerSeams> = {
    now: seamsIn.now ?? (() => new Date()),
    mintUlid: seamsIn.mintUlid ?? generateUlid,
    standardsNow: seamsIn.standardsNow ?? (() => new Date()),
  };

  return {
    type: "rule",

    async previewDiff(
      proposal: RetroProposal,
      ctx: HandlerContext,
    ): Promise<string> {
      assertRuleProposal(proposal);
      return renderRuleDiff(proposal, ctx, seams);
    },

    async apply(
      proposal: RetroProposal,
      ctx: HandlerContext,
    ): Promise<ProposalApplyResult> {
      assertRuleProposal(proposal);

      // Step 1: snapshot the registry bytes for cap-rollback.
      const preAppendRaw = await readRegistryRaw(ctx.targetRepoRoot);

      const { doc, data } = parseRuleRegistry(preAppendRaw, REGISTRY_REL_PATH);

      const existingIdx = data.rules.findIndex(
        (r) => r.target_failure_class === proposal.target_failure_class,
      );

      let updatedRules: typeof data.rules;
      if (existingIdx >= 0) {
        // Edit-in-place on a failure-class match: keep the existing id +
        // introduced_at, replace text + level.
        const prior = data.rules[existingIdx]!;
        const edited = DisciplineRuleSchema.parse({
          id: prior.id,
          text: proposal.text,
          target_failure_class: proposal.target_failure_class,
          introduced_at: prior.introduced_at,
          level: proposal.recommended_promotion_level,
        });
        replaceRuleNode(doc, existingIdx, edited);
        updatedRules = data.rules.map((r, i) => (i === existingIdx ? edited : r));
      } else {
        const rule = buildRuleFromProposal(proposal, seams);
        appendRuleNode(doc, rule);
        updatedRules = [...data.rules, rule];
      }

      // Step 2: write the updated registry.
      const contents = serializeRuleRegistry(doc);
      const absRegistryPath = path.join(ctx.targetRepoRoot, REGISTRY_REL_PATH);
      await writeManagedFile({
        absPath: absRegistryPath,
        contents,
        targetRepoRoot: ctx.targetRepoRoot,
        mcpToolContext: { toolName: TOOL_NAME, role: ctx.role },
      });

      // Step 3: determine the target version for the regenerated standards doc.
      // Read the prior standards doc to get the prior version; fall back to the
      // seed version if the doc does not exist yet.
      let priorVersion: string;
      try {
        const prior = await lookupStandards(ctx.targetRepoRoot);
        priorVersion = prior.version;
      } catch (err) {
        if (err instanceof StandardsDocMissingError) {
          priorVersion = STANDARDS_SEED_VERSION;
        } else {
          throw err;
        }
      }
      const targetVersion = bumpPatchVersion(priorVersion);

      // Step 4: regenerate. If the cap is exceeded, restore the registry
      // snapshot and re-raise (working-tree rollback).
      try {
        await regenerateStandards({
          registry: { rules: updatedRules },
          targetVersion,
          updatedTimestamp: seams.standardsNow().toISOString(),
          targetRepoRoot: ctx.targetRepoRoot,
          mcpToolContext: { toolName: TOOL_NAME, role: ctx.role },
        });
      } catch (err) {
        // Cap-exceeded rollback: restore the registry to its pre-append state.
        // The gate's partial-failure posture (throw from apply → no commit/stamp/
        // telemetry) does the rest.
        const rollbackContents = preAppendRaw ?? "rules: []\n";
        await writeManagedFile({
          absPath: absRegistryPath,
          contents: rollbackContents,
          targetRepoRoot: ctx.targetRepoRoot,
          mcpToolContext: { toolName: TOOL_NAME, role: ctx.role },
        });
        throw err;
      }

      // Step 5: return both changed paths so the gate commits them together.
      return { changedPaths: [REGISTRY_REL_PATH, STANDARDS_REL_PATH] };
    },
  };
}

/**
 * Narrow a `RetroProposal` to the `rule` variant. The gate only dispatches a
 * `rule` proposal to this handler, so a non-`rule` proposal here is a wiring
 * bug — fail loud rather than silently mis-handle.
 */
function assertRuleProposal(
  proposal: RetroProposal,
): asserts proposal is Extract<RetroProposal, { type: "rule" }> {
  if (proposal.type !== "rule") {
    throw new Error(
      `rule apply handler received a proposal of type '${proposal.type}'; ` +
        `expected 'rule'. This is a registry-dispatch bug.`,
    );
  }
}
