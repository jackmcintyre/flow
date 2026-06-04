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
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { readPersona } from "./read-persona.js";
import { extractSkillRefs } from "../lib/apply-promote-lesson-to-skill.js";
import { parsePersonaFile } from "../lib/persona-file.js";
import { writeManagedFile } from "../lib/managed-fs.js";
import { rankLessons, rebuildBodyWithTopLessons, archiveLessons, DEFAULT_BRIEFING_BUDGET, } from "../lib/lesson-archive.js";
import { stringify as yamlStringify } from "yaml";
/** Tool name threaded into managed-fs for persona + archive writes. */
const TOOL_NAME = "buildPersonaSpawnPrompt";
/**
 * Assemble the system prompt for a dev-subagent spawn.
 *
 * Reads the persona file at `<targetRepoRoot>/team/<role>/PERSONA.md`
 * exactly once per call, then concatenates the five sections plus the
 * locked-phrases sentinel block.
 *
 * Story native:01KT6QSW4W7SMAHAT4EAKCCC65 — briefing budget cap:
 * Before assembling the prompt, the Knowledge section is ranked by
 * `use_count` descending then `last_used_at` descending. If the number of
 * structured lessons exceeds `briefingBudget` (default 10), overflow lessons
 * are demoted to the role's archived lesson store (`team/<role>/_archived/`)
 * and removed from the live Knowledge body. This keeps the always-shown index
 * focused regardless of how many lessons the role has accumulated.
 *
 * The persona file is rewritten in-place (via `writeManagedFile`) when lessons
 * are demoted. The rewrite is performed BEFORE assembling the prompt so the
 * next call to `readPersona` will see the pruned Knowledge body.
 *
 * @throws {PersonaFileNotFoundError} When the persona file is absent.
 * @throws {PersonaFileMalformedError} When the persona file fails the parser.
 */
export async function buildPersonaSpawnPrompt(opts) {
    const { targetRepoRoot, role, briefingBudget = DEFAULT_BRIEFING_BUDGET, now = () => new Date(), } = opts;
    // One read per call — this is the assembly contract.
    const persona = await readPersona({ targetRepoRoot, role });
    // --- Briefing budget cap ---
    const knowledgeBody = persona.sections["Knowledge"];
    const { topLessons, overflow } = rankLessons(knowledgeBody, briefingBudget);
    if (overflow.length > 0) {
        // 1. Archive overflow lessons to `team/<role>/_archived/<id>.json`.
        await archiveLessons(targetRepoRoot, role, overflow, now);
        // 2. Rebuild the Knowledge body in ranked order with only the top lessons.
        //    This also sorts the remaining lessons by use_count/last_used_at so the
        //    always-shown index satisfies the "ordered by use-count descending and
        //    most-recent first" requirement from AC1.
        const rankedBody = rebuildBodyWithTopLessons(knowledgeBody, topLessons);
        // 3. Rewrite the persona file with the ranked+pruned Knowledge body.
        const personaPath = path.join(targetRepoRoot, "team", role, "PERSONA.md");
        const rawPersona = await fs.readFile(personaPath, "utf8");
        const parsed = parsePersonaFile(rawPersona, personaPath);
        const newContents = reconstructPersonaFileWithKnowledge(parsed, rankedBody);
        await writeManagedFile({
            absPath: personaPath,
            contents: newContents,
            targetRepoRoot,
            mcpToolContext: { toolName: TOOL_NAME, role },
        });
        // Re-read the persona after the rewrite to get the pruned Knowledge section.
        const updatedPersona = await readPersona({ targetRepoRoot, role });
        const systemPrompt = assemblePrompt(updatedPersona);
        return { systemPrompt };
    }
    const systemPrompt = assemblePrompt(persona);
    return { systemPrompt };
}
/**
 * Reconstruct the full persona file from parsed sections, replacing the
 * Knowledge body with `newKnowledgeBody`. Mirrors `reconstructPersonaFile`
 * in `apply-persona-append.ts` — kept local to avoid circular imports.
 */
