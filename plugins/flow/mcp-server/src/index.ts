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

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { registerAllTools } from "./tools/register.js";
import { createLifecycleLog } from "./lib/lifecycle-log.js";
import { getPluginVersion } from "./lib/plugin-version.js";

// ---------------------------------------------------------------------------
// Task 2: Instantiate the lifecycle log at module load (before any imports
// that could fail) so crash-resilience handlers can use it immediately.
// ---------------------------------------------------------------------------

const lifecycle = createLifecycleLog();

// ---------------------------------------------------------------------------
// Task 2.2 / 2.3 / 2.4: Crash-resilience handlers (AC3)
// Install at module load — before main() — so they catch synchronous init
// failures too. These handlers do NOT call process.exit().
// ---------------------------------------------------------------------------

process.on("uncaughtException", (err: Error) => {
  lifecycle.log("uncaughtException", {
    name: err.name,
    message: err.message,
    stack: err.stack,
  });
});

process.on("unhandledRejection", (reason: unknown) => {
  lifecycle.log("unhandledRejection", {
    reason: String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

// Catches EPIPE when the parent closes its read end of the pipe.
// Without this handler, Node's default behaviour is to emit an unhandled
// 'error' event, which crashes the process.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  lifecycle.log("stdout.error", {
    code: err.code,
    message: err.message,
  });
});

// ---------------------------------------------------------------------------
// Task 3: Signal and exit logging (AC1, AC3)
// Adding ANY signal listener prevents Node's default termination for that
// signal, so we must call process.exit() explicitly with the conventional
// exit code (128 + signal number).
// ---------------------------------------------------------------------------

// Signal handlers use logSync to guarantee the line lands on disk before
// process.exit() terminates the process. Async stream.write() may not flush
// in time; appendFileSync is synchronous and therefore reliable here.
process.on("SIGTERM", () => {
  lifecycle.logSync("signal", { name: "SIGTERM" });
  process.exit(143); // 128 + 15
});

process.on("SIGINT", () => {
  lifecycle.logSync("signal", { name: "SIGINT" });
  process.exit(130); // 128 + 2
});

process.on("SIGHUP", () => {
  lifecycle.logSync("signal", { name: "SIGHUP" });
  process.exit(129); // 128 + 1
});

process.on("beforeExit", (code: number) => {
  lifecycle.log("beforeExit", { code });
});

// exit handler uses logSync so the line lands before the OS reclaims the fd.
process.on("exit", (code: number) => {
  lifecycle.logSync("exit", { code });
  lifecycle.close();
});

// ---------------------------------------------------------------------------
// main: boot, connect transport, wire keepalive + stdin shutdown
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Task 6.1: Log boot with version info (AC1)
  lifecycle.log("boot", {
    version: getPluginVersion(),
    nodeVersion: process.version,
  });

  const server = createServer();
  registerAllTools(server);

  const transport = new StdioServerTransport();

  // Task 6.4: Hook transport.onclose to log the event before the SDK's
  // handler runs. The SDK's Protocol.connect() chains callbacks so both
  // our hook and the SDK's internal handler fire.
  const existingOnClose = transport.onclose;
  transport.onclose = () => {
    lifecycle.log("transport.onclose");
    if (existingOnClose) existingOnClose();
  };

  await server.connect(transport);

  // Task 4.3: Logging-only stdin listeners + clean shutdown on end (AC4).
  // The SDK's StdioServerTransport does NOT listen for stdin 'end'/'close',
  // so we must handle the clean shutdown ourselves. Per MCP spec, stdin close
  // is the client's shutdown signal — we honour it by closing the server and
  // exiting cleanly (code 0). No suppression, no keep-alive zombie.
  process.stdin.on("end", () => {
    lifecycle.log("stdin.end");
    // Close the server (tears down the transport, clears handlers) then exit
    // cleanly. Use void to avoid unhandled-rejection if close() rejects.
    void server.close().catch(() => {
      /* ignore close errors on shutdown */
    });
    process.exit(0);
  });

  process.stdin.on("close", () => {
    lifecycle.log("stdin.close");
  });

  // Task 6.2: Log successful transport connection (AC1)
  lifecycle.log("transport.connected");

  // Task 5: Server-initiated keepalive ping (AC2)
  // The SDK's Server class exposes server.ping() which sends a JSON-RPC
  // ping request. The client (Claude Code) auto-pongs via the SDK's
  // Protocol class ping-handler. The timer is unref'd so it does NOT
  // hold the event loop alive after the transport tears down — preventing
  // the zombie process that Story 5.12's keep-alive introduced.
  const intervalMs = Number(process.env["FLOW_MCP_KEEPALIVE_MS"] ?? 300_000);
  if (intervalMs > 0) {
    const pingTimer = setInterval(() => {
      void sendPing();
    }, intervalMs);
    pingTimer.unref(); // critical: must not prevent clean shutdown
  } else {
    lifecycle.log("keepalive.disabled", { intervalMs });
  }

  async function sendPing(): Promise<void> {
    lifecycle.log("keepalive.sent", { intervalMs });
    const t0 = Date.now();
    try {
      await server.ping();
      lifecycle.log("keepalive.response", { latencyMs: Date.now() - t0 });
    } catch (err) {
      lifecycle.log("keepalive.error", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
