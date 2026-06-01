/**
 * Integration test for Story 5.19: scan-sources readFile resilience.
 *
 * AC2: vitest seeds a fixture with 3 valid manifests + 1 deliberately-malformed-yaml
 * manifest under to-do/, runs scanSources, asserts (a) the 3 valid manifests scan
 * clean, (b) the bad one appears in result.skippedRefs with reason "unreadable-manifest"
 * and a non-empty detail field, (c) scanSources returns without throwing at the
 * boundary (the per-file error is contained).
 *
 * Fixture pattern mirrors hand-edit-allowance.integration.test.ts and
 * scan-sources-drift-on-refresh.test.ts:
 * - Fresh tmpdir per test via beforeEach/afterEach.
 * - Minimal native-adapter workspace (config.yaml + native stories + to-do/ manifests).
 * - scanSources() called directly on the workspace root.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { stringify as yamlStringify } from "yaml";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { scanSources } from "../scan-sources.js";
// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------
// Four valid Crockford Base32 ULIDs (uppercase, 26 chars, no I/L/O/U).
const STORY_ULIDS = [
    "01HZDRF000000000000000005A",
    "01HZDRF000000000000000005B",
    "01HZDRF000000000000000005C",
    "01HZDRF000000000000000005D",
];
function refFor(ulid) {
    return `native:${ulid}`;
}
/** Build a minimal native story body. */
function makeStoryBody(suffix) {
    return [
        `# Resilience-test story ${suffix}`,
        ``,
        `## Narrative`,
        ``,
        `As a user, I want resilience ${suffix} so that one bad file doesn't break everything.`,
        ``,
        `## Acceptance Criteria`,
        ``,
        `**AC1 (integration):**`,
        `**Given** the system is running, **When** the user requests it, **Then** it works.`,
        `vitest: src/__tests__/resilience.test.ts`,
        ``,
        `## Implementation Notes`,
        ``,
        `Wire up the handler.`,
        ``,
        `## Dependencies`,
        ``,
        ``,
    ].join("\n");
}
/** Build a YAML manifest string for a to-do/ state file. */
function makeManifestYaml(opts) {
    const manifest = {
        ref: opts.ref,
        status: "to-do",
        adapter: "native",
        source_path: opts.sourcePath,
        source_hash: opts.sourceHash,
        depends_on: [],
        acceptance_criteria: [
            {
                text: "Given the system is running, When the user requests it, Then it works.",
                kind: "integration",
            },
        ],
        title: "Resilience-test story",
        narrative: "As a user, I want resilience so that one bad file doesn't break everything.",
        withdrawn: false,
    };
    return yamlStringify(manifest, { lineWidth: 0 });
}
function sha256(content) {
    return createHash("sha256").update(content).digest("hex");
}
// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------
let scratch;
beforeEach(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "crew-scan-readfile-resilience-"));
});
afterEach(async () => {
    await fs.rm(scratch, { recursive: true, force: true });
});
// ---------------------------------------------------------------------------
// AC2: 3 valid + 1 malformed manifest under to-do/
// ---------------------------------------------------------------------------
describe("scan-sources readFile resilience (Story 5.19)", () => {
    it("skips a single malformed-yaml manifest with reason 'unreadable-manifest' and scans the other three clean", async () => {
        const root = path.join(scratch, "workspace");
        await fs.mkdir(root);
        const storiesDir = path.join(root, ".crew", "native-stories");
        const toDoDir = path.join(root, ".crew", "state", "to-do");
        await fs.mkdir(storiesDir, { recursive: true });
        await fs.mkdir(toDoDir, { recursive: true });
        // Native-adapter config.
        await atomicWriteFile(path.join(root, ".crew", "config.yaml"), `adapter: native\nadapter_config: {}\n`);
        // Seed four source stories + four matching to-do manifests; the LAST manifest's
        // bytes are deliberately corrupted YAML so the readFile/parse path takes the
        // unreadable-manifest skip branch.
        for (let i = 0; i < STORY_ULIDS.length; i++) {
            const ulid = STORY_ULIDS[i];
            const ref = refFor(ulid);
            const body = makeStoryBody(`#${i}`);
            const storyAbsPath = path.join(storiesDir, `${ulid}.md`);
            await atomicWriteFile(storyAbsPath, body);
            const sourceHash = sha256(body);
            const storyRelPath = `.crew/native-stories/${ulid}.md`;
            const toDoManifestAbsPath = path.join(toDoDir, `${ref}.yaml`);
            if (i < 3) {
                // Valid manifest with source_hash matching the story body — should land in
                // unchangedRefs after scan (UPDATE-or-UNCHANGED branch with no drift).
                await atomicWriteFile(toDoManifestAbsPath, makeManifestYaml({ ref, sourceHash, sourcePath: storyRelPath }));
            }
            else {
                // Deliberately malformed YAML — parses but fails schema validation, AND
                // a leading control character that makes the YAML payload nonsensical.
                // Either way, the catch block in scan-sources.ts must push the ref to
                // result.skippedRefs with reason "unreadable-manifest" and continue.
                const badYaml = "this: is: not: valid: yaml: at: all:\n" +
                    "  - [broken,\n" +
                    "  : indentation chaos\n" +
                    "}}}}}\n";
                await atomicWriteFile(toDoManifestAbsPath, badYaml);
            }
        }
        // (c) scanSources returns without throwing at the boundary.
        const result = await scanSources({ targetRepoRoot: root });
        // (a) The 3 valid manifests scan clean — they land in unchangedRefs because
        // their source_hash matches the on-disk story body, no drift, no rewrite.
        const validRefs = STORY_ULIDS.slice(0, 3).map(refFor);
        for (const ref of validRefs) {
            expect(result.unchangedRefs).toContain(ref);
        }
        // (b) The malformed manifest appears in result.skippedRefs with reason
        // "unreadable-manifest" and a non-empty detail field.
        const badRef = refFor(STORY_ULIDS[3]);
        const skipped = result.skippedRefs.find((s) => s.ref === badRef);
        expect(skipped).toBeDefined();
        expect(skipped.reason).toBe("unreadable-manifest");
        expect(skipped.detail).toBeDefined();
        expect(skipped.detail.length).toBeGreaterThan(0);
        // Bad ref should NOT pollute the other ref-arrays.
        expect(result.unchangedRefs).not.toContain(badRef);
        expect(result.updatedRefs).not.toContain(badRef);
        expect(result.createdRefs).not.toContain(badRef);
        expect(result.blockedRefs).not.toContain(badRef);
    });
    it("skips a manifest whose file is unreadable (simulated read error) with the documented detail shape", async () => {
        const root = path.join(scratch, "workspace-readerr");
        await fs.mkdir(root);
        const storiesDir = path.join(root, ".crew", "native-stories");
        const toDoDir = path.join(root, ".crew", "state", "to-do");
        await fs.mkdir(storiesDir, { recursive: true });
        await fs.mkdir(toDoDir, { recursive: true });
        await atomicWriteFile(path.join(root, ".crew", "config.yaml"), `adapter: native\nadapter_config: {}\n`);
        // One source story.
        const ulid = STORY_ULIDS[0];
        const ref = refFor(ulid);
        const body = makeStoryBody("#read-err");
        await atomicWriteFile(path.join(storiesDir, `${ulid}.md`), body);
        // Seed the to-do manifest as a DIRECTORY (not a file) — fs.readFile will
        // throw EISDIR. This exercises the readFile catch branch with an errno-bearing
        // ENOENT-class error, matching the AC1 "<errno>: <path>" detail shape.
        const toDoManifestAbsPath = path.join(toDoDir, `${ref}.yaml`);
        await fs.mkdir(toDoManifestAbsPath);
        // scanSources must not throw at the boundary.
        const result = await scanSources({ targetRepoRoot: root });
        const skipped = result.skippedRefs.find((s) => s.ref === ref);
        expect(skipped).toBeDefined();
        expect(skipped.reason).toBe("unreadable-manifest");
        expect(skipped.detail).toBeDefined();
        // Detail follows "<errno>: <path>" — both halves non-empty.
        expect(skipped.detail).toMatch(/^[A-Z][A-Z0-9_]*: \//);
        expect(skipped.detail).toContain(toDoManifestAbsPath);
    });
});
