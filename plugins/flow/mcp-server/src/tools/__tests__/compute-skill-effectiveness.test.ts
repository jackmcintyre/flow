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
      skill_path: `/abs/plugins/flow/skills/${opts.skill_name.replace("flow:", "")}/SKILL.md`,
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
    //   flow:plan  — invoked once in story A, followed by READY FOR MERGE  → ratio 1
    //   flow:board — invoked once in story B, followed by NEEDS CHANGES    → ratio 0
    //   flow:judge — invoked twice in story C, one READY FOR MERGE follows
    //                BOTH invokes (both come before the verdict)           → 2/2 = ratio 1
    //   flow:scan  — invoked once in story D, NO verdict at all            → ratio 0
    const events = [
      // story A — flow:plan, useful
      makeInvoke({ ts: makeTs(1000), session_id: "sA", skill_name: "flow:plan", story_id: "bmad:1.1" }),
      makeVerdict({ ts: makeTs(2000), session_id: "sA", pr_number: 1, verdict: "READY FOR MERGE", story_id: "bmad:1.1" }),
      // story B — flow:board, NOT useful (verdict is NEEDS CHANGES)
      makeInvoke({ ts: makeTs(3000), session_id: "sB", skill_name: "flow:board", story_id: "bmad:2.2" }),
      makeVerdict({ ts: makeTs(4000), session_id: "sB", pr_number: 2, verdict: "NEEDS CHANGES", story_id: "bmad:2.2" }),
      // story C — flow:judge twice, both before a single READY FOR MERGE → both useful
      makeInvoke({ ts: makeTs(5000), session_id: "sC", skill_name: "flow:judge", story_id: "bmad:3.3" }),
      makeInvoke({ ts: makeTs(6000), session_id: "sC", skill_name: "flow:judge", story_id: "bmad:3.3" }),
      makeVerdict({ ts: makeTs(7000), session_id: "sC", pr_number: 3, verdict: "READY FOR MERGE", story_id: "bmad:3.3" }),
      // story D — flow:scan, no verdict
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
      skill_tier: "planning",
    });
    expect(result.per_skill["flow:board"]).toEqual({
      invoke_count: 1,
      useful_fire_count: 0,
      effectiveness_ratio: 0,
      skill_tier: "execution",
    });
    expect(result.per_skill["flow:judge"]).toEqual({
      invoke_count: 2,
      useful_fire_count: 2,
      effectiveness_ratio: 1,
      skill_tier: "execution",
    });
    expect(result.per_skill["flow:scan"]).toEqual({
      invoke_count: 1,
      useful_fire_count: 0,
      effectiveness_ratio: 0,
      skill_tier: "execution",
    });

    expect(result.window_size).toBe(DEFAULT_SKILL_EFFECTIVENESS_WINDOW);
    expect(result.sample_size).toBe(5); // five skill.invoke events
    expect(result.malformed_lines).toBe(0);
    // READY FOR MERGE verdicts existed → real signal (issue #390).
    expect(result.attribution).toBe("attributed");
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
      skill_tier: "execution",
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
      skill_tier: "execution",
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
      skill_tier: "execution",
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
      attribution: "no-completed-flows",
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
      skill_tier: "planning",
    });
    expect(result.malformed_lines).toBe(2); // bad-JSON + schema-invalid; blank not counted
    expect(result.sample_size).toBe(1);
  });

  it("bounds the scored invocations by the window and reports window_size / sample_size used", async () => {
    // Four invocations of flow:plan; with window 2 only the two NEWEST are scored.
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
      skill_tier: "planning",
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

  it("reports attribution:attributed when planning-tier skill fires even with no READY FOR MERGE verdict (issue #390 widened)", async () => {
    // flow:plan is a planning-tier skill — presence-based scoring means its
    // invoke IS a useful fire regardless of verdicts. The cycle attribution is
    // therefore "attributed" (not "no-completed-flows") so the retro does not
    // misread planning activity as universal skill ineffectiveness.
    const events = [
      makeInvoke({ ts: makeTs(1000), session_id: "sN", skill_name: "flow:plan", story_id: "bmad:1.1" }),
      makeInvoke({ ts: makeTs(2000), session_id: "sN", skill_name: "flow:board", story_id: "bmad:1.1" }),
      makeVerdict({ ts: makeTs(3000), session_id: "sN", pr_number: 1, verdict: "NEEDS CHANGES", story_id: "bmad:1.1" }),
    ].map(assertValid);
    const result = await computeSkillEffectiveness({
      targetRepoRoot: ROOT,
      ...seams({ "2026-05.jsonl": events }),
    });
    // flow:plan is planning-tier — its invoke IS a useful fire, so "attributed".
    expect(result.attribution).toBe("attributed");
    // flow:plan presence-scored: useful_fire_count equals invoke_count.
    expect(result.per_skill["flow:plan"]!.useful_fire_count).toBe(1);
    expect(result.per_skill["flow:plan"]!.effectiveness_ratio).toBe(1);
    // flow:board is unknown (falls back to execution tier) — no READY FOR MERGE
    // → useful_fire_count 0, ratio 0.
    expect(result.per_skill["flow:board"]!.useful_fire_count).toBe(0);
  });

  it("reports attribution:no-completed-flows when ONLY pure execution-tier skills fire with no READY FOR MERGE verdict", async () => {
    // flow:run is execution-tier, flow:unknown-new-skill falls back to execution.
    // No READY FOR MERGE verdict and no planning/cockpit invocations → "nothing
    // to attribute" (true negative, not a false "useless" signal).
    const events = [
      makeInvoke({ ts: makeTs(1000), session_id: "sX", skill_name: "flow:run", story_id: "bmad:5.5" }),
      makeInvoke({ ts: makeTs(2000), session_id: "sX", skill_name: "flow:unknown-new-skill", story_id: "bmad:5.5" }),
      makeVerdict({ ts: makeTs(3000), session_id: "sX", pr_number: 5, verdict: "NEEDS CHANGES", story_id: "bmad:5.5" }),
    ].map(assertValid);
    const result = await computeSkillEffectiveness({
      targetRepoRoot: ROOT,
      ...seams({ "2026-05.jsonl": events }),
    });
    expect(result.attribution).toBe("no-completed-flows");
    expect(result.per_skill["flow:run"]!.useful_fire_count).toBe(0);
    expect(result.per_skill["flow:unknown-new-skill"]!.useful_fire_count).toBe(0);
  });

  it("joins invoke→verdict on story_id across divergent session_ids (issue #390 root cause)", async () => {
    // THE BUG: the capture seam stamps the harness session_id on skill.invoke,
    // while post-reviewer-comments stamps a run ULID on reviewer.verdict — the
    // two NEVER match. The story_id join must still credit the useful fire.
    const events = [
      makeInvoke({ ts: makeTs(1000), session_id: "harness-sess-abc", skill_name: "flow:run", story_id: "native:01STORY" }),
      makeVerdict({ ts: makeTs(2000), session_id: "run-ulid-xyz", pr_number: 7, verdict: "READY FOR MERGE", story_id: "native:01STORY" }),
    ].map(assertValid);
    const result = await computeSkillEffectiveness({
      targetRepoRoot: ROOT,
      ...seams({ "2026-05.jsonl": events }),
    });
    expect(result.per_skill["flow:run"]).toEqual({
      invoke_count: 1,
      useful_fire_count: 1, // joined on story_id despite mismatched session_id
      effectiveness_ratio: 1,
      skill_tier: "execution",
    });
    expect(result.attribution).toBe("attributed");
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

// ---------------------------------------------------------------------------
// Done/-manifest attribution — Story native:01KVS12K AC1 + AC2
// ---------------------------------------------------------------------------

describe("computeSkillEffectiveness — done/-manifest attribution (Story native:01KVS12K)", () => {
  it("AC1: credits a done-but-no-verdict-event invoke as a useful fire via done/-manifest read", async () => {
    // A skill.invoke whose story_id reached done/ but has NO joined READY FOR
    // MERGE reviewer.verdict in telemetry — the done/-manifest is the only signal.
    // Before this fix: useful_fire_count 0 → retro wrongly proposes retire/revise.
    // After this fix: useful_fire_count 1, effectiveness_ratio 1.
    const doneStoryRef = "native:01DONE0NOVERDICT00000001";
    const events = [
      makeInvoke({ ts: makeTs(1000), session_id: "s-done-1", skill_name: "flow:run", story_id: doneStoryRef }),
      // No READY FOR MERGE verdict for this story — only the done/ manifest signals completion.
    ].map(assertValid);

    const result = await computeSkillEffectiveness({
      targetRepoRoot: ROOT,
      ...seams({ "2026-06.jsonl": events }),
      readDoneRefsImpl: async () => new Set([doneStoryRef]),
    });

    expect(SkillEffectivenessResultSchema.safeParse(result).success).toBe(true);
    expect(result.per_skill["flow:run"]).toEqual({
      invoke_count: 1,
      useful_fire_count: 1,
      effectiveness_ratio: 1,
      skill_tier: "execution",
    });
    // Done refs present → signal is "attributed", not "no-completed-flows".
    expect(result.attribution).toBe("attributed");
  });

  it("AC2a: a not-done, no-verdict invoke is NOT credited (genuinely unhelpful skill stays 0)", async () => {
    // A skill.invoke whose story is neither in done/ nor has a joined READY FOR
    // MERGE verdict must remain uncredited — the done/ path must not over-credit.
    const notDoneStoryRef = "native:01NOTDONE0000000000001";
    const events = [
      makeInvoke({ ts: makeTs(1000), session_id: "s-notdone-1", skill_name: "flow:run", story_id: notDoneStoryRef }),
      // No verdict and story NOT in done/.
    ].map(assertValid);

    const result = await computeSkillEffectiveness({
      targetRepoRoot: ROOT,
      ...seams({ "2026-06.jsonl": events }),
      readDoneRefsImpl: async () => new Set(), // empty done set
    });

    expect(SkillEffectivenessResultSchema.safeParse(result).success).toBe(true);
    expect(result.per_skill["flow:run"]).toEqual({
      invoke_count: 1,
      useful_fire_count: 0,
      effectiveness_ratio: 0,
      skill_tier: "execution",
    });
    // No done refs, no verdicts, no planning/cockpit → "no-completed-flows".
    expect(result.attribution).toBe("no-completed-flows");
  });

  it("AC2b: a skill.invoke that already joins a READY-FOR-MERGE verdict still counts as a useful fire exactly as today", async () => {
    // The existing verdict-join path must be unaffected by the done/-manifest
    // augmentation. An invoke followed by a READY FOR MERGE verdict (regardless of
    // whether the story also has a done/ manifest) must still be credited.
    const storyRef = "native:01VERDICTANDDO00000001";
    const events = [
      makeInvoke({ ts: makeTs(1000), session_id: "s-v-d", skill_name: "flow:run", story_id: storyRef }),
      makeVerdict({ ts: makeTs(2000), session_id: "run-ulid-v-d", pr_number: 42, verdict: "READY FOR MERGE", story_id: storyRef }),
    ].map(assertValid);

    // Provide both: verdict in telemetry AND story in done/ — must still credit once.
    const result = await computeSkillEffectiveness({
      targetRepoRoot: ROOT,
      ...seams({ "2026-06.jsonl": events }),
      readDoneRefsImpl: async () => new Set([storyRef]),
    });

    expect(SkillEffectivenessResultSchema.safeParse(result).success).toBe(true);
    expect(result.per_skill["flow:run"]).toEqual({
      invoke_count: 1,
      useful_fire_count: 1,     // credited exactly once (verdict join wins; done/ is redundant but harmless)
      effectiveness_ratio: 1,
      skill_tier: "execution",
    });
    expect(result.attribution).toBe("attributed");
  });

  it("done/-manifest ENOENT is treated as empty set (no done refs), not an error", async () => {
    // Repos without a done/ dir yet should behave as if there are no done refs —
    // consistent with the empty-telemetry-dir posture.
    const events = [
      makeInvoke({ ts: makeTs(1000), session_id: "s-enoent", skill_name: "flow:run", story_id: "native:01SOMEREF000" }),
    ].map(assertValid);

    // Simulate ENOENT on the done/ dir via the injected seam.
    const result = await computeSkillEffectiveness({
      targetRepoRoot: ROOT,
      ...seams({ "2026-06.jsonl": events }),
      readDoneRefsImpl: async () => {
        const err = new Error("no done dir") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      },
    });

    // Should not throw; the invoke is uncredited (no verdict, no done manifest).
    expect(result.per_skill["flow:run"]).toEqual({
      invoke_count: 1,
      useful_fire_count: 0,
      effectiveness_ratio: 0,
      skill_tier: "execution",
    });
  });
});

// ---------------------------------------------------------------------------
// Tier-aware scoring — Story native:01KVEYY1 AC1 + AC2 + AC3
// ---------------------------------------------------------------------------

describe("computeSkillEffectiveness — tier-aware scoring", () => {
  it("AC1: mixed execution+planning cycle yields differentiated per-tier scores — flow:run on verdict join, flow:plan on presence", async () => {
    // Scenario: /flow:plan invoked 5 times, /flow:run invoked 2 times; both runs
    // reach READY FOR MERGE. The retro analyst must see:
    //   - flow:plan: effectiveness_ratio 1.0 (planning tier — presence-based)
    //   - flow:run:  effectiveness_ratio 1.0 (execution tier — verdict join)
    // Without tier-aware scoring, flow:plan would score 0 (never directly
    // precedes a verdict under the old join criterion).
    const planInvokes = [1000, 2000, 3000, 4000, 5000].map((ms) =>
      makeInvoke({ ts: makeTs(ms), session_id: "sess-plan", skill_name: "flow:plan" }),
    );
    const runInvoke1 = makeInvoke({ ts: makeTs(6000), session_id: "sess-run-1", skill_name: "flow:run", story_id: "native:S01" });
    const runVerdict1 = makeVerdict({ ts: makeTs(7000), session_id: "run-ulid-1", pr_number: 1, verdict: "READY FOR MERGE", story_id: "native:S01" });
    const runInvoke2 = makeInvoke({ ts: makeTs(8000), session_id: "sess-run-2", skill_name: "flow:run", story_id: "native:S02" });
    const runVerdict2 = makeVerdict({ ts: makeTs(9000), session_id: "run-ulid-2", pr_number: 2, verdict: "READY FOR MERGE", story_id: "native:S02" });

    const events = [...planInvokes, runInvoke1, runVerdict1, runInvoke2, runVerdict2].map(assertValid);

    const result = await computeSkillEffectiveness({
      targetRepoRoot: ROOT,
      ...seams({ "2026-06.jsonl": events }),
    });

    // Round-trips through the strict schema.
    expect(SkillEffectivenessResultSchema.safeParse(result).success).toBe(true);

    // flow:run — execution tier, verdict join: both invocations joined to their
    // own READY FOR MERGE verdicts via story_id → ratio 1.
    expect(result.per_skill["flow:run"]).toEqual({
      invoke_count: 2,
      useful_fire_count: 2,
      effectiveness_ratio: 1,
      skill_tier: "execution",
    });

    // flow:plan — planning tier, presence-based: all 5 invocations are useful
    // fires → ratio 1 (non-zero, so the retro sees a real positive signal).
    expect(result.per_skill["flow:plan"]).toEqual({
      invoke_count: 5,
      useful_fire_count: 5,
      effectiveness_ratio: 1,
      skill_tier: "planning",
    });

    // Both scores are present and non-zero → "attributed".
    expect(result.attribution).toBe("attributed");
  });

  it("AC2: cockpit-only cycle with no READY FOR MERGE verdicts yields positive effectiveness_ratio for cockpit skills", async () => {
    // Scenario: only /flow:dashboard and /flow:ask were invoked; no stories
    // shipped yet. The retro must not read this as "all skills useless".
    const events = [
      makeInvoke({ ts: makeTs(1000), session_id: "sess-cockpit", skill_name: "flow:dashboard" }),
      makeInvoke({ ts: makeTs(2000), session_id: "sess-cockpit", skill_name: "flow:dashboard" }),
      makeInvoke({ ts: makeTs(3000), session_id: "sess-cockpit", skill_name: "flow:ask" }),
    ].map(assertValid);

    const result = await computeSkillEffectiveness({
      targetRepoRoot: ROOT,
      ...seams({ "2026-06.jsonl": events }),
    });

    // Round-trips through the strict schema.
    expect(SkillEffectivenessResultSchema.safeParse(result).success).toBe(true);

    // flow:dashboard — cockpit tier, presence-based: 2 invocations → ratio 1.
    expect(result.per_skill["flow:dashboard"]).toEqual({
      invoke_count: 2,
      useful_fire_count: 2,
      effectiveness_ratio: 1,
      skill_tier: "cockpit",
    });

    // flow:ask — cockpit tier, presence-based: 1 invocation → ratio 1.
    expect(result.per_skill["flow:ask"]).toEqual({
      invoke_count: 1,
      useful_fire_count: 1,
      effectiveness_ratio: 1,
      skill_tier: "cockpit",
    });

    // Cockpit invocations qualify as "attributed" — the retro can distinguish
    // "cockpit skills actively used, no stories done yet" from "all useless".
    expect(result.attribution).toBe("attributed");
    // No verdicts → usefulVerdictCount is 0, but attribution is still "attributed"
    // because anyNonExecutionInvoke is true.
    expect(result.per_skill).not.toHaveProperty("flow:run");
  });

  it("AC3: unknown skill name (not in tier table) falls back to execution tier and is scored on the verdict join", async () => {
    // A brand-new skill not yet in the tier table must NOT receive a false-positive
    // ratio — it falls back to execution tier and is scored on the verdict join.
    const events = [
      // Invoked before the verdict → would be useful IF execution-tier join fires.
      makeInvoke({ ts: makeTs(1000), session_id: "sess-new", skill_name: "flow:brand-new-skill", story_id: "native:S99" }),
      makeVerdict({ ts: makeTs(2000), session_id: "run-ulid-new", pr_number: 99, verdict: "READY FOR MERGE", story_id: "native:S99" }),
      // A second invocation with NO verdict → NOT useful (execution-tier, no join match).
      makeInvoke({ ts: makeTs(3000), session_id: "sess-new2", skill_name: "flow:brand-new-skill", story_id: "native:S100" }),
    ].map(assertValid);

    const result = await computeSkillEffectiveness({
      targetRepoRoot: ROOT,
      ...seams({ "2026-06.jsonl": events }),
    });

    // Round-trips through the strict schema.
    expect(SkillEffectivenessResultSchema.safeParse(result).success).toBe(true);

    // flow:brand-new-skill — execution fallback: first invoke joined to its
    // READY FOR MERGE (story_id join), second has no verdict → ratio 0.5.
    expect(result.per_skill["flow:brand-new-skill"]).toEqual({
      invoke_count: 2,
      useful_fire_count: 1,
      effectiveness_ratio: 0.5,
      skill_tier: "execution",
    });

    // Execution fallback means the skill CAN'T produce a false-positive
    // presence-based score — it must earn its ratio via the verdict join.
    expect(result.attribution).toBe("attributed");
  });
});

// ---------------------------------------------------------------------------
// Retired-skill installed-check — Story native:01KW5WPDPJY5DK6JV810307E0J
// AC1: re-rooted path, retired excluded, moved/renamed live skill kept.
// AC2: injected IO seam (no raw fs — fake ROOT=/abs/repo never touched).
// AC3: live skill counts unaffected by the filter.
// AC4: ambiguous path (matches neither candidate dir) defaults to installed.
// ---------------------------------------------------------------------------

describe("computeSkillEffectiveness — retired-skill installed-check (native:01KW5WPDPJY5DK6JV810307E0J)", () => {
  /**
   * Commands that are "currently installed" in this test suite.
   * Corresponds to the flow plugin's current skill palette.
   * Any command NOT in this set is treated as retired.
   */
  const liveCommands = new Set([
    "run", "plan", "retro", "ready", "hire", "ask", "dashboard", "help", "init",
  ]);

  /**
   * Build a fake existsImpl that examines the re-rooted candidate-1 path
   * ({ROOT}/plugins/flow/skills/{command}/SKILL.md) and returns true only when
   * the extracted command is in `liveCommands`.
   *
   * ROOT = "/abs/repo" is non-existent on disk — this seam ensures NO real fs
   * access happens inside the helper, which is the whole point of AC2.
   *
   * @param onCheck  Optional spy callback fired on every existsImpl call.
   */
  function makeExistsImpl(
    onCheck?: (path: string) => void,
  ): (filePath: string) => boolean {
    return (filePath: string): boolean => {
      onCheck?.(filePath);
      const m = filePath.match(/[/\\]skills[/\\]([^/\\]+)[/\\]SKILL\.md$/i);
      if (!m) return false;
      return liveCommands.has(m[1] ?? "");
    };
  }

  it("AC1: retired skill is excluded; live skill whose path was captured at an old install location is NOT misclassified", async () => {
    // flow:run is live → kept in per_skill with its READY FOR MERGE verdict counted.
    // flow:author is retired (removed from the plugin) → excluded from per_skill.
    // The skill_paths are captured at an OLD install location (/abs/plugins/flow/...)
    // that no longer matches the current install — but the re-rooting logic extracts
    // the command and checks the candidate dir, so a live skill is never wrong excluded.
    const events = [
      makeInvoke({ ts: makeTs(1000), session_id: "s-ret-1", skill_name: "flow:run", story_id: "native:01RET001" }),
      makeInvoke({ ts: makeTs(2000), session_id: "s-ret-1", skill_name: "flow:author", story_id: "native:01RET002" }),
      makeVerdict({ ts: makeTs(3000), session_id: "run-ret-1", pr_number: 1, verdict: "READY FOR MERGE", story_id: "native:01RET001" }),
    ].map(assertValid);

    const result = await computeSkillEffectiveness({
      targetRepoRoot: ROOT,
      ...seams({ "2026-05.jsonl": events }),
      existsImpl: makeExistsImpl(),
    });

    expect(SkillEffectivenessResultSchema.safeParse(result).success).toBe(true);
    // flow:run is live → present in per_skill with its verdict-joined useful fire.
    expect(result.per_skill).toHaveProperty("flow:run");
    expect(result.per_skill["flow:run"]).toMatchObject({
      invoke_count: 1,
      useful_fire_count: 1,
      effectiveness_ratio: 1,
      skill_tier: "execution",
    });
    // flow:author is retired → excluded from the scored set (zero-ratio active set).
    expect(result.per_skill).not.toHaveProperty("flow:author");
  });

  it("AC2: installed-check routes through the injected IO seam; no raw fs is used", async () => {
    // ROOT = "/abs/repo" does not exist on disk. If the helper called raw existsSync
    // internally, the check would always return false (no skills dir at /abs/repo) and
    // every skill would be wrongly filtered. The injected seam is the ONLY IO for the
    // installed-check — this test is a structural proof that raw fs is forbidden.
    let seamCallCount = 0;
    const trackingExistsImpl = (p: string): boolean => {
      seamCallCount++;
      return makeExistsImpl()(p);
    };

    const events = [
      makeInvoke({ ts: makeTs(1000), session_id: "s-seam-1", skill_name: "flow:run", story_id: "native:01SEAM001" }),
    ].map(assertValid);

    const result = await computeSkillEffectiveness({
      targetRepoRoot: ROOT,
      ...seams({ "2026-05.jsonl": events }),
      existsImpl: trackingExistsImpl,
    });

    // The seam was called — confirming the installed-check executed.
    expect(seamCallCount).toBeGreaterThanOrEqual(1);
    // flow:run is live (seam returned true for its candidate) → in per_skill.
    expect(result.per_skill).toHaveProperty("flow:run");
    // Because ROOT is a fake non-existent path, only the injected seam can return
    // true here. If the test passes, the helper did NOT fall back to raw fs.
  });

  it("AC3: a skill still installed on disk is unaffected — invoke_count and effectiveness_ratio unchanged by the filter", async () => {
    // flow:plan is a live planning-tier skill. With existsImpl active, the
    // installed-check must NOT alter its invoke_count or effectiveness_ratio.
    // Planning tier is presence-scored → every invocation is a useful fire → ratio 1.
    const events = [
      makeInvoke({ ts: makeTs(1000), session_id: "s-live-1", skill_name: "flow:plan", story_id: "native:01LIVE001" }),
      makeInvoke({ ts: makeTs(2000), session_id: "s-live-1", skill_name: "flow:plan", story_id: "native:01LIVE001" }),
    ].map(assertValid);

    const result = await computeSkillEffectiveness({
      targetRepoRoot: ROOT,
      ...seams({ "2026-05.jsonl": events }),
      existsImpl: makeExistsImpl(),
    });

    // Both invocations are kept — the installed-check does NOT skip live skills.
    expect(result.per_skill["flow:plan"]).toEqual({
      invoke_count: 2,
      useful_fire_count: 2,
      effectiveness_ratio: 1,
      skill_tier: "planning",
    });
  });

  it("AC4 (integration): retired skill excluded; ambiguous other-plugin path defaults to installed and is never wrongly dropped", async () => {
    // Scenario verbatim from the story AC4:
    // - flow:author is retired (skill_path matches the canonical /skills/{cmd}/SKILL.md
    //   pattern, existsImpl returns false for its candidate) → excluded from per_skill.
    // - "flow:relpath" has a skill_path that matches NEITHER candidate dir (no
    //   /skills/{command}/SKILL.md suffix at all) → ambiguous → treated as installed,
    //   so it is NOT filtered out even though it is not in liveCommands.
    //
    // The READY FOR MERGE verdict for the ambiguous skill confirms it is correctly
    // scored (execution tier, verdict join) — the retro sees a real signal, not a
    // silently-dropped skill that still exists in some other plugin or configuration.
    const ambiguousPath = "other-plugin/relpath/something.md"; // no /skills/{cmd}/SKILL.md

    const eventsRaw = [
      // Retired skill in the window.
      assertValid(makeInvoke({ ts: makeTs(1000), session_id: "s-ac4-ret", skill_name: "flow:author", story_id: "native:01AC4RET" })),
      // Ambiguous-path skill: manually override skill_path to a non-canonical value.
      assertValid({
        ts: makeTs(2000),
        session_id: "s-ac4-amb",
        agent: "user",
        story_id: "native:01AC4AMB",
        type: "skill.invoke",
        data: {
          skill_name: "flow:relpath",
          skill_path: ambiguousPath,
          skill_version: "0.1.0",
          skill_scope: "plugin" as const,
          invocation_source: "user-slash-command" as const,
        },
      }),
      // Verdict for the ambiguous skill → it IS a useful fire.
      assertValid(makeVerdict({ ts: makeTs(3000), session_id: "run-ac4-amb", pr_number: 1, verdict: "READY FOR MERGE", story_id: "native:01AC4AMB" })),
    ];

    const result = await computeSkillEffectiveness({
      targetRepoRoot: ROOT,
      ...seams({ "2026-05.jsonl": eventsRaw }),
      existsImpl: makeExistsImpl(),
    });

    expect(SkillEffectivenessResultSchema.safeParse(result).success).toBe(true);
    // Retired skill: excluded — does not appear as a 0-ratio active skill.
    expect(result.per_skill).not.toHaveProperty("flow:author");
    // Ambiguous skill: treated as installed — never wrongly dropped.
    expect(result.per_skill).toHaveProperty("flow:relpath");
    expect(result.per_skill["flow:relpath"]).toEqual({
      invoke_count: 1,
      useful_fire_count: 1,
      effectiveness_ratio: 1,
      skill_tier: "execution",
    });
  });
});
