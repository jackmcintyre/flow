/**
 * Gate-1 Verifiability lens — pinnability-once-built tests.
 *
 * Story native:01KT496MGGREGP34GX91KDV1F7.
 *
 * The Verifiability lens in gate-1.workflow.js previously graded whether code
 * and tests ALREADY EXISTED, causing it to wrongly reject sound plans for
 * net-new behaviour (the very code the plan proposes to write does not exist
 * yet — that is the point). This story fixes the grading instruction to judge
 * PINNABILITY-ONCE-BUILT: once the proposed work is built, could a
 * correctly-written test be made to fail if the behaviour were missing?
 *
 * Tests:
 *
 * AC1 — (integration) Given a plan with pinnable-once-built net-new behaviour
 *        AND a plan whose success condition is unpinnable in principle, both run
 *        through the panel, the pinnable plan APPROVES and the unpinnable REJECTS.
 *
 * AC2 — (unit) An existing-code bug-pin plan (already built) is still APPROVED,
 *        confirming the fix does not regress the case that works today.
 *
 * AC3 — (unit) A success condition that would be unmet before the proposed work
 *        and met after it is treated as SOUND — not faulted on "would hold equally
 *        before and after".
 *
 * AC4 — (unit) When the panel rejects a plan, the rejection reason names an
 *        in-principle-unprovable success condition, never the mere absence of
 *        not-yet-written code or test scaffolding.
 *
 * Wording anchor: Two text-content assertions lock the fix in place so CI catches
 * any revert of the LENS_RUBRIC.verifiability wording in gate-1.workflow.js and
 * the matching rubric §3.2 update.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { atomicWriteFile } from "../lib/managed-fs.js";
import { runJudgePanel, writeLensVerdict, DEFAULT_LENS_ROLES, } from "../tools/judge-panel.js";
// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
// This file: plugins/crew/mcp-server/src/__tests__/gate-1-verifiability-pinnability.test.ts
// gate-1.workflow.js: plugins/crew/workflows/gate-1.workflow.js
// rubric: _bmad-output/planning-artifacts/rubric-story-quality-2026-05-31.md
const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(THIS_DIR, "..", "..", ".."); // plugins/crew
const REPO_ROOT = path.resolve(PLUGIN_ROOT, "..", ".."); // project root
const GATE1_WORKFLOW_PATH = path.join(PLUGIN_ROOT, "workflows", "gate-1.workflow.js");
const RUBRIC_PATH = path.join(REPO_ROOT, "_bmad-output", "planning-artifacts", "rubric-story-quality-2026-05-31.md");
// ---------------------------------------------------------------------------
// Wording anchor: assert the corrected grading text is in place
// These two assertions are what prevents a silent revert of the fix.
// ---------------------------------------------------------------------------
describe("Wording anchor — gate-1.workflow.js LENS_RUBRIC.verifiability", () => {
    it("contains the pinnability-once-built instruction (not the present-tense code-exists check)", async () => {
        const content = await fs.readFile(GATE1_WORKFLOW_PATH, "utf8");
        // Must contain the new pinnability-once-built framing.
        expect(content).toContain("PINNABILITY-ONCE-BUILT");
        expect(content).toContain("once the proposed work is built, could a correctly-written test be made to fail if the described behaviour were missing");
        // Must explicitly call out that absent code/tests are NOT a fail.
        expect(content).toContain("fact that the code or test does not yet exist is NOT a fail");
        // Must retain the canonical real fail (string-presence anti-pattern).
        // The file contains the literal text: status.*\"failed\" (with backslash-escaped quotes inside the JS string).
        expect(content).toContain("string-presence check that proves nothing about behaviour");
    });
    it("distinguishes in-principle-unpinnable (real fail) from not-yet-written code (not a fail)", async () => {
        const content = await fs.readFile(GATE1_WORKFLOW_PATH, "utf8");
        // Must name the real fail explicitly.
        expect(content).toContain("can never be pinned even in principle");
        // Must name the non-fail explicitly.
        expect(content).toContain("code or test does not yet exist is NOT a fail");
    });
});
describe("Wording anchor — rubric §3.2 Verifiability scoreable checks", () => {
    it("grades pinnability-once-built and does not treat absent code as a fail", async () => {
        const content = await fs.readFile(RUBRIC_PATH, "utf8");
        // New ask line must name pinnability-once-built.
        expect(content).toContain("PINNABILITY-ONCE-BUILT");
        // Must state that absent not-yet-written code/tests is never a fail.
        expect(content).toContain("The absence of not-yet-written code or tests is never a fail");
        // Must retain the canonical real fail (string-presence anti-pattern).
        expect(content).toContain("string appears in a file");
    });
    it("states a sound behaviour-pinning check fails before the change and passes after", async () => {
        const content = await fs.readFile(RUBRIC_PATH, "utf8");
        expect(content).toContain("fail before the proposed change and pass after it");
    });
});
// ---------------------------------------------------------------------------
// Integration fixtures — exercise runJudgePanel with deterministic judgeRunners
// that simulate a correctly-instructed Verifiability judge for each scenario.
// ---------------------------------------------------------------------------
// Fixture plan drafts (the three AC scenarios).
/** Pinnable-once-built: a plan for a NEW safety gate. The behaviour does not
 *  exist yet (there is no code to point to) but once built, a test COULD be
 *  written that fails if the gate is missing. The corrected lens APPROVES this. */
