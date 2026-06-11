/**
 * Direct unit tests for the session-liveness primitive — Story native:01KTSQWJ.
 *
 * The consumer tests (liveness-before-reclaim, reap-stale-worktrees-liveness)
 * inject a mock `isSessionAliveImpl`, so before this file the real writer +
 * window/pid logic had NO direct coverage. These tests exercise the real
 * `writeSessionHeartbeat` → `isSessionAlive` round-trip on a tmpdir, and pin the
 * staleness-window and pid-liveness branches of `isSessionAlive`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  writeSessionHeartbeat,
  isSessionAlive,
} from "../session-liveness.js";
import { atomicWriteFile } from "../managed-fs.js";

let root: string;
const SU = "01KTSQWJ62C4XQBDK4NXTEPQC0";
// Heartbeat path is an internal detail of the module; the test reconstructs it
// the same way the module does (sessions/<ulid>/heartbeat.json).
const hbPath = () =>
  path.join(root, ".flow", "state", "sessions", SU, "heartbeat.json");

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "flow-liveness-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("writeSessionHeartbeat", () => {
  it("writes a parseable {pid, updatedAt} heartbeat at the session path", async () => {
    await writeSessionHeartbeat(root, SU);
    const raw = await fs.readFile(hbPath(), "utf8");
    const payload = JSON.parse(raw) as { pid: number; updatedAt: string };
    expect(payload.pid).toBe(process.pid);
    expect(Number.isFinite(new Date(payload.updatedAt).getTime())).toBe(true);
  });

  it("is idempotent / last-writer-wins (refresh overwrites the timestamp)", async () => {
    await writeSessionHeartbeat(root, SU);
    const first = JSON.parse(await fs.readFile(hbPath(), "utf8")) as { updatedAt: string };
    await writeSessionHeartbeat(root, SU);
    const second = JSON.parse(await fs.readFile(hbPath(), "utf8")) as { updatedAt: string };
    // Same file, still exactly one heartbeat; second write is a clean overwrite.
    expect(new Date(second.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(first.updatedAt).getTime(),
    );
  });
});

describe("isSessionAlive", () => {
  it("round-trips: a freshly-written heartbeat for the live process reads alive", async () => {
    await writeSessionHeartbeat(root, SU);
    // Real pid (process.pid) is alive; timestamp is fresh.
    expect(await isSessionAlive(root, SU)).toBe(true);
  });

  it("returns false (fail-safe) when no heartbeat file exists", async () => {
    expect(await isSessionAlive(root, SU)).toBe(false);
  });

  it("returns false when the heartbeat timestamp is stale beyond the 30-min window", async () => {
    await writeSessionHeartbeat(root, SU);
    // 31 minutes later, the same live pid is irrelevant — stale timestamp = dead.
    const future = Date.now() + 31 * 60_000;
    expect(
      await isSessionAlive(root, SU, {
        nowMs: future,
        killImpl: () => {}, // pid "alive"
      }),
    ).toBe(false);
  });

  it("stays alive at ~20 min (one build) but dead past 30 min — the window brackets a build", async () => {
    await writeSessionHeartbeat(root, SU);
    const base = Date.now();
    const live = { killImpl: () => {} };
    // ~20 min (a full build) → still within the 30-min window → alive.
    expect(await isSessionAlive(root, SU, { nowMs: base + 20 * 60_000, ...live })).toBe(true);
    // Past 30 min without a refresh → dead.
    expect(await isSessionAlive(root, SU, { nowMs: base + 31 * 60_000, ...live })).toBe(false);
  });

  it("returns false when the pid is gone (kill throws ESRCH)", async () => {
    await writeSessionHeartbeat(root, SU);
    const esrch = () => {
      const e = new Error("no such process") as NodeJS.ErrnoException;
      e.code = "ESRCH";
      throw e;
    };
    expect(await isSessionAlive(root, SU, { killImpl: esrch })).toBe(false);
  });

  it("returns true when the pid exists but is owned by another user (EPERM)", async () => {
    await writeSessionHeartbeat(root, SU);
    const eperm = () => {
      const e = new Error("operation not permitted") as NodeJS.ErrnoException;
      e.code = "EPERM";
      throw e;
    };
    expect(await isSessionAlive(root, SU, { killImpl: eperm })).toBe(true);
  });

  it("returns false on a malformed heartbeat file", async () => {
    // Route the fixture write through the sanctioned atomic writer (the
    // canonical-fs-guard forbids raw write-shaped fs APIs anywhere under src/**).
    await atomicWriteFile(hbPath(), "not json");
    expect(await isSessionAlive(root, SU)).toBe(false);
  });
});
