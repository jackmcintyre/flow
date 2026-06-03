/**
 * Shared lesson-block parser for the Knowledge section of a persona file.
 *
 * Used by:
 *   - `build-persona-spawn-prompt.ts` — to build a one-line index for the agent briefing
 *   - `recall-lesson.ts` — to look up a lesson by id and return its full body
 *
 * Structured lessons are stored as HTML comment blocks:
 *   <!-- lesson:json {"id":"<ULID>","kind":"...","applies_when":"...","detail":"...",...} -->
 *
 * Flat `- bullet` entries from before the structured format are migrated at read-time
 * with a synthesised id derived from their line position
 * (`MIGRATED-<zero-padded-index>`), kind defaults to `"pattern"`, and `applies_when`
 * equals the bullet text.
 *
 * (Story native:01KT6QEWY794ZY0DH6JHQFWG6V)
 * (Story native:01KT6QSW4W7SMAHAT4EAKCCC65 — adds use_count and last_used_at)
 */
/** Sentinel wrapper that unambiguously marks a structured lesson line. */
const LESSON_BLOCK_PREFIX = "<!-- lesson:json ";
const LESSON_BLOCK_SUFFIX = " -->";
/**
 * Parse every lesson from the body of a `## Knowledge` section.
 *
 * Returns entries in file order (top to bottom).  The caller decides
 * limiting / reversal if needed.
 *
 * Algorithm:
 *  - Lines starting with `<!-- lesson:json ` and ending with ` -->` are
 *    parsed as structured entries (id included verbatim).
 *  - Top-level `^- ` bullet lines that are NOT lesson blocks are migrated
 *    with a synthetic `MIGRATED-<N>` id (N = zero-based order among migrated
 *    entries).
 *  - All other lines (blank, indented, etc.) are skipped.
 *  - Invalid JSON in a lesson block is silently skipped (migration safety).
 */
export function parseKnowledgeSection(knowledgeBody) {
    const entries = [];
    let migratedIndex = 0;
    for (const line of knowledgeBody.split("\n")) {
        const trimmed = line.trimStart();
        // Structured lesson block.
        if (trimmed.startsWith(LESSON_BLOCK_PREFIX) && trimmed.endsWith(LESSON_BLOCK_SUFFIX)) {
            const jsonStr = trimmed
                .slice(LESSON_BLOCK_PREFIX.length, trimmed.length - LESSON_BLOCK_SUFFIX.length)
                .trim();
            try {
                const raw = JSON.parse(jsonStr);
                if (raw !== null &&
                    typeof raw === "object" &&
                    "kind" in raw &&
                    "applies_when" in raw &&
                    "detail" in raw) {
                    const obj = raw;
                    const id = typeof obj["id"] === "string" && obj["id"].length > 0
                        ? obj["id"]
                        : `MISSING-ID-${migratedIndex++}`;
                    entries.push({
                        id,
                        kind: obj["kind"],
                        applies_when: String(obj["applies_when"]),
                        detail: String(obj["detail"]),
                        ...(typeof obj["source_ref"] === "string" && obj["source_ref"].length > 0
                            ? { source_ref: obj["source_ref"] }
                            : {}),
                        use_count: typeof obj["use_count"] === "number" ? obj["use_count"] : 0,
                        last_used_at: typeof obj["last_used_at"] === "string" && obj["last_used_at"].length > 0
                            ? obj["last_used_at"]
                            : null,
                    });
                }
            }
            catch {
                // Invalid JSON — skip silently.
            }
            continue;
        }
        // Flat-bullet migration: top-level `- text` lines.
        const match = /^-\s+(.+?)\s*$/.exec(line);
        if (match) {
            const text = match[1];
            entries.push({
                id: `MIGRATED-${migratedIndex++}`,
                kind: "pattern",
                applies_when: text,
                detail: text,
                use_count: 0,
                last_used_at: null,
            });
        }
    }
    return entries;
}
/**
 * Rank lessons by usefulness and apply a budget cap.
 *
 * Ranking criteria (descending priority):
 *   1. `use_count` descending — more-recalled lessons are more relevant.
 *   2. `last_used_at` descending — among equal use counts, most recently recalled first.
 *      Lessons that have never been recalled (`last_used_at === null`) rank lowest.
 *
 * The top `budget` lessons are `kept`; the remainder are `overflow`.
 * When `lessons.length <= budget`, all lessons are kept and `overflow` is empty.
 *
 * @param lessons   - All live lessons from the role's Knowledge section.
 * @param budget    - Maximum number of always-shown entries (default: 10).
 */
export function rankAndCap(lessons, budget = 10) {
    // Sort a copy — do not mutate the caller's array.
    const sorted = [...lessons].sort((a, b) => {
        // Primary: use_count descending.
        if (b.use_count !== a.use_count) {
            return b.use_count - a.use_count;
        }
        // Secondary: last_used_at descending (null = epoch 0, always last).
        const aTime = a.last_used_at ? new Date(a.last_used_at).getTime() : 0;
        const bTime = b.last_used_at ? new Date(b.last_used_at).getTime() : 0;
        return bTime - aTime;
    });
    return {
        kept: sorted.slice(0, budget),
        overflow: sorted.slice(budget),
    };
}
