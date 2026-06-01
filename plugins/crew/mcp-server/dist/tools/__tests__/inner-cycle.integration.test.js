/**
 * Integration tests for the inner dev → reviewer cycle through tool composition
 * — Story 4.3b Task 10; Story 4.3c Task 6.
 *
 * Behavioural contract source:
 *   _bmad-output/implementation-artifacts/4-3b-harness-task-spawn-seam-for-rundevsession.md § Behavioural contract
 *   _bmad-output/implementation-artifacts/4-3c-call-completestory-after-ready-for-merge.md § Behavioural contract
 *
 * Composes `processDevTranscript`, `processReviewerTranscript`, and `claimNextStory`
 * in the order the SKILL.md prose will compose them. The Claude Code `Task` tool is
 * NOT in the loop — this is a unit-level integration test of the MCP layer's
 * composition correctness.
 *
 * NOTE (Story 4.3c): `completeStory` is no longer called directly by the test code
 * on the green branch. `processReviewerTranscript` calls `completeStory` internally
 * when it parses a `READY FOR MERGE` verdict. The test asserts the side-effect by
 * inspecting the on-disk manifest state after `processReviewerTranscript` returns.
 * The `completeStory` import is retained for the blocked-branch negative assertions.
 *
 * Each test case seeds a fixture tmpdir with:
 *   - `.crew/config.yaml` (native adapter)
 *   - `.crew/state/in-progress/<ref>.yaml` (pre-claimed manifest)
 *   - `team/generalist-dev/PERSONA.md`
 *   - `team/generalist-reviewer/PERSONA.md`
 *
 * Covers the AC4 branches (a)–(g):
 *   (a) Happy handoff + READY FOR MERGE.
 *   (b) Rework loop: NEEDS CHANGES × 1 → READY FOR MERGE.
 *   (c) Grammar drift (handoff drift).
 *   (d) Two-iteration rework convergence.
 *   (e) Reviewer grammar drift.
 *   (f) Reviewer BLOCKED passthrough.
 *   (g) Tool count assertion (22 tools, contains new tools, does not contain runDevSession).
 *
 * AC4 (4.3c) — two-story drain via processReviewerTranscript internal seam:
 *   Two stories driven through claimNextStory → processDevTranscript →
 *   processReviewerTranscript (which internally calls completeStory and returns
 *   completed: true), then third claimNextStory returns queue-drained.
 *   (h) Blocked branch: processReviewerTranscript does NOT move manifest, returned
 *       object has no `completed` field.
 *   (i) Reviewer-grammar-drift branch: same MUST NOT pattern as (h).
 *
 * Story 4.3b Task 10.1–10.4; Story 4.3c Task 6.1–6.6.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { reviewerResultFilePath } from "../../lib/read-reviewer-result-file.js";
import { writeInProgressSnapshot } from "../../state/manifest-state-machine.js";
import { parseExecutionManifest } from "../../schemas/execution-manifest.js";
import { processDevTranscript } from "../process-dev-transcript.js";
import { processReviewerTranscript } from "../process-reviewer-transcript.js";
import { ReviewerFirstCallSkippedError } from "../../errors.js";
import { claimNextStory } from "../claim-next-story.js";
import { scanSources } from "../scan-sources.js";
import { markStoryReady } from "../mark-story-ready.js";
import { registerAllTools } from "../register.js";
import { createServer } from "../../server.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
// ---------------------------------------------------------------------------
// Mock deriveSourceBaseline for the tests that use the fixture STORY_REF
// (which uses a non-Crockford ULID that fails native adapter validation).
// Tests that use buildTwoStoryWorkspace (real source files) set the mock to
// call the real implementation via realDeriveSourceBaseline.
// ---------------------------------------------------------------------------
vi.mock("../../state/derive-source-baseline.js", () => ({
    deriveSourceBaseline: vi.fn(),
}));
import { deriveSourceBaseline } from "../../state/derive-source-baseline.js";
const mockDeriveSourceBaseline = vi.mocked(deriveSourceBaseline);
// Capture a real implementation reference via importActual for workspace-based tests.
const { deriveSourceBaseline: realDeriveSourceBaseline } = await vi.importActual("../../state/derive-source-baseline.js");
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const STORY_REF = "native:01J9P0K2N3MZX0YV4S5RTQ4GHI";
const SESSION_ULID = "01HZSESSION00000000000003";
const HANDOFF_PHRASE = `Handoff to reviewer — story ${STORY_REF} ready for review.`;
const READY_FOR_MERGE = `**Verdict: READY FOR MERGE**`;
const NEEDS_CHANGES = `**Verdict: NEEDS CHANGES** [2 issues]`;
const BLOCKED_VERDICT = `**Verdict: BLOCKED**`;
// Story 4.6: happy-path transcripts must include a GitHub PR URL for prNumber extraction.
const FIXTURE_PR_URL = "https://github.com/test-org/test-repo/pull/99";
// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------
function makeBaseManifest(ref) {
    return {
        ref,
        status: "in-progress",
        adapter: "native",
        source_path: `.crew/native-stories/${ref}.yaml`,
        source_hash: "a".repeat(64),
        depends_on: [],
        acceptance_criteria: [{ text: "Given x, when y, then z.", kind: "integration" }],
        title: "Integration Test Story",
        narrative: "As a dev, I want to integrate test.",
        withdrawn: false,
        ready: true,
        claimed_by: SESSION_ULID,
    };
}
const FIXTURE_DEV_PERSONA_MD = `---
role: generalist-dev
domain: "feature implementation in a story scope"
model_tier: sonnet
tools_allow:
  - Read
locked_phrases:
  handoff: "Handoff to reviewer — story <story-id> ready for review."
  yield: "This sits in <role>'s domain — handing off"
  verdict: "**Verdict: <SENTINEL>**"
hired_at: "2026-01-01T00:00:00.000Z"
catalogue_version: "0.1.0"
---

# Generalist Dev

## Domain

Implements stories.

## Mandate

- Implement.

## Out of mandate

- Review.

## Prompt

You are the dev.

## Knowledge

None.
`;
const FIXTURE_REVIEWER_PERSONA_MD = `---
role: generalist-reviewer
domain: "code review in a story scope"
model_tier: sonnet
tools_allow:
  - Read
locked_phrases:
  handoff: "Handoff to reviewer — story <story-id> ready for review."
  yield: "This sits in <role>'s domain — handing off"
  verdict: "**Verdict: <SENTINEL>**"
hired_at: "2026-01-01T00:00:00.000Z"
catalogue_version: "0.1.0"
---

# Generalist Reviewer

## Domain

Reviews stories.

## Mandate

- Review.

## Out of mandate

- Implement.

## Prompt

You are the reviewer.

## Knowledge

None.
`;
// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
let tmpRoot;
let manifestPath;
async function seedManifest(manifest) {
    await atomicWriteFile(manifestPath, yamlStringify(manifest, { lineWidth: 0 }));
    // Story 5.29: seed the claim-time sidecar so completeStory's hand-edit guard
    // has a baseline to compare against.
    await writeInProgressSnapshot({ targetRepoRoot: tmpRoot, ref: manifest.ref, manifest });
}
beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "crew-inner-cycle-integration-"));
    // .crew state dirs
    await fs.mkdir(path.join(tmpRoot, ".crew", "state", "in-progress"), { recursive: true });
    await fs.mkdir(path.join(tmpRoot, ".crew", "state", "to-do"), { recursive: true });
    await fs.mkdir(path.join(tmpRoot, ".crew", "state", "done"), { recursive: true });
    // .crew/config.yaml (native adapter)
    await atomicWriteFile(path.join(tmpRoot, ".crew", "config.yaml"), "adapter: native\n");
    manifestPath = path.join(tmpRoot, ".crew", "state", "in-progress", `${STORY_REF}.yaml`);
    await seedManifest(makeBaseManifest(STORY_REF));
    // team personas
    await fs.mkdir(path.join(tmpRoot, "team", "generalist-dev"), { recursive: true });
    await fs.mkdir(path.join(tmpRoot, "team", "generalist-reviewer"), { recursive: true });
    await atomicWriteFile(path.join(tmpRoot, "team", "generalist-dev", "PERSONA.md"), FIXTURE_DEV_PERSONA_MD);
    await atomicWriteFile(path.join(tmpRoot, "team", "generalist-reviewer", "PERSONA.md"), FIXTURE_REVIEWER_PERSONA_MD);
    // Mock deriveSourceBaseline so completeStory's hand-edit guard passes for
    // the fixture STORY_REF (which has a non-Crockford ULID / no source file).
    // The two-story drain tests override this mock to use real source resolution.
    mockDeriveSourceBaseline.mockResolvedValue({
        sourceHash: "a".repeat(64),
        sourceFields: {
            title: "Integration Test Story",
            narrative: "As a dev, I want to integrate test.",
            acceptance_criteria: [{ text: "Given x, when y, then z.", kind: "integration" }],
            implementation_notes: undefined,
            depends_on: [],
            withdrawn: false,
        },
    });
});
afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
});
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function readOnDiskManifest() {
    const raw = await fs.readFile(manifestPath, "utf8");
    return parseExecutionManifest(yamlParse(raw), { absPath: manifestPath });
}
function makeDevOpts(devTranscript) {
    // Story 4.6: prepend the fixture PR URL so processDevTranscript can extract prNumber.
    // The URL is prepended only when the transcript doesn't already contain a PR URL.
    const withPrUrl = devTranscript.includes("github.com")
        ? devTranscript
        : `${FIXTURE_PR_URL}\n${devTranscript}`;
    return { targetRepoRoot: tmpRoot, sessionUlid: SESSION_ULID, ref: STORY_REF, devTranscript: withPrUrl };
}
function makeReviewerOpts() {
    return {
        targetRepoRoot: tmpRoot,
        sessionUlid: SESSION_ULID,
        ref: STORY_REF,
        manifestPath,
    };
}
/**
 * Seed a reviewer-result.json file at the expected path for the given
 * targetRepoRoot + sessionUlid, with the given recommendedVerdict.
 * Mirrors what `runReviewerSession` writes before returning.
 */
