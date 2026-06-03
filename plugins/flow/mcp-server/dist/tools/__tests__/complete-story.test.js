/**
 * Unit tests for `completeStory` — Story 4.1 Task 7.2.
 *
 * Covers AC3, AC4, AC5:
 *   (a) Happy complete: matching claimed_by → manifest moves to done/ with
 *       status: "done" and claimed_by preserved.
 *   (b) Wrong claimant: mismatched ULID → WrongClaimantError, manifest unchanged.
 *   (c) Hand-edit refusal: in-progress/ manifest hand-edited → InProgressHandEditError.
 *   (d) Absent claimed_by: → WrongClaimantError with actualSessionUlid: "<unset>".
 *
 * Approach:
 * - Use a minimal native-adapter workspace in a tmpdir (real filesystem ops).
 * - Mock `deriveSourceBaseline` to control the hand-edit baseline.
 * - No `node:fs` mocking — real renames against tmpdir per testing requirements.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { InProgressHandEditError, ManifestNotFoundError, WrongClaimantError, } from "../../errors.js";
import { parseExecutionManifest } from "../../schemas/execution-manifest.js";
import { completeStory } from "../complete-story.js";
import { writeInProgressSnapshot, } from "../../state/manifest-state-machine.js";
// ---------------------------------------------------------------------------
// Module mock for deriveSourceBaseline (Story 5.29: no longer used by the guard
// but retained as an inert default for backwards-compatibility with any future
// caller).
// ---------------------------------------------------------------------------
vi.mock("../../state/derive-source-baseline.js", () => ({
    deriveSourceBaseline: vi.fn(),
}));
import { deriveSourceBaseline } from "../../state/derive-source-baseline.js";
const mockDeriveSourceBaseline = vi.mocked(deriveSourceBaseline);
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const REF = "native:01HZCOMPLETE000000000001";
const SESSION_A = "01HZSESSA000000000000001";
const SESSION_B = "01HZSESSB000000000000002";
const SOURCE_HASH = "b".repeat(64);
const SOURCE_FIELDS = {
    title: "Complete test story",
    narrative: "As a dev, I want to test completions.",
    acceptance_criteria: [
        {
            text: "Given the complete tool, when called with matching ULID, then it works.",
            kind: "integration",
        },
    ],
    implementation_notes: undefined,
    depends_on: [],
    withdrawn: false,
};
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeInProgressManifestYaml(ref, claimedBy, opts = {}) {
    const manifest = {
        ref,
        status: "in-progress",
        adapter: "native",
        source_path: `.flow/native-stories/${ref.replace("native:", "")}.md`,
        source_hash: opts.source_hash ?? SOURCE_HASH,
        depends_on: [],
        acceptance_criteria: [
            {
                text: "Given the complete tool, when called with matching ULID, then it works.",
                kind: "integration",
            },
        ],
        title: opts.title ?? "Complete test story",
        narrative: "As a dev, I want to test completions.",
        withdrawn: false,
    };
    if (claimedBy !== undefined) {
        manifest["claimed_by"] = claimedBy;
    }
    return yamlStringify(manifest, { lineWidth: 0 });
}
async function seedInProgressManifest(stateRoot, ref, claimedBy, opts, sidecarOpts) {
    const dir = path.join(stateRoot, "in-progress");
    await fs.mkdir(dir, { recursive: true });
    const absPath = path.join(dir, `${ref}.yaml`);
    await atomicWriteFile(absPath, makeInProgressManifestYaml(ref, claimedBy, opts));
    // Story 5.29: seed the claim-time sidecar so detectInProgressHandEdit has a
    // baseline to compare against. The sidecar mirrors what claimStory would
    // write — the operator-editable fields + source_hash at claim time.
    if (!sidecarOpts?.skip) {
        const raw = await fs.readFile(absPath, "utf8");
        const parsed = yamlParse(raw);
        const manifest = parseExecutionManifest(parsed, { absPath });
        const targetRepoRoot = path.dirname(path.dirname(stateRoot)); // strip .flow/state
        await writeInProgressSnapshot({ targetRepoRoot, ref, manifest });
    }
    return absPath;
}
async function buildWorkspaceRoot(scratch) {
    const root = path.join(scratch, "repo");
    await fs.mkdir(root, { recursive: true });
    await atomicWriteFile(path.join(root, ".flow", "config.yaml"), "adapter: native\nadapter_config: {}\n");
    return root;
}
// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
let scratch;
let root;
let stateRoot;
beforeEach(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "flow-complete-story-"));
    root = await buildWorkspaceRoot(scratch);
    stateRoot = path.join(root, ".flow", "state");
    // Default: baseline always clean — no hand-edit detected
    mockDeriveSourceBaseline.mockResolvedValue({
        sourceHash: SOURCE_HASH,
        sourceFields: SOURCE_FIELDS,
    });
});
afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(scratch, { recursive: true, force: true });
});
// ---------------------------------------------------------------------------
// (a) Happy complete
// ---------------------------------------------------------------------------
describe("completeStory (a) — happy complete: matching claimed_by", () => {
    it("moves manifest to done/ with status:done and claimed_by preserved", async () => {
        await seedInProgressManifest(stateRoot, REF, SESSION_A);
        const result = await completeStory({
            targetRepoRoot: root,
            ref: REF,
            sessionUlid: SESSION_A,
        });
        // Return value is correct.
        expect(result.ref).toBe(REF);
        expect(result.absPath).toBe(path.join(stateRoot, "done", `${REF}.yaml`));
        // done/ manifest exists with correct fields.
        const raw = await fs.readFile(result.absPath, "utf8");
        const parsed = yamlParse(raw);
        expect(parsed["status"]).toBe("done");
        expect(parsed["claimed_by"]).toBe(SESSION_A);
        // in-progress/ manifest no longer exists.
        await expect(fs.stat(path.join(stateRoot, "in-progress", `${REF}.yaml`))).rejects.toMatchObject({ code: "ENOENT" });
    });
    it("round-trips through parseExecutionManifest with widened schema", async () => {
        await seedInProgressManifest(stateRoot, REF, SESSION_A);
        const result = await completeStory({
            targetRepoRoot: root,
            ref: REF,
            sessionUlid: SESSION_A,
        });
        const raw = await fs.readFile(result.absPath, "utf8");
        const parsed = yamlParse(raw);
        // Should not throw — the widened schema accepts done + claimed_by.
        const manifest = parseExecutionManifest(parsed, { absPath: result.absPath });
        expect(manifest.status).toBe("done");
        expect(manifest.claimed_by).toBe(SESSION_A);
    });
});
// ---------------------------------------------------------------------------
// (b) Wrong claimant
// ---------------------------------------------------------------------------
describe("completeStory (b) — wrong claimant: mismatched ULID", () => {
    it("throws WrongClaimantError carrying both ULIDs", async () => {
        const inProgressPath = await seedInProgressManifest(stateRoot, REF, SESSION_A);
        const err = await completeStory({
            targetRepoRoot: root,
            ref: REF,
            sessionUlid: SESSION_B,
        }).catch((e) => e);
        expect(err).toBeInstanceOf(WrongClaimantError);
        const typed = err;
        expect(typed.ref).toBe(REF);
        expect(typed.expectedSessionUlid).toBe(SESSION_B);
        expect(typed.actualSessionUlid).toBe(SESSION_A);
        expect(typed.message).toContain(SESSION_A);
        expect(typed.message).toContain(SESSION_B);
        // Manifest stays in in-progress/, unchanged.
        await expect(fs.stat(inProgressPath)).resolves.toBeTruthy();
        // done/ does not exist.
        await expect(fs.stat(path.join(stateRoot, "done", `${REF}.yaml`))).rejects.toMatchObject({ code: "ENOENT" });
    });
});
// ---------------------------------------------------------------------------
// (c) Hand-edit refusal
// ---------------------------------------------------------------------------
describe("completeStory (c) — hand-edit refusal", () => {
    it("throws InProgressHandEditError when in-progress/ narrative has been hand-edited", async () => {
        const inProgressPath = await seedInProgressManifest(stateRoot, REF, SESSION_A);
        // Simulate an operator hand-edit: change narrative on disk.
        // The mock deriveSourceBaseline returns SOURCE_FIELDS with original narrative,
        // but we change the on-disk narrative.
        const raw = await fs.readFile(inProgressPath, "utf8");
        const obj = yamlParse(raw);
        obj["narrative"] = "HAND-EDITED NARRATIVE";
        await atomicWriteFile(inProgressPath, yamlStringify(obj, { lineWidth: 0 }));
        const err = await completeStory({
            targetRepoRoot: root,
            ref: REF,
            sessionUlid: SESSION_A,
        }).catch((e) => e);
        expect(err).toBeInstanceOf(InProgressHandEditError);
        const typed = err;
        expect(typed.changedFields).toContain("narrative");
        expect(typed.ref).toBe(REF);
        // in-progress/ manifest still exists — no move.
        await expect(fs.stat(inProgressPath)).resolves.toBeTruthy();
    });
});
// ---------------------------------------------------------------------------
// (d) Absent claimed_by
// ---------------------------------------------------------------------------
describe("completeStory (d) — absent claimed_by treated as mismatch", () => {
    it("throws WrongClaimantError with actualSessionUlid: '<unset>'", async () => {
        // Seed without claimed_by
        await seedInProgressManifest(stateRoot, REF, undefined);
        const err = await completeStory({
            targetRepoRoot: root,
            ref: REF,
            sessionUlid: SESSION_A,
        }).catch((e) => e);
        expect(err).toBeInstanceOf(WrongClaimantError);
        const typed = err;
        expect(typed.actualSessionUlid).toBe("<unset>");
        expect(typed.expectedSessionUlid).toBe(SESSION_A);
    });
});
// ---------------------------------------------------------------------------
// ManifestNotFoundError when in-progress/ ref does not exist
// ---------------------------------------------------------------------------
describe("completeStory — ManifestNotFoundError for missing in-progress/ ref", () => {
    it("throws ManifestNotFoundError when the manifest does not exist in in-progress/", async () => {
        // deriveSourceBaseline will throw ManifestNotFoundError from detectInProgressHandEdit
        // when the manifest doesn't exist. This propagates correctly.
        const err = await completeStory({
            targetRepoRoot: root,
            ref: REF,
            sessionUlid: SESSION_A,
        }).catch((e) => e);
        expect(err).toBeInstanceOf(ManifestNotFoundError);
        const typed = err;
        expect(typed.ref).toBe(REF);
        expect(typed.fromState).toBe("in-progress");
    });
});
