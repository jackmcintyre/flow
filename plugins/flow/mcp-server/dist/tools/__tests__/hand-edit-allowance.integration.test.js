/**
 * Integration tests for the hand-edit allowance contract — Story 3.7 Task 3.2.
 *
 * Covers AC4 cases (a), (b), (e), (f):
 *   (a) hand-edit `to-do/` title + narrative; assert parseExecutionManifest returns
 *       edited values; run scan-sources against the unchanged source story; assert
 *       edited values preserved AND manifest mtime stable (no rewrite).
 *   (b) hand-edit `to-do/` acceptance_criteria; mutate source story (new hash);
 *       run scan-sources; assert acceptance_criteria edits preserved AND
 *       source_hash / source_path updated.
 *   (e) hand-edit `blocked/` title; assert parseExecutionManifest returns edited value.
 *   (f) hand-edit `to-do/` to violate schema (delete title field); assert next
 *       parseExecutionManifest throws MalformedExecutionManifestError.
 *
 * Each test constructs a fresh tmpdir with a minimal native-adapter workspace
 * so the committed fixtures are never mutated.
 *
 * Note: operator edits are simulated via `atomicWriteFile` (the canonical write
 * primitive available to test code inside src test directories) — the static fs
 * guard bans direct write-shaped node:fs imports from src code.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { MalformedExecutionManifestError, } from "../../errors.js";
import { parseExecutionManifest } from "../../schemas/execution-manifest.js";
import { scanSources } from "../scan-sources.js";
// ---------------------------------------------------------------------------
// Helpers to construct a minimal native-adapter workspace in a tmpdir
// ---------------------------------------------------------------------------
// A native story body with properly formatted Given/When/Then ACs (bold markdown)
// so that parseNativeStory does not throw a format error.
const NATIVE_STORY_REF_ID = "01HZHAND000000000000000001";
const NATIVE_STORY_REF = `native:${NATIVE_STORY_REF_ID}`;
function makeNativeStoryContent(variant = "") {
    return [
        `# Hand-edit test story${variant}`,
        ``,
        `## Narrative`,
        ``,
        `As a user, I want the test feature so that I can verify hand-edit behaviour.`,
        ``,
        `## Acceptance Criteria`,
        ``,
        `**AC1 (integration):**`,
        `**Given** the feature is running, **When** the user accesses it, **Then** the feature works correctly.`,
        `vitest: src/__tests__/hand-edit.test.ts`,
        ``,
        `## Implementation Notes`,
        ``,
        `Wire up the handler in the main module.`,
        ``,
        `## Dependencies`,
        ``,
    ].join("\n");
}
function makeManifestYaml(opts) {
    const manifest = {
        ref: opts.ref,
        status: "to-do",
        adapter: "native",
        source_path: opts.sourcePath,
        source_hash: opts.sourceHash,
        depends_on: [],
        acceptance_criteria: opts.acceptanceCriteria ?? [
            {
                text: "Given the feature is running, When the user accesses it, Then the feature works correctly.",
                kind: "integration",
            },
        ],
        title: opts.title ?? "Hand-edit test story",
        narrative: opts.narrative ??
            "As a user, I want the test feature so that I can verify hand-edit behaviour.",
        withdrawn: false,
    };
    return yamlStringify(manifest, { lineWidth: 0 });
}
/**
 * Build a minimal native-adapter workspace in a tmpdir.
 * Returns the root path and the source story absolute path.
 */
async function buildWorkspace(root, opts = { sourceHash: "a".repeat(64) }) {
    const storiesDir = path.join(root, ".flow", "native-stories");
    await fs.mkdir(storiesDir, { recursive: true });
    const stateToDoDir = path.join(root, ".flow", "state", "to-do");
    await fs.mkdir(stateToDoDir, { recursive: true });
    // Write .flow/config.yaml — adapter:native
    await atomicWriteFile(path.join(root, ".flow", "config.yaml"), `adapter: native\nadapter_config: {}\n`);
    // Write native story file with proper **Given**/**When**/**Then** format.
    const storyContent = makeNativeStoryContent(opts.sourceVariant ?? "");
    const storyAbsPath = path.join(storiesDir, `${NATIVE_STORY_REF_ID}.md`);
    await atomicWriteFile(storyAbsPath, storyContent);
    // Write the to-do manifest with a pre-computed hash that matches the story.
    // Use scan-sources first to get the real hash — but for setup, seed with a known hash
    // that will be superseded by the first real scan.
    // Actually, to avoid a chicken-and-egg problem, we just seed the manifest directly
    // with the provided sourceHash. Tests that rely on scan-sources preserving the hash
    // will first run a scan to get the "real" hash, then hand-edit, then scan again.
    const storyRelPath = `.flow/native-stories/${NATIVE_STORY_REF_ID}.md`;
    const manifestAbsPath = path.join(stateToDoDir, `${NATIVE_STORY_REF}.yaml`);
    await atomicWriteFile(manifestAbsPath, makeManifestYaml({
        ref: NATIVE_STORY_REF,
        sourceHash: opts.sourceHash,
        sourcePath: storyRelPath,
    }));
    return { storyAbsPath, manifestAbsPath, sourceHash: opts.sourceHash };
}
/**
 * Read and parse a manifest from disk.
 */
