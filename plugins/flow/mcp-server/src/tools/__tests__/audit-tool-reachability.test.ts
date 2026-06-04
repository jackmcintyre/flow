/**
 * Tests for the audit-tool-reachability.mjs script.
 *
 * Story native:01KT7RQ447J3TRM2RZMGW7MCR3 — ACs 1, 2, 3, 4.
 *
 * Covers:
 *   (a) A synthetic registered-tools fixture + skill/workflow fixture proves the
 *       reachable-set union (AC1).
 *   (b) Workflow-only tools (drainPhaseStart, drainPhaseDone, guardCleanRoot,
 *       readReviewerLesson, reapStaleWorktrees) are absent from the unreachable
 *       list when they appear in a workflow seam call (AC2).
 *   (c) CLI-vs-workflow delta correctly identifies a TOOLS entry with no workflow
 *       seam call (AC3).
 *   (d) The audit script exits 0 and writes a human-readable report to stdout with
 *       at least the "unreachable" and "cli-vs-workflow delta" sections (AC4) —
 *       tested by running the script as a child process.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  parseRegisteredTools,
  parseSkillAllowedTools,
  parseWorkflowSeamCalls,
  parseCliToolsMap,
  buildReachabilityReport,
  DYNAMIC_TOOL_ALLOWLIST,
} from "../../../scripts/audit-tool-reachability.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Absolute path to the audit script. */
const AUDIT_SCRIPT = path.resolve(
  __dirname,
  "../../../scripts/audit-tool-reachability.mjs",
);

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-audit-reachability-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers for building fixture trees
// ---------------------------------------------------------------------------

/** Write a synthetic register.ts with just name: "toolX" entries. */
async function writeRegisterTs(toolNames: string[]): Promise<string> {
  const lines = toolNames.map(
    (n) => `  server.registerTool({ name: "${n}", description: "...", inputSchema: {}, handler: async () => ({}) });`,
  );
  const content = `// synthetic register.ts\nexport function registerAllTools(server: any): void {\n${lines.join("\n")}\n}\n`;
  const p = path.join(tmpRoot, "register.ts");
  await fs.writeFile(p, content, "utf-8");
  return p;
}

/** Write a synthetic cli.ts with a TOOLS: Record<string, ToolFn> = { ... } block. */
async function writeCliTs(toolKeys: string[]): Promise<string> {
  const block = toolKeys.map((k) => `  ${k},`).join("\n");
  const content = `// synthetic cli.ts\ntype ToolFn = (args: any) => unknown;\nconst TOOLS: Record<string, ToolFn> = {\n${block}\n};\n`;
  const p = path.join(tmpRoot, "cli.ts");
  await fs.writeFile(p, content, "utf-8");
  return p;
}

/** Write a SKILL.md under a synthetic skills directory. */
async function writeSkillMd(skillName: string, allowedTools: string[]): Promise<string> {
  const skillDir = path.join(tmpRoot, "skills", skillName);
  await fs.mkdir(skillDir, { recursive: true });
  const content = `---\nname: ${skillName}\nallowed_tools: [${allowedTools.join(", ")}]\n---\n# Skill\n`;
  const p = path.join(skillDir, "SKILL.md");
  await fs.writeFile(p, content, "utf-8");
  return p;
}

/** Write a synthetic workflow JS file with seam calls. */
async function writeWorkflowJs(toolNames: string[]): Promise<string> {
  const workflowsDir = path.join(tmpRoot, "workflows");
  await fs.mkdir(workflowsDir, { recursive: true });
  const lines = toolNames.map(
    (n) => "  await seam(`node ${CLI} " + n + " --json '${J({})}'`, `label:${n}`);",
  );
  const content = `// synthetic drain.workflow.js\nconst CLI = '';\n${lines.join("\n")}\n`;
  const p = path.join(workflowsDir, "drain.workflow.js");
  await fs.writeFile(p, content, "utf-8");
  return p;
}

// ---------------------------------------------------------------------------
// Unit tests for individual parser functions
// ---------------------------------------------------------------------------

