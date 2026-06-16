/**
 * The `lesson-retirement`-kind `ProposalApplyHandler` —
 * Story native:01KV7FGDTQ8FSJ2EEPHHGK0KRQ.
 *
 * Accepts a `lesson-retirement` proposal and moves the named lessons out of the
 * role's always-shown Knowledge section into the archived store, where they remain
 * retrievable on demand via `recallLesson`.
 *
 * ## Apply semantics
 *
 *   1. Resolve the persona file path: `team/<target_role>/PERSONA.md`.
 *   2. Read the file from disk. If absent, throw `PersonaFileNotFoundError`.
 *   3. Parse via `parsePersonaFile` to validate it is a well-formed persona.
 *   4. Extract the current Knowledge section body with `extractLessonsFromBody`.
 *   5. Build the set of lesson ids to retire from `proposal.lesson_retirements`.
 *   6. Collect the matching `ParsedLesson` objects (lessons that are in BOTH the
 *      Knowledge section AND the retirement list). Silently skip ids that are
 *      no longer present — idempotent re-runs must not crash on stale ids.
 *   7. Remove the matching lesson blocks from the Knowledge body via
 *      `demoteLessonsFromBody`.
 *   8. Archive each removed lesson via `archiveLessons` — nothing is deleted;
 *      retired lessons stay in `team/<role>/_archived/<id>.json` and remain
 *      retrievable via `recallLesson`'s archived-store fallback (step 4).
 *   9. Reconstruct the full file with the updated Knowledge body.
 *  10. Write via `writeManagedFile`.
 *  11. Return the repo-relative persona path + all archived-lesson paths as
 *      `changedPaths`.
 *
 * ## No commit
 *
 * The handler only mutates the working tree and returns the repo-relative paths
 * it changed. The gate (`acceptProposal`) owns the commit + proposal stamp +
 * telemetry.
 *
 * ## Reversibility
 *
 * Nothing is ever deleted. Archived lessons remain in the `_archived/` store
 * and are retrievable via `recallLesson`. A future story could re-promote an
 * archived lesson, but that is out of scope here.
 *
 * ## Idempotency
 *
 * Idempotency is the gate's, not the handler's. The gate's persisted-`applied`
 * no-op (Story 6.4 AC4) guards against a second apply. At the lesson level,
 * step 6 silently skips ids that are no longer in the live Knowledge section
 * (already removed by a prior partial application).
 *
 * (Story native:01KV7FGDTQ8FSJ2EEPHHGK0KRQ — retire dead lessons)
 */

import * as path from "node:path";
import { promises as fs } from "node:fs";
import { stringify as yamlStringify } from "yaml";
import { writeManagedFile } from "./managed-fs.js";
import { parsePersonaFile } from "./persona-file.js";
import {
  extractLessonsFromBody,
  demoteLessonsFromBody,
  archiveLessons,
} from "./lesson-archive.js";
import { PersonaFileNotFoundError } from "../errors.js";
import type {
  HandlerContext,
  ProposalApplyHandler,
  ProposalApplyResult,
} from "./proposal-apply-registry.js";
import type { RetroProposal } from "../schemas/retro-proposal.js";

/** Tool name threaded into managed-fs role-trace for the persona write. */
const TOOL_NAME = "acceptProposal";

/**
 * Repo-relative path to the persona file for a given role.
 */
function personaRelPath(targetRole: string): string {
  return `team/${targetRole}/PERSONA.md`;
}

/**
 * Read the persona file at `<targetRepoRoot>/team/<role>/PERSONA.md`.
 * Returns the raw string contents or null when absent.
 */
