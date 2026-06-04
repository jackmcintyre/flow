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
 *  3. If found, return `{ id, kind, applies_when, detail, failure_class?, source_ref?,
 *     source_pr?, learned_at }` — the full lesson body.
 *  4. If not found, return `{ id: null, detail: null }` — a soft miss (not an
 *     error, because the lesson might have been pruned or the id might be stale).
 *
 * Read-only by design: this tool never writes and never throws on a missing lesson.
 * Only absent persona files or malformed persona files throw.
 */
import { readPersona } from "./read-persona.js";
/** Sentinel / suffix constants mirrored from get-team-snapshot.ts. */
const LESSON_BLOCK_PREFIX = "<!-- lesson:json ";
const LESSON_BLOCK_SUFFIX = " -->";
/**
 * Retrieve the full body of one structured lesson by id from a role's
 * `## Knowledge` section.
 *
 * @throws {PersonaFileNotFoundError} When `team/<role>/PERSONA.md` is absent.
 * @throws {PersonaFileMalformedError} When the persona file fails the parser.
 */
export async function recallLesson(opts) {
    const { targetRepoRoot, role, id } = opts;
    const persona = await readPersona({ targetRepoRoot, role });
    const hit = findLessonById(persona.sections["Knowledge"], id);
    if (hit === null) {
        return { found: false, lesson: null };
    }
    return { found: true, lesson: hit };
}
/**
 * Scan the `## Knowledge` section body for the structured lesson block
 * whose `id` matches the supplied value.
 *
 * Returns the parsed `RecallLessonHit` or `null` when no match is found.
 *
 * Exported for unit testing.
 */
export function findLessonById(knowledgeBody, id) {
    for (const line of knowledgeBody.split("\n")) {
        const trimmed = line.trimStart();
        if (!trimmed.startsWith(LESSON_BLOCK_PREFIX) ||
            !trimmed.endsWith(LESSON_BLOCK_SUFFIX)) {
            continue;
        }
        const jsonStr = trimmed
            .slice(LESSON_BLOCK_PREFIX.length, trimmed.length - LESSON_BLOCK_SUFFIX.length)
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
        const hit = {
            id: obj["id"],
            kind: obj["kind"],
            applies_when: obj["applies_when"],
            detail: obj["detail"],
            learned_at: obj["learned_at"],
        };
        if (typeof obj["failure_class"] === "string") {
            hit.failure_class = obj["failure_class"];
        }
        if (typeof obj["source_ref"] === "string") {
            hit.source_ref = obj["source_ref"];
        }
        if (typeof obj["source_pr"] === "string") {
            hit.source_pr = obj["source_pr"];
        }
        return hit;
    }
    return null;
}
