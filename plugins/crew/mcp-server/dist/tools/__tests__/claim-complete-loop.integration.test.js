/**
 * Integration + chaos tests for the claim/complete loop — Story 4.1 Task 8.
 *
 * Covers AC6:
 *   (a) Happy claim (deps satisfied → in-progress/ with claimed_by stamped).
 *   (b) Deps-not-ready claim (dep missing from done/ → DependenciesNotReadyError,
 *       manifest unchanged in to-do/).
 *   (c) Happy complete (matching claimed_by → moved to done/).
 *   (d) Wrong-claimant complete (mismatched ULID → WrongClaimantError,
 *       manifest unchanged in in-progress/).
 *   (e) Hand-edit refusal on complete-story (operator hand-edited in-progress/<ref>.yaml
 *       → InProgressHandEditError thrown, manifest unchanged).
 *
 * Plus the chaos test:
 *   1,000 concurrent claimStory calls against the same to-do/ ref → exactly one
 *   winner, 999 ManifestNotFoundError failures, ref exists in exactly one state
 *   directory after the run.
 *
 * Uses a real native-adapter workspace in a tmpdir. Source stories are
 * constructed with proper Given/When/Then formatting so the native adapter
 * parses them correctly.
 *
 * @chaos — the chaos test is tagged; it runs in the default suite (1,000
 * concurrent claims is fast on a single filesystem with rename(2) atomicity).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { DependenciesNotReadyError, InProgressHandEditError, ManifestNotFoundError, WrongClaimantError, } from "../../errors.js";
import { scanSources } from "../scan-sources.js";
import { claimStory } from "../claim-story.js";
import { completeStory } from "../complete-story.js";
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ULID_A = "01HZ0000000000000000000001";
const ULID_B = "01HZ0000000000000000000002";
const REF_A = `native:${ULID_A}`;
const REF_B = `native:${ULID_B}`;
const SESSION_ULID = "01HZSESSION000000000000001";
// ---------------------------------------------------------------------------
// Native story content helpers
// ---------------------------------------------------------------------------
/**
 * Build a properly-formatted native story with Given/When/Then ACs.
 * The title is the H1; the ULID is in the filename.
 */
function makeStoryContent(title, depRefs) {
    const depsSection = depRefs.length > 0 ? depRefs.map((d) => `- ${d}`).join("\n") : "";
    // Story 5.13: include a `Depends on: <refs>` prose line so the deps-drift gate
    // finds prose and manifest in agreement (no false-positive blocking).
    const proseDepsLine = depRefs.length > 0 ? `\nDepends on: ${depRefs.join(", ")}\n` : "";
    return ([
        `# ${title}`,
        "",
        "## Narrative",
        "",
        `As a user, I want ${title.toLowerCase()} so that I can verify the loop.`,
    ].join("\n") +
        proseDepsLine +
        [
            "",
            "## Acceptance Criteria",
            "",
            "**AC1 (integration):**",
            `**Given** ${title} is live, **When** a user accesses it, **Then** it works correctly.`,
            "vitest: src/__tests__/loop.test.ts",
            "",
            "## Implementation Notes",
            "",
            `Implement ${title}.`,
            "",
            "## Dependencies",
            "",
            depsSection,
        ].join("\n"));
}
function hashContent(content) {
    return createHash("sha256").update(content).digest("hex");
}
// ---------------------------------------------------------------------------
// Workspace builder
// ---------------------------------------------------------------------------
/**
 * Build a minimal native-adapter workspace with story A (no deps) and
 * story B (depends_on: [REF_A]). Returns the root path.
 */
