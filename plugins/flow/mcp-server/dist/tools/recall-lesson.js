/**
 * `recallLesson` tool — Story native:01KT6QEWY794ZY0DH6JHQFWG6V
 * (Swap agent briefings from full lesson text to a one-line index with on-demand recall).
 *
 * The companion to the one-line index in `buildPersonaSpawnPrompt`. When an agent
 * receives a briefing with the compact knowledge index it can call this tool with
 * a lesson `id` to retrieve the full `detail` body of that single lesson.
 *
 * Behaviour:
 *  1. Read the persona file at `<targetRepoRoot>/team/<role>/PERSONA.md`.
 *     Throws `PersonaFileNotFoundError` when absent (propagated from `readPersona`).
 *  2. Scan the `## Knowledge` section body for a structured lesson block whose
 *     `id` field matches the supplied `id`.
 *  3. If found in the live store, increment `use_count` and stamp `last_used_at`,
 *     write the updated lesson block back to the persona file, and return the full
 *     lesson body.
 *  4. If NOT found in the live store, search the archived lesson store at
 *     `team/<role>/_archived/<id>.json`. If found there, return the full lesson
 *     body (archived lessons are retrievable but their use_count is also updated
 *     in the archive file).
 *  5. If not found in either store, return `{ id: null, detail: null }` — a soft
 *     miss (not an error, because the lesson might have been permanently removed or
 *     the id might be stale).
 *
 * Updating usage tracking: this tool performs a write-back when it returns a lesson.
 * The write-back is best-effort: if the write fails the lesson is still returned
 * (we never block a recall on a telemetry write failure).
 *
 * Story native:01KT6QSW4W7SMAHAT4EAKCCC65 additions:
 *  - Archived store fallback (step 4 above).
 *  - use_count / last_used_at write-back on hit.
 */
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { readPersona } from "./read-persona.js";
import { writeManagedFile } from "../lib/managed-fs.js";
import { parsePersonaFile } from "../lib/persona-file.js";
import { findArchivedLessonById, LESSON_BLOCK_PREFIX, LESSON_BLOCK_SUFFIX, serialiseLessonBlock, } from "../lib/lesson-archive.js";
import { stringify as yamlStringify } from "yaml";
/** Sentinel / suffix constants mirrored from get-team-snapshot.ts. */
const _LESSON_BLOCK_PREFIX = LESSON_BLOCK_PREFIX;
const _LESSON_BLOCK_SUFFIX = LESSON_BLOCK_SUFFIX;
const TOOL_NAME = "recallLesson";
/**
 * Retrieve the full body of one structured lesson by id from a role's
 * `## Knowledge` section, falling back to the archived store when not found
 * in the live persona file.
 *
 * When a lesson is found, `use_count` is incremented and `last_used_at` is
 * stamped. The write-back is best-effort; a failed write does not prevent the
 * lesson from being returned.
 *
 * @throws {PersonaFileNotFoundError} When `team/<role>/PERSONA.md` is absent.
 * @throws {PersonaFileMalformedError} When the persona file fails the parser.
 */
export async function recallLesson(opts) {
    const { targetRepoRoot, role, id, now = () => new Date() } = opts;
    // --- Step 1: read the live persona file ---
    const persona = await readPersona({ targetRepoRoot, role });
    const knowledgeBody = persona.sections["Knowledge"];
    // --- Step 2: search the live store ---
    const liveHit = findLessonById(knowledgeBody, id);
    if (liveHit !== null) {
        // --- Step 3: found in live store — write-back use_count/last_used_at ---
        const nowIso = now().toISOString();
        const updatedLesson = {
            ...liveHit,
            use_count: (liveHit.use_count ?? 0) + 1,
            last_used_at: nowIso,
        };
        try {
            const updatedBody = updateLessonInBody(knowledgeBody, updatedLesson);
            const personaPath = path.join(targetRepoRoot, "team", role, "PERSONA.md");
            const rawPersona = await fs.readFile(personaPath, "utf8");
            const parsed = parsePersonaFile(rawPersona, personaPath);
            const newContents = reconstructPersonaFile(parsed, updatedBody);
            await writeManagedFile({
                absPath: personaPath,
                contents: newContents,
                targetRepoRoot,
                mcpToolContext: { toolName: TOOL_NAME, role },
            });
        }
        catch {
            // Best-effort write-back: if the update fails, still return the lesson.
        }
        const hit = {
            id: liveHit.id,
            kind: liveHit.kind,
            applies_when: liveHit.applies_when,
            detail: liveHit.detail,
            learned_at: liveHit.learned_at,
        };
        if (liveHit.failure_class !== undefined)
            hit.failure_class = liveHit.failure_class;
        if (liveHit.source_ref !== undefined)
            hit.source_ref = liveHit.source_ref;
        if (liveHit.source_pr !== undefined)
            hit.source_pr = liveHit.source_pr;
        return { found: true, lesson: hit };
    }
    // --- Step 4: not in live store — search the archived store ---
    const archivedLesson = await findArchivedLessonById(targetRepoRoot, role, id);
    if (archivedLesson !== null) {
        // Write-back use_count/last_used_at to the archive file (best-effort).
        const nowIso = now().toISOString();
        try {
            const updated = {
                ...archivedLesson,
                use_count: (archivedLesson.use_count ?? 0) + 1,
                last_used_at: nowIso,
            };
            const relPath = `team/${role}/_archived/${id}.json`;
            await writeManagedFile({
                absPath: path.join(targetRepoRoot, relPath),
                contents: JSON.stringify(updated, null, 2) + "\n",
                targetRepoRoot,
                mcpToolContext: { toolName: TOOL_NAME, role },
            });
        }
        catch {
            // Best-effort.
        }
        const hit = {
            id: archivedLesson.id,
            kind: archivedLesson.kind,
            applies_when: archivedLesson.applies_when,
            detail: archivedLesson.detail,
            learned_at: archivedLesson.learned_at,
            archived: true,
        };
        if (archivedLesson.failure_class !== undefined)
            hit.failure_class = archivedLesson.failure_class;
        if (archivedLesson.source_ref !== undefined)
            hit.source_ref = archivedLesson.source_ref;
        if (archivedLesson.source_pr !== undefined)
            hit.source_pr = archivedLesson.source_pr;
        return { found: true, lesson: hit };
    }
    // --- Step 5: soft miss ---
    return { found: false, lesson: null };
}
/**
 * Scan the `## Knowledge` section body for the structured lesson block
 * whose `id` matches the supplied value.
 *
 * Returns the parsed `ParsedLesson` (which includes use_count/last_used_at)
 * or `null` when no match is found.
 *
 * Exported for unit testing.
 */
