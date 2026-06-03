/**
 * Integration tests for Story 5.16: deps-drift gate on to-do source-hash refresh.
 *
 * Covers AC2 cases (a), (b), (c):
 *   (a) drift introduced on refresh — spec edited to add a prose `Depends on:` ref
 *       that the manifest's `depends_on` omits (AND changes source_hash).
 *       Expects: to-do/ manifest NOT overwritten, blocked/ manifest written with
 *       blocked_by: "deps-drift", result.depsDriftRefs populated, result.blockedRefs
 *       populated, result.updatedRefs does NOT contain the ref.
 *   (b) no-drift-on-refresh (idempotency control) — spec body edited (changing hash)
 *       WITHOUT adding a new prose dep. Expects: to-do/ manifest rewritten with new
 *       source_hash, result.updatedRefs populated, no blocked/ manifest, depsDriftRefs
 *       empty for this ref.
 *   (c) drift-already-present-pre-refresh (symmetric drift) — prose adds a dep AND
 *       manifest already has an extra dep simultaneously. Expects: same blocked/
 *       outcome as (a) with both proseRefs and manifestRefs reflecting the symmetric
 *       difference.
 *
 * Fixture pattern mirrors hand-edit-allowance.integration.test.ts:
 * - Fresh tmpdir per test via beforeEach/afterEach.
 * - Minimal native-adapter workspace (config.yaml + native story + to-do/ manifest).
 * - scanSources() called directly on the workspace root.
 * - Assertions on the returned ScanResult AND on the post-scan filesystem state.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { parseExecutionManifest } from "../../schemas/execution-manifest.js";
import { scanSources } from "../scan-sources.js";
// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------
// A valid Crockford Base32 ULID for the test story.
// Note: Crockford Base32 excludes I, L, O, U — use only 0-9, A-H, J, K, M, N, P-T, V-Z.
const STORY_ULID = "01HZDRF000000000000000001A";
const STORY_REF = `native:${STORY_ULID}`;
/**
 * Build a native story body.
 * - `extraProseDepLine`: a prose `Depends on:` line inserted into Implementation Notes
 *   (triggers the `extractDepRefsFromSpecBody` prose pattern).
 * - `depsSection`: bullet refs for the `## Dependencies` section (populates `story.depends_on`).
 * - `narrativeSuffix`: appended to title and narrative (forces a hash change).
 */
function makeStoryBody(opts = {}) {
    const implNotes = opts.extraProseDepLine
        ? `Wire up the handler.\n${opts.extraProseDepLine}`
        : `Wire up the handler.`;
    const depLines = (opts.depsSection ?? []).map((ref) => `- ${ref}`).join("\n");
    return [
        `# Drift-on-refresh test story${opts.narrativeSuffix ?? ""}`,
        ``,
        `## Narrative`,
        ``,
        `As a user, I want drift detection${opts.narrativeSuffix ?? ""} so that deps stay consistent.`,
        ``,
        `## Acceptance Criteria`,
        ``,
        `**AC1 (integration):**`,
        `**Given** the system is running, **When** the user requests it, **Then** it works.`,
        `vitest: src/__tests__/drift.test.ts`,
        ``,
        `## Implementation Notes`,
        ``,
        implNotes,
        ``,
        `## Dependencies`,
        ``,
        ...(depLines ? [depLines, ``] : [``]),
    ].join("\n");
}
/** Build a YAML manifest string for the to-do/ state. */
function makeManifestYaml(opts) {
    const manifest = {
        ref: opts.ref,
        status: "to-do",
        adapter: "native",
        source_path: opts.sourcePath,
        source_hash: opts.sourceHash,
        depends_on: opts.dependsOn ?? [],
        acceptance_criteria: [
            {
                text: "Given the system is running, When the user requests it, Then it works.",
                kind: "integration",
            },
        ],
        title: "Drift-on-refresh test story",
        narrative: "As a user, I want drift detection so that deps stay consistent.",
        withdrawn: false,
    };
    return yamlStringify(manifest, { lineWidth: 0 });
}
/** Compute SHA-256 hex of a string (same as parseNativeStory). */
function sha256(content) {
    return createHash("sha256").update(content).digest("hex");
}
/**
 * Build a minimal native-adapter workspace. Returns paths to the story and
 * to-do manifest, plus the initial source hash.
 *
 * The to-do manifest is seeded with a source_hash matching the given storyBody,
 * and depends_on matching the storyBody's `## Dependencies` section (i.e. what
 * the scanner would have written on first scan). Pass `overrideManifestDepsOn`
 * to deliberately mismatch the manifest from the story's ## Dependencies (used in
 * case (c) to simulate a pre-existing manifest-side extra dep).
 */
