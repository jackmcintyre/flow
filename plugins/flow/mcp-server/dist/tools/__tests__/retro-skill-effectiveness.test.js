/**
 * Tests for the skill-effectiveness retro signal — Story native:01KT49PKTMJPJM7WMCB67TA6EY.
 *
 * AC1 (integration): Given a cycle in which at least one skill was invoked and at
 *   least one story reached a READY FOR MERGE verdict, gatherRetroInputs returns a
 *   skillEffectiveness bundle whose per_skill map carries invoke_count,
 *   useful_fire_count, and effectiveness_ratio for each skill that fired — so the
 *   analyst can cite specific numbers without re-deriving them from raw telemetry.
 *
 * AC2 (unit): The retro-analyst catalogue prompt instructs the analyst to cite
 *   effectiveness_ratio and invoke_count from skillEffectiveness.per_skill when
 *   drafting a skill-retire or skill-revise proposal, and to never recount
 *   invocations from raw telemetry — the same discipline enforced for the
 *   fire-count and recurring-friction signals.
 *
 * AC3 (unit): Given a cycle with no skill-invoke telemetry, gatherRetroInputs
 *   completes without error and skillEffectiveness.per_skill is an empty map —
 *   the retro does not fail or skip due to an absent signal.
 *
 * AC1/AC3 use real tool implementations against a temp filesystem (mirroring
 * retro-friction-signal.test.ts); AC2 reads the real catalogue via readCatalogue
 * (mirroring retro-persona-append-proposals.test.ts) — no mocks of the things
 * under test.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gatherRetroInputs } from "../gather-retro-inputs.js";
import { readCatalogue } from "../read-catalogue.js";
import { getPluginRoot } from "../../lib/plugin-root.js";
// ---------------------------------------------------------------------------
// Shared telemetry fixture builders
// ---------------------------------------------------------------------------
function makeSkillInvokeLine(opts) {
    return JSON.stringify({
        ts: opts.ts,
        session_id: opts.session_id,
        agent: "user",
        ...(opts.story_id !== undefined ? { story_id: opts.story_id } : {}),
        type: "skill.invoke",
        data: {
            skill_name: opts.skill_name,
            skill_path: `/abs/plugins/flow/skills/${opts.skill_name.replace("flow:", "")}/SKILL.md`,
            skill_version: "0.1.0",
            skill_scope: "plugin",
            invocation_source: "user-slash-command",
        },
    });
}
function makeVerdictLine(opts) {
    return JSON.stringify({
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
    });
}
// ---------------------------------------------------------------------------
// AC1: Integration — skill-effectiveness surfaces in gatherRetroInputs
// ---------------------------------------------------------------------------
describe("AC1 — gatherRetroInputs includes skillEffectiveness.per_skill with correct counts", () => {
    let tmpRoot;
    beforeEach(async () => {
        tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "retro-skilleff-ac1-"));
    });
    afterEach(async () => {
        await fs.rm(tmpRoot, { recursive: true, force: true });
    });
    it("reports invoke_count, useful_fire_count, and effectiveness_ratio per skill that fired", async () => {
        const telemetryDir = path.join(tmpRoot, ".flow", "telemetry");
        await fs.mkdir(telemetryDir, { recursive: true });
        // flow:plan invoked twice in story S1; the story reaches READY FOR MERGE
        //   after both invocations → both are useful fires → ratio 1.
        // flow:author invoked once in story S2 whose verdict is NEEDS CHANGES →
        //   not a useful fire → ratio 0.
        const lines = [
            makeSkillInvokeLine({ skill_name: "flow:plan", session_id: "01KSESSAAAAAAAAAAAAAAAAAA1", story_id: "native:01KSTORY00000000000000001", ts: "2026-06-01T10:00:00.000Z" }),
            makeSkillInvokeLine({ skill_name: "flow:plan", session_id: "01KSESSAAAAAAAAAAAAAAAAAA1", story_id: "native:01KSTORY00000000000000001", ts: "2026-06-01T10:01:00.000Z" }),
            makeVerdictLine({ session_id: "01KSESSAAAAAAAAAAAAAAAAAA1", story_id: "native:01KSTORY00000000000000001", verdict: "READY FOR MERGE", pr_number: 101, ts: "2026-06-01T10:05:00.000Z" }),
            makeSkillInvokeLine({ skill_name: "flow:author", session_id: "01KSESSBBBBBBBBBBBBBBBBBB2", story_id: "native:01KSTORY00000000000000002", ts: "2026-06-01T11:00:00.000Z" }),
            makeVerdictLine({ session_id: "01KSESSBBBBBBBBBBBBBBBBBB2", story_id: "native:01KSTORY00000000000000002", verdict: "NEEDS CHANGES", pr_number: 102, ts: "2026-06-01T11:05:00.000Z" }),
        ];
        await fs.writeFile(path.join(telemetryDir, "2026-06.jsonl"), lines.join("\n") + "\n", "utf8");
        const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });
        // The signal is present and carries a per_skill map.
        expect(bundle.skillEffectiveness).toBeDefined();
        const perSkill = bundle.skillEffectiveness.per_skill;
        // flow:plan — 2 invocations, both useful (later READY FOR MERGE in flow) → ratio 1.
        expect(perSkill["flow:plan"]).toEqual({
            invoke_count: 2,
            useful_fire_count: 2,
            effectiveness_ratio: 1,
        });
        // flow:author — 1 invocation, no READY FOR MERGE → ratio 0 (never NaN).
        expect(perSkill["flow:author"]).toEqual({
            invoke_count: 1,
            useful_fire_count: 0,
            effectiveness_ratio: 0,
        });
    });
    it("carries enough info for the analyst to cite invoke_count and effectiveness_ratio in a proposal", async () => {
        const telemetryDir = path.join(tmpRoot, ".flow", "telemetry");
        await fs.mkdir(telemetryDir, { recursive: true });
        // flow:judge fired 3 times; only 1 invocation is followed by a READY FOR
        // MERGE in its own story flow → useful_fire_count 1 / invoke_count 3.
        const lines = [
            makeSkillInvokeLine({ skill_name: "flow:judge", session_id: "01KSESSCCCCCCCCCCCCCCCCCC1", story_id: "native:01KSTORY00000000000000010", ts: "2026-06-02T09:00:00.000Z" }),
            makeVerdictLine({ session_id: "01KSESSCCCCCCCCCCCCCCCCCC1", story_id: "native:01KSTORY00000000000000010", verdict: "READY FOR MERGE", pr_number: 201, ts: "2026-06-02T09:10:00.000Z" }),
            makeSkillInvokeLine({ skill_name: "flow:judge", session_id: "01KSESSDDDDDDDDDDDDDDDDDD2", story_id: "native:01KSTORY00000000000000011", ts: "2026-06-02T10:00:00.000Z" }),
            makeVerdictLine({ session_id: "01KSESSDDDDDDDDDDDDDDDDDD2", story_id: "native:01KSTORY00000000000000011", verdict: "NEEDS CHANGES", pr_number: 202, ts: "2026-06-02T10:10:00.000Z" }),
            makeSkillInvokeLine({ skill_name: "flow:judge", session_id: "01KSESSEEEEEEEEEEEEEEEEEE3", story_id: "native:01KSTORY00000000000000012", ts: "2026-06-02T11:00:00.000Z" }),
            // No verdict for the third invocation's story → not useful.
        ];
        await fs.writeFile(path.join(telemetryDir, "2026-06.jsonl"), lines.join("\n") + "\n", "utf8");
        const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });
        const entry = bundle.skillEffectiveness.per_skill["flow:judge"];
        // The analyst can write: "flow:judge fired 3 times (invoke_count) with an
        // effectiveness_ratio of 0.333 — a candidate to revise."
        expect(entry).toBeDefined();
        expect(entry.invoke_count).toBe(3);
        expect(entry.useful_fire_count).toBe(1);
        expect(entry.effectiveness_ratio).toBeCloseTo(1 / 3, 10);
    });
});
// ---------------------------------------------------------------------------
// AC2: Unit — the catalogue prompt carries the skill-effectiveness discipline
// ---------------------------------------------------------------------------
describe("AC2 — retro-analyst catalogue prompt instructs citing skillEffectiveness, not recounting", () => {
    it("carries a STRICT skill-effectiveness discipline section in the Prompt", async () => {
        const role = await readCatalogue({
            pluginRoot: getPluginRoot(),
            role: "retro-analyst",
        });
        const prompt = role.sections.Prompt;
        // A dedicated discipline section, peer to fire-count and recurring-friction.
        expect(prompt).toContain("Skill-effectiveness discipline");
        expect(prompt).toContain("STRICT");
        // It must reference the signal and the two fields the analyst cites.
        expect(prompt).toContain("skillEffectiveness.per_skill");
        expect(prompt).toContain("effectiveness_ratio");
        expect(prompt).toContain("invoke_count");
        // It must name the proposal variants this signal feeds.
        expect(prompt).toMatch(/skill-retire/);
        expect(prompt).toMatch(/skill-revise/);
        // It must forbid recounting from raw telemetry (same discipline as the
        // fire-count and recurring-friction signals).
        expect(prompt).toMatch(/NEVER recount|not recount|never recount/i);
        expect(prompt).toMatch(/raw telemetry/i);
    });
    it("also carries the skill-effectiveness discipline in the Mandate", async () => {
        const role = await readCatalogue({
            pluginRoot: getPluginRoot(),
            role: "retro-analyst",
        });
        const mandate = role.sections.Mandate;
        expect(mandate).toContain("skillEffectiveness.per_skill");
        expect(mandate).toContain("effectiveness_ratio");
        expect(mandate).toContain("invoke_count");
        expect(mandate).toMatch(/skill-retire/);
        expect(mandate).toMatch(/skill-revise/);
    });
});
// ---------------------------------------------------------------------------
// AC3: Unit — empty-telemetry cycle yields an empty per_skill map, no error
// ---------------------------------------------------------------------------
describe("AC3 — gatherRetroInputs tolerates an absent skill-invoke signal", () => {
    let tmpRoot;
    beforeEach(async () => {
        tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "retro-skilleff-ac3-"));
    });
    afterEach(async () => {
        await fs.rm(tmpRoot, { recursive: true, force: true });
    });
    it("returns an empty per_skill map when there is no telemetry directory at all", async () => {
        // No .flow/telemetry directory on disk.
        const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });
        expect(bundle.skillEffectiveness).toBeDefined();
        expect(bundle.skillEffectiveness.per_skill).toEqual({});
    });
    it("returns an empty per_skill map when telemetry has no skill.invoke events", async () => {
        const telemetryDir = path.join(tmpRoot, ".flow", "telemetry");
        await fs.mkdir(telemetryDir, { recursive: true });
        // A verdict but no skill.invoke event — nothing to score.
        const lines = [
            makeVerdictLine({ session_id: "01KSESSFFFFFFFFFFFFFFFFFF1", story_id: "native:01KSTORY00000000000000020", verdict: "READY FOR MERGE", pr_number: 301, ts: "2026-06-03T08:00:00.000Z" }),
        ];
        await fs.writeFile(path.join(telemetryDir, "2026-06.jsonl"), lines.join("\n") + "\n", "utf8");
        const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });
        expect(bundle.skillEffectiveness.per_skill).toEqual({});
        // The overall bundle still resolves cleanly — the retro does not fail.
        expect(bundle.doneManifests).toEqual([]);
        expect(bundle.recurringFriction).toEqual([]);
    });
});
