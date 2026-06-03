/**
 * Story native:01KT484NY4HCBPBTT6VEY1Q0CS — cycle boundary: open a new work
 * cycle and scope the retro to it.
 *
 * Covers all four ACs:
 *
 *   AC1 (integration): after `openCycle`, `getStatus` reports the cycle ULID
 *     instead of "none".
 *   AC2 (integration): with a cycle active, `gatherRetroInputs` returns only
 *     done manifests + telemetry events from after the cycle's open instant —
 *     not the work that completed before it opened.
 *   AC3 (integration): opening a new cycle over an active one writes the prior
 *     cycle's record (done manifests, retro proposals, telemetry summary) to a
 *     named archive file under `.flow/cycle-archive/` BEFORE the window resets.
 *   AC4 (unit): with no cycle ever opened, `getStatus` shows "none" and
 *     `gatherRetroInputs` returns all available history (baseline preserved).
 *
 * All writes route through the sanctioned `atomicWriteFile` seam (managed-fs)
 * so the static fs-write guard stays green without whitelisting this file. File
 * mtimes (a done manifest's completion instant) are set with `fs.utimes`, which
 * is read-shaped, not a banned write binding.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { atomicWriteFile } from "../../lib/managed-fs.js";
import { getStatus, renderStatus } from "../get-status.js";
import { gatherRetroInputs } from "../gather-retro-inputs.js";
import { openCycle } from "../open-cycle.js";
import { readCycleState } from "../../schemas/cycle-state.js";
// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------
let tmpRoot;
beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cycle-boundary-"));
    // getStatus resolves the workspace + active adapter. A minimal native
    // workspace config makes it resolve cleanly so the cycle field is the only
    // thing under test. The standards doc is intentionally absent (downgraded to
    // standards.state="missing", not a failure).
    await seedNativeWorkspace(tmpRoot);
});
afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
});
/**
 * Seed the minimum on-disk shape `getStatus` needs to resolve a native
 * workspace: a `.flow/config.yaml` naming the native adapter, and the
 * native-stories dir the adapter detects on. Mirrors the fixtures other
 * workspace-touching tests build.
 */
async function seedNativeWorkspace(root) {
    await atomicWriteFile(path.join(root, ".flow", "config.yaml"), yamlStringify({ adapter: "native" }, { lineWidth: 0 }));
    // The native adapter's detect() requires at least one ULID-named .md file in
    // native-stories/, so seed one to make getStatus resolve a healthy native
    // workspace (adapter.state = "ok") rather than a downgraded "mismatched".
    await atomicWriteFile(path.join(root, ".flow", "native-stories", "01KT484NY4HCBPBTT6VEY1Q0CS.md"), "# fixture story\n");
}
function buildDoneManifest(ref) {
    return {
        ref,
        status: "done",
        adapter: "native",
        source_path: `.flow/native-stories/${ref.replace("native:", "")}.md`,
        source_hash: "a".repeat(64),
        depends_on: [],
        acceptance_criteria: [{ text: "Given x, when y, then z.", kind: "integration" }],
        title: `Story ${ref}`,
        narrative: "As a user, I want X, so that Y.",
        withdrawn: false,
        claimed_by: "01KSRP1Y9J9R9F5SKB7QXQ83ZK",
    };
}
/**
 * Write a done/ manifest and stamp its mtime to `completedAtMs` — the file
 * mtime IS the completion instant the retro windows on.
 */
