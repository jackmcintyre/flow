/**
 * Unit tests for `buildPersonaSpawnPrompt` and `assemblePrompt` — Story 4.2 Task 7.3.
 *
 * Covers:
 *   (a) Returns a string beginning with `# Generalist Dev — Persona` and containing
 *       `## Domain`, `## Mandate`, `## Out of mandate`, `## Prompt` in order.
 *   (b) Contains the `## Knowledge` heading after `## Prompt`.
 *   (c) Contains the `## Locked phrases` block with each phrase verbatim.
 *   (d) Frontmatter is absent from the output (no `role:` / `domain:` keys appear).
 *   (e) `PersonaFileNotFoundError` propagates if the persona file is absent.
 *
 * Story native:01KT6QEWY794ZY0DH6JHQFWG6V additions:
 *   (f) The Knowledge section shows a one-line index (id, kind, applies_when) per lesson
 *       instead of the full lesson text.
 *   (g) With 10 lessons the Knowledge section grows by exactly one summary line per lesson.
 *
 * Approach: real filesystem ops against a tmpdir with a constructed persona file.
 * No node:fs mocking.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PersonaFileNotFoundError } from "../../errors.js";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { buildPersonaSpawnPrompt, assemblePrompt } from "../build-persona-spawn-prompt.js";
import { parsePersonaFile } from "../../lib/persona-file.js";
let tmpRoot;
// ---------------------------------------------------------------------------
// Fixture persona file content
// ---------------------------------------------------------------------------
const FIXED_HIRED_AT = "2026-01-01T00:00:00.000Z";
const FIXED_VERSION = "0.1.0";
const FIXTURE_PERSONA_MD = `---
role: generalist-dev
domain: "feature implementation in a story scope"
model_tier: sonnet
tools_allow:
  - Read
  - Edit
  - Bash
  - Task
gh_allow:
  - pr-create
  - pr-view
  - pr-comment
locked_phrases:
  handoff: "Handoff to reviewer — story <story-id> ready for review."
  yield: "This sits in <role>'s domain — handing off"
  verdict: "**Verdict: <SENTINEL>**"
hired_at: "${FIXED_HIRED_AT}"
catalogue_version: "${FIXED_VERSION}"
---

# Generalist Dev

## Domain

Implements one story at a time end-to-end: claim, code, test, open PR, hand off to reviewer.

## Mandate

- Claim a story from the ready queue, work it in an isolated worktree.
- Implement against the AC, write tests, run the project's build/test gates green before opening a PR.
- Open the PR with the locked handoff phrase so the reviewer is woken.

## Out of mandate

- Reviewing the PR — yield to generalist-reviewer.
- Shaping the source story — yield to planner if the story is under-specified.

## Prompt

You are the generalist dev. You implement one story at a time, end-to-end, against the AC.

## Knowledge

Accumulated knowledge goes here.
`;
async function makePersonaDir(root, role) {
    const dir = path.join(root, "team", role);
    await fs.mkdir(dir, { recursive: true });
    return dir;
}
async function writePersonaFile(dir, content) {
    await atomicWriteFile(path.join(dir, "PERSONA.md"), content);
}
// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-build-persona-"));
});
afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
});
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("buildPersonaSpawnPrompt", () => {
    it("(a) returns a string beginning with the role display name H1 and containing four main section headings in order", async () => {
        const dir = await makePersonaDir(tmpRoot, "generalist-dev");
        await writePersonaFile(dir, FIXTURE_PERSONA_MD);
        const { systemPrompt } = await buildPersonaSpawnPrompt({
            targetRepoRoot: tmpRoot,
            role: "generalist-dev",
        });
        expect(systemPrompt).toMatch(/^# Generalist Dev — Persona/);
        // Check section headings in order.
        const domainIdx = systemPrompt.indexOf("## Domain");
        const mandateIdx = systemPrompt.indexOf("## Mandate");
        const outIdx = systemPrompt.indexOf("## Out of mandate");
        const promptIdx = systemPrompt.indexOf("## Prompt");
        expect(domainIdx).toBeGreaterThan(-1);
        expect(mandateIdx).toBeGreaterThan(domainIdx);
        expect(outIdx).toBeGreaterThan(mandateIdx);
        expect(promptIdx).toBeGreaterThan(outIdx);
    });
    it("(b) contains the ## Knowledge heading after ## Prompt", async () => {
        const dir = await makePersonaDir(tmpRoot, "generalist-dev");
        await writePersonaFile(dir, FIXTURE_PERSONA_MD);
        const { systemPrompt } = await buildPersonaSpawnPrompt({
            targetRepoRoot: tmpRoot,
            role: "generalist-dev",
        });
        const promptIdx = systemPrompt.indexOf("## Prompt");
        const knowledgeIdx = systemPrompt.indexOf("## Knowledge");
        expect(knowledgeIdx).toBeGreaterThan(-1);
        expect(knowledgeIdx).toBeGreaterThan(promptIdx);
    });
    it("(c) contains the ## Locked phrases block with each locked phrase verbatim", async () => {
        const dir = await makePersonaDir(tmpRoot, "generalist-dev");
        await writePersonaFile(dir, FIXTURE_PERSONA_MD);
        const { systemPrompt } = await buildPersonaSpawnPrompt({
            targetRepoRoot: tmpRoot,
            role: "generalist-dev",
        });
        expect(systemPrompt).toContain("## Locked phrases (do not paraphrase)");
        expect(systemPrompt).toContain(`- Handoff: "Handoff to reviewer — story <story-id> ready for review."`);
        expect(systemPrompt).toContain(`- Yield: "This sits in <role>'s domain — handing off"`);
        expect(systemPrompt).toContain(`- Verdict: "**Verdict: <SENTINEL>**"`);
    });
    it("(d) frontmatter keys are absent from the output", async () => {
        const dir = await makePersonaDir(tmpRoot, "generalist-dev");
        await writePersonaFile(dir, FIXTURE_PERSONA_MD);
        const { systemPrompt } = await buildPersonaSpawnPrompt({
            targetRepoRoot: tmpRoot,
            role: "generalist-dev",
        });
        // Frontmatter keys should NOT appear as YAML key: value lines.
        expect(systemPrompt).not.toMatch(/^role:/m);
        expect(systemPrompt).not.toMatch(/^domain:/m);
        expect(systemPrompt).not.toMatch(/^model_tier:/m);
        expect(systemPrompt).not.toMatch(/^tools_allow:/m);
        expect(systemPrompt).not.toMatch(/^hired_at:/m);
        expect(systemPrompt).not.toMatch(/^catalogue_version:/m);
    });
    it("(e) PersonaFileNotFoundError propagates if the persona file is absent", async () => {
        // No persona file created.
        await expect(buildPersonaSpawnPrompt({ targetRepoRoot: tmpRoot, role: "generalist-dev" })).rejects.toThrow(PersonaFileNotFoundError);
    });
});
describe("assemblePrompt (pure unit)", () => {
    it("produces the correct header and section order from a parsed PersonaFile", () => {
        const mockPersona = parsePersonaFile(FIXTURE_PERSONA_MD, "/fake/PERSONA.md");
        const prompt = assemblePrompt(mockPersona);
        expect(prompt).toMatch(/^# Generalist Dev — Persona\n/);
        // Section order: Domain < Mandate < Out of mandate < Prompt < Knowledge < Locked phrases.
        const order = [
            "## Domain",
            "## Mandate",
            "## Out of mandate",
            "## Prompt",
            "## Knowledge",
            "## Locked phrases (do not paraphrase)",
        ];
        let prev = -1;
        for (const heading of order) {
            const idx = prompt.indexOf(heading);
            expect(idx, `Expected "${heading}" to appear in output`).toBeGreaterThan(-1);
            expect(idx, `Expected "${heading}" to appear after previous heading`).toBeGreaterThan(prev);
            prev = idx;
        }
    });
    it("includes section body content verbatim (except Knowledge, which is an index)", () => {
        const mockPersona = parsePersonaFile(FIXTURE_PERSONA_MD, "/fake/PERSONA.md");
        const prompt = assemblePrompt(mockPersona);
        expect(prompt).toContain("Implements one story at a time end-to-end");
        expect(prompt).toContain("Claim a story from the ready queue");
        expect(prompt).toContain("You are the generalist dev.");
        // The fixture Knowledge body "Accumulated knowledge goes here." is plain text,
        // not a lesson block or bullet — so parseKnowledgeSection finds no entries and
        // the index shows "(no lessons yet)" instead of the raw body text.
        expect(prompt).not.toContain("Accumulated knowledge goes here.");
        expect(prompt).toContain("(no lessons yet)");
    });
    // ---------------------------------------------------------------------------
    // Story 4.3 Task 5.2 — per-token substitution instruction assertions
    // ---------------------------------------------------------------------------
    it("(Story 4.3) handoff phrase with <story-id> token gets a substitution instruction", () => {
        const mockPersona = parsePersonaFile(FIXTURE_PERSONA_MD, "/fake/PERSONA.md");
        const prompt = assemblePrompt(mockPersona);
        // The handoff phrase contains <story-id>, so a substitution line must be appended.
        expect(prompt).toContain("Substitute <story-id> with the live value from your initial context before emission; emit the substituted phrase verbatim.");
    });
    it("(Story 4.3) verdict phrase with <SENTINEL> token gets a substitution instruction", () => {
        const mockPersona = parsePersonaFile(FIXTURE_PERSONA_MD, "/fake/PERSONA.md");
        const prompt = assemblePrompt(mockPersona);
        // The verdict phrase contains <SENTINEL>, so a substitution line must be appended.
        expect(prompt).toContain("Substitute <SENTINEL> with the live value from your initial context before emission; emit the substituted phrase verbatim.");
    });
    it("(Story 4.3 Task 5.3) yield phrase with <role> token gets a substitution instruction", () => {
        const mockPersona = parsePersonaFile(FIXTURE_PERSONA_MD, "/fake/PERSONA.md");
        const prompt = assemblePrompt(mockPersona);
        // The yield phrase "This sits in <role>'s domain — handing off" contains <role>.
        expect(prompt).toContain("Substitute <role> with the live value from your initial context before emission; emit the substituted phrase verbatim.");
    });
    it("(Story 4.3 Task 5.3 regression) a phrase WITHOUT a <...> token does NOT get a spurious substitution instruction", () => {
        // Construct a persona with a locked phrase that has no tokens.
        const noTokenPersonaMd = FIXTURE_PERSONA_MD.replace(`handoff: "Handoff to reviewer — story <story-id> ready for review."`, `handoff: "Handoff to reviewer — story XYZ ready for review."`);
        const mockPersona = parsePersonaFile(noTokenPersonaMd, "/fake/PERSONA.md");
        const prompt = assemblePrompt(mockPersona);
        // Handoff line should be present without a spurious substitution instruction.
        expect(prompt).toContain(`- Handoff: "Handoff to reviewer — story XYZ ready for review."`);
        // Crucially, NO extra substitution instruction for the no-token handoff phrase.
        // We verify by counting "Substitute" lines and confirming the count doesn't include
        // one for the handoff phrase (only yield and verdict should have substitution lines).
        const substituteLines = prompt.split("\n").filter((l) => l.startsWith("Substitute <") && l.includes("with the live value"));
        // Only yield (<role>) and verdict (<SENTINEL>) should have substitution lines.
        expect(substituteLines.length).toBe(2);
    });
    // ---------------------------------------------------------------------------
    // Story native:01KT6QEWY794ZY0DH6JHQFWG6V — one-line index in Knowledge section
    // ---------------------------------------------------------------------------
    it("(AC1) Knowledge section shows one-line index entries instead of full lesson text", () => {
        // Build a persona with a structured lesson block.
        const personaWithLesson = FIXTURE_PERSONA_MD.replace(`## Knowledge\n\nAccumulated knowledge goes here.`, `## Knowledge\n\n<!-- lesson:json {"id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","kind":"pattern","applies_when":"use atomic writes for file ops","detail":"Always use atomic write patterns to avoid partial file corruption under concurrent access.","learned_at":"2026-01-01T00:00:00.000Z"} -->`);
        const mockPersona = parsePersonaFile(personaWithLesson, "/fake/PERSONA.md");
        const prompt = assemblePrompt(mockPersona);
        // The knowledge section must show a one-line summary, NOT the full detail.
        expect(prompt).toContain("## Knowledge");
        expect(prompt).toContain("- [01ARZ3NDEKTSV4RRFFQ69G5FAV] pattern | use atomic writes for file ops");
        // Full detail text must NOT appear in the briefing.
        expect(prompt).not.toContain("Always use atomic write patterns to avoid partial file corruption");
    });
    it("(AC1) Knowledge index includes kind and applies_when separated by |", () => {
        const personaWithLesson = FIXTURE_PERSONA_MD.replace(`## Knowledge\n\nAccumulated knowledge goes here.`, `## Knowledge\n\n<!-- lesson:json {"id":"01ARZ3NDEKTSV4RRFFQ69G5FAA","kind":"pitfall","applies_when":"do not skip pre-PR tests","detail":"Full pitfall detail here.","failure_class":"quality","learned_at":"2026-01-01T00:00:00.000Z"} -->`);
        const mockPersona = parsePersonaFile(personaWithLesson, "/fake/PERSONA.md");
        const prompt = assemblePrompt(mockPersona);
        expect(prompt).toContain("- [01ARZ3NDEKTSV4RRFFQ69G5FAA] pitfall | do not skip pre-PR tests");
        expect(prompt).not.toContain("Full pitfall detail here.");
    });
    it("(AC1 + flat migration) flat bullets appear as migrated entries in the index", () => {
        const personaWithBullet = FIXTURE_PERSONA_MD.replace(`## Knowledge\n\nAccumulated knowledge goes here.`, `## Knowledge\n\n- Always double-check the test setup before running.`);
        const mockPersona = parsePersonaFile(personaWithBullet, "/fake/PERSONA.md");
        const prompt = assemblePrompt(mockPersona);
        // Migrated entry: id is MIGRATED-0, kind is pattern, applies_when equals bullet text.
        expect(prompt).toContain("- [MIGRATED-0] pattern | Always double-check the test setup before running.");
        // Full text should NOT appear separately (it is the applies_when, so it IS in the index line).
    });
    it("(AC3) with ten lessons, knowledge section grows by exactly one summary line per lesson", () => {
        // Build a persona with NO lessons as the baseline.
        const emptyKnowledgePersona = FIXTURE_PERSONA_MD.replace(`## Knowledge\n\nAccumulated knowledge goes here.`, `## Knowledge\n\n`);
        const baselinePersona = parsePersonaFile(emptyKnowledgePersona, "/fake/PERSONA.md");
        const baselinePrompt = assemblePrompt(baselinePersona);
        const baselineKnowledgeStart = baselinePrompt.indexOf("## Knowledge");
        const baselineLockedStart = baselinePrompt.indexOf("## Locked phrases");
        const baselineKnowledgeSection = baselinePrompt.slice(baselineKnowledgeStart, baselineLockedStart);
        // Build 10 lesson blocks.
        const lessons = Array.from({ length: 10 }, (_, i) => {
            const id = `01ARZ3NDEKTSV4RRFFQ69G5F${String.fromCharCode(65 + i)}`; // A-J
            return `<!-- lesson:json {"id":"${id}","kind":"pattern","applies_when":"lesson number ${i + 1}","detail":"Full body of lesson ${i + 1}. Should not appear in briefing.","learned_at":"2026-01-01T00:00:00.000Z"} -->`;
        }).join("\n");
        const tenLessonPersonaMd = FIXTURE_PERSONA_MD.replace(`## Knowledge\n\nAccumulated knowledge goes here.`, `## Knowledge\n\n${lessons}`);
        const tenLessonPersona = parsePersonaFile(tenLessonPersonaMd, "/fake/PERSONA.md");
        const tenLessonPrompt = assemblePrompt(tenLessonPersona);
        const tenLessonKnowledgeStart = tenLessonPrompt.indexOf("## Knowledge");
        const tenLessonLockedStart = tenLessonPrompt.indexOf("## Locked phrases");
        const tenLessonKnowledgeSection = tenLessonPrompt.slice(tenLessonKnowledgeStart, tenLessonLockedStart);
        // Count the summary lines (lines starting with "- [").
        const summaryLines = tenLessonKnowledgeSection
            .split("\n")
            .filter((l) => l.trimStart().startsWith("- ["));
        expect(summaryLines).toHaveLength(10);
        // Each lesson adds exactly one line (not the full body).
        const baselineLineCount = baselineKnowledgeSection.split("\n").length;
        const tenLessonLineCount = tenLessonKnowledgeSection.split("\n").length;
        // 10 lessons should add exactly 10 lines relative to the "(no lessons yet)" baseline.
        // The baseline has 1 extra line ("(no lessons yet)"), replaced by 10 summary lines.
        // Net change: +9 lines (10 - 1 placeholder).
        expect(tenLessonLineCount - baselineLineCount).toBe(9);
        // Confirm none of the full lesson detail bodies appear in the prompt.
        for (let i = 0; i < 10; i++) {
            expect(tenLessonPrompt).not.toContain(`Full body of lesson ${i + 1}`);
        }
    });
});
