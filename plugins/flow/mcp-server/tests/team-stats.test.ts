/**
 * Story 2.6 AC2, AC3 — unit tests for `lib/team-stats.ts`.
 *
 * See `plugins/flow/docs/user-surface-acs.md` for the user-surface AC
 * rubric (Story 1.8 convention). AC2 and AC3 are NOT user-surface (the
 * operator never types `pnpm --dir plugins/flow test`).
 */
import { afterAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { readTeamTelemetryStats } from "../src/lib/team-stats.js";
import { logTelemetryEvent } from "../src/lib/logger.js";

const tmpDirs: string[] = [];

afterAll(async () => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try {
      await fs.rm(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

async function makeRepo(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(root);
  return root;
}

async function makeTelemetryDir(root: string): Promise<string> {
  const dir = path.join(root, ".flow", "telemetry");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function writeJsonlLines(filePath: string, lines: string[]): Promise<void> {
  await fs.writeFile(filePath, lines.map((l) => l + "\n").join(""), "utf8");
}

// ---------------------------------------------------------------------------
// Task 3.2(a) — no telemetry directory
// ---------------------------------------------------------------------------
describe("readTeamTelemetryStats — no telemetry dir (Task 3.2a)", () => {
  it("returns empty stats when .flow/telemetry does not exist", async () => {
    const root = await makeRepo("team-stats-no-dir-");
    const stats = await readTeamTelemetryStats({ targetRepoRoot: root });
    expect(stats).toEqual({ fireCountsByAgent: {}, malformedLines: 0, malformedFiles: 0 });
  });
});

// ---------------------------------------------------------------------------
// Task 3.2(b) — valid agent.invoke events
// ---------------------------------------------------------------------------
describe("readTeamTelemetryStats — valid events (Task 3.2b)", () => {
  it("counts per-agent invocations from one month file", async () => {
    const root = await makeRepo("team-stats-valid-");
    await makeTelemetryDir(root);

    const NOW_A = "2026-05-01T10:00:00.000Z";
    const NOW_B = "2026-05-01T11:00:00.000Z";
    const NOW_C = "2026-05-01T12:00:00.000Z";

    await logTelemetryEvent({
      targetRepoRoot: root,
      event: {
        type: "agent.invoke",
        session_id: "s1",
        agent: "planner",
        data: { runtime_ms: 100 },
        ts: NOW_A,
      },
      now: () => new Date(NOW_A),
    });
    await logTelemetryEvent({
      targetRepoRoot: root,
      event: {
        type: "agent.invoke",
        session_id: "s2",
        agent: "generalist-dev",
        data: { runtime_ms: 200 },
        ts: NOW_B,
      },
      now: () => new Date(NOW_B),
    });
    await logTelemetryEvent({
      targetRepoRoot: root,
      event: {
        type: "agent.invoke",
        session_id: "s3",
        agent: "planner",
        data: { runtime_ms: 150 },
        ts: NOW_C,
      },
      now: () => new Date(NOW_C),
    });

    const stats = await readTeamTelemetryStats({ targetRepoRoot: root });
    expect(stats.fireCountsByAgent).toEqual({ planner: 2, "generalist-dev": 1 });
    expect(stats.malformedLines).toBe(0);
    expect(stats.malformedFiles).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Task 3.2(c) — mixed valid + malformed lines
// ---------------------------------------------------------------------------
describe("readTeamTelemetryStats — mixed valid + malformed lines (Task 3.2c)", () => {
  it("counts malformed lines and files correctly", async () => {
    const root = await makeRepo("team-stats-malformed-");
    const dir = await makeTelemetryDir(root);
    const filePath = path.join(dir, "2026-05.jsonl");

    // Two valid agent.invoke lines + one JSON-parse failure + one Zod failure
    const validLine = JSON.stringify({
      ts: "2026-05-01T10:00:00.000Z",
      type: "agent.invoke",
      session_id: "s1",
      agent: "planner",
      data: { runtime_ms: 100 },
    });
    const validLine2 = JSON.stringify({
      ts: "2026-05-01T11:00:00.000Z",
      type: "agent.invoke",
      session_id: "s2",
      agent: "generalist-dev",
      data: { runtime_ms: 200 },
    });
    const badJson = "{ bad json";
    // Valid JSON but missing `data` field → Zod failure
    const zodFail = JSON.stringify({
      ts: "2026-05-01T12:00:00.000Z",
      type: "agent.invoke",
      session_id: "s3",
      agent: "planner",
    });

    await writeJsonlLines(filePath, [validLine, badJson, validLine2, zodFail]);

    const stats = await readTeamTelemetryStats({ targetRepoRoot: root });
    expect(stats.fireCountsByAgent).toEqual({ planner: 1, "generalist-dev": 1 });
    expect(stats.malformedLines).toBe(2); // badJson + zodFail
    expect(stats.malformedFiles).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Task 3.2(d) — two month files, counts aggregate
// ---------------------------------------------------------------------------
describe("readTeamTelemetryStats — two month files (Task 3.2d)", () => {
  it("aggregates fire counts across both files", async () => {
    const root = await makeRepo("team-stats-two-months-");
    const dir = await makeTelemetryDir(root);

    const aprilLine = JSON.stringify({
      ts: "2026-04-01T10:00:00.000Z",
      type: "agent.invoke",
      session_id: "s1",
      agent: "planner",
      data: { runtime_ms: 100 },
    });
    const mayLine = JSON.stringify({
      ts: "2026-05-01T10:00:00.000Z",
      type: "agent.invoke",
      session_id: "s2",
      agent: "planner",
      data: { runtime_ms: 200 },
    });

    await writeJsonlLines(path.join(dir, "2026-04.jsonl"), [aprilLine]);
    await writeJsonlLines(path.join(dir, "2026-05.jsonl"), [mayLine]);

    const stats = await readTeamTelemetryStats({ targetRepoRoot: root });
    expect(stats.fireCountsByAgent).toEqual({ planner: 2 });
    expect(stats.malformedLines).toBe(0);
    expect(stats.malformedFiles).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Task 3.2(e) — unusual filename (lexically matching but invalid calendar)
// ---------------------------------------------------------------------------
describe("readTeamTelemetryStats — invalid month in filename (Task 3.2e)", () => {
  it("reads a 2026-13.jsonl file (no calendar validation in v1)", async () => {
    const root = await makeRepo("team-stats-badmonth-");
    const dir = await makeTelemetryDir(root);
    const filePath = path.join(dir, "2026-13.jsonl");

    const line = JSON.stringify({
      ts: "2026-05-01T10:00:00.000Z",
      type: "agent.invoke",
      session_id: "s1",
      agent: "orchestrator",
      data: { runtime_ms: 50 },
    });
    await writeJsonlLines(filePath, [line]);

    // The helper reads all matching `\d{4}-\d{2}.jsonl` files; calendar
    // month validity is not enforced in v1.
    const stats = await readTeamTelemetryStats({ targetRepoRoot: root });
    expect(stats.fireCountsByAgent["orchestrator"]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Task 3.2(f) — telemetry.invalid events do NOT count as malformed
// ---------------------------------------------------------------------------
describe("readTeamTelemetryStats — telemetry.invalid events (Task 3.2f)", () => {
  it("does not count telemetry.invalid events as malformed or as fire counts", async () => {
    const root = await makeRepo("team-stats-invalid-event-");
    const dir = await makeTelemetryDir(root);
    const filePath = path.join(dir, "2026-05.jsonl");

    // A valid `telemetry.invalid` event (passes Zod — it's a known event type).
    const invalidEventLine = JSON.stringify({
      ts: "2026-05-01T10:00:00.000Z",
      type: "telemetry.invalid",
      session_id: "s1",
      agent: "planner",
      data: {
        attempted_type: "agent.invoke",
        zod_path: "data.runtime_ms",
        zod_message: "Expected number, received string",
      },
    });

    await writeJsonlLines(filePath, [invalidEventLine]);

    const stats = await readTeamTelemetryStats({ targetRepoRoot: root });
    // Valid event, just not `agent.invoke` — should not count as malformed.
    expect(stats.malformedLines).toBe(0);
    expect(stats.malformedFiles).toBe(0);
    // And not in fire counts either.
    expect(stats.fireCountsByAgent).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Task 3.2(g) — trailing newline does not produce spurious empty malformation
// ---------------------------------------------------------------------------
describe("readTeamTelemetryStats — trailing newline (Task 3.2g)", () => {
  it("does not count the trailing empty line as malformed", async () => {
    const root = await makeRepo("team-stats-trailing-nl-");
    const dir = await makeTelemetryDir(root);
    const filePath = path.join(dir, "2026-05.jsonl");

    // Logger writes `JSON.stringify(event) + "\n"`, so every file ends
    // with `\n`. Splitting on `\n` gives a trailing `""` element.
    const line = JSON.stringify({
      ts: "2026-05-01T10:00:00.000Z",
      type: "agent.invoke",
      session_id: "s1",
      agent: "retro-analyst",
      data: { runtime_ms: 75 },
    });

    // Hand-write with trailing newline (same as logTelemetryEvent).
    await fs.writeFile(filePath, line + "\n", "utf8");

    const stats = await readTeamTelemetryStats({ targetRepoRoot: root });
    expect(stats.malformedLines).toBe(0);
    expect(stats.fireCountsByAgent).toEqual({ "retro-analyst": 1 });
  });
});
