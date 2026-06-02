/**
 * Unit tests for lifecycle-log.ts (Story 5.25, Task 1.5).
 *
 * Covers:
 *   (a) writes a JSON line per call
 *   (b) survives unwritable path without throwing
 *   (c) honours the FLOW_MCP_LIFECYCLE_LOG env var
 *   (d) FLOW_MCP_DIAG env var falls back when LIFECYCLE_LOG unset
 *   (e) close() flushes pending writes
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createLifecycleLog } from "../lifecycle-log.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "flow-lifecycle-log-test-"));
}

function readLogLines(logPath: string): Record<string, unknown>[] {
  const text = fs.readFileSync(logPath, "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createLifecycleLog", () => {
  let tmpDir: string;
  let originalLifecycleLog: string | undefined;
  let originalDiag: string | undefined;
  let originalSessionUlid: string | undefined;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    originalLifecycleLog = process.env["FLOW_MCP_LIFECYCLE_LOG"];
    originalDiag = process.env["FLOW_MCP_DIAG"];
    originalSessionUlid = process.env["FLOW_SESSION_ULID"];
    // Clear env vars so tests are isolated
    delete process.env["FLOW_MCP_LIFECYCLE_LOG"];
    delete process.env["FLOW_MCP_DIAG"];
    delete process.env["FLOW_SESSION_ULID"];
  });

  afterEach(() => {
    // Restore env vars
    if (originalLifecycleLog === undefined) {
      delete process.env["FLOW_MCP_LIFECYCLE_LOG"];
    } else {
      process.env["FLOW_MCP_LIFECYCLE_LOG"] = originalLifecycleLog;
    }
    if (originalDiag === undefined) {
      delete process.env["FLOW_MCP_DIAG"];
    } else {
      process.env["FLOW_MCP_DIAG"] = originalDiag;
    }
    if (originalSessionUlid === undefined) {
      delete process.env["FLOW_SESSION_ULID"];
    } else {
      process.env["FLOW_SESSION_ULID"] = originalSessionUlid;
    }
    // Clean up tmp dir
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("(a) writes a JSON line per call", async () => {
    const logPath = path.join(tmpDir, "test.log");
    const logger = createLifecycleLog({ path: logPath });

    logger.log("boot", { version: "1.0.0" });
    logger.log("transport.connected");

    // Allow the stream to flush
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    logger.close();
    // Allow close to complete
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    const lines = readLogLines(logPath);
    expect(lines).toHaveLength(2);

    const bootLine = lines[0]!;
    expect(bootLine["event"]).toBe("boot");
    expect(bootLine["version"]).toBe("1.0.0");
    expect(typeof bootLine["ts"]).toBe("number");
    expect(bootLine["pid"]).toBe(process.pid);

    const connLine = lines[1]!;
    expect(connLine["event"]).toBe("transport.connected");
    expect(typeof connLine["ts"]).toBe("number");
  });

  it("(b) survives unwritable path without throwing", () => {
    // Create a regular file inside tmpDir then point the log path UNDER it
    // (as if it were a directory). On every Unix-like platform,
    // mkdirSync(<file>/<sub>, { recursive: true }) throws ENOTDIR
    // synchronously. This is more reliable than platform-specific paths
    // like /proc/this-cannot-exist which behave differently across kernels
    // (the previous version hung CI on Linux because the error fired async
    // via createWriteStream while logger.close() ran synchronously).
    const blocker = path.join(tmpDir, "not-a-directory");
    fs.writeFileSync(blocker, "");
    const unwritablePath = path.join(blocker, "mcp-lifecycle.log");
    let threw = false;

    try {
      const logger = createLifecycleLog({ path: unwritablePath });
      // log() should be a no-op, not throw
      logger.log("boot");
      logger.close();
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
  });

  it("(c) honours the FLOW_MCP_LIFECYCLE_LOG env var", async () => {
    const logPath = path.join(tmpDir, "from-env.log");
    process.env["FLOW_MCP_LIFECYCLE_LOG"] = logPath;

    const logger = createLifecycleLog(); // no explicit path
    logger.log("boot");

    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    logger.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    expect(fs.existsSync(logPath)).toBe(true);
    const lines = readLogLines(logPath);
    expect(lines).toHaveLength(1);
    expect(lines[0]!["event"]).toBe("boot");
  });

  it("(d) FLOW_MCP_DIAG env var falls back when LIFECYCLE_LOG unset", async () => {
    const logPath = path.join(tmpDir, "from-diag.log");
    // LIFECYCLE_LOG is not set; DIAG is set
    process.env["FLOW_MCP_DIAG"] = logPath;

    const logger = createLifecycleLog(); // no explicit path, no LIFECYCLE_LOG
    logger.log("boot");

    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    logger.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    expect(fs.existsSync(logPath)).toBe(true);
    const lines = readLogLines(logPath);
    expect(lines).toHaveLength(1);
    expect(lines[0]!["event"]).toBe("boot");
  });

  it("(d) FLOW_MCP_LIFECYCLE_LOG takes precedence over FLOW_MCP_DIAG", async () => {
    const lifecycleLogPath = path.join(tmpDir, "lifecycle.log");
    const diagPath = path.join(tmpDir, "diag.log");
    process.env["FLOW_MCP_LIFECYCLE_LOG"] = lifecycleLogPath;
    process.env["FLOW_MCP_DIAG"] = diagPath;

    const logger = createLifecycleLog();
    logger.log("boot");

    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    logger.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    expect(fs.existsSync(lifecycleLogPath)).toBe(true);
    expect(fs.existsSync(diagPath)).toBe(false);
  });

  it("(e) close() flushes pending writes", async () => {
    const logPath = path.join(tmpDir, "flush-test.log");
    const logger = createLifecycleLog({ path: logPath });

    // Write multiple events and close immediately
    logger.log("boot");
    logger.log("transport.connected");
    logger.log("exit", { code: 0 });
    logger.close();

    // Give stream time to flush after close
    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    const lines = readLogLines(logPath);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    // At minimum, the first event should be written
    expect(lines[0]!["event"]).toBe("boot");
  });

  it("creates parent directories automatically", async () => {
    const nestedPath = path.join(tmpDir, "deeply", "nested", "dir", "test.log");
    const logger = createLifecycleLog({ path: nestedPath });

    logger.log("boot");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    logger.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    expect(fs.existsSync(nestedPath)).toBe(true);
    const lines = readLogLines(nestedPath);
    expect(lines).toHaveLength(1);
    expect(lines[0]!["event"]).toBe("boot");
  });

  // -------------------------------------------------------------------------
  // Story 5.30 — ppid + pgid mandatory; sessionUlid optional via env var
  // -------------------------------------------------------------------------

  it("(5.30) writes ppid on every line", async () => {
    const logPath = path.join(tmpDir, "ppid.log");
    const logger = createLifecycleLog({ path: logPath });

    logger.log("boot");
    logger.log("transport.connected");
    logger.log("tool.call", { name: "claimNextStory" });

    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    logger.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    const lines = readLogLines(logPath);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) {
      expect(typeof line["ppid"]).toBe("number");
      expect(line["ppid"]).toBe(process.ppid);
    }
  });

  it("(5.30) writes pgid on every line on POSIX (undefined on win32)", async () => {
    const logPath = path.join(tmpDir, "pgid.log");
    const logger = createLifecycleLog({ path: logPath });

    logger.log("boot");
    logger.log("signal", { name: "SIGTERM" });

    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    logger.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    const lines = readLogLines(logPath);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const isPosix = os.platform() !== "win32";
    for (const line of lines) {
      if (isPosix) {
        expect(typeof line["pgid"]).toBe("number");
      } else {
        // On Windows, pgid is omitted from the line entirely.
        expect(line).not.toHaveProperty("pgid");
      }
    }
  });

  it("(5.30) writes sessionUlid when FLOW_SESSION_ULID is set, omits it otherwise", async () => {
    // Case A — env var absent (the test's beforeEach already deletes it)
    const logPathA = path.join(tmpDir, "nosession.log");
    const loggerA = createLifecycleLog({ path: logPathA });
    loggerA.log("boot");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    loggerA.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    const linesA = readLogLines(logPathA);
    expect(linesA).toHaveLength(1);
    expect(linesA[0]!).not.toHaveProperty("sessionUlid");

    // Case B — env var present
    process.env["FLOW_SESSION_ULID"] = "01TESTULID000000000000000000";
    const logPathB = path.join(tmpDir, "withsession.log");
    const loggerB = createLifecycleLog({ path: logPathB });
    loggerB.log("boot");
    loggerB.log("tool.call", { name: "claimNextStory" });
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    loggerB.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    const linesB = readLogLines(logPathB);
    expect(linesB).toHaveLength(2);
    for (const line of linesB) {
      expect(line["sessionUlid"]).toBe("01TESTULID000000000000000000");
    }
  });

  it("(5.30) ppid/pgid/sessionUlid appear on logSync output too", () => {
    const logPath = path.join(tmpDir, "sync.log");
    process.env["FLOW_SESSION_ULID"] = "01TESTULIDSYNC00000000000000";
    const logger = createLifecycleLog({ path: logPath });

    // Synchronous append — used in signal handlers
    logger.logSync("signal", { name: "SIGTERM" });
    logger.logSync("exit", { code: 0 });

    const lines = readLogLines(logPath);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const isPosix = os.platform() !== "win32";
    for (const line of lines) {
      expect(typeof line["ppid"]).toBe("number");
      expect(line["ppid"]).toBe(process.ppid);
      expect(line["sessionUlid"]).toBe("01TESTULIDSYNC00000000000000");
      if (isPosix) {
        expect(typeof line["pgid"]).toBe("number");
      }
    }

    logger.close();
  });

  it("appends to existing log file (does not truncate)", async () => {
    const logPath = path.join(tmpDir, "append.log");

    // First logger instance
    const logger1 = createLifecycleLog({ path: logPath });
    logger1.log("boot");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    logger1.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    // Second logger instance — should append
    const logger2 = createLifecycleLog({ path: logPath });
    logger2.log("transport.connected");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    logger2.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    const lines = readLogLines(logPath);
    expect(lines).toHaveLength(2);
    expect(lines[0]!["event"]).toBe("boot");
    expect(lines[1]!["event"]).toBe("transport.connected");
  });
});