async function readPersonaRaw(
  targetRepoRoot: string,
  relPath: string,
): Promise<string | null> {
  const abs = path.join(targetRepoRoot, relPath);
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
 * Reconstruct the full persona file from parsed sections, replacing the
 * Knowledge body with `newKnowledgeBody`. Mirrors the pattern in
 * `apply-lesson-consolidation.ts`.
 */
function reconstructPersonaFile(
  parsed: ReturnType<typeof parsePersonaFile>,
  newKnowledgeBody: string,
): string {
  const frontmatter = {
    role: parsed.role,
    domain: parsed.domain,
    model_tier: parsed.model_tier,
    tools_allow: [...parsed.tools_allow],
    gh_allow: [...parsed.gh_allow],
    locked_phrases: { ...parsed.locked_phrases },
    hired_at: parsed.hired_at,
    catalogue_version: parsed.catalogue_version,
  };

  const yamlBlock = yamlStringify(frontmatter).replace(/\n$/, "");

  const h1 = parsed.role
    .split("-")
    .map((part) =>
      part.length === 0 ? part : part[0]!.toUpperCase() + part.slice(1),
    )
    .join(" ");

  const sections: string[] = [
    `# ${h1}`,
    ``,
    `## Domain`,
    ``,
    parsed.sections.Domain,
    ``,
    `## Mandate`,
    ``,
    parsed.sections.Mandate,
    ``,
    `## Out of mandate`,
    ``,
    parsed.sections["Out of mandate"],
    ``,
    `## Prompt`,
    ``,
    parsed.sections.Prompt,
    ``,
    `## Knowledge`,
    ``,
  ];

  if (newKnowledgeBody.length > 0) {
    sections.push(newKnowledgeBody);
    sections.push(``);
  }

  if (parsed.skillsBody.length > 0) {
    sections.push(`## Skills`);
    sections.push(``);
    sections.push(parsed.skillsBody);
    sections.push(``);
  }

  return `---\n${yamlBlock}\n---\n\n${sections.join("\n")}`;
}

/**
 * Construct the `lesson-retirement`-kind apply handler.
 *
 * @param now - Injectable clock seam for `archiveLessons` (default: real Date).
 */
export function makeLessonRetirementHandler(
  opts: { now?: () => Date } = {},
): ProposalApplyHandler {
  const now = opts.now ?? (() => new Date());

  return {
    type: "lesson-retirement",

    async previewDiff(
      proposal: RetroProposal,
      ctx: HandlerContext,
    ): Promise<string> {
      assertLessonRetirementProposal(proposal);

      const relPath = personaRelPath(proposal.target_role);
      const raw = await readPersonaRaw(ctx.targetRepoRoot, relPath);

      const lines: string[] = [];
      lines.push(
        `# lesson-retirement proposal ${proposal.id} → ${relPath}`,
      );
      lines.push(``);

      if (raw === null) {
        lines.push(
          `ERROR: No persona file for role '${proposal.target_role}' at ${relPath}.`,
        );
        lines.push(`Run /hire to create one before accepting this proposal.`);
        return lines.join("\n") + "\n";
      }

      lines.push(
        `Would retire ${proposal.lesson_retirements.length} lesson(s) from ## Knowledge section of ${relPath}:`,
      );
      lines.push(``);
      for (const item of proposal.lesson_retirements) {
        lines.push(`- id: ${item.id}`);
        lines.push(`  reason: ${item.reason}`);
      }
      lines.push(``);
      lines.push(
        `Retired lessons are moved to team/${proposal.target_role}/_archived/<id>.json` +
          ` and remain retrievable via recallLesson.`,
      );
      return lines.join("\n") + "\n";
    },

    async apply(
      proposal: RetroProposal,
      ctx: HandlerContext,
    ): Promise<ProposalApplyResult> {
      assertLessonRetirementProposal(proposal);

      const relPath = personaRelPath(proposal.target_role);
      const absPath = path.join(ctx.targetRepoRoot, relPath);

      const raw = await readPersonaRaw(ctx.targetRepoRoot, relPath);
      if (raw === null) {
        throw new PersonaFileNotFoundError({
          role: proposal.target_role,
          personaPath: relPath,
        });
      }

      // Parse to validate + extract sections.
      const parsed = parsePersonaFile(raw, relPath);

      // Extract existing lessons so we can match by id.
      const existingLessons = extractLessonsFromBody(parsed.sections.Knowledge);
      const existingById = new Map(existingLessons.map((l) => [l.id, l]));

      // Build the set of ids to remove and collect the matching lesson objects
      // for archiving. Silently skip ids not found in the live section — they
      // may have been removed by a prior partial application.
      const retireIds = new Set<string>();
      const lessonsToArchive: typeof existingLessons = [];

      for (const item of proposal.lesson_retirements) {
        const lesson = existingById.get(item.id);
        if (lesson !== undefined) {
          retireIds.add(item.id);
          lessonsToArchive.push(lesson);
        }
      }

      // Remove the matched lessons from the live Knowledge body.
      const newKnowledgeBody = demoteLessonsFromBody(
        parsed.sections.Knowledge,
        retireIds,
      );

      // Reconstruct and write the updated persona file.
      const newContents = reconstructPersonaFile(parsed, newKnowledgeBody);
      await writeManagedFile({
        absPath,
        contents: newContents,
        targetRepoRoot: ctx.targetRepoRoot,
        mcpToolContext: { toolName: TOOL_NAME, role: ctx.role },
      });

      // Archive the removed lessons — nothing is deleted; they stay retrievable.
      const archivedPaths = await archiveLessons(
        ctx.targetRepoRoot,
        proposal.target_role,
        lessonsToArchive,
        now,
      );

      return { changedPaths: [relPath, ...archivedPaths] };
    },
  };
}

/**
 * Narrow a `RetroProposal` to the `lesson-retirement` variant.
 */
function assertLessonRetirementProposal(
  proposal: RetroProposal,
): asserts proposal is Extract<RetroProposal, { type: "lesson-retirement" }> {
  if (proposal.type !== "lesson-retirement") {
    throw new Error(
      `lesson-retirement apply handler received a proposal of type '${proposal.type}'; ` +
        `expected 'lesson-retirement'. This is a registry-dispatch bug.`,
    );
  }
}
