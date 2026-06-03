/**
 * Lesson archiving helpers for the role Knowledge store — Story native:01KT6QSW4W7SMAHAT4EAKCCC65.
 *
 * When a role's live lesson index grows beyond the briefing budget, overflow
 * lessons are demoted to the role's archived lesson store rather than deleted.
 * Archived lessons remain retrievable by id via `recallLesson` but are no
 * longer included in the agent's always-shown briefing index.
 *
 * ## Storage layout
 *
 * Live lessons:    stored as `<!-- lesson:json ... -->` blocks in the role's
 *                  `team/<role>/PERSONA.md` Knowledge section.
 *
 * Archived lessons: `team/<role>/_archived/lessons.json` — a JSON array of
 *                   `ArchivedLesson` objects. Each carries all original lesson
 *                   fields plus an `archived_at` ISO-8601 timestamp. No lesson
 *                   is ever deleted.
 *
 * ## Idempotency
 *
 * `appendArchivedLessons` reads the existing archive, merges by id (no
 * duplicates), and rewrites atomically. Demoting the same lesson twice is safe.
 *
 * ## Clock seam
 *
 * The `now` parameter defaults to `() => new Date()` so callers do not need
 * to pass it. Tests inject a fixed clock for deterministic assertions.
 *
 * (Story native:01KT6QSW4W7SMAHAT4EAKCCC65 — AC3, lesson-archive.test.ts)
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { atomicWriteFile } from "./managed-fs.js";
// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------
/**
 * Absolute path to the archived lessons file for a role.
 * Convention: `<targetRepoRoot>/team/<role>/_archived/lessons.json`
 */
export function archivedLessonsPath(targetRepoRoot, role) {
    return path.join(targetRepoRoot, "team", role, "_archived", "lessons.json");
}
// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------
/**
 * Read the archived lessons for a role. Returns an empty array when the
 * archive file does not exist (ENOENT → `[]`). Propagates other IO errors.
 *
 * Parses the JSON as an array, returning `[]` on any shape mismatch (graceful
 * corruption recovery).
 */
export async function readArchivedLessons(targetRepoRoot, role) {
    const absPath = archivedLessonsPath(targetRepoRoot, role);
    let raw;
    try {
        raw = await fs.readFile(absPath, "utf8");
    }
    catch (err) {
        if (isEnoent(err)) {
            return [];
        }
        throw err;
    }
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            return parsed;
        }
        return [];
    }
    catch {
        return [];
    }
}
// ---------------------------------------------------------------------------
// Write helpers
// ---------------------------------------------------------------------------
/**
 * Append demoted lessons to the archived lesson store for a role, stamping
 * each with `archived_at = now()`. Existing entries are preserved — demotion
 * is idempotent (merges by id, never doubles an entry).
 *
 * Returns the final array written to disk (the merged archive).
 *
 * @param targetRepoRoot  - Absolute path to the repo root.
 * @param role            - Role id (e.g. `"generalist-dev"`).
 * @param lessons         - Lessons to demote. Must include all original fields.
 * @param now             - Injectable clock; defaults to `() => new Date()`.
 */
export async function appendArchivedLessons(targetRepoRoot, role, lessons, now = () => new Date()) {
    const absPath = archivedLessonsPath(targetRepoRoot, role);
    // Ensure parent directory exists.
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    // Read existing archive (empty when file absent).
    const existing = await readArchivedLessons(targetRepoRoot, role);
    // Build a set of already-archived ids to avoid duplicates.
    const existingIds = new Set(existing.map((e) => e.id));
    const nowStr = now().toISOString();
    const newEntries = lessons
        .filter((l) => !existingIds.has(l.id))
        .map((l) => ({
        ...l,
        archived_at: nowStr,
    }));
    const merged = [...existing, ...newEntries];
    await atomicWriteFile(absPath, JSON.stringify(merged, null, 2));
    return merged;
}
// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------
function isEnoent(err) {
    return (typeof err === "object" &&
        err !== null &&
        "code" in err &&
        err.code === "ENOENT");
}
