/**
 * The `team-change`-kind `ProposalApplyHandler` — Story native:01KVFAP16TD6ENBDSQ9AQQCXTQ.
 *
 * Accepts a `team-change` proposal and either hires the target role (by
 * instantiating a persona file at `team/<target_role>/PERSONA.md`) or safely
 * sets it aside reversibly (by archiving the persona to
 * `team/_archived/<target_role>/PERSONA.md`).
 *
 * ## Apply semantics — hire
 *
 *   1. Calls `instantiatePersona` to create `team/<target_role>/PERSONA.md`.
 *   2. Returns `changedPaths: ["team/<target_role>/PERSONA.md"]`.
 *
 * ## Apply semantics — unhire
 *
 *   1. Calls `unhirePersona` which:
 *      a. Checks the grading-panel guard (bipartite matching). Throws
 *         `UnhireBelowJudgeMinimumError` if the removal would leave a lens
 *         uncovered.
 *      b. Archives the persona to `team/_archived/<target_role>/PERSONA.md`
 *         and removes the live `team/<target_role>/PERSONA.md`.
 *   2. Returns `changedPaths` strictly under the `team/` directory.
 *
 * ## Preview / would-break-grading guard (unhire only)
 *
 * The unhire preview MUST run the would-break-grading guard READ-ONLY
 * (`resolveLensRoleBinding` on the post-unhire roster) BEFORE confirming so
 * the operator sees a refusal in the preview if the removal would break the
 * panel. If the guard fires, the preview describes the refusal and apply
 * changes nothing.
 *
 * ## Safety isolation from standards machinery
 *
 * This handler is COMPLETELY INDEPENDENT of the rule/standards handlers. It
 * touches ONLY the team records directory (`team/...`) and NEVER the
 * quality-rubric/standards file. It is modelled on the persona-append handler,
 * NOT on any rule/standards handler.
 *
 * ## No commit
 *
 * The handler only mutates the working tree and returns the repo-relative
 * paths it changed. The gate (`acceptProposal`) owns the commit + proposal
 * stamp + telemetry.
 *
 * ## Confirm-gating and idempotency
 *
 * Confirm-first gating and double-apply protection are inherited from the
 * existing accept gate — not reimplemented here.
 *
 * (Story native:01KVFAP16TD6ENBDSQ9AQQCXTQ)
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { instantiatePersona } from "../tools/instantiate-persona.js";
import { unhirePersona } from "../tools/unhire-persona.js";
import { resolveLensRoleBinding } from "../tools/judge-panel.js";
import { getPluginRoot } from "./plugin-root.js";
import { LensJudgeUnavailableError } from "../errors.js";
import type {
  HandlerContext,
  ProposalApplyHandler,
  ProposalApplyResult,
} from "./proposal-apply-registry.js";
import type { RetroProposal } from "../schemas/retro-proposal.js";

// ---------------------------------------------------------------------------
// Team-roster enumeration (mirrors unhire-persona.ts logic)
// ---------------------------------------------------------------------------

/**
 * Enumerate live hired roles from `<targetRepoRoot>/team/`.
 * Mirrors the enumeration logic in `unhire-persona.ts`.
 */
async function enumerateHiredRoles(targetRepoRoot: string): Promise<string[]> {
  const teamDir = path.join(targetRepoRoot, "team");

  let dirEntries: string[];
  try {
    dirEntries = await fs.readdir(teamDir);
  } catch (err) {
    if (isEnoent(err)) {
      return [];
    }
    throw err;
  }

  const SKIP_DIRS = new Set(["custom", "_archived"]);
  const hiredRoles: string[] = [];

  for (const entry of dirEntries) {
    if (SKIP_DIRS.has(entry) || entry.startsWith(".")) {
      continue;
    }

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(path.join(teamDir, entry));
    } catch {
      continue;
    }
    if (!stat.isDirectory()) {
      continue;
    }

    try {
      await fs.access(path.join(teamDir, entry, "PERSONA.md"));
    } catch {
      continue;
    }

    hiredRoles.push(entry);
  }

  hiredRoles.sort();
  return hiredRoles;
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export interface MakeTeamChangeHandlerOptions {
  /**
   * Test seam: plugin root for `instantiatePersona`'s catalogue lookup.
   * Production callers omit; `getPluginRoot()` is called at apply time.
   */
  pluginRoot?: string;
  /**
   * Test seam: clock for `unhirePersona`'s `archived_at` stamp.
   * Production callers omit; `() => new Date()` is the default.
   */
  clock?: () => Date;
}

/**
 * Construct the `team-change`-kind apply handler. The production registry
 * calls this with no args; seams are injectable for tests.
 */
