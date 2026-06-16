/**
 * The `lesson-consolidation`-kind `ProposalApplyHandler` —
 * Story native:01KV7FFZ5PJKCW6Z6RVJ71XY6T.
 *
 * Accepts a `lesson-consolidation` proposal and merges two near-duplicate
 * lessons in a hired role's Knowledge section into a single sharper lesson.
 *
 * ## Apply semantics
 *
 *   1. Resolve the persona file path: `team/<target_role>/PERSONA.md`.
 *   2. Read the file from disk. If absent, throw `PersonaFileNotFoundError`.
 *   3. Parse via `parsePersonaFile` to validate it is a well-formed persona.
 *   4. Extract the current Knowledge section body with `extractLessonsFromBody`.
 *   5. Verify both `lesson_a_id` and `lesson_b_id` exist in the extracted lessons.
 *   6. Remove both source lesson blocks from the Knowledge body via
 *      `demoteLessonsFromBody`.
 *   7. Append a new structured lesson block carrying `merged_lesson` as the
 *      `detail` field, with `applies_when` set to the merged_lesson text (or a
 *      shorter form if the proposal carries one).
 *   8. Reconstruct the full file with the updated Knowledge body.
 *   9. Write via `writeManagedFile`.
 *  10. Return the repo-relative persona path as `changedPaths`.
 *
 * ## No commit
 *
 * The handler only mutates the working tree and returns the repo-relative
 * paths it changed. The gate (`acceptProposal`) owns the commit + proposal
 * stamp + telemetry.
 *
 * ## Idempotency
 *
 * Idempotency is the gate's, not the handler's. The gate's persisted-`applied`
 * no-op (Story 6.4 AC4) guards against a second apply.
 *
 * (Story native:01KV7FFZ5PJKCW6Z6RVJ71XY6T — retro lesson consolidation)
 */

import * as path from "node:path";
import { promises as fs } from "node:fs";
import { ulid } from "ulid";
import { stringify as yamlStringify } from "yaml";
import { writeManagedFile } from "./managed-fs.js";
import { parsePersonaFile } from "./persona-file.js";
import {
  extractLessonsFromBody,
  demoteLessonsFromBody,
  LESSON_BLOCK_PREFIX,
  LESSON_BLOCK_SUFFIX,
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
 * `apply-persona-append.ts`.
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
 * Serialise the merged lesson as an inline HTML comment block in the
 * Knowledge section lesson:json format.
 */
function serialiseMergedLesson(mergedLesson: string, createdAt: string): string {
  const obj: Record<string, string | number> = {
    id: ulid(),
    kind: "pattern",
    applies_when: mergedLesson,
    detail: mergedLesson,
    learned_at: createdAt,
    use_count: 0,
  };
  return `${LESSON_BLOCK_PREFIX}${JSON.stringify(obj)}${LESSON_BLOCK_SUFFIX}`;
}

/**
 * Append a lesson block to a Knowledge section body.
 */
function appendLessonBlock(existingBody: string, block: string): string {
  if (existingBody.trim() === "") {
    return block;
  }
  return `${existingBody}\n${block}`;
}

/**
 * Construct the `lesson-consolidation`-kind apply handler.
 */
export function makeLessonConsolidationHandler(): ProposalApplyHandler {
  return {
    type: "lesson-consolidation",

    async previewDiff(
      proposal: RetroProposal,
      ctx: HandlerContext,
    ): Promise<string> {
      assertLessonConsolidationProposal(proposal);

      const relPath = personaRelPath(proposal.target_role);
      const raw = await readPersonaRaw(ctx.targetRepoRoot, relPath);

      const lines: string[] = [];
      lines.push(
        `# lesson-consolidation proposal ${proposal.id} → ${relPath}`,
      );
      lines.push(``);

      if (raw === null) {
        lines.push(
          `ERROR: No persona file for role '${proposal.target_role}' at ${relPath}.`,
        );
        lines.push(`Run /hire to create one before accepting this proposal.`);
        return lines.join("\n") + "\n";
      }

      lines.push(`Would merge two lessons in ## Knowledge section of ${relPath}:`);
      lines.push(``);
      lines.push(`**Source lesson A** (id: ${proposal.lesson_a_id}):`);
      lines.push(`  ${proposal.lesson_a_text}`);
      lines.push(``);
      lines.push(`**Source lesson B** (id: ${proposal.lesson_b_id}):`);
      lines.push(`  ${proposal.lesson_b_text}`);
      lines.push(``);
      lines.push(`**Merged result** (replaces both):`);
      lines.push(`  ${proposal.merged_lesson}`);
      return lines.join("\n") + "\n";
    },

    async apply(
      proposal: RetroProposal,
      ctx: HandlerContext,
    ): Promise<ProposalApplyResult> {
      assertLessonConsolidationProposal(proposal);

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

      // Extract existing lessons to verify both ids are present.
      const existingLessons = extractLessonsFromBody(parsed.sections.Knowledge);
      const existingIds = new Set(existingLessons.map((l) => l.id));

      // Remove both source lessons from the Knowledge body.
      const idsToRemove = new Set<string>();
      if (existingIds.has(proposal.lesson_a_id)) {
        idsToRemove.add(proposal.lesson_a_id);
      }
      if (existingIds.has(proposal.lesson_b_id)) {
        idsToRemove.add(proposal.lesson_b_id);
      }

      const bodyAfterRemoval = demoteLessonsFromBody(
        parsed.sections.Knowledge,
        idsToRemove,
      );

      // Append the merged lesson block.
      const mergedBlock = serialiseMergedLesson(
        proposal.merged_lesson,
        proposal.created_at,
      );
      const newKnowledgeBody = appendLessonBlock(bodyAfterRemoval, mergedBlock);

      // Reconstruct the canonical file with the new Knowledge body.
      const newContents = reconstructPersonaFile(parsed, newKnowledgeBody);

      await writeManagedFile({
        absPath,
        contents: newContents,
        targetRepoRoot: ctx.targetRepoRoot,
        mcpToolContext: { toolName: TOOL_NAME, role: ctx.role },
      });

      return { changedPaths: [relPath] };
    },
  };
}

/**
 * Narrow a `RetroProposal` to the `lesson-consolidation` variant.
 */
function assertLessonConsolidationProposal(
  proposal: RetroProposal,
): asserts proposal is Extract<RetroProposal, { type: "lesson-consolidation" }> {
  if (proposal.type !== "lesson-consolidation") {
    throw new Error(
      `lesson-consolidation apply handler received a proposal of type '${proposal.type}'; ` +
        `expected 'lesson-consolidation'. This is a registry-dispatch bug.`,
    );
  }
}
