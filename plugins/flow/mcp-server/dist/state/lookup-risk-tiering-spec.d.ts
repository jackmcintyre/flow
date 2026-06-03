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
export declare function lookupRiskTieringSpec(opts: {
    targetRepoRoot: string;
    pluginRoot: string;
}): Promise<RiskTieringSpec>;
