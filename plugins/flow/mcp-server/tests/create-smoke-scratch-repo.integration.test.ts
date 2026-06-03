/**
 * Integration tests for the `createSmokeScratchRepo` tool (Story 1.13 AC1).
 *
 * All tests use real os.tmpdir() and real fs calls — no stubs.
 * Each test cleans up via vitest's `afterEach` hook so failed runs don't
 * leak directories.
 */

import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { createSmokeScratchRepo } from "../src/tools/create-smoke-scratch-repo.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Resolve the shipped standards template path for byte-equality assertion.
const STANDARDS_TEMPLATE_PATH = path.resolve(
  HERE,
  "..", // mcp-server/
  "..", // plugins/flow/
  "docs",
  "standards-example.md",
);

// Track scratch dirs created outside the tool's own cleanup (e.g. for the
// parentDir override test) so afterEach can clean them up too.
const extraScratchDirs: string[] = [];

afterEach(async () => {
  while (extraScratchDirs.length) {
    const d = extraScratchDirs.pop()!;
    try {
      await fs.rm(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("happy path", () => {
  it("returns a valid scratchRoot containing both .flow/config.yaml and .flow/standards.md", async () => {
    const { scratchRoot, cleanup } = await createSmokeScratchRepo({ label: "happy" });
    extraScratchDirs.push(scratchRoot);
    try {
      const stat = await fs.stat(scratchRoot);
      expect(stat.isDirectory()).toBe(true);

      const configStat = await fs.stat(path.join(scratchRoot, ".flow", "config.yaml"));
      expect(configStat.isFile()).toBe(true);

      const standardsStat = await fs.stat(path.join(scratchRoot, ".flow", "standards.md"));
      expect(standardsStat.isFile()).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("scratchRoot directory name starts with flow-smoke-<label>-", async () => {
    const { scratchRoot, cleanup } = await createSmokeScratchRepo({ label: "my-label" });
    extraScratchDirs.push(scratchRoot);
    try {
      const base = path.basename(scratchRoot);
      expect(base.startsWith("flow-smoke-my-label-")).toBe(true);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Idempotent cleanup
// ---------------------------------------------------------------------------

describe("idempotent cleanup", () => {
  it("calling cleanup twice succeeds without throwing", async () => {
    const { scratchRoot, cleanup } = await createSmokeScratchRepo({ label: "cleanup-test" });
    extraScratchDirs.push(scratchRoot);
    await cleanup();
    // Second call should be a no-op (force: true swallows ENOENT).
    await expect(cleanup()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Label validation
// ---------------------------------------------------------------------------

describe("label validation", () => {
  it("rejects an empty string label", async () => {
    await expect(createSmokeScratchRepo({ label: "" })).rejects.toThrow();
  });

  it("rejects a label with uppercase letters", async () => {
    await expect(createSmokeScratchRepo({ label: "MyLabel" })).rejects.toThrow();
  });

  it("rejects a label with spaces", async () => {
    await expect(createSmokeScratchRepo({ label: "my label" })).rejects.toThrow();
  });

  it("accepts a valid kebab-case label with digits", async () => {
    const { scratchRoot, cleanup } = await createSmokeScratchRepo({ label: "story-1-13" });
    extraScratchDirs.push(scratchRoot);
    try {
      const stat = await fs.stat(scratchRoot);
      expect(stat.isDirectory()).toBe(true);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// parentDir override
// ---------------------------------------------------------------------------

describe("parentDir override", () => {
  it("creates the scratch dir under the supplied parentDir", async () => {
    const customParent = await fs.mkdtemp(path.join(os.tmpdir(), "flow-smoke-parent-"));
    extraScratchDirs.push(customParent);

    const { scratchRoot, cleanup } = await createSmokeScratchRepo({
      label: "parent-override",
      parentDir: customParent,
    });
    extraScratchDirs.push(scratchRoot);
    try {
      expect(scratchRoot.startsWith(customParent)).toBe(true);
      const stat = await fs.stat(scratchRoot);
      expect(stat.isDirectory()).toBe(true);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Git repo is initialised
// ---------------------------------------------------------------------------

describe("git repo is initialised", () => {
  it("HEAD is resolvable to a 40-char SHA after createSmokeScratchRepo", async () => {
    const { scratchRoot, cleanup } = await createSmokeScratchRepo({ label: "git-init" });
    extraScratchDirs.push(scratchRoot);
    try {
      const result = await execa("git", ["-C", scratchRoot, "rev-parse", "HEAD"]);
      const sha = result.stdout.trim();
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// standards.md byte-equals the shipped template
// ---------------------------------------------------------------------------

describe("standards.md contents", () => {
  it("byte-equals the shipped docs/standards-example.md template", async () => {
    const { scratchRoot, cleanup } = await createSmokeScratchRepo({ label: "standards-check" });
    extraScratchDirs.push(scratchRoot);
    try {
      const [actual, expected] = await Promise.all([
        fs.readFile(path.join(scratchRoot, ".flow", "standards.md"), "utf8"),
        fs.readFile(STANDARDS_TEMPLATE_PATH, "utf8"),
      ]);
      expect(actual).toBe(expected);
    } finally {
      await cleanup();
    }
  });
});