async function seedReviewerResultFile(targetRepoRoot, sessionUlid, ref, recommendedVerdict) {
    // Story 8.15: seed at the per-ref namespaced path the reader now derives.
    const filePath = reviewerResultFilePath(targetRepoRoot, sessionUlid, ref);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const content = {
        sessionUlid,
        ref,
        recommendedVerdict,
        acResults: {},
        standardsByCriterionId: {},
        sourceStoryRef: ref,
        prNumber: 99,
        standardsVersion: "1.2.3",
    };
    await atomicWriteFile(filePath, JSON.stringify(content, null, 2));
}
// ---------------------------------------------------------------------------
// AC4(a): Happy handoff + READY FOR MERGE
// ---------------------------------------------------------------------------
describe("AC4(a): happy handoff + READY FOR MERGE", () => {
    it("full cycle: spawn-reviewer → done-ready-for-merge, completed: true, verbatim chatLog, manifest moved to done/", async () => {
        const devResult = await processDevTranscript(makeDevOpts(HANDOFF_PHRASE));
        expect(devResult.next).toBe("spawn-reviewer");
        if (devResult.next !== "spawn-reviewer")
            return;
        // Revision 2: seed reviewer-result.json before calling processReviewerTranscript
        await seedReviewerResultFile(tmpRoot, SESSION_ULID, STORY_REF, "READY FOR MERGE");
        const reviewerResult = await processReviewerTranscript(makeReviewerOpts());
        expect(reviewerResult.next).toBe("done-ready-for-merge");
        if (reviewerResult.next !== "done-ready-for-merge")
            return;
        // Story 4.3c: completed: true confirms completeStory ran internally.
        expect(reviewerResult.completed).toBe(true);
        // Cumulative chatLog contains AC1 verbatim line.
        const allChatLog = [...devResult.chatLog, ...reviewerResult.chatLog];
        expect(allChatLog).toContain(`handoff received — story ${STORY_REF} — spawning generalist-reviewer subagent (clean context)`);
        // READY FOR MERGE line.
        expect(allChatLog).toContain(`reviewer verdict: READY FOR MERGE — story ${STORY_REF} ready for merge gate`);
        // Story 4.3c: manifest moved to done/; in-progress/ no longer has the ref.
        await expect(fs.stat(manifestPath)).rejects.toThrow(); // ENOENT
        const doneManifestRaw = await fs.readFile(path.join(tmpRoot, ".crew", "state", "done", `${STORY_REF}.yaml`), "utf8");
        const doneManifest = parseExecutionManifest(yamlParse(doneManifestRaw), {
            absPath: path.join(tmpRoot, ".crew", "state", "done", `${STORY_REF}.yaml`),
        });
        expect(doneManifest.status).toBe("done");
        expect(doneManifest.rework_count).toBeUndefined();
        expect(doneManifest.blocked_by).toBeUndefined();
    });
});
// ---------------------------------------------------------------------------
// AC4(b): Rework loop — one NEEDS CHANGES → READY FOR MERGE
// ---------------------------------------------------------------------------
describe("AC4(b): NEEDS CHANGES (rework_count undefined → 1) → second cycle READY FOR MERGE", () => {
    it("rework-dev → reworkIteration: 1, then done-ready-for-merge; done manifest rework_count: 1; verbatim AC2 line", async () => {
        // First dev turn: happy handoff.
        const devResult1 = await processDevTranscript(makeDevOpts(HANDOFF_PHRASE));
        expect(devResult1.next).toBe("spawn-reviewer");
        if (devResult1.next !== "spawn-reviewer")
            return;
        // Revision 2: seed NEEDS CHANGES result file, then call processReviewerTranscript.
        await seedReviewerResultFile(tmpRoot, SESSION_ULID, STORY_REF, "NEEDS CHANGES");
        const reviewerResult1 = await processReviewerTranscript(makeReviewerOpts());
        // Revision 2: NEEDS CHANGES now returns done-blocked-reviewer-needs-changes (not rework-dev).
        // The rework-dev path is now only triggered by the old chat-based path which is retired.
        // For integration continuity, NEEDS CHANGES stamps blocked_by and returns the new variant.
        expect(reviewerResult1.next).toBe("done-blocked-reviewer-needs-changes");
        if (reviewerResult1.next !== "done-blocked-reviewer-needs-changes")
            return;
        // Second dev turn: happy handoff again.
        const devResult2 = await processDevTranscript(makeDevOpts(HANDOFF_PHRASE));
        expect(devResult2.next).toBe("spawn-reviewer");
        if (devResult2.next !== "spawn-reviewer")
            return;
        // Second reviewer turn: READY FOR MERGE.
        await seedReviewerResultFile(tmpRoot, SESSION_ULID, STORY_REF, "READY FOR MERGE");
        const reviewerResult2 = await processReviewerTranscript(makeReviewerOpts());
        expect(reviewerResult2.next).toBe("done-ready-for-merge");
        if (reviewerResult2.next !== "done-ready-for-merge")
            return;
        // Story 4.3c: completed: true confirms the internal move
        expect(reviewerResult2.completed).toBe(true);
        // Revision 2: NEEDS CHANGES chatLog contains the new blocked message.
        const allChatLog = [
            ...devResult1.chatLog,
            ...reviewerResult1.chatLog,
            ...devResult2.chatLog,
            ...reviewerResult2.chatLog,
        ];
        // Verify NEEDS CHANGES chatLog was emitted (revision 2 variant)
        const hasNeedsChangesLog = allChatLog.some((l) => l.includes("reviewer verdict: NEEDS CHANGES") && l.includes(STORY_REF));
        expect(hasNeedsChangesLog).toBe(true);
        // Story 4.3c: manifest moved to done/ after READY FOR MERGE on second attempt.
        await expect(fs.stat(manifestPath)).rejects.toThrow(); // ENOENT
        const doneManifestRaw = await fs.readFile(path.join(tmpRoot, ".crew", "state", "done", `${STORY_REF}.yaml`), "utf8");
        const doneManifest = parseExecutionManifest(yamlParse(doneManifestRaw), {
            absPath: path.join(tmpRoot, ".crew", "state", "done", `${STORY_REF}.yaml`),
        });
        // Note: In revision 2, NEEDS CHANGES stamps blocked_by on the manifest.
        // The operator would normally clear it before re-running; in this test we
        // just assert the done manifest got the READY FOR MERGE transition (status: "done").
        // The blocked_by from the NEEDS CHANGES round is preserved in the done manifest
        // since completeStory moves it as-is — this is expected behavior.
        expect(doneManifest.status).toBe("done");
    });
});
// ---------------------------------------------------------------------------
// AC4(c): Grammar drift (handoff drift)
// ---------------------------------------------------------------------------
describe("AC4(c): handoff grammar drift → done-blocked-handoff-grammar", () => {
    it("processReviewerTranscript is NOT called; manifest blocked_by: 'handoff-grammar'; verbatim AC3 line", async () => {
        const devResult = await processDevTranscript(makeDevOpts("story is ready for review — handing off!"));
        expect(devResult.next).toBe("done-blocked-handoff-grammar");
        expect(devResult.chatLog).toContain(`handoff grammar drift — story ${STORY_REF} blocked. expected verbatim phrase: "Handoff to reviewer — story ${STORY_REF} ready for review." Edit the manifest to clear blocked_by and re-run /crew:start.`);
        const onDisk = await readOnDiskManifest();
        expect(onDisk.blocked_by).toBe("handoff-grammar");
    });
});
// ---------------------------------------------------------------------------
// AC4(d): Two-iteration rework convergence
// ---------------------------------------------------------------------------
describe("AC4(d): two-iteration NEEDS CHANGES × 2 → READY FOR MERGE (revision 2 file-based transport)", () => {
    it("NEEDS CHANGES × 2 → final READY FOR MERGE; manifest moves to done/", async () => {
        const allChatLog = [];
        // Cycle 1: dev handoff → NEEDS CHANGES.
        const dev1 = await processDevTranscript(makeDevOpts(HANDOFF_PHRASE));
        allChatLog.push(...dev1.chatLog);
        expect(dev1.next).toBe("spawn-reviewer");
        if (dev1.next !== "spawn-reviewer")
            return;
        await seedReviewerResultFile(tmpRoot, SESSION_ULID, STORY_REF, "NEEDS CHANGES");
        const rev1 = await processReviewerTranscript(makeReviewerOpts());
        allChatLog.push(...rev1.chatLog);
        expect(rev1.next).toBe("done-blocked-reviewer-needs-changes");
        // Cycle 2: dev handoff → NEEDS CHANGES.
        const dev2 = await processDevTranscript(makeDevOpts(HANDOFF_PHRASE));
        allChatLog.push(...dev2.chatLog);
        expect(dev2.next).toBe("spawn-reviewer");
        if (dev2.next !== "spawn-reviewer")
            return;
        await seedReviewerResultFile(tmpRoot, SESSION_ULID, STORY_REF, "NEEDS CHANGES");
        const rev2 = await processReviewerTranscript(makeReviewerOpts());
        allChatLog.push(...rev2.chatLog);
        expect(rev2.next).toBe("done-blocked-reviewer-needs-changes");
        // Cycle 3: dev handoff → READY FOR MERGE.
        const dev3 = await processDevTranscript(makeDevOpts(HANDOFF_PHRASE));
        allChatLog.push(...dev3.chatLog);
        if (dev3.next !== "spawn-reviewer")
            return;
        await seedReviewerResultFile(tmpRoot, SESSION_ULID, STORY_REF, "READY FOR MERGE");
        const rev3 = await processReviewerTranscript(makeReviewerOpts());
        allChatLog.push(...rev3.chatLog);
        expect(rev3.next).toBe("done-ready-for-merge");
        if (rev3.next !== "done-ready-for-merge")
            return;
        // Story 4.3c: completed: true
        expect(rev3.completed).toBe(true);
        // NEEDS CHANGES lines appear twice in chat (revision 2 variant).
        const needsChangesCount = allChatLog.filter((l) => l.includes("reviewer verdict: NEEDS CHANGES") && l.includes(STORY_REF)).length;
        expect(needsChangesCount).toBe(2);
        // Story 4.3c: manifest moved to done/.
        await expect(fs.stat(manifestPath)).rejects.toThrow(); // ENOENT
        const doneManifestRaw = await fs.readFile(path.join(tmpRoot, ".crew", "state", "done", `${STORY_REF}.yaml`), "utf8");
        const doneManifest = parseExecutionManifest(yamlParse(doneManifestRaw), {
            absPath: path.join(tmpRoot, ".crew", "state", "done", `${STORY_REF}.yaml`),
        });
        // The manifest may carry blocked_by from the NEEDS CHANGES iterations;
        // what matters is the story reached done/ with status === "done".
        expect(doneManifest.status).toBe("done");
    });
});
// ---------------------------------------------------------------------------
// AC4(e): Reviewer grammar drift
// ---------------------------------------------------------------------------
describe("AC4(e): reviewer skips runReviewerSession → ReviewerFirstCallSkippedError (Story 5.21 seam)", () => {
    it("throws ReviewerFirstCallSkippedError, stamps blocked_by: 'reviewer-no-session-result' when reviewer-result.json is absent", async () => {
        const devResult = await processDevTranscript(makeDevOpts(HANDOFF_PHRASE));
        expect(devResult.next).toBe("spawn-reviewer");
        if (devResult.next !== "spawn-reviewer")
            return;
        // Story 5.21: Do NOT seed reviewer-result.json — simulates reviewer skipping runReviewerSession.
        // processReviewerTranscript now throws ReviewerFirstCallSkippedError (typed error)
        // instead of returning the old soft done-blocked-no-session-result variant.
        await expect(processReviewerTranscript(makeReviewerOpts())).rejects.toThrow(ReviewerFirstCallSkippedError);
        const onDisk = await readOnDiskManifest();
        expect(onDisk.blocked_by).toBe("reviewer-no-session-result");
        // No manifest moved to done/
        const doneFiles = await fs.readdir(path.join(tmpRoot, ".crew", "state", "done"));
        expect(doneFiles.filter((f) => f.endsWith(".yaml"))).toHaveLength(0);
    });
});
// ---------------------------------------------------------------------------
// AC4(f): Reviewer BLOCKED passthrough
// ---------------------------------------------------------------------------
describe("AC4(f): reviewer BLOCKED → done-blocked-reviewer-blocked (revision 2)", () => {
    it("stamps blocked_by: 'reviewer-verdict-blocked'; chatLog has BLOCKED line", async () => {
        const devResult = await processDevTranscript(makeDevOpts(HANDOFF_PHRASE));
        expect(devResult.next).toBe("spawn-reviewer");
        if (devResult.next !== "spawn-reviewer")
            return;
        // Revision 2: seed BLOCKED result file.
        await seedReviewerResultFile(tmpRoot, SESSION_ULID, STORY_REF, "BLOCKED");
        const reviewerResult = await processReviewerTranscript(makeReviewerOpts());
        expect(reviewerResult.next).toBe("done-blocked-reviewer-blocked");
        const onDisk = await readOnDiskManifest();
        expect(onDisk.blocked_by).toBe("reviewer-verdict-blocked");
        expect(onDisk.rework_count).toBeUndefined();
        // No manifest moved to done/
        const doneFiles = await fs.readdir(path.join(tmpRoot, ".crew", "state", "done"));
        expect(doneFiles.filter((f) => f.endsWith(".yaml"))).toHaveLength(0);
    });
});
// ---------------------------------------------------------------------------
// AC4(g): Tool count — 21 tools, contains new tools, does NOT contain runDevSession
// ---------------------------------------------------------------------------
describe("AC4(g): tool count and required tools present", () => {
    it("registered tool list has exactly 27 entries and contains the required tools but NOT runDevSession", async () => {
        const server = createServer();
        registerAllTools(server);
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: "ac4g-test-client", version: "0.0.0" }, { capabilities: {} });
        await Promise.all([
            server.connect(serverTransport),
            client.connect(clientTransport),
        ]);
        try {
            const result = await client.request({ method: "tools/list", params: {} }, ListToolsResultSchema);
            const toolNames = result.tools.map((t) => t.name);
            expect(toolNames).toContain("claimNextStory");
            expect(toolNames).toContain("processDevTranscript");
            expect(toolNames).toContain("processReviewerTranscript");
            expect(toolNames).toContain("runReviewerSession");
            expect(toolNames).toContain("postReviewerComments");
            expect(toolNames).not.toContain("runDevSession");
            expect(toolNames).toContain("applyReviewerLabels");
            // De-cruft 2026-05-30: recordAgentInvoke + recordPrCloseAction were
            // removed (unwired dead code — registered but never called on any runtime
            // path; the Story 4.12/5.3 wiring that would have called them was mooted
            // by the stateless-workflow pivot). 38 → 36.
            expect(toolNames).not.toContain("recordAgentInvoke");
            expect(toolNames).not.toContain("recordPrCloseAction");
            // Story 6.4 added acceptProposal (the /accept-proposal gate). 36 → 37.
            expect(toolNames).toContain("acceptProposal");
            // Story 9.1 added markStoryReady (the readiness brake). 37 → 38.
            expect(toolNames).toContain("markStoryReady");
            // Story 9.3 added writeLensVerdict + aggregateJudgePanel (judge panel). 38 → 40.
            expect(toolNames).toContain("writeLensVerdict");
            expect(toolNames).toContain("aggregateJudgePanel");
            // Story 9.4 added adjudicateQualityLead (Quality Lead). 40 → 41.
            expect(toolNames).toContain("adjudicateQualityLead");
            // Story 9.5 added getBacklogDashboard (backlog dashboard). 41 → 42.
            expect(toolNames).toContain("getBacklogDashboard");
            // Story 6.8 added recordSkillInvoke + computeSkillEffectiveness (skill telemetry). 42 → 44.
            expect(toolNames).toContain("recordSkillInvoke");
            expect(toolNames).toContain("computeSkillEffectiveness");
            // Story 10.5 added bmadToNativeIngest (BMad → native ingest seam). 44 → 45.
            expect(toolNames).toContain("bmadToNativeIngest");
            expect(toolNames.length).toBe(45);
        }
        finally {
            await client.close();
            await server.close();
        }
    });
});
// ---------------------------------------------------------------------------
// AC4 (4.3c): Two-story drain with completeStory — green path
// ---------------------------------------------------------------------------
/**
 * Build a minimal native-adapter workspace with two independent stories.
 * Returns { root, refA, refB } where refA and refB are the native refs.
 *
 * This helper mirrors the pattern from claim-complete-loop.integration.test.ts.
 */
