/**
 * Always-on JSON-line lifecycle logger for the flow MCP server (Story 5.25).
 *
 * Writes one JSON line per event to a persistent log file so that every
 * disconnect reveals its trigger. Logging is fail-open — an unwritable log
 * path never crashes the server.
 *
 * Default log path: ~/.flow/mcp-lifecycle.log
 * Override via: CREW_MCP_LIFECYCLE_LOG env var
 * Back-compat:  CREW_MCP_DIAG env var (used as path if LIFECYCLE_LOG unset)
 *
 * References:
 *   - Story 5.25 spec: _bmad-output/implementation-artifacts/5-25-always-on-mcp-lifecycle-logging.md
 *   - Project memory: project_diag_instrumentation_pattern
 */
export interface LifecycleLog {
    /** Fire-and-forget async log — suitable for most event sites. */
    log(event: string, fields?: Record<string, unknown>): void;
    /**
     * Synchronous log for use in signal handlers and process.on('exit') where
     * async writes may not complete before the process terminates.
     * Uses fs.appendFileSync to guarantee the line lands on disk before returning.
     */
    logSync(event: string, fields?: Record<string, unknown>): void;
    close(): void;
}
export interface CreateLifecycleLogOptions {
    path?: string;
}
/**
 * Create a lifecycle logger.
 *
 * Returns `{ log, logSync, close }`. `log` is fire-and-forget; `logSync` is
 * synchronous (for signal handlers). Errors in the underlying WriteStream
 * silently disable further writes without crashing.
 * `close()` flushes pending writes and ends the stream; call it from
 * `process.on('exit')` after logging the final 'exit' event.
 */
export declare function createLifecycleLog(opts?: CreateLifecycleLogOptions): LifecycleLog;
