/**
 * `discardDraft` MCP tool — Story native:01KTZKHJ1KDYKGXR20FZ15Y4WB.
 *
 * First-class discard of an un-built parked native draft.
 *
 * Removes BOTH the to-do/ execution manifest AND the underlying source draft
 * file under `.flow/native-stories/` in one guarded action, so a subsequent
 * source-projection pass cannot re-materialise the item.
 *
 * Eligibility model (mirrors mark-story-ready.ts exactly):
 *   - Scan all canonical state directories for the ref.
 *   - Accept ONLY an un-withdrawn, un-claimed to-do/ native draft.
 *   - Refuse with NotAnEligibleDraftError for every other case:
 *       not-found, claimed/in-progress/done/blocked (not-in-to-do),
 *       already-withdrawn, or a non-native adapter ref.
 *   - Idempotency: a ref absent from every state directory is a clean no-op
 *     (returns { removed: false, noop: true }) rather than raising.
 *
 * Removing the source draft is the load-bearing detail `markWithdrawn` lacks —
 * without it a projection pass re-materialises the item from the source file.
 *
 * Architecture reference: implementation_notes of
 * native:01KTZKHJ1KDYKGXR20FZ15Y4WB.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { NotAnEligibleDraftError } from "../errors.js";
import { parse as yamlParse } from "yaml";
import {
  parseExecutionManifest,
} from "../schemas/execution-manifest.js";
import { STATE_NAMES, type StateName } from "../state/manifest-state-machine.js";

const DiscardDraftInputSchema = z.object({
  targetRepoRoot: z.string().min(1),
  ref: z.string().min(1),
});

export interface DiscardDraftOutput {
  ref: string;
  /** True when both the manifest and the source file were removed. */
  removed: boolean;
  /**
   * True when the ref was already absent from every state directory —
   * a clean no-op; nothing was removed.
   */
  noop: boolean;
  /** Absolute path of the removed to-do manifest (present when removed:true). */
  manifestPath?: string;
  /** Absolute path of the removed source draft file (present when removed:true). */
  sourcePath?: string;
}

/**
 * Discard an un-claimed native draft parked in the backlog.
 *
 * Removes the to-do/ execution manifest AND the underlying native-stories
 * source file so a later projection pass cannot resurrect the item.
 *
 * @throws {NotAnEligibleDraftError} when the ref is not an un-claimed,
 *   un-withdrawn native-adapter to-do draft — without removing anything.
 * @throws {MalformedExecutionManifestError} if the manifest fails schema validation.
 */
export async function discardDraft(rawInput: unknown): Promise<DiscardDraftOutput> {
  const input = DiscardDraftInputSchema.parse(rawInput);
  const targetRepoRoot = path.resolve(input.targetRepoRoot);
  const { ref } = input;

  // Step 1: Locate the manifest. Scan canonical state dirs so we can give a
  // precise reason when the ref exists but is not an eligible draft.
  const stateRoot = path.join(targetRepoRoot, ".flow", "state");
  let foundState: StateName | null = null;
  let foundAbsPath: string | null = null;

  for (const stateName of STATE_NAMES) {
    const candidate = path.join(stateRoot, stateName, `${ref}.yaml`);
    try {
      await fs.stat(candidate);
      foundState = stateName;
      foundAbsPath = candidate;
      break;
    } catch {
      // ENOENT — not in this state dir, try next.
    }
  }

  // Step 2: Idempotency — if the ref is absent from every state directory,
  // return a clean no-op rather than raising. Mirrors mark-story-ready's
  // already-in-state no-op and mark-withdrawn's already-withdrawn return.
  if (foundState === null || foundAbsPath === null) {
    return { ref, removed: false, noop: true };
  }

  // Step 3: Guard — discard only applies to un-claimed to-do items.
  if (foundState !== "to-do") {
    throw new NotAnEligibleDraftError({
      ref,
      foundState,
      reason: "not-in-to-do",
    });
  }

  // Step 4: Read and parse via the canonical reader.
  const rawText = await fs.readFile(foundAbsPath, "utf8");
  const parsed = yamlParse(rawText) as unknown;
  const manifest = parseExecutionManifest(parsed, { absPath: foundAbsPath });

  // A withdrawn item is already logically retired — refusing is the correct
  // behaviour rather than double-discarding.
  if (manifest.withdrawn === true) {
    throw new NotAnEligibleDraftError({ ref, foundState, reason: "withdrawn" });
  }

  // Guard: discard is native-only. External adapter refs use markWithdrawn.
  if (manifest.adapter !== "native") {
    throw new NotAnEligibleDraftError({ ref, foundState, reason: "wrong-adapter" });
  }

  // Step 5: Re-stat the manifest immediately before the delete to close the
  // TOCTOU window where claimNextStory could move the manifest to in-progress/
  // between our scan (Step 1) and the unlink below.
  try {
    await fs.stat(foundAbsPath);
  } catch {
    // The manifest has moved out of to-do/ (most likely claimed by the dev loop).
    throw new NotAnEligibleDraftError({ ref, foundState, reason: "not-in-to-do" });
  }

  // Step 6: Resolve the source draft path from the ref's ULID under
  // .flow/native-stories/. The ULID is the portion of the ref after the
  // "native:" prefix; the file is named <ULID>.md.
  const ulid = ref.startsWith("native:") ? ref.slice("native:".length) : ref;
  const nativeStoriesDir = path.join(targetRepoRoot, ".flow", "native-stories");
  const sourceDraftPath = path.join(nativeStoriesDir, `${ulid}.md`);

  // Step 7: Remove the to-do manifest first.
  await fs.unlink(foundAbsPath);

  // Step 8: Remove the source draft file. If it does not exist (e.g. the file
  // was hand-deleted between scan and discard), we still succeeded — the
  // manifest is gone, so a future scan cannot re-materialise the item.
  try {
    await fs.unlink(sourceDraftPath);
  } catch (err) {
    if (!isEnoent(err)) {
      throw err;
    }
    // Source file already absent — that is fine; the manifest was the
    // authoritative claim entry that would trigger re-materialisation.
  }

  return {
    ref,
    removed: true,
    noop: false,
    manifestPath: foundAbsPath,
    sourcePath: sourceDraftPath,
  };
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}
