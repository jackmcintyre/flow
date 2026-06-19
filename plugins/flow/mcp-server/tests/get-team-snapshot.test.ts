/**
 * Story 2.6 AC1–AC4 — getTeamSnapshot MCP tool, renderTeamSnapshot, team
 * skill self-consistency, and tool registration.
 *
 * See `plugins/flow/docs/user-surface-acs.md` for the user-surface AC
 * rubric (Story 1.8 convention). AC1 is tagged `(user-surface)` — the
 * operator types `/flow:team` and reads the printed text block. AC2, AC3,
 * AC4 are NOT user-surface — operators never type `pnpm --dir plugins/flow
 * test`.
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
import {
  ListToolsResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { createServer } from "../src/server.js";
import { registerAllTools } from "../src/tools/register.js";
import { instantiatePersona } from "../src/tools/instantiate-persona.js";
import { getPluginRoot } from "../src/lib/plugin-root.js";
import {
  getTeamSnapshot,
  renderTeamSnapshot,
  extractKnowledgeEntries,
} from "../src/tools/get-team-snapshot.js";
import * as loggerModule from "../src/lib/logger.js";

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
// Catalogue domain values — needed for per-role domain assertions.
// We derive them at test time from readCatalogue rather than hardcoding
// so that future catalogue edits don't silently diverge from the test.
// ---------------------------------------------------------------------------
import { readCatalogue } from "../src/tools/read-catalogue.js";

async function getCatalogueDomains(
  roles: readonly string[],
): Promise<Record<string, string>> {
  const domains: Record<string, string> = {};
  for (const role of roles) {
    const cat = await readCatalogue({ pluginRoot: getPluginRoot(), role });
    domains[role] = cat.domain;
  }
  return domains;
}

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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `flow-26-${prefix}-`));
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

/** Replace the `## Knowledge` section body of an existing persona file. */
async function setKnowledgeBody(
  targetRepoRoot: string,
  role: string,
  knowledgeBody: string,
): Promise<void> {
  const personaPath = path.join(targetRepoRoot, "team", role, "PERSONA.md");
  const raw = await fs.readFile(personaPath, "utf8");

  // Split at the `## Knowledge` heading. Everything after the heading is
  // replaced with the new body.
  const knowledgeHeadingIdx = raw.indexOf("\n## Knowledge");
  if (knowledgeHeadingIdx === -1) {
    throw new Error(`No ## Knowledge section found in ${personaPath}`);
  }
  // Find the end of the `## Knowledge\n` line.
  const headingEnd = raw.indexOf("\n", knowledgeHeadingIdx + 1) + 1;
  const before = raw.slice(0, headingEnd);
  await fs.writeFile(
    personaPath,
    before + "\n" + knowledgeBody + "\n",
    "utf8",
  );
}

function buildAgentInvokeLine(agent: string, ts: string): string {
  return JSON.stringify({
    ts,
    type: "agent.invoke",
    session_id: `session-${agent}`,
    agent,
    data: { runtime_ms: 100 },
  });
}

