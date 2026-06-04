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
 * Story native:01KT6QEWY794ZY0DH6JHQFWG6V — compact knowledge index:
 * Instead of embedding the full text of every structured lesson in the
 * `## Knowledge` section, only a one-line summary index is rendered:
 *
 *   `[<id>] <kind> — <applies_when>`
 *
 * This keeps briefings lightweight regardless of how many lessons the role
 * has accumulated. An agent can call `recallLesson({ targetRepoRoot, role,
 * id })` to retrieve the full `detail` body of any lesson it needs. Flat
 * (non-structured) bullet entries that survived migration are included verbatim
 * (they have no id and thus cannot be recalled individually).
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
import type { PersonaFile } from "../schemas/persona.js";
export interface BuildPersonaSpawnPromptOptions {
    targetRepoRoot: string;
    role: string;
}
export interface BuildPersonaSpawnPromptResult {
    systemPrompt: string;
}
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
export declare function buildPersonaSpawnPrompt(opts: BuildPersonaSpawnPromptOptions): Promise<BuildPersonaSpawnPromptResult>;
/**
 * Render a compact one-line knowledge index from the raw `## Knowledge` body.
 *
 * For each structured lesson block (`<!-- lesson:json {...} -->`) a summary line
 * is produced: `[<id>] <kind> — <applies_when>`
 *
 * This keeps the index lightweight (one line per lesson) while preserving the
 * id so the agent can call `recallLesson` to retrieve the full detail.
 *
 * Flat bullet entries (`- text`) that survived migration are included verbatim —
 * they have no id and cannot be recalled individually.
 *
 * Lines that are neither structured blocks nor top-level bullets are skipped
 * (blank lines, continuation text, etc.).
 *
 * Exported for unit testing.
 */
export declare function buildKnowledgeIndex(knowledgeBody: string): string;
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
 * Story native:01KT6QEWY794ZY0DH6JHQFWG6V: The `## Knowledge` section body
 * is replaced with a compact one-line index (`[id] kind — applies_when` per
 * structured lesson) via `buildKnowledgeIndex`. Full lesson text is available
 * on demand via `recallLesson`.
 */
export declare function assemblePrompt(persona: PersonaFile): string;