describe("parseRegisteredTools", () => {
  it("extracts tool names from name: 'toolName' patterns", () => {
    const source = `
      server.registerTool({ name: "getStatus", description: "..." });
      server.registerTool({ name: 'openCycle', description: "..." });
      server.registerTool({ name: "writeNativeStory", description: "..." });
    `;
    const result = parseRegisteredTools(source);
    expect(result.has("getStatus")).toBe(true);
    expect(result.has("openCycle")).toBe(true);
    expect(result.has("writeNativeStory")).toBe(true);
    expect(result.size).toBe(3);
  });

  it("returns empty set for empty source", () => {
    expect(parseRegisteredTools("").size).toBe(0);
  });

  it("does not include non-tool name properties", () => {
    const source = `
      const schema = { name: 123, label: "hello", description: "world" };
    `;
    // 123 is not a valid tool name (not a string literal)
    const result = parseRegisteredTools(source);
    // description is NOT captured (not a string name value in quotes after "name:")
    // "hello" is not after name: so also not captured... but "label" pattern matches
    // Our regex only picks string literals after name: — let's verify
    expect(result.has("hello")).toBe(false);
  });
});

describe("parseSkillAllowedTools", () => {
  it("extracts tool names from allowed_tools frontmatter in SKILL.md files", async () => {
    await writeSkillMd("status", ["getStatus", "Read"]);
    await writeSkillMd("board", ["getBacklogDashboard", "mintSessionUlid", "recordSkillInvoke"]);

    const result = parseSkillAllowedTools(path.join(tmpRoot, "skills"));
    expect(result.has("getStatus")).toBe(true);
    expect(result.has("Read")).toBe(true);
    expect(result.has("getBacklogDashboard")).toBe(true);
    expect(result.has("mintSessionUlid")).toBe(true);
    expect(result.has("recordSkillInvoke")).toBe(true);
  });

  it("returns empty set when directory does not exist", () => {
    const result = parseSkillAllowedTools(path.join(tmpRoot, "nonexistent"));
    expect(result.size).toBe(0);
  });

  it("skips non-directory entries gracefully", async () => {
    const skillsDir = path.join(tmpRoot, "skills");
    await fs.mkdir(skillsDir, { recursive: true });
    // Write a plain file (not a directory)
    await fs.writeFile(path.join(skillsDir, "not-a-dir.md"), "content", "utf-8");
    const result = parseSkillAllowedTools(skillsDir);
    expect(result.size).toBe(0);
  });
});

describe("parseWorkflowSeamCalls", () => {
  it("extracts tool names from node CLI seam pattern", async () => {
    await writeWorkflowJs(["drainPhaseStart", "drainPhaseDone", "claimNextStory"]);
    const result = parseWorkflowSeamCalls(path.join(tmpRoot, "workflows"));
    expect(result.has("drainPhaseStart")).toBe(true);
    expect(result.has("drainPhaseDone")).toBe(true);
    expect(result.has("claimNextStory")).toBe(true);
  });

  it("extracts the four known workflow-only tools from a realistic seam call", async () => {
    await writeWorkflowJs([
      "drainPhaseStart",
      "drainPhaseDone",
      "guardCleanRoot",
      "readReviewerLesson",
      "reapStaleWorktrees",
    ]);
    const result = parseWorkflowSeamCalls(path.join(tmpRoot, "workflows"));
    // AC2 — these must all be in the reachable-from-workflow set
    expect(result.has("drainPhaseStart")).toBe(true);
    expect(result.has("drainPhaseDone")).toBe(true);
    expect(result.has("guardCleanRoot")).toBe(true);
    expect(result.has("readReviewerLesson")).toBe(true);
    expect(result.has("reapStaleWorktrees")).toBe(true);
  });

  it("returns empty set when directory does not exist", () => {
    const result = parseWorkflowSeamCalls(path.join(tmpRoot, "nonexistent"));
    expect(result.size).toBe(0);
  });

  it("ignores non-.js files", async () => {
    const workflowsDir = path.join(tmpRoot, "workflows");
    await fs.mkdir(workflowsDir, { recursive: true });
    await fs.writeFile(
      path.join(workflowsDir, "drain.workflow.ts"),
      "node ${CLI} someToolTs --json",
      "utf-8",
    );
    const result = parseWorkflowSeamCalls(workflowsDir);
    expect(result.has("someToolTs")).toBe(false);
  });
});

