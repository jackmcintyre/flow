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
import { ulid } from "ulid";
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
import type { StructuredLesson } from "../schemas/story-retro.js";

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
 * Knowledge body with `newKnowledgeBody`. The frontmatter key order is
 * preserved by feeding the same `PersonaFrontmatter` object insertion order
 * that `renderPersonaFile` uses.
 *
 * This deliberately reconstructs the canonical file from parsed sections —
 * never regex-substituting the raw string — to avoid byte-mangling.
 *
 * Story native:01KT6RHQ1K4KQMASAXNEK6MY7E: The optional `## Skills` section
 * is preserved verbatim from `parsed.skillsBody` (empty string when absent,
 * which suppresses the section entirely so round-trips stay identical to the
 * pre-Skills-section era).
 */
function reconstructPersonaFile(
  parsed: ReturnType<typeof parsePersonaFile>,
  newKnowledgeBody: string,
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

  // Preserve the optional ## Skills section if it was present in the parsed file.
  if (parsed.skillsBody.length > 0) {
    sections.push(`## Skills`);
    sections.push(``);
    sections.push(parsed.skillsBody);
    sections.push(``);
  }

  return `---\n${yamlBlock}\n---\n\n${sections.join("\n")}`;
}

/**
 * Serialise a `StructuredLesson` as an inline HTML comment block so the
 * Knowledge section stays human-readable while the structured data is
 * unambiguously machine-parseable by `extractKnowledgeEntries`.
 *
 * Format:
 *   <!-- lesson:json {"id":"...","kind":"...","applies_when":"...","detail":"...",...} -->
 *
 * Only fields with defined values are included in the JSON object.
 *
 * Usage-tracking fields (`use_count`, `last_used_at`) are initialised to their
 * zero-state values (`use_count: 0`) when a new lesson is first appended. The
 * `last_used_at` field is omitted until the lesson is first recalled. This
 * ensures the briefing-budget ranker (Story native:01KT6QSW4W7SMAHAT4EAKCCC65)
 * can treat newly-appended lessons uniformly without a separate migration step.
 */
function serialiseStructuredLesson(lesson: StructuredLesson): string {
  // Build a minimal JSON object — omit undefined optional fields.
  const obj: Record<string, string | number> = {
    id: lesson.id,
    kind: lesson.kind,
    applies_when: lesson.applies_when,
    detail: lesson.detail,
    learned_at: lesson.learned_at,
    // Initialise usage-tracking fields so the ranker can sort deterministically.
    use_count: lesson.use_count ?? 0,
  };
  if (lesson.last_used_at !== undefined) {
    obj["last_used_at"] = lesson.last_used_at;
  }
  if (lesson.failure_class !== undefined) {
    obj["failure_class"] = lesson.failure_class;
  }
  if (lesson.source_ref !== undefined) {
    obj["source_ref"] = lesson.source_ref;
  }
  if (lesson.source_pr !== undefined) {
    obj["source_pr"] = lesson.source_pr;
  }
  return `<!-- lesson:json ${JSON.stringify(obj)} -->`;
}

/**
 * Append a structured lesson block to a Knowledge section body.
 * If the body is empty, the result is the serialised block; if non-empty,
 * the block is appended after a newline.
 */
function appendStructuredLesson(
  existingBody: string,
  lesson: StructuredLesson,
): string {
  const block = serialiseStructuredLesson(lesson);
  if (existingBody.trim() === "") {
    return block;
  }
  return `${existingBody}\n${block}`;
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
      const kind = proposal.kind ?? "pattern";
      const appliesWhen = proposal.applies_when ?? proposal.lesson;
      lines.push(`+   <!-- lesson:json kind=${kind}, applies_when="${appliesWhen}" -->`);
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

      // Build a StructuredLesson from the proposal fields.
      // kind and applies_when are optional on the proposal (backward compat with
      // proposals authored before Story native:01KT6Q8PSDZQKM57VFRHFJ3RP4);
      // fall back to "pattern" / lesson text when absent.
      const structuredLesson: StructuredLesson = {
        id: ulid(),
        kind: proposal.kind ?? "pattern",
        applies_when: proposal.applies_when ?? proposal.lesson,
        detail: proposal.lesson,
        learned_at: proposal.created_at,
        ...(proposal.failure_class !== undefined
          ? { failure_class: proposal.failure_class }
          : {}),
        ...(proposal.source_ref !== undefined
          ? { source_ref: proposal.source_ref }
          : {}),
      };

      // Append the structured lesson block to the Knowledge body.
      const newKnowledgeBody = appendStructuredLesson(
        parsed.sections.Knowledge,
        structuredLesson,
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
