/**
 * Tests for the recurring-friction retro signal — Story native:01KT2RAXBSQ91Y80Z51DD26KPX.
 *
 * AC1 (integration): Given a cycle with >= 2 friction events of the same kind,
 *   gatherRetroInputs returns a recurringFriction entry for that kind with the
 *   correct count — surfacing the seam problem that outcome data alone missed.
 *
 * AC2 (unit): Given valid inputs, recordAgentFriction appends a structured
 *   agent.friction telemetry event to the JSONL file with all structured fields
 *   correct and parseable by TelemetryEventSchema.
 *
 * AC3 (unit): Given exactly 1 friction event of a given kind, gatherRetroInputs
 *   does NOT include that kind in recurringFriction (one-off noise is excluded;
 *   threshold is count >= 2).
 *
 * All tests use real tool implementations against a temp filesystem — no mocks
 * of the things under test.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gatherRetroInputs } from "../gather-retro-inputs.js";
import { recordAgentFriction } from "../record-agent-friction.js";
import { TelemetryEventSchema } from "../../schemas/telemetry-events.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeAgentFrictionLine(opts: {
  kind: string;
  expected: string;
  observed: string;
  ts?: string;
}): string {
  return JSON.stringify({
    ts: opts.ts ?? "2026-06-01T10:00:00.000Z",
    session_id: "01KT2STBTEST0000000000001",
    agent: "generalist-dev",
    story_id: "native:01KTTEST00000000000000001",
    type: "agent.friction",
    data: {
      kind: opts.kind,
      expected: opts.expected,
      observed: opts.observed,
    },
  });
}

function makeAgentInvokeLine(): string {
  return JSON.stringify({
    ts: "2026-06-01T10:00:00.000Z",
    session_id: "01KT2STBTEST0000000000001",
    agent: "generalist-dev",
    story_id: "native:01KTTEST00000000000000001",
    type: "agent.invoke",
    data: { runtime_ms: 1200 },
  });
}

// ---------------------------------------------------------------------------
// AC1: Integration — recurring friction surfaces in gatherRetroInputs
// ---------------------------------------------------------------------------

describe("AC1 — gatherRetroInputs includes recurringFriction when same kind repeats", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "retro-friction-ac1-"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("includes kind with count >= 2 in recurringFriction", async () => {
    const telemetryDir = path.join(tmpRoot, ".crew", "telemetry");
    await fs.mkdir(telemetryDir, { recursive: true });

    // Seed 3 friction events of kind 'empty-input' and 1 of kind 'forced-fallback'.
    // Only 'empty-input' should appear in recurringFriction (count >= 2).
    const lines = [
      makeAgentFrictionLine({ kind: "empty-input", expected: "non-empty AC list", observed: "empty array" }),
      makeAgentFrictionLine({ kind: "empty-input", expected: "non-empty AC list", observed: "null" }),
      makeAgentFrictionLine({ kind: "empty-input", expected: "non-empty AC list", observed: "undefined field" }),
      makeAgentFrictionLine({ kind: "forced-fallback", expected: "architect role", observed: "planner role (architect not hired)" }),
      makeAgentInvokeLine(),
    ];
    await fs.writeFile(
      path.join(telemetryDir, "2026-06.jsonl"),
      lines.join("\n") + "\n",
      "utf8",
    );

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    // The recurringFriction array must include 'empty-input' with count = 3.
    expect(bundle.recurringFriction).toHaveLength(1);
    expect(bundle.recurringFriction[0]).toMatchObject({ kind: "empty-input", count: 3 });
  });

  it("includes all recurring kinds (multiple kinds above threshold)", async () => {
    const telemetryDir = path.join(tmpRoot, ".crew", "telemetry");
    await fs.mkdir(telemetryDir, { recursive: true });

    // 2 events each for 'empty-input' and 'forced-fallback' → both should surface.
    const lines = [
      makeAgentFrictionLine({ kind: "empty-input", expected: "story body", observed: "empty string" }),
      makeAgentFrictionLine({ kind: "empty-input", expected: "story body", observed: "whitespace only" }),
      makeAgentFrictionLine({ kind: "forced-fallback", expected: "test-specialist lens", observed: "orchestrator lens" }),
      makeAgentFrictionLine({ kind: "forced-fallback", expected: "test-specialist lens", observed: "planner lens" }),
    ];
    await fs.writeFile(
      path.join(telemetryDir, "2026-06.jsonl"),
      lines.join("\n") + "\n",
      "utf8",
    );

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    // Both kinds should appear; sorted alphabetically for determinism.
    expect(bundle.recurringFriction).toHaveLength(2);
    const kinds = bundle.recurringFriction.map((e) => e.kind);
    expect(kinds).toContain("empty-input");
    expect(kinds).toContain("forced-fallback");
    // Verify counts
    const emptyInputEntry = bundle.recurringFriction.find((e) => e.kind === "empty-input");
    const forcedFallbackEntry = bundle.recurringFriction.find((e) => e.kind === "forced-fallback");
    expect(emptyInputEntry).toBeDefined();
    expect(forcedFallbackEntry).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(emptyInputEntry!.count).toBe(2);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(forcedFallbackEntry!.count).toBe(2);
  });

  it("returns empty recurringFriction when no friction events are present", async () => {
    const telemetryDir = path.join(tmpRoot, ".crew", "telemetry");
    await fs.mkdir(telemetryDir, { recursive: true });

    // Only agent.invoke events — no friction.
    await fs.writeFile(
      path.join(telemetryDir, "2026-06.jsonl"),
      [makeAgentInvokeLine(), makeAgentInvokeLine()].join("\n") + "\n",
      "utf8",
    );

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });
    expect(bundle.recurringFriction).toHaveLength(0);
  });

  it("returns empty recurringFriction when telemetry dir is absent", async () => {
    // No .crew/telemetry directory at all.
    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });
    expect(bundle.recurringFriction).toHaveLength(0);
  });

  it("proposal rationale can reference the friction kind and count from recurringFriction", async () => {
    // Integration: the bundle carries enough info for the analyst to draft a proposal.
    const telemetryDir = path.join(tmpRoot, ".crew", "telemetry");
    await fs.mkdir(telemetryDir, { recursive: true });

    const lines = [
      makeAgentFrictionLine({ kind: "repeated-retry", expected: "first-call success", observed: "retried 3 times before success" }),
      makeAgentFrictionLine({ kind: "repeated-retry", expected: "first-call success", observed: "retried 2 times before success" }),
    ];
    await fs.writeFile(
      path.join(telemetryDir, "2026-06.jsonl"),
      lines.join("\n") + "\n",
      "utf8",
    );

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    expect(bundle.recurringFriction).toHaveLength(1);
    const entry = bundle.recurringFriction[0];
    expect(entry).toBeDefined();
    // The analyst can use entry.kind and entry.count to write:
    // "kind 'repeated-retry' occurred 2 times — a seam in <tool> keeps misfiring."
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(entry!.kind).toBe("repeated-retry");
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(entry!.count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AC2: Unit — recordAgentFriction persists a valid agent.friction event
// ---------------------------------------------------------------------------

describe("AC2 — recordAgentFriction appends a valid agent.friction event", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "retro-friction-ac2-"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  async function readTelemetryLines(root: string): Promise<string[]> {
    const telemetryDir = path.join(root, ".crew", "telemetry");
    const entries = await fs.readdir(telemetryDir);
    const jsonlFiles = entries.filter((f) => f.endsWith(".jsonl")).sort();
    const lines: string[] = [];
    for (const file of jsonlFiles) {
      const raw = await fs.readFile(path.join(telemetryDir, file), "utf8");
      lines.push(...raw.split("\n").filter((l) => l.trim() !== ""));
    }
    return lines;
  }

  it("appends one line for a valid call with all fields", async () => {
    const result = await recordAgentFriction({
      targetRepoRoot: tmpRoot,
      agent: "generalist-dev",
      session_id: "01KT2STBTEST0000000000001",
      story_id: "native:01KTTEST00000000000000001",
      kind: "empty-input",
      expected: "non-empty acceptance_criteria list",
      observed: "empty array — likely a scan-sources gap",
    });

    expect(result.ok).toBe(true);
    expect(result.kind).toBe("empty-input");
    expect(result.agent).toBe("generalist-dev");
    expect(result.session_id).toBe("01KT2STBTEST0000000000001");

    const lines = await readTelemetryLines(tmpRoot);
    expect(lines).toHaveLength(1);

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const parsed = JSON.parse(lines[0]!);
    // Must parse cleanly through TelemetryEventSchema.
    const validated = TelemetryEventSchema.safeParse(parsed);
    expect(validated.success, `Zod parse failed: ${!validated.success ? JSON.stringify(validated.error.issues) : ""}`).toBe(true);
    if (!validated.success) return;

    const data = validated.data;
    expect(data.type).toBe("agent.friction");
    expect(data.agent).toBe("generalist-dev");
    expect(data.session_id).toBe("01KT2STBTEST0000000000001");
    expect(data.story_id).toBe("native:01KTTEST00000000000000001");
    if (data.type === "agent.friction") {
      expect(data.data.kind).toBe("empty-input");
      expect(data.data.expected).toBe("non-empty acceptance_criteria list");
      expect(data.data.observed).toBe("empty array — likely a scan-sources gap");
    }
  });

  it("appends without story_id when not supplied", async () => {
    await recordAgentFriction({
      targetRepoRoot: tmpRoot,
      agent: "generalist-reviewer",
      session_id: "01KT2STBTEST0000000000002",
      kind: "missing-cited-source",
      expected: "cited source file to exist",
      observed: "file not found on disk",
    });

    const lines = await readTelemetryLines(tmpRoot);
    expect(lines).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.story_id).toBeUndefined();
    expect(parsed.type).toBe("agent.friction");
  });

  it("appends all four kind values without error", async () => {
    const kinds = [
      "empty-input",
      "missing-cited-source",
      "forced-fallback",
      "repeated-retry",
    ] as const;

    for (const kind of kinds) {
      await recordAgentFriction({
        targetRepoRoot: tmpRoot,
        agent: "generalist-dev",
        session_id: "01KT2STBTEST0000000000003",
        kind,
        expected: `expected for ${kind}`,
        observed: `observed for ${kind}`,
      });
    }

    const lines = await readTelemetryLines(tmpRoot);
    expect(lines).toHaveLength(4);

    for (let i = 0; i < kinds.length; i++) {
      const parsed = JSON.parse(lines[i] ?? "{}");
      const validated = TelemetryEventSchema.safeParse(parsed);
      expect(validated.success).toBe(true);
      const expectedKind = kinds[i];
      if (validated.success && validated.data.type === "agent.friction" && expectedKind !== undefined) {
        expect(validated.data.data.kind).toBe(expectedKind);
      }
    }
  });

  it("rejects an unknown kind with a ZodError", async () => {
    await expect(
      recordAgentFriction({
        targetRepoRoot: tmpRoot,
        agent: "generalist-dev",
        session_id: "01KT2STBTEST0000000000004",
        kind: "not-a-real-kind" as "empty-input",
        expected: "something",
        observed: "something else",
      }),
    ).rejects.toThrow();
  });

  it("rejects an empty expected string with a ZodError", async () => {
    await expect(
      recordAgentFriction({
        targetRepoRoot: tmpRoot,
        agent: "generalist-dev",
        session_id: "01KT2STBTEST0000000000005",
        kind: "empty-input",
        expected: "",
        observed: "something",
      }),
    ).rejects.toThrow();
  });

  it("rejects an empty observed string with a ZodError", async () => {
    await expect(
      recordAgentFriction({
        targetRepoRoot: tmpRoot,
        agent: "generalist-dev",
        session_id: "01KT2STBTEST0000000000006",
        kind: "forced-fallback",
        expected: "something",
        observed: "",
      }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC3: Unit — one-off friction is excluded from recurringFriction
// ---------------------------------------------------------------------------

describe("AC3 — gatherRetroInputs excludes one-off friction (count < 2)", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "retro-friction-ac3-"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("excludes a kind that appeared exactly once", async () => {
    const telemetryDir = path.join(tmpRoot, ".crew", "telemetry");
    await fs.mkdir(telemetryDir, { recursive: true });

    // Exactly 1 friction event of kind 'missing-cited-source'.
    const lines = [
      makeAgentFrictionLine({ kind: "missing-cited-source", expected: "file present", observed: "file absent" }),
    ];
    await fs.writeFile(
      path.join(telemetryDir, "2026-06.jsonl"),
      lines.join("\n") + "\n",
      "utf8",
    );

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    // One-off — must NOT appear in recurringFriction.
    expect(bundle.recurringFriction).toHaveLength(0);
    const kinds = bundle.recurringFriction.map((e) => e.kind);
    expect(kinds).not.toContain("missing-cited-source");
  });

  it("excludes one-off kinds even when other recurring kinds are present", async () => {
    const telemetryDir = path.join(tmpRoot, ".crew", "telemetry");
    await fs.mkdir(telemetryDir, { recursive: true });

    const lines = [
      // 2x 'empty-input' — should surface.
      makeAgentFrictionLine({ kind: "empty-input", expected: "non-empty", observed: "empty" }),
      makeAgentFrictionLine({ kind: "empty-input", expected: "non-empty", observed: "null" }),
      // 1x 'repeated-retry' — should NOT surface.
      makeAgentFrictionLine({ kind: "repeated-retry", expected: "first-call success", observed: "second try needed" }),
    ];
    await fs.writeFile(
      path.join(telemetryDir, "2026-06.jsonl"),
      lines.join("\n") + "\n",
      "utf8",
    );

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    expect(bundle.recurringFriction).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(bundle.recurringFriction[0]!.kind).toBe("empty-input");
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(bundle.recurringFriction[0]!.count).toBe(2);

    // 'repeated-retry' must NOT appear.
    const kinds = bundle.recurringFriction.map((e) => e.kind);
    expect(kinds).not.toContain("repeated-retry");
  });

  it("threshold boundary: exactly 2 events is included, 1 is excluded", async () => {
    const telemetryDir = path.join(tmpRoot, ".crew", "telemetry");
    await fs.mkdir(telemetryDir, { recursive: true });

    // 2x forced-fallback (exactly at threshold) + 1x empty-input (below threshold)
    const lines = [
      makeAgentFrictionLine({ kind: "forced-fallback", expected: "architect", observed: "planner" }),
      makeAgentFrictionLine({ kind: "forced-fallback", expected: "architect", observed: "orchestrator" }),
      makeAgentFrictionLine({ kind: "empty-input", expected: "data", observed: "empty" }),
    ];
    await fs.writeFile(
      path.join(telemetryDir, "2026-06.jsonl"),
      lines.join("\n") + "\n",
      "utf8",
    );

    const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });

    // Only forced-fallback (count=2) should surface; empty-input (count=1) should not.
    expect(bundle.recurringFriction).toHaveLength(1);
    expect(bundle.recurringFriction[0]).toMatchObject({ kind: "forced-fallback", count: 2 });
    const kinds = bundle.recurringFriction.map((e) => e.kind);
    expect(kinds).not.toContain("empty-input");
  });
});
