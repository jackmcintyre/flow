/**
 * Cycle-state read helpers — Story native:01KT484NY4HCBPBTT6VEY1Q0CS.
 *
 * The active cycle's state is stored in a small JSON file at
 * `<targetRepoRoot>/.flow/cycle-state.json`.  The file is NOT inside
 * `.flow/state/` to avoid interference with the manifest scanner.
 *
 * Shape: `{ cycle_id: "<ULID>", opened_at: "<ISO-8601-UTC>" }`
 *
 * Absent file = no cycle has ever been opened (baseline behaviour: status
 * shows "none", retro returns full history).
 *
 * The file is always read fresh (no module-level cache) so concurrent readers
 * see the latest state without an in-process invalidation step.
 *
 * **Read-only.** This module only reads the cycle-state file.  Writes are
 * performed by `openCycle` (via `atomicWriteFile` from `lib/managed-fs.ts`)
 * to comply with the canonical-fs write guard.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const CycleStateSchema = z
  .object({
    /** Crockford-base32 ULID identifying the current cycle. */
    cycle_id: z.string().min(26).max(26),
    /**
     * ISO-8601 UTC timestamp at which `openCycle` opened this cycle.
     * All done manifests and telemetry events with a timestamp BEFORE
     * this value are excluded from the cycle-scoped retro window.
     */
    opened_at: z
      .string()
      .datetime({ offset: false })
      .refine((s) => s.endsWith("Z"), "must be UTC"),
  })
  .strict();

export type CycleState = z.infer<typeof CycleStateSchema>;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function cycleStateFilePath(targetRepoRoot: string): string {
  return path.join(targetRepoRoot, ".flow", "cycle-state.json");
}

export function cycleArchiveDir(targetRepoRoot: string): string {
  return path.join(targetRepoRoot, ".flow", "cycle-archive");
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Read the active cycle state. Returns `null` when the cycle-state file is
 * absent (no cycle has ever been opened — baseline behaviour).
 *
 * @throws {SyntaxError} When the file exists but is not valid JSON.
 * @throws {z.ZodError} When the JSON does not match `CycleStateSchema`.
 */
export async function readCycleState(
  targetRepoRoot: string,
): Promise<CycleState | null> {
  const filePath = cycleStateFilePath(targetRepoRoot);

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (isEnoent(err)) {
      return null;
    }
    throw err;
  }

  const parsed: unknown = JSON.parse(raw);
  return CycleStateSchema.parse(parsed);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}
