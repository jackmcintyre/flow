/**
 * Cycle-boundary tests — Story native:01KT484NY4HCBPBTT6VEY1Q0CS.
 *
 * Covers all four ACs from the execution manifest:
 *
 *   AC1 — After openCycle, getStatus reports the cycle ULID (not 'none').
 *   AC2 — gatherRetroInputs includes only done manifests / telemetry events
 *          that fall on or after the cycle's opened_at timestamp.
 *   AC3 — When a prior cycle is active, openCycle archives it to
 *          .flow/cycle-archive/<prior-cycle-id>-<iso>.yaml before activating
 *          the new one.
 *   AC4 — When no cycle has ever been opened, getStatus reports 'none' and
 *          gatherRetroInputs returns all available history (baseline behaviour).
 *
 * No LLM invocation, no network, no snapshot.  Every test seeds a tmpdir
 * and cleans up on exit.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { openCycle } from "../open-cycle.js";
import { gatherRetroInputs } from "../gather-retro-inputs.js";
import { getStatus } from "../get-status.js";
import { readCycleState } from "../../lib/cycle-state.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function toIso(d: Date): string {
  return d.toISOString();
}

/**
 * Build a minimal valid done/ manifest shape.
 * `completed_at` is optional — pass undefined to omit it.
 */
function buildDoneManifest(
  ref: string,
  completedAt?: string,
): Record<string, unknown> {
  return {
    ref,
    status: "done",
    adapter: "native",
    source_path: `.flow/native-stories/${ref}.md`,
    source_hash: "a".repeat(64),
    depends_on: [],
    acceptance_criteria: [{ text: "AC text", kind: "integration" }],
    title: `Story ${ref}`,
    narrative: "As a test, I want to test, so that tests pass.",
    withdrawn: false,
    ready: true,
    claimed_by: "01HSESSION00000000000000001",
    ...(completedAt !== undefined ? { completed_at: completedAt } : {}),
  };
}

async function writeYaml(absPath: string, obj: unknown): Promise<void> {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, yamlStringify(obj), "utf8");
}

async function writeTelemetryLine(
  targetRepoRoot: string,
  event: Record<string, unknown>,
): Promise<void> {
  const month = (event.ts as string).slice(0, 7);
  const filePath = path.join(targetRepoRoot, ".flow", "telemetry", `${month}.jsonl`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, JSON.stringify(event) + "\n", "utf8");
}

