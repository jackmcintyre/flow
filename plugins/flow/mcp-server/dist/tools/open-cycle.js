/**
 * `openCycle` MCP tool — Story native:01KT484NY4HCBPBTT6VEY1Q0CS.
 *
 * Opens a new work cycle. Each cycle is identified by a ULID and has an
 * `opened_at` timestamp that the retro gathers against — done manifests and
 * telemetry events from BEFORE `opened_at` are excluded from the retro's input
 * bundle, so each retrospective reasons only over work completed in the current
 * cycle.
 *
 * Behaviour:
 *  1. Read the current cycle-state file (`.flow/cycle-state.json`).
 *  2. If a prior cycle is active, archive it first:
 *       - Gather the prior cycle's done-manifest refs and retro-proposal paths.
 *       - Build a brief telemetry summary (event count for the prior window).
 *       - Write a YAML archive record to
 *         `.flow/cycle-archive/<prior-cycle-id>-<iso>.yaml`.
 *  3. Mint a new cycle ULID and record `opened_at = now`.
 *  4. Write the new cycle state to `.flow/cycle-state.json` via `atomicWriteFile`
 *     (the canonical write seam for non-state-machine files).
 *  5. Emit a `cycle.opened` telemetry event.
 *  6. Return `{ ok: true, cycleId, openedAt, archivedPriorCycleId }`.
 *
 * Idempotency note: re-opening a cycle (calling again immediately) creates a
 * brand-new cycle ULID each time — there is no idempotency key.  The operator
 * is responsible for not opening unnecessary cycles.
 *
 * **Writes route through `atomicWriteFile`** (from `lib/managed-fs.ts`) rather
 * than raw fs write/rename APIs so the canonical-fs write guard
 * (tests/canonical-fs-guard.test.ts) stays green.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { ulid } from "ulid";
import { logTelemetryEvent } from "../lib/logger.js";
import { atomicWriteFile } from "../lib/managed-fs.js";
import { readCycleState, cycleStateFilePath, cycleArchiveDir, } from "../lib/cycle-state.js";
// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------
/**
 * Open a new work cycle.
 *
 * @throws When the archive write fails or the telemetry event cannot be logged.
 */
export async function openCycle(opts) {
    const { targetRepoRoot, sessionUlid } = opts;
    const nowFn = opts.now ?? (() => new Date());
    // Step 1: Read prior cycle state.
    const priorState = await readCycleState(targetRepoRoot);
    // Step 2: Archive prior cycle if one is active.
    let archivedPriorCycleId = null;
    if (priorState !== null) {
        await archivePriorCycle(targetRepoRoot, priorState, nowFn);
        archivedPriorCycleId = priorState.cycle_id;
    }
    // Step 3: Mint new cycle.
    const cycleId = ulid();
    const openedAt = nowFn().toISOString();
    // Step 4: Persist new cycle state via atomicWriteFile (canonical write seam).
    const newState = { cycle_id: cycleId, opened_at: openedAt };
    const stateFilePath = cycleStateFilePath(targetRepoRoot);
    await atomicWriteFile(stateFilePath, JSON.stringify(newState, null, 2) + "\n");
    // Step 5: Emit telemetry.
    await logTelemetryEvent({
        targetRepoRoot,
        event: {
            type: "cycle.opened",
            session_id: sessionUlid,
            agent: "operator",
            data: {
                cycle_id: cycleId,
                prior_cycle_id: archivedPriorCycleId,
            },
        },
        now: nowFn,
    });
    return { ok: true, cycleId, openedAt, archivedPriorCycleId };
}
// ---------------------------------------------------------------------------
// Archive helper
// ---------------------------------------------------------------------------
/**
 * Write a YAML archive record for the prior cycle to
 * `.flow/cycle-archive/<prior-cycle-id>-<iso>.yaml`.
 *
 * The archive record is a lightweight summary:
 *   - refs of all `done/` manifests present at archive time
 *   - paths of all retro-proposals present at archive time
 *   - total telemetry line count from the telemetry directory
 *
 * This is a best-effort summary written at the moment of cycle transition.
 * The actual cycle-scoped filtering for the CURRENT cycle is done at retro
 * time via `gatherRetroInputs`.
 *
 * Writes via `atomicWriteFile` (canonical seam — no raw fs write APIs).
 */
async function archivePriorCycle(targetRepoRoot, priorState, nowFn) {
    const archiveDir = cycleArchiveDir(targetRepoRoot);
    // Gather done/ manifest refs.
    const doneManifestRefs = await gatherDoneManifestRefs(targetRepoRoot);
    // Gather retro-proposal paths.
    const retroProposalPaths = await gatherRetroProposalPaths(targetRepoRoot);
    // Count telemetry events.
    const telemetryEventCount = await countTelemetryLines(targetRepoRoot);
    const archiveRecord = {
        prior_cycle_id: priorState.cycle_id,
        archived_at: nowFn().toISOString(),
        done_manifest_refs: doneManifestRefs,
        retro_proposal_paths: retroProposalPaths,
        telemetry_event_count: telemetryEventCount,
    };
    // Sanitise the ISO timestamp for use in a filename: replace colons + dots.
    const isoSafe = nowFn().toISOString().replace(/[:.]/g, "-");
    const archiveFileName = `${priorState.cycle_id}-${isoSafe}.yaml`;
    const archivePath = path.join(archiveDir, archiveFileName);
    // Write via atomicWriteFile (canonical seam — no raw fs write APIs).
    await atomicWriteFile(archivePath, yamlStringify(archiveRecord));
}
// ---------------------------------------------------------------------------
// Small readers used only by the archive step
// ---------------------------------------------------------------------------
async function gatherDoneManifestRefs(targetRepoRoot) {
    const doneDir = path.join(targetRepoRoot, ".flow", "state", "done");
    let entries;
    try {
        entries = await fs.readdir(doneDir);
    }
    catch {
        return [];
    }
    return entries
        .filter((f) => f.endsWith(".yaml") && !f.endsWith(".snapshot.yaml"))
        .sort()
        .map((f) => f.slice(0, -".yaml".length));
}
async function gatherRetroProposalPaths(targetRepoRoot) {
    const proposalsDir = path.join(targetRepoRoot, ".flow", "retro-proposals");
    let entries;
    try {
        entries = await fs.readdir(proposalsDir);
    }
    catch {
        return [];
    }
    return entries
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map((f) => path.join(proposalsDir, f));
}
async function countTelemetryLines(targetRepoRoot) {
    const telemetryDir = path.join(targetRepoRoot, ".flow", "telemetry");
    let entries;
    try {
        entries = await fs.readdir(telemetryDir);
    }
    catch {
        return 0;
    }
    const files = entries.filter((f) => f.endsWith(".jsonl")).sort();
    let count = 0;
    for (const file of files) {
        try {
            const raw = await fs.readFile(path.join(telemetryDir, file), "utf8");
            const lines = raw.split("\n").filter((l) => l.trim() !== "");
            count += lines.length;
        }
        catch {
            // Skip unreadable files.
        }
    }
    return count;
}
