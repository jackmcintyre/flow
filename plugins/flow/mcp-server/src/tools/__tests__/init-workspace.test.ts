/**
 * initWorkspace — first-run scaffolder for /flow:init.
 *
 * Pins the core contract: a bare directory becomes a resolvable native
 * workspace (the explicit config breaks the no-adapter-detected deadlock),
 * the scaffold is idempotent, it never overwrites an existing standard, and
 * the bmad variant omits the native-stories dir.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, access, mkdir } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { initWorkspace, renderInitWorkspace } from "../init-workspace.js";
import { getStatus } from "../get-status.js";

// __tests__ -> tools -> src -> mcp-server -> flow (the plugin root).
const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

const CTX = { toolName: "initWorkspace", role: "operator" } as const;

describe("initWorkspace", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "flow-init-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("scaffolds a native workspace from a bare directory", async () => {
    const result = await initWorkspace({
      targetRepoRoot: root,
      pluginRoot: PLUGIN_ROOT,
      mcpToolContext: CTX,
    });

    expect(result.adapter).toBe("native");

    const config = await readFile(
      path.join(root, ".flow", "config.yaml"),
      "utf8",
    );
    expect(config).toContain("adapter: native");

    for (const sub of ["to-do", "in-progress", "blocked", "done"]) {
      expect(await exists(path.join(root, ".flow", "state", sub))).toBe(true);
    }

    expect(await exists(path.join(root, ".flow", "native-stories"))).toBe(true);
    expect(await exists(path.join(root, "docs", "standards.md"))).toBe(true);
    expect(result.created).toContain(".flow/config.yaml");
  });

  it("makes getStatus resolve the native adapter (breaks the fresh-repo deadlock)", async () => {
    await initWorkspace({
      targetRepoRoot: root,
      pluginRoot: PLUGIN_ROOT,
      mcpToolContext: CTX,
    });
    const status = await getStatus({ targetRepoRoot: root });
    expect(status.adapter.name).toBe("native");
  });

  it("is idempotent — a second run creates nothing and skips every artefact", async () => {
    const first = await initWorkspace({
      targetRepoRoot: root,
      pluginRoot: PLUGIN_ROOT,
      mcpToolContext: CTX,
    });
    expect(first.created.length).toBeGreaterThan(0);

    const second = await initWorkspace({
      targetRepoRoot: root,
      pluginRoot: PLUGIN_ROOT,
      mcpToolContext: CTX,
    });

    // Nothing written on the second pass; every artefact reported as skipped.
    expect(second.created).toEqual([]);
    expect(second.skipped).toContain(".flow/config.yaml");
    expect(second.skipped).toContain("docs/standards.md");
    expect(second.skipped).toContain(".flow/native-stories/");
  });

  it("bmad adapter writes a bmad config and no native-stories dir", async () => {
    const result = await initWorkspace({
      targetRepoRoot: root,
      adapter: "bmad",
      pluginRoot: PLUGIN_ROOT,
      mcpToolContext: CTX,
    });

    const config = await readFile(
      path.join(root, ".flow", "config.yaml"),
      "utf8",
    );
    expect(config).toContain("adapter: bmad");
    expect(result.adapter).toBe("bmad");
    expect(await exists(path.join(root, ".flow", "native-stories"))).toBe(false);
  });

  it("detects an existing git repo and team roster", async () => {
    await mkdir(path.join(root, ".git"), { recursive: true });
    await mkdir(path.join(root, "team", "planner"), { recursive: true });

    const result = await initWorkspace({
      targetRepoRoot: root,
      pluginRoot: PLUGIN_ROOT,
      mcpToolContext: CTX,
    });

    expect(result.gitPresent).toBe(true);
    expect(result.teamPresent).toBe(true);
  });
});

describe("renderInitWorkspace", () => {
  it("renders a fresh scaffold with the hire next-step and a git note", () => {
    const out = renderInitWorkspace({
      adapter: "native",
      created: [".flow/config.yaml", "docs/standards.md"],
      skipped: [],
      gitPresent: false,
      teamPresent: false,
      configPath: "/repo/.flow/config.yaml",
    });

    expect(out).toContain("Flow workspace initialised (adapter: native).");
    expect(out).toContain("Created:");
    expect(out).toContain("How flow works");
    expect(out).toContain("Next: /flow:hire default");
    expect(out).toContain("not a git repo");
  });

  it("renders an idempotent re-run with the plan next-step and no git note", () => {
    const out = renderInitWorkspace({
      adapter: "native",
      created: [],
      skipped: [".flow/config.yaml", "docs/standards.md"],
      gitPresent: true,
      teamPresent: true,
      configPath: "/repo/.flow/config.yaml",
    });

    expect(out).toContain("already initialised");
    expect(out).toContain("Already present (left as-is):");
    expect(out).toContain("Next: /flow:plan");
    expect(out).not.toContain("not a git repo");
  });
});
