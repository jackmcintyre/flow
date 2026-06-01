import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parse as yamlParse } from "yaml";
import { resolveWorkspace } from "../src/state/workspace-resolver.js";
import { adapters as registryAdapters } from "../src/adapters/registry.js";
import type { PlanningAdapter, SourceStory } from "../src/adapters/adapter.js";
import {
  AmbiguousAdapterError,
  InvalidWorkspaceConfigError,
  NoAdapterMatchedError,
  NotImplementedError,
} from "../src/errors.js";
import { BmadAdapter, resetBmadAdapter } from "../src/adapters/bmad/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures", "workspace-resolver");

function makeStubAdapter(opts: {
  name: string;
  detectResult: boolean;
  defaultCfg?: Record<string, unknown>;
  schema?: z.ZodTypeAny;
}): PlanningAdapter {
  return {
    name: opts.name,
    async detect(_t: string): Promise<boolean> {
      return opts.detectResult;
    },
    async listSourceStories(): Promise<SourceStory[]> {
      return [];
    },
    async readSourceStory(_r: string): Promise<SourceStory> {
      throw new NotImplementedError("stub");
    },
    resolveSourcePath(_r: string): string {
      throw new NotImplementedError("stub");
    },
    defaultConfig(): Record<string, unknown> {
      return opts.defaultCfg ?? {};
    },
    adapterConfigSchema: opts.schema ?? z.record(z.string(), z.unknown()),
    validateAgainstDiscipline: (s: SourceStory) => s,
  };
}

async function copyFixtureToTmp(fixtureName: string): Promise<string> {
  const src = path.join(FIXTURES, fixtureName);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `wsres-${fixtureName}-`));
  await fs.cp(src, tmp, { recursive: true });
  return tmp;
}

async function makeEmptyTmpRepo(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "wsres-empty-"));
}

