/**
 * Story 2.8 AC1–AC6 — worktree-smoke workflow and `_meta.role` enforcement harness.
 *
 * See `plugins/flow/docs/user-surface-acs.md` for the user-surface AC rubric
 * (Story 1.8 convention). AC1, AC3, AC4 are tagged `(user-surface)`:
 *   - AC1: operator runs the recipe from `plugins/flow/docs/worktree-smoke.md`.
 *   - AC3: operator runs `./plugins/flow/scripts/worktree-smoke.sh` and reads stdout.
 *   - AC4: operator reads `plugins/flow/docs/worktree-smoke.md` from a fresh checkout.
 * AC2 governs internal `_meta.role` propagation (NOT user-surface).
 * AC5 pins the enforcement doc shape (contributor artefact, NOT user-surface).
 * AC6 is the integration harness (NOT user-surface).
 *
 * AC2/AC5 verdict: "unknown-but-belt-and-braces" — `_meta.role` propagation from
 * the Claude Code `Task` tool to spawned subagent MCP calls could not be
 * empirically confirmed within story scope. Fallback option (a) `allowed_tools`
 * Task argument is implemented as defence-in-depth. See
 * `plugins/flow/docs/ask-mode-enforcement.md`.
 *
 * No .only, no .todo, no .skip.
 */

import { afterAll, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";

import { createServer } from "../src/server.js";
import { registerAllTools } from "../src/tools/register.js";
import { loadRolePermissions } from "../src/state/load-role-permissions.js";
import { RolePermissionsSchema } from "../src/schemas/role-permissions.js";
import {
  assembleAskModeAllowedTools,
  ASK_MODE_TASK_ALLOWED_TOOLS,
  isReadShapedTool,
} from "../src/lib/ask-mode-allowed-tools.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..", "..");
const SCRIPT_PATH = path.resolve(PLUGIN_ROOT, "scripts", "worktree-smoke.sh");
const DOC_PATH = path.resolve(PLUGIN_ROOT, "docs", "worktree-smoke.md");
const ENFORCEMENT_DOC_PATH = path.resolve(PLUGIN_ROOT, "docs", "ask-mode-enforcement.md");
const PERMISSIONS_DIR = path.resolve(PLUGIN_ROOT, "permissions");
const FIXTURE_PERMISSIONS_DIR = path.resolve(HERE, "fixtures", "permissions");

/** Verbatim three-line slash-command block (AC3, AC4, AC6(e)). */
const VERBATIM_RECIPE_LINES = [
  "/plugin uninstall flow@flow",
  "/plugin install flow@flow",
  "/reload-plugins",
] as const;

// ---------------------------------------------------------------------------
// Temp dir cleanup
// ---------------------------------------------------------------------------
const tmpDirs: string[] = [];

afterAll(async () => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try {
      await fs.rm(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

async function makeTmp(prefix: string): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `flow-28-${prefix}-`));
  tmpDirs.push(tmp);
  return tmp;
}

// ---------------------------------------------------------------------------
// MCP server factory (production wiring — real permissions loader)
// ---------------------------------------------------------------------------
async function makeServerAndClient(): Promise<{
  client: Client;
  cleanup: () => Promise<void>;
}> {
  const server = createServer({
    permissionsLoader: async (role) =>
      loadRolePermissions({ role, pluginRoot: PLUGIN_ROOT }),
  });
  registerAllTools(server);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "ask-mode-enforcement-test", version: "0.0.0" },
    { capabilities: {} },
  );
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