async function seedDoneManifest(ref, completedAtMs) {
    const absPath = path.join(tmpRoot, ".flow", "state", "done", `${ref}.yaml`);
    await atomicWriteFile(absPath, yamlStringify(buildDoneManifest(ref), { lineWidth: 0 }));
    const when = new Date(completedAtMs);
    await fs.utimes(absPath, when, when);
}
function agentInvokeLine(ts, story) {
    return JSON.stringify({
        ts,
        session_id: "01KSRP1Y9J9R9F5SKB7QXQ83ZK",
        agent: "generalist-dev",
        story_id: story,
        type: "agent.invoke",
        data: { runtime_ms: 1200 },
    });
}
async function seedTelemetry(fileName, lines) {
    await atomicWriteFile(path.join(tmpRoot, ".flow", "telemetry", fileName), lines.join("\n") + "\n");
}
async function seedProposal(isoStamp) {
    await atomicWriteFile(path.join(tmpRoot, ".flow", "retro-proposals", `${isoStamp}.md`), "# a proposal\n");
}
async function listArchiveFiles() {
    const dir = path.join(tmpRoot, ".flow", "cycle-archive");
    try {
        return (await fs.readdir(dir)).sort();
    }
    catch {
        return [];
    }
}
// ---------------------------------------------------------------------------
// AC1 — status reports the cycle ULID after openCycle
// ---------------------------------------------------------------------------
describe("AC1 — status shows the cycle ULID after opening a cycle", () => {
    it("getStatus reports 'none' before any cycle and the ULID after openCycle", async () => {
        const before = await getStatus({ targetRepoRoot: tmpRoot });
        expect(before.cycle).toBe("none");
        const result = await openCycle({ targetRepoRoot: tmpRoot });
        expect(result.cycleUlid).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
        const after = await getStatus({ targetRepoRoot: tmpRoot });
        expect(after.cycle).toBe(result.cycleUlid);
        // The rendered read-out carries the ULID, not 'none'.
        expect(renderStatus(after)).toContain(`cycle: ${result.cycleUlid}`);
        expect(renderStatus(after)).not.toContain("cycle: none");
    });
});
// ---------------------------------------------------------------------------
// AC2 — retro is scoped to the active cycle's window
// ---------------------------------------------------------------------------
describe("AC2 — retro inputs are scoped to the open cycle's window", () => {
    it("returns only done manifests + telemetry from after the cycle opened", async () => {
        // Two stories completed BEFORE the cycle opens, one AFTER.
        const cycleOpenMs = Date.parse("2026-06-01T00:00:00.000Z");
        const beforeMs = Date.parse("2026-05-15T00:00:00.000Z");
        const afterMs = Date.parse("2026-06-02T00:00:00.000Z");
        await seedDoneManifest("native:OLDSTORYA0000000000000001", beforeMs);
        await seedDoneManifest("native:OLDSTORYB0000000000000002", beforeMs);
        await seedDoneManifest("native:NEWSTORYC0000000000000003", afterMs);
        // Telemetry: two events before the boundary, one after.
        await seedTelemetry("2026-05.jsonl", [
            agentInvokeLine("2026-05-15T08:00:00.000Z", "native:OLDSTORYA0000000000000001"),
            agentInvokeLine("2026-05-16T08:00:00.000Z", "native:OLDSTORYB0000000000000002"),
        ]);
        await seedTelemetry("2026-06.jsonl", [
            agentInvokeLine("2026-06-02T08:00:00.000Z", "native:NEWSTORYC0000000000000003"),
        ]);
        // Open the cycle at the boundary instant (deterministic clock seam).
        await openCycle({
            targetRepoRoot: tmpRoot,
            now: () => new Date(cycleOpenMs),
        });
        const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });
        // Only the after-cycle story is in scope.
        expect(bundle.doneManifests.map((m) => m.ref)).toEqual([
            "native:NEWSTORYC0000000000000003",
        ]);
        // Only the after-cycle telemetry event is in scope. (The cycle.opened event
        // emitted by openCycle is stamped exactly at the boundary, so it is in scope
        // too — assert the pre-cycle events are gone and only post-boundary remain.)
        const inScopeStoryEvents = bundle.telemetrySummary.events.filter((e) => e.type === "agent.invoke");
        expect(inScopeStoryEvents.map((e) => e.story_id)).toEqual([
            "native:NEWSTORYC0000000000000003",
        ]);
        // Pre-boundary events are excluded, NOT counted as skipped (they are valid).
        expect(bundle.telemetrySummary.skipped_count).toBe(0);
    });
    it("a story completed exactly at the open instant is in scope (>= boundary)", async () => {
        const cycleOpenMs = Date.parse("2026-06-01T00:00:00.000Z");
        await seedDoneManifest("native:EXACTSTORY000000000000001", cycleOpenMs);
        await openCycle({
            targetRepoRoot: tmpRoot,
            now: () => new Date(cycleOpenMs),
        });
        const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });
        expect(bundle.doneManifests.map((m) => m.ref)).toEqual([
            "native:EXACTSTORY000000000000001",
        ]);
    });
});
// ---------------------------------------------------------------------------
// AC3 — prior cycle is archived before the window resets
// ---------------------------------------------------------------------------
describe("AC3 — the prior cycle's record is archived on the next open", () => {
    it("writes the prior cycle's manifests, proposals, and telemetry summary to .flow/cycle-archive/", async () => {
        // Cycle 1 opens, then a story completes + a proposal lands inside it.
        const cycle1OpenMs = Date.parse("2026-06-01T00:00:00.000Z");
        const firstOpen = await openCycle({
            targetRepoRoot: tmpRoot,
            now: () => new Date(cycle1OpenMs),
        });
        expect(firstOpen.priorCycleUlid).toBe(null);
        expect(firstOpen.archivePath).toBe(null);
        // First open has nothing to archive.
        expect(await listArchiveFiles()).toEqual([]);
        // Work inside cycle 1.
        const inCycle1Ms = Date.parse("2026-06-05T00:00:00.000Z");
        await seedDoneManifest("native:CYCLE1STORY00000000000001", inCycle1Ms);
        await seedTelemetry("2026-06.jsonl", [
            agentInvokeLine("2026-06-05T08:00:00.000Z", "native:CYCLE1STORY00000000000001"),
        ]);
        await seedProposal("2026-06-06T00:00:00.000Z");
        // Cycle 2 opens — this must archive cycle 1's record first.
        const cycle2OpenMs = Date.parse("2026-07-01T00:00:00.000Z");
        const secondOpen = await openCycle({
            targetRepoRoot: tmpRoot,
            now: () => new Date(cycle2OpenMs),
        });
        expect(secondOpen.priorCycleUlid).toBe(firstOpen.cycleUlid);
        expect(secondOpen.archivePath).not.toBe(null);
        // The archive file is named for the prior cycle and present on disk.
        const archives = await listArchiveFiles();
        expect(archives.length).toBe(1);
        expect(archives[0]).toContain(firstOpen.cycleUlid);
        // Its contents preserve cycle 1's record.
        const raw = await fs.readFile(secondOpen.archivePath, "utf8");
        const record = yamlParse(raw);
        expect(record.cycle_ulid).toBe(firstOpen.cycleUlid);
        expect(record.opened_at).toBe(firstOpen.openedAt);
        expect(record.closed_at).toBe(secondOpen.openedAt);
        expect(record.done_manifests.map((m) => m.ref)).toEqual([
            "native:CYCLE1STORY00000000000001",
        ]);
        expect(record.retro_proposals.map((p) => p.iso_timestamp)).toEqual([
            "2026-06-06T00:00:00.000Z",
        ]);
        // Cycle 1's telemetry: one work event + the cycle.opened event from the
        // first open (both at/after cycle 1's boundary, before cycle 2's).
        expect(record.telemetry_summary.event_count).toBeGreaterThanOrEqual(1);
        expect(record.telemetry_summary.skipped_count).toBe(0);
        // After the second open the active cycle has reset to cycle 2.
        const state = await readCycleState(tmpRoot);
        expect(state?.cycle_ulid).toBe(secondOpen.cycleUlid);
        const status = await getStatus({ targetRepoRoot: tmpRoot });
        expect(status.cycle).toBe(secondOpen.cycleUlid);
    });
});
// ---------------------------------------------------------------------------
// AC4 — no cycle ever opened: baseline preserved
// ---------------------------------------------------------------------------
describe("AC4 — no cycle ever opened preserves the baseline", () => {
    it("status shows 'none' and the retro returns all available history", async () => {
        // Seed history spanning a wide time range — none of it should be filtered
        // because no cycle boundary exists.
        await seedDoneManifest("native:HISTORYA00000000000000001", Date.parse("2026-01-01T00:00:00.000Z"));
        await seedDoneManifest("native:HISTORYB00000000000000002", Date.parse("2026-05-01T00:00:00.000Z"));
        await seedTelemetry("2026-01.jsonl", [
            agentInvokeLine("2026-01-01T08:00:00.000Z", "native:HISTORYA00000000000000001"),
        ]);
        await seedTelemetry("2026-05.jsonl", [
            agentInvokeLine("2026-05-01T08:00:00.000Z", "native:HISTORYB00000000000000002"),
        ]);
        // No openCycle call — cycle-state.json never written.
        const status = await getStatus({ targetRepoRoot: tmpRoot });
        expect(status.cycle).toBe("none");
        const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot });
        // ALL history is present — nothing is windowed out.
        expect(bundle.doneManifests.map((m) => m.ref).sort()).toEqual([
            "native:HISTORYA00000000000000001",
            "native:HISTORYB00000000000000002",
        ]);
        expect(bundle.telemetrySummary.events.length).toBe(2);
        expect(bundle.telemetrySummary.skipped_count).toBe(0);
    });
    it("an explicit cycleState: null forces the full-history baseline regardless of disk", async () => {
        await seedDoneManifest("native:STORYONLY000000000000001", Date.parse("2026-03-01T00:00:00.000Z"));
        // Open a cycle AFTER that story, so the on-disk boundary would normally
        // exclude it...
        await openCycle({
            targetRepoRoot: tmpRoot,
            now: () => new Date(Date.parse("2026-06-01T00:00:00.000Z")),
        });
        // ...but an explicit null override forces the baseline (the story is kept).
        const bundle = await gatherRetroInputs({ targetRepoRoot: tmpRoot, cycleState: null });
        expect(bundle.doneManifests.map((m) => m.ref)).toContain("native:STORYONLY000000000000001");
    });
});
