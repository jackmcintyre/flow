import { promises as fs } from "node:fs";
import * as path from "node:path";
import { ShippedRiskTieringDefaultMissingError } from "../errors.js";
import { parseRiskTieringSpec } from "../validators/risk-tiering-spec.js";
import type { RiskTieringSpec } from "../schemas/risk-tiering-spec.js";

/**
 * Resolve the active risk-tiering spec, attempting the target-repo override
 * first and falling back to the shipped plugin default.
 *
 * Story 4.9 — FR40a / Architecture § "Risk-Tier Classification (FR40a) — Spec Format".
 *
 * Resolution order (override-replaces-default semantics — NOT merged):
 *   1. `<targetRepoRoot>/docs/risk-tiering.md` — if present AND valid, returned in full.
 *      ENOENT → fall through to step 2. Any other read error → propagate uncaught.
 *   2. `<pluginRoot>/docs/risk-tiering.md` — the shipped default bundled with the plugin.
 *      ENOENT → raises `ShippedRiskTieringDefaultMissingError` (broken install).
 *      Any other read error → propagate uncaught.
 *
 * `pluginRoot` is supplied by the caller (Story 4.9b resolves it once via
 * `getPluginRoot()`). The loader does NOT resolve `import.meta.url` internally —
 * keeping it pure makes testing straightforward: pass any tmpdir for both roots.
 */
export async function lookupRiskTieringSpec(opts: {
  targetRepoRoot: string;
  pluginRoot: string;
}): Promise<RiskTieringSpec> {
  const overridePath = path.join(opts.targetRepoRoot, "docs", "risk-tiering.md");
  const defaultPath = path.join(opts.pluginRoot, "docs", "risk-tiering.md");

  // Step 1: try the target-repo override
  try {
    const raw = await fs.readFile(overridePath, "utf8");
    return parseRiskTieringSpec(raw, overridePath, defaultPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
    // ENOENT → fall through to shipped default
  }

  // Step 2: try the shipped plugin default
  try {
    const raw = await fs.readFile(defaultPath, "utf8");
    return parseRiskTieringSpec(raw, defaultPath, defaultPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ShippedRiskTieringDefaultMissingError({ expectedPath: defaultPath });
    }
    throw err;
  }
}
