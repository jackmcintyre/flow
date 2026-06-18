#!/usr/bin/env node
// @ts-check
/**
 * Tool-reachability audit for the Flow MCP server.
 *
 * Builds the call graph from three entry-point classes and reports:
 *   1. "unreachable" — tools registered in register.ts that no skill, workflow, or
 *      peer import actually calls.
 *   2. "cli-vs-workflow delta" — tool names in the cli.ts TOOLS map that no workflow
 *      seam call ("node CLI <toolName>") ever invokes.
 *
 * Entry-point classes:
 *   E1 — skill entry-points: allowed_tools lists in plugins/flow/skills/SKILL.md files
 *   E2 — workflow seam calls: "node CLI toolName" patterns in workflows JS files
 *        + TOOLS map keys in src/cli.ts
 *   E3 — static import graph (only inner-source cross-tool imports matter for
 *        determining liveness, but for this report we treat direct peer imports as
 *        additive reachability evidence)
 *
 * Exit code: always 0. This is a report-only script — it never removes a tool.
 *
 * Usage:
 *   node plugins/flow/mcp-server/scripts/audit-tool-reachability.mjs
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Path constants (relative to the mcp-server root)
// ---------------------------------------------------------------------------

const MCP_SERVER_ROOT = resolve(__dirname, "..");
const PLUGIN_ROOT = resolve(MCP_SERVER_ROOT, "..");
const REGISTER_TS = resolve(MCP_SERVER_ROOT, "src/tools/register.ts");
const CLI_TS = resolve(MCP_SERVER_ROOT, "src/cli.ts");
const SKILLS_DIR = resolve(PLUGIN_ROOT, "skills");
const WORKFLOWS_DIR = resolve(PLUGIN_ROOT, "workflows", "internal");

// ---------------------------------------------------------------------------
// Dynamic-tool allowlist — tool names built at runtime that are legitimately
// live even if no static call-site can be found. Exclude from unreachable output.
// ---------------------------------------------------------------------------

/**
 * @type {ReadonlySet<string>}
 */
export const DYNAMIC_TOOL_ALLOWLIST = new Set([
  // bmadToNativeIngestTool is exported with a different function name than its
  // MCP registration key "bmadToNativeIngest" — the CLI TOOLS map uses the
  // non-Tool suffix name from the import.
  // (No purely dynamic tools currently; list reserved for future expansion.)
]);

// ---------------------------------------------------------------------------
// E1 — Parse registered tool names from register.ts
// ---------------------------------------------------------------------------

/**
 * Extract tool names from `name: "toolName"` patterns inside server.registerTool({...}).
 * Uses a simple regex over the source text — no AST, no build step.
 *
 * @param {string} source
 * @returns {Set<string>}
 */
export function parseRegisteredTools(source) {
  const tools = new Set();
  // Match `name: "toolName"` or `name: 'toolName'` at the start of a property
  const re = /\bname:\s*["']([a-zA-Z][a-zA-Z0-9_]*)["']/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    tools.add(m[1]);
  }
  return tools;
}

// ---------------------------------------------------------------------------
// E1 — Parse allowed_tools from SKILL.md files
// ---------------------------------------------------------------------------

/**
 * Extract tool names from `allowed_tools: [tool1, tool2, ...]` frontmatter lines
 * across all SKILL.md files in the skills directory.
 *
 * @param {string} skillsDir
 * @returns {Set<string>}
 */
export function parseSkillAllowedTools(skillsDir) {
  const tools = new Set();
  if (!existsSync(skillsDir)) return tools;

  let entries;
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return tools;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMd = join(skillsDir, entry.name, "SKILL.md");
    if (!existsSync(skillMd)) continue;

    let content;
    try {
      content = readFileSync(skillMd, "utf-8");
    } catch {
      continue;
    }

    // Match lines of the form: allowed_tools: [tool1, tool2, ...]
    // The brackets may span a single line only (the current format).
    const re = /allowed_tools:\s*\[([^\]]+)\]/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      const items = m[1].split(",").map((s) => s.trim()).filter(Boolean);
      for (const item of items) {
        // Strip quotes if present
        const clean = item.replace(/^["']|["']$/g, "");
        if (clean && /^[a-zA-Z]/.test(clean)) {
          tools.add(clean);
        }
      }
    }
  }
  return tools;
}

// ---------------------------------------------------------------------------
// E2 — Parse workflow seam calls
// ---------------------------------------------------------------------------

/**
 * Extract tool names from "node CLI toolName" patterns in workflow source files.
 *
 * The seam pattern is:  node CLI toolName [--json ...]
 * In the workflow JS source, this appears as a template literal with dollar-brace-CLI.
 *
 * @param {string} workflowsDir
 * @returns {Set<string>}
 */
