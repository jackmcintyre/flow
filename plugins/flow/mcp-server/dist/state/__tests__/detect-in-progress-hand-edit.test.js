/**
 * Unit tests for `detectInProgressHandEdit` — Story 3.7 Task 3.1, narrowed by Story 5.29.
 *
 * **Story 5.29 — manifest-only baseline.** The check now reads its baseline from a
 * claim-time sidecar at `.flow/state/in-progress/<ref>.snapshot.yaml`. It no longer
 * accepts `sourceHash`/`sourceFields` parameters. Tests seed both the in-progress
 * manifest AND the sidecar to model what `claimStory` writes.
 *
 * Covers:
 *   (c1) hand-edit `title` only → InProgressHandEditError with changedFields:["title"]
 *   (c2) hand-edit `acceptance_criteria` (reorder) → detection via order-sensitive deep-equal
 *   (c3) hand-edit `withdrawn: false → true` → detection
 *   (c4) manifest source_hash drift from sidecar → detection (operator-tampered manifest)
 *   (c5) Story 5.29 regression — source story edit, manifest untouched → { ok: true }
 *   (c6) sidecar missing → InProgressHandEditError with changedFields:["_snapshot_missing"]
 *   (d)  no edit, no drift → { ok: true }
 *
 * Each test seeds a tmpdir with an `in-progress/<ref>.yaml` manifest plus its
 * `<ref>.snapshot.yaml` sidecar, then either mutates the manifest (operator hand-edit)
 * or leaves it intact, then calls `detectInProgressHandEdit` directly.
 *
 * Pure deterministic — no LLM invocation, no network.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { InProgressHandEditError, ManifestNotFoundError, MalformedExecutionManifestError } from "../../errors.js";
import { detectInProgressHandEdit, writeInProgressSnapshot, removeInProgressSnapshot, } from "../manifest-state-machine.js";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const REF = "native:01HZTEST0000000000000001";
/**
 * Canonical manifest content that matches a given sourceHash and sourceFields.
 * This is what scan-sources would write — the "canonical baseline".
 */
function makeManifest(sourceHash, sourceFields) {
    return {
        ref: REF,
        status: "to-do",
        adapter: "native",
        source_path: ".flow/native-stories/01HZTEST0000000000000000001.md",
        source_hash: sourceHash,
        depends_on: sourceFields.depends_on,
        acceptance_criteria: sourceFields.acceptance_criteria,
        title: sourceFields.title,
        narrative: sourceFields.narrative,
        implementation_notes: sourceFields.implementation_notes,
        withdrawn: sourceFields.withdrawn,
        ready: false,
    };
}
const CANONICAL_SOURCE_HASH = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
const CANONICAL_SOURCE_FIELDS = {
    title: "My feature story",
    narrative: "As a user, I want the feature so that I can use it.",
    acceptance_criteria: [
        {
            text: "Given the feature is live, when I access it, then it works correctly.",
            kind: "integration",
        },
        {
            text: "Given I am logged in, when I click the button, then the result appears.",
            kind: "unit",
        },
    ],
    implementation_notes: "Wire up the handler in the main module.",
    depends_on: ["native:01HZPREV0000000000000001"],
    withdrawn: false,
};
async function seedInProgressManifest(root, manifest) {
    const dir = path.join(root, ".flow", "state", "in-progress");
    await fs.mkdir(dir, { recursive: true });
    const absPath = path.join(dir, `${REF}.yaml`);
    const text = yamlStringify(manifest, { lineWidth: 0 });
    await atomicWriteFile(absPath, text);
    return absPath;
}
/**
 * Story 5.29 helper: seed the claim-time sidecar that `detectInProgressHandEdit`
 * reads as its baseline. The sidecar mirrors the manifest at the moment of claim.
 */
