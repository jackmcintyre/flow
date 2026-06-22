/**
 * Story 2.7 AC1–AC6 — `/flow:ask` side-session skill integration harness.
 *
 * See `plugins/flow/docs/user-surface-acs.md` for the user-surface AC
 * rubric (Story 1.8 convention). AC1 and AC6 are tagged `(user-surface)`:
 *   - AC1: operator runs `/flow:ask <role> "<question>"` and reads the response.
 *   - AC6: operator runs `/flow:ask <role>` against an un-hired role and reads the error block.
 * AC2, AC3, AC4, AC5 are NOT user-surface — operators never type
 * `pnpm --dir plugins/flow test`.
 *
 * This harness isolates the prompt-assembly helper (`assembleAskModePrompt`)
 * and the error-formatting helper (`formatUnhiredRoleError`) from a real
 * Claude Code `Task` subagent spawn — the subagent boundary is not testable
 * from inside vitest. The permission-enforcement assertions drive the existing
 * Story 1.4 boundary directly via the MCP server's `CallToolRequestSchema`
 * handler and the `gh()` wrapper.
 *
 * No .only, no .todo, no .skip.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { parse as yamlParse } from "yaml";
import { CallToolResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { createServer } from "../src/server.js";
import { registerAllTools } from "../src/tools/register.js";
import { instantiatePersona } from "../src/tools/instantiate-persona.js";
import { readPersona } from "../src/tools/read-persona.js";
import { getPluginRoot } from "../src/lib/plugin-root.js";
import { loadRolePermissions } from "../src/state/load-role-permissions.js";
import { RolePermissionsSchema } from "../src/schemas/role-permissions.js";
import {
  assembleAskModePrompt,
  formatUnhiredRoleError,
  ASK_MODE_BLOCK_STATIC,
} from "../src/lib/ask-mode-prompt.js";
import * as ghModule from "../src/lib/gh.js";
import { GhSubcommandDeniedError, PersonaFileNotFoundError } from "../src/errors.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..", "..");
const SKILL_FILE = path.resolve(PLUGIN_ROOT, "skills", "ask", "SKILL.md");
const PERMISSIONS_DIR = path.resolve(PLUGIN_ROOT, "permissions");

const FIXED_HIRED_AT = "2026-06-01T12:00:00.000Z";
const FIXED_VERSION = "0.1.0";
const FIXED_CLOCK = () => new Date(FIXED_HIRED_AT);

const DEFAULT_ROSTER = [
  "generalist-dev",
  "generalist-reviewer",
  "orchestrator",
  "planner",
  "retro-analyst",
] as const;

// ---------------------------------------------------------------------------
// Fixture helpers
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

afterEach(() => {
  vi.restoreAllMocks();
});

async function makeTmp(prefix: string): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `flow-27-${prefix}-`));
  tmpDirs.push(tmp);
  return tmp;
}

async function hireRoster(
  targetRepoRoot: string,
  roles: readonly string[],
): Promise<void> {
  for (const role of roles) {
    await instantiatePersona({
      pluginRoot: getPluginRoot(),
      targetRepoRoot,
      role,
      clock: FIXED_CLOCK,
      pluginVersion: FIXED_VERSION,
    });
  }
}

// ---------------------------------------------------------------------------
// MCP server factory wired with the real permissions loader (production wiring).
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
  const client = new Client({ name: "ask-skill-test", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return {
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

// ---------------------------------------------------------------------------
// AC4(a) — happy path: prompt assembly for planner (Task 6.4)
// ---------------------------------------------------------------------------
describe("AC4(a) — happy path: assembleAskModePrompt (Task 6.4)", () => {
  let TMP_A: string;

  beforeEach(async () => {
    TMP_A = await makeTmp("tmp-a");
    await hireRoster(TMP_A, DEFAULT_ROSTER);
  });

  it("(i) assembled system prompt contains persona Prompt body verbatim", async () => {
    const persona = await readPersona({ targetRepoRoot: TMP_A, role: "planner" });
    const personaPromptBody = persona.sections.Prompt;
    const question = "explain this verdict comment";

    const systemPrompt = assembleAskModePrompt({ personaPromptBody, question });

    expect(systemPrompt).toContain(personaPromptBody);
    // The persona body appears at the start.
    expect(systemPrompt.startsWith(personaPromptBody)).toBe(true);
  });

  it("(ii) assembled system prompt contains the <ask-mode> block static text", async () => {
    const persona = await readPersona({ targetRepoRoot: TMP_A, role: "planner" });
    const personaPromptBody = persona.sections.Prompt;
    const question = "explain this verdict comment";

    const systemPrompt = assembleAskModePrompt({ personaPromptBody, question });

    // The static parts of the <ask-mode> block must be present.
    expect(systemPrompt).toContain("<ask-mode>");
    expect(systemPrompt).toContain("You are running in /flow:ask mode. This is a non-mutating side-session.");
    expect(systemPrompt).toContain("You MAY read:");
    expect(systemPrompt).toContain("You MUST NOT mutate canonical state.");
    expect(systemPrompt).toContain("</ask-mode>");
  });

  it("(iii) the <question> placeholder is replaced by the actual question text", async () => {
    const persona = await readPersona({ targetRepoRoot: TMP_A, role: "planner" });
    const personaPromptBody = persona.sections.Prompt;
    const question = "what does this reviewer comment mean?";

    const systemPrompt = assembleAskModePrompt({ personaPromptBody, question });

    // The question appears in the assembled prompt.
    expect(systemPrompt).toContain(question);
    // The literal placeholder string `<question>` does NOT appear (it was substituted).
    expect(systemPrompt).not.toContain("Your reply is the operator's one-shot answer to: <question>");
    // The substituted form does appear.
    expect(systemPrompt).toContain(`Your reply is the operator's one-shot answer to: ${question}`);
  });

  it("(iv) assembleAskModePrompt does not mutate the persona file", async () => {
    const persona = await readPersona({ targetRepoRoot: TMP_A, role: "planner" });
    const personaPromptBody = persona.sections.Prompt;
    const personaPath = path.join(TMP_A, "team", "planner", "PERSONA.md");

    const beforeStat = await fs.stat(personaPath);

    assembleAskModePrompt({ personaPromptBody, question: "test question" });

    const afterStat = await fs.stat(personaPath);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it("ASK_MODE_BLOCK_STATIC contains the verbatim block structure (no question substitution)", () => {
    expect(ASK_MODE_BLOCK_STATIC).toContain("<ask-mode>");
    expect(ASK_MODE_BLOCK_STATIC).toContain("</ask-mode>");
    expect(ASK_MODE_BLOCK_STATIC).toContain("You are running in /flow:ask mode.");
    expect(ASK_MODE_BLOCK_STATIC).toContain("You MAY read:");
    expect(ASK_MODE_BLOCK_STATIC).toContain("You MUST NOT mutate canonical state.");
    expect(ASK_MODE_BLOCK_STATIC).toContain("Your reply is the operator's one-shot answer to: <question>");
  });

  it("(i+ii combined) readPersona called path goes through without error for the planner", async () => {
    // Verify readPersona succeeds for the pre-seeded planner.
    const persona = await readPersona({ targetRepoRoot: TMP_A, role: "planner" });
    expect(persona.role).toBe("planner");
    expect(typeof persona.sections.Prompt).toBe("string");
    expect(persona.sections.Prompt.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AC4(b) — gh pr view permitted via ask-mode allowlist (Task 6.5)
// ---------------------------------------------------------------------------
describe("AC4(b) — gh pr view is permitted in ask-mode (Task 6.5)", () => {
  it("gh('pr-view') with ask-mode permissions is NOT refused at the allowlist boundary", async () => {
    const TMP_B = await makeTmp("tmp-b");
    await hireRoster(TMP_B, DEFAULT_ROSTER);

    const permissions = await loadRolePermissions({
      role: "ask-mode",
      pluginRoot: PLUGIN_ROOT,
    });

    // Spy on execa to prevent real subprocess spawn, and to verify the call reaches the boundary.
    const execaSpy = vi.fn(async () => ({
      stdout: "PR #42 body text from fixture",
      stderr: "",
      exitCode: 0,
    }));

    // gh() should NOT throw GhSubcommandDeniedError for pr-view under ask-mode.
    const result = await ghModule.gh({
      role: "ask-mode",
      permissions,
      subcommand: "pr-view",
      args: ["42"],
      execaImpl: execaSpy as never,
    });

    expect(result.stdout).toBe("PR #42 body text from fixture");
    // The execa mock was actually called — pr-view reached the OS-call boundary.
    expect(execaSpy).toHaveBeenCalledTimes(1);
    const callArgs = execaSpy.mock.calls[0]!;
    // First arg is "gh", second is the segments array starting with "pr".
    expect(callArgs[0]).toBe("gh");
    expect(callArgs[1]).toContain("pr");
    expect(callArgs[1]).toContain("view");
  });

  it("ask-mode permissions include pr-view in gh_allow", async () => {
    const permissions = await loadRolePermissions({
      role: "ask-mode",
      pluginRoot: PLUGIN_ROOT,
    });
    expect(permissions.gh_allow).toContain("pr-view");
  });
});

// ---------------------------------------------------------------------------
// AC4(c) — write-refused assertions (Task 6.6)
// ---------------------------------------------------------------------------
describe("AC4(c) — canonical-state mutations are refused under ask-mode (Task 6.6)", () => {
  it("(i) instantiatePersona call with _meta.role=ask-mode returns PermissionDeniedError shape", async () => {
    const TMP_C = await makeTmp("tmp-c");
    await hireRoster(TMP_C, DEFAULT_ROSTER);

    const { client, cleanup } = await makeServerAndClient();

    try {
      const result = await client.request(
        {
          method: "tools/call",
          params: {
            name: "instantiatePersona",
            arguments: { targetRepoRoot: TMP_C, role: "security-specialist" },
            _meta: { role: "ask-mode" },
          },
        },
        CallToolResultSchema,
      );

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]!.type).toBe("text");
      const errMsg = content[0]!.text;

      // Error message names the ask-mode role.
      expect(errMsg).toContain("ask-mode");
      // Error message names the attempted tool.
      expect(errMsg).toContain("instantiatePersona");
      // Error is comprehensible to the subagent (references the permission spec context).
      expect(errMsg).toContain("not allowed");
    } finally {
      await cleanup();
    }
  });

  it("(ii) gh pr-comment with ask-mode permissions throws GhSubcommandDeniedError", async () => {
    const permissions = await loadRolePermissions({
      role: "ask-mode",
      pluginRoot: PLUGIN_ROOT,
    });

    const execaSpy = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));

    await expect(
      ghModule.gh({
        role: "ask-mode",
        permissions,
        subcommand: "pr-comment",
        args: ["42", "--body", "mutating!"],
        execaImpl: execaSpy as never,
      }),
    ).rejects.toThrow(GhSubcommandDeniedError);

    // The execa mock was NOT called — the refusal happened before the OS boundary.
    expect(execaSpy).not.toHaveBeenCalled();
  });

  it("(ii) gh pr-create is refused under ask-mode", async () => {
    const permissions = await loadRolePermissions({
      role: "ask-mode",
      pluginRoot: PLUGIN_ROOT,
    });

    await expect(
      ghModule.gh({
        role: "ask-mode",
        permissions,
        subcommand: "pr-create",
        args: [],
        execaImpl: vi.fn() as never,
      }),
    ).rejects.toThrow(GhSubcommandDeniedError);
  });

  it("(ii) gh pr-review is refused under ask-mode", async () => {
    const permissions = await loadRolePermissions({
      role: "ask-mode",
      pluginRoot: PLUGIN_ROOT,
    });

    await expect(
      ghModule.gh({
        role: "ask-mode",
        permissions,
        subcommand: "pr-review",
        args: [],
        execaImpl: vi.fn() as never,
      }),
    ).rejects.toThrow(GhSubcommandDeniedError);
  });

  it("(iii) synthetic mutating tool is refused under ask-mode via MCP boundary", async () => {
    // Register a synthetic mutator tool to simulate future canonical-state writers.
    const TMP_C2 = await makeTmp("tmp-c2");

    const server = createServer({
      permissionsLoader: async (role) =>
        loadRolePermissions({ role, pluginRoot: PLUGIN_ROOT }),
    });
    registerAllTools(server);

    const syntheticMutatorHandler = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "mutated!" }],
    }));
    server.registerTool({
      name: "syntheticMutateForTest",
      description: "Test-only synthetic mutator to validate ask-mode refusal.",
      inputSchema: { type: "object", properties: {} },
      handler: syntheticMutatorHandler,
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "ask-skill-mut-test", version: "0.0.0" }, { capabilities: {} });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const result = await client.request(
        {
          method: "tools/call",
          params: {
            name: "syntheticMutateForTest",
            arguments: { targetRepoRoot: TMP_C2 },
            _meta: { role: "ask-mode" },
          },
        },
        CallToolResultSchema,
      );

      // The synthetic mutator is NOT in ask-mode's tools_allow, so it must be refused.
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      const errMsg = content[0]!.text;
      expect(errMsg).toContain("ask-mode");
      expect(errMsg).toContain("syntheticMutateForTest");
      // Handler never ran.
      expect(syntheticMutatorHandler).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// AC6 — un-hired-role error surface (Task 6.7)
// ---------------------------------------------------------------------------
describe("AC6 (user-surface) — un-hired-role error surface (Task 6.7)", () => {
  it("formatUnhiredRoleError returns the verbatim AC6 error block", () => {
    const role = "security-specialist";
    const errorText = formatUnhiredRoleError(role);

    const expected = `flow:ask — role "${role}" is not hired in this repo.

Run /flow:hire to hire a project-shaped team (interactive), or /flow:hire default to hire the default roster (planner, generalist-dev, generalist-reviewer, retro-analyst, orchestrator).

If you meant a different role id, run /flow:dashboard to see your current roster.`;

    expect(errorText).toBe(expected);
  });

  it("readPersona throws PersonaFileNotFoundError for un-hired role (no team/ dir)", async () => {
    const TMP_D = await makeTmp("tmp-d-empty");
    // No team/ directory at all.

    await expect(
      readPersona({ targetRepoRoot: TMP_D, role: "security-specialist" }),
    ).rejects.toThrow(PersonaFileNotFoundError);
  });

  it("(d) ac6 diagnostic text matches byte-for-byte for any role token", () => {
    const role = "security-specialist";
    const errorText = formatUnhiredRoleError(role);

    // Byte-for-byte check: the three lines of the AC6 block are present verbatim.
    expect(errorText).toContain(`flow:ask — role "${role}" is not hired in this repo.`);
    expect(errorText).toContain(
      "Run /flow:hire to hire a project-shaped team (interactive), or /flow:hire default to hire the default roster (planner, generalist-dev, generalist-reviewer, retro-analyst, orchestrator).",
    );
    expect(errorText).toContain(
      "If you meant a different role id, run /flow:dashboard to see your current roster.",
    );
  });

  it("(d) + (6.11) task spawn boundary is not reached for un-hired role", () => {
    // The Task spawn boundary is a Claude Code primitive unavailable in vitest.
    // We assert the skill's logical path: formatUnhiredRoleError is called
    // and returns immediately without attempting prompt assembly.
    const role = "does-not-exist";
    const taskSpawnSpy = vi.fn();

    // Simulate skill body logic: if role is not hired, call formatUnhiredRoleError
    // and return without spawning Task.
    function skillBodyLogic(isHired: boolean, role: string): string {
      if (!isHired) {
        return formatUnhiredRoleError(role);
      }
      taskSpawnSpy(); // This would be the Task spawn call.
      return "subagent response";
    }

    const result = skillBodyLogic(false, role);
    expect(taskSpawnSpy).not.toHaveBeenCalled();
    expect(result).toBe(formatUnhiredRoleError(role));
  });
});

// ---------------------------------------------------------------------------
// AC4(e) — tool registration (Task 6.8)
// ---------------------------------------------------------------------------
describe("AC4(e) — tool registration unchanged at 8 tools (Task 6.8)", () => {
  it("MCP server lists exactly 8 tools and no new tool was added by Story 2.7", async () => {
    const server = createServer();
    registerAllTools(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "ac4e-test", version: "0.0.0" }, { capabilities: {} });

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const result = await client.request(
      { method: "tools/list", params: {} },
      ListToolsResultSchema,
    );

    const toolNames = result.tools.map((t) => t.name);

    // The eight Story 2.6 tools plus scanSources from Story 3.2.
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
      expect(toolNames).toContain(name);
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
    // Story native:01KVPSZ14HH48J9NEH7N6S6QDR added matchStorySpecialist + recordSpecialistEngagement (specialist auto-engage) = 65 total.
    // Story native:01KVQSCP87NMRZM0C2CTAF31DJ added refreshPersona (refresh hired persona from catalogue) = 66 total.
    expect(result.tools.length).toBe(66);

    // /flow:ask registers no new MCP tool.
    expect(toolNames).not.toContain("ask");
    expect(toolNames).not.toContain("flowAsk");
    expect(toolNames).not.toContain("askRole");

    await client.close();
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// AC4(f) — ask-mode allowlist shape (Task 6.9)
// ---------------------------------------------------------------------------
describe("AC4(f) — ask-mode allowlist shape (Task 6.9)", () => {
  it("(i) ask-mode.yaml parses against RolePermissionsSchema and role === 'ask-mode'", async () => {
    const askModePath = path.join(PERMISSIONS_DIR, "ask-mode.yaml");
    const raw = await fs.readFile(askModePath, "utf8");
    const parsed = yamlParse(raw);
    const result = RolePermissionsSchema.safeParse(parsed);
    expect(result.success, `RolePermissionsSchema parse failed: ${result.success ? "" : JSON.stringify((result as { error: unknown }).error)}`).toBe(true);
    if (result.success) {
      expect(result.data.role).toBe("ask-mode");
    }
  });

  it("(ii) every tools_allow entry starts with get, read, lookup, or equals heartbeat", async () => {
    const permissions = await loadRolePermissions({
      role: "ask-mode",
      pluginRoot: PLUGIN_ROOT,
    });
    const ALLOWED_PREFIXES = ["get", "read", "lookup"];
    for (const tool of permissions.tools_allow) {
      const isReadShaped =
        ALLOWED_PREFIXES.some((prefix) => tool.startsWith(prefix)) ||
        tool === "heartbeat";
      expect(
        isReadShaped,
        `tools_allow entry '${tool}' does not start with get/read/lookup and is not heartbeat`,
      ).toBe(true);
    }
  });

  it("(iii) gh_allow is exactly ['pr-view']", async () => {
    const permissions = await loadRolePermissions({
      role: "ask-mode",
      pluginRoot: PLUGIN_ROOT,
    });
    expect(permissions.gh_allow).toEqual(["pr-view"]);
  });

  it("(iv) tools_allow does NOT include any canonical-state mutators", async () => {
    const permissions = await loadRolePermissions({
      role: "ask-mode",
      pluginRoot: PLUGIN_ROOT,
    });
    const FORBIDDEN_TOOLS = [
      "instantiatePersona",
      "appendPersonaKnowledge",
      "claimStory",
      "recordVerdict",
      "applyRetroProposal",
      "unhireRole",
    ];
    for (const forbidden of FORBIDDEN_TOOLS) {
      expect(
        permissions.tools_allow,
        `tools_allow must not contain '${forbidden}'`,
      ).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// AC5 — skill self-consistency (Task 6.10)
// ---------------------------------------------------------------------------
describe("AC5 — skill self-consistency: skills/ask/SKILL.md (Task 6.10)", () => {
  it("(i) frontmatter parses and name === 'flow:ask'", async () => {
    const raw = await fs.readFile(SKILL_FILE, "utf8");
    const match = /^---\n([\s\S]*?)\n---/.exec(raw);
    expect(match, "frontmatter delimiters not found").toBeTruthy();
    const frontmatter = yamlParse(match![1]!) as { name: string; allowed_tools: string[] };
    expect(frontmatter.name).toBe("flow:ask");
  });

  it("(ii) allowed_tools deep-equals ['Read', 'Task'] — NO Bash, NO Edit", async () => {
    const raw = await fs.readFile(SKILL_FILE, "utf8");
    const match = /^---\n([\s\S]*?)\n---/.exec(raw);
    const frontmatter = yamlParse(match![1]!) as { allowed_tools: string[] };
    expect(frontmatter.allowed_tools).toEqual(["Read", "Task"]);
    expect(frontmatter.allowed_tools).not.toContain("Bash");
    expect(frontmatter.allowed_tools).not.toContain("Edit");
  });

  it("(iii) body contains required sections in exact order", async () => {
    const raw = await fs.readFile(SKILL_FILE, "utf8");
    const sections = [
      "# What this skill does",
      "# Prerequisites",
      "# Steps",
      "# Failure modes",
    ];
    let lastIdx = 0;
    for (const section of sections) {
      const idx = raw.indexOf(section);
      expect(idx, `missing section: ${section}`).toBeGreaterThan(-1);
      expect(idx, `section out of order: ${section}`).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });

  it("(iv) # Steps section contains readPersona and the verbatim <ask-mode> block start text", async () => {
    const raw = await fs.readFile(SKILL_FILE, "utf8");
    const stepsStart = raw.indexOf("# Steps");
    const stepsEnd = raw.indexOf("\n# ", stepsStart + 1);
    const stepsBody = raw.slice(stepsStart, stepsEnd === -1 ? undefined : stepsEnd);

    expect(stepsBody).toContain("readPersona");
    expect(stepsBody).toContain("<ask-mode>");
    expect(stepsBody).toContain("You are running in /flow:ask mode. This is a non-mutating side-session.");
    expect(stepsBody).toContain("You MUST NOT mutate canonical state.");
  });

  it("(v) body contains /flow:ask, /flow:hire, /flow:hire default, /flow:dashboard cross-links", async () => {
    const raw = await fs.readFile(SKILL_FILE, "utf8");
    expect(raw).toContain("/flow:ask");
    expect(raw).toContain("/flow:hire");
    expect(raw).toContain("/flow:hire default");
    expect(raw).toContain("/flow:dashboard");
  });

  it("(vi) body contains 'non-mutating' and enumerates the four permitted reads", async () => {
    const raw = await fs.readFile(SKILL_FILE, "utf8");

    // FR109's load-bearing word.
    expect(raw).toContain("non-mutating");

    // Four permitted reads per AC3.
    expect(raw).toContain("PR comments");
    expect(raw).toContain("story manifests");
    expect(raw).toContain("persona files");
    expect(raw).toContain("standards");
  });
});
