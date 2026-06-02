/**
 * Story 8.3 — evidence-only agent discipline.
 *
 * The generalist-dev and generalist-reviewer catalogue prompts MUST forbid
 * hand-writing the execution manifest / `.flow/state` (the spike's
 * manifest-corruption failure mode, where a dev agent wrote non-schema keys
 * like `pr_url`/`branch` into a manifest and broke `parseExecutionManifest`).
 *
 * These are content-structure anchors (the Story 1.8 convention for
 * LLM-driven prose) guarding a persona rule from silent regression: the rule
 * flows verbatim into the spawn prompt via `buildPersonaSpawnPrompt`.
 */
import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CATALOGUE_DIR = path.resolve(HERE, "..", "..", "catalogue");

describe("Story 8.3 — evidence-only agent discipline (no manifest writes)", () => {
  for (const filename of ["generalist-dev.md", "generalist-reviewer.md"]) {
    it(`${filename} forbids hand-writing the execution manifest / .flow/state`, async () => {
      const raw = await fs.readFile(path.join(CATALOGUE_DIR, filename), "utf8");
      // Names the execution manifest and the state tree as off-limits.
      expect(raw).toMatch(/execution manifest/i);
      expect(raw).toContain(".flow/state");
      // Explicitly forbids writing it.
      expect(raw).toMatch(/never\b/i);
    });
  }

  it("generalist-dev preserves engineering-judgment latitude (constrains bookkeeping only)", async () => {
    const raw = await fs.readFile(path.join(CATALOGUE_DIR, "generalist-dev.md"), "utf8");
    // The rule must constrain state-writes, NOT the agent's reasoning.
    expect(raw).toMatch(/engineering judgment/i);
  });
});