export function parseWorkflowSeamCalls(workflowsDir) {
  const tools = new Set();
  if (!existsSync(workflowsDir)) return tools;

  let entries;
  try {
    entries = readdirSync(workflowsDir, { withFileTypes: true });
  } catch {
    return tools;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    const filePath = join(workflowsDir, entry.name);
    let content;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    // Match the pattern: node + dollar-brace-CLI-close-brace + toolName
    // (the CLI is a template variable in the workflow JS source)
    const re = /node\s+\$\{CLI\}\s+([a-zA-Z][a-zA-Z0-9_]*)/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      tools.add(m[1]);
    }
  }
  return tools;
}

// ---------------------------------------------------------------------------
// E2 — Parse TOOLS map from cli.ts
// ---------------------------------------------------------------------------

/**
 * Extract tool names from the `const TOOLS: Record<string, ToolFn> = { ... }` map
 * in cli.ts. Uses a simple approach: find the TOOLS block and extract keys.
 *
 * @param {string} source
 * @returns {Set<string>}
 */
export function parseCliToolsMap(source) {
  const tools = new Set();

  // Find the TOOLS block: `const TOOLS: Record<...> = {` ... `};`
  const blockStart = source.indexOf("const TOOLS:");
  if (blockStart === -1) return tools;

  // Find the matching closing brace
  let depth = 0;
  let inBlock = false;
  let blockEnd = -1;
  for (let i = blockStart; i < source.length; i++) {
    if (source[i] === "{") {
      depth++;
      inBlock = true;
    } else if (source[i] === "}" && inBlock) {
      depth--;
      if (depth === 0) {
        blockEnd = i;
        break;
      }
    }
  }

  if (blockEnd === -1) return tools;
  const block = source.slice(blockStart, blockEnd + 1);

  // Extract keys: lines of the form `  toolName,` or `  toolName:` (shorthand or explicit)
  // In the CLI map, shorthand property names are used (e.g. `runPhaseStart,`)
  // Regex: match identifiers at the start of a property position
  const keyRe = /^\s{2}([a-zA-Z][a-zA-Z0-9_]*)\s*[,:{]/gm;
  let m;
  while ((m = keyRe.exec(block)) !== null) {
    tools.add(m[1]);
  }
  return tools;
}

// ---------------------------------------------------------------------------
// E3 — Peer-import graph (additive reachability from src/tools/*.ts imports)
// ---------------------------------------------------------------------------

/**
 * Walk the tool source files and collect any tool function names they import
 * from sibling tool files. This catches tools that are only called by other
 * tools (peer imports), not directly by a skill or workflow.
 *
 * For this report, a peer import is an `import { ... } from "./some-tool.js"` in
 * a file under src/tools/. The imported names are NOT treated as tool-name
 * registrations — only the register.ts `name:` fields are canonical. Instead,
 * peer imports contribute to the REACHABLE set: if a tool file imports from
 * another tool file, that source file is peer-reached.
 *
 * In practice the Flow server has very few inter-tool imports (classifyRiskTier
 * is called by runAutoMergeGate, computeAgreement is called by runAutoMergeGate,
 * etc.) — but we include them for completeness.
 *
 * @param {string} toolsDir
 * @returns {Set<string>} function names imported from sibling tool files
 */
export function parsePeerImports(toolsDir) {
  const reachedFunctions = new Set();
  if (!existsSync(toolsDir)) return reachedFunctions;

  let entries;
  try {
    entries = readdirSync(toolsDir, { withFileTypes: true });
  } catch {
    return reachedFunctions;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
    const filePath = join(toolsDir, entry.name);
    let content;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    // Match: import { foo, bar } from "./some-tool.js"
    const importRe = /import\s*\{([^}]+)\}\s*from\s*["']\.\//g;
    let m;
    while ((m = importRe.exec(content)) !== null) {
      const names = m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
      for (const name of names) {
        reachedFunctions.add(name);
      }
    }
  }
  return reachedFunctions;
}

// ---------------------------------------------------------------------------
// Main report builder
// ---------------------------------------------------------------------------

/**
 * Build the full reachability report.
 *
 * @param {{
 *   registerTsPath?: string;
 *   cliTsPath?: string;
 *   skillsDir?: string;
 *   workflowsDir?: string;
 *   toolsSrcDir?: string;
 * }} [opts]
 * @returns {{
 *   registeredTools: string[];
 *   reachableFromSkills: string[];
 *   reachableFromWorkflowSeams: string[];
 *   cliToolsMapKeys: string[];
 *   reachableFromPeerImports: string[];
 *   reachableSet: string[];
 *   unreachable: string[];
 *   cliVsWorkflowDelta: string[];
 * }}
 */
export function buildReachabilityReport(opts = {}) {
  const registerTsPath = opts.registerTsPath ?? REGISTER_TS;
  const cliTsPath = opts.cliTsPath ?? CLI_TS;
  const skillsDirPath = opts.skillsDir ?? SKILLS_DIR;
  const workflowsDirPath = opts.workflowsDir ?? WORKFLOWS_DIR;
  const toolsSrcDir = opts.toolsSrcDir ?? resolve(MCP_SERVER_ROOT, "src/tools");

  // Read source files
  const registerSource = existsSync(registerTsPath) ? readFileSync(registerTsPath, "utf-8") : "";
  const cliSource = existsSync(cliTsPath) ? readFileSync(cliTsPath, "utf-8") : "";

  // E1 — registered tools (canonical set)
  const registeredTools = parseRegisteredTools(registerSource);

  // E1 — skill entry-points
  const skillTools = parseSkillAllowedTools(skillsDirPath);

  // E2 — workflow seam calls
  const workflowSeamTools = parseWorkflowSeamCalls(workflowsDirPath);

  // E2 — CLI TOOLS map
  const cliToolsMap = parseCliToolsMap(cliSource);

  // E3 — peer imports from tool source files
  const peerImports = parsePeerImports(toolsSrcDir);

  // The three entry-point classes for the "unreachable" determination (AC1):
  //   E1 — skill allowed_tools
  //   E2 — workflow seam calls (actual "node CLI toolName" invocations)
  //   E3 — peer imports
  // NOTE: The CLI TOOLS map is NOT an entry-point class for unreachability; it is
  // only compared against workflow seam calls for the "cli-vs-workflow delta" (AC3).
  const reachableFromEntryPoints = new Set([
    ...skillTools,
    ...workflowSeamTools,
    ...peerImports,
  ]);

  // Full reachable set (all four sources) — informational display only.
  const reachableSet = new Set([
    ...reachableFromEntryPoints,
    ...cliToolsMap,
  ]);

  // Unreachable: registered but not reached by any of the three entry-point classes,
  // and not in the dynamic allowlist.
  const unreachable = [...registeredTools]
    .filter((t) => !reachableFromEntryPoints.has(t) && !DYNAMIC_TOOL_ALLOWLIST.has(t))
    .sort();

  // CLI-vs-workflow delta: tools in the CLI TOOLS map but absent from every workflow seam call
  const cliVsWorkflowDelta = [...cliToolsMap]
    .filter((t) => !workflowSeamTools.has(t))
    .sort();

  return {
    registeredTools: [...registeredTools].sort(),
    reachableFromSkills: [...skillTools].sort(),
    reachableFromWorkflowSeams: [...workflowSeamTools].sort(),
    cliToolsMapKeys: [...cliToolsMap].sort(),
    reachableFromPeerImports: [...peerImports].sort(),
    reachableSet: [...reachableSet].sort(),
    unreachable,
    cliVsWorkflowDelta,
  };
}

// ---------------------------------------------------------------------------
// Human-readable report renderer
// ---------------------------------------------------------------------------

/**
 * Render the reachability report as a human-readable string.
 *
 * @param {ReturnType<typeof buildReachabilityReport>} report
 * @returns {string}
 */
export function renderReport(report) {
  const lines = [];

  lines.push("=== Flow MCP Server — Tool Reachability Audit ===");
  lines.push("");
  lines.push(`Registered tools total: ${report.registeredTools.length}`);
  lines.push(`Reachable (union of all entry-point classes): ${report.reachableSet.length}`);
  lines.push("");

  // ---------- unreachable section ----------
  lines.push("--- unreachable ---");
  if (report.unreachable.length === 0) {
    lines.push("  (none — all registered tools are reachable)");
  } else {
    lines.push(`  ${report.unreachable.length} tool(s) registered but reachable by NO skill, workflow seam, or peer import:`);
    for (const t of report.unreachable) {
      lines.push(`  - ${t}`);
    }
  }
  lines.push("");

  // ---------- cli-vs-workflow delta section ----------
  lines.push("--- cli-vs-workflow delta ---");
  if (report.cliVsWorkflowDelta.length === 0) {
    lines.push("  (none — every CLI TOOLS entry has at least one workflow seam call)");
  } else {
    lines.push(`  ${report.cliVsWorkflowDelta.length} tool(s) in the CLI TOOLS map but absent from every workflow seam call:`);
    for (const t of report.cliVsWorkflowDelta) {
      lines.push(`  - ${t}`);
    }
  }
  lines.push("");

  // ---------- debug breakdown ----------
  lines.push("--- reachability breakdown ---");
  lines.push(`  From skill allowed_tools: ${report.reachableFromSkills.length}`);
  lines.push(`  From workflow seam calls: ${report.reachableFromWorkflowSeams.length}`);
  lines.push(`  From CLI TOOLS map:       ${report.cliToolsMapKeys.length}`);
  lines.push(`  From peer imports:         ${report.reachableFromPeerImports.length}`);
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI entry-point
// ---------------------------------------------------------------------------

function main() {
  const report = buildReachabilityReport();
  const text = renderReport(report);
  process.stdout.write(text + "\n");
  process.exit(0);
}

const isDirectInvocation =
  process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectInvocation) {
  main();
}
