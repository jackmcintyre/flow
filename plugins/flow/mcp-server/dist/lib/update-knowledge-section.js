/**
 * Helpers to update a role's live Knowledge section in PERSONA.md.
 *
 * Used by:
 *   - `buildPersonaSpawnPrompt` — to remove archived (overflow) lessons from
 *     the live store after they have been demoted to `_archived/lessons.json`.
 *   - `recallLesson` — to write back updated `use_count` / `last_used_at`
 *     fields after a lesson is recalled.
 *
 * Both operations perform a targeted line-level rewrite of the
 * `<!-- lesson:json ... -->` blocks in the Knowledge section body, leaving
 * all other sections untouched. The approach mirrors the apply-persona-append
 * handler: reconstruct the canonical persona file from parsed sections and
 * write back via `writeManagedFile`.
 *
 * (Story native:01KT6QSW4W7SMAHAT4EAKCCC65)
 */
import * as path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { writeManagedFile } from "./managed-fs.js";
import { parsePersonaFile } from "./persona-file.js";
/** Sentinel prefix/suffix — MUST match the ones in parse-knowledge-section.ts. */
const LESSON_BLOCK_PREFIX = "<!-- lesson:json ";
const LESSON_BLOCK_SUFFIX = " -->";
/** Tool name threaded into managed-fs role-trace. */
const TOOL_NAME = "buildPersonaSpawnPrompt";
// ---------------------------------------------------------------------------
// Public: remove lessons by id
// ---------------------------------------------------------------------------
/**
 * Remove lesson blocks whose ids appear in `idsToRemove` from the live
 * Knowledge section of `team/<role>/PERSONA.md`.
 *
 * Returns the repo-relative path and the count of blocks removed. When no
 * blocks match, the file is NOT rewritten (no-op).
 *
 * @param targetRepoRoot  - Absolute path to the repo root.
 * @param role            - Role id (e.g. `"generalist-dev"`).
 * @param idsToRemove     - Set of lesson ids to strip from the live store.
 */
export async function removeKnowledgeLessonsById(targetRepoRoot, role, idsToRemove) {
    const relPath = `team/${role}/PERSONA.md`;
    const absPath = path.join(targetRepoRoot, relPath);
    const raw = await readFile(absPath);
    const parsed = parsePersonaFile(raw, relPath);
    const { newBody, removedCount } = removeBlocksById(parsed.sections["Knowledge"], idsToRemove);
    if (removedCount === 0) {
        return { personaRelPath: relPath, modifiedCount: 0 };
    }
    const newContents = reconstructPersonaFile(parsed, newBody);
    await writeManagedFile({
        absPath,
        contents: newContents,
        targetRepoRoot,
        mcpToolContext: { toolName: TOOL_NAME, role },
    });
    return { personaRelPath: relPath, modifiedCount: removedCount };
}
// ---------------------------------------------------------------------------
// Public: update use_count and last_used_at for one lesson
// ---------------------------------------------------------------------------
/**
 * Update the `use_count` and `last_used_at` fields in the live lesson block
 * for a given lesson id. If the id is not found in the live store, this is a
 * no-op (the lesson may be in the archived store — the caller handles that).
 *
 * @param targetRepoRoot  - Absolute path to the repo root.
 * @param role            - Role id (e.g. `"generalist-dev"`).
 * @param id              - The lesson's stable ULID id.
 * @param useCount        - New use_count value.
 * @param lastUsedAt      - ISO-8601 UTC timestamp string.
 */
export async function updateLessonUsageInPersona(targetRepoRoot, role, id, useCount, lastUsedAt) {
    const relPath = `team/${role}/PERSONA.md`;
    const absPath = path.join(targetRepoRoot, relPath);
    const raw = await readFile(absPath);
    const parsed = parsePersonaFile(raw, relPath);
    const { newBody, modifiedCount } = updateBlockUsage(parsed.sections["Knowledge"], id, useCount, lastUsedAt);
    if (modifiedCount === 0) {
        return { personaRelPath: relPath, modifiedCount: 0 };
    }
    const newContents = reconstructPersonaFile(parsed, newBody);
    await writeManagedFile({
        absPath,
        contents: newContents,
        targetRepoRoot,
        mcpToolContext: { toolName: TOOL_NAME, role },
    });
    return { personaRelPath: relPath, modifiedCount };
}
// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
/**
 * Walk the Knowledge section body line by line.
 * Remove any `<!-- lesson:json ... -->` block whose `id` is in `idsToRemove`.
 * All other lines are preserved verbatim.
 */
function removeBlocksById(knowledgeBody, idsToRemove) {
    const lines = knowledgeBody.split("\n");
    const kept = [];
    let removedCount = 0;
    for (const line of lines) {
        const trimmed = line.trimStart();
        if (trimmed.startsWith(LESSON_BLOCK_PREFIX) &&
            trimmed.endsWith(LESSON_BLOCK_SUFFIX)) {
            const jsonStr = trimmed
                .slice(LESSON_BLOCK_PREFIX.length, trimmed.length - LESSON_BLOCK_SUFFIX.length)
                .trim();
            try {
                const obj = JSON.parse(jsonStr);
                if (typeof obj["id"] === "string" && idsToRemove.has(obj["id"])) {
                    removedCount++;
                    continue; // skip (remove) this line
                }
            }
            catch {
                // Malformed block — preserve it rather than accidentally destroying it.
            }
        }
        kept.push(line);
    }
    return { newBody: kept.join("\n"), removedCount };
}
/**
 * Walk the Knowledge section body line by line.
 * For the `<!-- lesson:json ... -->` block whose `id` matches, update
 * `use_count` and `last_used_at` in-place. All other lines are preserved.
 */
function updateBlockUsage(knowledgeBody, id, useCount, lastUsedAt) {
    const lines = knowledgeBody.split("\n");
    const result = [];
    let modifiedCount = 0;
    for (const line of lines) {
        const trimmed = line.trimStart();
        if (trimmed.startsWith(LESSON_BLOCK_PREFIX) &&
            trimmed.endsWith(LESSON_BLOCK_SUFFIX)) {
            const jsonStr = trimmed
                .slice(LESSON_BLOCK_PREFIX.length, trimmed.length - LESSON_BLOCK_SUFFIX.length)
                .trim();
            try {
                const obj = JSON.parse(jsonStr);
                if (typeof obj["id"] === "string" && obj["id"] === id) {
                    // Update the usage fields.
                    obj["use_count"] = useCount;
                    obj["last_used_at"] = lastUsedAt;
                    result.push(`${LESSON_BLOCK_PREFIX}${JSON.stringify(obj)}${LESSON_BLOCK_SUFFIX}`);
                    modifiedCount++;
                    continue;
                }
            }
            catch {
                // Malformed block — preserve verbatim.
            }
        }
        result.push(line);
    }
    return { newBody: result.join("\n"), modifiedCount };
}
// ---------------------------------------------------------------------------
// Persona reconstruction (mirrors apply-persona-append.ts)
// ---------------------------------------------------------------------------
function reconstructPersonaFile(parsed, newKnowledgeBody) {
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
// ---------------------------------------------------------------------------
// IO helpers
// ---------------------------------------------------------------------------
import { promises as fs } from "node:fs";
async function readFile(absPath) {
    return fs.readFile(absPath, "utf8");
}
