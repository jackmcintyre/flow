/**
 * Stateless CLI shim over the crew tool functions (Story 8.4; spike-proven 2026-05-29).
 *
 * Purpose: invoke the existing MCP tool *logic* as one-shot processes, with NO
 * persistent MCP server in the loop. Each invocation runs a tool function over
 * the filesystem and exits — so the cascade-SIGTERM (which only kills a
 * long-lived stdio server child sitting in the host's process group) cannot
 * occur by construction. Consumed by the spike `drain` workflow's seam-agents,
 * which shell out to this CLI and read the JSON it prints.
 *
 * Usage:
 *   node dist/cli.js <toolName> --json '<argsJSON>'
 *   node dist/cli.js <toolName> '<argsJSON>'        # positional fallback
 *   node dist/cli.js mintSessionUlid                # no-arg tools
 *
 * Always prints a single JSON line to stdout. On success: the tool's structured
 * result (non-serialisable fields such as a returned cleanup() closure are
 * dropped by JSON.stringify). On failure: {"error":{...}} and a non-zero exit
 * (2 for a typed DomainError, 1 otherwise, 64/65 for usage errors).
 *
 * This is the one-shot seam transport the stateless `drain` workflow's seam-agents
 * shell out to — no persistent MCP server on the drain path. Reuses every tool
 * function unchanged; see plugins/flow/mcp-server/src/tools/register.ts for the
 * same functions wired to the MCP transport (interactive skills still use that).
 */
export {};
