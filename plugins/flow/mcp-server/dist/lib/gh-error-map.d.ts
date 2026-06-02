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
/**
 * A parsed and validated entry from `gh-error-map.yaml`.
 * The `stderr_regex` field is the compiled `RegExp` instance (if present),
 * NOT the source string — callers do not recompile.
 */
export interface ParsedGhErrorMapEntry {
    exit_code: number;
    stderr_regex?: RegExp;
    class: "defer" | "retry" | "needs-human";
}
export interface ParsedGhErrorMap {
    entries: ParsedGhErrorMapEntry[];
}
/**
 * Resets the load-once cache between tests. Production code MUST NOT call this.
 * (AC1h / AC3i)
 */
export declare function __resetGhErrorMapCacheForTests(): void;
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
export declare function parseGhErrorMap(filePath: string): Promise<ParsedGhErrorMap>;
/**
 * Load `gh-error-map.yaml` from `<pluginRoot>/permissions/gh-error-map.yaml`,
 * memoised by the resolved absolute path.
 *
 * Production callers pass `getPluginRoot()`. Tests inject a custom path and
 * call `__resetGhErrorMapCacheForTests()` between fixtures.
 *
 * @param pluginRoot Absolute path to the plugin root (`plugins/flow/`).
 */
export declare function loadGhErrorMap(pluginRoot: string): Promise<ParsedGhErrorMap>;
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
export declare function classifyGhError(result: {
    exitCode: number;
    stderr: string;
}, map: ParsedGhErrorMap): "defer" | "retry" | "needs-human" | null;
