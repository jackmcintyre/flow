/**
 * The `promote-lesson-to-skill` apply handler — Story native:01KT6RHQ1K4KQMASAXNEK6MY7E.
 *
 * Accepts a `promote-lesson-to-skill` proposal and performs two atomic effects:
 *
 *  1. Creates a new skill file at `proposed_skill_path` under `.flow/skills/`
 *     (reuses the `writeNewSkill` path from Story 6.7; fails with
 *     SkillAlreadyExistsError before any write if the path is occupied).
 *
 *  2. Appends a one-line skill reference to the `## Skills` section of the
 *     originating role's PERSONA.md. The reference serialises as an HTML comment
 *     block (`<!-- skill:ref {...} -->`) so it is machine-parseable by
 *     `buildPersonaSpawnPrompt` while staying human-readable.
 *
 * ## Skill-reference block format
 *
 *   `<!-- skill:ref {"name":"<skill-name>","skill_path":"<rel-path>","when_to_use":"<when>"} -->`
 *
 * `buildPersonaSpawnPrompt` renders each block as a one-line entry:
 *   `[<skill-name>] <when_to_use>`
 *
 * The full skill body is available on demand by reading the skill file at
 * `skill_path`.
 *
 * ## Ordering (atomicity)
 *
 * The skill file is created BEFORE the persona is updated. If the skill-create
 * throws (e.g. SkillAlreadyExistsError), the persona is left unchanged and no
 * half-applied state is committed (the gate only commits on a clean `apply`
 * return).
 *
 * ## No commit
 *
 * The handler only mutates the working tree and returns the repo-relative paths
 * it changed. The gate (`acceptProposal`) owns the commit + proposal stamp +
 * telemetry.
 *
 * (Story native:01KT6RHQ1K4KQMASAXNEK6MY7E — FR promote-lesson-to-skill)
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { writeManagedFile } from "./managed-fs.js";
import { parsePersonaFile } from "./persona-file.js";
import {
  writeNewSkill,
  type SkillHandlerDeps,
} from "./apply-skill-proposal.js";
import { PersonaFileNotFoundError } from "../errors.js";
import type {
  HandlerContext,
  ProposalApplyHandler,
  ProposalApplyResult,
} from "./proposal-apply-registry.js";
import type { RetroProposal } from "../schemas/retro-proposal.js";

/** Tool name threaded into managed-fs role-trace for the persona write. */
const TOOL_NAME = "acceptProposal";

/** The prefix/suffix that delineate a skill-ref block (machine-parseable). */
const SKILL_REF_BLOCK_PREFIX = "<!-- skill:ref ";
const SKILL_REF_BLOCK_SUFFIX = " -->";

/**
 * A parsed skill reference as it appears in a persona's `## Skills` section.
 */
export interface SkillRef {
  name: string;
  skill_path: string;
  when_to_use: string;
}

/**
 * Serialise a `SkillRef` as an HTML comment block for storage in a persona's
 * `## Skills` section body.
 */
export function serialiseSkillRef(ref: SkillRef): string {
  return `${SKILL_REF_BLOCK_PREFIX}${JSON.stringify(ref)}${SKILL_REF_BLOCK_SUFFIX}`;
}

/**
 * Parse all `<!-- skill:ref {...} -->` blocks from a `## Skills` section body.
 * Silently skips malformed or unrecognisable blocks. Returns an array of
 * parsed `SkillRef` objects.
 *
 * Exported for unit testing.
 */
