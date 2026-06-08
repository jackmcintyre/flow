/**
 * Integration tests for `computeAgreement` — Story 4.10 AC4.
 *
 * All tmpdir fixtures use `fs.mkdtemp(path.join(os.tmpdir(), "compute-agreement-"))`.
 * Events are written as raw JSONL via `fs.writeFile` (not `logTelemetryEvent`).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import {
  computeAgreement,
  AgreementMetricResultSchema,
  DEFAULT_AGREEMENT_WINDOW,
} from "../compute-agreement.js";
import { AgreementWindowInvalidError } from "../../errors.js";
import { TelemetryEventSchema } from "../../schemas/telemetry-events.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** ISO-8601 UTC timestamp at a given millisecond offset from a base epoch */
function makeTs(offsetMs: number): string {
  return new Date(1_700_000_000_000 + offsetMs).toISOString();
}

/** Create a `reviewer.verdict` event payload (TelemetryEventSchema-valid) */
function makeVerdictEvent(opts: {
  ts: string;
  session_id: string;
  pr_number: number;
  verdict: "READY FOR MERGE" | "NEEDS CHANGES" | "BLOCKED" | "reviewer-failure";
  story_id?: string;
  timed_out?: boolean;
}): object {
  return {
    ts: opts.ts,
    session_id: opts.session_id,
    agent: "generalist-reviewer",
    story_id: opts.story_id ?? "bmad:1-1-example",
    type: "reviewer.verdict",
    data: {
      pr_number: opts.pr_number,
      verdict: opts.verdict,
      standards_version: "1.0.0",
      plugin_version: "1.0.0",
      timed_out: opts.timed_out ?? false,
    },
  };
}

/** Create a `reviewer.verdict.merge_action` event payload (TelemetryEventSchema-valid) */
function makeMergeActionEvent(opts: {
  ts: string;
  session_id: string;
  pr_number: number;
  merge_action: "merged" | "closed-unmerged" | "still-open";
  story_id?: string;
  resolved_at?: string;
}): object {
  return {
    ts: opts.ts,
    session_id: opts.session_id,
    agent: "generalist-reviewer",
    story_id: opts.story_id ?? "bmad:1-1-example",
    type: "reviewer.verdict.merge_action",
    data: {
      pr_number: opts.pr_number,
      merge_action: opts.merge_action,
      resolved_at: opts.resolved_at ?? opts.ts,
    },
  };
}

/** Validate a fixture event against TelemetryEventSchema (fast-fail on drift) */
function assertValidEvent(event: object): void {
  const result = TelemetryEventSchema.safeParse(event);
  if (!result.success) {
    throw new Error(`Fixture event is not TelemetryEventSchema-valid: ${JSON.stringify(result.error.issues)}`);
  }
}

