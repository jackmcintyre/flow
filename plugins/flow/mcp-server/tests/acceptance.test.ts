import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ListToolsResultSchema,
  CallToolResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../src/server.js";
import { BmadAdapter } from "../src/adapters/bmad/index.js";
import {
  getPluginVersion,
  __resetPluginVersionCacheForTests,
} from "../src/lib/plugin-version.js";
import { PluginManifestSchema, SEMVER_REGEX } from "../src/schemas/plugin-manifest.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, "../..");
const MANIFEST_PATH = resolve(PLUGIN_ROOT, ".claude-plugin/plugin.json");

// ---------------------------------------------------------------------------
// AC2: scaffold tree contains the required files & directories
// ---------------------------------------------------------------------------
describe("AC2 — scaffold tree layout", () => {
  const requiredFiles = [
    ".claude-plugin/plugin.json",
    "pnpm-workspace.yaml",
    "tsconfig.base.json",
    "mcp-server/src/server.ts",
  ];
  const requiredDirs = [
    "mcp-server",
    "catalogue",
    "skills",
    "permissions",
    "docs",
    "example",
  ];

  for (const f of requiredFiles) {
    it(`file exists: ${f}`, () => {
      const p = resolve(PLUGIN_ROOT, f);
      expect(existsSync(p), `missing ${f}`).toBe(true);
      expect(statSync(p).isFile()).toBe(true);
    });
  }

  for (const d of requiredDirs) {
    it(`dir exists: ${d}/`, () => {
      const p = resolve(PLUGIN_ROOT, d);
      expect(existsSync(p), `missing ${d}/`).toBe(true);
      expect(statSync(p).isDirectory()).toBe(true);
    });
  }

  it("plugin.json has semver version", () => {
    const parsed = PluginManifestSchema.parse(
      JSON.parse(readFileSync(MANIFEST_PATH, "utf8")),
    );
    expect(parsed.version).toMatch(SEMVER_REGEX);
  });

  it("mcp-server/src/server.ts exports a createServer that returns an MCP server", () => {
    const s = createServer();
    expect(s).toBeDefined();
    expect(typeof s.connect).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// AC3: MCP server starts and reports zero tools registered (no errors)
// ---------------------------------------------------------------------------
describe("AC3 — MCP server starts and reports zero tools via list-tools", () => {
  it("connects over an in-memory transport and ListTools returns []", async () => {
    const server = createServer();
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    const client = new Client(
      { name: "ac3-test-client", version: "0.0.0" },
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

    expect(result.tools).toEqual([]);

    await client.close();
    await server.close();
  });

  it("calling an unknown tool returns an isError response, not a thrown error", async () => {
    const server = createServer();
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "ac3-test-client", version: "0.0.0" },
      { capabilities: {} },
    );
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const result = await client.request(
      {
        method: "tools/call",
        params: { name: "does-not-exist", arguments: {} },
      },
      CallToolResultSchema,
    );
    expect(result.isError).toBe(true);

    await client.close();
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// AC4: BmadAdapter implements PlanningAdapter.listSourceStories as []
// ---------------------------------------------------------------------------
describe("AC4 — BmadAdapter scaffold", () => {
  it("is exported from mcp-server/src/adapters/bmad/index.ts", async () => {
    const mod = await import("../src/adapters/bmad/index.js");
    expect(mod.BmadAdapter).toBeDefined();
  });

  it("listSourceStories() throws when no context is bound (post-Story-3.3)", async () => {
    // Pre-Story-3.3 the stub returned []. Story 3.3 replaced the stub
    // with a real implementation that requires a bound (targetRepo,
    // storiesRoot) context; without one the singleton refuses to walk.
    await expect(BmadAdapter.listSourceStories()).rejects.toThrow(
      /no bound context/,
    );
  });

  it("declares the PlanningAdapter shape (name + required methods)", () => {
    expect(BmadAdapter.name).toBe("bmad");
    expect(typeof BmadAdapter.listSourceStories).toBe("function");
    expect(typeof BmadAdapter.readSourceStory).toBe("function");
    expect(typeof BmadAdapter.resolveSourcePath).toBe("function");
    expect(typeof BmadAdapter.detect).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// AC5: getPluginVersion() returns the semver from .claude-plugin/plugin.json
// ---------------------------------------------------------------------------
describe("AC5 — getPluginVersion() reads from plugin.json", () => {
  it("returns the exact version string from .claude-plugin/plugin.json", () => {
    __resetPluginVersionCacheForTests();
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
    expect(getPluginVersion()).toBe(manifest.version);
  });

  it("returned version matches semver", () => {
    expect(getPluginVersion()).toMatch(SEMVER_REGEX);
  });
});