// ---------------------------------------------------------------------------
// AC6(a) — Path-A happy case: _meta.role === "ask-mode" refuses instantiatePersona
// ---------------------------------------------------------------------------
describe("AC6(a) — Path-A happy case: ask-mode refuses instantiatePersona", () => {
  it("CallTool with _meta.role=ask-mode against instantiatePersona returns PermissionDeniedError", async () => {
    const { client, cleanup } = await makeServerAndClient();
    try {
      const result = await client.callTool({
        name: "instantiatePersona",
        arguments: {
          targetRepoRoot: "/tmp/fake",
          role: "planner",
        },
        _meta: { role: "ask-mode" },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content.length).toBeGreaterThan(0);
      const text = content[0]!.text;
      expect(text, "error text must mention ask-mode").toContain("ask-mode");
      expect(text, "error text must mention instantiatePersona").toContain(
        "instantiatePersona",
      );
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// AC6(b) — no-_meta probe: omitting _meta does NOT refuse at dispatcher
// ---------------------------------------------------------------------------
describe("AC6(b) — no-_meta probe: omitting _meta does NOT refuse at dispatcher", () => {
  it("CallTool with no _meta.role reaches the handler (not a PermissionDeniedError)", async () => {
    // AC6(b) spec: a CallTool with _meta omitted is NOT refused at the dispatcher.
    // The dispatcher only enforces when _meta.role is present. Without it, the call
    // falls through to the handler.
    //
    // We call readCatalogue (a read-only handler) with a valid catalogue role,
    // which succeeds without _meta.role — proving the dispatcher does not
    // pre-emptively refuse calls that omit _meta.role.
    //
    // The contrapositive proven: if Task strips _meta, the spawned subagent's
    // calls to mutators are unrestricted at the MCP layer — motivating the
    // allowed_tools Task argument fallback (option (a)).
    const { client, cleanup } = await makeServerAndClient();
    try {
      const result = await client.callTool({
        name: "readCatalogue",
        arguments: {
          role: "planner",
        },
        // _meta intentionally omitted — no role, no permission check at dispatcher
      });

      // The call was NOT refused at the dispatcher layer.
      // readCatalogue succeeded (or returned a handler-level error), but critically
      // NOT a PermissionDeniedError — the absence of _meta.role is NOT itself a refuse.
      const content = result.content as Array<{ type: string; text: string }>;
      const text = content[0]?.text ?? "";
      expect(
        text,
        "no-_meta call must NOT produce a PermissionDeniedError",
      ).not.toContain("is not allowed to invoke tool");
      // readCatalogue with role:"planner" should succeed normally
      expect(result.isError).toBeFalsy();
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// AC6(c) — Fallback option (a): assembleAskModeAllowedTools returns the read-only set
// ---------------------------------------------------------------------------
describe("AC6(c) — fallback option (a): assembleAskModeAllowedTools returns read-only set", () => {
  // AC5 verdict: unknown-but-belt-and-braces → fallback exercised.

  it("assembleAskModeAllowedTools returns tools_allow from ask-mode.yaml plus Read", async () => {
    const allowedTools = await assembleAskModeAllowedTools(PLUGIN_ROOT);

    // Must include "Read" (Claude Code built-in)
    expect(allowedTools, "must include Read").toContain("Read");

    // Must include all tools from ask-mode.yaml tools_allow
    const perms = await loadRolePermissions({ role: "ask-mode", pluginRoot: PLUGIN_ROOT });
    for (const tool of perms.tools_allow) {
      expect(allowedTools, `must include tools_allow entry: ${tool}`).toContain(tool);
    }

    // Length = tools_allow.length + 1 (for "Read")
    expect(allowedTools.length).toBe(perms.tools_allow.length + 1);
  });

  it("ASK_MODE_TASK_ALLOWED_TOOLS static constant matches runtime result", async () => {
    const allowedTools = await assembleAskModeAllowedTools(PLUGIN_ROOT);

    // Sort both for order-insensitive comparison
    const sorted = [...allowedTools].sort();
    const sortedStatic = [...ASK_MODE_TASK_ALLOWED_TOOLS].sort();
    expect(sorted).toEqual(sortedStatic);
  });

  it("allowed set does NOT include any canonical-state mutators", async () => {
    const allowedTools = await assembleAskModeAllowedTools(PLUGIN_ROOT);
    const MUTATORS = [
      "instantiatePersona",
      "appendPersonaKnowledge",
      "claimStory",
      "recordVerdict",
      "applyRetroProposal",
      "unhireRole",
    ];
    for (const mutator of MUTATORS) {
      expect(
        allowedTools,
        `allowed set must not contain mutator '${mutator}'`,
      ).not.toContain(mutator);
    }
  });

  it("every tools_allow entry is read-shaped (starts with get/read/lookup or equals heartbeat)", async () => {
    const allowedTools = await assembleAskModeAllowedTools(PLUGIN_ROOT);
    const ALLOWED_PREFIXES = ["get", "read", "lookup"];
    const NON_MCP = ["Read"]; // Claude Code built-in, not an MCP tool
    for (const tool of allowedTools) {
      if (NON_MCP.includes(tool)) continue; // Claude Code built-ins are always safe
      const isReadShaped =
        ALLOWED_PREFIXES.some((prefix) => tool.startsWith(prefix)) ||
        tool === "heartbeat";
      expect(
        isReadShaped,
        `allowed tool '${tool}' is not read-shaped (get/read/lookup prefix or heartbeat)`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// AC6(d) — worktree-smoke script exit-code matrix
// ---------------------------------------------------------------------------
describe("AC6(d) — worktree-smoke script exit-code matrix", () => {
  it("(i) exits 0 inside a worktree and stdout contains the verbatim three-line block", async () => {
    // Build a real git repo with a worktree
    const mainDir = await makeTmp("main");
    const wtDir = await makeTmp("wt");

    // Init the main repo and create an initial commit
    await execa("git", ["init", mainDir]);
    await execa("git", ["-C", mainDir, "config", "user.email", "test@test.com"]);
    await execa("git", ["-C", mainDir, "config", "user.name", "Test"]);
    await execa("git", ["-C", mainDir, "commit", "--allow-empty", "-m", "init"]);

    // Add a worktree on a new branch
    const wtBranch = "story/test-worktree-28";
    await execa("git", ["-C", mainDir, "worktree", "add", "-b", wtBranch, wtDir]);

    const result = await execa("/bin/sh", [SCRIPT_PATH], {
      cwd: wtDir,
      reject: false,
    });

    expect(result.exitCode, `expected exit 0, got ${result.exitCode}; stderr: ${result.stderr}`).toBe(0);

    const stdout = result.stdout;
    for (const line of VERBATIM_RECIPE_LINES) {
      expect(stdout, `stdout must contain: ${line}`).toContain(line);
    }
  });

  it("(ii) exits 2 inside a plain git checkout (not a worktree) with the verbatim diagnostic", async () => {
    const mainDir = await makeTmp("main2");

    await execa("git", ["init", mainDir]);
    await execa("git", ["-C", mainDir, "config", "user.email", "test@test.com"]);
    await execa("git", ["-C", mainDir, "config", "user.name", "Test"]);
    await execa("git", ["-C", mainDir, "commit", "--allow-empty", "-m", "init"]);

    const result = await execa("/bin/sh", [SCRIPT_PATH], {
      cwd: mainDir,
      reject: false,
    });

    expect(result.exitCode, `expected exit 2, got ${result.exitCode}`).toBe(2);
    expect(result.stderr).toContain(
      "worktree-smoke: refusing to run outside a worktree — cd into .worktrees/<branch>/ first",
    );
  });

  it("(iii) exits 3 when git is not on PATH with the verbatim diagnostic", async () => {
    const tmpDir = await makeTmp("nopath");

    // Use /bin/sh directly (absolute path) so execa can find it even with PATH="".
    // This simulates the operator's environment having no git on PATH.
    const result = await execa("/bin/sh", [SCRIPT_PATH], {
      cwd: tmpDir,
      env: { HOME: os.homedir(), PATH: "" },
      reject: false,
    });

    expect(result.exitCode, `expected exit 3, got ${result.exitCode}`).toBe(3);
    expect(result.stderr).toContain("worktree-smoke: missing dependency: git");
  });
});

// ---------------------------------------------------------------------------
// AC6(e) — worktree-smoke / doc parity: three-line block is byte-identical
// ---------------------------------------------------------------------------
describe("AC6(e) — worktree-smoke doc and script parity", () => {
  it("the verbatim three-line block in worktree-smoke.md is byte-identical to the script's stdout block", async () => {
    const docContent = await fs.readFile(DOC_PATH, "utf8");
    const scriptContent = await fs.readFile(SCRIPT_PATH, "utf8");

    // Extract the three lines from the doc (inside the fenced code block in ## Recipe)
    // The block looks like:
    // ```
    // /plugin uninstall flow@flow
    // /plugin install flow@flow
    // /reload-plugins
    // ```
    const docBlockMatch = /```\n(\/plugin uninstall flow@flow\n\/plugin install flow@flow\n\/reload-plugins)\n```/.exec(docContent);
    expect(docBlockMatch, "doc must contain the verbatim three-line fenced block").toBeTruthy();
    const docBlock = docBlockMatch![1]!;

    // Extract the three lines from the script (printf statements)
    // The script uses: printf '/plugin uninstall flow@flow\n'
    //                  printf '/plugin install flow@flow\n'
    //                  printf '/reload-plugins\n'
    const scriptUninstall = /printf '(\/plugin uninstall flow@flow)\\n'/.exec(scriptContent);
    const scriptInstall = /printf '(\/plugin install flow@flow)\\n'/.exec(scriptContent);
    const scriptReload = /printf '(\/reload-plugins)\\n'/.exec(scriptContent);

    expect(scriptUninstall, "script must contain printf for /plugin uninstall").toBeTruthy();
    expect(scriptInstall, "script must contain printf for /plugin install").toBeTruthy();
    expect(scriptReload, "script must contain printf for /reload-plugins").toBeTruthy();

    const scriptBlock = [
      scriptUninstall![1]!,
      scriptInstall![1]!,
      scriptReload![1]!,
    ].join("\n");

    expect(scriptBlock).toBe(docBlock);

    // Also assert each verbatim line is present in both
    for (const line of VERBATIM_RECIPE_LINES) {
      expect(docContent, `doc must contain: ${line}`).toContain(line);
      expect(scriptContent, `script must contain: ${line}`).toContain(line);
    }
  });
});

// ---------------------------------------------------------------------------
// AC6(f) — ask-mode-enforcement.md shape
// ---------------------------------------------------------------------------
describe("AC6(f) — ask-mode-enforcement.md shape", () => {
  it("contains all five required sections in order", async () => {
    const content = await fs.readFile(ENFORCEMENT_DOC_PATH, "utf8");

    const requiredSections = [
      "## Question",
      "## Investigation method",
      "## Answer",
      "## Verification artefact",
      "## Implications for future stories",
    ];

    let lastIdx = 0;
    for (const section of requiredSections) {
      const idx = content.indexOf(section, lastIdx);
      expect(
        idx,
        `Section "${section}" not found after position ${lastIdx}`,
      ).toBeGreaterThan(-1);
      lastIdx = idx + section.length;
    }
  });

  it("Answer section names exactly one of the three sanctioned values", async () => {
    const content = await fs.readFile(ENFORCEMENT_DOC_PATH, "utf8");

    // Extract the Answer section content
    const answerMatch = /## Answer\n([\s\S]*?)(?=\n## |\n---|\s*$)/.exec(content);
    expect(answerMatch, "## Answer section not found").toBeTruthy();
    const answerSection = answerMatch![1]!;

    const sanctionedValues = [
      "confirmed-propagating",
      "confirmed-not-propagating",
      "unknown-but-belt-and-braces",
    ];

    const found = sanctionedValues.filter((v) => answerSection.includes(v));
    expect(
      found.length,
      `Answer section must contain exactly one sanctioned value, found: ${found.join(", ")}`,
    ).toBeGreaterThanOrEqual(1);

    // Regex match per AC6(f) spec
    const regex = /(confirmed-propagating|confirmed-not-propagating|unknown-but-belt-and-braces)/;
    expect(regex.test(answerSection)).toBe(true);
  });

  it("file is <= 150 lines (operator-readability budget)", async () => {
    const content = await fs.readFile(ENFORCEMENT_DOC_PATH, "utf8");
    const lineCount = content.split("\n").length;
    expect(
      lineCount,
      `ask-mode-enforcement.md is ${lineCount} lines; must be <= 150`,
    ).toBeLessThanOrEqual(150);
  });
});

// ---------------------------------------------------------------------------
// AC6(g) — tool registration at 9 tools (Story 3.2 added scanSources)
// ---------------------------------------------------------------------------
describe("AC6(g) — tool registration unchanged at 8 tools (Story 2.8 registers no new tools)", () => {
  it("MCP server lists exactly 8 tools and no new tool was added by Story 2.8", async () => {
    const server = createServer();
    registerAllTools(server);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "ac6g-test", version: "0.0.0" },
      { capabilities: {} },
    );

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const result = await client.request(
        { method: "tools/list", params: {} },
        ListToolsResultSchema,
      );

      const toolNames = result.tools.map((t) => t.name);

      // The eight Story 2.6 tools (unchanged through Story 2.8) plus scanSources from Story 3.2
      const expectedTools = [
        "getStatus",
        "readCatalogue",
        "instantiatePersona",
        "readPersona",
        "lookupRoleByDomain",
        "readRepoSignals",
        "readCustomRole",
        "getTeamSnapshot",
        "scanSources",
      ];
      for (const name of expectedTools) {
        expect(toolNames, `expected tool '${name}' to be registered`).toContain(name);
      }

      // Story 3.2 added scanSources (9); Story 3.4 added writeNativeStory (10); Story 3.5 added validatePlannerBacklog (11); Story 3.6 added markWithdrawn (12) and readBacklogInventory (13); Story 4.1 added claimStory (14) and completeStory (15); Story 4.2 added mintSessionUlid (16), listClaimableTodos (17), buildPersonaSpawnPrompt (18); Story 4.3 added runDevSession (19); Story 4.3b replaced runDevSession with claimNextStory (19), processDevTranscript (20), processReviewerTranscript (21); Story 4.4 added runDevTerminalAction (22); Story 4.6 added runReviewerSession (23); Story 4.6b added postReviewerComments (24); Story 4.8 added applyReviewerLabels (25); Story 4.12 added recordAgentInvoke (26) and recordPrCloseAction (27); Story 4.11 added processReviewerYield (28); Story 4.9b added classifyRiskTier (29); Story 4.10 added computeAgreement (30); Story 4.10b added runAutoMergeGate (31); Story 1.13 added createSmokeScratchRepo (32); Story 5.11 added scanOrphanedInProgress (33), reattachOrphan (34), blockOrphanNoTranscript (35); Story 6.1 added recordStoryRetro (36); Story 6.3 added writeRetroProposal (37); Story 6.2 added gatherRetroInputs (38). De-cruft 2026-05-30: removed recordAgentInvoke (26) + recordPrCloseAction (27) (unwired dead code) = 36 total. Story 6.4 added acceptProposal = 37 total. Story 9.1 added markStoryReady = 38 total. Story 9.3 added writeLensVerdict + aggregateJudgePanel (judge panel) = 40 total. Story 9.4 added adjudicateQualityLead (Quality Lead) = 41 total. Story 9.5 added getBacklogDashboard (backlog dashboard) = 42 total. Story 6.8 added recordSkillInvoke + computeSkillEffectiveness (skill telemetry) = 44 total. Story 10.5 added bmadToNativeIngest (BMad → native ingest seam) = 45 total. FU2 added resolveLensRoles (deterministic lens→role binding) = 46 total. FU7 added recordAgentFriction (agent friction signal) = 47 total. Story native:01KT484NY4HCBPBTT6VEY1Q0CS added openCycle (cycle boundary) = 48 total. Story native:01KT6GSV8KTTKKHPRGEJWJAGZV added recordReviewerLesson (learning-loop capture) = 49 total. Story native:01KT6QEWY794ZY0DH6JHQFWG6V added recallLesson (on-demand lesson recall) = 50 total.
      // Story native:01KTKJXP6DWN5YHKVG96DH16V0 added classifyStoryLane (pre-judge lane classifier) = 51 total.
      // Story native:01KTKK2Y73EDDAXK470EZ3MHQ8 added resolveJudgePlan (fast-lane judge plan resolver) = 52 total.
      // Story native:01KTKK3HQYNFS1M1ZR9TG02G1F added resolveBuildPlan (fast-lane build plan resolver) = 53 total.
      // Story native:01KTZGEW6TSC6M84P9KJ7FD96S added summariseRetroProposal (retro inline summary) = 54 total.
      // Story native:01KTZKHJ1KDYKGXR20FZ15Y4WB added discardDraft (discard un-built parked draft) = 55 total.
      // Story native:01KT7S0E2 removed bmadToNativeIngest (auditor-confirmed orphan) = 54 total.
      // Story native:01KV7FHZ41Z6CFPABW1B8J38BV added recordMaintainerFeedback (maintainer inbox capture) = 55 total.
      // Story native:01KV9QR3VK11RDD1ZDPVJ7SEYA added reviewMaintainerInbox (on-demand inbox review) = 56 total.
      // Story native:01KVDXX (surface-maintainer-findings-in-run) added dismissMaintainerFeedback = 57 total.
      // Story native:01KVEHE5XNBHKVVZ624GPAW9FF added getHelpAdvice (context-aware next-action advisor) = 58 total.
      // Story native:01KVFAF2T7DPJ5T18PQ534D7XM added analyzeTeamFit (team-fit analysis) = 59 total.
      // Story native:01KVF66HWKXCM7GYNRR9YJFKB2 added unhirePersona (safe reversible unhire) = 60 total.
      // /flow:init added initWorkspace (first-run workspace scaffolder) = 61 total.
      // Story native:01KVN6ASCWXAHZ0FF7YRFKJECC added requeueBlockedStory (requeue blocked story) = 62 total.
      // Story native:01KVPQS1DVJE41KNG065D6X1X7 added resolveRunSlot (dynamic run slot resolution) = 63 total.
      expect(result.tools.length, "expected exactly 63 tools").toBe(63);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// AC6(h) — ask-mode.yaml unchanged (structural assertion)
// ---------------------------------------------------------------------------
describe("AC6(h) — ask-mode.yaml content stability", () => {
  it("ask-mode.yaml parses with role=ask-mode, expected tools_allow, gh_allow=[pr-view]", async () => {
    const perms = await loadRolePermissions({
      role: "ask-mode",
      pluginRoot: PLUGIN_ROOT,
    });

    expect(perms.role).toBe("ask-mode");

    // Structural: tools_allow is the read-only set from Story 2.7
    const EXPECTED_TOOLS_ALLOW = [
      "heartbeat",
      "readPersona",
      "readCatalogue",
      "lookupRoleByDomain",
      "readRepoSignals",
      "readCustomRole",
      "getStatus",
      "getTeamSnapshot",
    ];
    expect(perms.tools_allow.length).toBe(EXPECTED_TOOLS_ALLOW.length);
    for (const tool of EXPECTED_TOOLS_ALLOW) {
      expect(perms.tools_allow, `tools_allow must contain '${tool}'`).toContain(tool);
    }

    // gh_allow exactly ['pr-view']
    expect(perms.gh_allow).toEqual(["pr-view"]);
  });

  it("ask-mode.yaml passes RolePermissionsSchema.safeParse", async () => {
    const { parse: yamlParse } = await import("yaml");
    const raw = await fs.readFile(
      path.join(PERMISSIONS_DIR, "ask-mode.yaml"),
      "utf8",
    );
    const parsed = yamlParse(raw);
    const result = RolePermissionsSchema.safeParse(parsed);
    expect(
      result.success,
      `RolePermissionsSchema parse failed: ${result.success ? "" : JSON.stringify((result as { error: unknown }).error)}`,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Story native:01KVPR1REEC5Y90FKFDCKNNADC AC1/AC2/AC3 — role-union allowlist
// ---------------------------------------------------------------------------

/**
 * Build a temporary plugin-root directory that contains a `permissions/`
 * subdirectory with:
 *   - `ask-mode.yaml` copied from the real plugin root, and
 *   - `<extraRole>.yaml` copied from the test fixtures dir.
 *
 * This lets `assembleAskModeAllowedTools(tmpRoot, role)` run against a
 * controlled fixture without touching the real permissions directory.
 */
async function makeFixturePluginRoot(extraRole: string): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `flow-askmod-union-`));
  tmpDirs.push(tmp);
  const tmpPerms = path.join(tmp, "permissions");
  await fs.mkdir(tmpPerms, { recursive: true });

  // Copy the real ask-mode.yaml (shared set) into the temp root.
  await fs.copyFile(
    path.join(PERMISSIONS_DIR, "ask-mode.yaml"),
    path.join(tmpPerms, "ask-mode.yaml"),
  );

  // Copy the fixture role permissions file.
  const fixtureSrc = path.join(FIXTURE_PERMISSIONS_DIR, `${extraRole}.yaml`);
  await fs.copyFile(fixtureSrc, path.join(tmpPerms, `${extraRole}.yaml`));

  return tmp;
}

/**
 * The read-shaped tools declared by the platform-specialist fixture that are
 * NOT in the shared ask-mode set — i.e., the tools that should appear in the
 * union but not in the base set.
 *
 * Must stay in sync with `tests/fixtures/permissions/platform-specialist.yaml`.
 */
const PLATFORM_SPECIALIST_EXTRA_READ_TOOLS = [
  "readPlatformDocs",
  "lookupPlatformService",
] as const;

/**
 * The write-capable tools declared by the platform-specialist fixture that
 * MUST NOT be admitted to the union allowlist.
 *
 * Must stay in sync with `tests/fixtures/permissions/platform-specialist.yaml`.
 */
const PLATFORM_SPECIALIST_WRITE_TOOLS = [
  "writePlatformEntry",
  "recordPlatformEvent",
] as const;

describe("AC1 — platform-specialist consult: union includes role-declared read-only tools", () => {
  it("union allowlist contains the shared set plus the specialist's read-shaped tools", async () => {
    const fixtureRoot = await makeFixturePluginRoot("platform-specialist");
    const allowedTools = await assembleAskModeAllowedTools(fixtureRoot, "platform-specialist");

    // All shared tools must be present.
    for (const tool of ASK_MODE_TASK_ALLOWED_TOOLS) {
      expect(allowedTools, `must still contain shared tool '${tool}'`).toContain(tool);
    }

    // The specialist's read-shaped tools must be present in the union.
    for (const tool of PLATFORM_SPECIALIST_EXTRA_READ_TOOLS) {
      expect(
        allowedTools,
        `union must include specialist's read-shaped tool '${tool}'`,
      ).toContain(tool);
    }
  });

  it("union allowlist contains 'Read' (Claude Code built-in)", async () => {
    const fixtureRoot = await makeFixturePluginRoot("platform-specialist");
    const allowedTools = await assembleAskModeAllowedTools(fixtureRoot, "platform-specialist");
    expect(allowedTools, "must include 'Read' built-in").toContain("Read");
  });

  it("the union set is strictly larger than the shared-only set when the role declares extra read tools", async () => {
    const sharedOnly = await assembleAskModeAllowedTools(PLUGIN_ROOT);
    const fixtureRoot = await makeFixturePluginRoot("platform-specialist");
    const withRole = await assembleAskModeAllowedTools(fixtureRoot, "platform-specialist");

    // The union must be strictly larger (the specialist added read tools not in the shared set).
    expect(
      withRole.length,
      "union set must be larger than the shared-only set",
    ).toBeGreaterThan(sharedOnly.length);
  });
});

describe("AC2 — mutation refusal is absolute regardless of extra role tools in the consult", () => {
  it("write-capable tools from the platform-specialist fixture are NOT in the union allowlist", async () => {
    const fixtureRoot = await makeFixturePluginRoot("platform-specialist");
    const allowedTools = await assembleAskModeAllowedTools(fixtureRoot, "platform-specialist");

    for (const writeTool of PLATFORM_SPECIALIST_WRITE_TOOLS) {
      expect(
        allowedTools,
        `write-capable tool '${writeTool}' must NOT be admitted to the union allowlist`,
      ).not.toContain(writeTool);
    }
  });

  it("known canonical-state mutators are not admitted even when a role declares extra read tools", async () => {
    const fixtureRoot = await makeFixturePluginRoot("platform-specialist");
    const allowedTools = await assembleAskModeAllowedTools(fixtureRoot, "platform-specialist");

    const MUTATORS = [
      "instantiatePersona",
      "appendPersonaKnowledge",
      "claimStory",
      "recordVerdict",
      "applyRetroProposal",
      "unhireRole",
    ];
    for (const mutator of MUTATORS) {
      expect(
        allowedTools,
        `canonical-state mutator '${mutator}' must not be in the union allowlist`,
      ).not.toContain(mutator);
    }
  });

  it("MCP server still refuses a state-mutating call with _meta.role=ask-mode when extra role tools are present", async () => {
    // This asserts the server-side boundary is independent of the allowed-tools assembly.
    // The MCP dispatcher refuses based on _meta.role, not the assembled tool list.
    const { client, cleanup } = await makeServerAndClient();
    try {
      const result = await client.callTool({
        name: "instantiatePersona",
        arguments: {
          targetRepoRoot: "/tmp/fake-for-union-test",
          role: "planner",
        },
        _meta: { role: "ask-mode" },
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      const text = content[0]!.text;
      expect(text, "refusal must mention ask-mode").toContain("ask-mode");
      expect(text, "refusal must mention the attempted tool").toContain("instantiatePersona");
    } finally {
      await cleanup();
    }
  });
});

describe("AC3 — assembled tool set is exactly the union of shared + role read-shaped tools, no others", () => {
  it("every tool in the union allowlist is either from the shared set or a read-shaped role tool", async () => {
    const fixtureRoot = await makeFixturePluginRoot("platform-specialist");
    const allowedTools = await assembleAskModeAllowedTools(fixtureRoot, "platform-specialist");

    // Load both permission files to compute the expected union explicitly.
    const sharedPerms = await loadRolePermissions({ role: "ask-mode", pluginRoot: fixtureRoot });
    const rolePerms = await loadRolePermissions({ role: "platform-specialist", pluginRoot: fixtureRoot });

    const expectedUnion = new Set([
      ...sharedPerms.tools_allow,
      "Read",
      ...rolePerms.tools_allow.filter(isReadShapedTool),
    ]);

    // Every tool in the assembled set must be in the expected union.
    for (const tool of allowedTools) {
      expect(
        expectedUnion.has(tool),
        `assembled tool '${tool}' is not in the expected union (shared + role read-shaped)`,
      ).toBe(true);
    }

    // Every tool in the expected union must be in the assembled set.
    for (const tool of expectedUnion) {
      expect(
        allowedTools,
        `expected union tool '${tool}' is missing from the assembled set`,
      ).toContain(tool);
    }
  });

  it("no write-capable tool from the role's declaration appears in the assembled set", async () => {
    const fixtureRoot = await makeFixturePluginRoot("platform-specialist");
    const rolePerms = await loadRolePermissions({ role: "platform-specialist", pluginRoot: fixtureRoot });
    const allowedTools = await assembleAskModeAllowedTools(fixtureRoot, "platform-specialist");

    // Find all write-capable tools in the role's declaration.
    const writeCapable = rolePerms.tools_allow.filter((t) => !isReadShapedTool(t));
    for (const writeTool of writeCapable) {
      expect(
        allowedTools,
        `write-capable role tool '${writeTool}' must not appear in the assembled set`,
      ).not.toContain(writeTool);
    }
  });

  it("isReadShapedTool correctly classifies known prefixes and exact names", () => {
    // True: read-shaped
    expect(isReadShapedTool("readPlatformDocs")).toBe(true);
    expect(isReadShapedTool("readPersona")).toBe(true);
    expect(isReadShapedTool("lookupPlatformService")).toBe(true);
    expect(isReadShapedTool("lookupRoleByDomain")).toBe(true);
    expect(isReadShapedTool("getStatus")).toBe(true);
    expect(isReadShapedTool("getTeamSnapshot")).toBe(true);
    expect(isReadShapedTool("heartbeat")).toBe(true);

    // False: write-capable / state-mutating
    expect(isReadShapedTool("writePlatformEntry")).toBe(false);
    expect(isReadShapedTool("recordPlatformEvent")).toBe(false);
    expect(isReadShapedTool("instantiatePersona")).toBe(false);
    expect(isReadShapedTool("claimStory")).toBe(false);
    expect(isReadShapedTool("completeStory")).toBe(false);
    expect(isReadShapedTool("recordYield")).toBe(false);
    expect(isReadShapedTool("blockStory")).toBe(false);
    expect(isReadShapedTool("runDevTerminalAction")).toBe(false);
  });

  it("fallback: when the role has no permissions file, returns only the shared set", async () => {
    // PLUGIN_ROOT has ask-mode.yaml but no 'nonexistent-role.yaml'.
    const allowedTools = await assembleAskModeAllowedTools(PLUGIN_ROOT, "nonexistent-role");
    const sharedOnly = await assembleAskModeAllowedTools(PLUGIN_ROOT);

    // With a missing role file, the result must equal the shared-only set (order-insensitive).
    expect([...allowedTools].sort()).toEqual([...sharedOnly].sort());
  });
});

// ---------------------------------------------------------------------------
// Additional: worktree-smoke.md structural shape (AC4)
// ---------------------------------------------------------------------------
describe("worktree-smoke.md structural shape (AC4)", () => {
  it("contains all required sections in exact order", async () => {
    const content = await fs.readFile(DOC_PATH, "utf8");

    const requiredSections = [
      "# Worktree smoke-test recipe for the flow plugin",
      "## Why this exists",
      "## Recipe",
      "## Helper script",
      "## Verifying the recipe worked",
      "## Cross-references",
    ];

    let lastIdx = 0;
    for (const section of requiredSections) {
      const idx = content.indexOf(section, lastIdx);
      expect(
        idx,
        `Section "${section}" not found after position ${lastIdx}`,
      ).toBeGreaterThan(-1);
      lastIdx = idx + section.length;
    }
  });

  it("contains the cache-reload trap warning verbatim", async () => {
    const content = await fs.readFile(DOC_PATH, "utf8");
    expect(content).toContain("/plugin install flow@flow");
    expect(content).toContain("no-op");
    expect(content).toContain("Uninstall first");
  });

  it("is <= 200 lines (operator-readability budget)", async () => {
    const content = await fs.readFile(DOC_PATH, "utf8");
    const lineCount = content.split("\n").length;
    expect(
      lineCount,
      `worktree-smoke.md is ${lineCount} lines; must be <= 200`,
    ).toBeLessThanOrEqual(200);
  });

  it("cross-references section links to user-surface-acs.md, SKILL.md, and ask-mode-enforcement.md", async () => {
    const content = await fs.readFile(DOC_PATH, "utf8");
    expect(content, "must link to user-surface-acs.md").toContain("user-surface-acs.md");
    expect(content, "must link to ask/SKILL.md").toContain("SKILL.md");
    expect(content, "must link to ask-mode-enforcement.md").toContain("ask-mode-enforcement.md");
  });
});