export function findLessonById(knowledgeBody, id) {
    for (const line of knowledgeBody.split("\n")) {
        const trimmed = line.trimStart();
        if (!trimmed.startsWith(_LESSON_BLOCK_PREFIX) ||
            !trimmed.endsWith(_LESSON_BLOCK_SUFFIX)) {
            continue;
        }
        const jsonStr = trimmed
            .slice(_LESSON_BLOCK_PREFIX.length, trimmed.length - _LESSON_BLOCK_SUFFIX.length)
            .trim();
        let raw;
        try {
            raw = JSON.parse(jsonStr);
        }
        catch {
            // Invalid JSON — skip silently (best-effort migration safety, mirrors get-team-snapshot).
            continue;
        }
        if (raw === null ||
            typeof raw !== "object" ||
            !("id" in raw) ||
            raw["id"] !== id) {
            continue;
        }
        // Found a matching block — extract fields.
        const obj = raw;
        if (typeof obj["id"] !== "string" ||
            typeof obj["kind"] !== "string" ||
            typeof obj["applies_when"] !== "string" ||
            typeof obj["detail"] !== "string" ||
            typeof obj["learned_at"] !== "string") {
            // Malformed block that happens to match the id — skip silently.
            continue;
        }
        const lesson = {
            id: obj["id"],
            kind: obj["kind"],
            applies_when: obj["applies_when"],
            detail: obj["detail"],
            learned_at: obj["learned_at"],
        };
        if (typeof obj["use_count"] === "number") {
            lesson.use_count = obj["use_count"];
        }
        if (typeof obj["last_used_at"] === "string") {
            lesson.last_used_at = obj["last_used_at"];
        }
        if (typeof obj["failure_class"] === "string") {
            lesson.failure_class = obj["failure_class"];
        }
        if (typeof obj["source_ref"] === "string") {
            lesson.source_ref = obj["source_ref"];
        }
        if (typeof obj["source_pr"] === "string") {
            lesson.source_pr = obj["source_pr"];
        }
        return lesson;
    }
    return null;
}
/**
 * Replace the lesson block for a given lesson id in the Knowledge section body
 * with an updated block (reflecting new use_count / last_used_at).
 *
 * If the lesson id is not found, the body is returned unchanged.
 *
 * Exported for unit testing.
 */
export function updateLessonInBody(body, updatedLesson) {
    const lines = body.split("\n");
    const outLines = [];
    for (const line of lines) {
        const trimmed = line.trimStart();
        if (trimmed.startsWith(_LESSON_BLOCK_PREFIX) &&
            trimmed.endsWith(_LESSON_BLOCK_SUFFIX)) {
            const jsonStr = trimmed
                .slice(_LESSON_BLOCK_PREFIX.length, trimmed.length - _LESSON_BLOCK_SUFFIX.length)
                .trim();
            try {
                const raw = JSON.parse(jsonStr);
                if (raw !== null &&
                    typeof raw === "object" &&
                    "id" in raw &&
                    raw["id"] === updatedLesson.id) {
                    outLines.push(serialiseLessonBlock(updatedLesson));
                    continue;
                }
            }
            catch {
                // Malformed block — preserve as-is.
            }
        }
        outLines.push(line);
    }
    return outLines.join("\n");
}
// ---------------------------------------------------------------------------
// Persona file reconstruction (mirrors apply-persona-append.ts helper)
// ---------------------------------------------------------------------------
/**
 * Reconstruct the full persona file from parsed sections, replacing the
 * Knowledge body with `newKnowledgeBody`.
 *
 * Mirrors `reconstructPersonaFile` in `apply-persona-append.ts` but is
 * private to this module to avoid a circular import.
 */
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
