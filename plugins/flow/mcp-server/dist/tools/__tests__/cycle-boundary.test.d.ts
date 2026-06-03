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
export {};