export function extractSkillRefs(skillsBody: string): SkillRef[] {
  const refs: SkillRef[] = [];

  for (const line of skillsBody.split("\n")) {
    const trimmed = line.trimStart();
    if (
      !trimmed.startsWith(SKILL_REF_BLOCK_PREFIX) ||
      !trimmed.endsWith(SKILL_REF_BLOCK_SUFFIX)
    ) {
      continue;
    }

    const jsonStr = trimmed
      .slice(SKILL_REF_BLOCK_PREFIX.length, trimmed.length - SKILL_REF_BLOCK_SUFFIX.length)
      .trim();

    let raw: unknown;
    try {
      raw = JSON.parse(jsonStr);
    } catch {
      // Invalid JSON — skip silently.
      continue;
    }

    if (
      raw === null ||
      typeof raw !== "object" ||
      typeof (raw as Record<string, unknown>)["name"] !== "string" ||
      typeof (raw as Record<string, unknown>)["skill_path"] !== "string" ||
      typeof (raw as Record<string, unknown>)["when_to_use"] !== "string"
    ) {
      continue;
    }

    const obj = raw as Record<string, unknown>;
    refs.push({
      name: obj["name"] as string,
      skill_path: obj["skill_path"] as string,
      when_to_use: obj["when_to_use"] as string,
    });
  }

  return refs;
}

/**
 * Append a skill-ref block to a `## Skills` section body.
 * If the body is empty, the result is the serialised block; if non-empty,
 * the block is appended after a newline.
 *
 */
function appendSkillRef(existingBody: string, ref: SkillRef): string {
  const block = serialiseSkillRef(ref);
  if (existingBody.trim() === "") {
    return block;
  }
  return `${existingBody}\n${block}`;
}

// ---------------------------------------------------------------------------
// Persona file helpers
// ---------------------------------------------------------------------------

/**
 * Repo-relative path to the persona file for a given role.
 */
function personaRelPath(targetRole: string): string {
  return `team/${targetRole}/PERSONA.md`;
}

/**
 * Read the raw persona file bytes, or null when absent.
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
 * Extract the `## Skills` section body from the raw persona file text, or an
 * empty string when the section is absent. Scans line-by-line for the heading
 * then collects subsequent lines until the next `##` heading.
 *
 * Exported for unit testing.
 */
export function extractSkillsSection(raw: string): string {
  const lines = raw.split("\n");
  let inSkills = false;
  const body: string[] = [];

  for (const line of lines) {
    if (/^##\s+Skills\s*$/.test(line) && !line.startsWith("###")) {
      inSkills = true;
      continue;
    }
    if (inSkills) {
      if (/^##\s+/.test(line) && !line.startsWith("###")) {
        // Next ## heading — end of Skills section.
        break;
      }
      body.push(line);
    }
  }

  if (!inSkills) {
    return "";
  }

  return body.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
}

/**
 * Reconstruct the full persona file, replacing the `## Knowledge` body and
 * setting the `## Skills` body. The frontmatter key order is preserved by
 * mirroring `renderPersonaFile`'s canonical insertion order.
 *
 * This deliberately reconstructs the canonical file from parsed sections —
 * never regex-substituting the raw string — to avoid byte-mangling. The `##
 * Skills` section is appended AFTER `## Knowledge` and is present even when
 * its body is empty (so future appends find a consistent structure).
 */
