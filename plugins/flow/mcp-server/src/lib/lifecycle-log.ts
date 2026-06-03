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

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";

/**
 * Resolve the process-group ID on POSIX. Returns `undefined` on Windows
 * or if resolution fails for any reason — fail-open, no throw.
 *
 * Implementation note: Node exposes `process.pid` and `process.ppid` but
 * not `getpgrp` as a stdlib API on most builds. We use a one-time `ps`
 * invocation at module load to read the process group, then cache the
 * result. `pgid` only changes if a process calls `setsid`/`setpgid`,
 * which the MCP server does not — so the cached value is correct for
 * the lifetime of the process.
 *
 * Story 5.30: the cascade RCA was invisible because every log line carried
 * only `pid`. With `pgid`, paired SIGTERMs across the parent + subagent
 * MCP children become a one-pass `awk` correlation.
 */
function resolvePgid(): number | undefined {
  if (os.platform() === "win32") return undefined;
  // Try the (non-stdlib but present on many Node builds) typed getpgrp first.
  try {
    const candidate = (process as unknown as { getpgrp?: () => number }).getpgrp;
    if (typeof candidate === "function") {
      const value = candidate.call(process);
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
  } catch {
    // fall through to ps
  }
  // Fallback: spawn `ps` once and parse the pgid column. POSIX-portable;
  // works on darwin + linux.
  try {
    const out = execSync(`ps -o pgid= -p ${process.pid}`, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    })
      .toString()
      .trim();
    const parsed = Number.parseInt(out, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// Resolved once at module load. `pgid` is invariant across the process
// lifetime unless the process calls setsid/setpgid (we do not).
const RESOLVED_PGID = resolvePgid();

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
export function createLifecycleLog(opts?: CreateLifecycleLogOptions): LifecycleLog {
  const logPath = resolveLogPath(opts?.path);
  let disabled = false;
  let stream: fs.WriteStream | null = null;

  // Attempt mkdir + open the stream; on any failure, set disabled.
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    stream = fs.createWriteStream(logPath, { flags: "a" });
    stream.on("error", () => {
      disabled = true;
      stream = null;
    });
  } catch {
    disabled = true;
    stream = null;
  }

  function buildLine(event: string, fields?: Record<string, unknown>): string {
    // Story 5.30: ppid and pgid are mandatory on every event so cascade-class
    // disconnects are observable from the log file alone. sessionUlid is
    // optional — included only when CREW_SESSION_ULID is set in the
    // environment (fail-open: absence is documented, not an error).
    const sessionUlid = process.env["CREW_SESSION_ULID"];
    const line: Record<string, unknown> = {
      event,
      ts: Date.now(),
      pid: process.pid,
      ppid: process.ppid,
      ...(RESOLVED_PGID !== undefined ? { pgid: RESOLVED_PGID } : {}),
      ...(sessionUlid ? { sessionUlid } : {}),
      ...fields,
    };
    return JSON.stringify(line) + "\n";
  }

  function log(event: string, fields?: Record<string, unknown>): void {
    if (disabled || stream === null) return;
    try {
      stream.write(buildLine(event, fields));
    } catch {
      // Fire-and-forget; swallow write errors silently.
    }
  }

  function logSync(event: string, fields?: Record<string, unknown>): void {
    if (disabled) return;
    try {
      fs.appendFileSync(logPath, buildLine(event, fields));
    } catch {
      // Synchronous best-effort; swallow errors silently.
    }
  }

  function close(): void {
    if (stream !== null) {
      try {
        stream.end();
      } catch {
        // Best-effort close; ignore errors.
      }
      stream = null;
    }
  }

  return { log, logSync, close };
}

/**
 * Resolve the log file path from options or environment variables.
 *
 * Priority:
 *   1. opts.path (explicit caller override — used in tests)
 *   2. CREW_MCP_LIFECYCLE_LOG env var
 *   3. CREW_MCP_DIAG env var (back-compat: if set, use its value as path)
 *   4. Default: ~/.flow/mcp-lifecycle.log
 */
function resolveLogPath(explicitPath?: string): string {
  if (explicitPath) return explicitPath;
  const envPath =
    process.env["CREW_MCP_LIFECYCLE_LOG"] ?? process.env["CREW_MCP_DIAG"];
  if (envPath) return envPath;
  return path.join(os.homedir(), ".flow", "mcp-lifecycle.log");
}
