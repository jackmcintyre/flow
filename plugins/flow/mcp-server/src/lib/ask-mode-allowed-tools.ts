/**
 * `assembleAskModeAllowedTools` — deterministic helper that reads the
 * ask-mode permissions spec and returns the canonical allowed-tools array
 * for passing to a Claude Code `Task` invocation's `allowed_tools` argument.
 *
 * Story 2.8 AC2, AC5, AC6(c) — option (a) `allowed_tools` Task argument.
 * Story native:01KVPR1REEC5Y90FKFDCKNNADC — union with the consulted role's
 *   own declared read-only tools.
 *
 * **Enforcement rationale (ask-mode-enforcement.md):**
 * Claude Code's `Task` tool propagation of `_meta.role` through to spawned
 * subagent MCP `CallTool` requests could not be empirically confirmed within
 * this story's scope (no live Claude Code session available to the dev agent).
 * The verdict is "unknown-but-belt-and-braces". As defence-in-depth, the
 * skill body's Step 5 passes `allowed_tools` to the `Task` invocation so the
 * spawned subagent's tool surface is constrained at the Claude Code layer —
 * independently of whether `_meta.role` propagates.
 *
 * This helper exports:
 *   - `assembleAskModeAllowedTools(pluginRoot, role?)` — reads
 *     `permissions/ask-mode.yaml`, optionally unions with the consulted
 *     role's own declared read-only tools, and always appends `"Read"`.
 *     When `role` is provided and a permissions file exists for it at
 *     `pluginRoot/permissions/<role>.yaml`, the helper reads that file,
 *     filters its `tools_allow` to read-shaped tools only (names that
 *     start with `get`, `read`, or `lookup`, or equal `heartbeat`), and
 *     merges the result into the shared ask-mode set (de-duped). If the
 *     role's permissions file does not exist or cannot be loaded the
 *     helper silently falls back to the shared set alone — the non-
 *     mutation boundary is never widened by a load failure.
 *   - `ASK_MODE_TASK_ALLOWED_TOOLS` — a static snapshot of the shared-
 *     only expected array, used by tests that need a synchronous
 *     reference without IO (no role unioned in).
 *   - `isReadShapedTool(name)` — predicate exported for tests to assert
 *     the read-shape classification without coupling to the implementation.
 *
 * (FR109, NFR12)
 */

import { loadRolePermissions } from "../state/load-role-permissions.js";

/**
 * Static snapshot of the ask-mode tool allowlist as shipped by Story 2.7.
 * Tests use this constant to assert the helper returns the right set without
 * round-tripping through the filesystem.
 *
 * IMPORTANT: keep in sync with `plugins/flow/permissions/ask-mode.yaml`.
 * The AC6(h) test asserts the YAML file's content against this constant.
 *
 * This constant reflects the SHARED set only (no role-specific additions).
 */
export const ASK_MODE_TASK_ALLOWED_TOOLS: readonly string[] = [
  // MCP tools from ask-mode.yaml tools_allow (read-shaped)
  "heartbeat",
  "readPersona",
  "readCatalogue",
  "lookupRoleByDomain",
  "readRepoSignals",
  "readCustomRole",
  "getStatus",
  "getTeamSnapshot",
  // Claude Code built-in read tool (not an MCP tool; always safe to include)
  "Read",
] as const;

/**
 * The name prefixes and exact names that qualify a tool as "read-shaped" for
 * the purposes of the ask-mode union allowlist.
 *
 * A tool is read-shaped if:
 *   - Its name starts with "get", "read", or "lookup" (case-sensitive), OR
 *   - Its name is exactly "heartbeat".
 *
 * This classification is the gating predicate used when unioning a consulted
 * role's declared tools into the ask-mode allowlist. Write-capable or state-
 * mutating tools that do not match this predicate are NEVER admitted.
 */
const READ_SHAPED_PREFIXES = ["get", "read", "lookup"] as const;
const READ_SHAPED_EXACT = new Set(["heartbeat"]);

/**
 * Returns `true` when `name` is read-shaped (safe to include in the ask-mode
 * union allowlist). Exported so tests can assert the classification directly.
 */
export function isReadShapedTool(name: string): boolean {
  if (READ_SHAPED_EXACT.has(name)) return true;
  return READ_SHAPED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Assemble the `allowed_tools` array for a Claude Code `Task` invocation
 * that opens a `/flow:ask` side-session.
 *
 * Reads `permissions/ask-mode.yaml` from `pluginRoot` via the same loader
 * used by the MCP dispatcher, then appends `"Read"` (a Claude Code built-in
 * that is not an MCP tool but must be in the Task allowlist so the subagent
 * can read files during its response).
 *
 * When `role` is supplied, the helper additionally loads
 * `permissions/<role>.yaml` (from the same `pluginRoot`), filters
 * `tools_allow` to read-shaped tools only, and merges those into the result
 * (de-duped). If the role's permissions file is missing or malformed the
 * helper silently returns the shared set — a load error MUST NOT widen the
 * mutation boundary.
 *
 * @param pluginRoot - Absolute path to the plugin root (e.g. the value of
 *   `getPluginRoot()` in production, or a fixture path in tests).
 * @param role - Optional. The consulted role's id. When provided, its
 *   declared read-only tools are unioned into the result.
 * @returns Mutable copy of the allowed-tools array (shared set, plus the
 *   role's read-shaped tools when `role` is provided, de-duped).
 */
export async function assembleAskModeAllowedTools(
  pluginRoot: string,
  role?: string,
): Promise<string[]> {
  const sharedPerms = await loadRolePermissions({ role: "ask-mode", pluginRoot });
  const sharedSet = new Set([...sharedPerms.tools_allow, "Read"]);

  if (role !== undefined) {
    try {
      const rolePerms = await loadRolePermissions({ role, pluginRoot });
      for (const tool of rolePerms.tools_allow) {
        if (isReadShapedTool(tool)) {
          sharedSet.add(tool);
        }
      }
    } catch {
      // Role permissions file missing or malformed — fall back to shared set.
      // Fail-safe: a load error must NEVER widen the mutation boundary.
    }
  }

  return [...sharedSet];
}
