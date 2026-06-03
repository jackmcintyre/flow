/**
 * Unit tests for lifecycle-log.ts (Story 5.25, Task 1.5).
 *
 * Covers:
 *   (a) writes a JSON line per call
 *   (b) survives unwritable path without throwing
 *   (c) honours the CREW_MCP_LIFECYCLE_LOG env var
 *   (d) CREW_MCP_DIAG env var falls back when LIFECYCLE_LOG unset
 *   (e) close() flushes pending writes
 */
export {};