async function buildWorkspace(root, storyBody, opts = {}) {
    const storiesDir = path.join(root, ".flow", "native-stories");
    const toDoDir = path.join(root, ".flow", "state", "to-do");
    const blockedDir = path.join(root, ".flow", "state", "blocked");
    await fs.mkdir(storiesDir, { recursive: true });
    await fs.mkdir(toDoDir, { recursive: true });
    await fs.mkdir(blockedDir, { recursive: true });
    // Write adapter config.
    await atomicWriteFile(path.join(root, ".flow", "config.yaml"), `adapter: native\nadapter_config: {}\n`);
    // Write the source story file.
    const storyAbsPath = path.join(storiesDir, `${STORY_ULID}.md`);
    await atomicWriteFile(storyAbsPath, storyBody);
    // Seed the to-do/ manifest with the current story hash.
    const sourceHash = sha256(storyBody);
    const storyRelPath = `.flow/native-stories/${STORY_ULID}.md`;
    const toDoManifestAbsPath = path.join(toDoDir, `${STORY_REF}.yaml`);
    // Use the override if provided; otherwise default to empty (no deps in manifest).
    const manifestDependsOn = opts.overrideManifestDepsOn ?? [];
    await atomicWriteFile(toDoManifestAbsPath, makeManifestYaml({
        ref: STORY_REF,
        sourceHash,
        sourcePath: storyRelPath,
        dependsOn: manifestDependsOn,
    }));
    return { storyAbsPath, toDoManifestAbsPath, blockedDir };
}
/** Read and parse a manifest from disk. */
async function readParsedManifest(absPath) {
    const raw = await fs.readFile(absPath, "utf8");
    const parsed = yamlParse(raw);
    return parseExecutionManifest(parsed, { absPath });
}
/** Read raw YAML from disk (returns null if the file does not exist). */
async function readYamlOrNull(absPath) {
    try {
        const raw = await fs.readFile(absPath, "utf8");
        return yamlParse(raw);
    }
    catch (err) {
        if (err.code === "ENOENT")
            return null;
        throw err;
    }
}
// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------
let scratch;
beforeEach(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "flow-scan-drift-refresh-"));
});
afterEach(async () => {
    await fs.rm(scratch, { recursive: true, force: true });
});
// ---------------------------------------------------------------------------
// Case (a): drift introduced on refresh
// ---------------------------------------------------------------------------
describe("scan-sources-drift-on-refresh (a) — drift introduced on refresh", () => {
    it("refuses to overwrite to-do/ manifest and writes blocked/ manifest with deps-drift", async () => {
        const root = path.join(scratch, "workspace-a");
        await fs.mkdir(root);
        // Seed workspace: story has no deps in prose or ## Dependencies; manifest has depends_on: [].
        const originalBody = makeStoryBody();
        const { storyAbsPath, toDoManifestAbsPath, blockedDir } = await buildWorkspace(root, originalBody);
        // Capture the pre-scan manifest state.
        const preScanManifest = await readParsedManifest(toDoManifestAbsPath);
        const preScanHash = preScanManifest.source_hash;
        const preScanDependsOn = preScanManifest.depends_on;
        // Operator edits the spec body: adds a prose `Depends on:` line for bmad:5.1 in
        // Implementation Notes (changes source_hash AND introduces deps-drift — prose refs
        // bmad:5.1 but story.depends_on (from ## Dependencies) is still []).
        const editedBody = makeStoryBody({ extraProseDepLine: "Depends on: bmad:5.1" });
        await atomicWriteFile(storyAbsPath, editedBody);
        // Run scanSources — should detect drift on the refresh branch.
        const result = await scanSources({ targetRepoRoot: root });
        // (i) to-do/ manifest is NOT overwritten — parsed source_hash and depends_on
        //     are identical to the pre-scan values.
        const postScanToDo = await readParsedManifest(toDoManifestAbsPath);
        expect(postScanToDo.source_hash).toBe(preScanHash);
        expect(postScanToDo.depends_on).toEqual(preScanDependsOn);
        // (ii) blocked/ manifest written with blocked_by: "deps-drift" and the correct
        //      discipline_violations code.
        const blockedAbsPath = path.join(blockedDir, `${STORY_REF}.yaml`);
        const blockedRaw = await readYamlOrNull(blockedAbsPath);
        expect(blockedRaw).not.toBeNull();
        expect(blockedRaw["blocked_by"]).toBe("deps-drift");
        const violations = blockedRaw["discipline_violations"];
        expect(Array.isArray(violations)).toBe(true);
        expect(violations[0].code).toBe("deps-drift-prose-vs-manifest");
        // (iii) result.depsDriftRefs contains an entry for the ref with correct arrays.
        const driftEntry = result.depsDriftRefs.find((e) => e.ref === STORY_REF);
        expect(driftEntry).toBeDefined();
        expect(driftEntry.proseRefs).toContain("bmad:5.1");
        expect(driftEntry.manifestRefs).toEqual([]);
        // (iv) result.blockedRefs contains the ref.
        expect(result.blockedRefs).toContain(STORY_REF);
        // (v) result.updatedRefs does NOT contain the ref.
        expect(result.updatedRefs).not.toContain(STORY_REF);
    });
});
// ---------------------------------------------------------------------------
// Case (b): no-drift-on-refresh (idempotency control)
// ---------------------------------------------------------------------------
describe("scan-sources-drift-on-refresh (b) — no-drift-on-refresh (idempotency control)", () => {
    it("rewrites the to-do/ manifest with new source_hash when no deps drift is present", async () => {
        const root = path.join(scratch, "workspace-b");
        await fs.mkdir(root);
        // Seed workspace: story has no deps in prose or ## Dependencies; manifest has depends_on: [].
        const originalBody = makeStoryBody();
        const { storyAbsPath, toDoManifestAbsPath, blockedDir } = await buildWorkspace(root, originalBody);
        const preScanManifest = await readParsedManifest(toDoManifestAbsPath);
        const preScanHash = preScanManifest.source_hash;
        // Operator edits the spec body: tweaks narrative text only (no new prose dep).
        const editedBody = makeStoryBody({ narrativeSuffix: " — revised narrative" });
        await atomicWriteFile(storyAbsPath, editedBody);
        // Confirm the edit actually changes the hash.
        const newHash = sha256(editedBody);
        expect(newHash).not.toBe(preScanHash);
        // Run scanSources — no deps drift, so the refresh path should proceed.
        const result = await scanSources({ targetRepoRoot: root });
        // (i) to-do/ manifest IS rewritten with the new source_hash.
        const postScanToDo = await readParsedManifest(toDoManifestAbsPath);
        expect(postScanToDo.source_hash).toBe(newHash);
        // (ii) result.updatedRefs contains the ref.
        expect(result.updatedRefs).toContain(STORY_REF);
        // (iii) no blocked/ manifest is written.
        const blockedAbsPath = path.join(blockedDir, `${STORY_REF}.yaml`);
        const blockedRaw = await readYamlOrNull(blockedAbsPath);
        expect(blockedRaw).toBeNull();
        // (iv) result.depsDriftRefs is empty for this ref.
        const driftEntry = result.depsDriftRefs.find((e) => e.ref === STORY_REF);
        expect(driftEntry).toBeUndefined();
    });
});
// ---------------------------------------------------------------------------
// Case (c): drift-already-present-pre-refresh (symmetric drift)
// ---------------------------------------------------------------------------
describe("scan-sources-drift-on-refresh (c) — symmetric drift on refresh", () => {
    it("blocks with both proseRefs and manifestRefs reflecting the symmetric difference", async () => {
        const root = path.join(scratch, "workspace-c");
        await fs.mkdir(root);
        // Seed workspace: story has bmad:5.2 in its ## Dependencies section
        // (so story.depends_on = ["bmad:5.2"]).
        const originalBody = makeStoryBody({ depsSection: ["bmad:5.2"] });
        const { storyAbsPath, toDoManifestAbsPath, blockedDir } = await buildWorkspace(root, originalBody);
        // Operator edits the spec: adds prose `Depends on: bmad:5.1` in Implementation
        // Notes (changes hash AND introduces a prose dep). Now:
        //   prose refs (extractDepRefsFromSpecBody): [bmad:5.1]
        //   story.depends_on (from ## Dependencies): [bmad:5.2]
        //   symmetric difference: each side has something the other lacks.
        const editedBody = makeStoryBody({
            depsSection: ["bmad:5.2"],
            extraProseDepLine: "Depends on: bmad:5.1",
        });
        await atomicWriteFile(storyAbsPath, editedBody);
        // Run scanSources — should detect symmetric drift and block.
        const result = await scanSources({ targetRepoRoot: root });
        // Verify blocked/ manifest is written.
        const blockedAbsPath = path.join(blockedDir, `${STORY_REF}.yaml`);
        const blockedRaw = await readYamlOrNull(blockedAbsPath);
        expect(blockedRaw).not.toBeNull();
        expect(blockedRaw["blocked_by"]).toBe("deps-drift");
        const violations = blockedRaw["discipline_violations"];
        expect(violations[0].code).toBe("deps-drift-prose-vs-manifest");
        // result.depsDriftRefs entry should carry the symmetric difference.
        const driftEntry = result.depsDriftRefs.find((e) => e.ref === STORY_REF);
        expect(driftEntry).toBeDefined();
        // proseRefs: everything prose sees (bmad:5.1).
        expect(driftEntry.proseRefs).toContain("bmad:5.1");
        // manifestRefs: everything the manifest sees (bmad:5.2).
        expect(driftEntry.manifestRefs).toContain("bmad:5.2");
        // result.blockedRefs contains the ref; result.updatedRefs does not.
        expect(result.blockedRefs).toContain(STORY_REF);
        expect(result.updatedRefs).not.toContain(STORY_REF);
    });
});
