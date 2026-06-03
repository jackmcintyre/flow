/**
 * Structural acceptance tests for Story 3.3b:
 * Adapter config seam — move `configureBmadAdapter` into `resolveWorkspace`.
 *
 * ACs 1–3 are verified by reading source files from disk and asserting the
 * presence/absence of specific symbols. This is deliberately a file-level
 * structural check so it survives any future refactor that might silently
 * re-introduce the old coupling.
 *
 * ACs 4 and 5 are covered in workspace-resolver.test.ts (the string-level
 * default assertion and the integration binding test respectively). Those
 * tests are not duplicated here — the cross-reference below names them.
 *
 * AC4 cross-ref: workspace-resolver.test.ts >
 *   "applies the default stories_root fallback when adapterConfig.stories_root is absent"
 * AC5 cross-ref: workspace-resolver.test.ts >
 *   "binds BmadAdapter context so listSourceStories() works without an explicit configureBmadAdapter call"
 */

import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "src");

describe("Story 3.3b structural acceptance: adapter-config seam", () => {
  // ---------------------------------------------------------------------------
  // AC1: resolveWorkspace performs the per-adapter context binding
  // ---------------------------------------------------------------------------

  describe("AC1 — resolveWorkspace binds the adapter before returning", () => {
    it("workspace-resolver.ts imports configureBmadAdapter", async () => {
      const src = await fs.readFile(
        path.join(SRC, "state", "workspace-resolver.ts"),
        "utf8",
      );
      // The import must be present.
      expect(src).toContain('import { configureBmadAdapter }');
      expect(src).toContain('../adapters/bmad/index.js');
    });

    it("workspace-resolver.ts calls configureBmadAdapter inside the bmad dispatch block", async () => {
      const src = await fs.readFile(
        path.join(SRC, "state", "workspace-resolver.ts"),
        "utf8",
      );
      // Both the guard and the call must be present.
      expect(src).toContain('activeAdapter.name === "bmad"');
      expect(src).toContain('configureBmadAdapter({');
    });

    it("workspace-resolver.ts passes targetRepoRoot and storiesRoot to configureBmadAdapter", async () => {
      const src = await fs.readFile(
        path.join(SRC, "state", "workspace-resolver.ts"),
        "utf8",
      );
      expect(src).toContain('targetRepo: targetRepoRoot');
      expect(src).toContain('storiesRoot:');
    });
  });

  // ---------------------------------------------------------------------------
  // AC2: scan-sources.ts no longer contains configureBmadAdapter
  // ---------------------------------------------------------------------------

  describe("AC2 — scan-sources.ts is free of configureBmadAdapter", () => {
    it("scan-sources.ts does not import configureBmadAdapter", async () => {
      const src = await fs.readFile(
        path.join(SRC, "tools", "scan-sources.ts"),
        "utf8",
      );
      expect(src).not.toContain("configureBmadAdapter");
    });

    it("scan-sources.ts does not contain the if-bmad dispatch block", async () => {
      const src = await fs.readFile(
        path.join(SRC, "tools", "scan-sources.ts"),
        "utf8",
      );
      // The old block checked activeAdapterName === "bmad" to call configureBmadAdapter.
      // After the refactor the block is gone; scan-sources.ts may still reference
      // activeAdapterName for other purposes (e.g. result.adapterName), but never in
      // a conjunction with configureBmadAdapter.
      expect(src).not.toMatch(/activeAdapterName.*bmad.*configureBmadAdapter/s);
      expect(src).not.toMatch(/configureBmadAdapter.*activeAdapterName.*bmad/s);
    });
  });

  // ---------------------------------------------------------------------------
  // AC3: no tool file under src/tools/ calls configureBmadAdapter
  // ---------------------------------------------------------------------------

  describe("AC3 — no tool file calls configureBmadAdapter", () => {
    it("get-status.ts does not reference configureBmadAdapter", async () => {
      const src = await fs.readFile(
        path.join(SRC, "tools", "get-status.ts"),
        "utf8",
      );
      expect(src).not.toContain("configureBmadAdapter");
    });

    it("no file under src/tools/ references configureBmadAdapter", async () => {
      const toolsDir = path.join(SRC, "tools");
      const entries = await fs.readdir(toolsDir);
      const tsFiles = entries.filter((e) => e.endsWith(".ts"));

      const violations: string[] = [];
      for (const file of tsFiles) {
        const content = await fs.readFile(path.join(toolsDir, file), "utf8");
        if (content.includes("configureBmadAdapter")) {
          violations.push(file);
        }
      }

      expect(violations).toEqual([]);
    });
  });
});
