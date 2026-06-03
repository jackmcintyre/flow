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
 */

/** Sentinel wrapper that unambiguously marks a structured lesson line. */
const LESSON_BLOCK_PREFIX = "<!-- lesson:json ";
const LESSON_BLOCK_SUFFIX = " -->";

/**
 * A parsed knowledge lesson entry that includes the stable `id` field so the
 * `recallLesson` tool can look entries up by id and `buildPersonaSpawnPrompt`
 * can render a one-line index without the full body.
 */
export interface ParsedLessonEntry {
  /** Stable ULID from structured entries, or `"MIGRATED-<N>"` for flat bullets. */
  id: string;
  /** Closed lesson-kind enum value. */
  kind: "pitfall" | "pattern" | "tool-quirk" | "discipline";
  /** Short trigger line shown in the one-line index. */
  applies_when: string;
  /** Full lesson prose — NOT included in the briefing index. */
  detail: string;
  /** Provenance — optional story ref. */
  source_ref?: string;
}

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
export function parseKnowledgeSection(knowledgeBody: string): ParsedLessonEntry[] {
  const entries: ParsedLessonEntry[] = [];
  let migratedIndex = 0;

  for (const line of knowledgeBody.split("\n")) {
    const trimmed = line.trimStart();

    // Structured lesson block.
    if (trimmed.startsWith(LESSON_BLOCK_PREFIX) && trimmed.endsWith(LESSON_BLOCK_SUFFIX)) {
      const jsonStr = trimmed
        .slice(LESSON_BLOCK_PREFIX.length, trimmed.length - LESSON_BLOCK_SUFFIX.length)
        .trim();
      try {
        const raw = JSON.parse(jsonStr) as unknown;
        if (
          raw !== null &&
          typeof raw === "object" &&
          "kind" in raw &&
          "applies_when" in raw &&
          "detail" in raw
        ) {
          const obj = raw as Record<string, unknown>;
          const id =
            typeof obj["id"] === "string" && obj["id"].length > 0
              ? obj["id"]
              : `MISSING-ID-${migratedIndex++}`;
          entries.push({
            id,
            kind: obj["kind"] as ParsedLessonEntry["kind"],
            applies_when: String(obj["applies_when"]),
            detail: String(obj["detail"]),
            ...(typeof obj["source_ref"] === "string" && obj["source_ref"].length > 0
              ? { source_ref: obj["source_ref"] }
              : {}),
          });
        }
      } catch {
        // Invalid JSON — skip silently.
      }
      continue;
    }

    // Flat-bullet migration: top-level `- text` lines.
    const match = /^-\s+(.+?)\s*$/.exec(line);
    if (match) {
      const text = match[1]!;
      entries.push({
        id: `MIGRATED-${migratedIndex++}`,
        kind: "pattern",
        applies_when: text,
        detail: text,
      });
    }
  }

  return entries;
}