function reconstructPersonaFileWithKnowledge(parsed, newKnowledgeBody) {
    const frontmatter = {
        role: parsed.role,
        domain: parsed.domain,
        model_tier: parsed.model_tier,
        tools_allow: [...parsed.tools_allow],
        gh_allow: [...parsed.gh_allow],
        locked_phrases: { ...parsed.locked_phrases },
        hired_at: parsed.hired_at,
        catalogue_version: parsed.catalogue_version,
    };
    const yamlBlock = yamlStringify(frontmatter).replace(/\n$/, "");
    const h1 = parsed.role
        .split("-")
        .map((part) => part.length === 0 ? part : part[0].toUpperCase() + part.slice(1))
        .join(" ");
    const sections = [
        `# ${h1}`,
        ``,
        `## Domain`,
        ``,
        parsed.sections.Domain,
        ``,
        `## Mandate`,
        ``,
        parsed.sections.Mandate,
        ``,
        `## Out of mandate`,
        ``,
        parsed.sections["Out of mandate"],
        ``,
        `## Prompt`,
        ``,
        parsed.sections.Prompt,
        ``,
        `## Knowledge`,
        ``,
    ];
    if (newKnowledgeBody.length > 0) {
        sections.push(newKnowledgeBody);
        sections.push(``);
    }
    // Preserve the optional ## Skills section if it was present in the parsed file.
    // (Story native:01KT6RHQ1K4KQMASAXNEK6MY7E — without this, the briefing-budget
    // rewrite would silently drop a role's promoted skills.)
    if (parsed.skillsBody.length > 0) {
        sections.push(`## Skills`);
        sections.push(``);
        sections.push(parsed.skillsBody);
        sections.push(``);
    }
    return `---\n${yamlBlock}\n---\n\n${sections.join("\n")}`;
}
/** Sentinel constants for structured lesson blocks (mirrors get-team-snapshot.ts). */
const LESSON_BLOCK_PREFIX = "<!-- lesson:json ";
const LESSON_BLOCK_SUFFIX = " -->";
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
export function buildKnowledgeIndex(knowledgeBody) {
    const lines = [];
    for (const line of knowledgeBody.split("\n")) {
        const trimmed = line.trimStart();
        // Structured lesson block.
        if (trimmed.startsWith(LESSON_BLOCK_PREFIX) &&
            trimmed.endsWith(LESSON_BLOCK_SUFFIX)) {
            const jsonStr = trimmed
                .slice(LESSON_BLOCK_PREFIX.length, trimmed.length - LESSON_BLOCK_SUFFIX.length)
                .trim();
            try {
                const raw = JSON.parse(jsonStr);
                if (raw !== null &&
                    typeof raw === "object" &&
                    "id" in raw &&
                    "kind" in raw &&
                    "applies_when" in raw) {
                    const obj = raw;
                    const id = String(obj["id"]);
                    const kind = String(obj["kind"]);
                    const trigger = String(obj["applies_when"]);
                    lines.push(`[${id}] ${kind} — ${trigger}`);
                }
            }
            catch {
                // Invalid JSON in lesson block — skip silently (mirrors extractKnowledgeEntries).
            }
            continue;
        }
        // Flat-bullet migration entry — include verbatim.
        if (/^-\s+(.+?)\s*$/.test(line)) {
            lines.push(line);
        }
        // All other lines (blank, continuation, etc.) are skipped.
    }
    return lines.join("\n");
}
/**
 * Render a compact one-line skill index from a `## Skills` section body.
 *
 * For each `<!-- skill:ref {...} -->` block a summary line is produced:
 *   `[<skill-name>] <when_to_use>`
 *
 * Returns an empty string when the body is empty or has no parseable blocks.
 * The full skill body is available on demand via reading the skill file at
 * `skill_path` (on-demand recall, analogous to `recallLesson`).
 *
 * Exported for unit testing.
 *
 * Story native:01KT6RHQ1K4KQMASAXNEK6MY7E.
 */
export function buildSkillsIndex(skillsBody) {
    if (!skillsBody || skillsBody.trim() === "") {
        return "";
    }
    const refs = extractSkillRefs(skillsBody);
    return refs.map((ref) => `[${ref.name}] ${ref.when_to_use}`).join("\n");
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
 * Story native:01KT6QEWY794ZY0DH6JHQFWG6V: The `## Knowledge` section body
 * is replaced with a compact one-line index (`[id] kind — applies_when` per
 * structured lesson) via `buildKnowledgeIndex`. Full lesson text is available
 * on demand via `recallLesson`.
 *
 * Story native:01KT6RHQ1K4KQMASAXNEK6MY7E: A `## Skills` section is appended
 * after `## Knowledge` when the persona has promoted skills. Each skill
 * reference is rendered as one line: `[<skill-name>] <when_to_use>`. The full
 * skill body is available on demand via reading the skill file at the
 * `skill_path` stored in the reference block.
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
    // Story native:01KT6QEWY794ZY0DH6JHQFWG6V — compact knowledge index.
    const knowledgeIndex = buildKnowledgeIndex(persona.sections["Knowledge"]);
    // Story native:01KT6RHQ1K4KQMASAXNEK6MY7E — skill references index.
    const skillsIndex = buildSkillsIndex(persona.skillsBody);
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
        knowledgeIndex,
        ``,
    ];
    // Append ## Skills only when the persona has at least one skill reference.
    if (skillsIndex.length > 0) {
        parts.push(`## Skills`);
        parts.push(``);
        parts.push(skillsIndex);
        parts.push(``);
    }
    parts.push(`## Locked phrases (do not paraphrase)`);
    parts.push(...lockedPhraseLines);
    return parts.join("\n");
}
function toDisplayName(role) {
    return role
        .split("-")
        .map((part) => part.length === 0 ? part : part[0].toUpperCase() + part.slice(1))
        .join(" ");
}
