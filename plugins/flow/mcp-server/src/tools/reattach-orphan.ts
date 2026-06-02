/**
 * `reattachOrphan` MCP tool — Story 5.11 Task 2.
 *
 * Atomically rewrites an orphaned in-progress manifest's `claimed_by` field
 * from the stale session ULID to the current session ULID. This is the
 * transcript-present path of the orphan-recovery branch in `/flow:start`.
 *
 * After `reattachOrphan` returns, `completeStory`'s `WrongClaimantError` check
 * is satisfied (the manifest's `claimed_by` now matches the current session).
 *
 * Throws `NotAnOrphanError` if the manifest's `claimed_by` already equals
 * `currentSessionUlid` — a race condition between the scan and the rewrite.
 *
 * Throws `ManifestNotFoundError` if the ref is absent from `in-progress/`.
 *
 * Architecture §MCP Tool Naming — camelCase verb-noun: `reattachOrphan`.
 * Story 5.11 Task 2.1–2.4.
 */

import * as path from "node:path";
import { ManifestNotFoundError, NotAnOrphanError } from "../errors.js";
import { readManifest, writeManifest } from "../lib/manifest-io.js";

export interface ReattachOrphanResult {
  chatLog: string[];
  /**
   * The story's crash-resume count AFTER this reattach (post-increment). The
   * autonomous drain reads this to cap repeated resumptions of a doomed story.
   */
  resumeAttempts: number;
}

export interface ReattachOrphanOptions {
  targetRepoRoot: string;
  ref: string;
  currentSessionUlid: string;
}

/**
 * Reattach an orphaned in-progress manifest to the current session.
 *
 * Rewrites `claimed_by` from the stale ULID to `currentSessionUlid` atomically
 * via `writeManifest` (which uses `atomicWriteFile` internally).
 *
 * @param opts.targetRepoRoot - Absolute path to the target repository root.
 * @param opts.ref - Manifest ref (e.g. `"native:01HZ..."` or `"bmad:1.1"`).
 * @param opts.currentSessionUlid - ULID of the calling session. Will become the new `claimed_by`.
 *
 * @returns `{ chatLog }` — a one-entry array with the reattach log line.
 *
 * @throws {NotAnOrphanError} When `claimed_by === currentSessionUlid` (race condition).
 * @throws {ManifestNotFoundError} When the ref is absent from `in-progress/`.
 * @throws {MalformedExecutionManifestError} When the manifest fails schema validation.
 */
export async function reattachOrphan(
  opts: ReattachOrphanOptions,
): Promise<ReattachOrphanResult> {
  const { targetRepoRoot, ref, currentSessionUlid } = opts;
  const absPath = path.join(
    targetRepoRoot,
    ".flow",
    "state",
    "in-progress",
    `${ref}.yaml`,
  );

  // Step 1: Load the manifest. Propagate ManifestNotFoundError on ENOENT
  // (readManifest itself throws ENOENT — wrap it).
  let manifest;
  try {
    manifest = await readManifest(absPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      throw new ManifestNotFoundError({
        ref,
        expectedAbsPath: absPath,
        fromState: "in-progress",
      });
    }
    throw err;
  }

  // Step 2: Verify it is actually an orphan.
  if (manifest.claimed_by === currentSessionUlid) {
    throw new NotAnOrphanError({ ref, currentSessionUlid });
  }

  const staleUlid = manifest.claimed_by ?? "<absent>";

  // Step 3: Rewrite claimed_by to the current session ULID and bump the
  // crash-resume counter. The drain reads `resumeAttempts` to cap repeated
  // resumptions (a story that crashes the loop on every resume must not loop
  // forever — past the cap the drain blocks it for a human instead).
  const resumeAttempts = (manifest.drain_resume_attempts ?? 0) + 1;
  const updatedManifest = {
    ...manifest,
    claimed_by: currentSessionUlid,
    drain_resume_attempts: resumeAttempts,
  };
  await writeManifest(absPath, updatedManifest);

  // Step 4: Return the verbatim chat log entry + the post-increment count.
  const chatLog: string[] = [
    `reattaching ${ref} — claimed_by rewritten from ${staleUlid} to ${currentSessionUlid} (resume attempt ${resumeAttempts})`,
  ];

  return { chatLog, resumeAttempts };
}