function makeAgentInvokeEvent(ts: string): Record<string, unknown> {
  return {
    ts,
    session_id: "01HSESSION00000000000000001",
    agent: "generalist-dev",
    type: "agent.invoke",
    data: { runtime_ms: 100 },
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-cycle-boundary-"));

  // .flow structure
  await fs.mkdir(path.join(tmpRoot, ".flow", "state", "done"), { recursive: true });
  await fs.mkdir(path.join(tmpRoot, ".flow", "state", "to-do"), { recursive: true });
  await fs.mkdir(path.join(tmpRoot, ".flow", "state", "in-progress"), { recursive: true });
  await fs.mkdir(path.join(tmpRoot, ".flow", "telemetry"), { recursive: true });
  await fs.mkdir(path.join(tmpRoot, ".flow", "retro-proposals"), { recursive: true });

  // Minimal adapter config so getStatus can resolve the workspace.
  await fs.writeFile(
    path.join(tmpRoot, ".flow", "config.yaml"),
    "adapter: native\n",
    "utf8",
  );
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC1 — Status shows ULID after openCycle
// ---------------------------------------------------------------------------

describe("AC1: openCycle → getStatus shows cycle ULID", () => {
  it("status shows 'none' before any cycle, then the cycle ULID after openCycle", async () => {
    // AC4 baseline: no cycle opened yet → status shows 'none'.
    const beforeState = await readCycleState(tmpRoot);
    expect(beforeState).toBeNull();

    const fixedNow = new Date("2026-06-10T10:00:00.000Z");
    const result = await openCycle({
      targetRepoRoot: tmpRoot,
      sessionUlid: "01HSESSION00000000000000001",
      now: () => fixedNow,
    });

    expect(result.ok).toBe(true);
    expect(result.archivedPriorCycleId).toBeNull();

    // The ULID should be non-empty and 26 chars (Crockford base32).
    expect(result.cycleId).toHaveLength(26);
    expect(result.openedAt).toBe("2026-06-10T10:00:00.000Z");

    // cycle-state.json should contain the new cycle.
    const state = await readCycleState(tmpRoot);
    expect(state).not.toBeNull();
    expect(state!.cycle_id).toBe(result.cycleId);
    expect(state!.opened_at).toBe("2026-06-10T10:00:00.000Z");
  });

  it("getStatus reports the cycle ULID (not none) after openCycle", async () => {
    const fixedNow = new Date("2026-06-10T12:00:00.000Z");
    const opened = await openCycle({
      targetRepoRoot: tmpRoot,
      sessionUlid: "01HSESSION00000000000000001",
      now: () => fixedNow,
    });

    // getStatus needs a valid standards doc path — write a minimal one.
    await fs.mkdir(path.join(tmpRoot, "docs"), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, "docs", "standards.md"),
      "---\nversion: 1.0.0\n---\n# Standards\n",
      "utf8",
    );

    const report = await getStatus({ targetRepoRoot: tmpRoot });
    expect(report.cycle).toBe(opened.cycleId);
    expect(report.cycle).not.toBe("none");
  });
});

// ---------------------------------------------------------------------------
// AC2 — gatherRetroInputs scopes to cycle window
// ---------------------------------------------------------------------------

describe("AC2: gatherRetroInputs filters to cycle window", () => {
  it("excludes manifests and events that pre-date the cycle's opened_at", async () => {
    const cycleOpen = "2026-06-05T00:00:00.000Z";

    // Two done manifests: one before the cycle, one after.
    await writeYaml(
      path.join(tmpRoot, ".flow", "state", "done", "native:AAAAAAAAAAAAAAAAAAAAAAAAAA.yaml"),
      buildDoneManifest(
        "native:AAAAAAAAAAAAAAAAAAAAAAAAAA",
        "2026-06-01T10:00:00.000Z", // before cycle
      ),
    );
    await writeYaml(
      path.join(tmpRoot, ".flow", "state", "done", "native:BBBBBBBBBBBBBBBBBBBBBBBBBB.yaml"),
      buildDoneManifest(
        "native:BBBBBBBBBBBBBBBBBBBBBBBBBB",
        "2026-06-07T10:00:00.000Z", // after cycle
      ),
    );

    // Two telemetry events: one before, one after.
    await writeTelemetryLine(tmpRoot, makeAgentInvokeEvent("2026-06-03T08:00:00.000Z"));
    await writeTelemetryLine(tmpRoot, makeAgentInvokeEvent("2026-06-08T08:00:00.000Z"));

    // Use the cycleOpenedAt test seam (avoid disk).
    const bundle = await gatherRetroInputs({
      targetRepoRoot: tmpRoot,
      cycleOpenedAt: cycleOpen,
    });

    expect(bundle.doneManifests).toHaveLength(1);
    expect(bundle.doneManifests[0]?.ref).toBe("native:BBBBBBBBBBBBBBBBBBBBBBBBBB");

    expect(bundle.telemetrySummary.events).toHaveLength(1);
    expect(bundle.telemetrySummary.events[0]?.ts).toBe("2026-06-08T08:00:00.000Z");
  });

  it("excludes done manifests with no completed_at when a cycle is active", async () => {
    const cycleOpen = "2026-06-05T00:00:00.000Z";

    // Manifest with no completed_at (written before this feature landed).
    await writeYaml(
      path.join(tmpRoot, ".flow", "state", "done", "native:CCCCCCCCCCCCCCCCCCCCCCCCCC.yaml"),
      buildDoneManifest("native:CCCCCCCCCCCCCCCCCCCCCCCCCC"), // no completed_at
    );

    // Manifest with completed_at after cycle.
    await writeYaml(
      path.join(tmpRoot, ".flow", "state", "done", "native:DDDDDDDDDDDDDDDDDDDDDDDDDD.yaml"),
      buildDoneManifest(
        "native:DDDDDDDDDDDDDDDDDDDDDDDDDD",
        "2026-06-06T10:00:00.000Z",
      ),
    );

    const bundle = await gatherRetroInputs({
      targetRepoRoot: tmpRoot,
      cycleOpenedAt: cycleOpen,
    });

    // Only the manifest with a known completed_at in the window is included.
    expect(bundle.doneManifests).toHaveLength(1);
    expect(bundle.doneManifests[0]?.ref).toBe("native:DDDDDDDDDDDDDDDDDDDDDDDDDD");
  });

  it("includes manifests completed exactly at opened_at (boundary is inclusive)", async () => {
    const cycleOpen = "2026-06-05T00:00:00.000Z";

    await writeYaml(
      path.join(tmpRoot, ".flow", "state", "done", "native:EEEEEEEEEEEEEEEEEEEEEEEEEE.yaml"),
      buildDoneManifest("native:EEEEEEEEEEEEEEEEEEEEEEEEEE", cycleOpen),
    );

    const bundle = await gatherRetroInputs({
      targetRepoRoot: tmpRoot,
      cycleOpenedAt: cycleOpen,
    });

    expect(bundle.doneManifests).toHaveLength(1);
    expect(bundle.doneManifests[0]?.ref).toBe("native:EEEEEEEEEEEEEEEEEEEEEEEEEE");
  });

  it("reads cycle from disk when no cycleOpenedAt override is passed", async () => {
    const cycleOpen = "2026-06-05T00:00:00.000Z";

    // Write cycle-state.json directly.
    await fs.writeFile(
      path.join(tmpRoot, ".flow", "cycle-state.json"),
      JSON.stringify({ cycle_id: "01HX000000000000000000TEST", opened_at: cycleOpen }) + "\n",
      "utf8",
    );

    // After-cycle manifest.
    await writeYaml(
      path.join(tmpRoot, ".flow", "state", "done", "native:FFFFFFFFFFFFFFFFFFFFFFFFFF.yaml"),
      buildDoneManifest(
        "native:FFFFFFFFFFFFFFFFFFFFFFFFFF",
        "2026-06-09T00:00:00.000Z",
      ),
    );
    // Before-cycle manifest.
    await writeYaml(
      path.join(tmpRoot, ".flow", "state", "done", "native:GGGGGGGGGGGGGGGGGGGGGGGGGG.yaml"),
      buildDoneManifest(
        "native:GGGGGGGGGGGGGGGGGGGGGGGGGG",
        "2026-06-01T00:00:00.000Z",
      ),
    );

    // No override — reads from disk.
    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    expect(bundle.doneManifests).toHaveLength(1);
    expect(bundle.doneManifests[0]?.ref).toBe("native:FFFFFFFFFFFFFFFFFFFFFFFFFF");
  });
});

// ---------------------------------------------------------------------------
// AC3 — Archive written when opening over existing cycle
// ---------------------------------------------------------------------------

describe("AC3: prior cycle archived when openCycle is called again", () => {
  it("writes a YAML archive record for the prior cycle and then activates the new one", async () => {
    const firstNow = new Date("2026-06-01T09:00:00.000Z");
    const secondNow = new Date("2026-06-10T09:00:00.000Z");

    // Open the first cycle.
    const first = await openCycle({
      targetRepoRoot: tmpRoot,
      sessionUlid: "01HSESSION00000000000000001",
      now: () => firstNow,
    });

    // Seed some done manifests and proposals for the archive snapshot.
    await writeYaml(
      path.join(tmpRoot, ".flow", "state", "done", "native:HHHHHHHHHHHHHHHHHHHHHHHHHH.yaml"),
      buildDoneManifest(
        "native:HHHHHHHHHHHHHHHHHHHHHHHHHH",
        "2026-06-03T10:00:00.000Z",
      ),
    );
    await fs.writeFile(
      path.join(tmpRoot, ".flow", "retro-proposals", "2026-06-05T00:00:00.000Z.md"),
      "# A proposal\n",
      "utf8",
    );

    // Open a second cycle over the first.
    const second = await openCycle({
      targetRepoRoot: tmpRoot,
      sessionUlid: "01HSESSION00000000000000002",
      now: () => secondNow,
    });

    expect(second.archivedPriorCycleId).toBe(first.cycleId);

    // Verify archive directory exists and contains a file.
    const archiveDir = path.join(tmpRoot, ".flow", "cycle-archive");
    const archiveEntries = await fs.readdir(archiveDir);
    expect(archiveEntries).toHaveLength(1);

    // The archive file name starts with the prior cycle's ULID.
    const archiveFileName = archiveEntries[0] as string;
    expect(archiveFileName).toMatch(new RegExp(`^${first.cycleId}-`));
    expect(archiveFileName).toMatch(/\.yaml$/);

    // Read and parse the archive file — it should mention the prior cycle id.
    const archiveContent = await fs.readFile(
      path.join(archiveDir, archiveFileName),
      "utf8",
    );
    expect(archiveContent).toContain(first.cycleId);
    expect(archiveContent).toContain("native:HHHHHHHHHHHHHHHHHHHHHHHHHH");

    // The new cycle-state.json should point to the SECOND cycle.
    const state = await readCycleState(tmpRoot);
    expect(state!.cycle_id).toBe(second.cycleId);
    expect(state!.cycle_id).not.toBe(first.cycleId);
  });

  it("second cycle ULID differs from first", async () => {
    let callCount = 0;
    const nowFn = () => {
      callCount++;
      // Ensure strictly increasing times so ULIDs differ monotonically.
      return new Date(Date.now() + callCount * 1000);
    };

    const first = await openCycle({
      targetRepoRoot: tmpRoot,
      sessionUlid: "01HSESSION00000000000000001",
      now: nowFn,
    });
    const second = await openCycle({
      targetRepoRoot: tmpRoot,
      sessionUlid: "01HSESSION00000000000000002",
      now: nowFn,
    });

    expect(second.cycleId).not.toBe(first.cycleId);
  });
});

// ---------------------------------------------------------------------------
// AC4 — No cycle baseline: status = 'none', retro = full history
// ---------------------------------------------------------------------------

describe("AC4: no-cycle baseline (cycle-state.json absent)", () => {
  it("readCycleState returns null when no cycle has been opened", async () => {
    const state = await readCycleState(tmpRoot);
    expect(state).toBeNull();
  });

  it("gatherRetroInputs returns ALL done manifests when no cycle is active", async () => {
    // Two manifests with different completed_at values.
    await writeYaml(
      path.join(tmpRoot, ".flow", "state", "done", "native:IIIIIIIIIIIIIIIIIIIIIIIIII.yaml"),
      buildDoneManifest(
        "native:IIIIIIIIIIIIIIIIIIIIIIIIII",
        "2026-01-01T00:00:00.000Z",
      ),
    );
    await writeYaml(
      path.join(tmpRoot, ".flow", "state", "done", "native:JJJJJJJJJJJJJJJJJJJJJJJJJJ.yaml"),
      buildDoneManifest(
        "native:JJJJJJJJJJJJJJJJJJJJJJJJJJ",
        "2026-06-01T00:00:00.000Z",
      ),
    );

    // No cycle file on disk, no override → full history.
    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    expect(bundle.doneManifests).toHaveLength(2);
  });

  it("gatherRetroInputs returns ALL telemetry events when no cycle is active", async () => {
    await writeTelemetryLine(tmpRoot, makeAgentInvokeEvent("2025-12-01T10:00:00.000Z"));
    await writeTelemetryLine(tmpRoot, makeAgentInvokeEvent("2026-03-15T10:00:00.000Z"));
    await writeTelemetryLine(tmpRoot, makeAgentInvokeEvent("2026-06-10T10:00:00.000Z"));

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    expect(bundle.telemetrySummary.events).toHaveLength(3);
  });

  it("gatherRetroInputs returns full history when cycleOpenedAt is explicitly null", async () => {
    await writeYaml(
      path.join(tmpRoot, ".flow", "state", "done", "native:KKKKKKKKKKKKKKKKKKKKKKKKKK.yaml"),
      buildDoneManifest(
        "native:KKKKKKKKKKKKKKKKKKKKKKKKKK",
        "2020-01-01T00:00:00.000Z",
      ),
    );

    const bundle = await gatherRetroInputs({
      targetRepoRoot: tmpRoot,
      cycleOpenedAt: null, // explicit baseline override
    });

    expect(bundle.doneManifests).toHaveLength(1);
  });

  it("gatherRetroInputs returns empty bundle when no .flow dirs exist (absence is not an error)", async () => {
    const emptyRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-cycle-empty-"));
    try {
      const bundle = await gatherRetroInputs({ targetRepoRoot: emptyRoot });
      expect(bundle.doneManifests).toEqual([]);
      expect(bundle.telemetrySummary.events).toEqual([]);
      expect(bundle.priorProposals).toEqual([]);
      expect(bundle.ruleRegistry).toBeNull();
    } finally {
      await fs.rm(emptyRoot, { recursive: true, force: true });
    }
  });
});
