/**
 * `blockStory` MCP tool — fix/run-isolation-coordination-honesty.
 *
 * Move a story THIS session owns from `in-progress/` to `blocked/` as a clean
 * state change, stamping a caller-supplied `blocked_by` reason. This is the live
 * run's "give up on this story" primitive — the generalisation of
 * `blockOrphanNoTranscript` (which is orphan-recovery-only and hardcodes its
 * reason) for a story the CURRENT session claimed.
 *
 * Why it exists (the non-termination fix): the run used to bucket a given-up
 * story as `blocked` in its RESULT object but leave the manifest sitting in
 * `in-progress/`. `claimNextStory` counts every `in-progress/` manifest, so it
 * kept returning `waiting-on-in-progress` forever and the loop re-polled without
 * end. Moving the manifest off `in-progress/` at the give-up point is what lets
 * the queue actually run.
 *
 * Eligibility / safety (mirrors `completeStory`):
 *   - The manifest MUST be in `in-progress/` (else ManifestNotFoundError).
 *   - The caller's `sessionUlid` MUST match `claimed_by` (else WrongClaimantError,
 *     absent `claimed_by` treated as a mismatch) — so one worker can never block
 *     another worker's story under concurrency.
 *
 * Clean-state move (mirrors `blockOrphanNoTranscript`):
 *   removeInProgressSnapshot → moveBetweenStates(in-progress→blocked) → clear
 *   `claimed_by`, set `status: "blocked"`, stamp the supplied `blocked_by`. The
 *   blocked manifest reads back without contradiction, so the documented recovery
 *   (move back to `to-do/`) yields a genuinely claimable manifest.
 *
 * Unlike `completeStory` this does NOT run the hand-edit guard: we are abandoning
 * the story, not certifying it untouched, and a NEEDS-CHANGES round legitimately
 * stamps the in-progress manifest mid-flight.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { ManifestNotFoundError, WrongClaimantError } from "../errors.js";
import { writeManagedFile } from "../lib/managed-fs.js";
import { parseExecutionManifest } from "../schemas/execution-manifest.js";
import {
  moveBetweenStates,
  removeInProgressSnapshot,
} from "../state/manifest-state-machine.js";

/**
 * Strip keys with `undefined` values before YAML stringification.
 * Mirrors `complete-story.ts` / `mark-withdrawn.ts`.
 */
function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

/**
 * Block a claimed story the current session owns.
 *
 * @param opts.targetRepoRoot - Absolute path to the target repository root.
 * @param opts.ref - Manifest ref (e.g. `"native:01HZ..."` or `"bmad:1.1"`).
 * @param opts.sessionUlid - ULID of the calling session. Must match `claimed_by`.
 * @param opts.blockedBy - The give-up reason to stamp (a `blocked_by` enum value).
 * @param opts.role - Optional role label for the canonical-fs guard. Default
 *   `"orchestrator"`.
 * @returns `{ ref, absPath }` — the ref and absolute path of the blocked manifest.
 *
 * @throws {ManifestNotFoundError} When the ref is absent from `in-progress/`.
 * @throws {WrongClaimantError} When `sessionUlid` does not match `claimed_by`.
 * @throws {MalformedExecutionManifestError} When the manifest (or the supplied
 *   `blockedBy`) fails schema validation.
 */
export async function blockStory(opts: {
  targetRepoRoot: string;
  ref: string;
  sessionUlid: string;
  blockedBy: string;
  role?: string;
}): Promise<{ ref: string; absPath: string }> {
  const { targetRepoRoot, ref, sessionUlid, blockedBy, role = "orchestrator" } =
    opts;

  const stateRoot = path.join(targetRepoRoot, ".flow", "state");
  const absInProgressPath = path.join(stateRoot, "in-progress", `${ref}.yaml`);
  const absBlockedPath = path.join(stateRoot, "blocked", `${ref}.yaml`);

  // Step 1: Load the in-progress/ manifest (for the claimant guard).
  let rawText: string;
  try {
    rawText = await fs.readFile(absInProgressPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      throw new ManifestNotFoundError({
        ref,
        expectedAbsPath: absInProgressPath,
        fromState: "in-progress",
      });
    }
    throw err;
  }
  const parsed = yamlParse(rawText) as unknown;
  const manifest = parseExecutionManifest(parsed, { absPath: absInProgressPath });

  // Step 2: Claimant guard (mirrors completeStory) — only block a story THIS
  // session owns. Absent claimed_by is a mismatch.
  if (manifest.claimed_by !== sessionUlid) {
    throw new WrongClaimantError({
      ref,
      expectedSessionUlid: sessionUlid,
      actualSessionUlid: manifest.claimed_by ?? "<unset>",
    });
  }

  // Step 3: Remove the claim-time sidecar (best-effort) BEFORE the move — it
  // targets in-progress/<ref>.snapshot.yaml. A missing sidecar is not an error.
  await removeInProgressSnapshot({ targetRepoRoot, ref });

  // Step 4: Atomic transition in-progress/ → blocked/ (single-syscall rename).
  await moveBetweenStates({ targetRepoRoot, ref, from: "in-progress", to: "blocked" });

  // Step 5: Write the clean blocked state — clear claimed_by, set status, stamp
  // the supplied blocked_by. parseExecutionManifest validates blocked_by against
  // the closed enum, so an unknown reason throws rather than writing garbage.
  const { claimed_by: _dropClaim, ...withoutClaim } = manifest;
  const updatedManifest = {
    ...withoutClaim,
    status: "blocked" as const,
    blocked_by: blockedBy,
  };
  const reparsed = parseExecutionManifest(updatedManifest, {
    absPath: absBlockedPath,
  });
  const yamlText = yamlStringify(
    stripUndefined(reparsed as unknown as Record<string, unknown>),
    { lineWidth: 0 },
  );
  await writeManagedFile({
    absPath: absBlockedPath,
    contents: yamlText,
    targetRepoRoot,
    mcpToolContext: { toolName: "blockStory", role },
  });

  return { ref, absPath: absBlockedPath };
}