export function makeTeamChangeHandler(
  opts: MakeTeamChangeHandlerOptions = {},
): ProposalApplyHandler {
  const clock = opts.clock ?? (() => new Date());

  return {
    type: "team-change",

    async previewDiff(
      proposal: RetroProposal,
      ctx: HandlerContext,
    ): Promise<string> {
      assertTeamChangeProposal(proposal);

      const { action, target_role: targetRole } = proposal;

      const lines: string[] = [];
      lines.push(`# team-change proposal ${proposal.id} → action: ${action}, role: ${targetRole}`);
      lines.push(``);

      if (action === "hire") {
        // For hire: show what would be added.
        const personaPath = `team/${targetRole}/PERSONA.md`;
        lines.push(`Would add role '${targetRole}' to the team:`);
        lines.push(`+   ${personaPath} (new persona file)`);
        lines.push(``);
        lines.push(`Only team records under team/ would change.`);
      } else {
        // action === "unhire"
        // Run the would-break-grading guard READ-ONLY in the preview.
        const hiredRoles = await enumerateHiredRoles(ctx.targetRepoRoot);
        const postUnhireRoster = hiredRoles.filter((r) => r !== targetRole);

        let wouldBreakGrading: { lens: string } | null = null;
        try {
          resolveLensRoleBinding(postUnhireRoster);
        } catch (err) {
          if (err instanceof LensJudgeUnavailableError) {
            wouldBreakGrading = { lens: err.lens };
          } else {
            throw err;
          }
        }

        if (wouldBreakGrading !== null) {
          lines.push(`REFUSAL: Removing role '${targetRole}' would leave the quality-grading panel`);
          lines.push(`unable to staff the '${wouldBreakGrading.lens}' reviewer slot.`);
          lines.push(``);
          lines.push(`The team must retain enough distinct roles to cover all five reviewer slots.`);
          lines.push(`Hire a replacement before removing this role.`);
          lines.push(``);
          lines.push(`No team records would change if you proceed (the apply will also refuse).`);
        } else {
          const livePersonaPath = `team/${targetRole}/PERSONA.md`;
          const archivedPath = `team/_archived/${targetRole}/PERSONA.md`;
          lines.push(`Would safely set aside role '${targetRole}':`);
          lines.push(`-   ${livePersonaPath} (moved to archive)`);
          lines.push(`+   ${archivedPath} (reversible — role can be reinstated)`);
          lines.push(``);
          lines.push(`Only team records under team/ would change.`);
        }
      }

      return lines.join("\n") + "\n";
    },

    async apply(
      proposal: RetroProposal,
      ctx: HandlerContext,
    ): Promise<ProposalApplyResult> {
      assertTeamChangeProposal(proposal);

      const { action, target_role: targetRole } = proposal;
      const pluginRoot = opts.pluginRoot ?? getPluginRoot();

      if (action === "hire") {
        // Hire path: instantiate the persona.
        const result = await instantiatePersona({
          pluginRoot,
          targetRepoRoot: ctx.targetRepoRoot,
          role: targetRole,
          clock,
        });

        // changedPaths MUST be strictly under team/
        const relPath = path.relative(ctx.targetRepoRoot, result.path);
        assertUnderTeamDir(relPath);

        return { changedPaths: [relPath] };
      } else {
        // action === "unhire"
        // Unhire path: the safe, reversible unhire capability.
        // unhirePersona runs the grading guard itself; if it would break the
        // panel it throws UnhireBelowJudgeMinimumError before touching any file.
        const result = await unhirePersona({
          targetRepoRoot: ctx.targetRepoRoot,
          role: targetRole,
          clock,
        });

        if (result.status === "already-archived") {
          // Idempotent: already archived. Return the archive path as the
          // "changed" path (consistent with the nominal unhire path).
          const relPath = path.relative(ctx.targetRepoRoot, result.archivedPath);
          assertUnderTeamDir(relPath);
          return { changedPaths: [relPath] };
        }

        // Nominal unhire: both the archived path (new) and the live path
        // (removed) are in the team directory.
        const archivedRelPath = path.relative(ctx.targetRepoRoot, result.archivedPath);
        assertUnderTeamDir(archivedRelPath);

        const livePersonaRelPath = `team/${targetRole}/PERSONA.md`;
        assertUnderTeamDir(livePersonaRelPath);

        return { changedPaths: [archivedRelPath, livePersonaRelPath] };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

/**
 * Narrow a `RetroProposal` to the `team-change` variant. The gate only
 * dispatches a `team-change` proposal to this handler, so a non-`team-change`
 * proposal here is a wiring bug — fail loud.
 */
function assertTeamChangeProposal(
  proposal: RetroProposal,
): asserts proposal is Extract<RetroProposal, { type: "team-change" }> {
  if (proposal.type !== "team-change") {
    throw new Error(
      `team-change apply handler received a proposal of type '${proposal.type}'; ` +
        `expected 'team-change'. This is a registry-dispatch bug.`,
    );
  }
}

/**
 * Assert that a repo-relative path is strictly under the `team/` directory.
 * Throws if the path escapes the team directory — safety guard for AC4.
 */
function assertUnderTeamDir(relPath: string): void {
  const normalised = path.normalize(relPath);
  if (!normalised.startsWith("team/") && !normalised.startsWith("team\\")) {
    throw new Error(
      `team-change handler produced a changedPath outside the team directory: '${relPath}'. ` +
        `This is a safety violation — the team-change handler MUST only modify paths under team/.`,
    );
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
