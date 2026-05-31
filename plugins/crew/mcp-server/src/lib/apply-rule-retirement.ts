/**
 * The `rule-retirement`-kind `ProposalApplyHandler` — Story 6.6 (FR64a).
 *
 * Accepts a `rule-retirement` proposal and either:
 *   - **`retire`**: removes the matching rule from `docs/discipline-rules.yaml`.
 *   - **`relax`**: demotes the matching rule's `level` to `"advisory"` in place.
 *
 * After either mutation, the handler regenerates `docs/standards.md` via
 * Story 6.5b's `regenerateStandards` (REUSED — no second projection
 * implementation). Returns both changed paths so the gate commits them together.
 *
 * ## Working-tree-atomic posture (mirroring the `rule` handler from 6.5)
 *
 *   1. Snapshot the current registry bytes.
 *   2. Validate `target_rule_id` exists BEFORE any write.
 *   3. For `retire`: guard against removing the last rule (→ empty standards doc).
 *   4. Mutate the registry in memory + write.
 *   5. Call `regenerateStandards`. If it throws, restore the snapshot and re-raise.
 *   6. Return both changed paths.
 *
 * ## No commit
 *
 * The handler only mutates the working tree and returns the repo-relative paths
 * it changed. The gate (`acceptProposal`) owns the commit + proposal stamp +
 * telemetry.
 *
 * ## Comment preservation
 *
 * Removal and demotion both go through the `yaml` Document API
 * (removeRuleNode, replaceRuleNode) so comments on untouched rules survive.
 *
 * (Story 6.6 — FR64a, Architecture §Skill calibration loop)
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { writeManagedFile } from "./managed-fs.js";
import {
  regenerateStandards,
  bumpPatchVersion,
  STANDARDS_REL_PATH,
  STANDARDS_SEED_VERSION,
} from "./regenerate-standards.js";
import { lookupStandards } from "../state/lookup-standards.js";
import {
  StandardsDocMissingError,
  RuleNotFoundError,
  RetirementWouldEmptyRegistryError,
} from "../errors.js";
import type {
  HandlerContext,
  ProposalApplyHandler,
  ProposalApplyResult,
} from "./proposal-apply-registry.js";
import type { RetroProposal } from "../schemas/retro-proposal.js";
import {
  parseRuleRegistry,
  serializeRuleRegistry,
  removeRuleNode,
  replaceRuleNode,
  DisciplineRuleSchema,
} from "../schemas/discipline-rules.js";

/** The single repo-relative registry path this handler writes. */
export const REGISTRY_REL_PATH = "docs/discipline-rules.yaml";

/** Tool name threaded into the managed-fs role-trace. */
const TOOL_NAME = "acceptProposal";

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

/**
 * Injectable seams for tests (mirroring the `rule` handler's seams shape so
 * tests can assert byte-stable standards-doc output).
 */
