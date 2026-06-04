/**
 * Parser, load-once cache, and classifier for `gh-error-map.yaml`.
 *
 * **Behavioural contract source:**
 * `_bmad-output/implementation-artifacts/4-5-gh-error-map-yaml-and-recoverable-error-classification.md § Behavioural contract`
 *
 * ## Exports
 *
 * - `parseGhErrorMap(filePath)` — reads YAML, validates via strict-mode Zod,
 *   compiles each `stderr_regex` into a `RegExp`. Raises `MalformedGhErrorMapError`
 *   on any validation failure.
 *
 * - `loadGhErrorMap(pluginRoot)` — load-once cache keyed by resolved absolute path.
 *   Test-only: `__resetGhErrorMapCacheForTests()` resets between tests.
 *
 * - `classifyGhError(result, map)` — walks `entries` in file order, returns the
 *   first matching class or `null` (unmapped → existing terminal-error path).
 *
 * Story 4.5 Task 1.2
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parse as yamlParse } from "yaml";
import { GhErrorMapSchema } from "../schemas/gh-error-map.js";
import { MalformedGhErrorMapError } from "../errors.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A parsed and validated entry from `gh-error-map.yaml`.
 * The `stderr_regex` field is the compiled `RegExp` instance (if present),
 * NOT the source string — callers do not recompile.
 */
interface ParsedGhErrorMapEntry {
  exit_code: number;
  stderr_regex?: RegExp;
  class: "defer" | "retry" | "needs-human";
}

export interface ParsedGhErrorMap {
  entries: ParsedGhErrorMapEntry[];
}

// ---------------------------------------------------------------------------
// Load-once cache (key = resolved absolute path)
// ---------------------------------------------------------------------------

const cache = new Map<string, ParsedGhErrorMap>();

/**
 * Resets the load-once cache between tests. Production code MUST NOT call this.
 * (AC1h / AC3i)
 */
export function __resetGhErrorMapCacheForTests(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// parseGhErrorMap
// ---------------------------------------------------------------------------

/**
 * Read and parse `gh-error-map.yaml` at `filePath`.
 *
 * - Validates via strict-mode Zod schema (no unknown top-level or per-entry keys).
 * - Compiles each `stderr_regex` string into a `RegExp` at parse time.
 * - Any validation error raises `MalformedGhErrorMapError` with the file path,
 *   reason, 1-indexed row (when applicable), and offending key (when applicable).
 * - Preserves entry order from the file (first-match semantics in classifier).
 *
 * @param filePath Absolute path to `gh-error-map.yaml`.
 */
export async function parseGhErrorMap(filePath: string): Promise<ParsedGhErrorMap> {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = yamlParse(raw) as unknown;

  const result = GhErrorMapSchema.safeParse(parsed);
  if (!result.success) {
    // Extract the first Zod error to produce a focused MalformedGhErrorMapError.
    const firstIssue = result.error.issues[0];
    if (!firstIssue) {
      throw new MalformedGhErrorMapError({ filePath, reason: result.error.message });
    }

    // Detect row index from the path (path looks like: ["entries", 2, "class"])
    let rowIndex: number | undefined;
    let offendingKey: string | undefined;

    if (
      firstIssue.path.length >= 2 &&
      firstIssue.path[0] === "entries" &&
      typeof firstIssue.path[1] === "number"
    ) {
      rowIndex = (firstIssue.path[1] as number) + 1; // 1-indexed
      const keyPart = firstIssue.path[2];
      offendingKey = typeof keyPart === "string" ? keyPart : undefined;
    } else if (firstIssue.path.length >= 1) {
      offendingKey = String(firstIssue.path[0]);
    }

    throw new MalformedGhErrorMapError({
      filePath,
      reason: firstIssue.message,
      rowIndex,
      offendingKey,
    });
  }

  // Compile stderr_regex strings into RegExp instances.
  const entries: ParsedGhErrorMapEntry[] = result.data.entries.map((entry, idx) => {
    if (entry.stderr_regex === undefined) {
      return { exit_code: entry.exit_code, class: entry.class };
    }

    let compiled: RegExp;
    try {
      compiled = new RegExp(entry.stderr_regex);
    } catch (e) {
      throw new MalformedGhErrorMapError({
        filePath,
        reason: "stderr_regex did not compile",
        rowIndex: idx + 1,
        offendingKey: "stderr_regex",
      });
    }

    return { exit_code: entry.exit_code, stderr_regex: compiled, class: entry.class };
  });

  return { entries };
}

// ---------------------------------------------------------------------------
// loadGhErrorMap (load-once cache)
// ---------------------------------------------------------------------------

/**
 * Load `gh-error-map.yaml` from `<pluginRoot>/permissions/gh-error-map.yaml`,
 * memoised by the resolved absolute path.
 *
 * Production callers pass `getPluginRoot()`. Tests inject a custom path and
 * call `__resetGhErrorMapCacheForTests()` between fixtures.
 *
 * @param pluginRoot Absolute path to the plugin root (`plugins/flow/`).
 */
export async function loadGhErrorMap(pluginRoot: string): Promise<ParsedGhErrorMap> {
  const absPath = path.resolve(pluginRoot, "permissions", "gh-error-map.yaml");
  const cached = cache.get(absPath);
  if (cached !== undefined) {
    return cached;
  }

  const parsed = await parseGhErrorMap(absPath);
  cache.set(absPath, parsed);
  return parsed;
}

// ---------------------------------------------------------------------------
// classifyGhError
// ---------------------------------------------------------------------------

/**
 * Classify a `gh` failure result against the loaded error map.
 *
 * Walks `entries` in file order. Returns the first matching class, or `null`
 * if no entry matches (unmapped → existing terminal-error path).
 *
 * Match logic per entry:
 * 1. `result.exitCode === entry.exit_code`
 * 2. If `entry.stderr_regex` is present: `entry.stderr_regex.test(result.stderr)`
 *
 * Both conditions must hold. The parser preserves entry order; for the same
 * exit code, entries with stricter regex conditions MUST appear before catch-all
 * entries in the YAML file.
 *
 * @param result  The `{ exitCode, stderr }` from the `gh` call.
 * @param map     The parsed error map returned by `parseGhErrorMap` / `loadGhErrorMap`.
 */
export function classifyGhError(
  result: { exitCode: number; stderr: string },
  map: ParsedGhErrorMap,
): "defer" | "retry" | "needs-human" | null {
  for (const entry of map.entries) {
    if (result.exitCode !== entry.exit_code) continue;
    if (entry.stderr_regex !== undefined && !entry.stderr_regex.test(result.stderr)) continue;
    return entry.class;
  }
  return null;
}
