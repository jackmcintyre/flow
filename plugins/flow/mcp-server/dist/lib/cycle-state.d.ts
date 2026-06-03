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
import { z } from "zod";
export declare const CycleStateSchema: z.ZodObject<{
    cycle_id: z.ZodString;
    opened_at: z.ZodString;
}, z.core.$strict>;
export type CycleState = z.infer<typeof CycleStateSchema>;
export declare function cycleStateFilePath(targetRepoRoot: string): string;
export declare function cycleArchiveDir(targetRepoRoot: string): string;
/**
 * Read the active cycle state. Returns `null` when the cycle-state file is
 * absent (no cycle has ever been opened — baseline behaviour).
 *
 * @throws {SyntaxError} When the file exists but is not valid JSON.
 * @throws {z.ZodError} When the JSON does not match `CycleStateSchema`.
 */
export declare function readCycleState(targetRepoRoot: string): Promise<CycleState | null>;
