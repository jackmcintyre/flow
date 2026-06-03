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
import { readPersona } from "./read-persona.js";
import { parseKnowledgeSection, rankAndCap, } from "../lib/parse-knowledge-section.js";
import { appendArchivedLessons } from "../lib/lesson-archive.js";
import { removeKnowledgeLessonsById } from "../lib/update-knowledge-section.js";
/** Default briefing budget — configurable per invocation. */
export const DEFAULT_BRIEFING_BUDGET = 10;
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
export async function buildPersonaSpawnPrompt(opts) {
    const { targetRepoRoot, role } = opts;
    const budget = opts.briefingBudget ?? DEFAULT_BRIEFING_BUDGET;
    // One read per call — this is the assembly contract.
    const persona = await readPersona({ targetRepoRoot, role });
    // Parse the Knowledge section and apply the budget cap.
    const allLessons = parseKnowledgeSection(persona.sections["Knowledge"]);
    const { kept, overflow } = rankAndCap(allLessons, budget);
    // Archive overflow lessons and remove them from the live store (side-effects).
    if (overflow.length > 0) {
        await appendArchivedLessons(targetRepoRoot, role, overflow);
        const overflowIds = new Set(overflow.map((l) => l.id));
        await removeKnowledgeLessonsById(targetRepoRoot, role, overflowIds);
    }
    // Assemble the prompt using the capped index.
    const knowledgeIndexLines = buildKnowledgeIndexFromEntries(kept);
    const systemPrompt = assemblePrompt(persona, knowledgeIndexLines);
    return { systemPrompt };
}
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
export function assemblePrompt(persona, knowledgeIndexLines) {
    const displayName = toDisplayName(persona.role);
    const lockedPhraseLines = [];
    for (const [label, phrase] of [
        ["Handoff", persona.locked_phrases.handoff],
        ["Yield", persona.locked_phrases.yield],
        ["Verdict", persona.locked_phrases.verdict],
    ]) {
        lockedPhraseLines.push(`- ${label}: "${phrase}"`);
        // Extract all <token> placeholders in the phrase.
        const tokenPattern = /<([^>]+)>/g;
        let match;
        while ((match = tokenPattern.exec(phrase)) !== null) {
            const token = match[0]; // e.g. "<story-id>"
            lockedPhraseLines.push(`Substitute ${token} with the live value from your initial context before emission; emit the substituted phrase verbatim.`);
        }
    }
    // Use pre-computed index lines when provided (the IO path has already done
    // ranking + archiving). Fall back to a full parse for the pure unit-test path.
    const effectiveIndexLines = knowledgeIndexLines ?? buildKnowledgeIndex(persona.sections["Knowledge"]);
    const parts = [
        `# ${displayName} — Persona`,
        ``,
        `## Domain`,
        ``,
        persona.sections["Domain"],
        ``,
        `## Mandate`,
        ``,
        persona.sections["Mandate"],
        ``,
        `## Out of mandate`,
        ``,
        persona.sections["Out of mandate"],
        ``,
        `## Prompt`,
        ``,
        persona.sections["Prompt"],
        ``,
        `## Knowledge`,
        ``,
        ...effectiveIndexLines,
        ``,
        `## Locked phrases (do not paraphrase)`,
        ...lockedPhraseLines,
    ];
    return parts.join("\n");
}
/**
 * Build the one-line knowledge index from the Knowledge section body.
 *
 * Falls back to a full parse (no budget cap, no archiving) — used by the
 * pure `assemblePrompt` path when no pre-computed index is provided.
 *
 * Returns one summary line per lesson in file order:
 *   `- [<id>] <kind> | <applies_when>`
 *
 * When no lessons are present, returns `["(no lessons yet)"]`.
 */
function buildKnowledgeIndex(knowledgeBody) {
    const lessons = parseKnowledgeSection(knowledgeBody);
    return buildKnowledgeIndexFromEntries(lessons);
}
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
export function buildKnowledgeIndexFromEntries(lessons) {
    if (lessons.length === 0) {
        return ["(no lessons yet)"];
    }
    return lessons.map((l) => `- [${l.id}] ${l.kind} | ${l.applies_when}`);
}
function toDisplayName(role) {
    return role
        .split("-")
        .map((part) => part.length === 0 ? part : part[0].toUpperCase() + part.slice(1))
        .join(" ");
}
