/**
 * AC3 — /flow:smoke SKILL.md content structure check — Story 1.13.
 *
 * Reads the on-disk `plugins/flow/skills/smoke/SKILL.md`, splits its YAML
 * front-matter, and asserts the deterministic structural anchors required by AC3:
 *
 *   (i)    Frontmatter `name` equals `flow:smoke`.
 *   (ii)   Frontmatter `allowed_tools` is exactly
 *          [createSmokeScratchRepo, getTeamSnapshot, readBacklogInventory, listClaimableTodos]
 *          — four tools, no extras.
 *   (iii)  All five step labels appear in the body, each paired with its expected
 *          checkpoint tool name (or null for step 5).
 *   (iv)   The body contains each of the four concrete success lines:
 *          `[smoke] step N (<name>): ok` for steps 1–4. Plus the failure-shape
 *          template `[smoke] step N (<name>): FAILED — <reason>` is present
 *          (documented shape, not a per-step line).
 *   (v)    The body contains the literal handoff line
 *          `Ready. Run /flow:start in this scratch repo.`.
 *   (vi)   The body does NOT contain a Claude-Code-style invocation of `/flow:start`
 *          beyond what appears in the handoff line — count occurrences of
 *          `/flow:start` and assert the count equals 1 (the handoff line).
 *
 * Story 1.13 Task 5.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as yamlParse } from "yaml";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const SKILL_FILE = path.resolve(
  HERE,
  "..", // src/skills/
  "..", // src/
  "..", // mcp-server/
  "..", // plugins/flow/
  "..", // plugins/
  "..", // repo root (worktree)
  "plugins",
  "flow",
  "skills",
  "smoke",
  "SKILL.md",
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/m.exec(raw);
  if (!match) {
    throw new Error("SKILL.md has no valid YAML front-matter delimited by ---");
  }
  return { frontmatter: match[1]!, body: match[2]! };
}

// ---------------------------------------------------------------------------
// Step definitions (AC3 iii–iv)
// ---------------------------------------------------------------------------

const STEPS: ReadonlyArray<{ stepNumber: number; name: string; tool: string | null }> = [
  { stepNumber: 1, name: "scratch-repo", tool: "createSmokeScratchRepo" },
  { stepNumber: 2, name: "skip-hiring", tool: "getTeamSnapshot" },
  { stepNumber: 3, name: "plan", tool: "readBacklogInventory" },
  { stepNumber: 4, name: "materialise", tool: "listClaimableTodos" },
  { stepNumber: 5, name: "start", tool: null },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AC3 — /flow:smoke SKILL.md content structure (Story 1.13)", () => {
  let raw: string;
  let frontmatter: Record<string, unknown>;
  let body: string;

  beforeAll(async () => {
    raw = await fs.readFile(SKILL_FILE, "utf8");
    const split = splitFrontmatter(raw);
    frontmatter = yamlParse(split.frontmatter) as Record<string, unknown>;
    body = split.body;
  });

  // (i) name field
  it("AC3(i) — frontmatter name is exactly 'flow:smoke'", () => {
    expect(frontmatter["name"]).toBe("flow:smoke");
  });

  // (ii) allowed_tools exactly four
  it("AC3(ii) — allowed_tools is exactly [createSmokeScratchRepo, getTeamSnapshot, readBacklogInventory, listClaimableTodos]", () => {
    const allowedTools = frontmatter["allowed_tools"] as string[];
    expect(Array.isArray(allowedTools)).toBe(true);
    const expected = [
      "createSmokeScratchRepo",
      "getTeamSnapshot",
      "readBacklogInventory",
      "listClaimableTodos",
    ];
    expect(allowedTools.length).toBe(4);
    for (const tool of expected) {
      expect(allowedTools, `Expected allowed_tools to contain '${tool}'`).toContain(tool);
    }
    for (const tool of allowedTools) {
      expect(expected, `Unexpected tool '${tool}' in allowed_tools`).toContain(tool);
    }
  });

  // (iii) all five step labels and their checkpoint tools appear in the body
  it("AC3(iii) — all five step labels appear in the body", () => {
    for (const step of STEPS) {
      expect(body, `Expected step label '${step.name}' to appear in body`).toContain(step.name);
    }
  });

  it("AC3(iii) — steps 1–4 each reference their checkpoint tool in the body", () => {
    for (const step of STEPS) {
      if (step.tool !== null) {
        expect(body, `Expected tool '${step.tool}' for step ${step.stepNumber} to appear in body`).toContain(step.tool);
      }
    }
  });

  // (iv) concrete success lines for steps 1–4
  it("AC3(iv) — body contains concrete success lines for steps 1–4", () => {
    const stepsWithTools = STEPS.filter((s) => s.tool !== null);
    for (const step of stepsWithTools) {
      const successLine = `[smoke] step ${step.stepNumber} (${step.name}): ok`;
      expect(body, `Expected success line '${successLine}' in body`).toContain(successLine);
    }
  });

  it("AC3(iv) — body contains the failure-shape template with literal N and <name> placeholders", () => {
    expect(body).toContain("[smoke] step N (<name>): FAILED — <reason>");
  });

  // (v) handoff line
  it("AC3(v) — body contains the literal handoff line", () => {
    expect(body).toContain("Ready. Run /flow:start in this scratch repo.");
  });

  // (vi) /flow:start appears exactly once (only in the handoff line)
  it("AC3(vi) — /flow:start appears exactly once in the body (only inside the handoff line, never as a standalone invocation)", () => {
    const count = (body.match(/\/flow:start/g) ?? []).length;
    // The handoff line contains exactly one occurrence of /flow:start.
    expect(count).toBe(1);
  });
});
