/**
 * Integration tests for `computeSkillEffectiveness` — Story 6.8 AC2 + AC3.
 *
 * AC2: a known distribution of `skill.invoke` + `reviewer.verdict` events yields
 *      per-skill `invoke_count`, `useful_fire_count`, and `effectiveness_ratio`
 *      that match by hand — including a skill that fired but was never followed
 *      by a READY-FOR-MERGE (ratio 0) and a skill invoked once and followed by
 *      one (ratio 1).
 * AC3: the empty-telemetry result is a documented empty shape (never an error);
 *      malformed JSONL lines are skipped + counted (`malformed_lines`); the
 *      window bounds which invocations are scored, and the result reports the
 *      `window_size` / `sample_size` actually used.
 *
 * The helper reads through injected file/dir seams (like `computeAgreement`), so
 * these tests are deterministic with no real filesystem clock.
 */

import { describe, it, expect } from "vitest";
import {
  computeSkillEffectiveness,
  SkillEffectivenessResultSchema,
  DEFAULT_SKILL_EFFECTIVENESS_WINDOW,
} from "../compute-skill-effectiveness.js";
import { SkillEffectivenessWindowInvalidError } from "../../errors.js";
import { TelemetryEventSchema } from "../../schemas/telemetry-events.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOT = "/abs/repo";

/** ISO-8601 UTC timestamp at a given millisecond offset from a base epoch. */
function makeTs(offsetMs: number): string {
  return new Date(1_700_000_000_000 + offsetMs).toISOString();
}

function makeInvoke(opts: {
  ts: string;
  session_id: string;
  skill_name: string;
  story_id?: string;
  agent?: string;
}): object {
  return {
    ts: opts.ts,
    session_id: opts.session_id,
    agent: opts.agent ?? "user",
    ...(opts.story_id !== undefined ? { story_id: opts.story_id } : {}),
    type: "skill.invoke",
    data: {
      skill_name: opts.skill_name,
      skill_path: `/abs/plugins/flow/skills/${opts.skill_name.replace("crew:", "")}/SKILL.md`,
      skill_version: "0.1.0",
      skill_scope: "plugin",
      invocation_source: "user-slash-command",
    },
  };
}

function makeVerdict(opts: {
  ts: string;
  session_id: string;
  pr_number: number;
  verdict: "READY FOR MERGE" | "NEEDS CHANGES" | "BLOCKED";
  story_id?: string;
}): object {
  return {
    ts: opts.ts,
    session_id: opts.session_id,
    agent: "generalist-reviewer",
    ...(opts.story_id !== undefined ? { story_id: opts.story_id } : {}),
    type: "reviewer.verdict",
    data: {
      pr_number: opts.pr_number,
      verdict: opts.verdict,
      standards_version: "1.0.0",
      plugin_version: "1.0.0",
      timed_out: false,
    },
  };
}

/** Fast-fail if a fixture event drifts from the canonical schema. */
function assertValid(event: object): object {
  const result = TelemetryEventSchema.safeParse(event);
  if (!result.success) {
    throw new Error(
      `Fixture event not TelemetryEventSchema-valid: ${JSON.stringify(result.error.issues)}`,
    );
  }
  return event;
}

/**
 * Build injected dir/file seams from a map of filename → array of (event |
 * raw-string). Strings are emitted verbatim (for malformed-line tests);
 * objects are JSON-encoded.
 */
function seams(files: Record<string, Array<object | string>>): {
  readTelemetryDirImpl: (dir: string) => Promise<string[]>;
  readFileImpl: (filePath: string) => Promise<string>;
} {
  const names = Object.keys(files).sort();
  return {
    readTelemetryDirImpl: async () => names,
    readFileImpl: async (filePath: string) => {
      const name = filePath.split("/").pop()!;
      const lines = (files[name] ?? []).map((e) =>
        typeof e === "string" ? e : JSON.stringify(e),
      );
      return lines.join("\n") + "\n";
    },
  };
}