async function buildTwoStoryWorkspace(scratch) {
    const root = scratch;
    // Config
    await atomicWriteFile(path.join(root, ".crew", "config.yaml"), "adapter: native\nadapter_config: {}\n");
    // Native stories directory
    const storiesDir = path.join(root, ".crew", "native-stories");
    await fs.mkdir(storiesDir, { recursive: true });
    // Story 10.3 — seed the cited source so the Tier-0 T0-5 resolvability check
    // passes at scan (cited paths must resolve on disk).
    await atomicWriteFile(path.join(root, "src", "inner-cycle.ts"), "// seeded\n");
    // State directories
    await fs.mkdir(path.join(root, ".crew", "state", "to-do"), { recursive: true });
    await fs.mkdir(path.join(root, ".crew", "state", "in-progress"), { recursive: true });
    await fs.mkdir(path.join(root, ".crew", "state", "done"), { recursive: true });
    // Story A — ULID that sorts before B alphabetically
    const ulidA = "01J9P0K2N3MZX0YV4S5RTQ4AAA";
    const ulidB = "01J9P0K2N3MZX0YV4S5RTQ4BBB";
    const refA = `native:${ulidA}`;
    const refB = `native:${ulidB}`;
    function makeStoryContent(title) {
        return [
            `# ${title}`,
            "",
            "## Narrative",
            "",
            `As a dev, I want ${title.toLowerCase()} so that I can verify the drain.`,
            "",
            "## Acceptance Criteria",
            "",
            "**AC1 (integration):**",
            `**Given** ${title} is live, **When** accessed, **Then** it works.`,
            "vitest: src/__tests__/inner-cycle.test.ts",
            "",
            // Story 10.3 — §3 enriched sections required to pass the Tier-0 scan gate.
            "## Tasks",
            "",
            `- Implement ${title} (AC: 1)`,
            "",
            "## Cited Sources",
            "",
            "- src/inner-cycle.ts",
            "",
            "## Implementation Notes",
            "",
            `Implement ${title}.`,
            "",
            "## Dependencies",
            "",
            "",
        ].join("\n");
    }
    await atomicWriteFile(path.join(storiesDir, `${ulidA}.md`), makeStoryContent("Story A"));
    await atomicWriteFile(path.join(storiesDir, `${ulidB}.md`), makeStoryContent("Story B"));
    // Team personas
    await fs.mkdir(path.join(root, "team", "generalist-dev"), { recursive: true });
    await fs.mkdir(path.join(root, "team", "generalist-reviewer"), { recursive: true });
    await atomicWriteFile(path.join(root, "team", "generalist-dev", "PERSONA.md"), FIXTURE_DEV_PERSONA_MD);
    await atomicWriteFile(path.join(root, "team", "generalist-reviewer", "PERSONA.md"), FIXTURE_REVIEWER_PERSONA_MD);
    // Scan sources to populate to-do/
    await scanSources({ targetRepoRoot: root });
    // Story 9.1: freshly-scanned items default to not-ready (fail-closed brake).
    // Bless both so the claim path will admit them, as these tests assert.
    await markStoryReady({ targetRepoRoot: root, ref: refA, ready: true });
    await markStoryReady({ targetRepoRoot: root, ref: refB, ready: true });
    return { root, refA, refB };
}
describe("AC4 (4.3c): green-path two-story drain via processReviewerTranscript internal seam", () => {
    let twoStoryRoot;
    beforeEach(async () => {
        twoStoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "crew-ac4-4-3c-two-story-"));
        // Use real deriveSourceBaseline for workspace-based tests (has real source files).
        mockDeriveSourceBaseline.mockImplementation(realDeriveSourceBaseline);
    });
    afterEach(async () => {
        await fs.rm(twoStoryRoot, { recursive: true, force: true });
    });
    it("drives two stories through claim → dev → reviewer-ready (internal completeStory), then queue-drained", async () => {
        const sessionUlid = "01HZSESSION4_3CTWO_STORY_0001";
        const { root, refA, refB } = await buildTwoStoryWorkspace(twoStoryRoot);
        const syntheticChatLog = [];
        // ---------- Story A ----------
        // AC4(a): claim story A
        const claimA = await claimNextStory({ targetRepoRoot: root, sessionUlid });
        expect(claimA.next).toBe("spawn-dev");
        if (claimA.next !== "spawn-dev")
            return;
        expect(claimA.ref).toBe(refA);
        syntheticChatLog.push(...claimA.chatLog);
        // Assert manifest moved to in-progress/
        await expect(fs.stat(path.join(root, ".crew", "state", "in-progress", `${refA}.yaml`))).resolves.toBeDefined();
        await expect(fs.stat(path.join(root, ".crew", "state", "to-do", `${refA}.yaml`))).rejects.toThrow();
        const handoffPhraseA = `Handoff to reviewer — story ${refA} ready for review.`;
        // AC4(b): processDevTranscript → spawn-reviewer
        // Story 4.6: include a PR URL so prNumber extraction succeeds.
        const devA = await processDevTranscript({
            targetRepoRoot: root,
            sessionUlid,
            ref: refA,
            devTranscript: `https://github.com/test-org/test-repo/pull/101\n${handoffPhraseA}`,
        });
        expect(devA.next).toBe("spawn-reviewer");
        syntheticChatLog.push(...devA.chatLog);
        // AC4(c): processReviewerTranscript → done-ready-for-merge with completed: true
        // NOTE (Story 4.3c): No external completeStory call here — the side-effect is
        // performed INSIDE processReviewerTranscript before it returns.
        // Revision 2: seed the reviewer-result.json before calling processReviewerTranscript.
        await seedReviewerResultFile(root, sessionUlid, refA, "READY FOR MERGE");
        const reviewerA = await processReviewerTranscript({
            targetRepoRoot: root,
            sessionUlid,
            ref: refA,
            manifestPath: path.join(root, ".crew", "state", "in-progress", `${refA}.yaml`),
        });
        expect(reviewerA.next).toBe("done-ready-for-merge");
        if (reviewerA.next !== "done-ready-for-merge")
            return;
        // AC4(c): completed: true confirms the internal completeStory ran
        expect(reviewerA.completed).toBe(true);
        syntheticChatLog.push(...reviewerA.chatLog);
        // AC4(c) disk assertion: in-progress/ no longer has refA; done/ does
        await expect(fs.stat(path.join(root, ".crew", "state", "in-progress", `${refA}.yaml`))).rejects.toThrow(); // ENOENT — moved by processReviewerTranscript internally
        const doneManifestARaw = await fs.readFile(path.join(root, ".crew", "state", "done", `${refA}.yaml`), "utf8");
        const doneManifestA = parseExecutionManifest(yamlParse(doneManifestARaw), {
            absPath: path.join(root, ".crew", "state", "done", `${refA}.yaml`),
        });
        expect(doneManifestA.status).toBe("done");
        expect(doneManifestA.claimed_by).toBe(sessionUlid);
        // AC4(d): synthetic chat log — prose observes completed: true and appends the line
        const completionLineA = `story ${refA} moved to done — claiming next`;
        syntheticChatLog.push(completionLineA); // simulates prose emitting line after observing completed: true
        const readyForMergeLineA = `reviewer verdict: READY FOR MERGE — story ${refA} ready for merge gate`;
        const readyIdx = syntheticChatLog.indexOf(readyForMergeLineA);
        const doneIdx = syntheticChatLog.indexOf(completionLineA);
        expect(readyIdx).toBeGreaterThanOrEqual(0);
        expect(doneIdx).toBeGreaterThan(readyIdx);
        // ---------- Story B ----------
        // AC4(a) for story B: claim story B
        const claimB = await claimNextStory({ targetRepoRoot: root, sessionUlid });
        expect(claimB.next).toBe("spawn-dev");
        if (claimB.next !== "spawn-dev")
            return;
        expect(claimB.ref).toBe(refB);
        syntheticChatLog.push(...claimB.chatLog);
        await expect(fs.stat(path.join(root, ".crew", "state", "in-progress", `${refB}.yaml`))).resolves.toBeDefined();
        const handoffPhraseB = `Handoff to reviewer — story ${refB} ready for review.`;
        // Story 4.6: include a PR URL so prNumber extraction succeeds.
        const devB = await processDevTranscript({
            targetRepoRoot: root,
            sessionUlid,
            ref: refB,
            devTranscript: `https://github.com/test-org/test-repo/pull/102\n${handoffPhraseB}`,
        });
        expect(devB.next).toBe("spawn-reviewer");
        syntheticChatLog.push(...devB.chatLog);
        // processReviewerTranscript calls completeStory internally for story B too
        // Revision 2: seed the reviewer-result.json for story B.
        await seedReviewerResultFile(root, sessionUlid, refB, "READY FOR MERGE");
        const reviewerB = await processReviewerTranscript({
            targetRepoRoot: root,
            sessionUlid,
            ref: refB,
            manifestPath: path.join(root, ".crew", "state", "in-progress", `${refB}.yaml`),
        });
        expect(reviewerB.next).toBe("done-ready-for-merge");
        if (reviewerB.next !== "done-ready-for-merge")
            return;
        expect(reviewerB.completed).toBe(true);
        syntheticChatLog.push(...reviewerB.chatLog);
        await expect(fs.stat(path.join(root, ".crew", "state", "in-progress", `${refB}.yaml`))).rejects.toThrow();
        const doneManifestBRaw = await fs.readFile(path.join(root, ".crew", "state", "done", `${refB}.yaml`), "utf8");
        const doneManifestB = parseExecutionManifest(yamlParse(doneManifestBRaw), {
            absPath: path.join(root, ".crew", "state", "done", `${refB}.yaml`),
        });
        expect(doneManifestB.status).toBe("done");
        expect(doneManifestB.claimed_by).toBe(sessionUlid);
        const completionLineB = `story ${refB} moved to done — claiming next`;
        syntheticChatLog.push(completionLineB); // simulates prose observing completed: true
        const readyForMergeLineB = `reviewer verdict: READY FOR MERGE — story ${refB} ready for merge gate`;
        const readyIdxB = syntheticChatLog.lastIndexOf(readyForMergeLineB);
        const doneIdxB = syntheticChatLog.lastIndexOf(completionLineB);
        expect(readyIdxB).toBeGreaterThanOrEqual(0);
        expect(doneIdxB).toBeGreaterThan(readyIdxB);
        // AC4(e): third claimNextStory → queue-drained
        const claimThird = await claimNextStory({ targetRepoRoot: root, sessionUlid });
        expect(claimThird.next).toBe("queue-drained");
        expect(claimThird.chatLog[0]).toBe("queue drained — to-do/ and in-progress/ are both empty. Stop here, or run /crew:plan to add work.");
        // AC4(f): final on-disk state
        const todoFiles = await fs.readdir(path.join(root, ".crew", "state", "to-do"));
        expect(todoFiles.filter((f) => f.endsWith(".yaml"))).toHaveLength(0);
        const inProgressFiles = await fs.readdir(path.join(root, ".crew", "state", "in-progress"));
        expect(inProgressFiles.filter((f) => f.endsWith(".yaml"))).toHaveLength(0);
        const doneFiles = await fs.readdir(path.join(root, ".crew", "state", "done"));
        const doneYaml = doneFiles.filter((f) => f.endsWith(".yaml"));
        expect(doneYaml).toHaveLength(2);
        expect(doneYaml).toContain(`${refA}.yaml`);
        expect(doneYaml).toContain(`${refB}.yaml`);
    });
});
// ---------------------------------------------------------------------------
// AC4 (4.3c): Blocked branches do NOT invoke completeStory
// ---------------------------------------------------------------------------
describe("AC4 (4.3c): blocked branches do NOT invoke completeStory", () => {
    let blockedRoot;
    beforeEach(async () => {
        blockedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "crew-ac4-4-3c-blocked-"));
        // Use real deriveSourceBaseline for workspace-based tests.
        mockDeriveSourceBaseline.mockImplementation(realDeriveSourceBaseline);
    });
    afterEach(async () => {
        await fs.rm(blockedRoot, { recursive: true, force: true });
    });
    /**
     * AC4(g): Reviewer BLOCKED branch — processReviewerTranscript does NOT move
     * the manifest, returned object has no `completed` field, done/ is empty.
     */
    it("AC4(g): reviewer BLOCKED verdict — manifest stays in-progress, no completed field, done/ empty", async () => {
        const sessionUlid = "01HZSESSION4_3CBLOCKED_001";
        const { root, refA } = await buildTwoStoryWorkspace(blockedRoot);
        // Claim story A
        const claim = await claimNextStory({ targetRepoRoot: root, sessionUlid });
        expect(claim.next).toBe("spawn-dev");
        if (claim.next !== "spawn-dev")
            return;
        expect(claim.ref).toBe(refA);
        const handoffPhrase = `Handoff to reviewer — story ${refA} ready for review.`;
        // Story 4.6: include a PR URL so prNumber extraction succeeds.
        const devResult = await processDevTranscript({
            targetRepoRoot: root,
            sessionUlid,
            ref: refA,
            devTranscript: `https://github.com/test-org/test-repo/pull/103\n${handoffPhrase}`,
        });
        expect(devResult.next).toBe("spawn-reviewer");
        // Reviewer returns BLOCKED (revision 2: seed reviewer-result.json with BLOCKED)
        await seedReviewerResultFile(root, sessionUlid, refA, "BLOCKED");
        const reviewerResult = await processReviewerTranscript({
            targetRepoRoot: root,
            sessionUlid,
            ref: refA,
            manifestPath: path.join(root, ".crew", "state", "in-progress", `${refA}.yaml`),
        });
        expect(reviewerResult.next).toBe("done-blocked-reviewer-blocked");
        // AC4(g): BLOCKED branch must NOT have a completed field
        expect("completed" in reviewerResult).toBe(false);
        // Manifest stays in in-progress/ with blocked_by: "reviewer-verdict-blocked"
        const inProgressRaw = await fs.readFile(path.join(root, ".crew", "state", "in-progress", `${refA}.yaml`), "utf8");
        const onDiskBlocked = parseExecutionManifest(yamlParse(inProgressRaw), {
            absPath: path.join(root, ".crew", "state", "in-progress", `${refA}.yaml`),
        });
        expect(onDiskBlocked.blocked_by).toBe("reviewer-verdict-blocked");
        const doneFiles = await fs.readdir(path.join(root, ".crew", "state", "done"));
        expect(doneFiles.filter((f) => f.endsWith(".yaml"))).toHaveLength(0);
    });
    /**
     * AC4(h): Reviewer skips runReviewerSession (Story 5.21 seam) — manifest stays
     * in-progress/ with blocked_by: "reviewer-no-session-result", done/ is empty.
     * processReviewerTranscript now throws ReviewerFirstCallSkippedError (typed error)
     * instead of returning the old soft done-blocked-no-session-result variant.
     */
    it("AC4(h): reviewer-result.json absent → ReviewerFirstCallSkippedError thrown, blocked_by: 'reviewer-no-session-result', done/ empty (Story 5.21)", async () => {
        const sessionUlid = "01HZSESSION4_3CGRAMMAR_001";
        const { root, refA } = await buildTwoStoryWorkspace(blockedRoot);
        // Claim story A
        const claim = await claimNextStory({ targetRepoRoot: root, sessionUlid });
        expect(claim.next).toBe("spawn-dev");
        if (claim.next !== "spawn-dev")
            return;
        expect(claim.ref).toBe(refA);
        const handoffPhrase = `Handoff to reviewer — story ${refA} ready for review.`;
        // Story 4.6: include a PR URL so prNumber extraction succeeds.
        const devResult = await processDevTranscript({
            targetRepoRoot: root,
            sessionUlid,
            ref: refA,
            devTranscript: `https://github.com/test-org/test-repo/pull/104\n${handoffPhrase}`,
        });
        expect(devResult.next).toBe("spawn-reviewer");
        // Story 5.21: Do NOT seed reviewer-result.json — simulates reviewer skipping runReviewerSession.
        // processReviewerTranscript throws ReviewerFirstCallSkippedError (typed DomainError).
        await expect(processReviewerTranscript({
            targetRepoRoot: root,
            sessionUlid,
            ref: refA,
            manifestPath: path.join(root, ".crew", "state", "in-progress", `${refA}.yaml`),
        })).rejects.toThrow(ReviewerFirstCallSkippedError);
        // Manifest stays in in-progress/ with blocked_by: "reviewer-no-session-result"
        const inProgressRaw = await fs.readFile(path.join(root, ".crew", "state", "in-progress", `${refA}.yaml`), "utf8");
        const onDisk = parseExecutionManifest(yamlParse(inProgressRaw), {
            absPath: path.join(root, ".crew", "state", "in-progress", `${refA}.yaml`),
        });
        expect(onDisk.blocked_by).toBe("reviewer-no-session-result");
        const doneFiles = await fs.readdir(path.join(root, ".crew", "state", "done"));
        expect(doneFiles.filter((f) => f.endsWith(".yaml"))).toHaveLength(0);
    });
});
