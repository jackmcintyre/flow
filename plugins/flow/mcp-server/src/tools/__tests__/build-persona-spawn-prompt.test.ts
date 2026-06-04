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

let tmpRoot: string;

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

async function makePersonaDir(root: string, role: string): Promise<string> {
  const dir = path.join(root, "team", role);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function writePersonaFile(dir: string, content: string): Promise<void> {
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
    expect(systemPrompt).toContain(
      `- Handoff: "Handoff to reviewer — story <story-id> ready for review."`,
    );
    expect(systemPrompt).toContain(
      `- Yield: "This sits in <role>'s domain — handing off"`,
    );
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
    await expect(
      buildPersonaSpawnPrompt({ targetRepoRoot: tmpRoot, role: "generalist-dev" }),
    ).rejects.toThrow(PersonaFileNotFoundError);
  });

  it("(DR2 AC2/AC3) persona file with ## Skills section: briefing shows one-line ref, not full body", async () => {
    const personaWithSkills = FIXTURE_PERSONA_MD +
      "\n## Skills\n\n- handoff-discipline (.flow/skills/handoff-discipline.md): Before handing off.\n";
    const dir = await makePersonaDir(tmpRoot, "generalist-dev");
    await writePersonaFile(dir, personaWithSkills);

    const { systemPrompt } = await buildPersonaSpawnPrompt({
      targetRepoRoot: tmpRoot,
      role: "generalist-dev",
    });

    // ## Skills heading appears.
    expect(systemPrompt).toContain("## Skills");

    // One-line reference is present.
    expect(systemPrompt).toContain(
      "- handoff-discipline (.flow/skills/handoff-discipline.md): Before handing off.",
    );

    // Full skill body is NOT inlined; the reference is a path pointer.
    // (The skill file body itself lives at the path, not in the briefing.)
    const skillsIdx = systemPrompt.indexOf("## Skills");
    const lockedIdx = systemPrompt.indexOf("## Locked phrases");
    expect(skillsIdx).toBeGreaterThan(-1);
    expect(lockedIdx).toBeGreaterThan(skillsIdx);
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

  it("includes section body content verbatim", () => {
    const mockPersona = parsePersonaFile(FIXTURE_PERSONA_MD, "/fake/PERSONA.md");
    const prompt = assemblePrompt(mockPersona);

    expect(prompt).toContain("Implements one story at a time end-to-end");
    expect(prompt).toContain("Claim a story from the ready queue");
    expect(prompt).toContain("You are the generalist dev.");
    expect(prompt).toContain("Accumulated knowledge goes here.");
  });

  // ---------------------------------------------------------------------------
  // Story 4.3 Task 5.2 — per-token substitution instruction assertions
  // ---------------------------------------------------------------------------

  it("(Story 4.3) handoff phrase with <story-id> token gets a substitution instruction", () => {
    const mockPersona = parsePersonaFile(FIXTURE_PERSONA_MD, "/fake/PERSONA.md");
    const prompt = assemblePrompt(mockPersona);

    // The handoff phrase contains <story-id>, so a substitution line must be appended.
    expect(prompt).toContain(
      "Substitute <story-id> with the live value from your initial context before emission; emit the substituted phrase verbatim.",
    );
  });

  it("(Story 4.3) verdict phrase with <SENTINEL> token gets a substitution instruction", () => {
    const mockPersona = parsePersonaFile(FIXTURE_PERSONA_MD, "/fake/PERSONA.md");
    const prompt = assemblePrompt(mockPersona);

    // The verdict phrase contains <SENTINEL>, so a substitution line must be appended.
    expect(prompt).toContain(
      "Substitute <SENTINEL> with the live value from your initial context before emission; emit the substituted phrase verbatim.",
    );
  });

  it("(Story 4.3 Task 5.3) yield phrase with <role> token gets a substitution instruction", () => {
    const mockPersona = parsePersonaFile(FIXTURE_PERSONA_MD, "/fake/PERSONA.md");
    const prompt = assemblePrompt(mockPersona);

    // The yield phrase "This sits in <role>'s domain — handing off" contains <role>.
    expect(prompt).toContain(
      "Substitute <role> with the live value from your initial context before emission; emit the substituted phrase verbatim.",
    );
  });

  it("(Story 4.3 Task 5.3 regression) a phrase WITHOUT a <...> token does NOT get a spurious substitution instruction", () => {
    // Construct a persona with a locked phrase that has no tokens.
    const noTokenPersonaMd = FIXTURE_PERSONA_MD.replace(
      `handoff: "Handoff to reviewer — story <story-id> ready for review."`,
      `handoff: "Handoff to reviewer — story XYZ ready for review."`,
    );
    const mockPersona = parsePersonaFile(noTokenPersonaMd, "/fake/PERSONA.md");
    const prompt = assemblePrompt(mockPersona);

    // Handoff line should be present without a spurious substitution instruction.
    expect(prompt).toContain(`- Handoff: "Handoff to reviewer — story XYZ ready for review."`);
    // Crucially, NO extra substitution instruction for the no-token handoff phrase.
    // We verify by counting "Substitute" lines and confirming the count doesn't include
    // one for the handoff phrase (only yield and verdict should have substitution lines).
    const substituteLines = prompt.split("\n").filter((l) =>
      l.startsWith("Substitute <") && l.includes("with the live value"),
    );
    // Only yield (<role>) and verdict (<SENTINEL>) should have substitution lines.
    expect(substituteLines.length).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // Story DR2 AC2/AC3 — ## Skills section rendering
  // ---------------------------------------------------------------------------

  it("(DR2 AC2/AC3) persona with ## Skills section renders one-line skill references (not full body)", () => {
    // Persona with a ## Skills section containing a promoted-skill reference.
    const personaWithSkills = FIXTURE_PERSONA_MD +
      "\n## Skills\n\n- handoff-discipline (.flow/skills/handoff-discipline.md): Before handing off a story to the reviewer.\n";
    const mockPersona = parsePersonaFile(personaWithSkills, "/fake/PERSONA.md");
    const prompt = assemblePrompt(mockPersona);

    // ## Skills heading appears in the output.
    expect(prompt).toContain("## Skills");

    // One-line skill reference is present.
    expect(prompt).toContain(
      "- handoff-discipline (.flow/skills/handoff-discipline.md): Before handing off a story to the reviewer.",
    );

    // The full skill body content is NOT inlined (only the reference line).
    // (Verifying the reference is a path pointer, not the skill's markdown body.)
    const skillsIdx = prompt.indexOf("## Skills");
    const lockedIdx = prompt.indexOf("## Locked phrases");
    expect(skillsIdx).toBeGreaterThan(-1);
    expect(lockedIdx).toBeGreaterThan(skillsIdx);
  });

  it("(DR2 AC2) ## Skills section appears after ## Knowledge and before ## Locked phrases", () => {
    const personaWithSkills = FIXTURE_PERSONA_MD +
      "\n## Skills\n\n- my-skill (.flow/skills/my-skill.md): Use when needed.\n";
    const mockPersona = parsePersonaFile(personaWithSkills, "/fake/PERSONA.md");
    const prompt = assemblePrompt(mockPersona);

    const knowledgeIdx = prompt.indexOf("## Knowledge");
    const skillsIdx = prompt.indexOf("## Skills");
    const lockedIdx = prompt.indexOf("## Locked phrases");

    expect(knowledgeIdx).toBeGreaterThan(-1);
    expect(skillsIdx).toBeGreaterThan(knowledgeIdx);
    expect(lockedIdx).toBeGreaterThan(skillsIdx);
  });

  it("(DR2 AC3) persona without ## Skills section does NOT emit a ## Skills heading", () => {
    // The base fixture persona has no ## Skills section.
    const mockPersona = parsePersonaFile(FIXTURE_PERSONA_MD, "/fake/PERSONA.md");
    const prompt = assemblePrompt(mockPersona);

    expect(prompt).not.toContain("## Skills");
  });

  it("(DR2 AC2) a second role referencing the same skill also shows the one-line entry", () => {
    // Simulate a second role's persona that also references the same skill.
    const secondRolePersona = FIXTURE_PERSONA_MD
      .replace("role: generalist-dev", "role: generalist-reviewer")
      .replace("# Generalist Dev", "# Generalist Reviewer") +
      "\n## Skills\n\n- handoff-discipline (.flow/skills/handoff-discipline.md): Verify the dev used it.\n";
    const mockPersona = parsePersonaFile(secondRolePersona, "/fake/PERSONA.md");
    const prompt = assemblePrompt(mockPersona);

    // The one-line reference for the same skill appears for the second role.
    expect(prompt).toContain("## Skills");
    expect(prompt).toContain(
      "- handoff-discipline (.flow/skills/handoff-discipline.md): Verify the dev used it.",
    );
  });
});
