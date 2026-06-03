#!/usr/bin/env node
/**
 * Story 5.32 — vitest fixture daemon used by proxy-spawn.test.ts (AC1).
 *
 * Binds the unix socket at $SOCKET_PATH (mandatory env), writes its pid to
 * $PID_FILE if supplied, then accepts one connection, reads one line
 * (JSON-RPC initialize), and writes back a fixed initialize-response frame.
 *
 * Stays alive for 10s after the response so the AC1 test can perform its
 * spawn-detachment assertions without the daemon exiting first.
 */
import * as net from "node:net";
import * as fs from "node:fs";

const SOCKET_PATH = process.env.SOCKET_PATH;
const PID_FILE = process.env.PID_FILE;
if (!SOCKET_PATH) {
  process.stderr.write("echo-daemon: SOCKET_PATH not set\n");
  process.exit(1);
}

if (PID_FILE) {
  fs.writeFileSync(PID_FILE, `${process.pid}\n`);
}

// Ensure no stale socket.
try {
  fs.unlinkSync(SOCKET_PATH);
} catch (err) {
  if (err.code !== "ENOENT") throw err;
}

const server = net.createServer((socket) => {
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const idx = buffer.indexOf("\n");
    if (idx === -1) return;
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    let id = 1;
    try {
      const parsed = JSON.parse(line);
      id = parsed.id ?? 1;
    } catch {
      /* keep id default */
    }
    const response = {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        serverInfo: { name: "echo-daemon", version: "0.0.1" },
      },
    };
    socket.write(JSON.stringify(response) + "\n");
  });
});

server.listen(SOCKET_PATH, () => {
  try {
    fs.chmodSync(SOCKET_PATH, 0o600);
  } catch {
    /* ignore */
  }
  // Stay alive for 10s, then clean exit.
  setTimeout(() => {
    server.close();
    process.exit(0);
  }, 10_000).unref();
});

// Signal handlers — ensure cleanup on SIGTERM/SIGINT.
const cleanup = () => {
  try {
    server.close();
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch {
    /* ignore */
  }
  process.exit(0);
};
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);
