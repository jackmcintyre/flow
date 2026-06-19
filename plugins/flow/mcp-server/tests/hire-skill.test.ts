/**
 * Story 2.4 AC1–AC5 — `/flow:hire` skill, `readRepoSignals` MCP tool,
 * hiring-manager permission allowlist, integration harness.
 *
 * See `plugins/flow/docs/user-surface-acs.md` for the user-surface AC
 * rubric (Story 1.8 convention). AC1–AC4 are tagged `(user-surface)`;
 * AC5 (this integration harness) is NOT user-surface — operators never
 * type `pnpm --dir plugins/flow test`. The harness asserts the SKILL'S
 * TOOL ORCHESTRATION — which MCP tools are called, with what args, and
 * the persona-file side effects — not LLM conversational behaviour.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { parse as yamlParse } from "yaml";
import { execa } from "execa";
import {
  ListToolsResultSchema,
  CallToolResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { createServer } from "../src/server.js";
import { registerAllTools } from "../src/tools/register.js";
import { readRepoSignals } from "../src/tools/read-repo-signals.js";
import { readCatalogue } from "../src/tools/read-catalogue.js";
import { readPersona } from "../src/tools/read-persona.js";
import * as instantiatePersonaModule from "../src/tools/instantiate-persona.js";
import { getPluginRoot } from "../src/lib/plugin-root.js";
import { parsePersonaFile } from "../src/lib/persona-file.js";
import { parseCatalogueRole } from "../src/lib/markdown-frontmatter.js";
import { loadRolePermissions } from "../src/state/load-role-permissions.js";
import {
  RepoSignalsSchema,
  type RepoSignals,
} from "../src/schemas/repo-signals.js";
import { PersonaAlreadyExistsError } from "../src/errors.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..", "..");

const FIXED_HIRED_AT = "2026-06-01T12:00:00.000Z";
const FIXED_VERSION = "0.1.0";
const FIXED_CLOCK = () => new Date(FIXED_HIRED_AT);

const DEFAULT_ROSTER = [
  "planner",
  "generalist-dev",
  "generalist-reviewer",
  "retro-analyst",
  "orchestrator",
] as const;

const VALID_CONFIG_YAML = `adapter: bmad
adapter_config:
  stories_root: _bmad-output/planning-artifacts/stories
plugin: {}
`;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
} as const;

async function makeTmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `flow-hire-${prefix}-`));
}

async function seedConfig(root: string): Promise<void> {
  await fs.mkdir(path.join(root, ".flow"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".flow", "config.yaml"),
    VALID_CONFIG_YAML,
    "utf8",
  );
}

async function seedFreshFixture(root: string): Promise<void> {
  await seedConfig(root);
  await fs.writeFile(path.join(root, "README.md"), "# Test target repo\n", "utf8");
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "test", version: "0.0.1" }) + "\n",
    "utf8",
  );
  await execa("git", ["init", "-q"], { cwd: root, env: GIT_ENV });
  await execa(
    "git",
    ["commit", "-q", "-m", "init", "--allow-empty"],
    { cwd: root, env: GIT_ENV },
  );
}

const tmpDirs: string[] = [];
afterEach(async () => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try {
      await fs.rm(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

// ---------------------------------------------------------------------------
// In-process subagent stub — simulates the skill's orchestration without
// spawning Claude Code (Task 7.3). It encodes the SAME default-roster
// decision the catalogue prompt body authors, so the test asserts the
// tool-side contract (call counts + side effects), not LLM behaviour.
// ---------------------------------------------------------------------------

type HireResponse =
  | "approve all"
  | "decline"
  | "done"
  | `approve ${string}`
  | `add ${string}`;

interface HireFlowResult {
  signals: RepoSignals;
  currentRoster: Array<{ role: string; domain: string; hired_at: string }>;
  confirmations: string[];
  reentryBlock: string;
  instantiateCalls: string[];
}

async function listExistingRoster(
  targetRepoRoot: string,
): Promise<Array<{ role: string; domain: string; hired_at: string }>> {
  const teamDir = path.join(targetRepoRoot, "team");
  let entries: string[] = [];
  try {
    entries = await fs.readdir(teamDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const roles = entries
    .filter((name) => name !== "custom" && name !== "_archived")
    .filter((name) => !name.startsWith("."))
    .sort();
  const roster: Array<{ role: string; domain: string; hired_at: string }> = [];
  for (const role of roles) {
    const personaFile = path.join(teamDir, role, "PERSONA.md");
    if (!existsSync(personaFile)) continue;
    const persona = await readPersona({ targetRepoRoot, role });
    roster.push({
      role: persona.role,
      domain: persona.domain,
      hired_at: persona.hired_at,
    });
  }
  return roster;
}

async function runHireFlow(opts: {
  targetRepoRoot: string;
  response: HireResponse;
}): Promise<HireFlowResult> {
  const signals = await readRepoSignals({
    targetRepoRoot: opts.targetRepoRoot,
  });
  // The subagent system prompt is the catalogue Prompt section; we call
  // readCatalogue here to mirror the skill's read (and ensure the
  // catalogue is exercised by the harness).
  await readCatalogue({ pluginRoot: getPluginRoot(), role: "hiring-manager" });

  const currentRoster = await listExistingRoster(opts.targetRepoRoot);

  const confirmations: string[] = [];
  const instantiateCalls: string[] = [];
  let reentryBlock = "";

  if (currentRoster.length > 0) {
    // Re-entry mode (AC4). The subagent's first reply lists the existing
    // roster and ends with the verbatim re-entry prompt line.
    const lines = currentRoster.map(
      (r) => `${r.role} — ${r.domain} — hired ${r.hired_at}`,
    );
    const prompt =
      "Hire one more (specify catalogue role id), unhire {role}, view-persona {role}, or done.";
    reentryBlock = ["Currently hired:", "", ...lines, "", prompt].join("\n");

    if (opts.response === "done") {
      // No-op exit.
    } else if (opts.response.startsWith("approve ") || opts.response === "approve all") {
      // Re-entry should not accept approve-all; treat as no-op per AC4.
    } else if (opts.response.startsWith("add ")) {
      const role = opts.response.slice(4);
      const callResult = await callInstantiate(
        opts.targetRepoRoot,
        role,
        instantiateCalls,
        confirmations,
      );
      void callResult;
    }
    return {
      signals,
      currentRoster,
      confirmations,
      reentryBlock,
      instantiateCalls,
    };
  }

  // Fresh-hire mode (AC1–AC3).
  if (opts.response === "decline") {
    confirmations.push(
      "No roles hired. Run /flow:hire again or /flow:hire default to hire the default roster.",
    );
    return {
      signals,
      currentRoster,
      confirmations,
      reentryBlock,
      instantiateCalls,
    };
  }

  if (opts.response === "approve all") {
    for (const role of DEFAULT_ROSTER) {
      await callInstantiate(
        opts.targetRepoRoot,
        role,
        instantiateCalls,
        confirmations,
      );
    }
    return {
      signals,
      currentRoster,
      confirmations,
      reentryBlock,
      instantiateCalls,
    };
  }

  if (opts.response.startsWith("approve ")) {
    const ids = opts.response.slice("approve ".length).split(/\s+/).filter(Boolean);
    for (const role of ids) {
      await callInstantiate(
        opts.targetRepoRoot,
        role,
        instantiateCalls,
        confirmations,
      );
    }
    return {
      signals,
      currentRoster,
      confirmations,
      reentryBlock,
      instantiateCalls,
    };
  }

  if (opts.response.startsWith("add ")) {
    const role = opts.response.slice(4);
    // Validate against the catalogue first per AC3.
    try {
      await readCatalogue({ pluginRoot: getPluginRoot(), role });
    } catch {
      confirmations.push(
        `Unknown catalogue role: ${role}. See plugins/flow/catalogue/ for the v1 roster or use the manual escape hatch under <target-repo>/team/custom/.`,
      );
      return {
        signals,
        currentRoster,
        confirmations,
        reentryBlock,
        instantiateCalls,
      };
    }
    await callInstantiate(
      opts.targetRepoRoot,
      role,
      instantiateCalls,
      confirmations,
    );
    return {
      signals,
      currentRoster,
      confirmations,
      reentryBlock,
      instantiateCalls,
    };
  }

  throw new Error(`harness: unhandled response ${opts.response satisfies never}`);
}

async function callInstantiate(
  targetRepoRoot: string,
  role: string,
  instantiateCalls: string[],
  confirmations: string[],
): Promise<void> {
  instantiateCalls.push(role);
  try {
    const { path: personaPath } = await instantiatePersonaModule.instantiatePersona({
      pluginRoot: getPluginRoot(),
      targetRepoRoot,
      role,
      clock: FIXED_CLOCK,
      pluginVersion: FIXED_VERSION,
    });
    confirmations.push(`Hired: ${role} → ${personaPath}`);
  } catch (err) {
    if (err instanceof PersonaAlreadyExistsError) {
      confirmations.push(`Already hired: ${role} (no change).`);
      return;
    }
    throw err;
  }
}

// ===========================================================================
// AC1 / AC5(a, c) — fresh-empty fixture happy path
// ===========================================================================
describe("Story 2.4 AC1 / AC5(a, c) — fresh-hire happy path", () => {
  it("approve-all writes five default-roster persona files and calls instantiatePersona 5×", async () => {
    const tmp = await makeTmp("ac1");
    tmpDirs.push(tmp);
    await seedFreshFixture(tmp);

    const spy = vi.spyOn(instantiatePersonaModule, "instantiatePersona");

    const result = await runHireFlow({
      targetRepoRoot: tmp,
      response: "approve all",
    });

    // RepoSignals shape and content checks (AC1).
    expect(() => RepoSignalsSchema.parse(result.signals)).not.toThrow();
    expect(result.signals.targetRepoRoot).toBe(tmp);
    expect(result.signals.languages, "AC1 fixture A languages").toContain(
      "TypeScript",
    );
    expect(result.signals.languages).toContain("Markdown");
    expect(result.signals.dependencyManifests).toContain("package.json");
    expect(result.signals.readmeExcerpt).toContain("Test target repo");
    expect(result.signals.recentCommitTitles).toContain("init");

    // Five persona files exist and parse cleanly (AC5(a)).
    for (const role of DEFAULT_ROSTER) {
      const personaPath = path.join(tmp, "team", role, "PERSONA.md");
      const raw = await fs.readFile(personaPath, "utf8");
      const parsed = parsePersonaFile(raw, personaPath);
      expect(parsed.role, `AC5(a) role parity for ${role}`).toBe(role);
    }

    // No specialist hired in fresh-empty fixture.
    for (const specialist of [
      "security-specialist",
      "test-specialist",
      "docs-specialist",
      "debugger",
    ]) {
      expect(
        existsSync(path.join(tmp, "team", specialist, "PERSONA.md")),
        `AC1 no specialist hired: ${specialist}`,
      ).toBe(false);
    }

    // Tool-boundary assertions (AC5(c)).
    expect(result.instantiateCalls.length).toBe(5);
    expect(spy).toHaveBeenCalledTimes(5);
    for (const call of spy.mock.calls) {
      expect((call[0] as { targetRepoRoot: string }).targetRepoRoot).toBe(tmp);
    }
    // Hired confirmation lines count matches calls (AC5(c)).
    const hiredCount = result.confirmations.filter((l) =>
      l.startsWith("Hired: "),
    ).length;
    expect(hiredCount).toBe(spy.mock.calls.length);

    spy.mockRestore();
  });
});

// ===========================================================================
// AC4 / AC5(b, e) — already-hired re-entry
// ===========================================================================
describe("Story 2.4 AC4 / AC5(b, e) — re-entry against existing roster", () => {
  let tmp: string;
  const SEEDED = ["planner", "generalist-dev", "generalist-reviewer"] as const;

  beforeEach(async () => {
    tmp = await makeTmp("ac4");
    tmpDirs.push(tmp);
    await seedConfig(tmp);
    for (const role of SEEDED) {
      await instantiatePersonaModule.instantiatePersona({
        pluginRoot: getPluginRoot(),
        targetRepoRoot: tmp,
        role,
        clock: FIXED_CLOCK,
        pluginVersion: FIXED_VERSION,
      });
    }
  });

  it("done returns the re-entry block, calls instantiatePersona zero times, idempotent on re-run", async () => {
    const spy = vi.spyOn(instantiatePersonaModule, "instantiatePersona");

    const result = await runHireFlow({ targetRepoRoot: tmp, response: "done" });

    // No new hires.
    expect(result.instantiateCalls.length).toBe(0);
    expect(spy).not.toHaveBeenCalled();

    // Re-entry block contains exactly three role lines, each in the
    // pinned `<role> — <domain> — hired <ts>` shape (AC5(b)).
    const roleLineRegex =
      /^([a-z0-9-]+) — (.+?) — hired (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/;
    const matchedRoles = new Set<string>();
    for (const line of result.reentryBlock.split("\n")) {
      const m = roleLineRegex.exec(line);
      if (m) {
        matchedRoles.add(m[1]!);
        expect(m[3]).toBe(FIXED_HIRED_AT);
      }
    }
    expect(matchedRoles.size, `AC5(b) three role lines in re-entry block`).toBe(3);
    for (const seeded of SEEDED) {
      expect(matchedRoles.has(seeded)).toBe(true);
    }

    // Verbatim re-entry prompt line (AC4).
    expect(result.reentryBlock).toContain(
      "Hire one more (specify catalogue role id), unhire {role}, view-persona {role}, or done.",
    );

    // Domain cross-check: domain string in each line equals the catalogue's domain.
    for (const role of SEEDED) {
      const cataloguePath = path.join(PLUGIN_ROOT, "catalogue", `${role}.md`);
      const raw = await fs.readFile(cataloguePath, "utf8");
      const cat = parseCatalogueRole(raw, cataloguePath);
      expect(result.reentryBlock).toContain(
        `${role} — ${cat.domain} — hired ${FIXED_HIRED_AT}`,
      );
    }

    // Re-entry idempotency (AC5(e)).
    const second = await runHireFlow({ targetRepoRoot: tmp, response: "done" });
    expect(second.reentryBlock.trimEnd()).toBe(result.reentryBlock.trimEnd());

    spy.mockRestore();
  });

  it("view-persona returns the catalogue Prompt section byte-for-byte (AC5(b)(iv))", async () => {
    const cataloguePath = path.join(PLUGIN_ROOT, "catalogue", "planner.md");
    const raw = await fs.readFile(cataloguePath, "utf8");
    const cat = parseCatalogueRole(raw, cataloguePath);

    // The view-persona action returns the persona's Prompt section
    // verbatim; persona is a verbatim copy of the catalogue Prompt at
    // hire time (Story 2.3 contract).
    const persona = await readPersona({ targetRepoRoot: tmp, role: "planner" });
    expect(persona.sections.Prompt).toBe(cat.sections.Prompt);
  });
});

// ===========================================================================
// AC3 — add path
// ===========================================================================
describe("Story 2.4 AC3 — add <role> path", () => {
  it("rejects unknown catalogue role with the verbatim error string, no instantiation", async () => {
    const tmp = await makeTmp("ac3-unknown");
    tmpDirs.push(tmp);
    await seedFreshFixture(tmp);

    const spy = vi.spyOn(instantiatePersonaModule, "instantiatePersona");

    const result = await runHireFlow({
      targetRepoRoot: tmp,
      response: "add not-a-real-role",
    });
    expect(spy).not.toHaveBeenCalled();
    expect(result.instantiateCalls.length).toBe(0);
    expect(
      result.confirmations.some((c) =>
        c.startsWith("Unknown catalogue role: not-a-real-role."),
      ),
      `AC3 unknown-role failure line missing — confirmations: ${JSON.stringify(result.confirmations)}`,
    ).toBe(true);

    spy.mockRestore();
  });

  it("add security-specialist instantiates exactly once and writes the persona file", async () => {
    const tmp = await makeTmp("ac3-add");
    tmpDirs.push(tmp);
    await seedFreshFixture(tmp);

    const spy = vi.spyOn(instantiatePersonaModule, "instantiatePersona");

    const result = await runHireFlow({
      targetRepoRoot: tmp,
      response: "add security-specialist",
    });
    expect(result.instantiateCalls).toEqual(["security-specialist"]);
    expect(spy).toHaveBeenCalledTimes(1);
    const personaPath = path.join(
      tmp,
      "team",
      "security-specialist",
      "PERSONA.md",
    );
    expect(existsSync(personaPath), `AC3 specialist persona at ${personaPath}`).toBe(
      true,
    );

    spy.mockRestore();
  });
});

// ===========================================================================
// AC3 — decline path
// ===========================================================================
describe("Story 2.4 AC3 — decline path", () => {
  it("decline emits the No-roles-hired line, no team/ directory created", async () => {
    const tmp = await makeTmp("ac3-decline");
    tmpDirs.push(tmp);
    await seedFreshFixture(tmp);

    const spy = vi.spyOn(instantiatePersonaModule, "instantiatePersona");

    const result = await runHireFlow({ targetRepoRoot: tmp, response: "decline" });
    expect(spy).not.toHaveBeenCalled();
    expect(result.instantiateCalls.length).toBe(0);
    expect(existsSync(path.join(tmp, "team"))).toBe(false);
    expect(result.confirmations).toContain(
      "No roles hired. Run /flow:hire again or /flow:hire default to hire the default roster.",
    );

    spy.mockRestore();
  });
});

// ===========================================================================
// AC5(d) — permission allowlist
// (Updated by Story 2.5 to add readCustomRole — the Story 2.4 contract was
// "the six entries", now seven. Story 2.5's spec AC4(e) is the canonical
// assertion. Updated again by native:01KVFAAPMZWNK8838CMP4SNNC4 to add
// unhirePersona — now eight. We update here to keep the suite consistent
// with the shipped hiring-manager.yaml.)
// ===========================================================================
describe("Story 2.4 AC5(d) — hiring-manager permission allowlist (post-demand-driven: includes readCustomRole + unhirePersona + analyzeTeamFit + readBacklogInventory)", () => {
  it("tools_allow contains exactly the ten expected entries", async () => {
    const perms = await loadRolePermissions({
      pluginRoot: getPluginRoot(),
      role: "hiring-manager",
    });
    expect([...perms.tools_allow].sort()).toEqual(
      [
        "analyzeTeamFit",
        "heartbeat",
        "instantiatePersona",
        "lookupRoleByDomain",
        "readBacklogInventory",
        "readCatalogue",
        "readCustomRole",
        "readPersona",
        "readRepoSignals",
        "unhirePersona",
      ].sort(),
    );
    expect(perms.gh_allow).toEqual([]);
  });
});

// ===========================================================================
// Operator-smoke defect guard — hiring-manager catalogue prompt must tell the
// agent (a) fresh repos have no .flow/config.yaml, (b) stick to the six
// allowlisted tools (no getStatus), (c) treat adapter errors as bugs, not
// reasons to abort. See fix(2.4): tell hiring manager fresh repos have no
// .flow/config.yaml.
// ===========================================================================
describe("Story 2.4 operator-smoke fix — hiring-manager prompt operating constraints", () => {
  it("catalogue Prompt section includes fresh-repo / tool-allowlist / adapter-error guidance", async () => {
    const cataloguePath = path.join(
      PLUGIN_ROOT,
      "catalogue",
      "hiring-manager.md",
    );
    const raw = await fs.readFile(cataloguePath, "utf8");
    const cat = parseCatalogueRole(raw, cataloguePath);
    const prompt = cat.sections.Prompt;

    // (a) Fresh repo without .flow/config.yaml is expected, not an error.
    expect(prompt).toMatch(/\.flow\/config\.yaml/);
    expect(prompt).toMatch(/fresh repo/i);

    // (b) Explicit allowlist enumeration including the seven tools, and an
    // explicit prohibition on calling getStatus.
    for (const tool of [
      "heartbeat",
      "readCatalogue",
      "instantiatePersona",
      "readPersona",
      "lookupRoleByDomain",
      "readRepoSignals",
      "unhirePersona",
    ]) {
      expect(prompt).toContain(tool);
    }
    expect(prompt).toMatch(/getStatus/);
    expect(prompt).toMatch(/Do NOT call `getStatus`/);

    // (c) Adapter-resolution errors are programming bugs, not abort triggers.
    expect(prompt).toMatch(/NoAdapterMatchedError/);
    expect(prompt).toMatch(/programming bug/i);

    // Verbatim phrases from Task 0 of the spec must remain byte-identical.
    expect(prompt).toContain(
      "Approve all, approve a subset (list role ids), decline, or request a specific catalogue role.",
    );
    expect(prompt).toContain(
      "Hire one more (specify catalogue role id), unhire {role}, view-persona {role}, or done.",
    );
    expect(prompt).toContain("Handoff to planner — team hired, ready to plan");
  });

  it("catalogue Prompt section pins re-entry detection and the full default roster", async () => {
    const cataloguePath = path.join(
      PLUGIN_ROOT,
      "catalogue",
      "hiring-manager.md",
    );
    const raw = await fs.readFile(cataloguePath, "utf8");
    const cat = parseCatalogueRole(raw, cataloguePath);
    const prompt = cat.sections.Prompt;

    // Defect 1 — re-entry detection step must reference the literal RE-ENTRY
    // mode marker, the team directory path, and the readPersona tool.
    expect(prompt).toContain("RE-ENTRY mode");
    expect(prompt).toContain("team/<role>/PERSONA.md");
    expect(prompt).toContain("readPersona");

    // Defect 2 — the five default roles must be listed in the exact
    // contractual order, behind an absolute-language marker.
    expect(prompt).toContain("you MUST list ALL FIVE");
    expect(prompt).toContain(
      "planner, generalist-dev, generalist-reviewer, retro-analyst, orchestrator",
    );
  });
});

// ===========================================================================
// Task 7.10 — SKILL.md self-consistency
// ===========================================================================
describe("Story 2.4 Task 7.10 — skills/hire/SKILL.md self-consistency", () => {
  it("frontmatter and required body sections are present in order", async () => {
    const skillPath = path.join(PLUGIN_ROOT, "skills", "hire", "SKILL.md");
    const raw = await fs.readFile(skillPath, "utf8");

    // Frontmatter parse.
    const fmMatch = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
    expect(fmMatch, `skills/hire/SKILL.md frontmatter delimiters`).not.toBeNull();
    const fm = yamlParse(fmMatch![1]!) as {
      name: string;
      description: string;
      allowed_tools: string[];
    };
    expect(fm.name).toBe("flow:hire");
    // Read + Task drive the interactive conversation; readPersona +
    // instantiatePersona drive the `/flow:hire default` fast path (formerly
    // the standalone /flow:skip-hiring skill); analyzeTeamFit is called
    // fail-soft to gather demand-driven fit analysis (Story B).
    expect(fm.allowed_tools).toEqual([
      "Read",
      "Task",
      "readPersona",
      "instantiatePersona",
      "analyzeTeamFit",
    ]);

    // Body sections in order.
    const body = fmMatch![2]!;
    const required = [
      "# What this skill does",
      "# Prerequisites",
      "# Steps",
      "# Failure modes",
    ];
    let cursor = 0;
    for (const heading of required) {
      const idx = body.indexOf(heading, cursor);
      expect(idx, `SKILL.md missing or out-of-order heading: ${heading}`).toBeGreaterThan(
        -1,
      );
      cursor = idx + heading.length;
    }

    // Body references the slash command literal.
    expect(body).toContain("/flow:hire");
  });
});

// ===========================================================================
// Story 2.5 extension — custom-role discovery via /flow:hire
// ===========================================================================
describe("custom-role discovery (Story 2.5 extension)", () => {
  const VALID_CUSTOM_BODY = `---
role: data-scientist
domain: "ml pipeline ownership"
model_tier: sonnet
tools_allow:
  - Read
  - Edit
  - Bash
gh_allow: []
locked_phrases:
  handoff: "Handoff to <next role> — <intent>"
  yield: "This sits in <role>'s domain — handing off"
  verdict: "**Verdict: <SENTINEL>**"
---

# Data scientist

## Domain

Owns the ML pipeline so generalist-dev does not have to learn pandas.

## Mandate

- Author training scripts, model evaluation, and inference glue.

## Out of mandate

- Production deploys (orchestrator owns).

## Prompt

You are the data scientist. Stay terse.
`;

  async function seedCustomRole(root: string): Promise<void> {
    const customDir = path.join(root, "team", "custom");
    await fs.mkdir(customDir, { recursive: true });
    await fs.writeFile(
      path.join(customDir, "data-scientist.md"),
      VALID_CUSTOM_BODY,
      "utf8",
    );
  }

  it("approve all does NOT silently include the custom role; five default hires only", async () => {
    const tmp = await makeTmp("ac-2-5-approve-all");
    tmpDirs.push(tmp);
    await seedFreshFixture(tmp);
    await seedCustomRole(tmp);

    const spy = vi.spyOn(instantiatePersonaModule, "instantiatePersona");

    const result = await runHireFlow({
      targetRepoRoot: tmp,
      response: "approve all",
    });

    // Default roster only — five hires, no data-scientist.
    expect(spy).toHaveBeenCalledTimes(5);
    const hiredRoles = spy.mock.calls.map(
      (c) => (c[0] as { role: string }).role,
    );
    expect(hiredRoles.sort()).toEqual([...DEFAULT_ROSTER].sort());
    expect(hiredRoles).not.toContain("data-scientist");
    expect(result.instantiateCalls).toEqual([...DEFAULT_ROSTER]);
    spy.mockRestore();
  });

  it("explicit approve subset including the custom role calls instantiatePersona six times", async () => {
    const tmp = await makeTmp("ac-2-5-explicit");
    tmpDirs.push(tmp);
    await seedFreshFixture(tmp);
    await seedCustomRole(tmp);

    // Capture the real implementation BEFORE installing the spy, so
    // the fallback path does not recurse into the spy wrapper.
    const realModule = await vi.importActual<typeof instantiatePersonaModule>(
      "../src/tools/instantiate-persona.js",
    );
    const real = realModule.instantiatePersona;
    const spy = vi.spyOn(instantiatePersonaModule, "instantiatePersona");
    // Stub so data-scientist instantiation reads from the custom file
    // (the shipped catalogue has no data-scientist.md). Other roles
    // pass through to the real implementation.
    spy.mockImplementation(async (callOpts) => {
      if (callOpts.role === "data-scientist") {
        const { readCustomRole } = await import(
          "../src/tools/read-custom-role.js"
        );
        const { renderPersonaFile } = await import(
          "../src/lib/persona-file.js"
        );
        const customRole = await readCustomRole({
          targetRepoRoot: callOpts.targetRepoRoot,
          role: callOpts.role,
        });
        const personaPath = path.join(
          callOpts.targetRepoRoot,
          "team",
          callOpts.role,
          "PERSONA.md",
        );
        if (existsSync(personaPath)) {
          throw new PersonaAlreadyExistsError({
            role: callOpts.role,
            personaPath,
          });
        }
        const contents = renderPersonaFile({
          catalogue: customRole,
          hiredAt: FIXED_HIRED_AT,
          catalogueVersion: FIXED_VERSION,
        });
        await fs.mkdir(path.dirname(personaPath), { recursive: true });
        await fs.writeFile(personaPath, contents, "utf8");
        return { path: personaPath };
      }
      return real(callOpts);
    });

    const result = await runHireFlow({
      targetRepoRoot: tmp,
      response:
        "approve planner generalist-dev generalist-reviewer retro-analyst orchestrator data-scientist",
    });

    expect(spy).toHaveBeenCalledTimes(6);
    expect(result.instantiateCalls).toContain("data-scientist");
    for (const call of spy.mock.calls) {
      expect((call[0] as { targetRepoRoot: string }).targetRepoRoot).toBe(tmp);
    }
    expect(
      existsSync(path.join(tmp, "team", "data-scientist", "PERSONA.md")),
    ).toBe(true);
    spy.mockRestore();
  });
});

// ===========================================================================
// Task 7.11 — end-to-end MCP tool listing
// ===========================================================================
describe("Story 2.4 Task 7.11 — readRepoSignals reachable via MCP", () => {
  it("ListTools includes readRepoSignals and CallTool returns RepoSignals-shaped JSON", async () => {
    const tmp = await makeTmp("mcp-e2e");
    tmpDirs.push(tmp);
    await seedFreshFixture(tmp);

    const server = createServer();
    registerAllTools(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "story-2-4-test", version: "0.0.0" },
      { capabilities: {} },
    );
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const list = await client.request(
      { method: "tools/list", params: {} },
      ListToolsResultSchema,
    );
    const names = list.tools.map((t) => t.name);
    expect(names).toContain("readRepoSignals");
    // Story 2.3 tools also present.
    expect(names).toContain("readCatalogue");
    expect(names).toContain("instantiatePersona");
    expect(names).toContain("readPersona");
    expect(names).toContain("lookupRoleByDomain");

    const call = await client.request(
      {
        method: "tools/call",
        params: {
          name: "readRepoSignals",
          arguments: { targetRepoRoot: tmp },
        },
      },
      CallToolResultSchema,
    );
    expect(call.isError).toBeFalsy();
    const block = (call.content as Array<{ type: string; text: string }>)[0]!;
    expect(block.type).toBe("text");
    const parsed = JSON.parse(block.text);
    expect(() => RepoSignalsSchema.parse(parsed)).not.toThrow();
    expect(parsed.targetRepoRoot).toBe(tmp);

    await client.close();
    await server.close();
  });
});
