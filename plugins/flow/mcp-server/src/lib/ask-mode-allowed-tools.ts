/**
 * `assembleAskModeAllowedTools` — deterministic helper that reads the
 * ask-mode permissions spec and returns the canonical allowed-tools array
 * for passing to a Claude Code `Task` invocation's `allowed_tools` argument.
 *
 * Story 2.8 AC2, AC5, AC6(c) — option (a) `allowed_tools` Task argument.
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
 *   - `assembleAskModeAllowedTools(pluginRoot)` — reads `permissions/ask-mode.yaml`
 *     and returns `[...tools_allow, "Read"]` (Read is always included so the
 *     subagent can read files; it is not a registered MCP tool so it does not
 *     appear in tools_allow but IS a Claude Code built-in tool name).
 *   - `ASK_MODE_TASK_ALLOWED_TOOLS` — a static snapshot of the expected array,
 *     used by tests that need a synchronous reference without IO.
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
 * Assemble the `allowed_tools` array for a Claude Code `Task` invocation
 * that opens a `/flow:ask` side-session.
 *
 * Reads `permissions/ask-mode.yaml` from `pluginRoot` via the same loader
 * used by the MCP dispatcher, then appends `"Read"` (a Claude Code built-in
 * that is not an MCP tool but must be in the Task allowlist so the subagent
 * can read files during its response).
 *
 * @param pluginRoot - Absolute path to the plugin root (e.g. the value of
 *   `getPluginRoot()` in production, or a fixture path in tests).
 * @returns Mutable copy of the allowed-tools array.
 */
export async function assembleAskModeAllowedTools(
  pluginRoot: string,
): Promise<string[]> {
  const perms = await loadRolePermissions({ role: "ask-mode", pluginRoot });
  return [...perms.tools_allow, "Read"];
}