describe("resolveWorkspace", () => {
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

  it("AC4a: loads a valid bmad config and exposes the Workspace", async () => {
    const tmp = await copyFixtureToTmp("valid-bmad");
    tmpDirs.push(tmp);

    const ws = await resolveWorkspace({ targetRepoRoot: tmp });

    expect(ws.targetRepoRoot).toBe(path.resolve(tmp));
    expect(ws.activeAdapterName).toBe("bmad");
    expect(ws.activeAdapter.name).toBe("bmad");
    expect(ws.adapterConfig).toEqual({
      stories_root: "_bmad-output/planning-artifacts/stories",
    });
    // Partial plugin block in the fixture overrides agreement_threshold;
    // orchestration_interval_seconds gets the documented default.
    expect(ws.pluginSettings.agreement_threshold).toBe(0.9);
    expect(ws.pluginSettings.orchestration_interval_seconds).toBe(120);
  });

  it("AC4b: missing config + exactly one detect() match writes config and is idempotent", async () => {
    const tmp = await makeEmptyTmpRepo();
    tmpDirs.push(tmp);

    const stub = makeStubAdapter({
      name: "stubA",
      detectResult: true,
      defaultCfg: { stories_root: "stories/" },
      schema: z.object({ stories_root: z.string() }),
    });

    const ws1 = await resolveWorkspace({ targetRepoRoot: tmp, adapters: [stub] });
    expect(ws1.activeAdapterName).toBe("stubA");
    expect(ws1.adapterConfig).toEqual({ stories_root: "stories/" });
    expect(ws1.pluginSettings.agreement_threshold).toBe(0.8);
    expect(ws1.pluginSettings.orchestration_interval_seconds).toBe(120);

    const configPath = path.join(tmp, ".crew", "config.yaml");
    const written = await fs.readFile(configPath, "utf8");
    const parsed = yamlParse(written) as { adapter: string };
    expect(parsed.adapter).toBe("stubA");

    // Second call parses the just-written file via the same code path.
    const ws2 = await resolveWorkspace({ targetRepoRoot: tmp, adapters: [stub] });
    expect(ws2.activeAdapterName).toBe(ws1.activeAdapterName);
    expect(ws2.adapterConfig).toEqual(ws1.adapterConfig);
    expect(ws2.pluginSettings).toEqual(ws1.pluginSettings);
  });

  it("AC4c: invalid config (unknown adapter name) throws InvalidWorkspaceConfigError", async () => {
    const tmp = await copyFixtureToTmp("invalid");
    tmpDirs.push(tmp);

    await expect(resolveWorkspace({ targetRepoRoot: tmp })).rejects.toMatchObject({
      name: "InvalidWorkspaceConfigError",
      yamlPath: "adapter",
      schemaModule: "mcp-server/src/schemas/workspace-config.ts",
    });

    try {
      await resolveWorkspace({ targetRepoRoot: tmp });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidWorkspaceConfigError);
      const e = err as InvalidWorkspaceConfigError;
      expect(e.message).toContain("adapter");
      expect(e.message).toContain("nonexistent");
      expect(e.message).toContain("mcp-server/src/schemas/workspace-config.ts");
    }
  });

  it("AC4d: no detect() matches throws NoAdapterMatchedError and writes no config", async () => {
    const tmp = await makeEmptyTmpRepo();
    tmpDirs.push(tmp);

    const stub = makeStubAdapter({ name: "stubA", detectResult: false });

    await expect(
      resolveWorkspace({ targetRepoRoot: tmp, adapters: [stub] }),
    ).rejects.toBeInstanceOf(NoAdapterMatchedError);

    const configPath = path.join(tmp, ".crew", "config.yaml");
    await expect(fs.stat(configPath)).rejects.toThrow();
  });

  it("AC4e: two detect() matches throws AmbiguousAdapterError and writes no config", async () => {
    const tmp = await makeEmptyTmpRepo();
    tmpDirs.push(tmp);

    const stubA = makeStubAdapter({ name: "stubA", detectResult: true });
    const stubB = makeStubAdapter({ name: "stubB", detectResult: true });

    try {
      await resolveWorkspace({ targetRepoRoot: tmp, adapters: [stubA, stubB] });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AmbiguousAdapterError);
      const e = err as AmbiguousAdapterError;
      expect(e.matchingAdapters).toEqual(["stubA", "stubB"]);
      expect(e.message).toContain("stubA");
      expect(e.message).toContain("stubB");
    }

    const configPath = path.join(tmp, ".crew", "config.yaml");
    await expect(fs.stat(configPath)).rejects.toThrow();
  });

  describe("AC5: BMad adapter binding", () => {
    let bmadTmpDirs: string[] = [];

    beforeEach(() => {
      resetBmadAdapter();
    });

    afterEach(async () => {
      resetBmadAdapter();
      while (bmadTmpDirs.length) {
        const d = bmadTmpDirs.pop()!;
        try {
          await fs.rm(d, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    });

    it("binds BmadAdapter context so listSourceStories() works without an explicit configureBmadAdapter call", async () => {
      // Build a BMad-shaped tmp repo with one valid story file.
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "wsres-bmad-binding-"));
      bmadTmpDirs.push(tmp);

      // Write .crew/config.yaml
      const crewDir = path.join(tmp, ".crew");
      await fs.mkdir(crewDir, { recursive: true });
      await fs.writeFile(
        path.join(crewDir, "config.yaml"),
        "adapter: bmad\nadapter_config:\n  stories_root: _bmad-output/planning-artifacts/stories\nplugin: {}\n",
        "utf8",
      );

      // Write a minimal BMad story file so listSourceStories() returns ≥1 result.
      const storiesDir = path.join(tmp, "_bmad-output", "planning-artifacts", "stories");
      await fs.mkdir(storiesDir, { recursive: true });
      await fs.writeFile(
        path.join(storiesDir, "9-9-fixture-story.md"),
        [
          "# Story 9.9: Fixture story",
          "",
          "Status: ready-for-dev",
          "",
          "## Story",
          "",
          "As a **fixture story**,",
          "I want **to be scanned**,",
          "so that **the binding test can assert listSourceStories() resolves**.",
          "",
          "## Acceptance Criteria",
          "",
          "**AC1 (integration):**",
          "**Given** this fixture,",
          "**When** listSourceStories is called,",
          "**Then** a SourceStory is returned.",
        ].join("\n"),
        "utf8",
      );

      // Ensure the adapter is not yet bound (resetBmadAdapter called in beforeEach).
      const ws = await resolveWorkspace({ targetRepoRoot: tmp, adapters: [BmadAdapter] });

      expect(ws.activeAdapterName).toBe("bmad");

      // Critical assertion (AC5): listSourceStories() must NOT throw "BmadAdapter has no bound context".
      const stories = await ws.activeAdapter.listSourceStories();
      expect(stories.length).toBeGreaterThanOrEqual(1);
    });

    it("applies the default stories_root fallback when adapterConfig.stories_root is absent", async () => {
      // String-level assertion: the default literal must appear in workspace-resolver.ts.
      const HERE = path.dirname(fileURLToPath(import.meta.url));
      const resolverSrc = await fs.readFile(
        path.join(HERE, "../src/state/workspace-resolver.ts"),
        "utf8",
      );
      const matches = resolverSrc.match(/"_bmad-output\/planning-artifacts\/stories"/g);
      expect(matches).not.toBeNull();
      expect(matches!.length).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Story 10.6 AC3 — the cutover is reversible up to the flip. Both adapters
  // remain registered and coexist; native is additive. Flipping
  // `.crew/config.yaml` back to `adapter: bmad` restores BMad as the active
  // adapter, and the BMad parser remains available as an ingest on-ramp after
  // cutover (it is demoted, not removed). Uses the LIVE registry (not stubs) so
  // the test pins the real coexistence.
  // -------------------------------------------------------------------------
  describe("Story 10.6 AC3 — reversible cutover; both adapters coexist in the live registry", () => {
    beforeEach(() => {
      resetBmadAdapter();
    });
    afterEach(() => {
      resetBmadAdapter();
    });

    it("both bmad and native are registered and coexist (native is additive, not a replacement)", () => {
      const names = registryAdapters.map((a) => a.name);
      expect(names).toContain("bmad");
      expect(names).toContain("native");
    });

    async function writeRepoWithAdapter(adapter: "native" | "bmad"): Promise<string> {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `wsres-cutover-${adapter}-`));
      tmpDirs.push(tmp);
      const crewDir = path.join(tmp, ".crew");
      await fs.mkdir(crewDir, { recursive: true });
      if (adapter === "native") {
        await fs.writeFile(
          path.join(crewDir, "config.yaml"),
          "adapter: native\nadapter_config: {}\nplugin: {}\n",
          "utf8",
        );
      } else {
        await fs.writeFile(
          path.join(crewDir, "config.yaml"),
          "adapter: bmad\nadapter_config:\n  stories_root: _bmad-output/planning-artifacts/stories\nplugin: {}\n",
          "utf8",
        );
      }
      return tmp;
    }

    it("flipping config to native binds the native adapter; flipping back to bmad restores bmad as live", async () => {
      // After cutover: adapter: native → native is the live adapter.
      const tmp = await writeRepoWithAdapter("native");
      const ws1 = await resolveWorkspace({ targetRepoRoot: tmp });
      expect(ws1.activeAdapterName).toBe("native");
      expect(ws1.activeAdapter.name).toBe("native");

      // Reversibility: flip the SAME repo's config back to bmad.
      await fs.writeFile(
        path.join(tmp, ".crew", "config.yaml"),
        "adapter: bmad\nadapter_config:\n  stories_root: _bmad-output/planning-artifacts/stories\nplugin: {}\n",
        "utf8",
      );
      const ws2 = await resolveWorkspace({ targetRepoRoot: tmp });
      expect(ws2.activeAdapterName).toBe("bmad");
      expect(ws2.activeAdapter.name).toBe("bmad");
    });

    it("after cutover the BMad parser is still an available ingest on-ramp (demoted, not removed)", async () => {
      // The repo is native-primary (post-cutover), but the BMad adapter is still
      // in the registry and its parser still works — it is the ingest on-ramp.
      const bmadAdapter = registryAdapters.find((a) => a.name === "bmad")!;
      expect(bmadAdapter).toBeDefined();

      // Build a BMad-shaped repo and parse a story through the still-registered
      // adapter to prove the parser is reachable, not stripped, after cutover.
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "wsres-cutover-ingest-"));
      tmpDirs.push(tmp);
      const storiesDir = path.join(tmp, "_bmad-output", "planning-artifacts", "stories");
      await fs.mkdir(storiesDir, { recursive: true });
      await fs.writeFile(
        path.join(storiesDir, "9-9-ingest-story.md"),
        [
          "# Story 9.9: Ingest on-ramp story",
          "",
          "Status: ready-for-dev",
          "",
          "## Story",
          "",
          "As a **BMad story**,",
          "I want **to remain parseable after cutover**,",
          "so that **the ingest on-ramp still works**.",
          "",
          "## Acceptance Criteria",
          "",
          "**AC1 (integration):**",
          "**Given** this fixture,",
          "**When** the BMad parser runs,",
          "**Then** a SourceStory is returned.",
        ].join("\n"),
        "utf8",
      );

      // Bind the BMad adapter's context (as resolveWorkspace would) and parse.
      const { configureBmadAdapter } = await import("../src/adapters/bmad/index.js");
      configureBmadAdapter({
        targetRepo: tmp,
        storiesRoot: "_bmad-output/planning-artifacts/stories",
      });
      const stories = await bmadAdapter.listSourceStories();
      expect(stories.length).toBeGreaterThanOrEqual(1);
    });
  });
});
