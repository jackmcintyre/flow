/**
 * Story 2.5 AC1–AC5 — /flow:skip-hiring fast path, readCustomRole MCP
 * tool, role-invention refusal, custom-role acceptance.
 *
 * See `plugins/flow/docs/user-surface-acs.md` for the user-surface AC
 * rubric (Story 1.8 convention). AC1, AC2, AC3, AC5 are tagged
 * `(user-surface)`; AC4 (this integration harness) is NOT user-surface —
 * operators never type `pnpm --dir plugins/flow test`. The harness
 * asserts the SKILL'S TOOL ORCHESTRATION — which MCP tools are called,
 * with what args, the persona-file side effects, and that the catalogue
 * prompt contains the verbatim role-invention refusal string — not LLM
 * conversational behaviour.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as yamlParse } from "yaml";
import {
  ListToolsResultSchema,
  CallToolResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { createServer } from "../src/server.js";
import { registerAllTools } from "../src/tools/register.js";
import { readCatalogue } from "../src/tools/read-catalogue.js";
import * as readCustomRoleModule from "../src/tools/read-custom-role.js";
import * as instantiatePersonaModule from "../src/tools/instantiate-persona.js";
import { getPluginRoot } from "../src/lib/plugin-root.js";
import { parsePersonaFile } from "../src/lib/persona-file.js";
import { parseCatalogueRole } from "../src/lib/markdown-frontmatter.js";
import { loadRolePermissions } from "../src/state/load-role-permissions.js";
import {
  CatalogueRoleNotFoundError,
  CatalogueShapeError,
  PersonaAlreadyExistsError,
} from "../src/errors.js";

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

const REFUSAL_STRING =
  "I cannot invent roles outside the v1 catalogue. The catalogue is fixed; the manual escape hatch is to author <target-repo>/team/custom/<role>.md matching the catalogue file shape (see plugins/flow/catalogue/planner.md for the canonical example), then re-run /flow:hire.";

const REENTRY_PROMPT =
  "Hire one more (specify catalogue role id), unhire {role}, view-persona {role}, or done.";

const VALID_CUSTOM_ROLE_BODY = `---
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
- Surface dataset shape changes to the planner before the dev loop wakes.

## Out of mandate

- Production deploys (orchestrator owns).
- Reviewing non-ML code (generalist-reviewer owns).

## Prompt

You are the data scientist. Read the dataset, propose the model, train it, evaluate, write the inference glue. Stay terse.
`;

const MALFORMED_CUSTOM_ROLE_BODY = `---
role: broken
domain: "test malformation"
model_tier: sonnet
tools_allow:
  - Read
gh_allow: []
locked_phrases:
  handoff: "Handoff to <next role> — <intent>"
  yield: "This sits in <role>'s domain — handing off"
  verdict: "**Verdict: <SENTINEL>**"
---

# Broken

## Domain

This file is intentionally missing the ## Out of mandate section.

## Mandate

- nothing.

## Prompt

invalid.
`;

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

async function makeTmp(prefix: string): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `crew-25-${prefix}-`));
  tmpDirs.push(tmp);
  return tmp;
}

async function seedConfig(root: string): Promise<void> {
  await fs.mkdir(path.join(root, ".flow"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".flow", "config.yaml"),
    VALID_CONFIG_YAML,
    "utf8",
  );
}

async function writeCustomRoleFile(
  root: string,
  filename: string,
  body: string,
): Promise<string> {
  const customDir = path.join(root, "team", "custom");
  await fs.mkdir(customDir, { recursive: true });
  const filePath = path.join(customDir, filename);
  await fs.writeFile(filePath, body, "utf8");
  return filePath;
}

afterEach(async () => {
  vi.restoreAllMocks();
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
// runSkipHiringFlow — in-process simulation of the /flow:skip-hiring
// skill body (Task 5). Mirrors the contract in skills/skip-hiring/SKILL.md:
//   step 2 — refuse if any role subdir under team/ has a PERSONA.md
//   step 3 — call instantiatePersona for the five default-roster roles
//   step 4 — print the terminal line
// ---------------------------------------------------------------------------

interface SkipHiringResult {
  confirmations: string[];
  instantiateCalls: string[];
  subagentSpawns: number;
}

async function runSkipHiringFlow(opts: {
  targetRepoRoot: string;
}): Promise<SkipHiringResult> {
  const confirmations: string[] = [];
  const instantiateCalls: string[] = [];
  const subagentSpawns = 0;

  // Step 2 — refuse if hired.
  const teamDir = path.join(opts.targetRepoRoot, "team");
  let teamEntries: string[] = [];
  try {
    teamEntries = await fs.readdir(teamDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const roleSubdirs = teamEntries.filter(
    (name) => name !== "custom" && name !== "_archived" && !name.startsWith("."),
  );
  for (const role of roleSubdirs) {
    if (existsSync(path.join(teamDir, role, "PERSONA.md"))) {
      confirmations.push(
        "Team already hired. Run /flow:hire to add more roles, or /flow:team to view the current roster.",
      );
      return { confirmations, instantiateCalls, subagentSpawns };
    }
  }

  // Step 3 — hire default roster in order.
  for (const role of DEFAULT_ROSTER) {
    instantiateCalls.push(role);
    try {
      const { path: personaPath } =
        await instantiatePersonaModule.instantiatePersona({
          pluginRoot: getPluginRoot(),
          targetRepoRoot: opts.targetRepoRoot,
          role,
          clock: FIXED_CLOCK,
          pluginVersion: FIXED_VERSION,
        });
      confirmations.push(`Hired: ${role} → ${personaPath}`);
    } catch (err) {
      if (err instanceof PersonaAlreadyExistsError) {
        confirmations.push(`Already hired: ${role} (no change).`);
        continue;
      }
      throw err;
    }
  }

  // Step 4 — terminal line.
  confirmations.push(
    "Default roster hired (5 roles). Run /flow:team to view, or /flow:hire to add more.",
  );

  return { confirmations, instantiateCalls, subagentSpawns };
}

// ---------------------------------------------------------------------------
// runCustomRoleAddFlow — in-process simulation of the /flow:hire `add
// <role>` path EXTENDED for the custom-role discovery contract (Task 6):
//   - try readCatalogue first
//   - on CatalogueRoleNotFoundError, try readCustomRole
//   - on success, call instantiatePersona with the (custom) suffix in the
//     confirmation line
//   - on CatalogueShapeError from readCustomRole, surface verbatim and
//     do NOT call instantiatePersona
// ---------------------------------------------------------------------------

interface CustomRoleAddResult {
  confirmations: string[];
  instantiateCalls: string[];
}

async function runCustomRoleAddFlow(opts: {
  targetRepoRoot: string;
  response: `add ${string}`;
}): Promise<CustomRoleAddResult> {
  const confirmations: string[] = [];
  const instantiateCalls: string[] = [];

  const role = opts.response.slice("add ".length).trim();

  // Try catalogue first.
  try {
    await readCatalogue({ pluginRoot: getPluginRoot(), role });
    // Catalogue hit — instantiate.
    instantiateCalls.push(role);
    try {
      const { path: personaPath } =
        await instantiatePersonaModule.instantiatePersona({
          pluginRoot: getPluginRoot(),
          targetRepoRoot: opts.targetRepoRoot,
          role,
          clock: FIXED_CLOCK,
          pluginVersion: FIXED_VERSION,
        });
      confirmations.push(`Hired: ${role} → ${personaPath}`);
    } catch (err) {
      if (err instanceof PersonaAlreadyExistsError) {
        confirmations.push(`Already hired: ${role} (no change).`);
      } else {
        throw err;
      }
    }
    return { confirmations, instantiateCalls };
  } catch (err) {
    if (!(err instanceof CatalogueRoleNotFoundError)) throw err;
  }

  // Fall back to custom-role.
  let custom;
  try {
    custom = await readCustomRoleModule.readCustomRole({
      targetRepoRoot: opts.targetRepoRoot,
      role,
    });
  } catch (err) {
    if (err instanceof CatalogueRoleNotFoundError) {
      confirmations.push(
        `Unknown catalogue role: ${role}. See plugins/flow/catalogue/ for the v1 roster or use the manual escape hatch under <target-repo>/team/custom/.`,
      );
      confirmations.push(REENTRY_PROMPT);
      return { confirmations, instantiateCalls };
    }
    if (err instanceof CatalogueShapeError) {
      const customPath = path.join(
        opts.targetRepoRoot,
        "team",
        "custom",
        `${role}.md`,
      );
      confirmations.push(
        `Custom role file at ${customPath} failed validation: ${err.message}`,
      );
      confirmations.push(REENTRY_PROMPT);
      return { confirmations, instantiateCalls };
    }
    throw err;
  }

  // Custom-role hit — instantiate via the same per-role path (NOT team/custom/<role>/).
  void custom;
  instantiateCalls.push(role);
  try {
    const { path: personaPath } =
      await instantiatePersonaModule.instantiatePersona({
        pluginRoot: getPluginRoot(),
        targetRepoRoot: opts.targetRepoRoot,
        role,
        clock: FIXED_CLOCK,
        pluginVersion: FIXED_VERSION,
      });
    confirmations.push(`Hired: ${role} (custom) → ${personaPath}`);
  } catch (err) {
    if (err instanceof PersonaAlreadyExistsError) {
      confirmations.push(`Already hired: ${role} (no change).`);
    } else {
      throw err;
    }
  }
  return { confirmations, instantiateCalls };
}

// Story 2.5 fix (operator-smoke defect): `instantiatePersona` now
// implements custom-first / catalogue-fallback precedence directly —
// it consults `<targetRepoRoot>/team/custom/<role>.md` before the
// shipped catalogue. The AC3 case below therefore drives the REAL
// tool end-to-end (no stub) and asserts the persona file is written
// from the operator-authored source.

// ===========================================================================
// AC1 / AC4(a) — skip-hiring fast path
// ===========================================================================
describe("Story 2.5 AC1 / AC4(a) — /flow:skip-hiring fast path", () => {
  it("hires the five default-roster roles in order with zero subagent spawns", async () => {
    const tmp = await makeTmp("ac1");
    await seedConfig(tmp);

    const spy = vi.spyOn(instantiatePersonaModule, "instantiatePersona");

    const result = await runSkipHiringFlow({ targetRepoRoot: tmp });

    // (i) Five persona files exist.
    for (const role of DEFAULT_ROSTER) {
      const personaPath = path.join(tmp, "team", role, "PERSONA.md");
      expect(existsSync(personaPath), `persona for ${role}`).toBe(true);
      // (ii) Each parses cleanly.
      const raw = await fs.readFile(personaPath, "utf8");
      const parsed = parsePersonaFile(raw, personaPath);
      expect(parsed.role).toBe(role);
    }

    // (iii) No specialist persona exists.
    for (const specialist of [
      "security-specialist",
      "test-specialist",
      "docs-specialist",
      "debugger",
    ]) {
      expect(
        existsSync(path.join(tmp, "team", specialist, "PERSONA.md")),
        `no specialist: ${specialist}`,
      ).toBe(false);
    }

    // (iv) instantiatePersona called exactly five times, all with the same root.
    expect(spy).toHaveBeenCalledTimes(5);
    for (const call of spy.mock.calls) {
      expect((call[0] as { targetRepoRoot: string }).targetRepoRoot).toBe(tmp);
    }
    expect(result.instantiateCalls).toEqual([...DEFAULT_ROSTER]);

    // (v) No subagent was spawned.
    expect(result.subagentSpawns).toBe(0);

    // (vi) Confirmation lines in order + terminal line.
    const hiredLines = result.confirmations.filter((l) => l.startsWith("Hired: "));
    expect(hiredLines.length).toBe(5);
    for (let i = 0; i < DEFAULT_ROSTER.length; i++) {
      const role = DEFAULT_ROSTER[i]!;
      const expected = `Hired: ${role} → ${path.join(tmp, "team", role, "PERSONA.md")}`;
      expect(hiredLines[i]).toBe(expected);
    }
    expect(result.confirmations[result.confirmations.length - 1]).toBe(
      "Default roster hired (5 roles). Run /flow:team to view, or /flow:hire to add more.",
    );
  });

  it("already-hired guard refuses cleanly (no new instantiate calls, terminal cross-ref line)", async () => {
    const tmp = await makeTmp("ac1-guard");
    await seedConfig(tmp);
    // First run hires the default roster.
    await runSkipHiringFlow({ targetRepoRoot: tmp });

    const spy = vi.spyOn(instantiatePersonaModule, "instantiatePersona");
    const second = await runSkipHiringFlow({ targetRepoRoot: tmp });
    expect(spy).not.toHaveBeenCalled();
    expect(second.instantiateCalls.length).toBe(0);
    expect(second.subagentSpawns).toBe(0);
    expect(second.confirmations).toContain(
      "Team already hired. Run /flow:hire to add more roles, or /flow:team to view the current roster.",
    );
  });
});

// ===========================================================================
// AC2 / AC4(b) — role-invention refusal: the contract surface
// ===========================================================================
describe("Story 2.5 AC2 / AC4(b) — role-invention refusal", () => {
  it("hiring-manager catalogue prompt contains the verbatim refusal string and absolute modals", async () => {
    const cat = await readCatalogue({
      pluginRoot: getPluginRoot(),
      role: "hiring-manager",
    });
    const prompt = cat.sections.Prompt;
    // Verbatim refusal string.
    expect(prompt).toContain(REFUSAL_STRING);
    // Absolute-language modals (Story 1.8 hard-pin).
    expect(prompt).toContain("MUST NOT");
    expect(prompt).toContain("NEVER paraphrase");
    // Headings.
    expect(prompt).toContain("### Role-invention prohibition — absolute, not advisory");
    expect(prompt).toContain("### Custom-role discovery — every run, both modes");
  });

  it("'add kubernetes-expert' against a hired team neither calls instantiatePersona nor finds the role", async () => {
    const tmp = await makeTmp("ac2");
    await seedConfig(tmp);
    // Pre-seed five-default-roster persona files.
    for (const role of DEFAULT_ROSTER) {
      await instantiatePersonaModule.instantiatePersona({
        pluginRoot: getPluginRoot(),
        targetRepoRoot: tmp,
        role,
        clock: FIXED_CLOCK,
        pluginVersion: FIXED_VERSION,
      });
    }

    // Catalogue lookup fails for the invented role.
    await expect(
      readCatalogue({ pluginRoot: getPluginRoot(), role: "kubernetes-expert" }),
    ).rejects.toBeInstanceOf(CatalogueRoleNotFoundError);
    // Custom-role lookup also fails (no file authored).
    await expect(
      readCustomRoleModule.readCustomRole({
        targetRepoRoot: tmp,
        role: "kubernetes-expert",
      }),
    ).rejects.toBeInstanceOf(CatalogueRoleNotFoundError);

    const spy = vi.spyOn(instantiatePersonaModule, "instantiatePersona");
    const result = await runCustomRoleAddFlow({
      targetRepoRoot: tmp,
      response: "add kubernetes-expert",
    });
    expect(spy).not.toHaveBeenCalled();
    expect(result.instantiateCalls.length).toBe(0);

    // Harness emits the unknown-role line + re-entry prompt.
    expect(
      result.confirmations.some((c) =>
        c.startsWith("Unknown catalogue role: kubernetes-expert."),
      ),
    ).toBe(true);
    expect(result.confirmations).toContain(REENTRY_PROMPT);
  });
});

// ===========================================================================
// AC3 / AC4(c) — custom-role acceptance
// ===========================================================================
describe("Story 2.5 AC3 / AC4(c) — custom-role acceptance", () => {
  it("'add data-scientist' resolves via readCustomRole, calls instantiatePersona, writes persona at team/<role>/PERSONA.md", async () => {
    const tmp = await makeTmp("ac3");
    await seedConfig(tmp);
    const customPath = await writeCustomRoleFile(
      tmp,
      "data-scientist.md",
      VALID_CUSTOM_ROLE_BODY,
    );

    // No stubbing: post-fix, `instantiatePersona` reads from
    // team/custom/<role>.md first and only falls back to the shipped
    // catalogue. The real catalogue has no `data-scientist.md`, so the
    // tool naturally consults the operator-authored file.
    const readCustomSpy = vi.spyOn(
      readCustomRoleModule,
      "readCustomRole",
    );
    const instantiateSpy = vi.spyOn(
      instantiatePersonaModule,
      "instantiatePersona",
    );

    const result = await runCustomRoleAddFlow({
      targetRepoRoot: tmp,
      response: "add data-scientist",
    });

    // readCustomRole called once with the expected args. (The spy may
    // also see a recursive call from the instantiate-stub helper above —
    // assert the first user-flow call matches.)
    expect(readCustomSpy).toHaveBeenCalled();
    const firstCall = readCustomSpy.mock.calls[0]!;
    expect(firstCall[0]).toEqual({
      targetRepoRoot: tmp,
      role: "data-scientist",
    });
    // instantiatePersona called once for data-scientist.
    const instCalls = instantiateSpy.mock.calls.filter(
      (c) => (c[0] as { role: string }).role === "data-scientist",
    );
    expect(instCalls.length).toBe(1);
    expect(
      (instCalls[0]![0] as { targetRepoRoot: string }).targetRepoRoot,
    ).toBe(tmp);

    // Persona file exists at the catalogue-shaped path.
    const personaPath = path.join(tmp, "team", "data-scientist", "PERSONA.md");
    expect(existsSync(personaPath)).toBe(true);
    // Parses cleanly.
    const personaRaw = await fs.readFile(personaPath, "utf8");
    const persona = parsePersonaFile(personaRaw, personaPath);
    expect(persona.role).toBe("data-scientist");

    // Prompt body equals the custom file's Prompt body byte-for-byte.
    const customRoleParsed = parseCatalogueRole(
      VALID_CUSTOM_ROLE_BODY,
      customPath,
    );
    expect(persona.sections.Prompt).toBe(customRoleParsed.sections.Prompt);

    // Harness confirmation line.
    expect(result.confirmations).toContain(
      `Hired: data-scientist (custom) → ${personaPath}`,
    );

    // Second add → idempotent already-hired line.
    const second = await runCustomRoleAddFlow({
      targetRepoRoot: tmp,
      response: "add data-scientist",
    });
    expect(second.confirmations).toContain(
      "Already hired: data-scientist (no change).",
    );
  });
});

// ===========================================================================
// AC3 / AC4(d) — custom-role parse failure
// ===========================================================================
describe("Story 2.5 AC3 / AC4(d) — custom-role parse failure", () => {
  it("malformed custom file surfaces verbatim diagnostic, no instantiation", async () => {
    const tmp = await makeTmp("ac3d");
    await seedConfig(tmp);
    const brokenPath = await writeCustomRoleFile(
      tmp,
      "broken.md",
      MALFORMED_CUSTOM_ROLE_BODY,
    );

    const readCustomSpy = vi.spyOn(
      readCustomRoleModule,
      "readCustomRole",
    );
    const instantiateSpy = vi.spyOn(
      instantiatePersonaModule,
      "instantiatePersona",
    );

    const result = await runCustomRoleAddFlow({
      targetRepoRoot: tmp,
      response: "add broken",
    });

    expect(readCustomSpy).toHaveBeenCalledWith({
      targetRepoRoot: tmp,
      role: "broken",
    });
    expect(instantiateSpy).not.toHaveBeenCalled();
    expect(existsSync(path.join(tmp, "team", "broken", "PERSONA.md"))).toBe(
      false,
    );

    const diagnostic = result.confirmations.find((c) =>
      c.startsWith(`Custom role file at ${brokenPath} failed validation:`),
    );
    expect(diagnostic, `diagnostic: ${JSON.stringify(result.confirmations)}`)
      .toBeDefined();
  });
});

// ===========================================================================
// AC4(e) — permission allowlist
// ===========================================================================
describe("Story 2.5 AC4(e) — hiring-manager allowlist includes readCustomRole", () => {
  it("tools_allow contains exactly the seven expected entries", async () => {
    const perms = await loadRolePermissions({
      pluginRoot: getPluginRoot(),
      role: "hiring-manager",
    });
    expect([...perms.tools_allow].sort()).toEqual(
      [
        "heartbeat",
        "instantiatePersona",
        "lookupRoleByDomain",
        "readCatalogue",
        "readCustomRole",
        "readPersona",
        "readRepoSignals",
      ].sort(),
    );
    expect(perms.gh_allow).toEqual([]);
  });
});

// ===========================================================================
// AC4(f) — skip-hiring SKILL.md self-consistency
// ===========================================================================
describe("Story 2.5 AC4(f) — skills/skip-hiring/SKILL.md self-consistency", () => {
  it("frontmatter and required body sections are present in order", async () => {
    const skillPath = path.join(
      PLUGIN_ROOT,
      "skills",
      "skip-hiring",
      "SKILL.md",
    );
    const raw = await fs.readFile(skillPath, "utf8");
    const fmMatch = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
    expect(fmMatch).not.toBeNull();
    const fm = yamlParse(fmMatch![1]!) as {
      name: string;
      description: string;
      allowed_tools: string[];
    };
    expect(fm.name).toBe("flow:skip-hiring");
    // (ii) allowed_tools exactly ["Read"] — NO Task.
    expect(fm.allowed_tools).toEqual(["Read"]);

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
      expect(idx, `missing or out-of-order: ${heading}`).toBeGreaterThan(-1);
      cursor = idx + heading.length;
    }

    // (iv) body references /flow:skip-hiring at least once.
    expect(body).toContain("/flow:skip-hiring");
    // (v) body references /flow:hire at least once (cross-link).
    expect(body).toContain("/flow:hire");
  });
});

// ===========================================================================
// Task 7.12 — hiring-manager catalogue post-edit self-consistency
// ===========================================================================
describe("Story 2.5 Task 7.12 — hiring-manager catalogue post-edit self-consistency", () => {
  it("Story 2.4 verbatim strings preserved AND Story 2.5 strings added", async () => {
    const cat = await readCatalogue({
      pluginRoot: getPluginRoot(),
      role: "hiring-manager",
    });
    const prompt = cat.sections.Prompt;

    // Story 2.4 byte-for-byte preserved.
    expect(prompt).toContain(
      "Approve all, approve a subset (list role ids), decline, or request a specific catalogue role.",
    );
    expect(prompt).toContain(REENTRY_PROMPT);
    expect(prompt).toContain("Handoff to planner — team hired, ready to plan");

    // Story 2.5 additions.
    expect(prompt).toContain(REFUSAL_STRING);
    expect(prompt).toContain("MUST NOT");
    expect(prompt).toContain("NEVER paraphrase");
    expect(prompt).toContain(
      "### Role-invention prohibition — absolute, not advisory",
    );
    expect(prompt).toContain(
      "### Custom-role discovery — every run, both modes",
    );
  });
});

// ===========================================================================
// Task 7.13 — end-to-end via MCP
// ===========================================================================
describe("Story 2.5 Task 7.13 — readCustomRole reachable via MCP", () => {
  it("ListTools includes readCustomRole alongside the six prior tools, and CallTool returns parsed JSON", async () => {
    const tmp = await makeTmp("mcp-e2e");
    await seedConfig(tmp);
    await writeCustomRoleFile(
      tmp,
      "data-scientist.md",
      VALID_CUSTOM_ROLE_BODY,
    );

    const server = createServer();
    registerAllTools(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "story-2-5-test", version: "0.0.0" },
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
    // Seven total.
    for (const expected of [
      "getStatus",
      "readCatalogue",
      "instantiatePersona",
      "readPersona",
      "lookupRoleByDomain",
      "readRepoSignals",
      "readCustomRole",
    ]) {
      expect(names, `MCP tool: ${expected}`).toContain(expected);
    }

    const call = await client.request(
      {
        method: "tools/call",
        params: {
          name: "readCustomRole",
          arguments: { targetRepoRoot: tmp, role: "data-scientist" },
        },
      },
      CallToolResultSchema,
    );
    expect(call.isError).toBeFalsy();
    const block = (call.content as Array<{ type: string; text: string }>)[0]!;
    expect(block.type).toBe("text");
    const parsed = JSON.parse(block.text);
    expect(parsed.role).toBe("data-scientist");
    expect(parsed.domain).toBe("ml pipeline ownership");

    await client.close();
    await server.close();
  });
});