/** Write a sequence of objects as JSONL to a file under telemetryDir */
async function writeJSONL(
  telemetryDir: string,
  filename: string,
  events: object[],
  extraLines?: string[],
): Promise<void> {
  const lines = events.map((e) => JSON.stringify(e));
  if (extraLines) lines.push(...extraLines);
  await fs.writeFile(path.join(telemetryDir, filename), lines.join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// Fixture: fully-resolved 50-pair window (40 agree, 10 disagree)
// Used in (4b) and (4l) determinism test
// ---------------------------------------------------------------------------
function makeFullyResolvedPairs(count: number): { verdicts: object[]; mergeActions: object[] } {
  const verdicts: object[] = [];
  const mergeActions: object[] = [];

  for (let i = 0; i < count; i++) {
    const ts = makeTs(i * 1000);
    const session_id = `session-${String(i).padStart(4, "0")}`;
    const pr_number = 100 + i;

    // First 40: agreement pairs
    // - 0-19: READY FOR MERGE + merged (agree)
    // - 20-39: NEEDS CHANGES + closed-unmerged (agree)
    // - 40-44: READY FOR MERGE + closed-unmerged (disagree)
    // - 45-49: NEEDS CHANGES + merged (disagree)
    let verdict: "READY FOR MERGE" | "NEEDS CHANGES" | "BLOCKED";
    let mergeAction: "merged" | "closed-unmerged";

    if (i < 20) {
      verdict = "READY FOR MERGE";
      mergeAction = "merged"; // agree
    } else if (i < 40) {
      verdict = "NEEDS CHANGES";
      mergeAction = "closed-unmerged"; // agree
    } else if (i < 45) {
      verdict = "READY FOR MERGE";
      mergeAction = "closed-unmerged"; // disagree
    } else {
      verdict = "NEEDS CHANGES";
      mergeAction = "merged"; // disagree
    }

    const v = makeVerdictEvent({ ts, session_id, pr_number, verdict });
    const ma = makeMergeActionEvent({ ts, session_id, pr_number, merge_action: mergeAction, resolved_at: ts });
    assertValidEvent(v);
    assertValidEvent(ma);
    verdicts.push(v);
    mergeActions.push(ma);
  }

  return { verdicts, mergeActions };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpRoot: string;
let telemetryDir: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "compute-agreement-"));
  telemetryDir = path.join(tmpRoot, ".flow", "telemetry");
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (4b) Fully-resolved window — ratio 0.8, distribution sums to 50
// ---------------------------------------------------------------------------
describe("AC4b — fully-resolved window", () => {
  it("returns ratio=0.8, sample_size=50, window_size=50, distribution sums to 50", async () => {
    await fs.mkdir(telemetryDir, { recursive: true });
    const { verdicts, mergeActions } = makeFullyResolvedPairs(50);
    await writeJSONL(telemetryDir, "2026-05.jsonl", [...verdicts, ...mergeActions]);

    const result = await computeAgreement({ targetRepoRoot: tmpRoot });
    expect(result).not.toBeNull();
    expect(result!.ratio).toBe(0.8);
    expect(result!.window_size).toBe(50);
    expect(result!.sample_size).toBe(50);
    expect(result!.skipped_unresolved).toBe(0);
    expect(result!.skipped_excluded).toBe(0);
    expect(result!.malformed_lines).toBe(0);
    const distSum =
      result!.distribution["READY FOR MERGE"] +
      result!.distribution["NEEDS CHANGES"] +
      result!.distribution.BLOCKED;
    expect(distSum).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// (4c) Partially-resolved window — null on default window; non-null on 30
// ---------------------------------------------------------------------------
describe("AC4c — partially-resolved window", () => {
  it("returns null when sample(30) < window(50)", async () => {
    await fs.mkdir(telemetryDir, { recursive: true });

    // 30 resolved pairs
    const resolvedV: object[] = [];
    const resolvedMA: object[] = [];
    for (let i = 0; i < 30; i++) {
      const ts = makeTs(i * 1000);
      const session_id = `sess-resolved-${i}`;
      const v = makeVerdictEvent({ ts, session_id, pr_number: 200 + i, verdict: "READY FOR MERGE" });
      const ma = makeMergeActionEvent({ ts, session_id, pr_number: 200 + i, merge_action: "merged", resolved_at: ts });
      assertValidEvent(v);
      assertValidEvent(ma);
      resolvedV.push(v);
      resolvedMA.push(ma);
    }

    // 20 unresolved (no merge_action)
    const unresolvedV: object[] = [];
    for (let i = 0; i < 20; i++) {
      const ts = makeTs(100_000 + i * 1000); // newer than resolved
      const session_id = `sess-open-${i}`;
      const v = makeVerdictEvent({ ts, session_id, pr_number: 300 + i, verdict: "NEEDS CHANGES" });
      assertValidEvent(v);
      unresolvedV.push(v);
    }

    await writeJSONL(telemetryDir, "2026-05.jsonl", [...resolvedV, ...resolvedMA, ...unresolvedV]);

    // Default window 50 → null
    const result50 = await computeAgreement({ targetRepoRoot: tmpRoot });
    expect(result50).toBeNull();

    // Window 30 → non-null
    const result30 = await computeAgreement({ targetRepoRoot: tmpRoot, lastNVerdicts: 30 });
    expect(result30).not.toBeNull();
    expect(result30!.sample_size).toBe(30);
    expect(result30!.window_size).toBe(30);
    // All 30 resolved are READY FOR MERGE + merged = agree → ratio 1.0
    expect(result30!.ratio).toBe(1.0);
    expect(result30!.skipped_unresolved).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// (4d) Empty log — null in all sub-cases
// ---------------------------------------------------------------------------
describe("AC4d — empty log", () => {
  it("null when .flow/telemetry/ does not exist", async () => {
    const result = await computeAgreement({ targetRepoRoot: tmpRoot });
    expect(result).toBeNull();
  });

  it("null when directory exists but no *.jsonl files", async () => {
    await fs.mkdir(telemetryDir, { recursive: true });
    const result = await computeAgreement({ targetRepoRoot: tmpRoot });
    expect(result).toBeNull();
  });

  it("null when *.jsonl files have only agent.invoke events", async () => {
    await fs.mkdir(telemetryDir, { recursive: true });
    const agentInvoke = {
      ts: makeTs(0),
      session_id: "sess-agent",
      agent: "generalist-dev",
      story_id: "bmad:1-1",
      type: "agent.invoke",
      data: { runtime_ms: 5000 },
    };
    assertValidEvent(agentInvoke);
    await writeJSONL(telemetryDir, "2026-05.jsonl", [agentInvoke]);
    const result = await computeAgreement({ targetRepoRoot: tmpRoot });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (4e) reviewer-failure exclusion
// ---------------------------------------------------------------------------
describe("AC4e — reviewer-failure exclusion", () => {
  it("null when 10 excluded leave only 40 substantive (< window 50)", async () => {
    await fs.mkdir(telemetryDir, { recursive: true });
    const verdicts: object[] = [];
    const mergeActions: object[] = [];

    // 40 substantive (READY FOR MERGE + merged)
    for (let i = 0; i < 40; i++) {
      const ts = makeTs(i * 1000);
      const session_id = `sess-sub-${i}`;
      const v = makeVerdictEvent({ ts, session_id, pr_number: 400 + i, verdict: "READY FOR MERGE" });
      const ma = makeMergeActionEvent({ ts, session_id, pr_number: 400 + i, merge_action: "merged", resolved_at: ts });
      assertValidEvent(v);
      assertValidEvent(ma);
      verdicts.push(v);
      mergeActions.push(ma);
    }

    // 10 reviewer-failure (timed_out: true)
    for (let i = 0; i < 10; i++) {
      const ts = makeTs(50_000 + i * 1000);
      const session_id = `sess-fail-${i}`;
      const v = makeVerdictEvent({ ts, session_id, pr_number: 500 + i, verdict: "reviewer-failure", timed_out: true });
      const ma = makeMergeActionEvent({ ts, session_id, pr_number: 500 + i, merge_action: "merged", resolved_at: ts });
      assertValidEvent(v);
      assertValidEvent(ma);
      verdicts.push(v);
      mergeActions.push(ma);
    }

    await writeJSONL(telemetryDir, "2026-05.jsonl", [...verdicts, ...mergeActions]);

    // Window 50 → null (40 substantive < 50)
    expect(await computeAgreement({ targetRepoRoot: tmpRoot })).toBeNull();

    // Window 40 → non-null, excluded=10, distribution sums to 40
    const result40 = await computeAgreement({ targetRepoRoot: tmpRoot, lastNVerdicts: 40 });
    expect(result40).not.toBeNull();
    expect(result40!.sample_size).toBe(40);
    expect(result40!.window_size).toBe(40);
    expect(result40!.skipped_excluded).toBe(10);
    const distSum =
      result40!.distribution["READY FOR MERGE"] +
      result40!.distribution["NEEDS CHANGES"] +
      result40!.distribution.BLOCKED;
    expect(distSum).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// (4f) Cross-month windowing
// ---------------------------------------------------------------------------
describe("AC4f — cross-month windowing", () => {
  it("samples 50 pairs newest-first across 3 monthly files", async () => {
    await fs.mkdir(telemetryDir, { recursive: true });

    // 3 files × 20 pairs each, all resolved READY FOR MERGE + merged
    const files = ["2026-03.jsonl", "2026-04.jsonl", "2026-05.jsonl"];
    // ts: older month = lower offset so newer file = newer ts
    for (let fileIdx = 0; fileIdx < 3; fileIdx++) {
      const events: object[] = [];
      for (let i = 0; i < 20; i++) {
        const globalIdx = fileIdx * 20 + i;
        const ts = makeTs(globalIdx * 1000); // monotonic across all files
        const session_id = `cross-${fileIdx}-${i}`;
        const pr_number = 600 + globalIdx;
        const v = makeVerdictEvent({ ts, session_id, pr_number, verdict: "READY FOR MERGE" });
        const ma = makeMergeActionEvent({ ts, session_id, pr_number, merge_action: "merged", resolved_at: ts });
        assertValidEvent(v);
        assertValidEvent(ma);
        events.push(v, ma);
      }
      await writeJSONL(telemetryDir, files[fileIdx]!, events);
    }

    const result = await computeAgreement({ targetRepoRoot: tmpRoot });
    expect(result).not.toBeNull();
    expect(result!.sample_size).toBe(50);
    expect(result!.window_size).toBe(50);
    // All agree
    expect(result!.ratio).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// (4g) Latest-merge-action-wins
// ---------------------------------------------------------------------------
describe("AC4g — latest-merge-action-wins", () => {
  it("older=still-open, newer=merged → resolved (agree)", async () => {
    await fs.mkdir(telemetryDir, { recursive: true });
    const ts = makeTs(0);
    const session_id = "sess-latest-1";
    const pr_number = 700;

    const v = makeVerdictEvent({ ts, session_id, pr_number, verdict: "READY FOR MERGE" });
    const ma_old = makeMergeActionEvent({ ts, session_id, pr_number, merge_action: "still-open", resolved_at: makeTs(0) });
    const ma_new = makeMergeActionEvent({ ts, session_id, pr_number, merge_action: "merged", resolved_at: makeTs(1000) });
    assertValidEvent(v);
    assertValidEvent(ma_old);
    assertValidEvent(ma_new);

    await writeJSONL(telemetryDir, "2026-05.jsonl", [v, ma_old, ma_new]);

    const result = await computeAgreement({ targetRepoRoot: tmpRoot, lastNVerdicts: 1 });
    expect(result).not.toBeNull();
    expect(result!.sample_size).toBe(1);
  });

  it("older=merged, newer=still-open → unresolved → null", async () => {
    await fs.mkdir(telemetryDir, { recursive: true });
    const ts = makeTs(0);
    const session_id = "sess-latest-2";
    const pr_number = 701;

    const v = makeVerdictEvent({ ts, session_id, pr_number, verdict: "READY FOR MERGE" });
    const ma_old = makeMergeActionEvent({ ts, session_id, pr_number, merge_action: "merged", resolved_at: makeTs(0) });
    const ma_new = makeMergeActionEvent({ ts, session_id, pr_number, merge_action: "still-open", resolved_at: makeTs(1000) });
    assertValidEvent(v);
    assertValidEvent(ma_old);
    assertValidEvent(ma_new);

    await writeJSONL(telemetryDir, "2026-05.jsonl", [v, ma_old, ma_new]);

    const result = await computeAgreement({ targetRepoRoot: tmpRoot, lastNVerdicts: 1 });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (4h) Walk semantics — skip-then-take, NOT take-then-skip
// ---------------------------------------------------------------------------
describe("AC4h — skip-then-take walk semantics", () => {
  it("50 resolved found after 20 unresolved at head → sample_size=50", async () => {
    await fs.mkdir(telemetryDir, { recursive: true });
    const events: object[] = [];

    // 50 fully-resolved pairs (older timestamps)
    for (let i = 0; i < 50; i++) {
      const ts = makeTs(i * 1000);
      const session_id = `sess-resolved-${i}`;
      const pr_number = 800 + i;
      const v = makeVerdictEvent({ ts, session_id, pr_number, verdict: "READY FOR MERGE" });
      const ma = makeMergeActionEvent({ ts, session_id, pr_number, merge_action: "merged", resolved_at: ts });
      assertValidEvent(v);
      assertValidEvent(ma);
      events.push(v, ma);
    }

    // 20 unresolved (newer timestamps — head of the sorted log)
    for (let i = 0; i < 20; i++) {
      const ts = makeTs(100_000 + i * 1000);
      const session_id = `sess-open-${i}`;
      const pr_number = 900 + i;
      const v = makeVerdictEvent({ ts, session_id, pr_number, verdict: "NEEDS CHANGES" });
      assertValidEvent(v);
      events.push(v);
      // No merge_action → unresolved
    }

    await writeJSONL(telemetryDir, "2026-05.jsonl", events);

    const result = await computeAgreement({ targetRepoRoot: tmpRoot });
    expect(result).not.toBeNull();
    expect(result!.sample_size).toBe(50);
    expect(result!.window_size).toBe(50);
    expect(result!.skipped_unresolved).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// (4i) lastNVerdicts validation
// ---------------------------------------------------------------------------
describe("AC4i — lastNVerdicts validation", () => {
  it.each([0, -1, 1.5, NaN, Infinity])(
    "throws AgreementWindowInvalidError for lastNVerdicts=%s",
    async (badValue) => {
      await expect(
        computeAgreement({ targetRepoRoot: tmpRoot, lastNVerdicts: badValue }),
      ).rejects.toThrow(AgreementWindowInvalidError);
    },
  );

  it("error message names the offending value and 'positive integer'", async () => {
    await expect(
      computeAgreement({ targetRepoRoot: tmpRoot, lastNVerdicts: 0 }),
    ).rejects.toMatchObject({ name: "AgreementWindowInvalidError" });
  });
});

// ---------------------------------------------------------------------------
// (4j) Orphan merge_action ignored
// ---------------------------------------------------------------------------
describe("AC4j — orphan merge_action silently ignored", () => {
  it("5 orphan merge_actions with no matching verdicts → null, no error", async () => {
    await fs.mkdir(telemetryDir, { recursive: true });
    const events: object[] = [];
    for (let i = 0; i < 5; i++) {
      const ts = makeTs(i * 1000);
      const ma = makeMergeActionEvent({
        ts,
        session_id: `sess-orphan-${i}`,
        pr_number: 1000 + i,
        merge_action: "merged",
        resolved_at: ts,
      });
      assertValidEvent(ma);
      events.push(ma);
    }
    await writeJSONL(telemetryDir, "2026-05.jsonl", events);

    const result = await computeAgreement({ targetRepoRoot: tmpRoot, lastNVerdicts: 1 });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (4k) Malformed JSONL tolerance
// ---------------------------------------------------------------------------
describe("AC4k — malformed JSONL line tolerance", () => {
  it("malformed_lines=5 (not counting empty lines); sample_size=50", async () => {
    await fs.mkdir(telemetryDir, { recursive: true });

    const { verdicts, mergeActions } = makeFullyResolvedPairs(50);
    const allEvents = [...verdicts, ...mergeActions];

    // Build the JSONL manually: interleave 5 bad lines (not counting empty lines)
    const lines: string[] = [];
    for (let i = 0; i < allEvents.length; i++) {
      lines.push(JSON.stringify(allEvents[i]));
      if (i === 10) lines.push("not-json"); // literal garbage — malformed
      if (i === 20) lines.push(JSON.stringify({ type: "reviewer.verdict", data: { extra_unknown_field_zod_will_reject: true } })); // Zod-fail
      if (i === 30) lines.push(JSON.stringify({ type: "reviewer.verdict", some_missing_required_field: true })); // malformed
    }
    // 2 empty lines (these must NOT count as malformed per JSONL convention)
    lines.push("");
    lines.push("");

    await fs.writeFile(path.join(telemetryDir, "2026-05.jsonl"), lines.join("\n"));

    const result = await computeAgreement({ targetRepoRoot: tmpRoot });
    expect(result).not.toBeNull();
    expect(result!.sample_size).toBe(50);
    expect(result!.malformed_lines).toBe(3); // not-json + 2 Zod-fail lines (empty lines excluded)
  });
});

// ---------------------------------------------------------------------------
// (4l) Determinism / byte-stability
// ---------------------------------------------------------------------------
describe("AC4l — determinism / byte-stability", () => {
  it("two calls against same JSONL produce identical results", async () => {
    await fs.mkdir(telemetryDir, { recursive: true });
    const { verdicts, mergeActions } = makeFullyResolvedPairs(50);
    await writeJSONL(telemetryDir, "2026-05.jsonl", [...verdicts, ...mergeActions]);

    const r1 = await computeAgreement({ targetRepoRoot: tmpRoot });
    const r2 = await computeAgreement({ targetRepoRoot: tmpRoot });
    expect(r1).toEqual(r2);
  });

  it("shuffled event write order produces same result (sort by ts)", async () => {
    await fs.mkdir(telemetryDir, { recursive: true });
    const { verdicts, mergeActions } = makeFullyResolvedPairs(50);

    // Write in original order to get baseline
    await writeJSONL(telemetryDir, "2026-05.jsonl", [...verdicts, ...mergeActions]);
    const baseline = await computeAgreement({ targetRepoRoot: tmpRoot });

    // Now write in reverse order
    await fs.writeFile(
      path.join(telemetryDir, "2026-05.jsonl"),
      [...mergeActions, ...verdicts].reverse().map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    const shuffled = await computeAgreement({ targetRepoRoot: tmpRoot });

    expect(shuffled).toEqual(baseline);
  });
});

// ---------------------------------------------------------------------------
// (4m) AgreementMetricResultSchema round-trip
// ---------------------------------------------------------------------------
describe("AC4m — AgreementMetricResultSchema round-trip", () => {
  it("JSON.stringify → JSON.parse → parse succeeds and is value-equal", async () => {
    await fs.mkdir(telemetryDir, { recursive: true });
    const { verdicts, mergeActions } = makeFullyResolvedPairs(50);
    await writeJSONL(telemetryDir, "2026-05.jsonl", [...verdicts, ...mergeActions]);

    const result = await computeAgreement({ targetRepoRoot: tmpRoot });
    expect(result).not.toBeNull();

    const serialised = JSON.stringify(result);
    const deserialised = JSON.parse(serialised);
    const parsed = AgreementMetricResultSchema.parse(deserialised);
    expect(parsed).toEqual(result);
  });
});

// ---------------------------------------------------------------------------
// (4n) Schema-strict assertion — extra unknown fields rejected
// ---------------------------------------------------------------------------
describe("AC4n — AgreementMetricResultSchema strict rejection", () => {
  it("rejects an object with an unknown extra field", () => {
    const candidate = {
      ratio: 0.8,
      distribution: {
        "READY FOR MERGE": 25,
        "NEEDS CHANGES": 15,
        BLOCKED: 10,
      },
      window_size: 50,
      sample_size: 50,
      skipped_unresolved: 0,
      skipped_excluded: 0,
      malformed_lines: 0,
      extra_unknown_field: "should be rejected",
    };
    const result = AgreementMetricResultSchema.safeParse(candidate);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (4o) MCP tool registration smoke test — computeAgreement in register.ts
// ---------------------------------------------------------------------------
describe("AC4o — MCP tool registration smoke", () => {
  it("register.ts includes computeAgreement (tool count 30)", async () => {
    const { registerAllTools } = await import("../register.js");
    const registeredTools: string[] = [];
    const fakeServer = {
      registerTool: (tool: { name: string }) => {
        registeredTools.push(tool.name);
      },
    };
    registerAllTools(fakeServer as unknown as Parameters<typeof registerAllTools>[0]);
    expect(registeredTools).toContain("computeAgreement");
    expect(registeredTools).toContain("runAutoMergeGate");
    // Story 5.11 added scanOrphanedInProgress (33), reattachOrphan (34), blockOrphanNoTranscript (35); Story 6.1 added recordStoryRetro (36); Story 6.3 added writeRetroProposal (37); Story 6.2 added gatherRetroInputs (38).
    // De-cruft 2026-05-30: removed recordAgentInvoke + recordPrCloseAction (unwired dead code). 38 → 36.
    // Story 6.4 added acceptProposal. 36 → 37.
    // Story 9.1 added markStoryReady. 37 → 38.
    // Story 9.3 added writeLensVerdict + aggregateJudgePanel (judge panel). 38 → 40.
    // Story 9.4 added adjudicateQualityLead (Quality Lead). 40 → 41.
    // Story 9.5 added getBacklogDashboard (backlog dashboard). 41 → 42.
    // Story 6.8 added recordSkillInvoke + computeSkillEffectiveness (skill telemetry). 42 → 44.
    // Story 10.5 added bmadToNativeIngest (BMad → native ingest seam). 44 → 45.
    // FU2 added resolveLensRoles (deterministic lens→role binding). 45 → 46.
    // FU7 added recordAgentFriction (agent friction signal). 46 → 47.
    // Story native:01KT484NY4HCBPBTT6VEY1Q0CS added openCycle (cycle boundary). 47 → 48.
    // Story native:01KT6GSV8KTTKKHPRGEJWJAGZV added recordReviewerLesson (learning-loop capture). 48 → 49.
    // Story native:01KT6QEWY794ZY0DH6JHQFWG6V added recallLesson (on-demand lesson recall). 49 → 50.
    // Story native:01KTKJXP6DWN5YHKVG96DH16V0 added classifyStoryLane (pre-judge lane classifier). 50 → 51.
    // Story native:01KTKK2Y73EDDAXK470EZ3MHQ8 added resolveJudgePlan (fast-lane judge plan resolver). 51 → 52.
    expect(registeredTools.length).toBe(52);
  });
});

// ---------------------------------------------------------------------------
// Bonus: exact-fit window is NOT insufficient data (AC2d)
// ---------------------------------------------------------------------------
describe("AC2d — exact-fit window is not insufficient", () => {
  it("30 resolved pairs with lastNVerdicts=30 → non-null result", async () => {
    await fs.mkdir(telemetryDir, { recursive: true });
    const events: object[] = [];
    for (let i = 0; i < 30; i++) {
      const ts = makeTs(i * 1000);
      const session_id = `sess-fit-${i}`;
      const pr_number = 1100 + i;
      const v = makeVerdictEvent({ ts, session_id, pr_number, verdict: "BLOCKED" });
      const ma = makeMergeActionEvent({ ts, session_id, pr_number, merge_action: "closed-unmerged", resolved_at: ts });
      assertValidEvent(v);
      assertValidEvent(ma);
      events.push(v, ma);
    }
    await writeJSONL(telemetryDir, "2026-05.jsonl", events);

    const result = await computeAgreement({ targetRepoRoot: tmpRoot, lastNVerdicts: 30 });
    expect(result).not.toBeNull();
    expect(result!.sample_size).toBe(30);
    expect(result!.window_size).toBe(30);
    // All BLOCKED + closed-unmerged = agree
    expect(result!.ratio).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_AGREEMENT_WINDOW is exported and equals 50
// ---------------------------------------------------------------------------
describe("DEFAULT_AGREEMENT_WINDOW constant", () => {
  it("equals 50", () => {
    expect(DEFAULT_AGREEMENT_WINDOW).toBe(50);
  });
});