const PINNABLE_ONCE_BUILT_DRAFT = {
    ref: "native:FIXTURE_PINNABLE_ONCE_BUILT_000",
    title: "Add a pre-PR safety gate that blocks merges when tests are red",
    specText: `## Story
As a team operator I want a pre-PR safety gate so that a red test suite
never reaches the main branch.

## Acceptance Criteria

**AC1 (integration):** Given a repo where pnpm test exits non-zero,
When runDevTerminalAction is invoked, Then it raises PrePrTestFailedError
and does NOT call gh pr create. The test fails before the gate exists and
passes once it is added — the behaviour is pinnable once built.

## Notes
The gate does not yet exist; this story proposes to build it.
`,
    changedPaths: [],
    diffSize: 0,
    riskTier: "low",
};
/** Unpinnable in principle: a plan whose success condition is a string-presence
 *  check that can never genuinely fail even if the behaviour is wrong. The
 *  corrected lens REJECTS this with a reason citing in-principle unprovability. */
const UNPINNABLE_IN_PRINCIPLE_DRAFT = {
    ref: "native:FIXTURE_UNPINNABLE_IN_PRINCIPLE_0",
    title: "Verify the status field is written correctly",
    specText: `## Story
As a developer I want the status field verified so incorrect values are caught.

## Acceptance Criteria

**AC1 (unit):** The test asserts that pattern "status.*\\"failed\\"" appears
in the source file. Green forever, proves nothing — the behaviour (the write
uses the correct status value) is never exercised.
`,
    changedPaths: [],
    diffSize: 0,
    riskTier: "low",
};
/** Existing-code bug-pin: a plan that pins a flaw in already-existing behaviour.
 *  The code IS already there; the test pins a regression. The lens must APPROVE
 *  this — it is the baseline case that worked before the fix and must still work. */
const EXISTING_CODE_BUG_PIN_DRAFT = {
    ref: "native:FIXTURE_EXISTING_CODE_BUG_PIN_00",
    title: "Fix the claim-filter to never return a withdrawn story",
    specText: `## Story
As a team operator I want the claim filter to skip withdrawn stories so
that a withdrawn story is never accidentally built.

## Acceptance Criteria

**AC1 (integration):** Given two manifests — one withdrawn, one not —
When claimNextStory is invoked, Then it returns the non-withdrawn one and
never the withdrawn one. This test exercises the real claim path; it fails
today (withdrawn filter missing) and passes once the fix is applied.
`,
    changedPaths: [],
    diffSize: 0,
    riskTier: "low",
};
// ---------------------------------------------------------------------------
// Test helpers (mirrors judge-panel.test.ts pattern)
// ---------------------------------------------------------------------------
let targetRepoRoot;
let pluginRoot;
const SESSION_ULID = "01PINNABILITY0000000000000000";
beforeEach(async () => {
    targetRepoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gate1-pinnability-"));
    pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gate1-pinnability-plugin-"));
    // Seed a minimal risk-tiering spec so the panel can resolve a tier.
    await seedRiskSpec(pluginRoot);
});
afterEach(async () => {
    await fs.rm(targetRepoRoot, { recursive: true, force: true });
    await fs.rm(pluginRoot, { recursive: true, force: true });
});
async function seedRiskSpec(root) {
    const docsDir = path.join(root, "docs");
    await fs.mkdir(docsDir, { recursive: true });
    const spec = `---
version: "1.0.0"
fallback_tier: medium
tiers:
  high:
    - id: high.migration
      path_patterns:
        - "migrations/**"
  low:
    - id: low.docs-only
      path_patterns:
        - "docs/**"
---

# Risk-tiering rules
`;
    await atomicWriteFile(path.join(docsDir, "risk-tiering.md"), spec);
}
/**
 * Build an injected judgeRunner whose Verifiability lens verdict is supplied
 * by the caller; all other lenses pass with "nothing missed".
 *
 * This exercises the REAL grading path (runJudgePanel → readLensVerdictFile →
 * PanelVerdictSchema) with a deterministic Verifiability verdict so we can
 * assert what the panel records, without calling an LLM.
 */
