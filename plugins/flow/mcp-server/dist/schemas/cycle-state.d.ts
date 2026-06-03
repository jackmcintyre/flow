import { z } from "zod";
/**
 * On-disk shape of `.flow/cycle-state.json`. Strict — an unknown key is a bug
 * (a hand-edit or a forward-incompatible writer), not a silently-tolerated
 * extension.
 *
 *   - `cycle_ulid` — the open cycle's identifier, minted by `openCycle`.
 *   - `opened_at`  — ISO-8601 UTC timestamp (Z-suffixed) of when the cycle was
 *                    opened. This is the window boundary: the retro includes
 *                    work completed at or after this instant.
 */
export declare const CycleStateSchema: z.ZodObject<{
    cycle_ulid: z.ZodString;
    opened_at: z.ZodString;
}, z.core.$strict>;
export type CycleState = z.infer<typeof CycleStateSchema>;
/** Resolve the absolute cycle-state path for a target repo. */
export declare function cycleStatePath(targetRepoRoot: string): string;
/**
 * Read and validate the cycle-state file.
 *
 * Returns the parsed `CycleState` when the file exists and is valid, or `null`
 * when the file is absent (the legitimate "no cycle ever opened" baseline). A
 * present-but-malformed file is a hard stop — it raises the Zod error so a
 * corrupt boundary cannot silently widen the retro window back to all-history.
 *
 * @throws {z.ZodError} When the file exists but fails schema validation.
 * @throws {SyntaxError} When the file exists but is not valid JSON.
 */
export declare function readCycleState(targetRepoRoot: string): Promise<CycleState | null>;
