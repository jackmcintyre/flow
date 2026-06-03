/**
 * Stdio entrypoint referenced by `.claude-plugin/plugin.json#mcpServers`.
 *
 * Story 5.25 — Always-on MCP lifecycle logging + server-initiated keepalive.
 *
 * Story 5.12's module-level setInterval keep-alive was reverted here because
 * it fought the MCP stdio transport spec: per spec, stdin-close IS the
 * client's shutdown signal, and the kept-alive child gained nothing because
 * Claude Code has no reconnect mechanism (#36308 / #43177 / #57207). The
 * 5.12 keep-alive produced a zombie process that SIGTERM eventually reached
 * anyway.
 *
 * The durable mechanism (this file) is:
 *   • Server-initiated keepalive pings (AC2) — prevent the parent's idle
 *     timer from firing in the first place; the client auto-pongs per spec.
 *   • Persistent lifecycle log (AC1) — every process/transport event is
 *     written to ~/.flow/mcp-lifecycle.log so disconnects are observable.
 *   • Crash-resilience handlers (AC3) — uncaughtException, unhandledRejection,
 *     stdout EPIPE are logged but do not crash the server.
 *   • Signal handlers (AC3) — SIGTERM/SIGINT/SIGHUP log before exiting with
 *     the conventional exit codes (143/130/129).
 *   • stdin listeners (AC4) — log-only; no shutdown suppression.
 *
 * References:
 *   - Story spec:  _bmad-output/implementation-artifacts/5-25-always-on-mcp-lifecycle-logging.md
 *   - Postmortem:  _bmad-output/postmortems/2026-05-25-dogfood-rollback.md § L1 defect #1
 *   - Memory:      project_mcp_server_silent_disconnect
 */
export {};