// ---------------------------------------------------------------------------
// Task 7.3 — AC3(a): hired team + seeded telemetry
// ---------------------------------------------------------------------------
describe("AC3(a) — hired team + seeded telemetry (Task 7.3)", () => {
  let TMP_A: string;
  let catalogueDomains: Record<string, string>;

  beforeEach(async () => {
    TMP_A = await makeTmp("tmp-a");
    await hireRoster(TMP_A, DEFAULT_ROSTER);

    // Seed planner knowledge: four bullets (most-recently-appended is delta).
    await setKnowledgeBody(TMP_A, "planner", "- alpha\n- beta\n- gamma\n- delta");

    // Seed telemetry: generalist-dev:3, generalist-reviewer:2, planner:1, orchestrator:1.
    const telemetryDir = path.join(TMP_A, ".flow", "telemetry");
    await fs.mkdir(telemetryDir, { recursive: true });
    const lines = [
      buildAgentInvokeLine("generalist-dev", "2026-05-01T01:00:00.000Z"),
      buildAgentInvokeLine("generalist-dev", "2026-05-01T02:00:00.000Z"),
      buildAgentInvokeLine("generalist-dev", "2026-05-01T03:00:00.000Z"),
      buildAgentInvokeLine("generalist-reviewer", "2026-05-01T04:00:00.000Z"),
      buildAgentInvokeLine("generalist-reviewer", "2026-05-01T05:00:00.000Z"),
      buildAgentInvokeLine("planner", "2026-05-01T06:00:00.000Z"),
      buildAgentInvokeLine("orchestrator", "2026-05-01T07:00:00.000Z"),
    ];
    await fs.writeFile(
      path.join(telemetryDir, "2026-05.jsonl"),
      lines.join("\n") + "\n",
      "utf8",
    );

    catalogueDomains = await getCatalogueDomains(DEFAULT_ROSTER);
  });

  it("(i) roles.length === 5", async () => {
    const snapshot = await getTeamSnapshot({
      targetRepoRoot: TMP_A,
      knowledgeLimit: 3,
    });
    expect(snapshot.roles.length).toBe(5);
  });

  it("(ii) roles sorted lexicographically", async () => {
    const snapshot = await getTeamSnapshot({
      targetRepoRoot: TMP_A,
      knowledgeLimit: 3,
    });
    const roleIds = snapshot.roles.map((r) => r.role);
    expect(roleIds).toEqual([
      "generalist-dev",
      "generalist-reviewer",
      "orchestrator",
      "planner",
      "retro-analyst",
    ]);
  });

  it("(iii) each role domain matches catalogue", async () => {
    const snapshot = await getTeamSnapshot({
      targetRepoRoot: TMP_A,
      knowledgeLimit: 3,
    });
    for (const role of snapshot.roles) {
      if (role.state === "ok") {
        expect(role.domain).toBe(catalogueDomains[role.role]);
      }
    }
  });

  it("(iv) fire counts match seeded telemetry", async () => {
    const snapshot = await getTeamSnapshot({
      targetRepoRoot: TMP_A,
      knowledgeLimit: 3,
    });
    const byRole = Object.fromEntries(
      snapshot.roles.map((r) => [r.role, r]),
    );
    expect(byRole["generalist-dev"]!.state).toBe("ok");
    if (byRole["generalist-dev"]!.state === "ok") {
      expect(byRole["generalist-dev"]!.fireCount).toBe(3);
    }
    if (byRole["generalist-reviewer"]!.state === "ok") {
      expect(byRole["generalist-reviewer"]!.fireCount).toBe(2);
    }
    if (byRole["planner"]!.state === "ok") {
      expect(byRole["planner"]!.fireCount).toBe(1);
    }
    if (byRole["orchestrator"]!.state === "ok") {
      expect(byRole["orchestrator"]!.fireCount).toBe(1);
    }
    if (byRole["retro-analyst"]!.state === "ok") {
      expect(byRole["retro-analyst"]!.fireCount).toBe(0);
    }
  });

  it("(v) planner knowledge is [delta, gamma, beta] (reverse file order, last 3) — migrated as pattern entries", async () => {
    const snapshot = await getTeamSnapshot({
      targetRepoRoot: TMP_A,
      knowledgeLimit: 3,
    });
    const planner = snapshot.roles.find((r) => r.role === "planner");
    expect(planner?.state).toBe("ok");
    if (planner?.state === "ok") {
      // Flat bullets are migrated to KnowledgeEntry with kind="pattern".
      expect(planner.knowledge).toEqual([
        { kind: "pattern", applies_when: "delta", detail: "delta" },
        { kind: "pattern", applies_when: "gamma", detail: "gamma" },
        { kind: "pattern", applies_when: "beta", detail: "beta" },
      ]);
    }
  });

  it("(vi) other roles have empty knowledge", async () => {
    const snapshot = await getTeamSnapshot({
      targetRepoRoot: TMP_A,
      knowledgeLimit: 3,
    });
    const others = snapshot.roles.filter((r) => r.role !== "planner");
    for (const role of others) {
      if (role.state === "ok") {
        expect(role.knowledge).toEqual([]);
      }
    }
  });

  it("(vii–viii) no malformed telemetry", async () => {
    const snapshot = await getTeamSnapshot({
      targetRepoRoot: TMP_A,
      knowledgeLimit: 3,
    });
    expect(snapshot.malformedTelemetryLines).toBe(0);
    expect(snapshot.malformedTelemetryFiles).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Task 7.4 — AC2 + AC3(a): no telemetry emit by getTeamSnapshot
// ---------------------------------------------------------------------------
describe("AC2 — no telemetry emit by getTeamSnapshot (Task 7.4)", () => {
  it("does not call logTelemetryEvent during getTeamSnapshot", async () => {
    const root = await makeTmp("ac2-no-emit");
    await hireRoster(root, ["planner"] as const);

    // Spy AFTER seeding (seeding calls logTelemetryEvent implicitly? No
    // — instantiatePersona doesn't emit telemetry in v1). Start spy
    // fresh to detect any emission by getTeamSnapshot itself.
    const spy = vi.spyOn(loggerModule, "logTelemetryEvent");

    await getTeamSnapshot({ targetRepoRoot: root });

    expect(spy).not.toHaveBeenCalled();

    // Note: "no Task spawn" cannot be asserted in a unit test because
    // `Task` is a Claude Code primitive, not a Node.js API. The call
    // graph of getTeamSnapshot (readPersona + readTeamTelemetryStats +
    // renderTeamSnapshot) terminates entirely in the MCP server process.
  });
});

// ---------------------------------------------------------------------------
// Task 7.5 — AC3(a): renderer produces byte-identical output
// ---------------------------------------------------------------------------
describe("AC3(a) — renderer byte-identical output (Task 7.5)", () => {
  it("renderTeamSnapshot output matches expected block", async () => {
    const root = await makeTmp("renderer-check");
    await hireRoster(root, DEFAULT_ROSTER);
    await setKnowledgeBody(root, "planner", "- alpha\n- beta\n- gamma\n- delta");

    const telemetryDir = path.join(root, ".flow", "telemetry");
    await fs.mkdir(telemetryDir, { recursive: true });
    const lines = [
      buildAgentInvokeLine("generalist-dev", "2026-05-01T01:00:00.000Z"),
      buildAgentInvokeLine("generalist-dev", "2026-05-01T02:00:00.000Z"),
      buildAgentInvokeLine("generalist-dev", "2026-05-01T03:00:00.000Z"),
      buildAgentInvokeLine("generalist-reviewer", "2026-05-01T04:00:00.000Z"),
      buildAgentInvokeLine("generalist-reviewer", "2026-05-01T05:00:00.000Z"),
      buildAgentInvokeLine("planner", "2026-05-01T06:00:00.000Z"),
      buildAgentInvokeLine("orchestrator", "2026-05-01T07:00:00.000Z"),
    ];
    await fs.writeFile(
      path.join(telemetryDir, "2026-05.jsonl"),
      lines.join("\n") + "\n",
      "utf8",
    );

    const snapshot = await getTeamSnapshot({ targetRepoRoot: root, knowledgeLimit: 3 });
    const output = renderTeamSnapshot(snapshot);

    // Build expected string from the snapshot fields (deterministic).
    const domains = await getCatalogueDomains(DEFAULT_ROSTER);

    const expected = [
      "flow team — 5 role(s)",
      "",
      "generalist-dev",
      `  domain:      ${domains["generalist-dev"]}`,
      "  fire count:  3",
      "  knowledge (last 3):",
      "    (no entries)",
      "",
      "generalist-reviewer",
      `  domain:      ${domains["generalist-reviewer"]}`,
      "  fire count:  2",
      "  knowledge (last 3):",
      "    (no entries)",
      "",
      "orchestrator",
      `  domain:      ${domains["orchestrator"]}`,
      "  fire count:  1",
      "  knowledge (last 3):",
      "    (no entries)",
      "",
      "planner",
      `  domain:      ${domains["planner"]}`,
      "  fire count:  1",
      "  knowledge (last 3):",
      "    - pattern | delta",
      "    - pattern | gamma",
      "    - pattern | beta",
      "",
      "retro-analyst",
      `  domain:      ${domains["retro-analyst"]}`,
      "  fire count:  0",
      "  knowledge (last 3):",
      "    (no entries)",
    ].join("\n");

    expect(output).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Task 7.6 — AC3(b): empty-team fixture
// ---------------------------------------------------------------------------
describe("AC3(b) — empty-team fixture (Task 7.6)", () => {
  it("returns roles.length === 0 and renders empty-state block", async () => {
    const TMP_B = await makeTmp("tmp-b");
    // No team/ directory at all.
    const snapshot = await getTeamSnapshot({ targetRepoRoot: TMP_B });

    expect(snapshot.roles.length).toBe(0);
    expect(snapshot.malformedTelemetryLines).toBe(0);

    const output = renderTeamSnapshot(snapshot);
    const expectedEmpty = [
      "flow team — 0 role(s)",
      "",
      "No hired roles found. Run /flow:hire to hire a project-shaped team, or /flow:hire default to hire the default roster.",
    ].join("\n");

    expect(output).toBe(expectedEmpty);
  });
});

// ---------------------------------------------------------------------------
// Task 7.7 — AC3(c): custom-role hired
// ---------------------------------------------------------------------------
describe("AC3(c) — custom-role hired (Task 7.7)", () => {
  it("includes custom-rooted persona in snapshot lexicographically", async () => {
    const TMP_C = await makeTmp("tmp-c");
    await hireRoster(TMP_C, DEFAULT_ROSTER);

    // Pre-seed the custom data-scientist persona directly (since
    // instantiatePersona's custom path reads from team/custom/<role>.md).
    // We write the persona directly at the expected hire location
    // (team/data-scientist/PERSONA.md), simulating what the hire flow
    // would produce for a custom role.
    const dataSciPersonaDir = path.join(TMP_C, "team", "data-scientist");
    await fs.mkdir(dataSciPersonaDir, { recursive: true });

    // Build a valid persona file for the custom data-scientist role.
    const dataSciPersona = [
      "---",
      "role: data-scientist",
      'domain: "ml pipeline ownership"',
      "model_tier: sonnet",
      "tools_allow:",
      "  - Read",
      "  - Edit",
      "  - Bash",
      "gh_allow: []",
      "locked_phrases:",
      '  handoff: "Handoff to <next role> — <intent>"',
      '  yield: "This sits in <role>\'s domain — handing off"',
      '  verdict: "**Verdict: <SENTINEL>**"',
      `hired_at: ${FIXED_HIRED_AT}`,
      `catalogue_version: ${FIXED_VERSION}`,
      "---",
      "",
      "# Data Scientist",
      "",
      "## Domain",
      "",
      "Owns the ML pipeline so generalist-dev does not have to learn pandas.",
      "",
      "## Mandate",
      "",
      "- Author training scripts.",
      "",
      "## Out of mandate",
      "",
      "- Production deploys.",
      "",
      "## Prompt",
      "",
      "You are the data scientist.",
      "",
      "## Knowledge",
      "",
    ].join("\n");

    await fs.writeFile(
      path.join(dataSciPersonaDir, "PERSONA.md"),
      dataSciPersona,
      "utf8",
    );

    const snapshot = await getTeamSnapshot({ targetRepoRoot: TMP_C });

    const roleIds = snapshot.roles.map((r) => r.role);
    expect(roleIds).toContain("data-scientist");

    // data-scientist starts with 'd', so it comes after nothing in our roster
    // but before generalist-dev ('g'). Verify it's index 0.
    expect(roleIds[0]).toBe("data-scientist");

    // The snapshot does not distinguish custom-rooted from catalogue-rooted
    // personas at render time (Story 2.5 design rationale).
    const dataSciRole = snapshot.roles.find((r) => r.role === "data-scientist");
    expect(dataSciRole?.state).toBe("ok");
    if (dataSciRole?.state === "ok") {
      expect(dataSciRole.domain).toBe("ml pipeline ownership");
    }
  });
});

// ---------------------------------------------------------------------------
// Task 7.8 — AC3(d): malformed telemetry + malformed persona
// ---------------------------------------------------------------------------
describe("AC3(d) — malformed telemetry + malformed persona (Task 7.8)", () => {
  it("surfaces per-role error and annotates malformed telemetry count", async () => {
    const TMP_D = await makeTmp("tmp-d");

    // Only hire planner and generalist-dev.
    await instantiatePersona({
      pluginRoot: getPluginRoot(),
      targetRepoRoot: TMP_D,
      role: "planner",
      clock: FIXED_CLOCK,
      pluginVersion: FIXED_VERSION,
    });
    await instantiatePersona({
      pluginRoot: getPluginRoot(),
      targetRepoRoot: TMP_D,
      role: "generalist-dev",
      clock: FIXED_CLOCK,
      pluginVersion: FIXED_VERSION,
    });

    // Corrupt generalist-dev's PERSONA.md: delete the ## Knowledge heading.
    // This makes parsePersonaFile throw PersonaFileMalformedError.
    const genDevPersonaPath = path.join(
      TMP_D,
      "team",
      "generalist-dev",
      "PERSONA.md",
    );
    let genDevRaw = await fs.readFile(genDevPersonaPath, "utf8");
    genDevRaw = genDevRaw.replace(/\n## Knowledge\n/, "\n");
    await fs.writeFile(genDevPersonaPath, genDevRaw, "utf8");

    // Hand-write telemetry with 5 lines:
    //   2 valid agent.invoke lines (for planner)
    //   2 bad-JSON lines
    //   1 valid-JSON but missing data field (Zod failure)
    const telemetryDir = path.join(TMP_D, ".flow", "telemetry");
    await fs.mkdir(telemetryDir, { recursive: true });
    const validLine1 = JSON.stringify({
      ts: "2026-05-01T01:00:00.000Z",
      type: "agent.invoke",
      session_id: "s1",
      agent: "planner",
      data: { runtime_ms: 100 },
    });
    const validLine2 = JSON.stringify({
      ts: "2026-05-01T02:00:00.000Z",
      type: "agent.invoke",
      session_id: "s2",
      agent: "planner",
      data: { runtime_ms: 200 },
    });
    const badJson1 = "{ bad";
    const badJson2 = "{ bad2";
    // Valid JSON but missing `data` → Zod failure.
    const zodFail = JSON.stringify({
      ts: "2026-05-01T03:00:00.000Z",
      type: "agent.invoke",
      session_id: "s3",
      agent: "planner",
      // missing data field
    });

    await fs.writeFile(
      path.join(telemetryDir, "2026-05.jsonl"),
      [validLine1, validLine2, badJson1, badJson2, zodFail].join("\n") + "\n",
      "utf8",
    );

    const snapshot = await getTeamSnapshot({ targetRepoRoot: TMP_D });

    // (i) roles.length === 2 (planner + generalist-dev).
    expect(snapshot.roles.length).toBe(2);

    // (ii) planner stanza is fully populated.
    const planner = snapshot.roles.find((r) => r.role === "planner");
    expect(planner?.state).toBe("ok");
    if (planner?.state === "ok") {
      expect(planner.fireCount).toBe(2);
    }

    // (iii) generalist-dev stanza has error variant (no domain/fireCount/knowledge).
    const genDev = snapshot.roles.find((r) => r.role === "generalist-dev");
    expect(genDev?.state).toBe("error");
    if (genDev?.state === "error") {
      expect(genDev.error).toBeTruthy();
      expect(typeof genDev.error).toBe("string");
      // The error contains the persona path per PersonaFileMalformedError contract.
      expect(genDev.error).toContain("PERSONA.md");
    }
    // Structural absence: the error variant has only role + error.
    expect((genDev as Record<string, unknown>)?.["domain"]).toBeUndefined();
    expect((genDev as Record<string, unknown>)?.["fireCount"]).toBeUndefined();
    expect((genDev as Record<string, unknown>)?.["knowledge"]).toBeUndefined();

    // (iv) malformedTelemetryLines === 3 (two JSON-parse + one Zod).
    expect(snapshot.malformedTelemetryLines).toBe(3);

    // (v) malformedTelemetryFiles === 1.
    expect(snapshot.malformedTelemetryFiles).toBe(1);

    // Renderer: annotation and per-role error line.
    const rendered = renderTeamSnapshot(snapshot);
    expect(rendered).toContain("(3 malformed telemetry line(s) skipped across 1 file(s))");
    expect(rendered).toContain("  error: ");
  });
});

// ---------------------------------------------------------------------------
// Task 7.9 — AC3(e): tool registration (eight total tools)
// ---------------------------------------------------------------------------
describe("AC3(e) — tool registration (Task 7.9)", () => {
  it("getTeamSnapshot is registered and eight tools total are present", async () => {
    const server = createServer();
    registerAllTools(server);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    const client = new Client(
      { name: "ac3e-test-client", version: "0.0.0" },
      { capabilities: {} },
    );

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const result = await client.request(
      { method: "tools/list", params: {} },
      ListToolsResultSchema,
    );

    const toolNames = result.tools.map((t) => t.name);

    // getTeamSnapshot is present.
    expect(toolNames).toContain("getTeamSnapshot");

    // Prior seven tools still present and ordered correctly.
    const expectedPrior = [
      "getStatus",
      "readCatalogue",
      "instantiatePersona",
      "readPersona",
      "lookupRoleByDomain",
      "readRepoSignals",
      "readCustomRole",
    ];
    for (const name of expectedPrior) {
      expect(toolNames).toContain(name);
    }

    // Thirty-eight total — Story 3.2 added scanSources (9); Story 3.4 added writeNativeStory (10); Story 3.5 added validatePlannerBacklog (11); Story 3.6 added markWithdrawn (12) and readBacklogInventory (13); Story 4.1 added claimStory (14) and completeStory (15); Story 4.2 added mintSessionUlid (16), listClaimableTodos (17), buildPersonaSpawnPrompt (18); Story 4.3 added runDevSession (19); Story 4.3b replaced runDevSession with claimNextStory (19), processDevTranscript (20), processReviewerTranscript (21); Story 4.4 added runDevTerminalAction (22); Story 4.6 added runReviewerSession (23); Story 4.6b added postReviewerComments (24); Story 4.8 added applyReviewerLabels (25); Story 4.12 added recordAgentInvoke (26) and recordPrCloseAction (27); Story 4.11 added processReviewerYield (28); Story 4.9b added classifyRiskTier (29); Story 4.10 added computeAgreement (30); Story 4.10b added runAutoMergeGate (31); Story 1.13 added createSmokeScratchRepo (32); Story 5.11 added scanOrphanedInProgress (33), reattachOrphan (34), blockOrphanNoTranscript (35); Story 6.1 added recordStoryRetro (36); Story 6.3 added writeRetroProposal (37); Story 6.2 added gatherRetroInputs (38). De-cruft 2026-05-30: removed recordAgentInvoke (26) + recordPrCloseAction (27) (unwired dead code) = 36 total. Story 6.4 added acceptProposal = 37 total. Story 9.1 added markStoryReady = 38 total. Story 9.3 added writeLensVerdict + aggregateJudgePanel (judge panel) = 40 total. Story 9.4 added adjudicateQualityLead (Quality Lead) = 41 total. Story 9.5 added getBacklogDashboard (backlog dashboard) = 42 total. Story 6.8 added recordSkillInvoke + computeSkillEffectiveness (skill telemetry) = 44 total. Story 10.5 added bmadToNativeIngest (BMad → native ingest seam) = 45 total. FU2 added resolveLensRoles (deterministic lens→role binding) = 46 total. FU7 added recordAgentFriction (agent friction signal) = 47 total. Story native:01KT484NY4HCBPBTT6VEY1Q0CS added openCycle (cycle boundary) = 48 total. Story native:01KT6GSV8KTTKKHPRGEJWJAGZV added recordReviewerLesson (learning-loop capture) = 49 total. Story native:01KT6QEWY794ZY0DH6JHQFWG6V added recallLesson (on-demand lesson recall) = 50 total.
    // Story native:01KTKJXP6DWN5YHKVG96DH16V0 added classifyStoryLane (pre-judge lane classifier) = 51 total.
    // Story native:01KTKK2Y73EDDAXK470EZ3MHQ8 added resolveJudgePlan (fast-lane judge plan resolver) = 52 total.
    // Story native:01KTKK3HQYNFS1M1ZR9TG02G1F added resolveBuildPlan (fast-lane build plan resolver) = 53 total.
    // Story native:01KTZGEW6TSC6C84P9KJ7FD96S added summariseRetroProposal (retro inline summary) = 54 total.
    // Story native:01KTZKHJ1KDYKGXR20FZ15Y4WB added discardDraft (discard un-built parked draft) = 55 total.
    // Story native:01KT7S0E2 removed bmadToNativeIngest (auditor-confirmed orphan) = 54 total.
    // Story native:01KV7FHZ41Z6CFPABW1B8J38BV added recordMaintainerFeedback (maintainer inbox capture) = 55 total.
    // Story native:01KV9QR3VK11RDD1ZDPVJ7SEYA added reviewMaintainerInbox (on-demand inbox review) = 56 total.
    // Story native:01KVDXX (surface-maintainer-findings-in-run) added dismissMaintainerFeedback (dismiss inbox finding) = 57 total.
    // Story native:01KVEHE5XNBHKVVZ624GPAW9FF added getHelpAdvice (context-aware next-action advisor) = 58 total.
    expect(result.tools.length).toBe(58);

    await client.close();
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// Task 7.10 — AC3(f): no telemetry directory created by getTeamSnapshot
// ---------------------------------------------------------------------------
describe("AC3(f) — no telemetry dir created (Task 7.10)", () => {
  it("does not create .flow/telemetry/ as a side-effect", async () => {
    const TMP_E = await makeTmp("tmp-e");
    // Hire one role so team/ exists.
    await instantiatePersona({
      pluginRoot: getPluginRoot(),
      targetRepoRoot: TMP_E,
      role: "planner",
      clock: FIXED_CLOCK,
      pluginVersion: FIXED_VERSION,
    });

    await getTeamSnapshot({ targetRepoRoot: TMP_E });

    // Telemetry directory must NOT have been created.
    const telemetryDir = path.join(TMP_E, ".flow", "telemetry");
    await expect(fs.access(telemetryDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

// ---------------------------------------------------------------------------
// Task 7.11 — AC3(g): reverse-order regression (three explicit assertions)
// ---------------------------------------------------------------------------
describe("AC3(g) — reverse-order knowledge regression (Task 7.11)", () => {
  it("planner knowledge is delta,gamma,beta — NOT alphabetical and NOT first-N", async () => {
    const root = await makeTmp("tmp-g");
    await hireRoster(root, DEFAULT_ROSTER);
    await setKnowledgeBody(root, "planner", "- alpha\n- beta\n- gamma\n- delta");

    const snapshot = await getTeamSnapshot({ targetRepoRoot: root, knowledgeLimit: 3 });
    const planner = snapshot.roles.find((r) => r.role === "planner");
    expect(planner?.state).toBe("ok");
    if (planner?.state === "ok") {
      // Correct: reverse file order, last 3 — migrated flat bullets as pattern entries.
      expect(planner.knowledge).toEqual([
        { kind: "pattern", applies_when: "delta", detail: "delta" },
        { kind: "pattern", applies_when: "gamma", detail: "gamma" },
        { kind: "pattern", applies_when: "beta", detail: "beta" },
      ]);
      // Wrong: alphabetical order (the applies_when values would be sorted).
      expect(planner.knowledge.map((e) => e.applies_when)).not.toEqual(["alpha", "beta", "delta"]);
      // Wrong: first-N file order.
      expect(planner.knowledge.map((e) => e.applies_when)).not.toEqual(["alpha", "beta", "gamma"]);
    }
  });
});

// ---------------------------------------------------------------------------
// Task 7.12 — AC3(h): lexicographic role order independent of readdir
// ---------------------------------------------------------------------------
describe("AC3(h) — lexicographic order independent of readdir (Task 7.12)", () => {
  it("roles are sorted lexicographically regardless of instantiation order", async () => {
    const TMP_F = await makeTmp("tmp-f");
    // Instantiate in REVERSE of DEFAULT_ROSTER's lexicographic order.
    const reverseOrder = [
      "retro-analyst",
      "planner",
      "orchestrator",
      "generalist-reviewer",
      "generalist-dev",
    ] as const;
    await hireRoster(TMP_F, reverseOrder);

    const snapshot = await getTeamSnapshot({ targetRepoRoot: TMP_F });
    const roleIds = snapshot.roles.map((r) => r.role);
    expect(roleIds).toEqual([
      "generalist-dev",
      "generalist-reviewer",
      "orchestrator",
      "planner",
      "retro-analyst",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Task 7.13 — AC3(i): archived personas excluded
// ---------------------------------------------------------------------------
describe("AC3(i) — archived personas excluded (Task 7.13)", () => {
  it("does not include personas from team/_archived/", async () => {
    const TMP_G = await makeTmp("tmp-g-archived");
    await hireRoster(TMP_G, DEFAULT_ROSTER);

    // Create a persona in team/_archived/old-role/PERSONA.md.
    const archivedDir = path.join(TMP_G, "team", "_archived", "old-role");
    await fs.mkdir(archivedDir, { recursive: true });
    // Copy an existing persona file as the archived one.
    const sourcePath = path.join(TMP_G, "team", "planner", "PERSONA.md");
    await fs.copyFile(sourcePath, path.join(archivedDir, "PERSONA.md"));

    const snapshot = await getTeamSnapshot({ targetRepoRoot: TMP_G });
    const roleIds = snapshot.roles.map((r) => r.role);
    expect(roleIds).not.toContain("old-role");
    expect(snapshot.roles.length).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Task 7.14 — AC3(j): knowledge entry stripping
// ---------------------------------------------------------------------------
describe("AC3(j) — knowledge entry stripping (Task 7.14)", () => {
  it("only top-level bullets count; continuation/sub-bullet lines are excluded", async () => {
    const TMP_H = await makeTmp("tmp-h");
    await instantiatePersona({
      pluginRoot: getPluginRoot(),
      targetRepoRoot: TMP_H,
      role: "planner",
      clock: FIXED_CLOCK,
      pluginVersion: FIXED_VERSION,
    });

    // Four entries with various edge cases.
    const knowledgeBody = [
      "-   entry-with-leading-spaces   ",
      "- entry with continuation",
      "  this is a continuation line that should NOT count",
      "- entry with sub-bullet",
      "  - this is a sub-bullet, also indented — should NOT count as top-level",
      "-    trailing-whitespace-entry    ",
    ].join("\n");

    await setKnowledgeBody(TMP_H, "planner", knowledgeBody);

    const snapshot = await getTeamSnapshot({
      targetRepoRoot: TMP_H,
      knowledgeLimit: 10,
    });
    const planner = snapshot.roles.find((r) => r.role === "planner");
    expect(planner?.state).toBe("ok");
    if (planner?.state === "ok") {
      // Four top-level entries, reverse file order (limit=10 → no truncation).
      // Flat bullets are migrated to KnowledgeEntry with kind="pattern".
      expect(planner.knowledge).toEqual([
        { kind: "pattern", applies_when: "trailing-whitespace-entry", detail: "trailing-whitespace-entry" },
        { kind: "pattern", applies_when: "entry with sub-bullet", detail: "entry with sub-bullet" },
        { kind: "pattern", applies_when: "entry with continuation", detail: "entry with continuation" },
        { kind: "pattern", applies_when: "entry-with-leading-spaces", detail: "entry-with-leading-spaces" },
      ]);
    }
  });

  it("extractKnowledgeEntries strips leading/trailing whitespace from bullet text (migrated to pattern entries)", () => {
    const body = "-   padded   \n- normal\n  continuation\n- last";
    const result = extractKnowledgeEntries(body, 10);
    // All three top-level bullets, reverse order — migrated as pattern KnowledgeEntry objects.
    expect(result).toEqual([
      { kind: "pattern", applies_when: "last", detail: "last" },
      { kind: "pattern", applies_when: "normal", detail: "normal" },
      { kind: "pattern", applies_when: "padded", detail: "padded" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Bug 2 fix — TOCTOU PersonaFileNotFoundError mid-snapshot
// ---------------------------------------------------------------------------
describe("TOCTOU — persona file deleted mid-snapshot completes for remaining roles", () => {
  it("snapshot skips the vanished role and includes surviving roles", async () => {
    const root = await makeTmp("toctou");
    // Hire two roles.
    await hireRoster(root, ["planner", "generalist-dev"] as const);

    // Delete generalist-dev's PERSONA.md to simulate a race between readdir
    // and readPersona.
    await fs.rm(path.join(root, "team", "generalist-dev", "PERSONA.md"));

    // Should not throw — the missing file should be silently skipped.
    const snapshot = await getTeamSnapshot({ targetRepoRoot: root });

    // planner remains; generalist-dev is absent (not errored, just gone).
    expect(snapshot.roles.length).toBe(1);
    const roleIds = snapshot.roles.map((r) => r.role);
    expect(roleIds).toContain("planner");
    expect(roleIds).not.toContain("generalist-dev");
  });
});

// ---------------------------------------------------------------------------
// Task 7.16 — Header + no .only/.todo/.skip
// All tests in this file meet that constraint by construction.
// ---------------------------------------------------------------------------
