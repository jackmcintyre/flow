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
export interface UpdatedPersonaResult {
    /** Repo-relative path that was rewritten. */
    personaRelPath: string;
    /** Number of lesson blocks removed or updated. */
    modifiedCount: number;
}
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
export declare function removeKnowledgeLessonsById(targetRepoRoot: string, role: string, idsToRemove: Set<string>): Promise<UpdatedPersonaResult>;
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
export declare function updateLessonUsageInPersona(targetRepoRoot: string, role: string, id: string, useCount: number, lastUsedAt: string): Promise<UpdatedPersonaResult>;
