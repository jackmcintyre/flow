/**
 * `buildPersonaSpawnPrompt` MCP tool — Story 4.2 Task 4.
 *
 * Assembles the system prompt text for a dev-subagent spawn by reading
 * the persona file at `<targetRepoRoot>/team/<role>/PERSONA.md` and
 * concatenating the five required sections in canonical order:
 *
 *   # <Role display name> — Persona
 *
 *   ## Domain
 *   <Domain section verbatim>
 *
 *   ## Mandate
 *   <Mandate section verbatim>
 *
 *   ## Out of mandate
 *   <Out of mandate section verbatim>
 *
 *   ## Prompt
 *   <Prompt section verbatim>
 *
 *   ## Knowledge
 *   <Knowledge section verbatim>
 *
 *   ## Locked phrases (do not paraphrase)
 *   - Handoff: "<locked_phrases.handoff verbatim>"
 *   - Yield: "<locked_phrases.yield verbatim>"
 *   - Verdict: "<locked_phrases.verdict verbatim>"
 *
 * The frontmatter keys (`role:`, `domain:`, `model_tier:`, `tools_allow:`,
 * `gh_allow:`, `locked_phrases:`, `hired_at:`, `catalogue_version:`) are NOT
 * included — they are plugin-runtime metadata, not LLM instructions.
 *
 * The locked phrases from the frontmatter ARE appended as the sentinel block
 * after `## Knowledge`. This is the single source where locked-phrase strings
 * cross from frontmatter into LLM-readable text (Story 4.2 Task 4.3).
 *
 * Centralising assembly here means a future persona-format change updates one
 * place. The `/flow:start` skill calls this once per spawn; the tool internally
 * calls `readPersona` once per invocation. On a subsequent claim within the
 * same session, the skill calls this tool again so a persona edit between
 * stories is picked up at the next spawn.
 *
 * Edge case: if `<targetRepoRoot>/team/<role>/PERSONA.md` does not exist,
 * `readPersona` throws `PersonaFileNotFoundError`. This tool propagates it
 * verbatim. The skill must surface it and stop — the operator MUST run
 * `/flow:hire` (or `/flow:skip-hiring`) before `/flow:start`.
 *
 * The dev subagent's `permissions/generalist-dev.yaml` MUST NOT include
 * `buildPersonaSpawnPrompt` — the subagent does not assemble its own prompt;
 * the orchestrator does (Architecture §Persona injection).
 *
 * ## Budget cap (Story native:01KT6QSW4W7SMAHAT4EAKCCC65)
 *
 * When the live lesson store exceeds `briefingBudget` entries, the top-ranked
 * lessons (by use_count desc, then last_used_at desc) fill the always-shown
 * index. Overflow lessons are archived to `team/<role>/_archived/lessons.json`
 * with an `archived_at` timestamp and removed from the live store. Archived
 * lessons remain retrievable by id via the `recallLesson` tool.
 *
 * The budget caps the always-shown index size only — the total role knowledge
 * is never deleted.
 *
 * Architecture §MCP Tool Naming — camelCase verb-noun: `buildPersonaSpawnPrompt`.
 * Story 4.2 Task 4.1–4.5.
 */
import type { PersonaFile } from "../schemas/persona.js";
/** Default briefing budget — configurable per invocation. */
export declare const DEFAULT_BRIEFING_BUDGET = 10;
export interface BuildPersonaSpawnPromptOptions {
    targetRepoRoot: string;
    role: string;
    /**
     * Maximum number of lessons to show in the always-shown index.
     * Overflow is archived. Defaults to {@link DEFAULT_BRIEFING_BUDGET}.
     */
    briefingBudget?: number;
}
export interface BuildPersonaSpawnPromptResult {
    systemPrompt: string;
}
/**
 * Assemble the system prompt for a dev-subagent spawn.
 *
 * Reads the persona file at `<targetRepoRoot>/team/<role>/PERSONA.md`
 * exactly once per call, then:
 *   1. Parses the Knowledge section into structured lessons.
 *   2. Ranks by use_count desc then last_used_at desc and applies the budget cap.
 *   3. Archives overflow lessons to `team/<role>/_archived/lessons.json`
 *      (stamped with `archived_at`) and removes them from the live store.
 *   4. Builds the always-shown index from the top-`briefingBudget` lessons
 *      and assembles the full system prompt.
 *
 * @throws {PersonaFileNotFoundError} When the persona file is absent.
 * @throws {PersonaFileMalformedError} When the persona file fails the parser.
 */
export declare function buildPersonaSpawnPrompt(opts: BuildPersonaSpawnPromptOptions): Promise<BuildPersonaSpawnPromptResult>;
/**
 * Pure assembler — no IO. Exported for unit testing.
 *
 * Composition order (load-bearing — pins the architecture decision from
 * Story 4.2 Task 4.2):
 *   1. H1 display name
 *   2. ## Domain
 *   3. ## Mandate
 *   4. ## Out of mandate
 *   5. ## Prompt
 *   6. ## Knowledge
 *   7. ## Locked phrases (do not paraphrase)
 *
 * Frontmatter is NOT included in the output.
 *
 * Story 4.3 Task 5: For each locked phrase that contains a `<...>` token,
 * an additional substitution-instruction line is appended so the LLM knows
 * to substitute the live value from its initial context before emission.
 *
 * @param persona            - The parsed persona file.
 * @param knowledgeIndexLines - Pre-computed index lines. When omitted, the
 *   full Knowledge section body is parsed on the fly (unit-test path; no
 *   archiving — pure function contract preserved).
 */
export declare function assemblePrompt(persona: PersonaFile, knowledgeIndexLines?: string[]): string;
/**
 * Build the one-line knowledge index from a pre-parsed, pre-capped lesson list.
 *
 * Returns one summary line per entry:
 *   `- [<id>] <kind> | <applies_when>`
 *
 * When the list is empty, returns `["(no lessons yet)"]`.
 *
 * Exported so tests can verify the index shape independently.
 */
export declare function buildKnowledgeIndexFromEntries(lessons: import("../lib/parse-knowledge-section.js").ParsedLessonEntry[]): string[];
