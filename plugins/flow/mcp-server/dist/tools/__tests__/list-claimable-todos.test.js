/**
 * Unit tests for `listClaimableTodos` — Story 4.2 Task 7.2.
 *
 * Covers:
 *   (a) empty `to-do/` returns `{ todos: [], inProgressCount: 0 }`.
 *   (b) three claimable refs return them alphabetically.
 *   (c) a withdrawn ref is filtered out.
 *   (d) a ref with one unmet dep returns `depsReady: false`.
 *   (e) a ref with all deps in `done/` returns `depsReady: true`.
 *   (f) malformed manifest propagates `MalformedExecutionManifestError`.
 *   (g) `inProgressCount` reflects directory contents.
 *
 * Approach: real filesystem ops against a tmpdir. No node:fs mocking.
 */
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { MalformedExecutionManifestError } from "../../errors.js";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { listClaimableTodos } from "../list-claimable-todos.js";
let tmpRoot;
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function makeStateDir(root) {
    for (const state of ["to-do", "in-progress", "done", "blocked"]) {
        await fs.mkdir(path.join(root, ".flow", "state", state), { recursive: true });
    }
}
function makeManifest(ref, opts = {}) {
    const manifest = {
        ref,
        status: opts.status ?? "to-do",
        adapter: "native",
        source_path: `.flow/native-stories/${ref.replace("native:", "")}.md`,
        source_hash: "a".repeat(64),
        depends_on: opts.depends_on ?? [],
        acceptance_criteria: [
            { text: "Given something, when something, then something works.", kind: "integration" },
        ],
        title: `Story ${ref}`,
        narrative: "As a user, I want something so that I can use it.",
        withdrawn: opts.withdrawn ?? false,
    };
    return yamlStringify(manifest, { lineWidth: 0 });
}
async function writeManifest(root, state, ref, yaml) {
    const p = path.join(root, ".flow", "state", state, `${ref}.yaml`);
    await atomicWriteFile(p, yaml);
}
// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "flow-list-todos-"));
    await makeStateDir(tmpRoot);
});
afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
});
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("listClaimableTodos", () => {
    it("(a) empty to-do/ returns { todos: [], inProgressCount: 0 }", async () => {
        const result = await listClaimableTodos({ targetRepoRoot: tmpRoot });
        expect(result.todos).toEqual([]);
        expect(result.inProgressCount).toBe(0);
    });
    it("(b) three claimable refs return them alphabetically", async () => {
        const refs = [
            "native:01HZABC0000000000000000003",
            "native:01HZABC0000000000000000001",
            "native:01HZABC0000000000000000002",
        ];
        for (const ref of refs) {
            await writeManifest(tmpRoot, "to-do", ref, makeManifest(ref));
        }
        const result = await listClaimableTodos({ targetRepoRoot: tmpRoot });
        const returnedRefs = result.todos.map((c) => c.ref);
        expect(returnedRefs).toEqual([...returnedRefs].sort());
        expect(returnedRefs.length).toBe(3);
        expect(result.todos[0].ref).toBe("native:01HZABC0000000000000000001");
        expect(result.todos[1].ref).toBe("native:01HZABC0000000000000000002");
        expect(result.todos[2].ref).toBe("native:01HZABC0000000000000000003");
    });
    it("(c) a withdrawn ref is filtered out", async () => {
        const ref = "native:01HZABC0000000000000000001";
        await writeManifest(tmpRoot, "to-do", ref, makeManifest(ref, { withdrawn: true }));
        const result = await listClaimableTodos({ targetRepoRoot: tmpRoot });
        expect(result.todos).toEqual([]);
    });
    it("(d) a ref with one unmet dep returns depsReady: false", async () => {
        const dep = "native:01HZDEP000000000000000001";
        const ref = "native:01HZABC0000000000000000001";
        await writeManifest(tmpRoot, "to-do", ref, makeManifest(ref, { depends_on: [dep] }));
        // dep is NOT in done/
        const result = await listClaimableTodos({ targetRepoRoot: tmpRoot });
        expect(result.todos.length).toBe(1);
        expect(result.todos[0].depsReady).toBe(false);
    });
    it("(e) a ref with all deps in done/ returns depsReady: true", async () => {
        const dep = "native:01HZDEP000000000000000001";
        const ref = "native:01HZABC0000000000000000001";
        await writeManifest(tmpRoot, "to-do", ref, makeManifest(ref, { depends_on: [dep] }));
        // Place dep in done/
        await writeManifest(tmpRoot, "done", dep, makeManifest(dep, { status: "done" }));
        const result = await listClaimableTodos({ targetRepoRoot: tmpRoot });
        expect(result.todos.length).toBe(1);
        expect(result.todos[0].depsReady).toBe(true);
    });
    it("(f) malformed manifest propagates MalformedExecutionManifestError", async () => {
        const ref = "native:01HZABC0000000000000000001";
        // Valid YAML but missing required manifest fields — parseExecutionManifest will throw.
        const malformedYaml = "ref: native:01HZABC0000000000000000001\nstatus: to-do\n";
        await atomicWriteFile(path.join(tmpRoot, ".flow", "state", "to-do", `${ref}.yaml`), malformedYaml);
        await expect(listClaimableTodos({ targetRepoRoot: tmpRoot })).rejects.toThrow(MalformedExecutionManifestError);
    });
    it("(g) inProgressCount reflects in-progress directory contents", async () => {
        const ref1 = "native:01HZABC0000000000000000001";
        const ref2 = "native:01HZABC0000000000000000002";
        await writeManifest(tmpRoot, "in-progress", ref1, makeManifest(ref1, { status: "in-progress" }));
        await writeManifest(tmpRoot, "in-progress", ref2, makeManifest(ref2, { status: "in-progress" }));
        const result = await listClaimableTodos({ targetRepoRoot: tmpRoot });
        expect(result.inProgressCount).toBe(2);
        expect(result.todos).toEqual([]); // no to-do entries
    });
    it("returns depsReady: true for a ref with no deps", async () => {
        const ref = "native:01HZABC0000000000000000001";
        await writeManifest(tmpRoot, "to-do", ref, makeManifest(ref, { depends_on: [] }));
        const result = await listClaimableTodos({ targetRepoRoot: tmpRoot });
        expect(result.todos.length).toBe(1);
        expect(result.todos[0].depsReady).toBe(true);
    });
    // AC3 (this story) — every candidate includes a non-empty shortHandle field.
    it("(AC3) every candidate includes a non-empty shortHandle field", async () => {
        const nativeRef = "native:01HZABC0000000000000000001";
        await writeManifest(tmpRoot, "to-do", nativeRef, makeManifest(nativeRef));
        const result = await listClaimableTodos({ targetRepoRoot: tmpRoot });
        expect(result.todos.length).toBe(1);
        const candidate = result.todos[0];
        // shortHandle must be non-empty.
        expect(candidate.shortHandle).toBeTruthy();
        // For a native ref, shortHandle is the first 8 chars of the ULID.
        expect(candidate.shortHandle).toBe("01HZABC0");
        // The short handle is distinct from the full ref.
        expect(candidate.shortHandle).not.toBe(candidate.ref);
        // The short handle is shorter than the full ref (26-char ULID vs 8-char prefix).
        expect(candidate.shortHandle.length).toBeLessThan(candidate.ref.length);
    });
    it("(AC3) bmad ref shortHandle equals the local part after the colon", async () => {
        // Use a bmad-shaped ref to verify the bmad branch of shortHandle.
        const bmadRef = "bmad:8.18";
        // We need a manifest with bmad adapter; create a custom one.
        const manifest = {
            ref: bmadRef,
            status: "to-do",
            adapter: "bmad",
            source_path: `_bmad-output/stories/${bmadRef}.md`,
            source_hash: "a".repeat(64),
            depends_on: [],
            acceptance_criteria: [
                { text: "Given something, when something, then something works.", kind: "integration" },
            ],
            title: `Story ${bmadRef}`,
            narrative: "As a user, I want something so that I can use it.",
            withdrawn: false,
        };
        const { stringify: yamlStringify2 } = await import("yaml");
        await writeManifest(tmpRoot, "to-do", bmadRef, yamlStringify2(manifest, { lineWidth: 0 }));
        const result = await listClaimableTodos({ targetRepoRoot: tmpRoot });
        const bmadCandidate = result.todos.find((c) => c.ref === bmadRef);
        expect(bmadCandidate).toBeDefined();
        // bmad short handle is "8.18" (local part after colon)
        expect(bmadCandidate.shortHandle).toBe("8.18");
        expect(bmadCandidate.shortHandle).not.toBe(bmadRef);
    });
    it("does not include in-progress manifests in todos", async () => {
        const ref = "native:01HZABC0000000000000000001";
        // in-progress manifest has status: "in-progress", which isClaimable filters
        await writeManifest(tmpRoot, "in-progress", ref, makeManifest(ref, { status: "in-progress" }));
        // Also place a to-do/ entry for the same ref — should NOT happen in practice
        // but tests that the status field matters
        const ref2 = "native:01HZABC0000000000000000002";
        await writeManifest(tmpRoot, "to-do", ref2, makeManifest(ref2));
        const result = await listClaimableTodos({ targetRepoRoot: tmpRoot });
        expect(result.todos.length).toBe(1);
        expect(result.todos[0].ref).toBe(ref2);
        expect(result.inProgressCount).toBe(1);
    });
});
