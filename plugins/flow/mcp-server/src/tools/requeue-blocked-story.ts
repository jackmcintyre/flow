/**
 * `requeueBlockedStory` MCP tool — Story native:01KVN6ASCWXAHZ0FF7YRFKJECC.
 *
 * The inverse of `blockStory`: moves a genuinely blocked story back into the
 * to-do (buildable) queue with its block cleared, so the next run can claim
 * and build it normally.
 *
 * This is the missing escape path from the blocked state. Before this tool,
 * the only exit from blocked/ was a hand-edit that the rules forbid. Now the
 * operator can call `requeueBlockedStory` — a single supported command — and
 * the story returns to to-do/ ready to be claimed.
 *
 * Eligibility model (mirrors the blocked-state guard in `blockStory`):
 *   - Scan all canonical state directories for the ref.
 *   - Accept ONLY a manifest that is in the `blocked/` directory.
 *   - Refuse with `NotABlockedStoryError` for every other case:
 *       not-found, to-do, in-progress, or done.
 *
 * State transition (the inverse of `blockStory`'s Steps 3–5):
 *   blocked/ → to-do/ (single rename(2) syscall via `moveBetweenStates`)
 *   Clear `blocked_by` and `claimed_by` from the written manifest,
 *   reset `status` to `"to-do"`.
 *
 * Safety guarantee: the move is a single `rename(2)` syscall (NFR8). A
 * successful requeue leaves exactly one copy of the manifest in `to-do/`
 * and no copy in `blocked/` — the single-syscall move is the atomicity
 * guarantee.
 *
 * Architecture note: this story is scoped ONLY to the requeue state
 * transition. Persisting WHY the story was blocked (durable failure reason
 * + telemetry) is the sibling story native:01KVN66JADJVB5HQ0K18F5VQ2R —
 * do NOT fold any diagnostics or telemetry-event work in here.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { NotABlockedStoryError } from "../errors.js";
import { writeManagedFile } from "../lib/managed-fs.js";
import { parseExecutionManifest } from "../schemas/execution-manifest.js";
import {
  moveBetweenStates,
  STATE_NAMES,
  type StateName,
} from "../state/manifest-state-machine.js";

const RequeueBlockedStoryInputSchema = z.object({
  targetRepoRoot: z.string().min(1),
  ref: z.string().min(1),
});

export interface RequeueBlockedStoryOutput {
  ref: string;
  /** Absolute path to the manifest now sitting in to-do/. */
  todoPath: string;
}

/**
 * Strip keys with `undefined` values before YAML stringification.
 * Mirrors `complete-story.ts` / `mark-withdrawn.ts` / `block-story.ts`.
 */
function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

/**
 * Move a genuinely blocked story back into the buildable to-do queue.
 *
 * Performs a single atomic rename blocked/ → to-do/, then rewrites the
 * manifest in-place to clear `blocked_by`, `claimed_by`, and reset `status`
 * to `"to-do"`. The next `claimNextStory` call will see this manifest as a
 * normal claimable to-do item.
 *
 * @throws {NotABlockedStoryError} When the ref is not in `blocked/`.
 * @throws {MalformedExecutionManifestError} When the manifest fails schema validation.
 */
export async function requeueBlockedStory(rawInput: unknown): Promise<RequeueBlockedStoryOutput> {
  const input = RequeueBlockedStoryInputSchema.parse(rawInput);
  const targetRepoRoot = path.resolve(input.targetRepoRoot);
  const { ref } = input;

  // Step 1: Scan all canonical state directories to locate the manifest.
  // We need to know its actual state so we can give a precise refusal when
  // the ref exists but is not blocked.
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

  // Step 2: Guard — only a blocked/ manifest can be requeued.
  if (foundState !== "blocked" || foundAbsPath === null) {
    throw new NotABlockedStoryError({ ref, foundState });
  }

  // Step 3: Read and parse the blocked manifest.
  const rawText = await fs.readFile(foundAbsPath, "utf8");
  const parsed = yamlParse(rawText) as unknown;
  const manifest = parseExecutionManifest(parsed, { absPath: foundAbsPath });

  // Step 4: Atomic state transition blocked/ → to-do/ (single rename syscall).
  const moveResult = await moveBetweenStates({
    targetRepoRoot,
    ref,
    from: "blocked",
    to: "to-do",
  });

  // Step 5: Write the clean to-do state. Strip blocked_by, claimed_by;
  // reset status to "to-do". The parse validates the updated manifest
  // before we write it, so schema invariants hold after the write.
  const {
    blocked_by: _dropBlockedBy,
    claimed_by: _dropClaimedBy,
    discipline_violations: _dropViolations,
    ...withoutBlockFields
  } = manifest;
  const updatedManifest = {
    ...withoutBlockFields,
    status: "to-do" as const,
  };
  const reparsed = parseExecutionManifest(updatedManifest, {
    absPath: moveResult.absToPath,
  });
  const yamlText = yamlStringify(
    stripUndefined(reparsed as unknown as Record<string, unknown>),
    { lineWidth: 0 },
  );
  await writeManagedFile({
    absPath: moveResult.absToPath,
    contents: yamlText,
    targetRepoRoot,
    mcpToolContext: { toolName: "requeueBlockedStory", role: "operator" },
  });

  return { ref, todoPath: moveResult.absToPath };
}
