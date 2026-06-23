/**
 * Story 2.3 AC1–AC5 — persona-file machinery and persona MCP tools.
 * Story native:01KVPQDTW1J4JD0DAQAFYPTH2J (AC2, AC3) — capabilities declaration.
 *
 * See `plugins/flow/docs/user-surface-acs.md` for the user-surface AC
 * rubric (Story 1.8 convention). Story 2.3 has zero user-surface ACs —
 * the four MCP tool names are internal and `<target-repo>/team/<role>/
 * PERSONA.md` is not opened by name from the README/install docs.
 *
 * This harness exercises:
 *  - AC1 / AC5(a, b): instantiatePersona writes a parseable persona
 *    file at <target>/team/<role>/PERSONA.md for every catalogue role.
 *  - AC2 / AC5(c): readPersona round-trips frontmatter + body sections.
 *  - AC3 / AC5(d): lookupRoleByDomain exact-matches and returns null
 *    on miss.
 *  - AC4 / AC5(e): a hand-edit under ## Knowledge survives readPersona
 *    (plain-Markdown round-trip, no sidecar state).
 *  - AC5(f): unknown role / re-instantiation surface typed errors.
 *  - Lookup edge cases: stray dirs skipped; malformed personas surface.
 *  - (capabilities AC2) A custom role with a declared capabilities block is
 *    recognised as qualifying for exactly those lenses and jobs.
 *  - (capabilities AC3) A role with no capabilities block still loads and
 *    behaves exactly as today — back-compat is preserved.
 */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import {
  CatalogueRoleNotFoundError,
  PersonaAlreadyExistsError,
  PersonaFileMalformedError,
  UnhireBelowJudgeMinimumError,
} from "../src/errors.js";
import {
  parseCatalogueRole,
  splitFrontmatter,
} from "../src/lib/markdown-frontmatter.js";
import { parsePersonaFile, renderPersonaFile } from "../src/lib/persona-file.js";
import { getPluginRoot } from "../src/lib/plugin-root.js";
import { REQUIRED_PERSONA_SECTIONS } from "../src/schemas/persona.js";
import { instantiatePersona } from "../src/tools/instantiate-persona.js";
import { lookupRoleByDomain } from "../src/tools/lookup-role-by-domain.js";
import { readCatalogue } from "../src/tools/read-catalogue.js";
import { readPersona } from "../src/tools/read-persona.js";
import { refreshPersona } from "../src/tools/refresh-persona.js";
import { unhirePersona } from "../src/tools/unhire-persona.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT_FROM_TEST = path.resolve(HERE, "..", "..");

const CATALOGUE_ROLES = [
  "hiring-manager",
  "planner",
  "generalist-dev",
  "generalist-reviewer",
  "retro-analyst",
  "orchestrator",
  "security-specialist",
  "test-specialist",
  "docs-specialist",
  "debugger",
] as const;

const FIXED_HIRED_AT = "2026-06-01T12:00:00.000Z";
const FIXED_VERSION = "0.1.0";

async function makeTmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `flow-persona-${prefix}-`));
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

