/**
 * Unit tests for `claimStory` — Story 4.1 Task 7.1.
 *
 * Covers AC1, AC2, AC5 and the defensive parse (Task 7.1):
 *   (a) Happy claim: deps satisfied → manifest moves to in-progress/ with
 *       claimed_by stamped, to-do/ entry gone.
 *   (b) Deps-not-ready: one dep missing from done/ → DependenciesNotReadyError,
 *       manifest stays in to-do/ unchanged.
 *   (c) Hand-edit refusal on re-entry: in-progress/ manifest hand-edited →
 *       InProgressHandEditError, no move.
 *   (d) claimed_by defensive parse: rewritten manifest round-trips through
 *       parseExecutionManifest cleanly with the widened schema.
 *
 * Approach:
 * - Use a minimal native-adapter workspace in a tmpdir (real filesystem ops).
 * - Mock `deriveSourceBaseline` where needed to control the hand-edit baseline.
 * - No `node:fs` mocking — real renames against tmpdir per testing requirements.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { DependenciesNotReadyError, InProgressHandEditError, ManifestNotFoundError, } from "../../errors.js";
import { parseExecutionManifest } from "../../schemas/execution-manifest.js";
import { claimStory } from "../claim-story.js";
import { writeInProgressSnapshot, } from "../../state/manifest-state-machine.js";
// ---------------------------------------------------------------------------
// Module mock for deriveSourceBaseline
// ---------------------------------------------------------------------------
// We mock deriveSourceBaseline so we control the baseline without needing
// a real source story file tree.
vi.mock("../../state/derive-source-baseline.js", () => ({
    deriveSourceBaseline: vi.fn(),
}));
import { deriveSourceBaseline } from "../../state/derive-source-baseline.js";
const mockDeriveSourceBaseline = vi.mocked(deriveSourceBaseline);
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const REF = "native:01HZCLAIM0000000000000001";
const DEP_A = "native:01HZDEP00000000000000000A";
const DEP_B = "native:01HZDEP00000000000000000B";
const SESSION_ULID = "01HZSESSION00000000000001";
const SOURCE_HASH = "a".repeat(64);
const SOURCE_FIELDS = {
    title: "Claim test story",
    narrative: "As a dev, I want to test claims.",
    acceptance_criteria: [
        {
            text: "Given the claim tool, when called with valid deps, then it works.",
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
function makeManifestYaml(ref, opts = {}) {
    const manifest = {
        ref,
        status: opts.status ?? "to-do",
        adapter: "native",
        source_path: `.flow/native-stories/${ref.replace("native:", "")}.md`,
        source_hash: opts.source_hash ?? SOURCE_HASH,
        depends_on: opts.depends_on ?? [],
        acceptance_criteria: [
            {
                text: "Given the claim tool, when called with valid deps, then it works.",
                kind: "integration",
            },
        ],
        title: "Claim test story",
        narrative: "As a dev, I want to test claims.",
        withdrawn: false,
    };
    if (opts.claimed_by !== undefined) {
        manifest["claimed_by"] = opts.claimed_by;
    }
    return yamlStringify(manifest, { lineWidth: 0 });
}
async function seedManifest(stateRoot, stateName, ref, opts) {
    const dir = path.join(stateRoot, stateName);
    await fs.mkdir(dir, { recursive: true });
    const absPath = path.join(dir, `${ref}.yaml`);
    await atomicWriteFile(absPath, makeManifestYaml(ref, opts));
    return absPath;
}
async function seedDoneManifest(stateRoot, ref) {
    const dir = path.join(stateRoot, "done");
    await fs.mkdir(dir, { recursive: true });
    const absPath = path.join(dir, `${ref}.yaml`);
    // Simple done manifest — just needs to exist for the dep check
    const manifest = {
        ref,
        status: "done",
        adapter: "native",
        source_path: `.flow/native-stories/${ref.replace("native:", "")}.md`,
        source_hash: SOURCE_HASH,
        depends_on: [],
        acceptance_criteria: [
            { text: "AC for dep.", kind: "integration" },
        ],
        title: "Dep story",
        narrative: "Dep narrative.",
        withdrawn: false,
    };
    await atomicWriteFile(absPath, yamlStringify(manifest, { lineWidth: 0 }));
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
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "flow-claim-story-"));
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
// (a) Happy claim
// ---------------------------------------------------------------------------
describe("claimStory (a) — happy claim: deps satisfied", () => {
    it("moves manifest to in-progress/ and stamps claimed_by", async () => {
        // Seed the to-do/ manifest with no deps.
        await seedManifest(stateRoot, "to-do", REF);
        const result = await claimStory({
            targetRepoRoot: root,
            ref: REF,
            sessionUlid: SESSION_ULID,
        });
        // Return value is correct.
        expect(result.ref).toBe(REF);
        expect(result.absPath).toBe(path.join(stateRoot, "in-progress", `${REF}.yaml`));
        // in-progress/ manifest exists with correct fields.
        const raw = await fs.readFile(result.absPath, "utf8");
        const parsed = yamlParse(raw);
        expect(parsed["status"]).toBe("in-progress");
        expect(parsed["claimed_by"]).toBe(SESSION_ULID);
        expect(parsed["ref"]).toBe(REF);
        // to-do/ manifest no longer exists.
        await expect(fs.stat(path.join(stateRoot, "to-do", `${REF}.yaml`))).rejects.toMatchObject({ code: "ENOENT" });
    });
    it("works when depends_on is empty", async () => {
        await seedManifest(stateRoot, "to-do", REF, { depends_on: [] });
        const result = await claimStory({
            targetRepoRoot: root,
            ref: REF,
            sessionUlid: SESSION_ULID,
        });
        expect(result.ref).toBe(REF);
    });
    it("works when all deps are in done/", async () => {
        await seedDoneManifest(stateRoot, DEP_A);
        await seedManifest(stateRoot, "to-do", REF, { depends_on: [DEP_A] });
        const result = await claimStory({
            targetRepoRoot: root,
            ref: REF,
            sessionUlid: SESSION_ULID,
        });
        expect(result.ref).toBe(REF);
        // Verify in-progress manifest exists.
        const raw = await fs.readFile(result.absPath, "utf8");
        const m = yamlParse(raw);
        expect(m["status"]).toBe("in-progress");
    });
});
// ---------------------------------------------------------------------------
// (b) Deps-not-ready
// ---------------------------------------------------------------------------
describe("claimStory (b) — deps-not-ready: missing dep in done/", () => {
    it("throws DependenciesNotReadyError with missingDeps listing the missing ref", async () => {
        // DEP_A is NOT in done/, DEP_B IS in done/
        await seedDoneManifest(stateRoot, DEP_B);
        await seedManifest(stateRoot, "to-do", REF, { depends_on: [DEP_A, DEP_B] });
        const toDoPath = path.join(stateRoot, "to-do", `${REF}.yaml`);
        const beforeContent = await fs.readFile(toDoPath, "utf8");
        const beforeMtime = (await fs.stat(toDoPath)).mtimeMs;
        const err = await claimStory({
            targetRepoRoot: root,
            ref: REF,
            sessionUlid: SESSION_ULID,
        }).catch((e) => e);
        expect(err).toBeInstanceOf(DependenciesNotReadyError);
        const typed = err;
        expect(typed.ref).toBe(REF);
        expect(typed.missingDeps).toContain(DEP_A);
        expect(typed.missingDeps).not.toContain(DEP_B);
        // Manifest stays in to-do/, unchanged byte-for-byte.
        const afterContent = await fs.readFile(toDoPath, "utf8");
        expect(afterContent).toBe(beforeContent);
        const afterMtime = (await fs.stat(toDoPath)).mtimeMs;
        expect(afterMtime).toBe(beforeMtime);
        // in-progress/ does not exist.
        await expect(fs.stat(path.join(stateRoot, "in-progress", `${REF}.yaml`))).rejects.toMatchObject({ code: "ENOENT" });
    });
    it("names all missing deps in the error", async () => {
        await seedManifest(stateRoot, "to-do", REF, { depends_on: [DEP_A, DEP_B] });
        const err = await claimStory({
            targetRepoRoot: root,
            ref: REF,
            sessionUlid: SESSION_ULID,
        }).catch((e) => e);
        expect(err).toBeInstanceOf(DependenciesNotReadyError);
        const typed = err;
        expect(typed.missingDeps).toContain(DEP_A);
        expect(typed.missingDeps).toContain(DEP_B);
        expect(typed.message).toContain(DEP_A);
        expect(typed.message).toContain(DEP_B);
    });
});
// ---------------------------------------------------------------------------
// (c) Hand-edit refusal on re-entry
// ---------------------------------------------------------------------------
describe("claimStory (c) — hand-edit refusal on re-entry", () => {
    it("throws InProgressHandEditError when in-progress/ manifest has been hand-edited", async () => {
        // Pre-place an in-progress/ manifest (simulating a prior claim by another session).
        const inProgressPath = await seedManifest(stateRoot, "in-progress", REF, {
            status: "in-progress",
            claimed_by: "01HZOTHER00000000000000001",
        });
        // Story 5.29: write the claim-time sidecar BEFORE the hand-edit so the
        // baseline reflects the original (pre-edit) state.
        {
            const raw = await fs.readFile(inProgressPath, "utf8");
            const parsed = yamlParse(raw);
            const manifest = parseExecutionManifest(parsed, { absPath: inProgressPath });
            await writeInProgressSnapshot({ targetRepoRoot: root, ref: REF, manifest });
        }
        // Simulate an operator hand-edit by changing the title on disk.
        const raw = await fs.readFile(inProgressPath, "utf8");
        const obj = yamlParse(raw);
        obj["title"] = "HAND-EDITED TITLE";
        await atomicWriteFile(inProgressPath, yamlStringify(obj, { lineWidth: 0 }));
        const err = await claimStory({
            targetRepoRoot: root,
            ref: REF,
            sessionUlid: SESSION_ULID,
        }).catch((e) => e);
        expect(err).toBeInstanceOf(InProgressHandEditError);
        const typed = err;
        expect(typed.changedFields).toContain("title");
        expect(typed.ref).toBe(REF);
        // No move occurred — in-progress/ manifest still exists.
        await expect(fs.stat(inProgressPath)).resolves.toBeTruthy();
    });
});
// ---------------------------------------------------------------------------
// (d) claimed_by defensive parse
// ---------------------------------------------------------------------------
describe("claimStory (d) — claimed_by defensive parse", () => {
    it("rewritten manifest round-trips through parseExecutionManifest with widened schema", async () => {
        await seedManifest(stateRoot, "to-do", REF);
        const result = await claimStory({
            targetRepoRoot: root,
            ref: REF,
            sessionUlid: SESSION_ULID,
        });
        const raw = await fs.readFile(result.absPath, "utf8");
        const parsed = yamlParse(raw);
        // Should not throw — the widened schema accepts in-progress + claimed_by.
        const manifest = parseExecutionManifest(parsed, { absPath: result.absPath });
        expect(manifest.status).toBe("in-progress");
        expect(manifest.claimed_by).toBe(SESSION_ULID);
    });
});
// ---------------------------------------------------------------------------
// ManifestNotFoundError when to-do/ ref does not exist
// ---------------------------------------------------------------------------
describe("claimStory — ManifestNotFoundError for missing to-do/ ref", () => {
    it("throws ManifestNotFoundError when the manifest does not exist in to-do/", async () => {
        const err = await claimStory({
            targetRepoRoot: root,
            ref: REF,
            sessionUlid: SESSION_ULID,
        }).catch((e) => e);
        expect(err).toBeInstanceOf(ManifestNotFoundError);
        const typed = err;
        expect(typed.ref).toBe(REF);
        expect(typed.fromState).toBe("to-do");
    });
});
