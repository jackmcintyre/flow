/**
 * `openCycle` MCP/CLI tool — Story native:01KT484NY4HCBPBTT6VEY1Q0CS
 * (the cycle-boundary work deferred by Story 6.12).
 *
 * Opens a new work cycle: mints a fresh cycle ULID, archives the prior cycle's
 * record (if a cycle was active) BEFORE the active window resets, overwrites the
 * cycle-state file with the new cycle, and emits one `cycle.opened` telemetry
 * event. After this returns:
 *
 *   - `getStatus` reports the new cycle ULID instead of `"none"` (AC1).
 *   - `gatherRetroInputs` scopes its bundle to work completed at or after the
 *     new cycle's `opened_at` (AC2).
 *   - the prior cycle's done manifests, retro proposals, and a telemetry summary
 *     are preserved in `.flow/cycle-archive/<prior-ulid>-<iso>.yaml` (AC3) —
 *     history is not discarded.
 *
 * The cycle-state file lives at `.flow/cycle-state.json` and the archive under
 * `.flow/cycle-archive/` — both OUTSIDE `.flow/state/`, so the scanner never
 * mistakes them for execution manifests.
 *
 * **Ordering is load-bearing:** the prior cycle is archived FIRST (while
 * `cycle-state.json` still names it, so `gatherRetroInputs` windows correctly),
 * and only then is `cycle-state.json` overwritten. A crash between the two
 * leaves the archive written and the old cycle still active — re-running
 * `openCycle` simply archives again (idempotent in effect; the archive filename
 * carries a fresh ISO so a re-run writes a sibling rather than clobbering).
 */

import * as path from "node:path";
import { stringify as yamlStringify } from "yaml";
import { ulid } from "ulid";
import { atomicWriteFile } from "../lib/managed-fs.js";
import { logTelemetryEvent } from "../lib/logger.js";
import {
  readCycleState,
  cycleStatePath,
  type CycleState,
} from "../schemas/cycle-state.js";
import { gatherRetroInputs } from "./gather-retro-inputs.js";

export interface OpenCycleOptions {
  /** Absolute path to the target repository root. */
  targetRepoRoot: string;
  /**
   * Session ULID stamped onto the `cycle.opened` telemetry event's
   * `session_id`. Optional — when absent the new cycle ULID is reused so the
   * event is always well-formed (`session_id` requires min-1 length).
   */
  sessionUlid?: string;
  /**
   * Clock seam. Defaults to `() => new Date()`. Injected by tests for a
   * deterministic `opened_at` / archive filename.
   */
  now?: () => Date;
}

export interface OpenCycleResult {
  /** The freshly-minted, now-active cycle ULID. */
  cycleUlid: string;
  /** ISO-8601 UTC instant the cycle was opened (the window boundary). */
  openedAt: string;
  /** The cycle that was active before this open, or `null` on the first open. */
  priorCycleUlid: string | null;
  /**
   * Absolute path to the prior cycle's archive file, or `null` when there was
   * no prior cycle to archive (the first open).
   */
  archivePath: string | null;
}

/**
 * Filesystem-safe rendering of an ISO timestamp for the archive filename —
 * colons are illegal on some filesystems, so `2026-06-03T12:00:00.000Z`
 * becomes `2026-06-03T12-00-00-000Z`.
 */
function isoForFilename(iso: string): string {
  return iso.replace(/[:.]/g, "-");
}

/**
 * Open a new work cycle. See module JSDoc for full behaviour.
 *
 * @returns `{ cycleUlid, openedAt, priorCycleUlid, archivePath }`.
 */
export async function openCycle(
  opts: OpenCycleOptions,
): Promise<OpenCycleResult> {
  const { targetRepoRoot } = opts;
  const now = opts.now ?? (() => new Date());

  const openedAt = now().toISOString();
  const cycleUlid = ulid();

  // Step 1: read the prior cycle (if any). This is the window the archive
  // captures and the value reported on the telemetry event.
  const priorCycle = await readCycleState(targetRepoRoot);

  // Step 2: archive the prior cycle's record BEFORE the window resets (AC3).
  // Only when a cycle was actually active — the first-ever open has nothing to
  // archive (AC4 baseline preserved: no archive, no prior cycle).
  let archivePath: string | null = null;
  if (priorCycle !== null) {
    archivePath = await archivePriorCycle(targetRepoRoot, priorCycle, openedAt);
  }

  // Step 3: overwrite the cycle-state file with the new cycle (atomic). After
  // this, getStatus reports the new ULID and gatherRetroInputs windows to it.
  const newState: CycleState = { cycle_ulid: cycleUlid, opened_at: openedAt };
  await atomicWriteFile(
    cycleStatePath(targetRepoRoot),
    JSON.stringify(newState, null, 2) + "\n",
  );

  // Step 4: emit exactly one cycle.opened telemetry event (NFR14 — surfacing
  // fields only). The logger stamps its own `ts`; we pass `openedAt` so the
  // event timestamp matches the cycle boundary deterministically.
  await logTelemetryEvent({
    targetRepoRoot,
    event: {
      ts: openedAt,
      type: "cycle.opened",
      session_id: opts.sessionUlid ?? cycleUlid,
      agent: "orchestrator",
      data: {
        cycle_ulid: cycleUlid,
        prior_cycle_ulid: priorCycle?.cycle_ulid ?? null,
        archived: archivePath !== null,
      },
    },
  });

  return {
    cycleUlid,
    openedAt,
    priorCycleUlid: priorCycle?.cycle_ulid ?? null,
    archivePath,
  };
}

/**
 * Write the prior cycle's record to `.flow/cycle-archive/<ulid>-<iso>.yaml`.
 *
 * The record captures the prior cycle's done manifests, retro-proposal paths,
 * and a telemetry summary — gathered through `gatherRetroInputs` scoped to the
 * prior cycle's own window (the cycle-state file still names the prior cycle at
 * this point, but we pass it explicitly so the scoping is unambiguous). The
 * archive filename carries both the prior cycle ULID and the (new) open instant
 * so concurrent / repeated opens never clobber an existing archive.
 *
 * @returns the absolute path of the written archive file.
 */
async function archivePriorCycle(
  targetRepoRoot: string,
  priorCycle: CycleState,
  openedAt: string,
): Promise<string> {
  // Gather the prior cycle's window. Passing `priorCycle` explicitly forces the
  // scoping to the prior cycle regardless of what is on disk.
  const inputs = await gatherRetroInputs({
    targetRepoRoot,
    cycleState: priorCycle,
  });

  const archiveRecord = {
    cycle_ulid: priorCycle.cycle_ulid,
    opened_at: priorCycle.opened_at,
    closed_at: openedAt,
    done_manifests: inputs.doneManifests,
    retro_proposals: inputs.priorProposals.map((p) => ({
      // Store repo-relative paths so the archive is portable.
      path: path.relative(targetRepoRoot, p.path),
      iso_timestamp: p.iso_timestamp,
    })),
    telemetry_summary: {
      event_count: inputs.telemetrySummary.events.length,
      skipped_count: inputs.telemetrySummary.skipped_count,
    },
  };

  const fileName = `${priorCycle.cycle_ulid}-${isoForFilename(openedAt)}.yaml`;
  const absPath = path.join(targetRepoRoot, ".flow", "cycle-archive", fileName);

  await atomicWriteFile(absPath, yamlStringify(archiveRecord, { lineWidth: 0 }));

  return absPath;
}