async function readManifest(absPath) {
    const raw = await fs.readFile(absPath, "utf8");
    const parsed = yamlParse(raw);
    return parseExecutionManifest(parsed, { absPath });
}
/**
 * Simulate an operator hand-edit: read, mutate, write via atomicWriteFile.
 */
async function operatorEdit(absPath, mutate) {
    const raw = await fs.readFile(absPath, "utf8");
    const obj = yamlParse(raw);
    mutate(obj);
    await atomicWriteFile(absPath, yamlStringify(obj, { lineWidth: 0 }));
}
// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------
let scratch;
beforeEach(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "flow-hand-edit-allowance-"));
});
afterEach(async () => {
    await fs.rm(scratch, { recursive: true, force: true });
});
// ---------------------------------------------------------------------------
// (a) hand-edit to-do/ title + narrative; scan-sources no-op preserves edits
// ---------------------------------------------------------------------------
describe("hand-edit-allowance (a) — to-do/ hand-edit preserved after scan (no source change)", () => {
    it("parseExecutionManifest returns edited values; scan-sources preserves them (mtime stable)", async () => {
        const root = path.join(scratch, "workspace-a");
        await fs.mkdir(root);
        // 1. Run a real scan to seed the manifest with the correct hash.
        await buildWorkspace(root, { sourceHash: "a".repeat(64) });
        const firstScan = await scanSources({ targetRepoRoot: root });
        expect(firstScan.createdRefs.length + firstScan.updatedRefs.length + firstScan.unchangedRefs.length).toBeGreaterThan(0);
        const manifestAbsPath = path.join(root, ".flow", "state", "to-do", `${NATIVE_STORY_REF}.yaml`);
        // 2. Operator hand-edits title and narrative.
        await operatorEdit(manifestAbsPath, (obj) => {
            obj["title"] = "Hand-edit test story — operator edited title";
            obj["narrative"] = "As an operator, I hand-edited the narrative directly.";
        });
        // 3. parseExecutionManifest reflects the edited values immediately.
        const afterEdit = await readManifest(manifestAbsPath);
        expect(afterEdit.title).toBe("Hand-edit test story — operator edited title");
        expect(afterEdit.narrative).toBe("As an operator, I hand-edited the narrative directly.");
        // 4. Backdate mtime by 2 seconds so any subsequent rewrite is detectable.
        const statBefore = await fs.stat(manifestAbsPath);
        const backdatedSec = statBefore.mtimeMs / 1000 - 2;
        await fs.utimes(manifestAbsPath, backdatedSec, backdatedSec);
        const statBackdated = await fs.stat(manifestAbsPath);
        expect(statBackdated.mtimeMs).toBeLessThan(statBefore.mtimeMs);
        // 5. Run scan-sources — the source story has NOT changed, so the hash matches.
        await scanSources({ targetRepoRoot: root });
        // 6. Assert mtime is STABLE (scan-sources did not rewrite the manifest).
        const statAfterScan = await fs.stat(manifestAbsPath);
        expect(statAfterScan.mtimeMs).toBe(statBackdated.mtimeMs);
        // 7. Assert the edited values are still present.
        const afterScan = await readManifest(manifestAbsPath);
        expect(afterScan.title).toBe("Hand-edit test story — operator edited title");
        expect(afterScan.narrative).toBe("As an operator, I hand-edited the narrative directly.");
    });
});
// ---------------------------------------------------------------------------
// (b) hand-edit to-do/ acceptance_criteria; source story changes → scan
//     updates hash but preserves operator's AC edits
// ---------------------------------------------------------------------------
describe("hand-edit-allowance (b) — operator AC edits preserved when source hash changes", () => {
    it("source_hash updated AND operator acceptance_criteria edits preserved", async () => {
        const root = path.join(scratch, "workspace-b");
        await fs.mkdir(root);
        // 1. Build workspace and run initial scan to seed the manifest with the real hash.
        await buildWorkspace(root, { sourceHash: "a".repeat(64) });
        await scanSources({ targetRepoRoot: root });
        const manifestAbsPath = path.join(root, ".flow", "state", "to-do", `${NATIVE_STORY_REF}.yaml`);
        const storyAbsPath = path.join(root, ".flow", "native-stories", `${NATIVE_STORY_REF_ID}.md`);
        // 2. Operator edits acceptance_criteria.
        await operatorEdit(manifestAbsPath, (obj) => {
            obj["acceptance_criteria"] = [
                {
                    text: "Given the feature is running, When I click the button, Then I see a confirmation.",
                    kind: "integration",
                },
            ];
        });
        // 3. Read original source_hash from the manifest.
        const beforeScan = await readManifest(manifestAbsPath);
        const originalHash = beforeScan.source_hash;
        expect(beforeScan.acceptance_criteria[0].text).toContain("confirmation");
        // 4. Mutate the source story file to change its hash.
        const originalStoryContent = await fs.readFile(storyAbsPath, "utf8");
        // Append a harmless extra implementation note line to force a new hash.
        await atomicWriteFile(storyAbsPath, originalStoryContent.replace("Wire up the handler in the main module.", "Wire up the handler in the main module.\nAlso update the configuration."));
        // 5. Run scan-sources — it detects a hash change for this story.
        const result = await scanSources({ targetRepoRoot: root });
        expect(result.updatedRefs).toContain(NATIVE_STORY_REF);
        // 6. After scan: source_hash is new (different from original), but
        //    operator's acceptance_criteria edits are preserved.
        const afterScan = await readManifest(manifestAbsPath);
        expect(afterScan.source_hash).not.toBe(originalHash);
        expect(afterScan.acceptance_criteria[0].text).toContain("confirmation");
        // 7. source_path should be the repo-relative path (preserved or updated).
        expect(afterScan.source_path).toBeTruthy();
    });
});
// ---------------------------------------------------------------------------
// (e) hand-edit blocked/ title; parseExecutionManifest returns edited value
// ---------------------------------------------------------------------------
describe("hand-edit-allowance (e) — blocked/ hand-edit visible via parseExecutionManifest", () => {
    it("edited title is returned by parseExecutionManifest", async () => {
        const root = path.join(scratch, "workspace-e");
        await fs.mkdir(root);
        // Seed a blocked/ manifest directly (no need to run scan).
        const blockedDir = path.join(root, ".flow", "state", "blocked");
        await fs.mkdir(blockedDir, { recursive: true });
        const blockedRef = "native:01HZBLOCKED000000000000001";
        const blockedAbsPath = path.join(blockedDir, `${blockedRef}.yaml`);
        const blockedManifest = {
            ref: blockedRef,
            status: "blocked",
            adapter: "native",
            source_path: ".flow/native-stories/01HZBLOCKED000000000000001.md",
            source_hash: "e1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6e1b2",
            depends_on: [],
            acceptance_criteria: [
                {
                    text: "Given the blocked story, when it is fixed, then it passes the check.",
                    kind: "integration",
                },
            ],
            title: "Blocked story original title",
            narrative: "As a user, I want this blocked story to be fixed.",
            withdrawn: false,
            blocked_by: "planning-discipline",
            discipline_violations: [
                {
                    code: "missing-integration-ac",
                    field: "acceptance_criteria",
                    detail: "No integration-tagged AC found.",
                },
            ],
        };
        await atomicWriteFile(blockedAbsPath, yamlStringify(blockedManifest, { lineWidth: 0 }));
        // Operator hand-edits the title.
        await operatorEdit(blockedAbsPath, (obj) => {
            obj["title"] = "Blocked story — operator edited title";
        });
        // parseExecutionManifest must return the edited title.
        const afterEdit = await readManifest(blockedAbsPath);
        expect(afterEdit.title).toBe("Blocked story — operator edited title");
    });
});
// ---------------------------------------------------------------------------
// (f) hand-edit to-do/ to violate schema → MalformedExecutionManifestError
// ---------------------------------------------------------------------------
describe("hand-edit-allowance (f) — schema-violating edit surfaces MalformedExecutionManifestError", () => {
    it("parseExecutionManifest throws MalformedExecutionManifestError after removing required title", async () => {
        const root = path.join(scratch, "workspace-f");
        await fs.mkdir(root);
        await buildWorkspace(root, { sourceHash: "a".repeat(64) });
        await scanSources({ targetRepoRoot: root });
        const manifestAbsPath = path.join(root, ".flow", "state", "to-do", `${NATIVE_STORY_REF}.yaml`);
        // Operator removes the required `title` field (schema violation).
        await operatorEdit(manifestAbsPath, (obj) => {
            delete obj["title"];
        });
        const raw = await fs.readFile(manifestAbsPath, "utf8");
        const parsed = yamlParse(raw);
        // This must throw MalformedExecutionManifestError — cannot be silently accepted.
        expect(() => parseExecutionManifest(parsed, { absPath: manifestAbsPath })).toThrow(MalformedExecutionManifestError);
    });
});