describe("Story 2.3 — persona machinery (AC1–AC5)", () => {
  it("getPluginRoot resolves to plugins/flow", () => {
    const root = getPluginRoot();
    expect(root.endsWith(path.join("plugins", "flow"))).toBe(true);
    expect(root).toBe(PLUGIN_ROOT_FROM_TEST);
  });

  describe("AC1 / AC5(a, b) — instantiatePersona for every catalogue role", () => {
    for (const role of CATALOGUE_ROLES) {
      it(`writes a parseable persona at team/${role}/PERSONA.md`, async () => {
        const tmp = await makeTmp(role);
        tmpDirs.push(tmp);

        const { path: personaPath } = await instantiatePersona({
          pluginRoot: getPluginRoot(),
          targetRepoRoot: tmp,
          role,
          clock: () => new Date(FIXED_HIRED_AT),
          pluginVersion: FIXED_VERSION,
        });

        // Path is what the contract promises.
        expect(personaPath).toBe(
          path.join(tmp, "team", role, "PERSONA.md"),
        );

        const raw = await fs.readFile(personaPath, "utf8");
        const persona = parsePersonaFile(raw, personaPath);

        // Frontmatter assertions.
        expect(persona.role).toBe(role);
        expect(persona.hired_at).toBe(FIXED_HIRED_AT);
        expect(persona.catalogue_version).toBe(FIXED_VERSION);

        // Catalogue parity — frontmatter byte-for-byte (modulo persona-
        // only keys).
        const catalogue = await readCatalogue({
          pluginRoot: getPluginRoot(),
          role,
        });
        expect(persona.domain).toBe(catalogue.domain);
        expect(persona.model_tier).toBe(catalogue.model_tier);
        expect(persona.tools_allow).toEqual(catalogue.tools_allow);
        expect(persona.gh_allow).toEqual(catalogue.gh_allow);
        expect(persona.locked_phrases).toEqual(catalogue.locked_phrases);

        // Section parity — Domain / Mandate / Out of mandate / Prompt.
        expect(persona.sections.Domain).toBe(catalogue.sections.Domain);
        expect(persona.sections.Mandate).toBe(catalogue.sections.Mandate);
        expect(persona.sections["Out of mandate"]).toBe(
          catalogue.sections["Out of mandate"],
        );
        expect(persona.sections.Prompt).toBe(catalogue.sections.Prompt);

        // Knowledge is empty at hire time (FR89).
        expect(persona.sections.Knowledge).toBe("");

        // All five required sections present.
        for (const section of REQUIRED_PERSONA_SECTIONS) {
          expect(persona.sections[section]).toBeDefined();
        }
      });
    }
  });

  describe("AC2 / AC5(c) — readPersona round-trips", () => {
    it("returns deep-equal data to the parse of the on-disk file (planner)", async () => {
      const tmp = await makeTmp("rt");
      tmpDirs.push(tmp);

      const { path: personaPath } = await instantiatePersona({
        pluginRoot: getPluginRoot(),
        targetRepoRoot: tmp,
        role: "planner",
        clock: () => new Date(FIXED_HIRED_AT),
        pluginVersion: FIXED_VERSION,
      });

      const viaTool = await readPersona({ targetRepoRoot: tmp, role: "planner" });
      const raw = await fs.readFile(personaPath, "utf8");
      const viaParser = parsePersonaFile(raw, personaPath);

      expect(viaTool).toEqual(viaParser);
      expect(viaTool.sourcePath).toBe(personaPath);
      expect(path.isAbsolute(viaTool.sourcePath)).toBe(true);
    });
  });

  describe("AC3 / AC5(d) — lookupRoleByDomain exact-match", () => {
    it("finds each hired domain and returns null for an unknown domain", async () => {
      const tmp = await makeTmp("lookup");
      tmpDirs.push(tmp);

      const hired = ["planner", "generalist-dev", "generalist-reviewer"] as const;
      for (const role of hired) {
        await instantiatePersona({
          pluginRoot: getPluginRoot(),
          targetRepoRoot: tmp,
          role,
          clock: () => new Date(FIXED_HIRED_AT),
          pluginVersion: FIXED_VERSION,
        });
      }

      for (const role of hired) {
        const catalogue = await readCatalogue({
          pluginRoot: getPluginRoot(),
          role,
        });
        const result = await lookupRoleByDomain({
          targetRepoRoot: tmp,
          domain: catalogue.domain,
        });
        expect(
          result,
          `expected role '${role}' for domain '${catalogue.domain}'`,
        ).toEqual({ role });
      }

      const miss = await lookupRoleByDomain({
        targetRepoRoot: tmp,
        domain: "never-a-real-domain",
      });
      expect(miss).toEqual({ role: null });
    });

    it("returns { role: null } when team/ does not exist", async () => {
      const tmp = await makeTmp("empty");
      tmpDirs.push(tmp);
      const result = await lookupRoleByDomain({
        targetRepoRoot: tmp,
        domain: "anything",
      });
      expect(result).toEqual({ role: null });
    });
  });

  describe("AC4 / AC5(e) — plain-Markdown round-trip after a hand-edit", () => {
    it("readPersona reflects a programmatic edit under ## Knowledge", async () => {
      const tmp = await makeTmp("edit");
      tmpDirs.push(tmp);

      const { path: personaPath } = await instantiatePersona({
        pluginRoot: getPluginRoot(),
        targetRepoRoot: tmp,
        role: "planner",
        clock: () => new Date(FIXED_HIRED_AT),
        pluginVersion: FIXED_VERSION,
      });

      // Simulate an operator editing the file outside the MCP boundary.
      // Plain Markdown owned by the user — `writeManagedFile`'s guard
      // is for in-process agents, not human edits (FR96 / FR97).
      await fs.appendFile(
        personaPath,
        "Always read the discipline rules first.\n",
        "utf8",
      );

      const persona = await readPersona({ targetRepoRoot: tmp, role: "planner" });
      expect(persona.sections.Knowledge).toContain(
        "Always read the discipline rules first.",
      );
    });
  });

  describe("AC5 — end-to-end integration: instantiate, read, lookup, plain-Markdown round-trip", () => {
    it("exercises the full persona lifecycle in a single test (planner)", async () => {
      const tmp = await makeTmp("ac5-e2e");
      tmpDirs.push(tmp);

      // 1) Instantiate.
      const { path: personaPath } = await instantiatePersona({
        pluginRoot: getPluginRoot(),
        targetRepoRoot: tmp,
        role: "planner",
        clock: () => new Date(FIXED_HIRED_AT),
        pluginVersion: FIXED_VERSION,
      });
      expect(personaPath).toBe(path.join(tmp, "team", "planner", "PERSONA.md"));

      // 2) Read.
      const readBack = await readPersona({ targetRepoRoot: tmp, role: "planner" });
      expect(readBack.role).toBe("planner");
      expect(readBack.hired_at).toBe(FIXED_HIRED_AT);
      expect(readBack.catalogue_version).toBe(FIXED_VERSION);
      expect(readBack.sections.Knowledge).toBe("");

      // 3) Lookup by domain.
      const catalogue = await readCatalogue({
        pluginRoot: getPluginRoot(),
        role: "planner",
      });
      const lookup = await lookupRoleByDomain({
        targetRepoRoot: tmp,
        domain: catalogue.domain,
      });
      expect(lookup).toEqual({ role: "planner" });

      // 4) Plain-Markdown round-trip: hand-edit the file, re-read, confirm
      //    the edit is preserved and lookup still resolves.
      await fs.appendFile(
        personaPath,
        "- learned: prefer explicit guard clauses\n",
        "utf8",
      );
      const afterEdit = await readPersona({ targetRepoRoot: tmp, role: "planner" });
      expect(afterEdit.sections.Knowledge).toContain(
        "learned: prefer explicit guard clauses",
      );
      const lookupAfter = await lookupRoleByDomain({
        targetRepoRoot: tmp,
        domain: catalogue.domain,
      });
      expect(lookupAfter).toEqual({ role: "planner" });
    });
  });

  describe("AC5(f) — typed errors on unknown role and re-instantiation", () => {
    it("throws CatalogueRoleNotFoundError for an unknown role", async () => {
      const tmp = await makeTmp("unknown");
      tmpDirs.push(tmp);

      await expect(
        instantiatePersona({
          pluginRoot: getPluginRoot(),
          targetRepoRoot: tmp,
          role: "not-a-real-role",
          clock: () => new Date(FIXED_HIRED_AT),
          pluginVersion: FIXED_VERSION,
        }),
      ).rejects.toBeInstanceOf(CatalogueRoleNotFoundError);

      try {
        await instantiatePersona({
          pluginRoot: getPluginRoot(),
          targetRepoRoot: tmp,
          role: "not-a-real-role",
          clock: () => new Date(FIXED_HIRED_AT),
          pluginVersion: FIXED_VERSION,
        });
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(CatalogueRoleNotFoundError);
        const e = err as CatalogueRoleNotFoundError;
        expect(e.role).toBe("not-a-real-role");
        // Error message names BOTH checked paths (Story 2.5 fix).
        expect(e.message).toContain(
          path.join(tmp, "team", "custom", "not-a-real-role.md"),
        );
        expect(e.message).toContain(
          path.join(getPluginRoot(), "catalogue", "not-a-real-role.md"),
        );
      }
    });

    it("throws PersonaAlreadyExistsError on second instantiation of same role", async () => {
      const tmp = await makeTmp("dup");
      tmpDirs.push(tmp);

      const first = await instantiatePersona({
        pluginRoot: getPluginRoot(),
        targetRepoRoot: tmp,
        role: "planner",
        clock: () => new Date(FIXED_HIRED_AT),
        pluginVersion: FIXED_VERSION,
      });

      try {
        await instantiatePersona({
          pluginRoot: getPluginRoot(),
          targetRepoRoot: tmp,
          role: "planner",
          clock: () => new Date(FIXED_HIRED_AT),
          pluginVersion: FIXED_VERSION,
        });
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(PersonaAlreadyExistsError);
        const e = err as PersonaAlreadyExistsError;
        expect(e.role).toBe("planner");
        expect(e.personaPath).toBe(first.path);
      }
    });
  });

  describe("Story 2.5 fix — instantiatePersona honours team/custom/ precedence", () => {
    const CUSTOM_ROLE_BODY = `---
role: data-scientist
domain: "ml pipeline ownership"
model_tier: sonnet
tools_allow:
  - Read
  - Edit
gh_allow: []
locked_phrases:
  handoff: "Handoff to <next role> — <intent>"
  yield: "This sits in <role>'s domain — handing off"
  verdict: "**Verdict: <SENTINEL>**"
---

# Data scientist

## Domain

Owns the ML pipeline.

## Mandate

- Author training scripts.

## Out of mandate

- Production deploys.

## Prompt

You are the data scientist.
`;

    const CUSTOM_PLANNER_BODY = `---
role: planner
domain: "custom planner override"
model_tier: sonnet
tools_allow:
  - Read
gh_allow: []
locked_phrases:
  handoff: "Handoff to <next role> — <intent>"
  yield: "This sits in <role>'s domain — handing off"
  verdict: "**Verdict: <SENTINEL>**"
---

# Planner

## Domain

custom planner override

## Mandate

- Custom mandate body.

## Out of mandate

- Custom out-of-mandate body.

## Prompt

Custom prompt body for the operator's planner override.
`;

    async function writeCustom(
      root: string,
      filename: string,
      body: string,
    ): Promise<void> {
      const dir = path.join(root, "team", "custom");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, filename), body, "utf8");
    }

    it("uses team/custom/<role>.md when only the custom file exists", async () => {
      const tmp = await makeTmp("custom-only");
      tmpDirs.push(tmp);
      await writeCustom(tmp, "data-scientist.md", CUSTOM_ROLE_BODY);

      const { path: personaPath } = await instantiatePersona({
        pluginRoot: getPluginRoot(),
        targetRepoRoot: tmp,
        role: "data-scientist",
        clock: () => new Date(FIXED_HIRED_AT),
        pluginVersion: FIXED_VERSION,
      });

      expect(personaPath).toBe(
        path.join(tmp, "team", "data-scientist", "PERSONA.md"),
      );
      const persona = parsePersonaFile(
        await fs.readFile(personaPath, "utf8"),
        personaPath,
      );
      expect(persona.role).toBe("data-scientist");
      expect(persona.domain).toBe("ml pipeline ownership");
      expect(persona.sections.Prompt.trim()).toBe(
        "You are the data scientist.",
      );
    });

    it("uses plugin catalogue when only the catalogue file exists (existing behaviour preserved)", async () => {
      const tmp = await makeTmp("catalogue-only");
      tmpDirs.push(tmp);

      const { path: personaPath } = await instantiatePersona({
        pluginRoot: getPluginRoot(),
        targetRepoRoot: tmp,
        role: "planner",
        clock: () => new Date(FIXED_HIRED_AT),
        pluginVersion: FIXED_VERSION,
      });

      const persona = parsePersonaFile(
        await fs.readFile(personaPath, "utf8"),
        personaPath,
      );
      const catalogue = await readCatalogue({
        pluginRoot: getPluginRoot(),
        role: "planner",
      });
      expect(persona.role).toBe("planner");
      expect(persona.domain).toBe(catalogue.domain);
      expect(persona.sections.Prompt).toBe(catalogue.sections.Prompt);
    });

    it("custom takes precedence over catalogue when both exist (regression guard)", async () => {
      const tmp = await makeTmp("custom-wins");
      tmpDirs.push(tmp);
      await writeCustom(tmp, "planner.md", CUSTOM_PLANNER_BODY);

      const { path: personaPath } = await instantiatePersona({
        pluginRoot: getPluginRoot(),
        targetRepoRoot: tmp,
        role: "planner",
        clock: () => new Date(FIXED_HIRED_AT),
        pluginVersion: FIXED_VERSION,
      });

      const persona = parsePersonaFile(
        await fs.readFile(personaPath, "utf8"),
        personaPath,
      );
      const shippedCatalogue = await readCatalogue({
        pluginRoot: getPluginRoot(),
        role: "planner",
      });
      // Custom source wins.
      expect(persona.domain).toBe("custom planner override");
      expect(persona.sections.Prompt.trim()).toBe(
        "Custom prompt body for the operator's planner override.",
      );
      // And differs from the shipped catalogue (sanity).
      expect(persona.domain).not.toBe(shippedCatalogue.domain);
      expect(persona.sections.Prompt).not.toBe(shippedCatalogue.sections.Prompt);
    });
  });

  describe("lookup edge cases", () => {
    it("silently skips a stray empty role directory with no PERSONA.md", async () => {
      const tmp = await makeTmp("stray");
      tmpDirs.push(tmp);

      await instantiatePersona({
        pluginRoot: getPluginRoot(),
        targetRepoRoot: tmp,
        role: "planner",
        clock: () => new Date(FIXED_HIRED_AT),
        pluginVersion: FIXED_VERSION,
      });

      await fs.mkdir(path.join(tmp, "team", "empty-role"), { recursive: true });

      const miss = await lookupRoleByDomain({
        targetRepoRoot: tmp,
        domain: "never-a-real-domain",
      });
      expect(miss).toEqual({ role: null });

      const planner = await readCatalogue({
        pluginRoot: getPluginRoot(),
        role: "planner",
      });
      const hit = await lookupRoleByDomain({
        targetRepoRoot: tmp,
        domain: planner.domain,
      });
      expect(hit).toEqual({ role: "planner" });
    });

    it("propagates PersonaFileMalformedError when a persona file is corrupt", async () => {
      const tmp = await makeTmp("malformed");
      tmpDirs.push(tmp);

      const brokenDir = path.join(tmp, "team", "broken-role");
      await fs.mkdir(brokenDir, { recursive: true });
      // Truncated frontmatter — missing closing '---'.
      await fs.appendFile(
        path.join(brokenDir, "PERSONA.md"),
        "---\nrole: broken-role\n",
        "utf8",
      );

      await expect(
        lookupRoleByDomain({
          targetRepoRoot: tmp,
          domain: "anything",
        }),
      ).rejects.toBeInstanceOf(PersonaFileMalformedError);
    });

    it("filters out team/custom and team/_archived", async () => {
      const tmp = await makeTmp("filter");
      tmpDirs.push(tmp);

      await instantiatePersona({
        pluginRoot: getPluginRoot(),
        targetRepoRoot: tmp,
        role: "planner",
        clock: () => new Date(FIXED_HIRED_AT),
        pluginVersion: FIXED_VERSION,
      });

      // Plant decoys — these directories must not be walked by the lookup.
      await fs.mkdir(path.join(tmp, "team", "custom"), { recursive: true });
      await fs.appendFile(
        path.join(tmp, "team", "custom", "broken.md"),
        "not a persona file",
        "utf8",
      );
      await fs.mkdir(path.join(tmp, "team", "_archived", "old-role"), {
        recursive: true,
      });
      await fs.appendFile(
        path.join(tmp, "team", "_archived", "old-role", "PERSONA.md"),
        "not parsed because the dir is skipped",
        "utf8",
      );

      const planner = await readCatalogue({
        pluginRoot: getPluginRoot(),
        role: "planner",
      });
      const hit = await lookupRoleByDomain({
        targetRepoRoot: tmp,
        domain: planner.domain,
      });
      expect(hit).toEqual({ role: "planner" });
    });
  });

  describe("schema sanity", () => {
    it("rejects a malformed hired_at (no Z suffix)", async () => {
      const tmp = await makeTmp("badts");
      tmpDirs.push(tmp);

      // Build a persona file by hand with a bad timestamp.
      const personaPath = path.join(tmp, "team", "planner", "PERSONA.md");
      await fs.mkdir(path.dirname(personaPath), { recursive: true });
      const bad = [
        "---",
        "role: planner",
        'domain: "x"',
        "model_tier: sonnet",
        "tools_allow:",
        "  - Read",
        "gh_allow: []",
        "locked_phrases:",
        '  handoff: "h"',
        '  yield: "y"',
        '  verdict: "v"',
        "hired_at: 2026-06-01T12:00:00",
        "catalogue_version: 0.1.0",
        "---",
        "",
        "# Planner",
        "## Domain",
        "x",
        "## Mandate",
        "x",
        "## Out of mandate",
        "x",
        "## Prompt",
        "x",
        "## Knowledge",
        "",
      ].join("\n");
      await fs.appendFile(personaPath, bad, "utf8");

      await expect(
        readPersona({ targetRepoRoot: tmp, role: "planner" }),
      ).rejects.toBeInstanceOf(PersonaFileMalformedError);
    });

    it("rejects a persona file missing the Knowledge section", async () => {
      const tmp = await makeTmp("nok");
      tmpDirs.push(tmp);

      const planner = await readCatalogue({
        pluginRoot: getPluginRoot(),
        role: "planner",
      });
      const personaPath = path.join(tmp, "team", "planner", "PERSONA.md");
      await fs.mkdir(path.dirname(personaPath), { recursive: true });
      const noKnowledge = [
        "---",
        "role: planner",
        `domain: ${JSON.stringify(planner.domain)}`,
        "model_tier: sonnet",
        "tools_allow:",
        "  - Read",
        "gh_allow: []",
        "locked_phrases:",
        '  handoff: "h"',
        '  yield: "y"',
        '  verdict: "v"',
        "hired_at: 2026-06-01T12:00:00.000Z",
        "catalogue_version: 0.1.0",
        "---",
        "",
        "# Planner",
        "## Domain",
        "x",
        "## Mandate",
        "x",
        "## Out of mandate",
        "x",
        "## Prompt",
        "x",
        "",
      ].join("\n");
      await fs.appendFile(personaPath, noKnowledge, "utf8");

      await expect(
        readPersona({ targetRepoRoot: tmp, role: "planner" }),
      ).rejects.toBeInstanceOf(PersonaFileMalformedError);
    });
  });

  describe("parseCatalogueRole comparison sanity", () => {
    it("catalogue files parse via readCatalogue for the full roster", async () => {
      for (const role of CATALOGUE_ROLES) {
        const catalogue = await readCatalogue({
          pluginRoot: getPluginRoot(),
          role,
        });
        // Sanity check the parse vs raw file shape.
        const raw = await fs.readFile(
          path.join(getPluginRoot(), "catalogue", `${role}.md`),
          "utf8",
        );
        const reparsed = parseCatalogueRole(raw, "<inline>");
        expect(reparsed.role).toBe(catalogue.role);
        expect(reparsed.domain).toBe(catalogue.domain);
      }
    });
  });

  /**
   * Story native:01KVPQDTW1J4JD0DAQAFYPTH2J AC2 — authored capabilities are
   * recognised when the team reads the role.
   *
   * A custom role definition that declares specific review lenses and run jobs is
   * hired into a team, then read back. The read result must carry those exact
   * capabilities, proving the declaration round-trips through the persona machinery.
   */
  describe("(capabilities AC2) authored capabilities block is recognised on readPersona", () => {
    const CUSTOM_ROLE_WITH_CAPABILITIES = `---
role: ml-analyst
domain: "ml pipeline and model evaluation"
model_tier: sonnet
tools_allow:
  - Read
  - Edit
gh_allow: []
locked_phrases:
  handoff: "Handoff to <next role> — analysis complete"
  yield: "This sits in <domain>'s domain — handing off."
  verdict: "**Verdict: <SENTINEL>**"
capabilities:
  review_lenses:
    - domain
    - considered
  run_jobs:
    - build
---

# Ml Analyst

## Domain

Owns ML pipeline evaluation and model quality checks.

## Mandate

- Analyse model metrics and surface regressions.
- Review pipeline changes against the domain model.

## Out of mandate

- Production deploys.

## Prompt

You are the ML analyst. Read the model output, surface regressions, evaluate pipeline changes.
`;

    it("instantiates a custom role with capabilities and reads them back exactly", async () => {
      const tmp = await makeTmp("cap-ac2");
      tmpDirs.push(tmp);

      // Write the custom role file into team/custom/.
      const customDir = path.join(tmp, "team", "custom");
      await fs.mkdir(customDir, { recursive: true });
      await fs.writeFile(
        path.join(customDir, "ml-analyst.md"),
        CUSTOM_ROLE_WITH_CAPABILITIES,
        "utf8",
      );

      // Hire the role.
      const { path: personaPath } = await instantiatePersona({
        pluginRoot: getPluginRoot(),
        targetRepoRoot: tmp,
        role: "ml-analyst",
        clock: () => new Date(FIXED_HIRED_AT),
        pluginVersion: FIXED_VERSION,
      });

      // Read the persona back.
      const persona = await readPersona({ targetRepoRoot: tmp, role: "ml-analyst" });

      // The capabilities block must be present and exactly match what was declared.
      expect(
        persona.capabilities,
        "capabilities should be present on the hired persona",
      ).toBeDefined();
      expect([...(persona.capabilities?.review_lenses ?? [])].sort()).toEqual(
        ["considered", "domain"],
      );
      expect([...(persona.capabilities?.run_jobs ?? [])].sort()).toEqual(["build"]);

      // The persona path is where the contract promises.
      expect(personaPath).toBe(path.join(tmp, "team", "ml-analyst", "PERSONA.md"));
    });
  });

  /**
   * Story native:01KVPQDTW1J4JD0DAQAFYPTH2J AC3 — a capabilities-free role
   * definition still loads and behaves identically to today.
   *
   * A custom role with NO capabilities block is hired and read back. The persona
   * must load successfully, all existing fields must be intact, and `capabilities`
   * must be `undefined` — nothing is injected or implied by the absence.
   */
  describe("(capabilities AC3) capabilities-free role loads and behaves exactly as today", () => {
    const CUSTOM_ROLE_WITHOUT_CAPABILITIES = `---
role: data-engineer
domain: "data pipeline and ETL design"
model_tier: sonnet
tools_allow:
  - Read
  - Edit
  - Bash
gh_allow: []
locked_phrases:
  handoff: "Handoff to <next role> — pipeline designed"
  yield: "This sits in <domain>'s domain — handing off."
  verdict: "**Verdict: <SENTINEL>**"
---

# Data Engineer

## Domain

Designs and reviews ETL pipelines and data infrastructure.

## Mandate

- Author pipeline specs and transformation logic.
- Review data-adjacent PRs for correctness.

## Out of mandate

- ML model training.

## Prompt

You are the data engineer. Design pipelines, review data-adjacent code, keep the ETL clean.
`;

    it("loads a capabilities-free custom role with no capabilities field on the parsed result", async () => {
      const tmp = await makeTmp("cap-ac3-load");
      tmpDirs.push(tmp);

      const customDir = path.join(tmp, "team", "custom");
      await fs.mkdir(customDir, { recursive: true });
      await fs.writeFile(
        path.join(customDir, "data-engineer.md"),
        CUSTOM_ROLE_WITHOUT_CAPABILITIES,
        "utf8",
      );

      const { path: personaPath } = await instantiatePersona({
        pluginRoot: getPluginRoot(),
        targetRepoRoot: tmp,
        role: "data-engineer",
        clock: () => new Date(FIXED_HIRED_AT),
        pluginVersion: FIXED_VERSION,
      });

      const persona = await readPersona({
        targetRepoRoot: tmp,
        role: "data-engineer",
      });

      // Existing fields load correctly.
      expect(persona.role).toBe("data-engineer");
      expect(persona.domain).toBe("data pipeline and ETL design");
      expect(persona.model_tier).toBe("sonnet");
      expect(persona.hired_at).toBe(FIXED_HIRED_AT);
      expect(persona.catalogue_version).toBe(FIXED_VERSION);
      expect(persona.sections.Domain.length).toBeGreaterThan(0);
      expect(persona.sections.Mandate.length).toBeGreaterThan(0);
      expect(persona.sections["Out of mandate"].length).toBeGreaterThan(0);
      expect(persona.sections.Prompt.length).toBeGreaterThan(0);

      // capabilities is absent — undefined, never an empty default.
      expect(persona.capabilities).toBeUndefined();

      // sourcePath is stamped correctly.
      expect(personaPath).toBe(path.join(tmp, "team", "data-engineer", "PERSONA.md"));
    });

    it("parseCatalogueRole accepts a capabilities-free role file without change", () => {
      // This guards the back-compat contract for future roles that may omit capabilities.
      // The schema change must not break any existing role loader that has no capabilities block.
      const parsed = parseCatalogueRole(
        CUSTOM_ROLE_WITHOUT_CAPABILITIES,
        "/fake/data-engineer.md",
      );

      expect(parsed.role).toBe("data-engineer");
      expect(parsed.domain).toBe("data pipeline and ETL design");
      expect(parsed.capabilities).toBeUndefined();
      // All four sections present and non-empty — behaviour identical to before.
      expect(parsed.sections.Domain.length).toBeGreaterThan(0);
      expect(parsed.sections.Mandate.length).toBeGreaterThan(0);
      expect(parsed.sections["Out of mandate"].length).toBeGreaterThan(0);
      expect(parsed.sections.Prompt.length).toBeGreaterThan(0);
    });
  });

  /**
   * Story native:01KVS0YFNNFWFDP2EJT10FMV08 AC1 — refreshPersona re-materialises
   * catalogue-derived content while preserving hired_at and the accrued Knowledge
   * section.
   */
  describe("Story native:01KVS0YFNNFWFDP2EJT10FMV08 AC1 — refreshPersona preserves hired_at and Knowledge", () => {
    it("re-materialises a stale persona from the catalogue while preserving hired_at and Knowledge", async () => {
      const tmp = await makeTmp("refresh-ac1");
      tmpDirs.push(tmp);

      const ORIGINAL_HIRED_AT = "2026-01-15T08:00:00.000Z";

      // 1) Hire the planner role.
      const { path: personaPath } = await instantiatePersona({
        pluginRoot: getPluginRoot(),
        targetRepoRoot: tmp,
        role: "planner",
        clock: () => new Date(ORIGINAL_HIRED_AT),
        pluginVersion: "0.0.9",
      });

      // 2) Simulate accrued knowledge by appending to the Knowledge section.
      const accrued = "- learned: always check the spec before coding\n- learned: run tests locally first\n";
      await fs.appendFile(personaPath, accrued, "utf8");

      // Confirm knowledge is present before refresh.
      const before = await readPersona({ targetRepoRoot: tmp, role: "planner" });
      expect(before.sections.Knowledge).toContain("always check the spec before coding");
      expect(before.hired_at).toBe(ORIGINAL_HIRED_AT);

      // 3) Refresh the persona (simulates catalogue update — capabilities now present).
      const result = await refreshPersona({
        pluginRoot: getPluginRoot(),
        targetRepoRoot: tmp,
        role: "planner",
        pluginVersion: "0.2.0", // bumped version simulates a catalogue update
      });

      // Result contract.
      expect(result.path).toBe(personaPath);
      expect(result.hiredAt).toBe(ORIGINAL_HIRED_AT);
      expect(result.catalogueVersion).toBe("0.2.0");

      // 4) Read the refreshed persona and assert preservation + catalogue parity.
      const after = await readPersona({ targetRepoRoot: tmp, role: "planner" });

      // hired_at must be the ORIGINAL value, not the refresh time.
      expect(after.hired_at).toBe(ORIGINAL_HIRED_AT);

      // catalogue_version is updated to reflect the refresh.
      expect(after.catalogue_version).toBe("0.2.0");

      // Knowledge section is preserved verbatim.
      expect(after.sections.Knowledge).toContain("always check the spec before coding");
      expect(after.sections.Knowledge).toContain("run tests locally first");

      // Catalogue-derived content is re-materialised from the current catalogue.
      const catalogue = await readCatalogue({ pluginRoot: getPluginRoot(), role: "planner" });
      expect(after.domain).toBe(catalogue.domain);
      expect(after.sections.Domain).toBe(catalogue.sections.Domain);
      expect(after.sections.Mandate).toBe(catalogue.sections.Mandate);
      expect(after.sections["Out of mandate"]).toBe(catalogue.sections["Out of mandate"]);
      expect(after.sections.Prompt).toBe(catalogue.sections.Prompt);

      // All required sections present and the file is parseable.
      for (const section of REQUIRED_PERSONA_SECTIONS) {
        expect(after.sections[section]).toBeDefined();
      }
    });

    it("preserves an empty Knowledge section without appending spurious content", async () => {
      const tmp = await makeTmp("refresh-empty-knowledge");
      tmpDirs.push(tmp);

      const HIRED_AT = "2026-03-10T10:00:00.000Z";

      await instantiatePersona({
        pluginRoot: getPluginRoot(),
        targetRepoRoot: tmp,
        role: "generalist-dev",
        clock: () => new Date(HIRED_AT),
        pluginVersion: "0.1.0",
      });

      // Knowledge is empty at hire time (FR89).
      const before = await readPersona({ targetRepoRoot: tmp, role: "generalist-dev" });
      expect(before.sections.Knowledge).toBe("");

      await refreshPersona({
        pluginRoot: getPluginRoot(),
        targetRepoRoot: tmp,
        role: "generalist-dev",
        pluginVersion: "0.1.1",
      });

      const after = await readPersona({ targetRepoRoot: tmp, role: "generalist-dev" });
      expect(after.hired_at).toBe(HIRED_AT);
      expect(after.sections.Knowledge).toBe("");
    });

    it("throws PersonaFileNotFoundError when the role is not hired", async () => {
      const tmp = await makeTmp("refresh-not-hired");
      tmpDirs.push(tmp);

      const { PersonaFileNotFoundError } = await import("../src/errors.js");
      await expect(
        refreshPersona({
          pluginRoot: getPluginRoot(),
          targetRepoRoot: tmp,
          role: "planner",
          pluginVersion: "0.1.0",
        }),
      ).rejects.toBeInstanceOf(PersonaFileNotFoundError);
    });

    it("re-throws a non-ENOENT persona read error verbatim instead of masking it as not-found", async () => {
      const tmp = await makeTmp("refresh-read-eisdir");
      tmpDirs.push(tmp);

      // Make team/planner/PERSONA.md a *directory*, so fs.readFile throws
      // EISDIR (a non-ENOENT error). The tool must surface that raw error, not
      // mistake it for PersonaFileNotFoundError. (refresh-persona.ts:141-142)
      await fs.mkdir(path.join(tmp, "team", "planner", "PERSONA.md"), {
        recursive: true,
      });

      const { PersonaFileNotFoundError } = await import("../src/errors.js");
      await expect(
        refreshPersona({
          pluginRoot: getPluginRoot(),
          targetRepoRoot: tmp,
          role: "planner",
          pluginVersion: "0.1.0",
        }),
      ).rejects.toMatchObject({ code: "EISDIR" });

      await expect(
        refreshPersona({
          pluginRoot: getPluginRoot(),
          targetRepoRoot: tmp,
          role: "planner",
          pluginVersion: "0.1.0",
        }),
      ).rejects.not.toBeInstanceOf(PersonaFileNotFoundError);
    });

    it("stops collecting Knowledge at the next ##-level heading, dropping any trailing section", async () => {
      const tmp = await makeTmp("refresh-knowledge-break");
      tmpDirs.push(tmp);

      const HIRED_AT = "2026-04-01T09:00:00.000Z";

      const { path: personaPath } = await instantiatePersona({
        pluginRoot: getPluginRoot(),
        targetRepoRoot: tmp,
        role: "planner",
        clock: () => new Date(HIRED_AT),
        pluginVersion: "0.1.0",
      });

      // The rendered persona ends with `## Knowledge\n\n`. Append a Knowledge
      // body followed by a *trailing* ##-level heading. The extractor must keep
      // the Knowledge body and break at the trailing heading, dropping it.
      // (refresh-persona.ts:219-221)
      await fs.appendFile(
        personaPath,
        "- preserved lesson\n\n## Trailing Section\n\ndiscard me\n",
        "utf8",
      );

      await refreshPersona({
        pluginRoot: getPluginRoot(),
        targetRepoRoot: tmp,
        role: "planner",
        pluginVersion: "0.1.1",
      });

      const after = await readPersona({ targetRepoRoot: tmp, role: "planner" });
      expect(after.hired_at).toBe(HIRED_AT);
      expect(after.sections.Knowledge).toContain("preserved lesson");
      expect(after.sections.Knowledge).not.toContain("discard me");
      expect(after.sections.Knowledge).not.toContain("Trailing Section");
    });

    it("throws CatalogueRoleNotFoundError when the role is in neither custom nor the catalogue", async () => {
      const tmp = await makeTmp("refresh-unknown-role");
      tmpDirs.push(tmp);

      // 'ghost-role' passes the kebab-case guard but exists in no catalogue:
      // readCustomRole reports not-found (ENOENT), then readCatalogue reports
      // not-found, and refreshPersona wraps both into one
      // CatalogueRoleNotFoundError. (refresh-persona.ts:113-120)
      const { CatalogueRoleNotFoundError } = await import("../src/errors.js");
      await expect(
        refreshPersona({
          pluginRoot: getPluginRoot(),
          targetRepoRoot: tmp,
          role: "ghost-role",
          pluginVersion: "0.1.0",
        }),
      ).rejects.toBeInstanceOf(CatalogueRoleNotFoundError);
    });

    it("re-throws a non-not-found custom-role read error instead of falling through to the catalogue", async () => {
      const tmp = await makeTmp("refresh-custom-eisdir");
      tmpDirs.push(tmp);

      // Make team/custom/planner.md a *directory* so readCustomRole's readFile
      // throws EISDIR — a non-CatalogueRoleNotFoundError that refreshPersona
      // must surface verbatim rather than swallow. (refresh-persona.ts:101-102)
      await fs.mkdir(path.join(tmp, "team", "custom", "planner.md"), {
        recursive: true,
      });

      await expect(
        refreshPersona({
          pluginRoot: getPluginRoot(),
          targetRepoRoot: tmp,
          role: "planner",
          pluginVersion: "0.1.0",
        }),
      ).rejects.toMatchObject({ code: "EISDIR" });
    });

    it("re-throws a non-not-found catalogue read error instead of reporting role-not-found", async () => {
      const tmp = await makeTmp("refresh-cat-eisdir");
      tmpDirs.push(tmp);
      const fakeRoot = await makeTmp("refresh-fake-plugin");
      tmpDirs.push(fakeRoot);

      // No custom planner (readCustomRole reports not-found), then point the
      // catalogue at a *directory* so readCatalogue's readFile throws EISDIR —
      // a non-CatalogueRoleNotFoundError that refreshPersona surfaces verbatim
      // rather than masking as role-not-found. (refresh-persona.ts:119-120)
      await fs.mkdir(path.join(fakeRoot, "catalogue", "planner.md"), {
        recursive: true,
      });

      await expect(
        refreshPersona({
          pluginRoot: fakeRoot,
          targetRepoRoot: tmp,
          role: "planner",
          pluginVersion: "0.1.0",
        }),
      ).rejects.toMatchObject({ code: "EISDIR" });
    });
  });

  /**
   * Story native:01KVS0YFNNFWFDP2EJT10FMV08 AC2 — refreshPersona works without
   * requiring an unhire (safe at minimum roster), and instantiatePersona's FR89
   * existing-persona refusal still applies to genuine non-force re-instantiation.
   */
  describe("Story native:01KVS0YFNNFWFDP2EJT10FMV08 AC2 — refresh at minimum roster; FR89 intact", () => {
    /**
     * Build 5 custom roles where each covers exactly one unique lens, so that
     * hiring exactly these 5 roles produces the minimum roster: removing any one
     * would leave one lens uncovered → UnhireBelowJudgeMinimumError.
     */
    const MINIMUM_ROSTER_ROLES = [
      {
        id: "lens-structure-specialist",
        lens: "structure",
        body: `---
role: lens-structure-specialist
domain: "structure lens coverage"
model_tier: sonnet
tools_allow:
  - Read
gh_allow: []
locked_phrases:
  handoff: "Handoff to <next role> — done"
  yield: "This sits in <domain>'s domain — handing off."
  verdict: "**Verdict: <SENTINEL>**"
capabilities:
  review_lenses:
    - structure
  run_jobs: []
  path_patterns: []
---

# Lens Structure Specialist

## Domain

Covers the structure review lens.

## Mandate

- Review structure.

## Out of mandate

- Other lenses.

## Prompt

You cover the structure lens.
`,
      },
      {
        id: "lens-verifiability-specialist",
        lens: "verifiability",
        body: `---
role: lens-verifiability-specialist
domain: "verifiability lens coverage"
model_tier: sonnet
tools_allow:
  - Read
gh_allow: []
locked_phrases:
  handoff: "Handoff to <next role> — done"
  yield: "This sits in <domain>'s domain — handing off."
  verdict: "**Verdict: <SENTINEL>**"
capabilities:
  review_lenses:
    - verifiability
  run_jobs: []
  path_patterns: []
---

# Lens Verifiability Specialist

## Domain

Covers the verifiability review lens.

## Mandate

- Review verifiability.

## Out of mandate

- Other lenses.

## Prompt

You cover the verifiability lens.
`,
      },
      {
        id: "lens-discipline-specialist",
        lens: "discipline",
        body: `---
role: lens-discipline-specialist
domain: "discipline lens coverage"
model_tier: sonnet
tools_allow:
  - Read
gh_allow: []
locked_phrases:
  handoff: "Handoff to <next role> — done"
  yield: "This sits in <domain>'s domain — handing off."
  verdict: "**Verdict: <SENTINEL>**"
capabilities:
  review_lenses:
    - discipline
  run_jobs: []
  path_patterns: []
---

# Lens Discipline Specialist

## Domain

Covers the discipline review lens.

## Mandate

- Review discipline.

## Out of mandate

- Other lenses.

## Prompt

You cover the discipline lens.
`,
      },
      {
        id: "lens-domain-specialist",
        lens: "domain",
        body: `---
role: lens-domain-specialist
domain: "domain lens coverage"
model_tier: sonnet
tools_allow:
  - Read
gh_allow: []
locked_phrases:
  handoff: "Handoff to <next role> — done"
  yield: "This sits in <domain>'s domain — handing off."
  verdict: "**Verdict: <SENTINEL>**"
capabilities:
  review_lenses:
    - domain
  run_jobs: []
  path_patterns: []
---

# Lens Domain Specialist

## Domain

Covers the domain review lens.

## Mandate

- Review domain.

## Out of mandate

- Other lenses.

## Prompt

You cover the domain lens.
`,
      },
      {
        id: "lens-considered-specialist",
        lens: "considered",
        body: `---
role: lens-considered-specialist
domain: "considered lens coverage"
model_tier: sonnet
tools_allow:
  - Read
gh_allow: []
locked_phrases:
  handoff: "Handoff to <next role> — done"
  yield: "This sits in <domain>'s domain — handing off."
  verdict: "**Verdict: <SENTINEL>**"
capabilities:
  review_lenses:
    - considered
  run_jobs: []
  path_patterns: []
---

# Lens Considered Specialist

## Domain

Covers the considered review lens.

## Mandate

- Review considered.

## Out of mandate

- Other lenses.

## Prompt

You cover the considered lens.
`,
      },
    ] as const;

    it("refresh succeeds without unhire even when the minimum roster is hired", async () => {
      const tmp = await makeTmp("refresh-ac2-min-roster");
      tmpDirs.push(tmp);

      const HIRED_AT = "2026-05-01T09:00:00.000Z";

      // Write all 5 custom role files and hire them.
      const customDir = path.join(tmp, "team", "custom");
      await fs.mkdir(customDir, { recursive: true });

      for (const role of MINIMUM_ROSTER_ROLES) {
        await fs.writeFile(path.join(customDir, `${role.id}.md`), role.body, "utf8");
        await instantiatePersona({
          pluginRoot: getPluginRoot(),
          targetRepoRoot: tmp,
          role: role.id,
          clock: () => new Date(HIRED_AT),
          pluginVersion: "0.1.0",
        });
      }

      // Confirm the minimum roster blocks a plain unhire.
      await expect(
        unhirePersona({ targetRepoRoot: tmp, role: "lens-structure-specialist" }),
      ).rejects.toBeInstanceOf(UnhireBelowJudgeMinimumError);

      // Append some knowledge to the role we will refresh.
      const personaPath = path.join(tmp, "team", "lens-structure-specialist", "PERSONA.md");
      const knowledgeContent = "- learned: structure review patterns\n";
      await fs.appendFile(personaPath, knowledgeContent, "utf8");

      // refreshPersona must succeed even though unhirePersona would have refused.
      const result = await refreshPersona({
        pluginRoot: getPluginRoot(),
        targetRepoRoot: tmp,
        role: "lens-structure-specialist",
        pluginVersion: "0.2.0",
      });

      expect(result.hiredAt).toBe(HIRED_AT);
      expect(result.catalogueVersion).toBe("0.2.0");

      // Knowledge is preserved after the refresh.
      const after = await readPersona({ targetRepoRoot: tmp, role: "lens-structure-specialist" });
      expect(after.hired_at).toBe(HIRED_AT);
      expect(after.sections.Knowledge).toContain("structure review patterns");
    });

    it("instantiatePersona's FR89 existing-persona refusal still applies for non-force re-instantiation", async () => {
      const tmp = await makeTmp("refresh-ac2-fr89");
      tmpDirs.push(tmp);

      await instantiatePersona({
        pluginRoot: getPluginRoot(),
        targetRepoRoot: tmp,
        role: "planner",
        clock: () => new Date(FIXED_HIRED_AT),
        pluginVersion: FIXED_VERSION,
      });

      // A second instantiatePersona on the same role must still refuse (FR89 intact).
      await expect(
        instantiatePersona({
          pluginRoot: getPluginRoot(),
          targetRepoRoot: tmp,
          role: "planner",
          clock: () => new Date(FIXED_HIRED_AT),
          pluginVersion: FIXED_VERSION,
        }),
      ).rejects.toBeInstanceOf(PersonaAlreadyExistsError);

      // refreshPersona, by contrast, must succeed on the same role.
      const refreshResult = await refreshPersona({
        pluginRoot: getPluginRoot(),
        targetRepoRoot: tmp,
        role: "planner",
        pluginVersion: FIXED_VERSION,
      });
      expect(refreshResult.path).toBe(path.join(tmp, "team", "planner", "PERSONA.md"));
    });
  });

  describe("renderPersonaFile H1 parity with catalogue source", () => {
    // Guards against silent drift: today all ten shipped catalogue H1s
    // happen to match the title-cased role id, but renderPersonaFile
    // reconstructs the H1 from the role id rather than copying the
    // catalogue's actual H1. This test asserts byte-equality between
    // the catalogue's `# <H1>` line and the rendered persona's, so a
    // future role whose H1 uses an acronym or non-title-case stylisation
    // will fail loudly here instead of silently diverging at runtime.
    it("rendered persona H1 byte-equals catalogue H1 for every shipped role", async () => {
      const catalogueDir = path.join(getPluginRoot(), "catalogue");
      for (const role of CATALOGUE_ROLES) {
        const cataloguePath = path.join(catalogueDir, `${role}.md`);
        const raw = await fs.readFile(cataloguePath, "utf8");

        // Extract the catalogue's literal H1 line.
        const { body: catalogueBody } = splitFrontmatter(raw, cataloguePath);
        const catalogueH1 = extractH1(catalogueBody);
        expect(
          catalogueH1,
          `catalogue ${role}.md is missing an H1`,
        ).not.toBeNull();

        // Render a persona from the parsed catalogue.
        const catalogue = await readCatalogue({
          pluginRoot: getPluginRoot(),
          role,
        });
        const rendered = renderPersonaFile({
          catalogue,
          hiredAt: FIXED_HIRED_AT,
          catalogueVersion: FIXED_VERSION,
        });
        const { body: renderedBody } = splitFrontmatter(rendered, "<rendered>");
        const renderedH1 = extractH1(renderedBody);

        expect(renderedH1, `rendered persona for ${role} is missing an H1`)
          .not.toBeNull();
        expect(
          renderedH1,
          `rendered H1 for ${role} must byte-equal catalogue H1`,
        ).toBe(catalogueH1);
      }
    });
  });
});

function extractH1(body: string): string | null {
  for (const line of body.split("\n")) {
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (match && !line.startsWith("##")) {
      return match[1]!;
    }
  }
  return null;
}
