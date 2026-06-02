/**
 * Deterministic structure test for `plugins/flow/skills/plan/SKILL.md`
 * (Story 3.4 Task 6.5 — AC6).
 *
 * Loads the skill file from disk and asserts:
 *   - Front-matter `name:` is exactly `flow:plan`.
 *   - Body contains the verbatim planner-subagent invocation line (Task 5.3).
 *   - Body contains the literal strings `adapter: native` and `adapter: bmad`.
 *   - Body contains the slash-command literals `/flow:plan`, `/bmad-create-story`,
 *     and `/flow:scan`.
 *
 * These assertions guard against the "file exists but is empty or incomplete"
 * failure mode that an integration test with a mocked skill loader would not
 * catch.
 */

import { expect, it, describe } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Resolve the skill file path relative to this test file.
// This file lives at:   plugins/flow/mcp-server/src/skills/plan-skill-shape.test.ts
// Skill file lives at:  plugins/flow/skills/plan/SKILL.md
// Walk up: src/skills → src → mcp-server → crew → plugins → SKILL.md
const SKILL_PATH = path.resolve(
  HERE,
  "..", // src/
  "..", // mcp-server/
  "..", // crew/
  "skills",
  "plan",
  "SKILL.md",
);

// The verbatim invocation line required by AC6 / Task 5.3.
const REQUIRED_INVOCATION_LINE =
  "spawn the planner subagent via Claude Code's `Task` tool against the catalogue prompt at `plugins/flow/catalogue/planner.md`";

describe("plugins/flow/skills/plan/SKILL.md structural assertions (AC6)", () => {
  let skillContent: string;

  // Load once for all assertions in this suite.
  it("SKILL.md exists and is readable", async () => {
    skillContent = await fs.readFile(SKILL_PATH, "utf8");
    expect(skillContent.length).toBeGreaterThan(0);
  });

  it("front-matter name field is exactly 'flow:plan'", async () => {
    const content = await fs.readFile(SKILL_PATH, "utf8");
    // Match the YAML front-matter block between --- delimiters.
    const frontmatterMatch = /^---\n([\s\S]*?)\n---/.exec(content);
    expect(frontmatterMatch).not.toBeNull();
    const frontmatter = frontmatterMatch![1]!;
    // The `name:` line must be exactly `name: flow:plan`.
    expect(frontmatter).toMatch(/^name:\s*flow:plan\s*$/m);
  });

  it("body contains the verbatim planner-subagent invocation line (Task 5.3)", async () => {
    const content = await fs.readFile(SKILL_PATH, "utf8");
    expect(content).toContain(REQUIRED_INVOCATION_LINE);
  });

  it("body contains 'adapter: native'", async () => {
    const content = await fs.readFile(SKILL_PATH, "utf8");
    expect(content).toContain("adapter: native");
  });

  it("body contains 'adapter: bmad'", async () => {
    const content = await fs.readFile(SKILL_PATH, "utf8");
    expect(content).toContain("adapter: bmad");
  });

  it("body contains '/flow:plan'", async () => {
    const content = await fs.readFile(SKILL_PATH, "utf8");
    expect(content).toContain("/flow:plan");
  });

  it("body contains '/bmad-create-story'", async () => {
    const content = await fs.readFile(SKILL_PATH, "utf8");
    expect(content).toContain("/bmad-create-story");
  });

  it("body contains '/flow:scan'", async () => {
    const content = await fs.readFile(SKILL_PATH, "utf8");
    expect(content).toContain("/flow:scan");
  });

  it("front-matter name is NOT empty", async () => {
    const content = await fs.readFile(SKILL_PATH, "utf8");
    // Guard against the empty-file failure mode.
    expect(content.trim().length).toBeGreaterThan(100);
  });
});
