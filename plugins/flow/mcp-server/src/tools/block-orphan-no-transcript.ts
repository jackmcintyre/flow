/**
 * `blockOrphanNoTranscript` MCP tool — Story 5.11 Task 3.
 *
 * Handles the no-transcript path of the orphan-recovery branch in `/flow:start`.
 * When the operator chooses `reattach` but no persisted transcript exists, this
 * tool:
 *   1. Moves the manifest from `in-progress/` to `blocked/` via `moveBetweenStates`.
 *   2. Loads the now-blocked manifest from `blocked/<ref>.yaml`.
 *   3. Stamps `blocked_by: "orphan-no-transcript"` via `writeManifest`.
 *   4. Returns the verbatim AC3 chat log line.
 *
 * The two operations (move + stamp) run in order. If the move succeeds but the
 * field-write fails, the manifest lands in `blocked/` without `blocked_by` —
 * recoverable by the operator (matches the existing pattern from
 * `processDevTranscript`'s grammar-drift branch). No compound primitive is
 * introduced.
 *
 * Adds `orphan-no-transcript` to the de-facto `blocked_by` taxonomy established
 * by Stories 4.3b / 4.5. Story 5.1 will formalise the taxonomy when it ships.
 *
 * Architecture §MCP Tool Naming — camelCase verb-noun: `blockOrphanNoTranscript`.
 * Story 5.11 Task 3.1–3.5.
 */

import * as path from "node:path";
import { moveBetweenStates, removeInProgressSnapshot } from "../state/manifest-state-machine.js";
import { readManifest, writeManifest } from "../lib/manifest-io.js";

export interface BlockOrphanNoTranscriptResult {
  chatLog: string[];
}

export interface BlockOrphanNoTranscriptOptions {
  targetRepoRoot: string;
  ref: string;
  staleUlid: string;
}

/**
 * Block an orphaned in-progress manifest that has no persisted transcript.
 *
 * Makes blocking a **clean state change**: moves the manifest from `in-progress/`
 * to `blocked/`, stamps `blocked_by: "orphan-no-transcript"`, clears the stale
 * `claimed_by`, updates the `status` to `"blocked"`, and removes the claim-time
 * sidecar snapshot (`<ref>.snapshot.yaml`). After this call the manifest reads back
 * without contradiction — the documented recovery (move back to `to-do/`) yields a
 * manifest the claim loop will offer and can be claimed again.
 *
 * **Why the extra steps matter (B3):** the original implementation moved the manifest
 * and stamped `blocked_by` but left `claimed_by` populated and `status: "in-progress"`,
 * plus left the snapshot sidecar behind. A manifest moved back to `to-do/` by the
 * documented recovery still looked claimed/in-progress, so `claimNextStory` never
 * offered it — the story was stuck forever. This fix makes the blocked state genuinely
 * clean so the recovery path works as documented.
 *
 * **Ordering:** Remove the sidecar first (best-effort, cannot block the move). Move
 * the manifest (atomic rename — authoritative state transition). Then read-and-write
 * the blocked manifest to clear `claimed_by`, update `status`, and stamp `blocked_by`.
 * If the read-write fails after the move, the manifest lands in `blocked/` without
 * the full stamp — recoverable by the operator (matches the existing failure pattern
 * established by `processDevTranscript`'s grammar-drift branch). No compound primitive
 * is introduced.
 *
 * @param opts.targetRepoRoot - Absolute path to the target repository root.
 * @param opts.ref - Manifest ref (e.g. `"native:01HZ..."` or `"bmad:1.1"`).
 * @param opts.staleUlid - The stale session ULID from the manifest's `claimed_by`.
 *
 * @returns `{ chatLog }` — a one-entry array with the blocked log line.
 *
 * @throws {ManifestNotFoundError} When the ref is absent from `in-progress/`.
 * @throws {MalformedExecutionManifestError} When the manifest fails schema validation.
 */
export async function blockOrphanNoTranscript(
  opts: BlockOrphanNoTranscriptOptions,
): Promise<BlockOrphanNoTranscriptResult> {
  const { targetRepoRoot, ref, staleUlid } = opts;

  // Step 1: Remove the claim-time sidecar snapshot (best-effort).
  // This must happen BEFORE the manifest move because `removeInProgressSnapshot`
  // targets `in-progress/<ref>.snapshot.yaml`. A missing sidecar is not an error.
  await removeInProgressSnapshot({ targetRepoRoot, ref });

  // Step 2: Move from in-progress/ to blocked/ via the canonical primitive.
  // moveBetweenStates throws ManifestNotFoundError on ENOENT.
  await moveBetweenStates({
    targetRepoRoot,
    ref,
    from: "in-progress",
    to: "blocked",
  });

  // Step 3: Load the now-blocked manifest.
  const absBlockedPath = path.join(
    targetRepoRoot,
    ".flow",
    "state",
    "blocked",
    `${ref}.yaml`,
  );
  const manifest = await readManifest(absBlockedPath);

  // Step 4: Write the clean blocked state — stamp blocked_by, update status,
  // and clear the stale claimed_by so the manifest reads back without contradiction.
  // A blocked manifest must not carry a claim so that moving it back to to-do/
  // (the documented recovery) yields a genuinely claimable manifest.
  const { claimed_by: _clearClaim, ...manifestWithoutClaim } = manifest;
  const updatedManifest = {
    ...manifestWithoutClaim,
    status: "blocked" as const,
    blocked_by: "orphan-no-transcript" as const,
  };
  await writeManifest(absBlockedPath, updatedManifest);

  // Step 5: Return the verbatim AC3 chat log line.
  const chatLog: string[] = [
    `[blocked] ${ref} — orphan-no-transcript: no persisted transcript for session ${staleUlid}; manual recovery required`,
  ];

  return { chatLog };
}
