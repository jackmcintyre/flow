import { z } from "zod";
import { promises as fs } from "node:fs";
import * as path from "node:path";
/**
 * Cycle-state file schema + reader — Story native:01KT484NY4HCBPBTT6VEY1Q0CS
 * (FR — cycle boundary, the work deferred by Story 6.12).
 *
 * The cycle-state file is the single source of truth for "which work cycle is
 * currently open". It lives at `<targetRepoRoot>/.flow/cycle-state.json` — a
 * small JSON file (NOT inside `.flow/state/`, so the scanner never mistakes it
 * for an execution manifest). Two readers consume it:
 *
 *   - `getStatus` — reports `cycle: <ULID>` when a cycle is open, `cycle: "none"`
 *     when the file is absent.
 *   - `gatherRetroInputs` — scopes the retro bundle to the open cycle's window
 *     (done manifests + telemetry events from after `opened_at`).
 *
 * The file is written ONLY by `openCycle`. Absence is the legitimate baseline
 * (no cycle has ever been opened) — readers treat `null` as "no boundary,
 * preserve the existing full-history behaviour".
 */
/** Crockford-base32 ULID — 26 chars, alphabet `0-9A-HJKMNP-TV-Z`. */
const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;
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
export const CycleStateSchema = z
    .object({
    cycle_ulid: z.string().regex(ULID_REGEX),
    opened_at: z
        .string()
        .datetime({ offset: false })
        .refine((s) => s.endsWith("Z"), "must be UTC"),
})
    .strict();
/** Resolve the absolute cycle-state path for a target repo. */
export function cycleStatePath(targetRepoRoot) {
    return path.join(targetRepoRoot, ".flow", "cycle-state.json");
}
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
export async function readCycleState(targetRepoRoot) {
    const absPath = cycleStatePath(targetRepoRoot);
    let raw;
    try {
        raw = await fs.readFile(absPath, "utf8");
    }
    catch (err) {
        if (err?.code === "ENOENT") {
            return null;
        }
        throw err;
    }
    const parsed = JSON.parse(raw);
    return CycleStateSchema.parse(parsed);
}
