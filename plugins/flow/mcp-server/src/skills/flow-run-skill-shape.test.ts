/**
 * Deterministic structure tests for `plugins/flow/skills/run/SKILL.md`
 * (Story native:01KTMKPHNDMBFS4APB5RKGZWR4).
 *
 * AC1 — path-resolution contract: the skill resolves targetRepoRoot from the
 *   workspace context and the engine CLI path from CLAUDE_PLUGIN_ROOT, then
 *   validates both on disk before invoking the run.
 *
 * AC2 — preflight-error contract: when the engine file cannot be found the
 *   skill emits a clear human-readable message and does NOT start the run.
 *
 * AC3 — run-knob forwarding contract: the skill accepts maxStories,
 *   maxConcurrency, and devReviewerModel and forwards them unchanged to the
 *   run workflow.
 *
 * These assertions guard against the "file exists but is empty or incomplete"
 * failure mode that an integration test with a mocked skill loader would miss.
 */

import { expect, it, describe } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Resolve the skill file path relative to this test file.
// This file lives at:   plugins/flow/mcp-server/src/skills/flow-run-skill-shape.test.ts
// Skill file lives at:  plugins/flow/skills/run/SKILL.md
// Walk up: src/skills → src → mcp-server → flow → plugins → SKILL.md
const SKILL_PATH = path.resolve(
  HERE,
  "..", // src/
  "..", // mcp-server/
  "..", // flow/
  "skills",
  "run",
  "SKILL.md",
);

// Verbatim sentinel strings required by each AC.
const PREFLIGHT_CHECK_LINE =
  'test -f "${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/cli.js" && echo "ok" || echo "missing"';
const ENGINE_MISSING_ERROR =
  "Error: the run engine file could not be found at ${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/cli.js.";
// Git pre-flight contract: the run cuts a per-story worktree, which needs a git
// repo with at least one commit. The skill must check this BEFORE invoking the
// run and emit a distinct, actionable message for each failure mode.
const GIT_PREFLIGHT_CHECK_LINE =
  'git -C "<targetRepoRoot>" rev-parse --is-inside-work-tree';
const GIT_NOT_A_REPO_ERROR =
  "Error: the run target <targetRepoRoot> is not a git repository.";
const GIT_NO_COMMITS_ERROR =
  "Error: the run target <targetRepoRoot> is a git repository but has no commits yet.";

describe("plugins/flow/skills/run/SKILL.md structural assertions", () => {
  let skillContent: string;

  it("SKILL.md exists and is non-empty", async () => {
    skillContent = await fs.readFile(SKILL_PATH, "utf8");
    expect(skillContent.length).toBeGreaterThan(0);
  });

  it("front-matter name is exactly 'flow:run'", async () => {
    const content = await fs.readFile(SKILL_PATH, "utf8");
    const frontmatterMatch = /^---\n([\s\S]*?)\n---/.exec(content);
    expect(frontmatterMatch, "front-matter block must be present").not.toBeNull();
    const frontmatter = frontmatterMatch![1]!;
    expect(frontmatter).toMatch(/^name:\s*flow:run\s*$/m);
  });

  // AC1: path-resolution contract
  it("AC1: references CLAUDE_PLUGIN_ROOT for engine-file path resolution", async () => {
    const content = await fs.readFile(SKILL_PATH, "utf8");
    expect(content).toContain("CLAUDE_PLUGIN_ROOT");
  });

  it("AC1: resolves cli to CLAUDE_PLUGIN_ROOT/mcp-server/dist/cli.js", async () => {
    const content = await fs.readFile(SKILL_PATH, "utf8");
    expect(content).toContain("${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/cli.js");
  });

  it("AC1: includes the pre-flight existence check for the engine file", async () => {
    const content = await fs.readFile(SKILL_PATH, "utf8");
    expect(content).toContain(PREFLIGHT_CHECK_LINE);
  });

  // AC2: preflight-error contract
  it("AC2: contains the required human-readable error message when engine file is missing", async () => {
    const content = await fs.readFile(SKILL_PATH, "utf8");
    expect(content).toContain(ENGINE_MISSING_ERROR);
  });

  it("AC2: instructs to NOT attempt to start the run on missing engine file", async () => {
    const content = await fs.readFile(SKILL_PATH, "utf8");
    expect(content).toContain("Do NOT attempt to start the run");
  });

  // Git pre-flight contract: fail fast before any story is claimed when the
  // target is not a usable git repo (defect: worktree creation fails deep in the
  // run, mislabelling the burned story as a content failure).
  it("git pre-flight: checks the target is inside a git work tree", async () => {
    const content = await fs.readFile(SKILL_PATH, "utf8");
    expect(content).toContain(GIT_PREFLIGHT_CHECK_LINE);
  });

  it("git pre-flight: checks HEAD exists (at least one commit) so a worktree can be cut", async () => {
    const content = await fs.readFile(SKILL_PATH, "utf8");
    expect(content).toContain('git -C "<targetRepoRoot>" rev-parse HEAD');
  });

  it("git pre-flight: emits a distinct actionable message when the target is not a repo", async () => {
    const content = await fs.readFile(SKILL_PATH, "utf8");
    expect(content).toContain(GIT_NOT_A_REPO_ERROR);
    expect(content).toContain("git init");
  });

  it("git pre-flight: emits a distinct actionable message when the repo has no commits", async () => {
    const content = await fs.readFile(SKILL_PATH, "utf8");
    expect(content).toContain(GIT_NO_COMMITS_ERROR);
  });

  // AC3: run-knob forwarding contract
  it("AC3: documents the maxStories run knob", async () => {
    const content = await fs.readFile(SKILL_PATH, "utf8");
    expect(content).toContain("maxStories");
  });

  it("AC3: documents the maxConcurrency run knob", async () => {
    const content = await fs.readFile(SKILL_PATH, "utf8");
    expect(content).toContain("maxConcurrency");
  });

  it("AC3: documents the devReviewerModel run knob", async () => {
    const content = await fs.readFile(SKILL_PATH, "utf8");
    expect(content).toContain("devReviewerModel");
  });

  it("AC3: instructs to forward run knobs unchanged to the run workflow", async () => {
    const content = await fs.readFile(SKILL_PATH, "utf8");
    // The skill must document forwarding the args to the Workflow tool
    expect(content).toContain("Workflow");
    // and the args JSON structure containing the knobs
    expect(content).toContain('"targetRepoRoot"');
    expect(content).toContain('"cli"');
  });
});
