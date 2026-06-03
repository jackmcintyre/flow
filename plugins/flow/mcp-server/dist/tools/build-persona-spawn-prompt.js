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
 * Architecture §MCP Tool Naming — camelCase verb-noun: `buildPersonaSpawnPrompt`.
 * Story 4.2 Task 4.1–4.5.
 */
import { readPersona } from "./read-persona.js";
import { parseKnowledgeSection } from "../lib/parse-knowledge-section.js";
/**
 * Assemble the system prompt for a dev-subagent spawn.
 *
 * Reads the persona file at `<targetRepoRoot>/team/<role>/PERSONA.md`
 * exactly once per call, then concatenates the five sections plus the
 * locked-phrases sentinel block.
 *
 * @throws {PersonaFileNotFoundError} When the persona file is absent.
 * @throws {PersonaFileMalformedError} When the persona file fails the parser.
 */
export async function buildPersonaSpawnPrompt(opts) {
    const { targetRepoRoot, role } = opts;
    // One read per call — this is the assembly contract.
    const persona = await readPersona({ targetRepoRoot, role });
    const systemPrompt = assemblePrompt(persona);
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
 */
export function assemblePrompt(persona) {
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
    // Build the one-line knowledge index from the structured lesson store.
    // Each line: `- [<id>] <kind> | <applies_when>`
    // Agents receive the compact index; full lesson detail is on-demand via recallLesson.
    const knowledgeIndexLines = buildKnowledgeIndex(persona.sections["Knowledge"]);
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
        ...knowledgeIndexLines,
        ``,
        `## Locked phrases (do not paraphrase)`,
        ...lockedPhraseLines,
    ];
    return parts.join("\n");
}
/**
 * Build the one-line knowledge index from the Knowledge section body.
 *
 * Returns one summary line per lesson in file order:
 *   `- [<id>] <kind> | <applies_when>`
 *
 * When no lessons are present, returns `["(no lessons yet)"]`.
 *
 * Agents use this compact index to decide whether to recall a specific lesson
 * via the `recallLesson` tool rather than receiving the full body of every lesson
 * in the briefing regardless of relevance (Story native:01KT6QEWY794ZY0DH6JHQFWG6V).
 */
function buildKnowledgeIndex(knowledgeBody) {
    const lessons = parseKnowledgeSection(knowledgeBody);
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