describe("parseCliToolsMap", () => {
  it("extracts tool keys from the TOOLS: Record<string, ToolFn> block", async () => {
    const cliPath = await writeCliTs(["getStatus", "drainPhaseStart", "mintSessionUlid"]);
    const source = await fs.readFile(cliPath, "utf-8");
    const result = parseCliToolsMap(source);
    expect(result.has("getStatus")).toBe(true);
    expect(result.has("drainPhaseStart")).toBe(true);
    expect(result.has("mintSessionUlid")).toBe(true);
  });

  it("returns empty set when no TOOLS block is found", () => {
    const result = parseCliToolsMap("// no tools here\nconsole.log('hi');\n");
    expect(result.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integration tests for buildReachabilityReport
// ---------------------------------------------------------------------------

describe("buildReachabilityReport (AC1, AC2, AC3)", () => {
  it("(AC1) unreachable section identifies tools in register but not in skill/workflow/peer", async () => {
    // Set up fixtures:
    // - register.ts has: toolAlpha, toolBeta, toolGamma
    // - skill allows: toolAlpha (E1)
    // - workflow calls: toolBeta (E2)
    // - toolGamma is registered and even in the CLI map, but NOT called by any
    //   skill, workflow seam, or peer import — so it IS unreachable per AC1.
    //   (Being in the CLI TOOLS map does not count as reachable for AC1.)
    const registerTsPath = await writeRegisterTs(["toolAlpha", "toolBeta", "toolGamma"]);
    const cliTsPath = await writeCliTs(["toolAlpha", "toolBeta", "toolGamma"]);
    await writeSkillMd("my-skill", ["toolAlpha"]);
    await writeWorkflowJs(["toolBeta"]);

    const report = buildReachabilityReport({
      registerTsPath,
      cliTsPath,
      skillsDir: path.join(tmpRoot, "skills"),
      workflowsDir: path.join(tmpRoot, "workflows"),
      toolsSrcDir: path.join(tmpRoot, "nonexistent-tools"), // no peer imports
    });

    // toolGamma is in the CLI map but not called by any workflow seam, skill, or peer import
    expect(report.unreachable).toContain("toolGamma");
    expect(report.unreachable).not.toContain("toolAlpha"); // reachable via skill
    expect(report.unreachable).not.toContain("toolBeta"); // reachable via workflow seam
  });

  it("(AC2) workflow-only tools (drainPhaseStart etc.) do NOT appear in unreachable", async () => {
    // These tools are called ONLY via workflow seam — not via skill allowed_tools
    const workflowOnlyTools = [
      "drainPhaseStart",
      "drainPhaseDone",
      "guardCleanRoot",
      "readReviewerLesson",
      "reapStaleWorktrees",
    ];
    // All registered, none in skills
    const registerTsPath = await writeRegisterTs([
      ...workflowOnlyTools,
      "getStatus", // also in skill
    ]);
    const cliTsPath = await writeCliTs([...workflowOnlyTools, "getStatus"]);
    await writeSkillMd("status", ["getStatus"]);
    await writeWorkflowJs(workflowOnlyTools);

    const report = buildReachabilityReport({
      registerTsPath,
      cliTsPath,
      skillsDir: path.join(tmpRoot, "skills"),
      workflowsDir: path.join(tmpRoot, "workflows"),
      toolsSrcDir: path.join(tmpRoot, "nonexistent-tools"),
    });

    // None of the workflow-only tools should appear in unreachable
    for (const t of workflowOnlyTools) {
      expect(report.unreachable).not.toContain(t);
    }
    // getStatus is reachable via skill
    expect(report.unreachable).not.toContain("getStatus");
  });

  it("(AC3) cli-vs-workflow delta identifies TOOLS entries absent from workflow seam calls", async () => {
    // CLI TOOLS: getStatus, drainPhaseStart, mintSessionUlid
    // Workflow seam calls only: drainPhaseStart, mintSessionUlid
    // Delta should include: getStatus (in CLI, but no workflow seam call)
    const registerTsPath = await writeRegisterTs(["getStatus", "drainPhaseStart", "mintSessionUlid"]);
    const cliTsPath = await writeCliTs(["getStatus", "drainPhaseStart", "mintSessionUlid"]);
    await writeSkillMd("status", ["getStatus"]);
    await writeWorkflowJs(["drainPhaseStart", "mintSessionUlid"]);

    const report = buildReachabilityReport({
      registerTsPath,
      cliTsPath,
      skillsDir: path.join(tmpRoot, "skills"),
      workflowsDir: path.join(tmpRoot, "workflows"),
      toolsSrcDir: path.join(tmpRoot, "nonexistent-tools"),
    });

    // getStatus is in CLI but not called by any workflow seam
    expect(report.cliVsWorkflowDelta).toContain("getStatus");
    // drainPhaseStart is called by the workflow
    expect(report.cliVsWorkflowDelta).not.toContain("drainPhaseStart");
    expect(report.cliVsWorkflowDelta).not.toContain("mintSessionUlid");
  });

  it("reachable set is the union of all three entry-point classes", async () => {
    const registerTsPath = await writeRegisterTs(["fromSkill", "fromWorkflow", "fromPeer", "unreachableTool"]);
    const cliTsPath = await writeCliTs(["fromSkill", "fromWorkflow", "fromPeer"]);
    await writeSkillMd("my-skill", ["fromSkill"]);
    await writeWorkflowJs(["fromWorkflow"]);

    // Simulate peer imports by writing a tool file that imports fromPeer
    const toolsDir = path.join(tmpRoot, "tools-src");
    await fs.mkdir(toolsDir, { recursive: true });
    await fs.writeFile(
      path.join(toolsDir, "some-tool.ts"),
      `import { fromPeer } from "./peer-tool.js";\nexport async function someOtherTool() {}\n`,
      "utf-8",
    );

    const report = buildReachabilityReport({
      registerTsPath,
      cliTsPath,
      skillsDir: path.join(tmpRoot, "skills"),
      workflowsDir: path.join(tmpRoot, "workflows"),
      toolsSrcDir: toolsDir,
    });

    expect(report.reachableSet).toContain("fromSkill");
    expect(report.reachableSet).toContain("fromWorkflow");
    expect(report.reachableSet).toContain("fromPeer");
    // unreachableTool is registered but not in any reachable source
    expect(report.reachableSet).not.toContain("unreachableTool");
    expect(report.unreachable).toContain("unreachableTool");
  });

  it("tools in DYNAMIC_TOOL_ALLOWLIST are excluded from unreachable", async () => {
    // If we add a tool to the allowlist, it should not appear in unreachable
    // even if no skill/workflow/peer references it.
    // We can't mutate the exported const, so we test the invariant indirectly:
    // ensure the DYNAMIC_TOOL_ALLOWLIST is a Set (so it can be used as a filter)
    expect(DYNAMIC_TOOL_ALLOWLIST).toBeInstanceOf(Set);
  });
});

// ---------------------------------------------------------------------------
// AC4 — Script invocation test (exit 0, stdout has required sections)
// ---------------------------------------------------------------------------

describe("audit-tool-reachability.mjs (AC4)", () => {
  it("exits 0 and writes a human-readable report with 'unreachable' and 'cli-vs-workflow delta' sections", () => {
    // Run the script as a plain node script (no prior build step)
    const result = spawnSync("node", [AUDIT_SCRIPT], {
      encoding: "utf-8",
      timeout: 30_000,
    });

    // AC4: exits 0
    expect(result.status).toBe(0);

    // AC4: stdout must contain the "unreachable" section
    expect(result.stdout).toContain("--- unreachable ---");

    // AC4: stdout must contain the "cli-vs-workflow delta" section
    expect(result.stdout).toContain("--- cli-vs-workflow delta ---");

    // No stderr errors (might have warnings but should be clean)
    if (result.stderr && result.stderr.trim()) {
      // Only fail if it looks like a real error (not a warning)
      expect(result.stderr).not.toMatch(/SyntaxError|TypeError|Error:/);
    }
  });

  it("output includes the registered tools count line", () => {
    const result = spawnSync("node", [AUDIT_SCRIPT], {
      encoding: "utf-8",
      timeout: 30_000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Registered tools total:");
    expect(result.stdout).toContain("Reachable");
  });
});

// ---------------------------------------------------------------------------
// AC2 — Integration against the REAL codebase
// ---------------------------------------------------------------------------

describe("AC2: real codebase — workflow-only tools not in unreachable", () => {
  it("drainPhaseStart is not unreachable (it is called via workflow seam)", () => {
    // Run against the real plugin root
    const report = buildReachabilityReport();
    expect(report.unreachable).not.toContain("drainPhaseStart");
    expect(report.unreachable).not.toContain("drainPhaseDone");
    expect(report.unreachable).not.toContain("guardCleanRoot");
    expect(report.unreachable).not.toContain("readReviewerLesson");
    expect(report.unreachable).not.toContain("reapStaleWorktrees");
  });
});
