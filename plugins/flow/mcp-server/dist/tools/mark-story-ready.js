/**
 * `markStoryReady` MCP tool — Story 9.1 (Epic 9 intake cockpit).
 *
 * The operator readiness brake. Flips the `ready` boolean on an un-claimed
 * backlog manifest (a `to-do/<ref>.yaml`) in-place — same state directory,
 * same filename — using the same managed write path the withdraw tool uses.
 * `status` and the item's state directory are left untouched: `ready` is a
 * flat field flip, NOT a status transition.
 *
 * Polarity-flipped twin of `markWithdrawn`:
 *   - `markWithdrawn` removes an item from the claim candidate set.
 *   - `markStoryReady` admits an item (when set true) into the candidate set.
 *
 * Honoured by `claimNextStory`'s eligibility filter — an item is only claimed
 * once it is BOTH dependency-ready AND `ready: true`.
 *
 * Contract:
 *   - No-op (no write, no telemetry event) when the flag already holds the
 *     requested value.
 *   - Emits exactly one `backlog.readiness_changed` telemetry event per real
 *     toggle; NONE on a no-op and NONE on the typed-error path.
 *   - Throws `NotAnEligibleBacklogItemError` when the ref is not an un-claimed
 *     backlog item (not in `to-do/`, withdrawn, or absent entirely) — without
 *     mutating anything.
 *
 * Mirror reference: `mark-withdrawn.ts` (the binding template for the read /
 * managed-write / guard shape and the `serialiseManifest` serialisation).
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parse as yamlParse } from "yaml";
import { z } from "zod";
import { NotAnEligibleBacklogItemError } from "../errors.js";
import { atomicWriteFile } from "../lib/managed-fs.js";
import { logTelemetryEvent } from "../lib/logger.js";
import { parseExecutionManifest, } from "../schemas/execution-manifest.js";
import { STATE_NAMES } from "../state/manifest-state-machine.js";
import { serialiseManifest } from "./mark-withdrawn.js";
export const MarkStoryReadyInputSchema = z.object({
    targetRepoRoot: z.string().min(1),
    ref: z.string().min(1),
    ready: z.boolean(),
    /**
     * Session id for the telemetry envelope. Optional — the operator running
     * `/flow:ready` interactively has no orchestration session ULID. Defaults
     * to a stable operator marker so the event still validates.
     */
    sessionUlid: z.string().min(1).optional(),
});
/**
 * Set (or clear) the `ready` flag on an un-claimed backlog manifest.
 *
 * @throws {NotAnEligibleBacklogItemError} if the ref does not resolve to an
 *   un-claimed backlog item in `to-do/` (absent, withdrawn, or in another state).
 * @throws {MalformedExecutionManifestError} if the manifest fails schema validation.
 */
export async function markStoryReady(rawInput) {
    const input = MarkStoryReadyInputSchema.parse(rawInput);
    const targetRepoRoot = path.resolve(input.targetRepoRoot);
    const { ref, ready } = input;
    const sessionUlid = input.sessionUlid ?? "operator";
    // Step 1: Locate the manifest. Scan the canonical state dirs so we can give
    // a precise reason when the ref exists but is not an eligible backlog item.
    const stateRoot = path.join(targetRepoRoot, ".flow", "state");
    let foundState = null;
    let foundAbsPath = null;
    for (const stateName of STATE_NAMES) {
        const candidate = path.join(stateRoot, stateName, `${ref}.yaml`);
        try {
            await fs.stat(candidate);
            foundState = stateName;
            foundAbsPath = candidate;
            break;
        }
        catch {
            // ENOENT — not in this state dir, try next.
        }
    }
    // Step 2: Guard — the readiness brake only applies to un-claimed backlog items.
    if (foundState === null || foundAbsPath === null) {
        throw new NotAnEligibleBacklogItemError({ ref, foundState: null, reason: "not-found" });
    }
    if (foundState !== "to-do") {
        throw new NotAnEligibleBacklogItemError({ ref, foundState, reason: "not-in-to-do" });
    }
    // Step 3: Read and parse via the canonical reader.
    const rawText = await fs.readFile(foundAbsPath, "utf8");
    const parsed = yamlParse(rawText);
    const manifest = parseExecutionManifest(parsed, { absPath: foundAbsPath });
    // A withdrawn item is never an admissible backlog item — withdraw wins
    // (the two flags are orthogonal, but a withdrawn item stays unclaimable).
    if (manifest.withdrawn === true) {
        throw new NotAnEligibleBacklogItemError({ ref, foundState, reason: "withdrawn" });
    }
    // Step 4: Idempotency — if the flag already holds the requested value,
    // return without rewriting and without emitting a telemetry event.
    if (manifest.ready === ready) {
        return { ref, ready, noop: true, state: foundState };
    }
    // Step 5: Flip `ready`, re-serialise via the SAME path as the withdraw tool,
    // and write back atomically. MUST NOT modify any field other than `ready`,
    // and MUST NOT move the manifest between state directories.
    const updated = { ...manifest, ready };
    const yamlText = serialiseManifest(updated);
    await atomicWriteFile(foundAbsPath, yamlText);
    // Step 6: Emit exactly one readiness-change telemetry event (real toggle only).
    await logTelemetryEvent({
        targetRepoRoot,
        event: {
            type: "backlog.readiness_changed",
            session_id: sessionUlid,
            agent: "operator",
            story_id: ref,
            data: { ref, ready },
        },
    });
    return { ref, ready, noop: false, state: foundState, absPath: foundAbsPath };
}
