/**
 * Integration tests for the Quality Lead adjudication — Story 9.4 (gate 1).
 *
 * Covers AC2–AC5. The Quality Lead is driven through `adjudicateQualityLead` with
 * REAL fixtures (real temp dirs, real `node:fs`, the real schema, the real Story
 * 9.1 `markStoryReady` brake — no mocking of the thing under test):
 *
 *   AC2 — the synthesis rule (rubric §5) in the tool layer:
 *     all-pass → `ready`; one-lens-fail → `rework` carrying the miss; split at the
 *     K-th round → `escalate`.
 *   AC3 — `ready` blesses via the brake tool (the readiness flag flips through
 *     `markStoryReady`), `escalate` leaves the draft not-ready.
 *   AC4 — a split panel after K rounds yields `escalate` with a populated
 *     `escalation_reason`; the readiness flag is never set.
 *   AC5 — the emitted verdict validates against `AdjudicationVerdictSchema` and
 *     carries the decision + rationale; persisted as the canonical record.
 *
 * The brake tool is exercised for real against a seeded `to-do/` manifest so AC3
 * asserts the OBSERVABLE flag flip on disk, not a mock call.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { adjudicateQualityLead, synthesiseDecision, adjudicationVerdictFilePath, DEFAULT_ADJUDICATION_K, } from "../quality-lead-adjudicate.js";
import { AdjudicationVerdictSchema } from "../../schemas/adjudication-verdict.js";
import { LENS_NAMES } from "../../schemas/lens-verdict.js";
import { DEFAULT_LENS_ROLES } from "../judge-panel.js";
// ---------------------------------------------------------------------------
// Constants + fixtures
// ---------------------------------------------------------------------------
const REF = "native:01J9QUALITYLEAD00000000000";
const SESSION_ULID = "01HZQLSESSION0000000000000";
let targetRepoRoot;
let todoDir;
beforeEach(async () => {
    targetRepoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "quality-lead-"));
    todoDir = path.join(targetRepoRoot, ".crew", "state", "to-do");
    await fs.mkdir(todoDir, { recursive: true });
});
afterEach(async () => {
    await fs.rm(targetRepoRoot, { recursive: true, force: true });
});
/** Build a PanelVerdict where the named lenses fail; all others pass. */
function makePanel(failing = {}) {
    return {
        tier0: "pass",
        lenses: LENS_NAMES.map((lens) => {
            const miss = failing[lens];
            return {
                lens,
                role: DEFAULT_LENS_ROLES[lens],
                pass: miss === undefined,
                missed: miss ?? "nothing missed",
            };
        }),
    };
}
/** Seed a real un-claimed `to-do/` manifest the brake tool can flip. */
async function seedTodo(opts = {}) {
    const manifest = {
        ref: REF,
        status: "to-do",
        adapter: "native",
        source_path: `.crew/native-stories/${REF}.yaml`,
        source_hash: "a".repeat(64),
        depends_on: [],
        acceptance_criteria: [{ text: "Given x, when y, then z.", kind: "integration" }],
        title: `Test story ${REF}`,
        narrative: "As a dev, I want to test.",
        withdrawn: false,
        ready: opts.ready ?? false,
    };
    const absPath = path.join(todoDir, `${REF}.yaml`);
    await atomicWriteFile(absPath, yamlStringify(manifest, { lineWidth: 0 }));
    return absPath;
}
async function readReadyFlag(absPath) {
    const raw = await fs.readFile(absPath, "utf8");
    return yamlParse(raw).ready;
}
// ---------------------------------------------------------------------------
// AC2 — the synthesis rule (rubric §5) in the tool layer
// ---------------------------------------------------------------------------
describe("AC2: the synthesis rule decides ready / rework / escalate", () => {
    it("all five lenses pass → ready", async () => {
        // A `ready` decision blesses through the real brake, so seed a real to-do/ item.
        await seedTodo({ ready: false });
        const { verdict } = await adjudicateQualityLead({
            targetRepoRoot,
            sessionUlid: SESSION_ULID,
            ref: REF,
            panel: makePanel(),
        });
        expect(verdict.decision).toBe("ready");
        expect(verdict.escalation_reason).toBeUndefined();
    });
    it("one lens fails (inside the K-round window) → rework carrying the specific miss", async () => {
        const miss = "AC asserts a string appears in source — presence, not behaviour";
        const { verdict } = await adjudicateQualityLead({
            targetRepoRoot,
            sessionUlid: SESSION_ULID,
            ref: REF,
            panel: makePanel({ verifiability: miss }),
            round: 1,
            k: 2,
        });
        expect(verdict.decision).toBe("rework");
        // The failed lens's miss is returned to the author in the rationale.
        expect(verdict.rationale).toContain(miss);
        expect(verdict.rationale).toContain("verifiability");
        expect(verdict.escalation_reason).toBeUndefined();
    });
    it("a split that persists at the K-th round → escalate", async () => {
        const { verdict } = await adjudicateQualityLead({
            targetRepoRoot,
            sessionUlid: SESSION_ULID,
            ref: REF,
            panel: makePanel({ structure: "secretly two stories — split it" }),
            round: 2,
            k: 2,
        });
        expect(verdict.decision).toBe("escalate");
        expect(verdict.round).toBe(2);
    });
    it("synthesiseDecision is a pure function over the panel (default K = 2)", () => {
        expect(DEFAULT_ADJUDICATION_K).toBe(2);
        expect(synthesiseDecision({ panel: makePanel(), round: 1, k: 2 }).decision).toBe("ready");
        expect(synthesiseDecision({ panel: makePanel({ domain: "ungrounded claim" }), round: 1, k: 2 }).decision).toBe("rework");
        expect(synthesiseDecision({ panel: makePanel({ domain: "still split" }), round: 2, k: 2 }).decision).toBe("escalate");
    });
});
// ---------------------------------------------------------------------------
// AC3 — ready blesses via the brake tool; rework/escalate leave it not-ready
// ---------------------------------------------------------------------------
describe("AC3: ready blesses via the Story 9.1 brake; a non-ready decision leaves the draft not-ready", () => {
    it("an all-pass adjudication flips the draft's readiness flag via markStoryReady", async () => {
        const absPath = await seedTodo({ ready: false });
        expect(await readReadyFlag(absPath)).toBe(false);
        const { verdict, blessed } = await adjudicateQualityLead({
            targetRepoRoot,
            sessionUlid: SESSION_ULID,
            ref: REF,
            panel: makePanel(),
        });
        expect(verdict.decision).toBe("ready");
        // The flag flipped on disk — through the brake tool, not a direct write.
        expect(await readReadyFlag(absPath)).toBe(true);
        // The brake tool's output is surfaced (proving the bless went through it).
        expect(blessed).toBeDefined();
        expect(blessed.ready).toBe(true);
        expect(blessed.noop).toBe(false);
        expect(blessed.state).toBe("to-do");
    });
    it("an escalate adjudication leaves the draft not-ready (the brake is never called)", async () => {
        const absPath = await seedTodo({ ready: false });
        const { verdict, blessed } = await adjudicateQualityLead({
            targetRepoRoot,
            sessionUlid: SESSION_ULID,
            ref: REF,
            panel: makePanel({ considered: "a split that did not resolve" }),
            round: 2,
            k: 2,
        });
        expect(verdict.decision).toBe("escalate");
        // The flag is untouched — the brake tool was never invoked.
        expect(await readReadyFlag(absPath)).toBe(false);
        expect(blessed).toBeUndefined();
    });
    it("blesses ONLY through the brake — the brake seam is exercised, no direct manifest write", async () => {
        const absPath = await seedTodo({ ready: false });
        let brakeCalledWith = null;
        const { verdict } = await adjudicateQualityLead({
            targetRepoRoot,
            sessionUlid: SESSION_ULID,
            ref: REF,
            panel: makePanel(),
            markReady: async (opts) => {
                brakeCalledWith = { ref: opts.ref, ready: opts.ready };
                // Delegate to the real brake so the flag still flips for real.
                const { markStoryReady } = await import("../mark-story-ready.js");
                return markStoryReady(opts);
            },
        });
        expect(verdict.decision).toBe("ready");
        // The bless went through the brake seam with ready:true.
        expect(brakeCalledWith).toEqual({ ref: REF, ready: true });
        expect(await readReadyFlag(absPath)).toBe(true);
    });
});
// ---------------------------------------------------------------------------
// AC4 — split after K rounds escalates with a populated reason; never blessed
// ---------------------------------------------------------------------------
describe("AC4: a split panel after K rounds escalates with a populated reason; nothing is blessed", () => {
    it("escalates with a populated escalation_reason and never sets the readiness flag", async () => {
        const absPath = await seedTodo({ ready: false });
        const { verdict } = await adjudicateQualityLead({
            targetRepoRoot,
            sessionUlid: SESSION_ULID,
            ref: REF,
            panel: makePanel({
                structure: "secretly two stories",
                considered: "an open decision with no defaulted answer",
            }),
            round: DEFAULT_ADJUDICATION_K, // the K-th round
            k: DEFAULT_ADJUDICATION_K,
        });
        expect(verdict.decision).toBe("escalate");
        expect(verdict.escalation_reason).toBeDefined();
        expect(verdict.escalation_reason.length).toBeGreaterThan(0);
        // The reason names the unresolved lenses so the operator can act.
        expect(verdict.escalation_reason).toMatch(/structure|considered/);
        // The readiness flag was NEVER set — nothing is blessed on an escalate.
        expect(await readReadyFlag(absPath)).toBe(false);
    });
    it("a split BEFORE K rounds reworks (does not escalate) — escalation only after K", async () => {
        const { verdict } = await adjudicateQualityLead({
            targetRepoRoot,
            sessionUlid: SESSION_ULID,
            ref: REF,
            panel: makePanel({ structure: "split" }),
            round: 1,
            k: 2,
        });
        expect(verdict.decision).toBe("rework");
        expect(verdict.escalation_reason).toBeUndefined();
    });
});
// ---------------------------------------------------------------------------
// AC5 — schema-validated verdict, persisted as the canonical record
// ---------------------------------------------------------------------------
describe("AC5: the emitted verdict validates against the schema and is persisted", () => {
    it("the verdict validates against AdjudicationVerdictSchema and carries decision + rationale", async () => {
        const { verdict, verdictFilePath } = await adjudicateQualityLead({
            targetRepoRoot,
            sessionUlid: SESSION_ULID,
            ref: REF,
            panel: makePanel({ domain: "an ungrounded claim with no cited source" }),
            round: 1,
            k: 2,
        });
        // Validates against the schema.
        expect(() => AdjudicationVerdictSchema.parse(verdict)).not.toThrow();
        expect(verdict.ref).toBe(REF);
        expect(verdict.decision).toBe("rework");
        expect(verdict.rationale.length).toBeGreaterThan(0);
        // Persisted as the canonical record (a file, not a transcript), in the SAME
        // session dir the panel writes its per-lens verdicts to.
        const expectedPath = adjudicationVerdictFilePath(targetRepoRoot, SESSION_ULID, REF);
        expect(verdictFilePath).toBe(expectedPath);
        const onDisk = JSON.parse(await fs.readFile(expectedPath, "utf8"));
        expect(() => AdjudicationVerdictSchema.parse(onDisk)).not.toThrow();
        expect(onDisk.decision).toBe("rework");
        expect(onDisk.ref).toBe(REF);
    });
    it("emits exactly one quality.adjudicated telemetry event, even on a ready decision", async () => {
        await seedTodo({ ready: false });
        await adjudicateQualityLead({
            targetRepoRoot,
            sessionUlid: SESSION_ULID,
            ref: REF,
            panel: makePanel(),
        });
        const telemetryDir = path.join(targetRepoRoot, ".crew", "telemetry");
        const files = await fs.readdir(telemetryDir);
        const lines = [];
        for (const f of files) {
            const raw = await fs.readFile(path.join(telemetryDir, f), "utf8");
            lines.push(...raw.split("\n").filter((l) => l.trim() !== ""));
        }
        const events = lines.map((l) => JSON.parse(l));
        const adjudicated = events.filter((e) => e.type === "quality.adjudicated");
        expect(adjudicated).toHaveLength(1);
        expect(adjudicated[0].data.decision).toBe("ready");
        expect(adjudicated[0].data.escalated).toBe(false);
    });
    it("the schema rejects an escalate verdict with no escalation_reason (the close-call-auto-pass guard)", () => {
        expect(() => AdjudicationVerdictSchema.parse({
            ref: REF,
            decision: "escalate",
            rationale: "split",
            round: 2,
        })).toThrow();
    });
});
// ---------------------------------------------------------------------------
// Gate-1 AC4 — Story native:01KT1MP7TR651TAGVJ6EZSR589
//
// The gate-1 workflow ALWAYS calls adjudicateQualityLead with round=1 and k=1.
// This forces immediate escalate on any lens fail (round >= k, so 1 >= 1 → escalate).
// There is NO rework decision in gate-1: a clean panel → ready; any fail → escalate.
// The adjudication-verdict.json persisted to the session dir MUST record round=1
// so operators and the calibration loop can verify the gate-1 contract was honoured.
// ---------------------------------------------------------------------------
describe("Gate-1 AC4: synthesiseDecision with round=1 k=1 — any fail → escalate immediately (not rework)", () => {
    it("synthesiseDecision({round: 1, k: 1}) with a failing lens returns decision=escalate, NOT rework", () => {
        // This is the gate-1 contract: with k=1, a split that occurs at round=1
        // satisfies round >= k (1 >= 1) → escalate immediately.
        const failingPanel = makePanel({ verifiability: "AC does not pin behaviour" });
        const result = synthesiseDecision({ panel: failingPanel, round: 1, k: 1 });
        expect(result.decision).toBe("escalate");
        expect(result.escalation_reason).toBeDefined();
        expect(result.escalation_reason).toMatch(/verifiability/);
        // Sanity: with k=2 (default), round=1 would have been rework.
        expect(synthesiseDecision({ panel: failingPanel, round: 1, k: 2 }).decision).toBe("rework");
    });
    it("synthesiseDecision({round: 1, k: 1}) with all lenses passing → decision=ready", () => {
        const cleanPanel = makePanel();
        const result = synthesiseDecision({ panel: cleanPanel, round: 1, k: 1 });
        expect(result.decision).toBe("ready");
        expect(result.escalation_reason).toBeUndefined();
    });
    it("adjudicateQualityLead with round=1 k=1 and a failing lens → escalate with round=1 in persisted verdict", async () => {
        const failMsg = "open question has no defaulted answer — cold dev would stop to ask";
        const { verdict, verdictFilePath } = await adjudicateQualityLead({
            targetRepoRoot,
            sessionUlid: SESSION_ULID,
            ref: REF,
            panel: makePanel({ considered: failMsg }),
            round: 1,
            k: 1,
        });
        // Escalate immediately — no rework in gate-1.
        expect(verdict.decision).toBe("escalate");
        expect(verdict.round).toBe(1);
        expect(verdict.escalation_reason).toBeDefined();
        // The adjudication-verdict.json persisted to the session dir records round=1.
        const onDisk = JSON.parse(await fs.readFile(verdictFilePath, "utf8"));
        expect(onDisk.round).toBe(1);
        expect(onDisk.decision).toBe("escalate");
        // Verify the file is in the expected session dir.
        const expectedPath = adjudicationVerdictFilePath(targetRepoRoot, SESSION_ULID, REF);
        expect(verdictFilePath).toBe(expectedPath);
    });
    it("adjudicateQualityLead with round=1 k=1 and clean panel → ready with round=1 in persisted verdict", async () => {
        await seedTodo({ ready: false });
        const { verdict, verdictFilePath } = await adjudicateQualityLead({
            targetRepoRoot,
            sessionUlid: SESSION_ULID,
            ref: REF,
            panel: makePanel(),
            round: 1,
            k: 1,
        });
        expect(verdict.decision).toBe("ready");
        expect(verdict.round).toBe(1);
        // adjudication-verdict.json records round=1 even on a ready decision.
        const onDisk = JSON.parse(await fs.readFile(verdictFilePath, "utf8"));
        expect(onDisk.round).toBe(1);
        expect(onDisk.decision).toBe("ready");
    });
});
// ---------------------------------------------------------------------------
// AC1 — the role catalogue + permission files exist and parse against their schemas
// ---------------------------------------------------------------------------
describe("AC1: the quality-lead catalogue + permission files parse against the schemas", () => {
    it("the catalogue file exists and parses against the catalogue schema", async () => {
        const { getPluginRoot } = await import("../../lib/plugin-root.js");
        const { readCatalogue } = await import("../read-catalogue.js");
        const role = await readCatalogue({ pluginRoot: getPluginRoot(), role: "quality-lead" });
        expect(role.role).toBe("quality-lead");
        expect(role.domain.length).toBeGreaterThan(0);
        expect(role.locked_phrases.handoff.length).toBeGreaterThan(0);
        // Bounded negative-capability posture: no gh capability granted.
        expect(role.gh_allow).toEqual([]);
    });
    it("the permission file exists, parses, and lists a bounded tools_allow (AC6)", async () => {
        const { getPluginRoot } = await import("../../lib/plugin-root.js");
        const { loadRolePermissions } = await import("../../state/load-role-permissions.js");
        const perms = await loadRolePermissions({ pluginRoot: getPluginRoot(), role: "quality-lead" });
        expect(perms.role).toBe("quality-lead");
        // It can bless via the brake and adjudicate, and read — but nothing else.
        expect(perms.tools_allow).toContain("markStoryReady");
        expect(perms.tools_allow).toContain("adjudicateQualityLead");
        // Negative capability: no merge/push/code-edit surface.
        expect(perms.tools_allow).not.toContain("Bash");
        expect(perms.tools_allow).not.toContain("Edit");
        expect(perms.tools_allow).not.toContain("runDevTerminalAction");
        expect(perms.gh_allow).toEqual([]);
    });
});