// ---------------------------------------------------------------------------
// AC2 — known distribution, hand-verified counts
// ---------------------------------------------------------------------------

describe("computeSkillEffectiveness — AC2 known distribution", () => {
  it("computes invoke_count, useful_fire_count, and effectiveness_ratio per skill", async () => {
    // Distribution (all in session+story flows):
    //   crew:plan  — invoked once in story A, followed by READY FOR MERGE  → ratio 1
    //   crew:board — invoked once in story B, followed by NEEDS CHANGES    → ratio 0
    //   crew:judge — invoked twice in story C, one READY FOR MERGE follows
    //                BOTH invokes (both come before the verdict)           → 2/2 = ratio 1
    //   crew:scan  — invoked once in story D, NO verdict at all            → ratio 0
    const events = [
      // story A — crew:plan, useful
      makeInvoke({ ts: makeTs(1000), session_id: "sA", skill_name: "flow:plan", story_id: "bmad:1.1" }),
      makeVerdict({ ts: makeTs(2000), session_id: "sA", pr_number: 1, verdict: "READY FOR MERGE", story_id: "bmad:1.1" }),
      // story B — crew:board, NOT useful (verdict is NEEDS CHANGES)
      makeInvoke({ ts: makeTs(3000), session_id: "sB", skill_name: "flow:board", story_id: "bmad:2.2" }),
      makeVerdict({ ts: makeTs(4000), session_id: "sB", pr_number: 2, verdict: "NEEDS CHANGES", story_id: "bmad:2.2" }),
      // story C — crew:judge twice, both before a single READY FOR MERGE → both useful
      makeInvoke({ ts: makeTs(5000), session_id: "sC", skill_name: "flow:judge", story_id: "bmad:3.3" }),
      makeInvoke({ ts: makeTs(6000), session_id: "sC", skill_name: "flow:judge", story_id: "bmad:3.3" }),
      makeVerdict({ ts: makeTs(7000), session_id: "sC", pr_number: 3, verdict: "READY FOR MERGE", story_id: "bmad:3.3" }),
      // story D — crew:scan, no verdict
      makeInvoke({ ts: makeTs(8000), session_id: "sD", skill_name: "flow:scan", story_id: "bmad:4.4" }),
    ].map(assertValid);

    const result = await computeSkillEffectiveness({
      targetRepoRoot: ROOT,
      ...seams({ "2026-05.jsonl": events }),
    });

    // Round-trips through the strict schema.
    expect(SkillEffectivenessResultSchema.safeParse(result).success).toBe(true);

    expect(result.per_skill["flow:plan"]).toEqual({
      invoke_count: 1,
      useful_fire_count: 1,
      effectiveness_ratio: 1,
    });
    expect(result.per_skill["flow:board"]).toEqual({
      invoke_count: 1,
      useful_fire_count: 0,
      effectiveness_ratio: 0,
    });
    expect(result.per_skill["flow:judge"]).toEqual({
      invoke_count: 2,
      useful_fire_count: 2,
      effectiveness_ratio: 1,
    });
    expect(result.per_skill["flow:scan"]).toEqual({
      invoke_count: 1,
      useful_fire_count: 0,
      effectiveness_ratio: 0,
    });

    expect(result.window_size).toBe(DEFAULT_SKILL_EFFECTIVENESS_WINDOW);
    expect(result.sample_size).toBe(5); // five skill.invoke events
    expect(result.malformed_lines).toBe(0);
  });

  it("does not count a verdict that PRECEDES the invocation as a useful fire", async () => {
    // A READY FOR MERGE that lands BEFORE the skill fired must not retro-credit it.
    const events = [
      makeVerdict({ ts: makeTs(1000), session_id: "sX", pr_number: 9, verdict: "READY FOR MERGE", story_id: "bmad:9.9" }),
      makeInvoke({ ts: makeTs(2000), session_id: "sX", skill_name: "flow:late", story_id: "bmad:9.9" }),
    ].map(assertValid);

    const result = await computeSkillEffectiveness({
      targetRepoRoot: ROOT,
      ...seams({ "2026-05.jsonl": events }),
    });
    expect(result.per_skill["flow:late"]).toEqual({
      invoke_count: 1,
      useful_fire_count: 0,
      effectiveness_ratio: 0,
    });
  });

  it("requires a matching story_id when both invoke and verdict carry one", async () => {
    // Same session, but the READY FOR MERGE belongs to a DIFFERENT story.
    const events = [
      makeInvoke({ ts: makeTs(1000), session_id: "sY", skill_name: "flow:cross", story_id: "bmad:10.1" }),
      makeVerdict({ ts: makeTs(2000), session_id: "sY", pr_number: 11, verdict: "READY FOR MERGE", story_id: "bmad:10.2" }),
    ].map(assertValid);

    const result = await computeSkillEffectiveness({
      targetRepoRoot: ROOT,
      ...seams({ "2026-05.jsonl": events }),
    });
    expect(result.per_skill["flow:cross"]).toEqual({
      invoke_count: 1,
      useful_fire_count: 0,
      effectiveness_ratio: 0,
    });
  });

  it("joins on session_id alone when the invocation carries no story_id", async () => {
    // A user-slash-command outside a story flow (no story_id) is kept in the
    // denominator and CAN be a useful fire if a same-session READY FOR MERGE
    // follows it.
    const events = [
      makeInvoke({ ts: makeTs(1000), session_id: "sZ", skill_name: "flow:nostory" }),
      makeVerdict({ ts: makeTs(2000), session_id: "sZ", pr_number: 12, verdict: "READY FOR MERGE", story_id: "bmad:12.1" }),
    ].map(assertValid);

    const result = await computeSkillEffectiveness({
      targetRepoRoot: ROOT,
      ...seams({ "2026-05.jsonl": events }),
    });
    expect(result.per_skill["flow:nostory"]).toEqual({
      invoke_count: 1,
      useful_fire_count: 1,
      effectiveness_ratio: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// AC3 — empty result, malformed-line counting, window bound
// ---------------------------------------------------------------------------

describe("computeSkillEffectiveness — AC3 edges", () => {
  it("returns a documented empty result (empty map, never an error) over an empty telemetry dir", async () => {
    const result = await computeSkillEffectiveness({
      targetRepoRoot: ROOT,
      readTelemetryDirImpl: async () => [], // dir exists but has no *.jsonl
      readFileImpl: async () => "",
    });
    expect(result).toEqual({
      per_skill: {},
      window_size: DEFAULT_SKILL_EFFECTIVENESS_WINDOW,
      sample_size: 0,
      malformed_lines: 0,
    });
  });

  it("returns the empty result when the telemetry dir is absent (ENOENT)", async () => {
    const result = await computeSkillEffectiveness({
      targetRepoRoot: ROOT,
      readTelemetryDirImpl: async () => {
        const err = new Error("no dir") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      },
      readFileImpl: async () => "",
    });
    expect(result.per_skill).toEqual({});
    expect(result.sample_size).toBe(0);
  });

  it("returns the empty map (with malformed count) when there are zero skill.invoke events", async () => {
    const events = [
      makeVerdict({ ts: makeTs(1000), session_id: "s1", pr_number: 1, verdict: "READY FOR MERGE", story_id: "bmad:1.1" }),
    ].map(assertValid);
    const result = await computeSkillEffectiveness({
      targetRepoRoot: ROOT,
      ...seams({ "2026-05.jsonl": [...events, "{ not json"] }),
    });
    expect(result.per_skill).toEqual({});
    expect(result.malformed_lines).toBe(1);
  });

  it("skips and counts malformed JSONL lines (both bad-JSON and schema-invalid)", async () => {
    const good = makeInvoke({ ts: makeTs(1000), session_id: "s2", skill_name: "flow:plan", story_id: "bmad:1.1" });
    const verdict = makeVerdict({ ts: makeTs(2000), session_id: "s2", pr_number: 1, verdict: "READY FOR MERGE", story_id: "bmad:1.1" });
    assertValid(good);
    assertValid(verdict);
    const result = await computeSkillEffectiveness({
      targetRepoRoot: ROOT,
      ...seams({
        "2026-05.jsonl": [
          good,
          "this is not json at all",
          JSON.stringify({ type: "skill.invoke", data: {} }), // schema-invalid
          verdict,
          "", // blank line — skipped silently, NOT malformed
        ],
      }),
    });
    expect(result.per_skill["flow:plan"]).toEqual({
      invoke_count: 1,
      useful_fire_count: 1,
      effectiveness_ratio: 1,
    });
    expect(result.malformed_lines).toBe(2); // bad-JSON + schema-invalid; blank not counted
    expect(result.sample_size).toBe(1);
  });

  it("bounds the scored invocations by the window and reports window_size / sample_size used", async () => {
    // Four invocations of crew:plan; with window 2 only the two NEWEST are scored.
    // Newest two are at ts 4000 + 3000 (both BEFORE the READY FOR MERGE at 5000),
    // so they are useful; the older two (1000, 2000) are excluded from the window.
    const events = [
      makeInvoke({ ts: makeTs(1000), session_id: "s3", skill_name: "flow:plan", story_id: "bmad:1.1" }),
      makeInvoke({ ts: makeTs(2000), session_id: "s3", skill_name: "flow:plan", story_id: "bmad:1.1" }),
      makeInvoke({ ts: makeTs(3000), session_id: "s3", skill_name: "flow:plan", story_id: "bmad:1.1" }),
      makeInvoke({ ts: makeTs(4000), session_id: "s3", skill_name: "flow:plan", story_id: "bmad:1.1" }),
      makeVerdict({ ts: makeTs(5000), session_id: "s3", pr_number: 1, verdict: "READY FOR MERGE", story_id: "bmad:1.1" }),
    ].map(assertValid);

    const result = await computeSkillEffectiveness({
      targetRepoRoot: ROOT,
      window: 2,
      ...seams({ "2026-05.jsonl": events }),
    });
    expect(result.window_size).toBe(2);
    expect(result.sample_size).toBe(2); // only two invocations inside the window
    expect(result.per_skill["flow:plan"]).toEqual({
      invoke_count: 2,
      useful_fire_count: 2,
      effectiveness_ratio: 1,
    });
  });

  it("sample_size never exceeds the actual invocation count even when window is larger", async () => {
    const events = [
      makeInvoke({ ts: makeTs(1000), session_id: "s4", skill_name: "flow:plan", story_id: "bmad:1.1" }),
    ].map(assertValid);
    const result = await computeSkillEffectiveness({
      targetRepoRoot: ROOT,
      window: 100,
      ...seams({ "2026-05.jsonl": events }),
    });
    expect(result.window_size).toBe(100);
    expect(result.sample_size).toBe(1);
  });

  it("throws SkillEffectivenessWindowInvalidError on an invalid window", async () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        computeSkillEffectiveness({
          targetRepoRoot: ROOT,
          window: bad,
          ...seams({ "2026-05.jsonl": [] }),
        }),
      ).rejects.toBeInstanceOf(SkillEffectivenessWindowInvalidError);
    }
  });

  it("is deterministic — identical telemetry yields identical numbers across runs", async () => {
    const events = [
      makeInvoke({ ts: makeTs(1000), session_id: "s5", skill_name: "flow:plan", story_id: "bmad:1.1" }),
      makeInvoke({ ts: makeTs(1500), session_id: "s5", skill_name: "flow:board", story_id: "bmad:1.1" }),
      makeVerdict({ ts: makeTs(2000), session_id: "s5", pr_number: 1, verdict: "READY FOR MERGE", story_id: "bmad:1.1" }),
    ].map(assertValid);
    const opts = { targetRepoRoot: ROOT, ...seams({ "2026-05.jsonl": events }) };
    const a = await computeSkillEffectiveness(opts);
    const b = await computeSkillEffectiveness(opts);
    expect(a).toEqual(b);
  });
});