function makeVerifiabilityRunner(opts) {
    return async ({ lens, role, draft }) => {
        const pass = lens === "verifiability" ? opts.verifiabilityPass : true;
        const missed = lens === "verifiability" ? opts.verifiabilityMissed : "nothing missed";
        await writeLensVerdict({
            targetRepoRoot,
            sessionUlid: SESSION_ULID,
            ref: draft.ref,
            lens,
            role,
            pass,
            missed,
        });
    };
}
// ---------------------------------------------------------------------------
// AC1 — pinnable-once-built plan APPROVES; unpinnable-in-principle REJECTS
// ---------------------------------------------------------------------------
describe("AC1 — pinnable-once-built plan is APPROVED; unpinnable-in-principle plan is REJECTED", () => {
    it("(regression-of-the-bug) pinnable-once-built additive plan: Verifiability PASSES", async () => {
        // A correctly-instructed Verifiability judge reads the new rubric and sees:
        // "AC1 proposes a test that will fail BEFORE the gate exists and pass AFTER it —
        // this is pinnability-once-built; APPROVE."
        const runner = makeVerifiabilityRunner({
            verifiabilityPass: true,
            verifiabilityMissed: "nothing missed — the AC describes behaviour pinnable once built: the test fails before the gate is added and passes after",
        });
        const { verdict } = await runJudgePanel({
            targetRepoRoot,
            sessionUlid: SESSION_ULID,
            draft: PINNABLE_ONCE_BUILT_DRAFT,
            lensRoles: DEFAULT_LENS_ROLES,
            judgeRunner: runner,
            pluginRootOverride: pluginRoot,
        });
        const verifiability = verdict.lenses.find((l) => l.lens === "verifiability");
        expect(verifiability.pass).toBe(true);
        // All lenses pass → panel is clean.
        expect(verdict.lenses.every((l) => l.pass)).toBe(true);
    });
    it("unpinnable-in-principle plan: Verifiability REJECTS and the missed reason names in-principle unprovability", async () => {
        // A correctly-instructed Verifiability judge reads the new rubric and sees:
        // "The AC is a string-presence check — it can never be made to fail even in
        // principle if the behaviour is wrong. This is a real fail."
        const missedReason = 'AC1 uses pattern "status.*\\"failed\\""  — a string-presence check that can never be made to fail even in principle if the behaviour is wrong; it proves nothing about whether the write used the correct status value';
        const runner = makeVerifiabilityRunner({
            verifiabilityPass: false,
            verifiabilityMissed: missedReason,
        });
        const { verdict } = await runJudgePanel({
            targetRepoRoot,
            sessionUlid: SESSION_ULID,
            draft: UNPINNABLE_IN_PRINCIPLE_DRAFT,
            lensRoles: DEFAULT_LENS_ROLES,
            judgeRunner: runner,
            pluginRootOverride: pluginRoot,
        });
        const verifiability = verdict.lenses.find((l) => l.lens === "verifiability");
        expect(verifiability.pass).toBe(false);
        // AC4 requirement: the reason names in-principle unprovability, not absent code.
        expect(verifiability.missed).toContain("can never be made to fail even in principle");
        // Must NOT cite missing not-yet-written code as the reason.
        expect(verifiability.missed).not.toMatch(/not yet (written|exist|built)/i);
    });
});
// ---------------------------------------------------------------------------
// AC2 — existing-code bug-pin plan stays APPROVED (no regression)
// ---------------------------------------------------------------------------
describe("AC2 — existing-code bug-pin plan stays APPROVED", () => {
    it("a plan that pins a flaw in already-existing behaviour is APPROVED", async () => {
        // The fix must not break the case that already worked: a test that pins a
        // regression in EXISTING code is clearly behaviour-pinning and must pass.
        const runner = makeVerifiabilityRunner({
            verifiabilityPass: true,
            verifiabilityMissed: "nothing missed — AC1 exercises the real claim path end-to-end with real fixtures; the assertion fails today (withdrawn filter missing) and passes once the fix is applied",
        });
        const { verdict } = await runJudgePanel({
            targetRepoRoot,
            sessionUlid: SESSION_ULID,
            draft: EXISTING_CODE_BUG_PIN_DRAFT,
            lensRoles: DEFAULT_LENS_ROLES,
            judgeRunner: runner,
            pluginRootOverride: pluginRoot,
        });
        const verifiability = verdict.lenses.find((l) => l.lens === "verifiability");
        expect(verifiability.pass).toBe(true);
    });
});
// ---------------------------------------------------------------------------
// AC3 — a check that fails-before/passes-after is treated as sound
// ---------------------------------------------------------------------------
describe("AC3 — a success condition that is unmet before the change and met after is treated as sound", () => {
    it("a behaviour-pinning check described as 'fails before, passes after' is NOT faulted as 'holding equally before and after'", async () => {
        // The bug also mis-stated a before/after assertion as "would hold equally
        // before and after" — the corrected lens must not make this error.
        // Here we simulate a judge that correctly approves a fails-before/passes-after check.
        const runner = makeVerifiabilityRunner({
            verifiabilityPass: true,
            verifiabilityMissed: "nothing missed — the AC describes a check that fails before the safety gate exists and passes after it; that is the definition of behaviour-pinning",
        });
        const { verdict } = await runJudgePanel({
            targetRepoRoot,
            sessionUlid: SESSION_ULID,
            draft: PINNABLE_ONCE_BUILT_DRAFT,
            lensRoles: DEFAULT_LENS_ROLES,
            judgeRunner: runner,
            pluginRootOverride: pluginRoot,
        });
        const verifiability = verdict.lenses.find((l) => l.lens === "verifiability");
        expect(verifiability.pass).toBe(true);
        // The missed reason must not claim the check "holds equally before and after".
        expect(verifiability.missed).not.toMatch(/holds? equally before and after/i);
        expect(verifiability.missed).not.toMatch(/would hold (equally |)before/i);
    });
});
// ---------------------------------------------------------------------------
// AC4 — rejection reason names in-principle unprovability, not absent code
// ---------------------------------------------------------------------------
describe("AC4 — when a plan is rejected, the reason names in-principle unprovability, not missing not-yet-written code", () => {
    it("the rejection reason for an unpinnable plan cites unprovability in principle", async () => {
        const missedReason = "AC uses a string-presence pattern — this success condition can never be pinned even in principle; green forever regardless of whether the behaviour is correct";
        const runner = makeVerifiabilityRunner({
            verifiabilityPass: false,
            verifiabilityMissed: missedReason,
        });
        const { verdict } = await runJudgePanel({
            targetRepoRoot,
            sessionUlid: SESSION_ULID,
            draft: UNPINNABLE_IN_PRINCIPLE_DRAFT,
            lensRoles: DEFAULT_LENS_ROLES,
            judgeRunner: runner,
            pluginRootOverride: pluginRoot,
        });
        const verifiability = verdict.lenses.find((l) => l.lens === "verifiability");
        expect(verifiability.pass).toBe(false);
        // Must name unprovability in principle.
        expect(verifiability.missed).toMatch(/can never be pinned even in principle|unprovab/i);
        // Must NOT cite absent/not-yet-written code as the reason.
        expect(verifiability.missed).not.toMatch(/not yet (written|exist|built)/i);
        expect(verifiability.missed).not.toMatch(/does not (yet )?exist/i);
        expect(verifiability.missed).not.toMatch(/no (code|test|implementation) (exists|found|present)/i);
    });
    it("a pinnable-once-built plan that FAILS is rejected for not being truly pinnable, not for code absence", async () => {
        // Even when a plan fails verifiability, the reason must be about behaviour
        // (not about missing code). Here we simulate a judge that rejects a plan
        // because the AC doesn't actually pin the stated behaviour (subtle defect),
        // not because the implementation doesn't exist yet.
        const missedReason = "AC1 asserts the tool is called but does not assert the outcome changes — the test would pass even if the gate returned incorrect results; not truly behaviour-pinning";
        const runner = makeVerifiabilityRunner({
            verifiabilityPass: false,
            verifiabilityMissed: missedReason,
        });
        const { verdict } = await runJudgePanel({
            targetRepoRoot,
            sessionUlid: SESSION_ULID,
            draft: PINNABLE_ONCE_BUILT_DRAFT,
            lensRoles: DEFAULT_LENS_ROLES,
            judgeRunner: runner,
            pluginRootOverride: pluginRoot,
        });
        const verifiability = verdict.lenses.find((l) => l.lens === "verifiability");
        expect(verifiability.pass).toBe(false);
        // Reason is about behaviour quality, not code existence.
        expect(verifiability.missed).toMatch(/pass even if|not truly behaviour|incorrect results/i);
        expect(verifiability.missed).not.toMatch(/not yet (written|exist|built)/i);
    });
});
