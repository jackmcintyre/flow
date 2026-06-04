/**
 * The `persona-append`-kind `ProposalApplyHandler` — Story 6.9.
 *
 * Accepts a `persona-append` proposal and appends the lesson as a new bullet
 * to the `## Knowledge` section of the target role's persona file
 * (`team/<target_role>/PERSONA.md`).
 *
 * ## Apply semantics
 *
 *   1. Resolve the persona file path: `team/<target_role>/PERSONA.md`.
 *   2. Read the file from disk. If absent, throw `PersonaFileNotFoundError`.
 *   3. Parse via `parsePersonaFile` to validate it is a well-formed persona.
 *   4. Reconstruct the full file, replacing the Knowledge section body with
 *      the existing body + a new `- <lesson>` bullet appended. If the body
 *      is empty, the new body is `- <lesson>`; if non-empty, the bullet is
 *      appended after a newline.
 *   5. Serialise the full file from parsed sections (NOT regex substitution):
 *      frontmatter from the parsed PersonaFrontmatter, sections in canonical
 *      order, replacing only the Knowledge section body.
 *   6. Write via `writeManagedFile`.
 *   7. Return the repo-relative persona path as `changedPaths`.
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
 * (Story 6.9 — persona-knowledge write-back keystone)
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { writeManagedFile } from "./managed-fs.js";
import { parsePersonaFile } from "./persona-file.js";
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
 * Mirrors `instantiatePersona`'s path convention.
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
 * Knowledge body with `newKnowledgeBody` and optionally providing a new
 * Skills section body. The frontmatter key order is preserved by feeding
 * the same `PersonaFrontmatter` object insertion order that `renderPersonaFile`
 * uses.
 *
 * This deliberately reconstructs the canonical file from parsed sections —
 * never regex-substituting the raw string — to avoid byte-mangling.
 *
 * If `newSkillsBody` is provided, the `## Skills` section is written after
 * `## Knowledge`. If `newSkillsBody` is undefined, any existing `## Skills`
 * body from the parsed file is preserved; if neither exists, the section is
 * omitted.
 */
function reconstructPersonaFile(
  parsed: ReturnType<typeof parsePersonaFile>,
  newKnowledgeBody: string,
  newSkillsBody?: string,
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

  // Preserve or write the ## Skills section if we have content for it.
  const skillsBody =
    newSkillsBody !== undefined
      ? newSkillsBody
      : (parsed.optionalSections["Skills"] ?? "");

  if (skillsBody.length > 0) {
    sections.push(`## Skills`);
    sections.push(``);
    sections.push(skillsBody);
    sections.push(``);
  }

  return `---\n${yamlBlock}\n---\n\n${sections.join("\n")}`;
}

/**
 * Append a lesson bullet to a Knowledge section body. If the body is empty,
 * the result is `- <lesson>`; if non-empty, the bullet is appended on a new
 * line.
 */
function appendKnowledgeBullet(existingBody: string, lesson: string): string {
  const bullet = `- ${lesson}`;
  if (existingBody.trim() === "") {
    return bullet;
  }
  return `${existingBody}\n${bullet}`;
}

/**
 * Append a skill-reference line to the Skills section body.
 *
 * Each skill reference is formatted as:
 *   `- <skillName> (<skillPath>): <whenToUse>`
 *
 * If the body is empty, the result is the single reference line; if non-empty,
 * the line is appended after a newline.
 */
export function appendSkillReference(
  existingBody: string,
  skillName: string,
  skillPath: string,
  whenToUse: string,
): string {
  const line = `- ${skillName} (${skillPath}): ${whenToUse}`;
  if (existingBody.trim() === "") {
    return line;
  }
  return `${existingBody}\n${line}`;
}

/**
 * Apply a skill-reference addition to a persona file in the target repo.
 *
 * Reads the persona file at `team/<role>/PERSONA.md`, appends a skill-reference
 * entry to the `## Skills` section (creating the section after `## Knowledge`
 * if it does not yet exist), and writes back via `writeManagedFile`.
 *
 * Returns the repo-relative persona path (for the caller's `changedPaths`).
 *
 * @throws {PersonaFileNotFoundError} When the persona file does not exist.
 */
export async function applySkillReferenceToPersona(opts: {
  targetRepoRoot: string;
  role: string;
  skillName: string;
  skillPath: string;
  whenToUse: string;
  toolName: string;
  actingRole: string;
}): Promise<string> {
  const { targetRepoRoot, role, skillName, skillPath, whenToUse, toolName, actingRole } = opts;
  const relPath = personaRelPath(role);
  const absPath = path.join(targetRepoRoot, relPath);

  const raw = await readPersonaRaw(targetRepoRoot, relPath);
  if (raw === null) {
    throw new PersonaFileNotFoundError({
      role,
      personaPath: relPath,
    });
  }

  const parsed = parsePersonaFile(raw, relPath);
  const existingSkillsBody = parsed.optionalSections["Skills"] ?? "";
  const newSkillsBody = appendSkillReference(
    existingSkillsBody,
    skillName,
    skillPath,
    whenToUse,
  );

  const newContents = reconstructPersonaFile(
    parsed,
    parsed.sections.Knowledge,
    newSkillsBody,
  );

  await writeManagedFile({
    absPath,
    contents: newContents,
    targetRepoRoot,
    mcpToolContext: { toolName, role: actingRole },
  });

  return relPath;
}

/**
 * Construct the `persona-append`-kind apply handler. The production registry
 * calls this with no args; seams are injectable for tests.
 */
export function makePersonaAppendHandler(): ProposalApplyHandler {
  return {
    type: "persona-append",

    async previewDiff(
      proposal: RetroProposal,
      ctx: HandlerContext,
    ): Promise<string> {
      assertPersonaAppendProposal(proposal);

      const relPath = personaRelPath(proposal.target_role);
      const raw = await readPersonaRaw(ctx.targetRepoRoot, relPath);

      const lines: string[] = [];
      lines.push(
        `# persona-append proposal ${proposal.id} → ${relPath}`,
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
        `Would append to ## Knowledge section of ${relPath}:`,
      );
      lines.push(`+   - ${proposal.lesson}`);
      return lines.join("\n") + "\n";
    },

    async apply(
      proposal: RetroProposal,
      ctx: HandlerContext,
    ): Promise<ProposalApplyResult> {
      assertPersonaAppendProposal(proposal);

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

      // Append the new bullet to the Knowledge body.
      const newKnowledgeBody = appendKnowledgeBullet(
        parsed.sections.Knowledge,
        proposal.lesson,
      );

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
 * Narrow a `RetroProposal` to the `persona-append` variant. The gate only
 * dispatches a `persona-append` proposal to this handler, so a non-`persona-append`
 * proposal here is a wiring bug — fail loud.
 */
function assertPersonaAppendProposal(
  proposal: RetroProposal,
): asserts proposal is Extract<RetroProposal, { type: "persona-append" }> {
  if (proposal.type !== "persona-append") {
    throw new Error(
      `persona-append apply handler received a proposal of type '${proposal.type}'; ` +
        `expected 'persona-append'. This is a registry-dispatch bug.`,
    );
  }
}