export interface RuleRetirementApplyHandlerSeams {
  /** Returns "now" for the regenerated standards `updated` field. */
  standardsNow?: () => Date;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

async function readRegistryRaw(targetRepoRoot: string): Promise<string | null> {
  const abs = path.join(targetRepoRoot, REGISTRY_REL_PATH);
  try {
    return await fs.readFile(abs, "utf8");
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}

// ---------------------------------------------------------------------------
// Preview diff renderer (pure — no writes)
// ---------------------------------------------------------------------------

async function renderRetirementDiff(
  proposal: Extract<RetroProposal, { type: "rule-retirement" }>,
  ctx: HandlerContext,
): Promise<string> {
  const raw = await readRegistryRaw(ctx.targetRepoRoot);
  const { data } = parseRuleRegistry(raw, REGISTRY_REL_PATH);

  const ruleIdx = data.rules.findIndex((r) => r.id === proposal.target_rule_id);
  const lines: string[] = [];
  lines.push(`# rule-retirement proposal ${proposal.id} → ${proposal.recommended_action} in ${REGISTRY_REL_PATH}`);
  lines.push("");

  if (ruleIdx < 0) {
    lines.push(`Rule '${proposal.target_rule_id}' was NOT found in the registry.`);
    lines.push(`Accepting this proposal will raise RuleNotFoundError (no mutation).`);
  } else {
    const rule = data.rules[ruleIdx]!;
    if (proposal.recommended_action === "retire") {
      lines.push(`Would REMOVE rule '${rule.id}':`);
      lines.push(`-   text: ${rule.text}`);
      lines.push(`-   target_failure_class: ${rule.target_failure_class}`);
      if (rule.level !== undefined) lines.push(`-   level: ${rule.level}`);
      lines.push(`-   introduced_at: ${rule.introduced_at}`);
      lines.push(``);
      if (data.rules.length === 1) {
        lines.push(`WARNING: this is the last rule — accepting will refuse with RetirementWouldEmptyRegistryError.`);
      }
    } else {
      lines.push(`Would RELAX rule '${rule.id}' (demote level to advisory):`);
      lines.push(`    text: ${rule.text}`);
      lines.push(`    target_failure_class: ${rule.target_failure_class}`);
      if (rule.level !== undefined && rule.level !== "advisory") {
        lines.push(`-   level: ${rule.level}`);
      }
      lines.push(`+   level: advisory`);
      lines.push(`    (id and introduced_at unchanged)`);
    }
    lines.push(``);
    lines.push(`fire_count_over_window (from proposal): ${proposal.fire_count_over_window}`);
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Construct the `rule-retirement`-kind apply handler. Seams are injectable for
 * tests; the production registry calls this with no args.
 */
export function makeRuleRetirementApplyHandler(
  seamsIn: RuleRetirementApplyHandlerSeams = {},
): ProposalApplyHandler {
  const seams: Required<RuleRetirementApplyHandlerSeams> = {
    standardsNow: seamsIn.standardsNow ?? (() => new Date()),
  };

  return {
    type: "rule-retirement",

    async previewDiff(
      proposal: RetroProposal,
      ctx: HandlerContext,
    ): Promise<string> {
      assertRetirementProposal(proposal);
      return renderRetirementDiff(proposal, ctx);
    },

    async apply(
      proposal: RetroProposal,
      ctx: HandlerContext,
    ): Promise<ProposalApplyResult> {
      assertRetirementProposal(proposal);

      // Step 1: snapshot the registry bytes for rollback on regen failure.
      const preApplyRaw = await readRegistryRaw(ctx.targetRepoRoot);

      const { doc, data } = parseRuleRegistry(preApplyRaw, REGISTRY_REL_PATH);

      // Step 2: match the target_rule_id BEFORE any write — fail closed.
      const ruleIdx = data.rules.findIndex((r) => r.id === proposal.target_rule_id);
      if (ruleIdx < 0) {
        throw new RuleNotFoundError({
          targetRuleId: proposal.target_rule_id,
          registryPath: path.join(ctx.targetRepoRoot, REGISTRY_REL_PATH),
        });
      }

      // Step 3: guard against removing the last rule.
      if (proposal.recommended_action === "retire" && data.rules.length === 1) {
        throw new RetirementWouldEmptyRegistryError({
          targetRuleId: proposal.target_rule_id,
        });
      }

      // Step 4: mutate the Document in place.
      let updatedRules: typeof data.rules;
      if (proposal.recommended_action === "retire") {
        removeRuleNode(doc, ruleIdx);
        updatedRules = data.rules.filter((_, i) => i !== ruleIdx);
      } else {
        // relax — demote to advisory
        const prior = data.rules[ruleIdx]!;
        const relaxed = DisciplineRuleSchema.parse({
          id: prior.id,
          text: prior.text,
          target_failure_class: prior.target_failure_class,
          introduced_at: prior.introduced_at,
          level: "advisory",
        });
        replaceRuleNode(doc, ruleIdx, relaxed);
        updatedRules = data.rules.map((r, i) => (i === ruleIdx ? relaxed : r));
      }

      // Step 5: write the updated registry.
      const contents = serializeRuleRegistry(doc);
      const absRegistryPath = path.join(ctx.targetRepoRoot, REGISTRY_REL_PATH);
      await writeManagedFile({
        absPath: absRegistryPath,
        contents,
        targetRepoRoot: ctx.targetRepoRoot,
        mcpToolContext: { toolName: TOOL_NAME, role: ctx.role },
      });

      // Step 6: determine the target version for the regenerated standards doc.
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

      // Step 7: regenerate. If it fails, restore the registry snapshot and re-raise.
      try {
        await regenerateStandards({
          registry: { rules: updatedRules },
          targetVersion,
          updatedTimestamp: seams.standardsNow().toISOString(),
          targetRepoRoot: ctx.targetRepoRoot,
          mcpToolContext: { toolName: TOOL_NAME, role: ctx.role },
        });
      } catch (err) {
        // Restore the registry to its pre-apply state.
        const rollbackContents = preApplyRaw ?? "rules: []\n";
        await writeManagedFile({
          absPath: absRegistryPath,
          contents: rollbackContents,
          targetRepoRoot: ctx.targetRepoRoot,
          mcpToolContext: { toolName: TOOL_NAME, role: ctx.role },
        });
        throw err;
      }

      // Step 8: return both changed paths.
      return { changedPaths: [REGISTRY_REL_PATH, STANDARDS_REL_PATH] };
    },
  };
}

/**
 * Narrow a `RetroProposal` to the `rule-retirement` variant.
 */
function assertRetirementProposal(
  proposal: RetroProposal,
): asserts proposal is Extract<RetroProposal, { type: "rule-retirement" }> {
  if (proposal.type !== "rule-retirement") {
    throw new Error(
      `rule-retirement apply handler received a proposal of type '${proposal.type}'; ` +
        `expected 'rule-retirement'. This is a registry-dispatch bug.`,
    );
  }
}
