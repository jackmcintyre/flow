/**
 * initWorkspace — first-run scaffolder for /flow:init.
 *
 * Pins the core contract: a bare directory becomes a resolvable native
 * workspace (the explicit config breaks the no-adapter-detected deadlock),
 * the scaffold is idempotent, it never overwrites an existing standard, and
 * the bmad variant omits the native-stories dir.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { initWorkspace } from "../init-workspace.js";
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
});
