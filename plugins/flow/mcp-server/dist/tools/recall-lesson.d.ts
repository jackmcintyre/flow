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
export interface RecallLessonOptions {
    /** Absolute path to the target repository root. */
    targetRepoRoot: string;
    /** The role whose persona to read (kebab-case, e.g. `"generalist-dev"`). */
    role: string;
    /** The stable ULID id of the lesson from the index in the agent's briefing. */
    id: string;
}
export type RecallLessonResult = {
    found: true;
    id: string;
    kind: "pitfall" | "pattern" | "tool-quirk" | "discipline";
    applies_when: string;
    detail: string;
    source_ref?: string;
} | {
    found: false;
};
/**
 * Return the full body of one lesson by id from a role's Knowledge section.
 *
 * @throws {PersonaFileNotFoundError} When the persona file is absent.
 * @throws {PersonaFileMalformedError} When the persona file fails the parser.
 */
export declare function recallLesson(opts: RecallLessonOptions): Promise<RecallLessonResult>;