function reconstructPersonaFileWithSkills(
  parsed: ReturnType<typeof parsePersonaFile>,
  newKnowledgeBody: string,
  newSkillsBody: string,
): string {
  // Mirror renderPersonaFile's canonical key order.
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

  // Reconstruct the H1 display name from the role id (Title Case per hyphen).
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

  // Append the ## Skills section (always present; body may be empty or filled).
  sections.push(`## Skills`);
  sections.push(``);
  if (newSkillsBody.length > 0) {
    sections.push(newSkillsBody);
    sections.push(``);
  }

  return `---\n${yamlBlock}\n---\n\n${sections.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Handler: promote-lesson-to-skill
// ---------------------------------------------------------------------------

/**
 * Build the `promote-lesson-to-skill` apply handler. The clock seam is
 * injectable (same pattern as `createSkillProposalHandlers`) so tests can
 * assert `introduced_at` deterministically.
 */
export function makePromoteLessonToSkillHandler(
  deps: SkillHandlerDeps,
): ProposalApplyHandler {
  return {
    type: "promote-lesson-to-skill",

    async previewDiff(
      proposal: RetroProposal,
      ctx: HandlerContext,
    ): Promise<string> {
      assertPromoteLessonProposal(proposal);

      const relPath = personaRelPath(proposal.target_role);
      const raw = await readPersonaRaw(ctx.targetRepoRoot, relPath);

      const skillName = path.basename(proposal.proposed_skill_path, ".md");
      const lines: string[] = [];
      lines.push(
        `# promote-lesson-to-skill proposal ${proposal.id}`,
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
        `Effect 1 — create skill: ${proposal.proposed_skill_path}`,
      );
      lines.push(`    name: ${skillName}`);
      lines.push(`    description: ${proposal.skill_description}`);
      lines.push(`    version: 0.1.0`);
      lines.push(``);
      lines.push(
        `Effect 2 — append skill reference to ${relPath} ## Skills section:`,
      );
      lines.push(`+   <!-- skill:ref name="${skillName}", when_to_use="${proposal.when_to_use}" -->`);
      return lines.join("\n") + "\n";
    },

    async apply(
      proposal: RetroProposal,
      ctx: HandlerContext,
    ): Promise<ProposalApplyResult> {
      assertPromoteLessonProposal(proposal);

      const personaRel = personaRelPath(proposal.target_role);
      const personaAbs = path.join(ctx.targetRepoRoot, personaRel);

      const raw = await readPersonaRaw(ctx.targetRepoRoot, personaRel);
      if (raw === null) {
        throw new PersonaFileNotFoundError({
          role: proposal.target_role,
          personaPath: personaRel,
        });
      }

      // Parse to validate + extract sections.
      const parsed = parsePersonaFile(raw, personaRel);

      // Effect 1: create the skill file. Throws SkillAlreadyExistsError before
      // any persona write if the path is occupied (atomicity — persona unchanged
      // on collision).
      const skillRel = await writeNewSkill(ctx, {
        proposedPath: proposal.proposed_skill_path,
        description: proposal.skill_description,
        body: proposal.skill_body,
        sourceLessonRefs: [proposal.lesson_id],
        introducedAt: deps.now().toISOString(),
      });

      // Derive the skill name from its file path (basename without .md).
      const skillName = path.basename(skillRel, ".md");

      // Effect 2: append the skill reference to the ## Skills section.
      const existingSkillsBody = extractSkillsSection(raw);
      const skillRef: SkillRef = {
        name: skillName,
        skill_path: skillRel,
        when_to_use: proposal.when_to_use,
      };
      const newSkillsBody = appendSkillRef(existingSkillsBody, skillRef);

      // Reconstruct the canonical persona file with the updated Skills section.
      // Knowledge section is preserved unchanged.
      const newContents = reconstructPersonaFileWithSkills(
        parsed,
        parsed.sections.Knowledge,
        newSkillsBody,
      );

      await writeManagedFile({
        absPath: personaAbs,
        contents: newContents,
        targetRepoRoot: ctx.targetRepoRoot,
        mcpToolContext: { toolName: TOOL_NAME, role: ctx.role },
      });

      return { changedPaths: [skillRel, personaRel] };
    },
  };
}

/**
 * Narrow a `RetroProposal` to the `promote-lesson-to-skill` variant.
 * A non-matching type here is a registry-dispatch bug — fail loud.
 */
function assertPromoteLessonProposal(
  proposal: RetroProposal,
): asserts proposal is Extract<RetroProposal, { type: "promote-lesson-to-skill" }> {
  if (proposal.type !== "promote-lesson-to-skill") {
    throw new Error(
      `promote-lesson-to-skill apply handler received a proposal of type '${proposal.type}'; ` +
        `expected 'promote-lesson-to-skill'. This is a registry-dispatch bug.`,
    );
  }
}
