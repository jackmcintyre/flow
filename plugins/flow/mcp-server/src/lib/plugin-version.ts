import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PluginManifestSchema } from "../schemas/plugin-manifest.js";
import { getPluginRoot } from "./plugin-root.js";

let cachedVersion: string | undefined;

/**
 * Returns the semver string from `.claude-plugin/plugin.json`.
 *
 * The value is parsed and validated against `PluginManifestSchema`
 * on first read, then cached. Stories 2.3, 4.7, and 4.9 call this
 * to stamp the plugin version onto personas, verdicts, and the
 * verdict footer marker.
 */
export function getPluginVersion(): string {
  if (cachedVersion !== undefined) {
    return cachedVersion;
  }
  const manifestPath = resolve(getPluginRoot(), ".claude-plugin/plugin.json");
  const raw = readFileSync(manifestPath, "utf8");
  const parsed = PluginManifestSchema.parse(JSON.parse(raw));
  cachedVersion = parsed.version;
  return cachedVersion;
}

/**
 * Test-only helper to clear the cached version. Not exported from
 * any public-facing barrel — intended for vitest only.
 */
export function __resetPluginVersionCacheForTests(): void {
  cachedVersion = undefined;
}