async function seedSidecar(root, manifest) {
    await writeInProgressSnapshot({ targetRepoRoot: root, ref: REF, manifest });
}
async function mutateManifest(absPath, mutate) {
    const raw = await fs.readFile(absPath, "utf8");
    const obj = yamlParse(raw);
    mutate(obj);
    const newText = yamlStringify(obj, { lineWidth: 0 });
    await atomicWriteFile(absPath, newText);
}
// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
let scratch;
beforeEach(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "flow-detect-inprogress-"));
});
afterEach(async () => {
    await fs.rm(scratch, { recursive: true, force: true });
});
// ---------------------------------------------------------------------------
// (c1) hand-edit title only
// ---------------------------------------------------------------------------
describe("detectInProgressHandEdit (c1) — hand-edit title only", () => {
    it("throws InProgressHandEditError with changedFields:[title]", async () => {
        const manifest = makeManifest(CANONICAL_SOURCE_HASH, CANONICAL_SOURCE_FIELDS);
        const absPath = await seedInProgressManifest(scratch, manifest);
        await seedSidecar(scratch, manifest);
        // Operator edits the title in their text editor.
        await mutateManifest(absPath, (obj) => {
            obj["title"] = "My feature story — EDITED";
        });
        const err = await detectInProgressHandEdit({
            targetRepoRoot: scratch,
            ref: REF,
        }).catch((e) => e);
        expect(err).toBeInstanceOf(InProgressHandEditError);
        const typed = err;
        expect(typed.changedFields).toContain("title");
        expect(typed.changedFields).toHaveLength(1);
        expect(typed.ref).toBe(REF);
        expect(typed.absPath).toBe(absPath);
        // Verify verbatim AC3 diagnostic shape.
        expect(typed.message).toMatch(/^Refusing: .+ in in-progress\/ has been hand-edited \(fields: .+\)\./);
        expect(typed.message).toContain("v1 does not support editing stories mid-flight");
        expect(typed.message).toContain("/flow:plan");
    });
});
// ---------------------------------------------------------------------------
// (c2) hand-edit acceptance_criteria (reorder) — order-sensitive deep-equal
// ---------------------------------------------------------------------------
describe("detectInProgressHandEdit (c2) — acceptance_criteria reorder detected", () => {
    it("throws InProgressHandEditError with changedFields:[acceptance_criteria]", async () => {
        const manifest = makeManifest(CANONICAL_SOURCE_HASH, CANONICAL_SOURCE_FIELDS);
        await seedInProgressManifest(scratch, manifest);
        await seedSidecar(scratch, manifest);
        // Operator swaps the two ACs — changing their order.
        const absPath = path.join(scratch, ".flow", "state", "in-progress", `${REF}.yaml`);
        await mutateManifest(absPath, (obj) => {
            const acs = obj["acceptance_criteria"];
            // Reverse the AC order.
            obj["acceptance_criteria"] = [acs[1], acs[0]];
        });
        const err = await detectInProgressHandEdit({
            targetRepoRoot: scratch,
            ref: REF,
        }).catch((e) => e);
        expect(err).toBeInstanceOf(InProgressHandEditError);
        const typed = err;
        expect(typed.changedFields).toContain("acceptance_criteria");
    });
});
// ---------------------------------------------------------------------------
// (c3) hand-edit withdrawn: false → true
// ---------------------------------------------------------------------------
describe("detectInProgressHandEdit (c3) — withdrawn flip detected", () => {
    it("throws InProgressHandEditError with changedFields:[withdrawn]", async () => {
        const manifest = makeManifest(CANONICAL_SOURCE_HASH, CANONICAL_SOURCE_FIELDS);
        await seedInProgressManifest(scratch, manifest);
        await seedSidecar(scratch, manifest);
        const absPath = path.join(scratch, ".flow", "state", "in-progress", `${REF}.yaml`);
        await mutateManifest(absPath, (obj) => {
            obj["withdrawn"] = true;
        });
        const err = await detectInProgressHandEdit({
            targetRepoRoot: scratch,
            ref: REF,
        }).catch((e) => e);
        expect(err).toBeInstanceOf(InProgressHandEditError);
        const typed = err;
        expect(typed.changedFields).toContain("withdrawn");
    });
});
// ---------------------------------------------------------------------------
// (c4) manifest source_hash drift from sidecar — operator-tampered manifest
// ---------------------------------------------------------------------------
describe("detectInProgressHandEdit (c4) — manifest source_hash drift from sidecar detected", () => {
    it("throws InProgressHandEditError with changedFields:[source_hash]", async () => {
        const manifest = makeManifest(CANONICAL_SOURCE_HASH, CANONICAL_SOURCE_FIELDS);
        await seedInProgressManifest(scratch, manifest);
        await seedSidecar(scratch, manifest);
        // Operator hand-edits source_hash in the in-progress manifest.
        // Under Story 5.29 this is a manifest-vs-sidecar drift, which IS a hand-edit
        // signal (the operator tampered with state-machine bookkeeping). Source-hash
        // drift between the manifest and the LIVE source story is no longer the trigger
        // (see (c5) below).
        const absPath = path.join(scratch, ".flow", "state", "in-progress", `${REF}.yaml`);
        await mutateManifest(absPath, (obj) => {
            obj["source_hash"] =
                "ffff1111ffff1111ffff1111ffff1111ffff1111ffff1111ffff1111ffff1111";
        });
        const err = await detectInProgressHandEdit({
            targetRepoRoot: scratch,
            ref: REF,
        }).catch((e) => e);
        expect(err).toBeInstanceOf(InProgressHandEditError);
        const typed = err;
        expect(typed.changedFields).toContain("source_hash");
    });
});
// ---------------------------------------------------------------------------
// (c5) Story 5.29 regression — source story edit, manifest untouched → ok
// ---------------------------------------------------------------------------
describe("detectInProgressHandEdit (c5) — Story 5.29 regression: source-story edit does not trip the guard", () => {
    it("returns { ok: true } when the source story would have a different source_hash but the manifest+sidecar are intact", async () => {
        // This case is the exact failure mode from PR #176 / bmad:6.1 close-out.
        // Under the OLD (Story 4.1) contract, the check re-read the source story via
        // the active adapter to derive `{ sourceHash, sourceFields }`. When the dev
        // legitimately edited the source story's `## Implementation Notes` (which the
        // story-spec placeholder instructs them to do), the recomputed source_hash
        // and implementation_notes would differ from the manifest, and the check would
        // throw InProgressHandEditError.
        //
        // Under the NEW (Story 5.29) contract, the check reads its baseline from the
        // sidecar — not the source story. So even if the source story has been edited
        // (and would produce a different source_hash if scan-sources re-ran), the
        // check sees manifest === sidecar and passes.
        const manifest = makeManifest(CANONICAL_SOURCE_HASH, CANONICAL_SOURCE_FIELDS);
        await seedInProgressManifest(scratch, manifest);
        await seedSidecar(scratch, manifest);
        // No mutation to the in-progress manifest. No sidecar mutation. The "source
        // story has been edited" condition is implicit — the check never reads the
        // source story at all under Story 5.29, so it does not matter what the source
        // file on disk says. This is the regression guard: the check MUST succeed in
        // this configuration.
        const result = await detectInProgressHandEdit({
            targetRepoRoot: scratch,
            ref: REF,
        });
        expect(result).toEqual({ ok: true });
    });
});
// ---------------------------------------------------------------------------
// (c6) sidecar missing
// ---------------------------------------------------------------------------
describe("detectInProgressHandEdit (c6) — sidecar missing", () => {
    it("throws InProgressHandEditError with changedFields:[_snapshot_missing]", async () => {
        const manifest = makeManifest(CANONICAL_SOURCE_HASH, CANONICAL_SOURCE_FIELDS);
        await seedInProgressManifest(scratch, manifest);
        // Deliberately do NOT seed the sidecar.
        const err = await detectInProgressHandEdit({
            targetRepoRoot: scratch,
            ref: REF,
        }).catch((e) => e);
        expect(err).toBeInstanceOf(InProgressHandEditError);
        const typed = err;
        expect(typed.changedFields).toEqual(["_snapshot_missing"]);
    });
});
// ---------------------------------------------------------------------------
// (d) no edit, no drift → { ok: true }
// ---------------------------------------------------------------------------
describe("detectInProgressHandEdit (d) — no edit, no drift → { ok: true }", () => {
    it("returns { ok: true } when manifest matches sidecar exactly", async () => {
        const manifest = makeManifest(CANONICAL_SOURCE_HASH, CANONICAL_SOURCE_FIELDS);
        await seedInProgressManifest(scratch, manifest);
        await seedSidecar(scratch, manifest);
        const result = await detectInProgressHandEdit({
            targetRepoRoot: scratch,
            ref: REF,
        });
        expect(result).toEqual({ ok: true });
    });
});
// ---------------------------------------------------------------------------
// ManifestNotFoundError when ref not in in-progress/
// ---------------------------------------------------------------------------
describe("detectInProgressHandEdit — non-existent ref", () => {
    it("throws ManifestNotFoundError when the manifest file does not exist", async () => {
        await expect(detectInProgressHandEdit({
            targetRepoRoot: scratch,
            ref: "native:does-not-exist",
        })).rejects.toBeInstanceOf(ManifestNotFoundError);
    });
});
// ---------------------------------------------------------------------------
// field list in error is alphabetically sorted (determinism)
// ---------------------------------------------------------------------------
describe("detectInProgressHandEdit — alphabetically sorted field list in error", () => {
    it("changedFields list in error message is sorted alphabetically", async () => {
        const manifest = makeManifest(CANONICAL_SOURCE_HASH, CANONICAL_SOURCE_FIELDS);
        await seedInProgressManifest(scratch, manifest);
        await seedSidecar(scratch, manifest);
        const absPath = path.join(scratch, ".flow", "state", "in-progress", `${REF}.yaml`);
        // Edit title and narrative simultaneously.
        await mutateManifest(absPath, (obj) => {
            obj["title"] = "Edited title";
            obj["narrative"] = "Edited narrative";
        });
        const err = await detectInProgressHandEdit({
            targetRepoRoot: scratch,
            ref: REF,
        }).catch((e) => e);
        expect(err).toBeInstanceOf(InProgressHandEditError);
        const typed = err;
        expect(typed.changedFields).toContain("title");
        expect(typed.changedFields).toContain("narrative");
        // The message should list fields in alphabetical order.
        const fieldListMatch = typed.message.match(/\(fields: ([^)]+)\)/);
        expect(fieldListMatch).not.toBeNull();
        const fields = fieldListMatch[1].split(", ");
        const sorted = [...fields].sort();
        expect(fields).toEqual(sorted);
    });
});
// ---------------------------------------------------------------------------
// MalformedExecutionManifestError propagates unchanged
// ---------------------------------------------------------------------------
describe("detectInProgressHandEdit — malformed manifest propagates MalformedExecutionManifestError", () => {
    it("throws MalformedExecutionManifestError when the in-progress manifest is invalid", async () => {
        const manifest = makeManifest(CANONICAL_SOURCE_HASH, CANONICAL_SOURCE_FIELDS);
        await seedInProgressManifest(scratch, manifest);
        await seedSidecar(scratch, manifest);
        const absPath = path.join(scratch, ".flow", "state", "in-progress", `${REF}.yaml`);
        // Remove the required `title` field to make the manifest malformed.
        await mutateManifest(absPath, (obj) => {
            delete obj["title"];
        });
        await expect(detectInProgressHandEdit({
            targetRepoRoot: scratch,
            ref: REF,
        })).rejects.toBeInstanceOf(MalformedExecutionManifestError);
    });
});
// ---------------------------------------------------------------------------
// Sidecar lifecycle — writeInProgressSnapshot + removeInProgressSnapshot
// ---------------------------------------------------------------------------
describe("writeInProgressSnapshot + removeInProgressSnapshot (Story 5.29 lifecycle)", () => {
    it("writes the sidecar at the canonical path and removes it on completion", async () => {
        const manifest = makeManifest(CANONICAL_SOURCE_HASH, CANONICAL_SOURCE_FIELDS);
        await seedInProgressManifest(scratch, manifest);
        const { absPath: sidecarAbs } = await writeInProgressSnapshot({
            targetRepoRoot: scratch,
            ref: REF,
            manifest,
        });
        expect(sidecarAbs).toBe(path.join(scratch, ".flow", "state", "in-progress", `${REF}.snapshot.yaml`));
        // The sidecar is parseable YAML containing the operator-editable fields + source_hash.
        const raw = await fs.readFile(sidecarAbs, "utf8");
        const parsed = yamlParse(raw);
        expect(parsed["source_hash"]).toBe(CANONICAL_SOURCE_HASH);
        expect(parsed["title"]).toBe(CANONICAL_SOURCE_FIELDS.title);
        expect(parsed["implementation_notes"]).toBe(CANONICAL_SOURCE_FIELDS.implementation_notes);
        // Completion-time removal is best-effort and successful on a present sidecar.
        await removeInProgressSnapshot({ targetRepoRoot: scratch, ref: REF });
        await expect(fs.stat(sidecarAbs)).rejects.toMatchObject({ code: "ENOENT" });
        // Idempotent — removing a missing sidecar is a no-op.
        await expect(removeInProgressSnapshot({ targetRepoRoot: scratch, ref: REF })).resolves.toBeUndefined();
    });
});
