/**
 * Integration tests for `runAutoMergeGate` — Story 4.10b (AC5d–q).
 *
 * Test coverage:
 *   (5d)  (a) Auto-merge fires — low risk, met threshold.
 *   (5e)  (b) Medium pauses.
 *   (5f)  (c) High pauses.
 *   (5g)  (d) Low + sub-threshold pauses.
 *   (5h)  (e) Low + insufficient-data pauses.
 *   (5i)  (f) Manual-merge override (structural SKILL.md check).
 *   (5j)  (g) No-tier pause (legacy manifest).
 *   (5k)  (h) Boundary — ratio exactly equals threshold.
 *   (5l)  (i) SKILL.md content-structure (runAutoMergeGate under done-ready-for-merge).
 *   (5m)  (j) MCP tool registration smoke (runAutoMergeGate in register list, count 31).
 *   (5n)  (k) dryRun: true — decision made but no gh call.
 *   (5o)  (l) Recoverable gh error on pr merge folds to pause-needs-human/merge-failed.
 *   (5p)  (m) pr-merge denied without permission folds to pause-needs-human/merge-failed.
 *   (5q)  (n) AutoMergeGateResultSchema round-trip.
 *
 * Strategy: inject `execaImpl` (never vi.mock production modules). The real `gh`
 * wrapper is exercised; only the underlying subprocess is replaced.
 *
 * Story 4.10b Task 2.6.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { stringify as yamlStringify } from "yaml";
import { fileURLToPath } from "node:url";
import { runAutoMergeGate, AutoMergeGateResultSchema, classifyCiRollup, } from "../run-auto-merge-gate.js";
import { registerAllTools } from "../register.js";
import { AutoMergeGateThresholdInvalidError } from "../../errors.js";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { __resetGhErrorMapCacheForTests } from "../../lib/gh-error-map.js";
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const SESSION_ULID = "01HZAUTOGATE0000000000000";
const PR_NUMBER = 55;
const REF = "native:01HZAUTOGATE0000000000000";
// Default repo-view response (matches the flow repo — same as other tests)
const DEFAULT_REPO_VIEW_JSON = JSON.stringify({
    name: "flow",
    owner: { login: "jackmcintyre" },
});
const DEFAULT_LABELS_RESPONSE = JSON.stringify([
    { id: 1, name: "needs-human", color: "e4e669" },
]);
const HERE = path.dirname(fileURLToPath(import.meta.url));
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** ISO-8601 UTC timestamp at a given millisecond offset */
function makeTs(offsetMs) {
    return new Date(1_700_000_000_000 + offsetMs).toISOString();
}
/** Create a `reviewer.verdict` event payload */
function makeVerdictEvent(opts) {
    return {
        ts: opts.ts,
        session_id: opts.session_id,
        agent: "generalist-reviewer",
        story_id: "bmad:1-1-example",
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
/** Create a `reviewer.verdict.merge_action` event payload */
function makeMergeActionEvent(opts) {
    return {
        ts: opts.ts,
        session_id: opts.session_id,
        agent: "generalist-reviewer",
        story_id: "bmad:1-1-example",
        type: "reviewer.verdict.merge_action",
        data: {
            pr_number: opts.pr_number,
            merge_action: opts.merge_action,
            resolved_at: opts.resolved_at ?? opts.ts,
        },
    };
}
/** Write JSONL events to a file */
async function writeJSONL(telemetryDir, filename, events) {
    const lines = events.map((e) => JSON.stringify(e));
    await fs.writeFile(path.join(telemetryDir, filename), lines.join("\n") + "\n");
}
/**
 * Seed N fully-resolved verdict pairs with a target agreement ratio.
 *
 * @param telemetryDir - Directory to write the JSONL file into.
 * @param count - Number of resolved pairs (window size).
 * @param agreedCount - How many pairs should agree (agree = READY + merged OR NEEDS + closed).
 */
async function seedVerdictPairs(telemetryDir, count, agreedCount) {
    const events = [];
    for (let i = 0; i < count; i++) {
        const ts = makeTs(i * 1000);
        const session_id = `gate-sess-${String(i).padStart(4, "0")}`;
        const pr_number = 9000 + i;
        // First `agreedCount` pairs agree; rest disagree
        const agree = i < agreedCount;
        const verdict = agree ? "READY FOR MERGE" : "NEEDS CHANGES";
        const mergeAction = agree ? "merged" : "merged"; // disagree for NEEDS CHANGES + merged
        // For agreement: READY FOR MERGE + merged = agree; NEEDS CHANGES + merged = disagree
        const v = makeVerdictEvent({ ts, session_id, pr_number, verdict });
        const ma = makeMergeActionEvent({ ts, session_id, pr_number, merge_action: mergeAction, resolved_at: ts });
        events.push(v, ma);
    }
    await fs.mkdir(telemetryDir, { recursive: true });
    await writeJSONL(telemetryDir, "gate-verdicts.jsonl", events);
}
/**
 * Seed N pairs with a specific READY FOR MERGE + merged ratio.
 * All pairs use READY FOR MERGE verdicts; agreedCount are merged, rest are closed-unmerged.
 */
async function seedRatioVerdicts(telemetryDir, count, mergedCount) {
    const events = [];
    for (let i = 0; i < count; i++) {
        const ts = makeTs(i * 1000);
        const session_id = `ratio-sess-${String(i).padStart(4, "0")}`;
        const pr_number = 8000 + i;
        const v = makeVerdictEvent({ ts, session_id, pr_number, verdict: "READY FOR MERGE" });
        const mergeAction = i < mergedCount ? "merged" : "closed-unmerged";
        const ma = makeMergeActionEvent({ ts, session_id, pr_number, merge_action: mergeAction, resolved_at: ts });
        events.push(v, ma);
    }
    await fs.mkdir(telemetryDir, { recursive: true });
    await writeJSONL(telemetryDir, "ratio-verdicts.jsonl", events);
}
/** Build the done manifest YAML */
function makeDoneManifestYaml(opts) {
    const manifest = {
        ref: opts.ref,
        status: "done",
        adapter: "native",
        source_path: `.flow/native-stories/${opts.ref.replace("native:", "")}.md`,
        source_hash: "a".repeat(64),
        depends_on: [],
        acceptance_criteria: [
            { text: "Given the tool, when called, then it works.", kind: "integration" },
        ],
        title: "Auto-merge gate test story",
        narrative: "As a dev, I want to test the auto-merge gate.",
        withdrawn: false,
        claimed_by: opts.sessionUlid,
    };
    if (opts.risk_tier !== undefined) {
        manifest["risk_tier"] = opts.risk_tier;
    }
    return yamlStringify(manifest, { lineWidth: 0 });
}
/** Seed the done/<ref>.yaml manifest */
async function seedDoneManifest(targetRepoRoot, opts) {
    const doneDir = path.join(targetRepoRoot, ".flow", "state", "done");
    await fs.mkdir(doneDir, { recursive: true });
    await atomicWriteFile(path.join(doneDir, `${opts.ref}.yaml`), makeDoneManifestYaml(opts));
}
/** Seed plugin permissions (generalist-dev.yaml with pr-merge, gh-error-map.yaml) */
async function seedPluginPermissions(pluginRoot) {
    await fs.mkdir(path.join(pluginRoot, "permissions"), { recursive: true });
    await atomicWriteFile(path.join(pluginRoot, "permissions", "generalist-dev.yaml"), [
        "role: generalist-dev",
        "tools_allow:",
        "  - claimStory",
        "gh_allow:",
        "  - pr-view",
        "  - pr-merge",
        "  - api",
        "  - repo-view",
        "gh_allow_args: {}",
    ].join("\n") + "\n");
    await atomicWriteFile(path.join(pluginRoot, "permissions", "gh-error-map.yaml"), [
        "entries:",
        '  - exit_code: 4',
        '    stderr_regex: "API rate limit exceeded"',
        '    class: defer',
        '  - exit_code: 1',
        '    stderr_regex: "already been merged"',
        '    class: defer',
    ].join("\n") + "\n");
}
/** Build a fake execa that records calls and returns canned responses */
function makeFakeExeca(routes) {
    const calls = [];
    const impl = vi.fn().mockImplementation(async (cmd, args, callOpts) => {
        calls.push({ cmd, args, input: callOpts?.input });
        for (const route of routes) {
            if (route.match(cmd, args)) {
                return {
                    stdout: route.response.stdout ?? "",
                    stderr: route.response.stderr ?? "",
                    exitCode: route.response.exitCode ?? 0,
                };
            }
        }
        // Fallback: unexpected call
        return {
            stdout: "",
            stderr: `unexpected gh call: ${cmd} ${args.join(" ")}`,
            exitCode: 1,
        };
    });
    return { impl, calls };
}
/** Fake execa that handles repo-view + api-labels (pause branch) */
function makePauseExeca(labelsOnCall) {
    return makeFakeExeca([
        {
            match: (cmd, args) => cmd === "gh" && args[0] === "repo" && args[1] === "view",
            response: { stdout: DEFAULT_REPO_VIEW_JSON },
        },
        {
            match: (cmd, args) => cmd === "gh" && args[0] === "api",
            response: { stdout: DEFAULT_LABELS_RESPONSE },
        },
    ]);
}
/** Fake execa that handles pr merge (auto-merge branch) */
function makeMergeExeca() {
    return makeFakeExeca([
        {
            match: (cmd, args) => cmd === "gh" && args[0] === "pr" && args[1] === "merge",
            response: { stdout: "Pull request #55 was successfully merged." },
        },
    ]);
}
/** Build a `computeAgreementImpl` that returns a fixed metric */
function makeAgreementImpl(result) {
    return async () => result;
}
function makeMetric(ratio) {
    return {
        ratio,
        distribution: {
            "READY FOR MERGE": Math.round(ratio * 50),
            "NEEDS CHANGES": 0,
            BLOCKED: 0,
        },
        window_size: 50,
        sample_size: 50,
        skipped_unresolved: 0,
        skipped_excluded: 0,
        malformed_lines: 0,
    };
}
// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
let tmpRoot;
let targetRepoRoot;
let pluginRoot;
beforeEach(async () => {
    __resetGhErrorMapCacheForTests();
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "auto-merge-gate-"));
    targetRepoRoot = path.join(tmpRoot, "repo");
    pluginRoot = path.join(tmpRoot, "plugin");
    await fs.mkdir(targetRepoRoot, { recursive: true });
    await seedPluginPermissions(pluginRoot);
});
afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
});
// ---------------------------------------------------------------------------
// Base options helper
// ---------------------------------------------------------------------------
function baseOpts(override = {}) {
    return {
        targetRepoRoot,
        prNumber: PR_NUMBER,
        ref: REF,
        sessionUlid: SESSION_ULID,
        pluginRootOverride: pluginRoot,
        // Default the CI gate to green so existing auto-merge assertions hold; the
        // CI-gating tests override this to exercise failed / pending-timeout.
        ciGateImpl: async () => "green",
        ...override,
    };
}
// ---------------------------------------------------------------------------
// Stage-2: cold-start provisional trust + tier-from-reviewer-result fallback
// ---------------------------------------------------------------------------
/** Minimal reviewer-result reader seam carrying the fields the gate reads. */
function makeReviewerResultWithTier(tier, overrides = {}) {
    return async () => ({
        ref: overrides.ref ?? REF,
        recommendedVerdict: overrides.recommendedVerdict ?? "READY FOR MERGE",
        riskTier: {
            tier,
            matched_rule: "test-rule",
            evidence: { paths: [], change_types: [], diff_size: 10 },
        },
    });
}
describe("Stage-2 — provisional trust + reviewer-result tier fallback", () => {
    it("manifest lacks risk_tier + reviewer-result says low + provisional_trust → auto-merges", async () => {
        // No risk_tier on the manifest — the gate must fall back to reviewer-result.
        await seedDoneManifest(targetRepoRoot, { ref: REF, sessionUlid: SESSION_ULID });
        const { impl: fakeExeca, calls } = makeMergeExeca();
        const result = await runAutoMergeGate(baseOpts({
            dryRun: false,
            execaImpl: fakeExeca,
            computeAgreementImpl: makeAgreementImpl(null), // cold start, no history
            readReviewerResultImpl: makeReviewerResultWithTier("low"),
            provisionalTrustOverride: true,
        }));
        expect(result.risk_tier).toBe("low");
        expect(result.decision).toBe("auto-merge");
        expect(result.reason).toBe("low-risk-provisional-trust");
        expect(result.merged).toBe(true);
        const mergeCalls = calls.filter(c => c.cmd === "gh" && c.args[0] === "pr" && c.args[1] === "merge");
        expect(mergeCalls).toHaveLength(1);
    });
    it("low tier (via fallback) + null history + provisional_trust OFF → pauses (insufficient-data)", async () => {
        await seedDoneManifest(targetRepoRoot, { ref: REF, sessionUlid: SESSION_ULID });
        const { impl: fakeExeca } = makePauseExeca();
        const result = await runAutoMergeGate(baseOpts({
            dryRun: false,
            execaImpl: fakeExeca,
            computeAgreementImpl: makeAgreementImpl(null),
            readReviewerResultImpl: makeReviewerResultWithTier("low"),
            provisionalTrustOverride: false,
        }));
        expect(result.risk_tier).toBe("low");
        expect(result.decision).toBe("pause-needs-human");
        expect(result.reason).toBe("low-risk-insufficient-data");
        expect(result.merged).toBe(false);
    });
    it("reviewer-result says medium + provisional_trust ON → STILL pauses (flag never relaxes medium)", async () => {
        await seedDoneManifest(targetRepoRoot, { ref: REF, sessionUlid: SESSION_ULID });
        const { impl: fakeExeca } = makePauseExeca();
        const result = await runAutoMergeGate(baseOpts({
            dryRun: false,
            execaImpl: fakeExeca,
            computeAgreementImpl: makeAgreementImpl(null),
            readReviewerResultImpl: makeReviewerResultWithTier("medium"),
            provisionalTrustOverride: true,
        }));
        expect(result.risk_tier).toBe("medium");
        expect(result.decision).toBe("pause-needs-human");
        expect(result.reason).toBe("medium-risk");
        expect(result.merged).toBe(false);
    });
    it("fallback IGNORES tier when reviewer-result verdict is not green → pauses (no-tier-no-signal)", async () => {
        await seedDoneManifest(targetRepoRoot, { ref: REF, sessionUlid: SESSION_ULID });
        const { impl: fakeExeca } = makePauseExeca();
        const result = await runAutoMergeGate(baseOpts({
            dryRun: false,
            execaImpl: fakeExeca,
            computeAgreementImpl: makeAgreementImpl(null),
            // tier says low, but the verdict is NOT green — the gate must not trust it.
            readReviewerResultImpl: makeReviewerResultWithTier("low", {
                recommendedVerdict: "NEEDS CHANGES",
            }),
            provisionalTrustOverride: true,
        }));
        expect(result.risk_tier).toBeNull();
        expect(result.decision).toBe("pause-needs-human");
        expect(result.reason).toBe("no-tier-no-signal");
        expect(result.merged).toBe(false);
    });
    it("fallback IGNORES tier when reviewer-result ref does not match the gated ref → pauses", async () => {
        await seedDoneManifest(targetRepoRoot, { ref: REF, sessionUlid: SESSION_ULID });
        const { impl: fakeExeca } = makePauseExeca();
        const result = await runAutoMergeGate(baseOpts({
            dryRun: false,
            execaImpl: fakeExeca,
            computeAgreementImpl: makeAgreementImpl(null),
            // A stale/cross-story result lingering in the session dir for a different ref.
            readReviewerResultImpl: makeReviewerResultWithTier("low", {
                ref: "native:01HZSOMEOTHERSTORY000000000",
            }),
            provisionalTrustOverride: true,
        }));
        expect(result.risk_tier).toBeNull();
        expect(result.decision).toBe("pause-needs-human");
        expect(result.reason).toBe("no-tier-no-signal");
        expect(result.merged).toBe(false);
    });
    it("manifest risk_tier wins over reviewer-result (manifest low, fallback not consulted)", async () => {
        await seedDoneManifest(targetRepoRoot, { ref: REF, sessionUlid: SESSION_ULID, risk_tier: "low" });
        const { impl: fakeExeca } = makeMergeExeca();
        let fallbackConsulted = false;
        const result = await runAutoMergeGate(baseOpts({
            dryRun: false,
            execaImpl: fakeExeca,
            computeAgreementImpl: makeAgreementImpl(null),
            readReviewerResultImpl: async () => {
                fallbackConsulted = true;
                return null;
            },
            provisionalTrustOverride: true,
        }));
        expect(result.risk_tier).toBe("low");
        expect(result.decision).toBe("auto-merge");
        expect(result.reason).toBe("low-risk-provisional-trust");
        expect(fallbackConsulted).toBe(false);
    });
});
// ---------------------------------------------------------------------------
// Stage-2 CI-gating: never auto-merge a PR whose CI is not green
// ---------------------------------------------------------------------------
describe("classifyCiRollup", () => {
    it("all checks SUCCESS (CheckRun) → green", () => {
        expect(classifyCiRollup([
            { status: "COMPLETED", conclusion: "SUCCESS", name: "build" },
            { status: "COMPLETED", conclusion: "SKIPPED", name: "lint" },
        ])).toBe("green");
    });
    it("any failing check → failed", () => {
        expect(classifyCiRollup([
            { status: "COMPLETED", conclusion: "SUCCESS", name: "build" },
            { status: "COMPLETED", conclusion: "FAILURE", name: "test" },
        ])).toBe("failed");
    });
    it("any in-progress check → pending", () => {
        expect(classifyCiRollup([
            { status: "IN_PROGRESS", name: "build" },
        ])).toBe("pending");
    });
    it("empty rollup → pending (checks not registered yet, conservatively not green)", () => {
        expect(classifyCiRollup([])).toBe("pending");
    });
    it("StatusContext state SUCCESS → green, FAILURE → failed, PENDING → pending", () => {
        expect(classifyCiRollup([{ state: "SUCCESS", context: "ci" }])).toBe("green");
        expect(classifyCiRollup([{ state: "FAILURE", context: "ci" }])).toBe("failed");
        expect(classifyCiRollup([{ state: "PENDING", context: "ci" }])).toBe("pending");
    });
    // Allowlist guards (code-review): non-success non-failure states must NOT green-wash.
    it("SKIPPED / NEUTRAL completed checks count as pass → green", () => {
        expect(classifyCiRollup([
            { status: "COMPLETED", conclusion: "SUCCESS", name: "build" },
            { status: "COMPLETED", conclusion: "SKIPPED", name: "optional" },
            { status: "COMPLETED", conclusion: "NEUTRAL", name: "advisory" },
        ])).toBe("green");
    });
    it("COMPLETED check with UNKNOWN conclusion → pending (not green)", () => {
        expect(classifyCiRollup([
            { status: "COMPLETED", conclusion: "SOME_FUTURE_VALUE", name: "x" },
        ])).toBe("pending");
    });
    it("COMPLETED check with no conclusion → pending (not green)", () => {
        expect(classifyCiRollup([{ status: "COMPLETED", name: "x" }])).toBe("pending");
    });
    it("sparse / unrecognized-shape item → pending, and never green-washes a sibling", () => {
        expect(classifyCiRollup([{ __typename: "Unknown" }])).toBe("pending");
        // a passing check + a sparse item must NOT be green (the sparse item is unproven)
        expect(classifyCiRollup([
            { status: "COMPLETED", conclusion: "SUCCESS" },
            { __typename: "Unknown" },
        ])).toBe("pending");
    });
    it("lowercase/odd failure value is NOT treated as failure but is NOT green either (pending)", () => {
        expect(classifyCiRollup([{ status: "COMPLETED", conclusion: "failure" }])).toBe("pending");
    });
});
describe("Stage-2 CI gate — non-green CI blocks the auto-merge", () => {
    it("risk says auto-merge but CI failed → pause-needs-human (ci-not-green), label applied, NOT merged", async () => {
        await seedDoneManifest(targetRepoRoot, { ref: REF, sessionUlid: SESSION_ULID, risk_tier: "low" });
        const { impl: fakeExeca, calls } = makePauseExeca();
        const result = await runAutoMergeGate(baseOpts({
            dryRun: false,
            execaImpl: fakeExeca,
            computeAgreementImpl: makeAgreementImpl(makeMetric(0.95)), // risk gate would auto-merge
            ciGateImpl: async () => "failed",
        }));
        expect(result.decision).toBe("pause-needs-human");
        expect(result.reason).toBe("ci-not-green");
        expect(result.merged).toBe(false);
        expect(result.labelsApplied).toEqual(["needs-human"]);
        // no pr merge call happened
        const mergeCalls = calls.filter(c => c.cmd === "gh" && c.args[0] === "pr" && c.args[1] === "merge");
        expect(mergeCalls).toHaveLength(0);
    });
    it("CI still pending at timeout → pause-needs-human (ci-not-green), NOT merged", async () => {
        await seedDoneManifest(targetRepoRoot, { ref: REF, sessionUlid: SESSION_ULID, risk_tier: "low" });
        const { impl: fakeExeca } = makePauseExeca();
        const result = await runAutoMergeGate(baseOpts({
            dryRun: false,
            execaImpl: fakeExeca,
            computeAgreementImpl: makeAgreementImpl(makeMetric(0.95)),
            ciGateImpl: async () => "pending-timeout",
        }));
        expect(result.decision).toBe("pause-needs-human");
        expect(result.reason).toBe("ci-not-green");
        expect(result.merged).toBe(false);
    });
    it("CI green → merge proceeds (gate fires only on green)", async () => {
        await seedDoneManifest(targetRepoRoot, { ref: REF, sessionUlid: SESSION_ULID, risk_tier: "low" });
        const { impl: fakeExeca } = makeMergeExeca();
        const result = await runAutoMergeGate(baseOpts({
            dryRun: false,
            execaImpl: fakeExeca,
            computeAgreementImpl: makeAgreementImpl(makeMetric(0.95)),
            ciGateImpl: async () => "green",
        }));
        expect(result.decision).toBe("auto-merge");
        expect(result.merged).toBe(true);
    });
    it("CI gate does NOT run when the risk gate already pauses (medium)", async () => {
        await seedDoneManifest(targetRepoRoot, { ref: REF, sessionUlid: SESSION_ULID, risk_tier: "medium" });
        const { impl: fakeExeca } = makePauseExeca();
        let ciConsulted = false;
        const result = await runAutoMergeGate(baseOpts({
            dryRun: false,
            execaImpl: fakeExeca,
            computeAgreementImpl: makeAgreementImpl(makeMetric(0.95)),
            ciGateImpl: async () => { ciConsulted = true; return "green"; },
        }));
        expect(result.decision).toBe("pause-needs-human");
        expect(result.reason).toBe("medium-risk");
        expect(ciConsulted).toBe(false);
    });
});
// ---------------------------------------------------------------------------
// (5d) (a) Auto-merge fires
// ---------------------------------------------------------------------------
describe("AC5(a) — auto-merge fires (low risk, met threshold)", () => {
    it("ratio === default threshold (0.8) → decision auto-merge, merged: true, pr merge called", async () => {
        await seedDoneManifest(targetRepoRoot, { ref: REF, sessionUlid: SESSION_ULID, risk_tier: "low" });
        const { impl: fakeExeca, calls } = makeMergeExeca();
        const result = await runAutoMergeGate(baseOpts({
            dryRun: false,
            execaImpl: fakeExeca,
            computeAgreementImpl: makeAgreementImpl(makeMetric(0.8)),
        }));
        expect(result.decision).toBe("auto-merge");
        expect(result.reason).toBe("low-risk-met-threshold");
        expect(result.merged).toBe(true);
        expect(result.labelsApplied).toEqual([]);
        expect(result.dryRun).toBe(false);
        expect(result.prNumber).toBe(PR_NUMBER);
        // fakeExeca called with pr merge --squash --delete-branch
        const mergeCalls = calls.filter(c => c.cmd === "gh" && c.args[0] === "pr" && c.args[1] === "merge");
        expect(mergeCalls).toHaveLength(1);
        expect(mergeCalls[0].args).toEqual(["pr", "merge", String(PR_NUMBER), "--squash", "--delete-branch"]);
    });
    it("ratio 0.81 (strictly above) → auto-merge", async () => {
        await seedDoneManifest(targetRepoRoot, { ref: REF, sessionUlid: SESSION_ULID, risk_tier: "low" });
        const { impl: fakeExeca } = makeMergeExeca();
        const result = await runAutoMergeGate(baseOpts({
            dryRun: false,
            execaImpl: fakeExeca,
            computeAgreementImpl: makeAgreementImpl(makeMetric(0.81)),
        }));
        expect(result.decision).toBe("auto-merge");
        expect(result.merged).toBe(true);
    });
    it("thresholdOverride: 0.85 with agreement 0.8 → pause (cross-check threshold-override path)", async () => {
        await seedDoneManifest(targetRepoRoot, { ref: REF, sessionUlid: SESSION_ULID, risk_tier: "low" });
        const { impl: fakeExeca } = makePauseExeca();
        const result = await runAutoMergeGate(baseOpts({
            dryRun: false,
            execaImpl: fakeExeca,
            computeAgreementImpl: makeAgreementImpl(makeMetric(0.8)),
            thresholdOverride: 0.85,
        }));
        expect(result.decision).toBe("pause-needs-human");
        expect(result.reason).toBe("low-risk-sub-threshold");
        expect(result.threshold_used).toBe(0.85);
    });
});
// ---------------------------------------------------------------------------
// (5e) (b) Medium pauses
// ---------------------------------------------------------------------------
describe("AC5(b) — medium pauses", () => {
    it("medium risk with perfect agreement → pause with medium-risk, no merge call", async () => {
        await seedDoneManifest(targetRepoRoot, { ref: REF, sessionUlid: SESSION_ULID, risk_tier: "medium" });
        const { impl: fakeExeca, calls } = makePauseExeca();
        const result = await runAutoMergeGate(baseOpts({
            dryRun: false,
            execaImpl: fakeExeca,
            computeAgreementImpl: makeAgreementImpl(makeMetric(1.0)),
        }));
        expect(result.decision).toBe("pause-needs-human");
        expect(result.reason).toBe("medium-risk");
        expect(result.merged).toBe(false);
        expect(result.labelsApplied).toEqual(["needs-human"]);
        // pr merge MUST NOT be called
        const mergeCalls = calls.filter(c => c.cmd === "gh" && c.args[0] === "pr" && c.args[1] === "merge");
        expect(mergeCalls).toHaveLength(0);
        // repo view MUST be called (owner/repo lookup)
        const viewCalls = calls.filter(c => c.cmd === "gh" && c.args[0] === "repo" && c.args[1] === "view");
        expect(viewCalls).toHaveLength(1);
        // api POST /labels MUST be called with needs-human
        const apiCalls = calls.filter(c => c.cmd === "gh" && c.args[0] === "api");
        expect(apiCalls).toHaveLength(1);
        const inputParsed = JSON.parse(apiCalls[0].input ?? "{}");
        expect(inputParsed.labels).toContain("needs-human");
    });
});
// ---------------------------------------------------------------------------
// (5f) (c) High pauses
// ---------------------------------------------------------------------------
describe("AC5(c) — high pauses", () => {
    it("high risk with perfect agreement → pause with high-risk, no merge call", async () => {
        await seedDoneManifest(targetRepoRoot, { ref: REF, sessionUlid: SESSION_ULID, risk_tier: "high" });
        const { impl: fakeExeca, calls } = makePauseExeca();
        const result = await runAutoMergeGate(baseOpts({
            dryRun: false,
            execaImpl: fakeExeca,
            computeAgreementImpl: makeAgreementImpl(makeMetric(1.0)),
        }));
        expect(result.decision).toBe("pause-needs-human");
        expect(result.reason).toBe("high-risk");
        expect(result.merged).toBe(false);
        expect(result.labelsApplied).toEqual(["needs-human"]);
        const mergeCalls = calls.filter(c => c.cmd === "gh" && c.args[0] === "pr" && c.args[1] === "merge");
        expect(mergeCalls).toHaveLength(0);
    });
});
// ---------------------------------------------------------------------------
// (5g) (d) Low + sub-threshold pauses
// ---------------------------------------------------------------------------
describe("AC5(d) — low + sub-threshold pauses", () => {
    it("low risk, ratio 0.7 (below default 0.8) → low-risk-sub-threshold pause", async () => {
        await seedDoneManifest(targetRepoRoot, { ref: REF, sessionUlid: SESSION_ULID, risk_tier: "low" });
        const { impl: fakeExeca } = makePauseExeca();
        const result = await runAutoMergeGate(baseOpts({
            dryRun: false,
            execaImpl: fakeExeca,
            computeAgreementImpl: makeAgreementImpl(makeMetric(0.7)),
        }));
        expect(result.decision).toBe("pause-needs-human");
        expect(result.reason).toBe("low-risk-sub-threshold");
        expect(result.merged).toBe(false);
        expect(result.labelsApplied).toEqual(["needs-human"]);
    });
    it("thresholdOverride: 0.6 with agreement 0.7 → auto-merge fires (cross-check)", async () => {
        await seedDoneManifest(targetRepoRoot, { ref: REF, sessionUlid: SESSION_ULID, risk_tier: "low" });
        const { impl: fakeExeca } = makeMergeExeca();
        const result = await runAutoMergeGate(baseOpts({
            dryRun: false,
            execaImpl: fakeExeca,
            computeAgreementImpl: makeAgreementImpl(makeMetric(0.7)),
            thresholdOverride: 0.6,
        }));
        expect(result.decision).toBe("auto-merge");
        expect(result.reason).toBe("low-risk-met-threshold");
        expect(result.threshold_used).toBe(0.6);
    });
});
// ---------------------------------------------------------------------------
// (5h) (e) Low + insufficient-data pauses
// ---------------------------------------------------------------------------
describe("AC5(e) — low + insufficient-data pauses", () => {
    it("null agreement_metric → low-risk-insufficient-data pause", async () => {
        await seedDoneManifest(targetRepoRoot, { ref: REF, sessionUlid: SESSION_ULID, risk_tier: "low" });
        const { impl: fakeExeca } = makePauseExeca();
        const result = await runAutoMergeGate(baseOpts({
            dryRun: false,
            execaImpl: fakeExeca,
            computeAgreementImpl: makeAgreementImpl(null),
        }));
        expect(result.decision).toBe("pause-needs-human");
        expect(result.reason).toBe("low-risk-insufficient-data");
        expect(result.agreement_metric).toBeNull();
        expect(result.merged).toBe(false);
        expect(result.labelsApplied).toEqual(["needs-human"]);
    });
    it("lastNVerdictsOverride: 30 with 30 seeds → agreement computed, decision based on ratio", async () => {
        await seedDoneManifest(targetRepoRoot, { ref: REF, sessionUlid: SESSION_ULID, risk_tier: "low" });
        const telemetryDir = path.join(targetRepoRoot, ".flow", "telemetry");
        // Seed 30 READY FOR MERGE + merged pairs (ratio 1.0)
        await seedRatioVerdicts(telemetryDir, 30, 30);
        const { impl: fakeExeca } = makeMergeExeca();
        // With lastNVerdictsOverride: 30, 30 pairs is sufficient → agreement should be 1.0
        const result = await runAutoMergeGate(baseOpts({
            dryRun: false,
            execaImpl: fakeExeca,
            lastNVerdictsOverride: 30,
        }));
        expect(result.agreement_metric).not.toBeNull();
        // ratio 1.0 >= threshold 0.8 → auto-merge
        expect(result.decision).toBe("auto-merge");
    });
});
// Note: the former AC5(f)/AC5(i) "structural SKILL.md check" tests (which read
// skills/start/SKILL.md to assert the orchestration prose invoked runAutoMergeGate
// under the right branch) were removed when /flow:start was retired — the drain
// workflow is the orchestration now, and the gate TOOL is covered by the cases
// above + below. (daemon-retirement, 2026-05-30)
// ---------------------------------------------------------------------------
// (5j) (g) No-tier pause (legacy manifest)
// ---------------------------------------------------------------------------
describe("AC5(g) — no-tier pause (legacy manifest)", () => {
    it("manifest without risk_tier → no-tier-no-signal pause, agreement still computed", async () => {
        // Seed manifest WITHOUT risk_tier
        await seedDoneManifest(targetRepoRoot, { ref: REF, sessionUlid: SESSION_ULID }); // no risk_tier
        const { impl: fakeExeca } = makePauseExeca();
        const result = await runAutoMergeGate(baseOpts({
            dryRun: false,
            execaImpl: fakeExeca,
            computeAgreementImpl: makeAgreementImpl(makeMetric(1.0)),
        }));
        expect(result.decision).toBe("pause-needs-human");
        expect(result.reason).toBe("no-tier-no-signal");
        expect(result.risk_tier).toBeNull();
        expect(result.agreement_metric).not.toBeNull(); // still computed
        expect(result.labelsApplied).toEqual(["needs-human"]);
    });
});
// ---------------------------------------------------------------------------
// (5k) (h) Boundary — ratio exactly equals threshold
// ---------------------------------------------------------------------------
describe("AC5(h) — boundary: ratio exactly equals threshold (>= semantics)", () => {
    it("ratio 0.8 with threshold 0.8 → auto-merge fires (pinned against regression to >)", async () => {
        await seedDoneManifest(targetRepoRoot, { ref: REF, sessionUlid: SESSION_ULID, risk_tier: "low" });
        const { impl: fakeExeca } = makeMergeExeca();
        const result = await runAutoMergeGate(baseOpts({
            dryRun: false,
            execaImpl: fakeExeca,
            computeAgreementImpl: makeAgreementImpl(makeMetric(0.8)),
            thresholdOverride: 0.8,
        }));
        expect(result.decision).toBe("auto-merge");
        expect(result.reason).toBe("low-risk-met-threshold");
        expect(result.merged).toBe(true);
    });
});
// ---------------------------------------------------------------------------
// (5m) (j) MCP tool registration smoke
// ---------------------------------------------------------------------------
describe("AC5(j) — MCP tool registration smoke", () => {
    it("register.ts includes runAutoMergeGate and total count is 31", () => {
        const registeredTools = [];
        const fakeServer = {
            registerTool: (tool) => {
                registeredTools.push(tool.name);
            },
        };
        registerAllTools(fakeServer);
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
        // native:01KT484NY4HCBPBTT6VEY1Q0CS added openCycle (cycle boundary). 47 → 48.
        expect(registeredTools.length).toBe(48);
    });
});
// ---------------------------------------------------------------------------
// (5n) (k) dryRun: true — no gh call made
// ---------------------------------------------------------------------------
describe("AC5(k) — dryRun: true skips gh shell-out", () => {
    it("dryRun: true → decision computed, merged: false, dryRun: true, no execa calls for merge", async () => {
        await seedDoneManifest(targetRepoRoot, { ref: REF, sessionUlid: SESSION_ULID, risk_tier: "low" });
        const { impl: fakeExeca, calls } = makeMergeExeca();
        const result = await runAutoMergeGate(baseOpts({
            dryRun: true,
            execaImpl: fakeExeca,
            computeAgreementImpl: makeAgreementImpl(makeMetric(0.8)),
            thresholdOverride: 0.8,
        }));
        expect(result.decision).toBe("auto-merge");
        expect(result.merged).toBe(false);
        expect(result.dryRun).toBe(true);
        expect(result.labelsApplied).toEqual([]);
        // No gh call should have been made
        expect(calls).toHaveLength(0);
    });
});
// ---------------------------------------------------------------------------
// (5o) (l) Recoverable gh error on pr merge folds to pause-needs-human
//
// The gate is a terminal seam in an unattended loop: a merge that gh refuses must
// NOT throw out of the gate (a raw throw exits the process non-zero, which the
// drain's one-shot seam courier can relay as garbled non-JSON — the PR #277 seam
// break). It folds into a clean pause-needs-human/merge-failed result with the
// cause recorded in chatLog, and the PR is still flagged needs-human.
// ---------------------------------------------------------------------------
describe("AC5(l) — recoverable gh error on pr merge folds to pause-needs-human", () => {
    it("non-zero exit on pr merge with mapped stderr → pause-needs-human/merge-failed (no throw), label still applied", async () => {
        await seedDoneManifest(targetRepoRoot, { ref: REF, sessionUlid: SESSION_ULID, risk_tier: "low" });
        // pr merge fails with a mapped (recoverable) stderr → gh() raises
        // GhRecoverableError; repo-view + api-labels succeed so the fallback
        // needs-human label still lands.
        const failExeca = makeFakeExeca([
            {
                match: (cmd, args) => cmd === "gh" && args[0] === "pr" && args[1] === "merge",
                response: { stdout: "", stderr: "already been merged", exitCode: 1 },
            },
            {
                match: (cmd, args) => cmd === "gh" && args[0] === "repo" && args[1] === "view",
                response: { stdout: DEFAULT_REPO_VIEW_JSON },
            },
            {
                match: (cmd, args) => cmd === "gh" && args[0] === "api",
                response: { stdout: DEFAULT_LABELS_RESPONSE },
            },
        ]);
        const result = await runAutoMergeGate(baseOpts({
            dryRun: false,
            execaImpl: failExeca.impl,
            computeAgreementImpl: makeAgreementImpl(makeMetric(0.8)),
            thresholdOverride: 0.8,
        }));
        expect(result.decision).toBe("pause-needs-human");
        expect(result.reason).toBe("merge-failed");
        expect(result.merged).toBe(false);
        expect(result.labelsApplied).toEqual(["needs-human"]);
        // The cause is surfaced, not silently dropped.
        expect(result.chatLog.join("\n")).toContain("auto-merge attempt failed");
        // Seam-safety: the result is clean JSON that survives a stringify→parse round-trip.
        expect(() => JSON.parse(JSON.stringify(result))).not.toThrow();
        expect(() => AutoMergeGateResultSchema.parse(result)).not.toThrow();
    });
});
// ---------------------------------------------------------------------------
// (5p) (m) pr-merge denied without permission folds to pause-needs-human
//
// A missing pr-merge permission used to throw GhSubcommandDeniedError out of the
// gate. It now folds to pause-needs-human/merge-failed with the denial surfaced
// in chatLog — the misconfiguration is visible (the story sits in the human bucket)
// but the drain seam never breaks.
// ---------------------------------------------------------------------------
describe("AC5(m) — pr-merge denied without permission folds to pause-needs-human", () => {
    it("pr-merge absent from gh_allow → pause-needs-human/merge-failed (no throw), denial in chatLog", async () => {
        await seedDoneManifest(targetRepoRoot, { ref: REF, sessionUlid: SESSION_ULID, risk_tier: "low" });
        // Create a plugin root WITHOUT pr-merge (and without repo-view/api) in gh_allow
        const restrictedPluginRoot = path.join(tmpRoot, "restricted-plugin");
        await fs.mkdir(path.join(restrictedPluginRoot, "permissions"), { recursive: true });
        await atomicWriteFile(path.join(restrictedPluginRoot, "permissions", "generalist-dev.yaml"), [
            "role: generalist-dev",
            "tools_allow:",
            "  - claimStory",
            "gh_allow:",
            "  - pr-view",
            // pr-merge intentionally omitted
            "gh_allow_args: {}",
        ].join("\n") + "\n");
        await atomicWriteFile(path.join(restrictedPluginRoot, "permissions", "gh-error-map.yaml"), "entries: []\n");
        const { impl: fakeExeca } = makeMergeExeca();
        const result = await runAutoMergeGate({
            targetRepoRoot,
            prNumber: PR_NUMBER,
            ref: REF,
            sessionUlid: SESSION_ULID,
            pluginRootOverride: restrictedPluginRoot,
            dryRun: false,
            execaImpl: fakeExeca,
            computeAgreementImpl: makeAgreementImpl(makeMetric(0.8)),
            thresholdOverride: 0.8,
            ciGateImpl: async () => "green",
        });
        expect(result.decision).toBe("pause-needs-human");
        expect(result.reason).toBe("merge-failed");
        expect(result.merged).toBe(false);
        // repo-view/api are also denied → the fallback label can't be applied.
        expect(result.labelsApplied).toEqual([]);
        // The denial is surfaced in chatLog, not silently swallowed.
        expect(result.chatLog.join("\n")).toContain("auto-merge attempt failed");
        expect(() => JSON.parse(JSON.stringify(result))).not.toThrow();
    });
});
// ---------------------------------------------------------------------------
// PR #277 regression — a side-effect failure on the PAUSE path never breaks the
// drain's JSON seam.
//
// The 2026-06-03 failure: a medium-risk PR paused, the gate's label gh call
// failed and threw, the gate exited non-zero with a verbose error blob, and the
// drain's seam courier garbled it into a bare `BLOCKED` token that broke JSON
// parsing — so the story paused with a SyntaxError reason and no label. The fix
// makes the pause path fold any labeller failure into a clean result, preserving
// the real decision/reason and keeping stdout JSON-only.
// ---------------------------------------------------------------------------
describe("PR #277 regression — label failure on the pause path stays JSON-only", () => {
    it("medium-risk pause + gh label call throws (with a stray BLOCKED token) → clean pause-needs-human/medium-risk, label skipped, cause in chatLog", async () => {
        await seedDoneManifest(targetRepoRoot, { ref: REF, sessionUlid: SESSION_ULID, risk_tier: "medium" });
        // repo-view succeeds; the label POST throws an ExecaError-shaped error whose
        // text carries a bare `BLOCKED` token — exactly the #277 shape that used to
        // escape the gate and break the seam.
        const labelThrowExeca = vi.fn().mockImplementation(async (cmd, args) => {
            if (cmd === "gh" && args[0] === "repo" && args[1] === "view") {
                return { stdout: DEFAULT_REPO_VIEW_JSON, stderr: "", exitCode: 0 };
            }
            if (cmd === "gh" && args[0] === "api") {
                throw new Error("Command failed with exit code 1: gh api ...\nHTTP 422: Validation Failed BLOCKED");
            }
            return { stdout: "", stderr: "", exitCode: 0 };
        });
        const result = await runAutoMergeGate(baseOpts({
            dryRun: false,
            execaImpl: labelThrowExeca,
            computeAgreementImpl: makeAgreementImpl(null),
        }));
        // The real decision is preserved — the labeller failure does not change it.
        expect(result.decision).toBe("pause-needs-human");
        expect(result.reason).toBe("medium-risk");
        expect(result.merged).toBe(false);
        expect(result.labelsApplied).toEqual([]);
        expect(result.chatLog.join("\n")).toContain("needs-human label not applied");
        // The crux: the gate returned clean JSON — the stray BLOCKED token never
        // escapes, so a stringify→parse (the seam's relay) does not throw.
        const relayed = JSON.parse(JSON.stringify(result));
        expect(relayed.reason).toBe("medium-risk");
        expect(() => AutoMergeGateResultSchema.parse(result)).not.toThrow();
    });
});
// ---------------------------------------------------------------------------
// (5q) (n) AutoMergeGateResultSchema round-trip
// ---------------------------------------------------------------------------
describe("AC5(n) — AutoMergeGateResultSchema round-trip", () => {
    it("result parses through schema without error and unknown keys fail", async () => {
        await seedDoneManifest(targetRepoRoot, { ref: REF, sessionUlid: SESSION_ULID, risk_tier: "low" });
        const { impl: fakeExeca } = makeMergeExeca();
        const result = await runAutoMergeGate(baseOpts({
            dryRun: false,
            execaImpl: fakeExeca,
            computeAgreementImpl: makeAgreementImpl(makeMetric(0.8)),
            thresholdOverride: 0.8,
        }));
        // Round-trip: JSON.stringify → JSON.parse → schema.parse
        const roundTripped = AutoMergeGateResultSchema.parse(JSON.parse(JSON.stringify(result)));
        expect(roundTripped.decision).toBe(result.decision);
        expect(roundTripped.reason).toBe(result.reason);
        expect(roundTripped.merged).toBe(result.merged);
        expect(roundTripped.prNumber).toBe(result.prNumber);
        // Unknown fields should fail strict schema
        const withExtraField = { ...result, unknownField: "surprise" };
        const parseResult = AutoMergeGateResultSchema.safeParse(withExtraField);
        expect(parseResult.success).toBe(false);
    });
});
// ---------------------------------------------------------------------------
// Additional: threshold validation errors
// ---------------------------------------------------------------------------
describe("AutoMergeGateThresholdInvalidError — threshold validation", () => {
    it("thresholdOverride: NaN → throws AutoMergeGateThresholdInvalidError", async () => {
        await seedDoneManifest(targetRepoRoot, { ref: REF, sessionUlid: SESSION_ULID, risk_tier: "low" });
        await expect(runAutoMergeGate(baseOpts({ thresholdOverride: NaN }))).rejects.toThrow(AutoMergeGateThresholdInvalidError);
    });
    it("thresholdOverride: 1.5 → throws AutoMergeGateThresholdInvalidError", async () => {
        await seedDoneManifest(targetRepoRoot, { ref: REF, sessionUlid: SESSION_ULID, risk_tier: "low" });
        await expect(runAutoMergeGate(baseOpts({ thresholdOverride: 1.5 }))).rejects.toThrow(AutoMergeGateThresholdInvalidError);
    });
    it("thresholdOverride: -0.1 → throws AutoMergeGateThresholdInvalidError", async () => {
        await seedDoneManifest(targetRepoRoot, { ref: REF, sessionUlid: SESSION_ULID, risk_tier: "low" });
        await expect(runAutoMergeGate(baseOpts({ thresholdOverride: -0.1 }))).rejects.toThrow(AutoMergeGateThresholdInvalidError);
    });
});
// ---------------------------------------------------------------------------
// threshold_used is stamped in result
// ---------------------------------------------------------------------------
describe("threshold_used is stamped in result", () => {
    it("thresholdOverride: 0.75 → result.threshold_used is 0.75", async () => {
        await seedDoneManifest(targetRepoRoot, { ref: REF, sessionUlid: SESSION_ULID, risk_tier: "low" });
        const { impl: fakeExeca } = makePauseExeca();
        const result = await runAutoMergeGate(baseOpts({
            dryRun: false,
            execaImpl: fakeExeca,
            computeAgreementImpl: makeAgreementImpl(makeMetric(0.7)),
            thresholdOverride: 0.75,
        }));
        expect(result.threshold_used).toBe(0.75);
    });
    it("no thresholdOverride + loadWorkspaceConfigImpl returning 0.9 → threshold_used is 0.9", async () => {
        await seedDoneManifest(targetRepoRoot, { ref: REF, sessionUlid: SESSION_ULID, risk_tier: "low" });
        const { impl: fakeExeca } = makePauseExeca();
        const result = await runAutoMergeGate(baseOpts({
            dryRun: false,
            execaImpl: fakeExeca,
            computeAgreementImpl: makeAgreementImpl(makeMetric(0.85)),
            loadWorkspaceConfigImpl: async () => ({
                agreement_threshold: 0.9,
                orchestration_interval_seconds: 120,
                provisional_trust: false,
            }),
        }));
        expect(result.threshold_used).toBe(0.9);
        // 0.85 < 0.9 → pause
        expect(result.decision).toBe("pause-needs-human");
    });
});
// ---------------------------------------------------------------------------
// Story 5.34 — AC2: regression guard against mock-masking gap.
//
// These tests load the REAL generalist-dev.yaml via the production
// loadRolePermissions path (pluginRootOverride points at the live
// plugins/flow/ directory, not a hand-built temp fixture).  The gh
// shell-out is still faked so no real `gh` subprocess runs.
//
// Drives BOTH gate branches to confirm neither throws GhSubcommandDeniedError
// for repo-view, api, or pr-merge after the AC1 allowlist fix.
// ---------------------------------------------------------------------------
const REAL_PLUGIN_ROOT = path.resolve(HERE, "..", "..", "..", "..");
describe("Story 5.34 — AC2: real generalist-dev permissions, both gate branches", () => {
    it("pause-needs-human branch — repo-view and api are allowed (no GhSubcommandDeniedError)", async () => {
        await seedDoneManifest(targetRepoRoot, {
            ref: REF,
            sessionUlid: SESSION_ULID,
            risk_tier: "medium", // medium → always pause-needs-human
        });
        const { impl: fakeExeca } = makePauseExeca();
        // Must not throw GhSubcommandDeniedError for repo-view or api
        const result = await runAutoMergeGate({
            targetRepoRoot,
            prNumber: PR_NUMBER,
            ref: REF,
            sessionUlid: SESSION_ULID,
            pluginRootOverride: REAL_PLUGIN_ROOT, // ← production permissions, not a fixture
            dryRun: false,
            execaImpl: fakeExeca,
            computeAgreementImpl: makeAgreementImpl(makeMetric(1.0)),
        });
        expect(result.decision).toBe("pause-needs-human");
        expect(result.merged).toBe(false);
        expect(result.labelsApplied).toEqual(["needs-human"]);
    });
    it("auto-merge branch — pr-merge is allowed (no GhSubcommandDeniedError)", async () => {
        await seedDoneManifest(targetRepoRoot, {
            ref: REF,
            sessionUlid: SESSION_ULID,
            risk_tier: "low", // low + met threshold → auto-merge
        });
        const { impl: fakeExeca } = makeMergeExeca();
        // Must not throw GhSubcommandDeniedError for pr-merge
        const result = await runAutoMergeGate({
            targetRepoRoot,
            prNumber: PR_NUMBER,
            ref: REF,
            sessionUlid: SESSION_ULID,
            pluginRootOverride: REAL_PLUGIN_ROOT, // ← production permissions, not a fixture
            dryRun: false,
            execaImpl: fakeExeca,
            computeAgreementImpl: makeAgreementImpl(makeMetric(0.9)), // above default 0.8 threshold
            ciGateImpl: async () => "green",
        });
        expect(result.decision).toBe("auto-merge");
        expect(result.merged).toBe(true);
    });
});
