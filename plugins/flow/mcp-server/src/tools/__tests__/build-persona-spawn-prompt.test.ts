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
import {
  buildPersonaSpawnPrompt,
  assemblePrompt,
  buildKnowledgeIndex,
  buildSkillsIndex,
} from "../build-persona-spawn-prompt.js";
import { parsePersonaFile } from "../../lib/persona-file.js";
import { serialiseSkillRef } from "../../lib/apply-promote-lesson-to-skill.js";

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

- migrate flat bullets verbatim
<!-- lesson:json {"id":"01KT6QEWY794ZY0DH6JHQFWG6V","kind":"pitfall","applies_when":"When deploying without running tests first","detail":"Always run the full test suite before opening a PR — deploy-without-test PRs caused 3 rollbacks in a row.","failure_class":"deploy-skip-test","source_ref":"native:01KT0001","learned_at":"2026-06-01T00:00:00.000Z"} -->
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

  it("includes section body content verbatim for non-knowledge sections", () => {
    const mockPersona = parsePersonaFile(FIXTURE_PERSONA_MD, "/fake/PERSONA.md");
    const prompt = assemblePrompt(mockPersona);

    expect(prompt).toContain("Implements one story at a time end-to-end");
    expect(prompt).toContain("Claim a story from the ready queue");
    expect(prompt).toContain("You are the generalist dev.");
    // Knowledge section is now a compact index — full lesson text is NOT embedded.
    // Instead the one-line summary appears.
    expect(prompt).toContain("[01KT6QEWY794ZY0DH6JHQFWG6V] pitfall — When deploying without running tests first");
    // Flat bullets are included verbatim.
    expect(prompt).toContain("- migrate flat bullets verbatim");
    // Full detail text is NOT in the briefing.
    expect(prompt).not.toContain("Always run the full test suite before opening a PR");
  });

  // ---------------------------------------------------------------------------
  // Story native:01KT6QEWY794ZY0DH6JHQFWG6V — AC1: one-line index in briefing
  // ---------------------------------------------------------------------------

  it("(AC1) knowledge section contains a one-line summary entry per lesson (id, kind, trigger)", () => {
    const mockPersona = parsePersonaFile(FIXTURE_PERSONA_MD, "/fake/PERSONA.md");
    const prompt = assemblePrompt(mockPersona);

    // The structured lesson should appear as [id] kind — applies_when.
    expect(prompt).toContain(
      "[01KT6QEWY794ZY0DH6JHQFWG6V] pitfall — When deploying without running tests first",
    );
    // Full lesson detail must NOT be embedded.
    expect(prompt).not.toContain(
      "Always run the full test suite before opening a PR",
    );
  });

  // ---------------------------------------------------------------------------
  // Story native:01KT6QEWY794ZY0DH6JHQFWG6V — AC3: size grows by one line per lesson
  // ---------------------------------------------------------------------------

  it("(AC3) with ten lessons the knowledge section grows by one summary line per lesson, not the full body", () => {
    // Build a knowledge body with 10 structured lessons.
    const lessons: string[] = [];
    for (let i = 0; i < 10; i++) {
      const id = `01KT0000000000000000000${String(i).padStart(3, "0")}`;
      lessons.push(
        `<!-- lesson:json {"id":"${id}","kind":"pattern","applies_when":"When rule ${i} applies","detail":"${"x".repeat(500)} — full text for lesson ${i}","learned_at":"2026-06-01T00:00:00.000Z"} -->`,
      );
    }
    const knowledgeBody = lessons.join("\n");
    const index = buildKnowledgeIndex(knowledgeBody);
    const indexLines = index.split("\n").filter((l) => l.trim().length > 0);

    // Exactly 10 lines in the index — one per lesson.
    expect(indexLines).toHaveLength(10);

    // Each line is the compact summary, NOT the full detail.
    for (let i = 0; i < 10; i++) {
      expect(indexLines[i]).toMatch(/^\[01KT/);
      expect(indexLines[i]).toContain("pattern — When rule");
      // Full 500-char detail must NOT appear in any index line.
      expect(indexLines[i]).not.toContain("x".repeat(500));
    }
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
});

// ---------------------------------------------------------------------------
// Story native:01KT6RHQ1K4KQMASAXNEK6MY7E — AC2 and AC3
// Skill references: one-line entry in briefing, full body not inlined,
// on-demand recall returns full body, second role also shows the reference.
// ---------------------------------------------------------------------------

const SKILL_REF_NAME = "write-tests-first";
const SKILL_REF_PATH = ".flow/skills/write-tests-first.md";
const SKILL_WHEN_TO_USE = "When building any new feature to ensure test coverage";
const SKILL_FULL_BODY = "# Write Tests First\n\nAlways write the test before implementing the feature.\n\nThis is the full skill body which should NOT appear in the briefing.";

/**
 * Build a FIXTURE_PERSONA_MD variant with a ## Skills section containing
 * one skill reference.
 */
function buildPersonaMdWithSkillRef(): string {
  const skillRefBlock = serialiseSkillRef({
    name: SKILL_REF_NAME,
    skill_path: SKILL_REF_PATH,
    when_to_use: SKILL_WHEN_TO_USE,
  });

  return `---
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

<!-- lesson:json {"id":"01KT6QEWY794ZY0DH6JHQFWG6V","kind":"pitfall","applies_when":"When deploying without running tests first","detail":"Always run the full test suite before opening a PR — deploy-without-test PRs caused 3 rollbacks in a row.","failure_class":"deploy-skip-test","source_ref":"native:01KT0001","learned_at":"2026-06-01T00:00:00.000Z"} -->

## Skills

${skillRefBlock}
`;
}

describe("buildSkillsIndex (pure unit — AC2/AC3)", () => {
  it("renders each skill ref as a one-line entry: [name] when_to_use", () => {
    const skillRefBlock = serialiseSkillRef({
      name: SKILL_REF_NAME,
      skill_path: SKILL_REF_PATH,
      when_to_use: SKILL_WHEN_TO_USE,
    });

    const index = buildSkillsIndex(skillRefBlock);
    expect(index).toBe(`[${SKILL_REF_NAME}] ${SKILL_WHEN_TO_USE}`);
  });

  it("returns empty string for an empty skills body", () => {
    expect(buildSkillsIndex("")).toBe("");
    expect(buildSkillsIndex("   ")).toBe("");
  });

  it("returns one line per skill reference", () => {
    const blocks = [
      serialiseSkillRef({ name: "skill-a", skill_path: ".flow/skills/skill-a.md", when_to_use: "When A" }),
      serialiseSkillRef({ name: "skill-b", skill_path: ".flow/skills/skill-b.md", when_to_use: "When B" }),
    ].join("\n");

    const index = buildSkillsIndex(blocks);
    const lines = index.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("[skill-a] When A");
    expect(lines[1]).toBe("[skill-b] When B");
  });
});

describe("assemblePrompt — skill reference rendering (AC2/AC3)", () => {
  it("(AC2/AC3) includes a ## Skills section with one-line entries when the persona has skill references", () => {
    const personaMd = buildPersonaMdWithSkillRef();
    const parsed = parsePersonaFile(personaMd, "/fake/PERSONA.md");
    const prompt = assemblePrompt(parsed);

    expect(prompt).toContain("## Skills");
    expect(prompt).toContain(`[${SKILL_REF_NAME}] ${SKILL_WHEN_TO_USE}`);
  });

  it("(AC2) the full skill body does NOT appear in the briefing — only the one-line reference", () => {
    const personaMd = buildPersonaMdWithSkillRef();
    const parsed = parsePersonaFile(personaMd, "/fake/PERSONA.md");
    const prompt = assemblePrompt(parsed);

    // The one-line reference IS present.
    expect(prompt).toContain(`[${SKILL_REF_NAME}] ${SKILL_WHEN_TO_USE}`);
    // The full skill body is NOT embedded in the briefing.
    expect(prompt).not.toContain(
      "Always write the test before implementing the feature.",
    );
  });

  it("(AC3) ## Skills section is absent from the briefing when the persona has no skill references", () => {
    // FIXTURE_PERSONA_MD has no ## Skills section.
    const parsed = parsePersonaFile(FIXTURE_PERSONA_MD, "/fake/PERSONA.md");
    const prompt = assemblePrompt(parsed);

    expect(prompt).not.toContain("## Skills");
  });

  it("(AC3) ## Skills appears AFTER ## Knowledge in the section order", () => {
    const personaMd = buildPersonaMdWithSkillRef();
    const parsed = parsePersonaFile(personaMd, "/fake/PERSONA.md");
    const prompt = assemblePrompt(parsed);

    const knowledgeIdx = prompt.indexOf("## Knowledge");
    const skillsIdx = prompt.indexOf("## Skills");

    expect(knowledgeIdx).toBeGreaterThan(-1);
    expect(skillsIdx).toBeGreaterThan(-1);
    expect(skillsIdx).toBeGreaterThan(knowledgeIdx);
  });
});

describe("buildPersonaSpawnPrompt — skill references (AC2/AC3 integration)", () => {
  it("(AC2/AC3) spawned briefing contains a one-line skill entry and omits the full skill body", async () => {
    const dir = await makePersonaDir(tmpRoot, "generalist-dev");
    await writePersonaFile(dir, buildPersonaMdWithSkillRef());

    // Seed the skill file (it exists on disk — on-demand recall reads it).
    const skillDir = path.join(tmpRoot, ".flow", "skills");
    await fs.mkdir(skillDir, { recursive: true });
    await atomicWriteFile(
      path.join(skillDir, "write-tests-first.md"),
      `---\nname: write-tests-first\ndescription: "Write tests first"\nallowed_tools: []\nversion: 0.1.0\nintroduced_at: 2026-06-01T00:00:00.000Z\nsource_lesson_refs: []\n---\n\n${SKILL_FULL_BODY}\n`,
    );

    const { systemPrompt } = await buildPersonaSpawnPrompt({
      targetRepoRoot: tmpRoot,
      role: "generalist-dev",
    });

    // ## Skills section is present.
    expect(systemPrompt).toContain("## Skills");
    // One-line entry is present.
    expect(systemPrompt).toContain(`[${SKILL_REF_NAME}] ${SKILL_WHEN_TO_USE}`);
    // Full skill body is NOT inlined — only available via on-demand recall.
    expect(systemPrompt).not.toContain(
      "This is the full skill body which should NOT appear in the briefing.",
    );
  });

  it("(AC2) a second role referencing the same skill also shows the one-line entry in its briefing", async () => {
    const skillRefBlock = serialiseSkillRef({
      name: SKILL_REF_NAME,
      skill_path: SKILL_REF_PATH,
      when_to_use: SKILL_WHEN_TO_USE,
    });

    // Build a second-role persona (generalist-reviewer) that references the same skill.
    const reviewerPersonaMd = `---
role: generalist-reviewer
domain: "code review in a story scope"
model_tier: sonnet
tools_allow:
  - Read
  - Bash
gh_allow:
  - pr-view
  - pr-comment
locked_phrases:
  handoff: "Handoff to dev — story <story-id> changes requested."
  yield: "This sits in <role>'s domain — handing off"
  verdict: "**Verdict: <SENTINEL>**"
hired_at: "${FIXED_HIRED_AT}"
catalogue_version: "${FIXED_VERSION}"
---

# Generalist Reviewer

## Domain

Reviews code.

## Mandate

- Review the PR.

## Out of mandate

- Implementing code.

## Prompt

You are the generalist reviewer.

## Knowledge

## Skills

${skillRefBlock}
`;

    // Write both personas.
    const devDir = await makePersonaDir(tmpRoot, "generalist-dev");
    await writePersonaFile(devDir, buildPersonaMdWithSkillRef());
    const reviewerDir = await makePersonaDir(tmpRoot, "generalist-reviewer");
    await writePersonaFile(reviewerDir, reviewerPersonaMd);

    // Both spawned briefings contain the same one-line skill entry.
    const { systemPrompt: devPrompt } = await buildPersonaSpawnPrompt({
      targetRepoRoot: tmpRoot,
      role: "generalist-dev",
    });
    const { systemPrompt: reviewerPrompt } = await buildPersonaSpawnPrompt({
      targetRepoRoot: tmpRoot,
      role: "generalist-reviewer",
    });

    expect(devPrompt).toContain(`[${SKILL_REF_NAME}] ${SKILL_WHEN_TO_USE}`);
    expect(reviewerPrompt).toContain(`[${SKILL_REF_NAME}] ${SKILL_WHEN_TO_USE}`);

    // Neither briefing inlines the full skill body.
    expect(devPrompt).not.toContain("Always write the test before implementing the feature.");
    expect(reviewerPrompt).not.toContain("Always write the test before implementing the feature.");
  });
});

// ---------------------------------------------------------------------------
// Story native:01KVPQS1DVJE41KNG065D6X1X7 — AC4 and AC5
// resolveRunSlot unit tests: generalist-wins-when-present default, non-default
// qualified-role selection, unstaffed-slot clean stop.
// ---------------------------------------------------------------------------
import { resolveRunSlot, RUN_JOB_GENERALISTS } from "../resolve-run-slot.js";
import { RunSlotUnstaffedError } from "../../errors.js";

// Minimal persona file with capabilities.
function buildPersonaMd(role: string, runJobs: string[]): string {
  const caps = runJobs.length > 0
    ? `capabilities:\n  review_lenses: []\n  run_jobs:\n${runJobs.map((j) => `    - ${j}`).join("\n")}`
    : "";
  return `---
role: ${role}
domain: "test domain"
model_tier: sonnet
tools_allow:
  - Read
gh_allow: []
locked_phrases:
  handoff: "Handoff to reviewer — story <story-id> ready for review."
  yield: "This sits in <domain>'s domain — handing off."
  verdict: "**Verdict: <SENTINEL>**"
hired_at: "2026-01-01T00:00:00.000Z"
catalogue_version: "0.1.0"
${caps}
---

# ${role}

## Domain

${role} domain.

## Mandate

- Mandate.

## Out of mandate

- Nothing.

## Prompt

You are ${role}.

## Knowledge

`;
}

async function seedPersona(root: string, role: string, runJobs: string[]): Promise<void> {
  const dir = path.join(root, "team", role);
  await fs.mkdir(dir, { recursive: true });
  await atomicWriteFile(path.join(dir, "PERSONA.md"), buildPersonaMd(role, runJobs));
}

describe("resolveRunSlot — AC4: generalist default wins when present alongside another qualified role", () => {
  it("(AC4) returns generalist-dev for the build slot when both generalist-dev and another build-qualified role are present", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-run-slot-"));
    try {
      await seedPersona(tmpDir, "generalist-dev", ["build"]);
      await seedPersona(tmpDir, "specialist-dev", ["build"]);

      const result = await resolveRunSlot({ targetRepoRoot: tmpDir, job: "build" });

      expect(result.role).toBe("generalist-dev");
      expect(result.isDefault).toBe(true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("(AC4) returns generalist-reviewer for the review slot when both generalist-reviewer and another review-qualified role are present", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-run-slot-"));
    try {
      await seedPersona(tmpDir, "generalist-reviewer", ["review"]);
      await seedPersona(tmpDir, "specialist-reviewer", ["review"]);

      const result = await resolveRunSlot({ targetRepoRoot: tmpDir, job: "review" });

      expect(result.role).toBe("generalist-reviewer");
      expect(result.isDefault).toBe(true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("resolveRunSlot — AC5: non-default qualified role used when generalist is absent", () => {
  it("(AC5) returns a non-default build-qualified role when generalist-dev is absent", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-run-slot-"));
    try {
      // Only a specialist-dev — no generalist-dev.
      await seedPersona(tmpDir, "specialist-dev", ["build"]);

      const result = await resolveRunSlot({ targetRepoRoot: tmpDir, job: "build" });

      expect(result.role).toBe("specialist-dev");
      expect(result.isDefault).toBe(false);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("(AC5) returns a non-default review-qualified role when generalist-reviewer is absent", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-run-slot-"));
    try {
      // Only a specialist-reviewer — no generalist-reviewer.
      await seedPersona(tmpDir, "specialist-reviewer", ["review"]);

      const result = await resolveRunSlot({ targetRepoRoot: tmpDir, job: "review" });

      expect(result.role).toBe("specialist-reviewer");
      expect(result.isDefault).toBe(false);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("(AC5 build) the spawned prompt comes from the non-default qualified role's persona, not the generalist", async () => {
    // When a non-default role wins the build slot, buildPersonaSpawnPrompt
    // briefed with that role returns its persona, not the generalist's.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-run-slot-persona-"));
    try {
      // Write a custom-dev persona with a distinctive domain string.
      const customPersona = buildPersonaMd("custom-dev", ["build"]).replace(
        "custom-dev domain.",
        "CUSTOM_DEV_DOMAIN_MARKER",
      );
      const dir = path.join(tmpDir, "team", "custom-dev");
      await fs.mkdir(dir, { recursive: true });
      await atomicWriteFile(path.join(dir, "PERSONA.md"), customPersona);

      // Resolve the build slot — should pick custom-dev.
      const slot = await resolveRunSlot({ targetRepoRoot: tmpDir, job: "build" });
      expect(slot.role).toBe("custom-dev");
      expect(slot.isDefault).toBe(false);

      // Fetch the persona for the resolved role.
      const { systemPrompt } = await buildPersonaSpawnPrompt({
        targetRepoRoot: tmpDir,
        role: slot.role,
      });
      // The prompt should contain the custom role's distinctive content.
      expect(systemPrompt).toContain("CUSTOM_DEV_DOMAIN_MARKER");
      // It must NOT contain the generalist-dev marker (generalist is absent, so
      // we verify by checking what the prompt actually came from).
      expect(systemPrompt).toContain("Custom Dev — Persona");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("resolveRunSlot — unstaffed slot clean stop", () => {
  it("throws RunSlotUnstaffedError when no role qualifies for the build slot", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-run-slot-"));
    try {
      // A role without capabilities cannot fill any run job.
      await seedPersona(tmpDir, "some-role", []);

      await expect(
        resolveRunSlot({ targetRepoRoot: tmpDir, job: "build" }),
      ).rejects.toThrow(RunSlotUnstaffedError);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("throws RunSlotUnstaffedError when no role qualifies for the review slot", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-run-slot-"));
    try {
      // A role only qualified for build, not review.
      await seedPersona(tmpDir, "build-only-role", ["build"]);

      await expect(
        resolveRunSlot({ targetRepoRoot: tmpDir, job: "review" }),
      ).rejects.toThrow(RunSlotUnstaffedError);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("error message names the unstaffed slot clearly (build)", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-run-slot-"));
    try {
      await seedPersona(tmpDir, "some-role", []);
      await expect(
        resolveRunSlot({ targetRepoRoot: tmpDir, job: "build" }),
      ).rejects.toThrow(/Run slot 'build' is unstaffed/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("error message names the unstaffed slot clearly (review)", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-run-slot-"));
    try {
      await seedPersona(tmpDir, "some-role", ["build"]);
      await expect(
        resolveRunSlot({ targetRepoRoot: tmpDir, job: "review" }),
      ).rejects.toThrow(/Run slot 'review' is unstaffed/);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("throws RunSlotUnstaffedError when no team directory exists at all", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-run-slot-"));
    try {
      // Do NOT create team/ — simulate a completely empty repo.
      await expect(
        resolveRunSlot({ targetRepoRoot: tmpDir, job: "build" }),
      ).rejects.toThrow(RunSlotUnstaffedError);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("resolveRunSlot — default team parity (AC1 unit-level check)", () => {
  it("returns generalist-dev for build on a default team (both generalists only)", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-run-slot-"));
    try {
      await seedPersona(tmpDir, "generalist-dev", ["build"]);
      await seedPersona(tmpDir, "generalist-reviewer", ["review"]);

      const buildResult = await resolveRunSlot({ targetRepoRoot: tmpDir, job: "build" });
      const reviewResult = await resolveRunSlot({ targetRepoRoot: tmpDir, job: "review" });

      expect(buildResult.role).toBe("generalist-dev");
      expect(buildResult.isDefault).toBe(true);
      expect(reviewResult.role).toBe("generalist-reviewer");
      expect(reviewResult.isDefault).toBe(true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("RUN_JOB_GENERALISTS exports the correct default role names", () => {
    expect(RUN_JOB_GENERALISTS.build).toBe("generalist-dev");
    expect(RUN_JOB_GENERALISTS.review).toBe("generalist-reviewer");
  });
});
