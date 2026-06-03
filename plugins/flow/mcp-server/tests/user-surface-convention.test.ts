/**
 * User-surface convention contract test (Story 1.8 AC1).
 *
 * AC1's mechanism is NOT a direct edit to the gitignored `bmad-create-story`
 * skill. Instead the convention is delivered via two checked-in artefacts:
 *
 *   1. `plugins/flow/docs/user-surface-acs.md` — the canonical, author-facing
 *      reference (the four-rubric definition, the tag syntax, the regex,
 *      tagged and untagged examples, the gate's pass/fail semantics).
 *   2. `.claude/skills/ship-story/SKILL.md` Step 4 — the prompt that spawns
 *      the `bmad-create-story` subagent. The prompt must inject the
 *      convention so the subagent (which is gitignored and not directly
 *      editable here) tags ACs correctly without the orchestrator pausing
 *      for clarifying questions.
 *
 * This suite pins the contract on both files: presence of the key strings,
 * the regex, the four rubric items, an example of each tagged/untagged AC
 * in the doc, and the Step 4 prompt actually citing the doc and pasting
 * the rubric summary into the subagent prompt.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");
const CONVENTION_DOC = resolve(REPO_ROOT, "plugins/flow/docs/user-surface-acs.md");
const SHIP_STORY_SKILL = resolve(REPO_ROOT, ".claude/skills/ship-story/SKILL.md");

describe("user-surface convention doc (Story 1.8 AC1, artefact 1)", () => {
  const doc = readFileSync(CONVENTION_DOC, "utf8");

  it("exists and is non-empty at the canonical path", () => {
    expect(doc.length).toBeGreaterThan(0);
  });

  it("defines the four-rubric definition of a user-surface AC", () => {
    // (i) slash command, (ii) CLI command, (iii) file path the user copies/opens,
    // (iv) Claude Code UI element the user observes.
    expect(doc).toMatch(/\(i\)[^\n]*slash command/i);
    expect(doc).toMatch(/\(ii\)[^\n]*CLI command/i);
    expect(doc).toMatch(/\(iii\)[^\n]*file path/i);
    expect(doc).toMatch(/\(iv\)[^\n]*Claude Code UI/i);
  });

  it("pins the tag-extraction regex used by the gate", () => {
    expect(doc).toContain(
      "^\\*\\*AC(\\d+)\\s*\\(user-surface\\)\\s*:\\*\\*",
    );
  });

  it("shows the canonical tag syntax `**AC<n> (user-surface):**`", () => {
    expect(doc).toMatch(/\*\*AC1 \(user-surface\):\*\*/);
  });

  it("shows at least one tagged example AND at least one untagged example", () => {
    // Tagged example must be present.
    expect(doc).toMatch(/\*\*AC\d+ \(user-surface\):\*\*/);
    // Untagged example: an AC line without `(user-surface)`. The doc body
    // explicitly contrasts a tagged AC with an untagged one.
    expect(doc).toMatch(/Not user-surface|no tag|MUST NOT carry|absent/i);
    // And a concrete `**AC<n>:**` (no parenthetical) appears in the examples.
    expect(doc).toMatch(/\n\*\*AC\d+:\*\*/);
  });

  it("documents the gate's pass/fail semantics including USER_SURFACE_UNVERIFIED / exit 42", () => {
    expect(doc).toMatch(/USER_SURFACE_UNVERIFIED|exit[s]?\s*`?42`?/);
    expect(doc).toMatch(/skipped/);
    expect(doc).toMatch(/passed/);
  });

  it("names both verification routes (automated and operator)", () => {
    expect(doc).toContain("automated_e2e_verified");
    expect(doc).toContain("user_surface_verified");
  });
});

describe("ship-story SKILL.md Step 4 prompt injection (Story 1.8 AC1, artefact 2)", () => {
  const skill = readFileSync(SHIP_STORY_SKILL, "utf8");

  // Isolate the Step 4 section so we are asserting on the actual spawn prompt
  // (not stray mentions elsewhere in the document, e.g. Step 5's validator).
  const step4Match = skill.match(/### Step 4[\s\S]*?(?=\n### Step 5)/);
  if (!step4Match) {
    throw new Error("Could not locate Step 4 section in ship-story SKILL.md");
  }
  const step4 = step4Match[0];

  it("Step 4 cites the canonical convention doc by path", () => {
    expect(step4).toContain("plugins/flow/docs/user-surface-acs.md");
  });

  it("Step 4 pastes the four-rubric summary into the subagent prompt", () => {
    expect(step4).toMatch(/\(i\)[^\n]*slash command/i);
    expect(step4).toMatch(/\(ii\)[^\n]*CLI command/i);
    expect(step4).toMatch(/\(iii\)[^\n]*(file path|copy|open by name)/i);
    expect(step4).toMatch(/\(iv\)[^\n]*(Claude Code UI|TUI|toast|tab-complete)/i);
  });

  it("Step 4 instructs the subagent to tag ACs with `**AC<n> (user-surface):**`", () => {
    expect(step4).toMatch(/\*\*AC<n> \(user-surface\):\*\*/);
  });

  it("Step 4 pins the gate's tag-extraction regex so the subagent uses the exact syntax", () => {
    expect(step4).toContain(
      "^\\*\\*AC(\\d+)\\s*\\(user-surface\\)\\s*:\\*\\*",
    );
  });

  it("Step 4 preserves the 'no clarifying questions' invariant", () => {
    expect(step4).toMatch(/no clarifying questions|Do NOT pause for clarifying questions/i);
  });

  it("Step 4 preserves the 'do not touch sprint-status.yaml' invariant", () => {
    expect(step4).toMatch(/sprint-status\.yaml/);
  });

  it("Step 4 instructs the subagent to make the judgement explicitly per AC (AC1's elicitation requirement)", () => {
    // The skill must prompt the author/subagent to judge each AC, not skip
    // the question. AC1's text: "the skill prompts the author to make this
    // judgement explicitly for each AC."
    expect(step4).toMatch(/each AC|every AC|per AC|explicitly judge/i);
  });
});
