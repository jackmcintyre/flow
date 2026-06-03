/**
 * `recallLesson` tool — Story native:01KT6QEWY794ZY0DH6JHQFWG6V.
 *
 * Agents receive a compact one-line index of their role's lessons in their
 * briefing (built by `buildPersonaSpawnPrompt`). When an agent needs the full
 * body of a specific lesson, it calls this tool with the lesson id from the
 * index to retrieve the complete detail.
 *
 * Behaviour:
 *   1. Read the persona file at `<targetRepoRoot>/team/<role>/PERSONA.md` via
 *      `readPersona` (throws `PersonaFileNotFoundError` when absent).
 *   2. Parse the `## Knowledge` section via `parseKnowledgeSection` to extract
 *      all lessons including their stable ids.
 *   3. Find the entry whose `id` matches the requested id. Return its full body
 *      (`detail`, `kind`, `applies_when`, `source_ref`).
 *   4. If no entry matches, return `{ found: false }`.
 *
 * Read-only — never writes to disk.
 *
 * (Story native:01KT6QEWY794ZY0DH6JHQFWG6V AC2)
 */
import { readPersona } from "./read-persona.js";
import { parseKnowledgeSection } from "../lib/parse-knowledge-section.js";
/**
 * Return the full body of one lesson by id from a role's Knowledge section.
 *
 * @throws {PersonaFileNotFoundError} When the persona file is absent.
 * @throws {PersonaFileMalformedError} When the persona file fails the parser.
 */
export async function recallLesson(opts) {
    const { targetRepoRoot, role, id } = opts;
    const persona = await readPersona({ targetRepoRoot, role });
    const lessons = parseKnowledgeSection(persona.sections["Knowledge"]);
    const match = lessons.find((l) => l.id === id);
    if (match === undefined) {
        return { found: false };
    }
    return {
        found: true,
        id: match.id,
        kind: match.kind,
        applies_when: match.applies_when,
        detail: match.detail,
        ...(match.source_ref !== undefined ? { source_ref: match.source_ref } : {}),
    };
}
