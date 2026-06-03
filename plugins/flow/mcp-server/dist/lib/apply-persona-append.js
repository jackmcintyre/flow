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
/** Tool name threaded into managed-fs role-trace for the persona write. */
const TOOL_NAME = "acceptProposal";
/**
 * Repo-relative path to the persona file for a given role.
 * Mirrors `instantiatePersona`'s path convention.
 */
function personaRelPath(targetRole) {
    return `team/${targetRole}/PERSONA.md`;
}
/**
 * Read the persona file at `<targetRepoRoot>/team/<role>/PERSONA.md`.
 * Returns the raw string contents or null when absent.
 */
async function readPersonaRaw(targetRepoRoot, relPath) {
    const abs = path.join(targetRepoRoot, relPath);
    try {
        return await fs.readFile(abs, "utf8");
    }
    catch (err) {
        if (typeof err === "object" &&
            err !== null &&
            "code" in err &&
            err.code === "ENOENT") {
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
 */
function reconstructPersonaFile(parsed, newKnowledgeBody) {
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
        .map((part) => part.length === 0 ? part : part[0].toUpperCase() + part.slice(1))
        .join(" ");
    const sections = [
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
 */
function serialiseStructuredLesson(lesson) {
    // Build a minimal JSON object — omit undefined optional fields.
    // use_count and last_used_at are included so the parser can read them back
    // for LRU ranking (Story native:01KT6QSW4W7SMAHAT4EAKCCC65).
    const obj = {
        id: lesson.id,
        kind: lesson.kind,
        applies_when: lesson.applies_when,
        detail: lesson.detail,
        learned_at: lesson.learned_at,
        use_count: 0,
        last_used_at: null,
    };
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
 *
 * Exported for unit testing.
 */
export function appendStructuredLesson(existingBody, lesson) {
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
export function makePersonaAppendHandler() {
    return {
        type: "persona-append",
        async previewDiff(proposal, ctx) {
            assertPersonaAppendProposal(proposal);
            const relPath = personaRelPath(proposal.target_role);
            const raw = await readPersonaRaw(ctx.targetRepoRoot, relPath);
            const lines = [];
            lines.push(`# persona-append proposal ${proposal.id} → ${relPath}`);
            lines.push(``);
            if (raw === null) {
                lines.push(`ERROR: No persona file for role '${proposal.target_role}' at ${relPath}.`);
                lines.push(`Run /hire to create one before accepting this proposal.`);
                return lines.join("\n") + "\n";
            }
            lines.push(`Would append to ## Knowledge section of ${relPath}:`);
            const kind = proposal.kind ?? "pattern";
            const appliesWhen = proposal.applies_when ?? proposal.lesson;
            lines.push(`+   <!-- lesson:json kind=${kind}, applies_when="${appliesWhen}" -->`);
            return lines.join("\n") + "\n";
        },
        async apply(proposal, ctx) {
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
            const structuredLesson = {
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
            const newKnowledgeBody = appendStructuredLesson(parsed.sections.Knowledge, structuredLesson);
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
function assertPersonaAppendProposal(proposal) {
    if (proposal.type !== "persona-append") {
        throw new Error(`persona-append apply handler received a proposal of type '${proposal.type}'; ` +
            `expected 'persona-append'. This is a registry-dispatch bug.`);
    }
}