async function buildIntegrationWorkspace(scratch) {
    const root = path.join(scratch, "repo");
    // Config
    await atomicWriteFile(path.join(root, ".crew", "config.yaml"), "adapter: native\nadapter_config: {}\n");
    // Native stories directory
    const storiesDir = path.join(root, ".crew", "native-stories");
    await fs.mkdir(storiesDir, { recursive: true });
    // Story A — no deps
    const contentA = makeStoryContent("Story A", []);
    await atomicWriteFile(path.join(storiesDir, `${ULID_A}.md`), contentA);
    // Story B — depends on A
    const contentB = makeStoryContent("Story B", [REF_A]);
    await atomicWriteFile(path.join(storiesDir, `${ULID_B}.md`), contentB);
    // Create state directories (scan-sources creates them too, but pre-create for clarity)
    await fs.mkdir(path.join(root, ".crew", "state", "to-do"), { recursive: true });
    return root;
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function stateOf(root, ref) {
    const stateRoot = path.join(root, ".crew", "state");
    for (const stateName of ["to-do", "in-progress", "blocked", "done"]) {
        try {
            await fs.stat(path.join(stateRoot, stateName, `${ref}.yaml`));
            return stateName;
        }
        catch {
            // ENOENT — not in this state
        }
    }
    return null;
}
async function countFilesInStates(root, ref) {
    const stateRoot = path.join(root, ".crew", "state");
    const states = [];
    for (const stateName of ["to-do", "in-progress", "blocked", "done"]) {
        try {
            await fs.stat(path.join(stateRoot, stateName, `${ref}.yaml`));
            states.push(stateName);
        }
        catch {
            // ENOENT
        }
    }
    return { count: states.length, states };
}
// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
let scratch;
beforeEach(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "crew-claim-complete-loop-"));
});
afterEach(async () => {
    await fs.rm(scratch, { recursive: true, force: true });
});
// ---------------------------------------------------------------------------
// AC6 — end-to-end integration: A depends-on nothing, B depends-on A
// ---------------------------------------------------------------------------
describe("claim/complete loop (AC6) — full A→B pipeline", () => {
    it("runs the complete 5-step loop with correct filesystem state at each step", async () => {
        const root = await buildIntegrationWorkspace(scratch);
        // Step 1: scanSources → both manifests in to-do/.
        await scanSources({ targetRepoRoot: root });
        expect(await stateOf(root, REF_A)).toBe("to-do");
        expect(await stateOf(root, REF_B)).toBe("to-do");
        // Step 2: claimStory(A) → A moves to in-progress/.
        const claimA = await claimStory({
            targetRepoRoot: root,
            ref: REF_A,
            sessionUlid: SESSION_ULID,
        });
        expect(claimA.ref).toBe(REF_A);
        expect(await stateOf(root, REF_A)).toBe("in-progress");
        expect(await stateOf(root, REF_B)).toBe("to-do");
        // Verify claimed_by is stamped.
        const rawA = await fs.readFile(claimA.absPath, "utf8");
        const parsedA = yamlParse(rawA);
        expect(parsedA["claimed_by"]).toBe(SESSION_ULID);
        expect(parsedA["status"]).toBe("in-progress");
        // Step 3: claimStory(B) while A is not yet in done/ → DependenciesNotReadyError.
        const claimBErr = await claimStory({
            targetRepoRoot: root,
            ref: REF_B,
            sessionUlid: SESSION_ULID,
        }).catch((e) => e);
        expect(claimBErr).toBeInstanceOf(DependenciesNotReadyError);
        const typedErr = claimBErr;
        expect(typedErr.missingDeps).toContain(REF_A);
        // B stays in to-do/.
        expect(await stateOf(root, REF_B)).toBe("to-do");
        // Step 4: completeStory(A) → A moves to done/.
        const completeA = await completeStory({
            targetRepoRoot: root,
            ref: REF_A,
            sessionUlid: SESSION_ULID,
        });
        expect(completeA.ref).toBe(REF_A);
        expect(await stateOf(root, REF_A)).toBe("done");
        // Verify done manifest preserves claimed_by.
        const rawADone = await fs.readFile(completeA.absPath, "utf8");
        const parsedADone = yamlParse(rawADone);
        expect(parsedADone["status"]).toBe("done");
        expect(parsedADone["claimed_by"]).toBe(SESSION_ULID);
        // Step 5: claimStory(B) — A is now in done/ → success.
        const claimB = await claimStory({
            targetRepoRoot: root,
            ref: REF_B,
            sessionUlid: SESSION_ULID,
        });
        expect(claimB.ref).toBe(REF_B);
        expect(await stateOf(root, REF_B)).toBe("in-progress");
        // Step 6: completeStory(B) → B moves to done/.
        const completeB = await completeStory({
            targetRepoRoot: root,
            ref: REF_B,
            sessionUlid: SESSION_ULID,
        });
        expect(completeB.ref).toBe(REF_B);
        expect(await stateOf(root, REF_B)).toBe("done");
    });
});
// ---------------------------------------------------------------------------
// AC6 (d) — wrong-claimant complete
// ---------------------------------------------------------------------------
describe("claim/complete loop (AC6d) — wrong-claimant complete", () => {
    it("refuses completeStory when session ULID does not match claimed_by", async () => {
        const root = await buildIntegrationWorkspace(scratch);
        await scanSources({ targetRepoRoot: root });
        const OTHER_SESSION = "01HZOTHERSESSION000000001";
        // Claim A with SESSION_ULID.
        await claimStory({
            targetRepoRoot: root,
            ref: REF_A,
            sessionUlid: SESSION_ULID,
        });
        // Try to complete with a DIFFERENT session ULID.
        const err = await completeStory({
            targetRepoRoot: root,
            ref: REF_A,
            sessionUlid: OTHER_SESSION,
        }).catch((e) => e);
        expect(err).toBeInstanceOf(WrongClaimantError);
        const typed = err;
        expect(typed.ref).toBe(REF_A);
        expect(typed.expectedSessionUlid).toBe(OTHER_SESSION);
        expect(typed.actualSessionUlid).toBe(SESSION_ULID);
        // A stays in in-progress/.
        expect(await stateOf(root, REF_A)).toBe("in-progress");
    });
});
// ---------------------------------------------------------------------------
// AC6 (e) — hand-edit refusal on completeStory
// ---------------------------------------------------------------------------
describe("claim/complete loop (AC6e) — hand-edit refusal on completeStory", () => {
    it("throws InProgressHandEditError when in-progress/ manifest has been hand-edited", async () => {
        const root = await buildIntegrationWorkspace(scratch);
        await scanSources({ targetRepoRoot: root });
        // Claim A.
        const claimResult = await claimStory({
            targetRepoRoot: root,
            ref: REF_A,
            sessionUlid: SESSION_ULID,
        });
        // Operator hand-edits the in-progress/ manifest (changes title).
        const raw = await fs.readFile(claimResult.absPath, "utf8");
        const obj = yamlParse(raw);
        obj["title"] = "HAND-EDITED TITLE BY OPERATOR";
        await atomicWriteFile(claimResult.absPath, yamlStringify(obj, { lineWidth: 0 }));
        // completeStory must refuse.
        const err = await completeStory({
            targetRepoRoot: root,
            ref: REF_A,
            sessionUlid: SESSION_ULID,
        }).catch((e) => e);
        expect(err).toBeInstanceOf(InProgressHandEditError);
        const typed = err;
        expect(typed.changedFields).toContain("title");
        expect(typed.ref).toBe(REF_A);
        // A stays in in-progress/ — no move.
        expect(await stateOf(root, REF_A)).toBe("in-progress");
    });
});
// ---------------------------------------------------------------------------
// Chaos test — 1,000 concurrent claimStory calls (AC6 chaos)
// ---------------------------------------------------------------------------
describe("claim/complete loop (chaos) — 1,000 concurrent claims @chaos", () => {
    it("produces exactly one winner and 999 typed failures; ref exists in exactly one state dir", async () => {
        const root = await buildIntegrationWorkspace(scratch);
        await scanSources({ targetRepoRoot: root });
        // Verify A is in to-do/ before the chaos run.
        expect(await stateOf(root, REF_A)).toBe("to-do");
        // Spawn 1,000 concurrent claimStory calls against the same ref.
        const CONCURRENCY = 1000;
        const results = await Promise.allSettled(Array.from({ length: CONCURRENCY }, () => claimStory({
            targetRepoRoot: root,
            ref: REF_A,
            sessionUlid: SESSION_ULID,
        })));
        // Exactly one must have resolved (the rename winner).
        const successes = results.filter((r) => r.status === "fulfilled");
        const failures = results.filter((r) => r.status === "rejected");
        expect(successes).toHaveLength(1);
        expect(failures).toHaveLength(CONCURRENCY - 1);
        // All failures must be ManifestNotFoundError (losers — rename ENOENT).
        for (const failure of failures) {
            expect(failure.reason).toBeInstanceOf(ManifestNotFoundError);
        }
        // The ref must exist in exactly one state directory after the run.
        const { count, states } = await countFilesInStates(root, REF_A);
        expect(count).toBe(1);
        // The winner moved it to in-progress/ (not done/).
        expect(states[0]).toBe("in-progress");
    }, 
    // Extended timeout for 1,000 concurrent renames
    30_000);
});
