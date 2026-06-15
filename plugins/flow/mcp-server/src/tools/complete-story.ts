/**
 * `completeStory` MCP tool — Story 4.1.
 *
 * Atomically completes a claimed story (FR19):
 *   1. Guards against in-progress hand-edits via `detectInProgressHandEdit` (FR14a).
 *   2. Loads the `in-progress/` manifest.
 *   3. Verifies the caller's session ULID matches `claimed_by` (AC4).
 *   4. Moves the manifest from `in-progress/` to `done/` via `moveBetweenStates`.
 *   5. Rewrites the manifest with `status: "done"` (preserving `claimed_by` for retros).
 *
 * **`claimed_by` is preserved** on completion so retrospectives can attribute
 * the completion to the session that ran the story.
 *
 * **Absent `claimed_by` is treated as a mismatch** — a story in `in-progress/`
 * without `claimed_by` is malformed and should not be completable by any caller.
 * The operator must fix the manifest or use `block-story` (FR20, a separate story).
 *
 * **No liveness validation.** This story only stamps `claimed_by` on claim and
 * validates it on complete. Heartbeat, stale-claim detection, and orphan recovery
 * are Epic 5 concerns.
 *
 * FR19 — atomic complete, FR14a — hand-edit guard.
 *
 * **Story 5.29 — sidecar baseline.** The hand-edit guard reads its baseline
 * from the claim-time sidecar at `.flow/state/in-progress/<ref>.snapshot.yaml`,
 * not by re-reading the source story. After successful transition to `done/`,
 * `completeStory` removes the sidecar (best-effort).
 *
 * See also: `moveBetweenStates` (manifest-state-machine.ts),
 *           `detectInProgressHandEdit` (manifest-state-machine.ts),
 *           `removeInProgressSnapshot` (manifest-state-machine.ts).
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { ManifestNotFoundError, WrongClaimantError } from "../errors.js";
import { writeManagedFile } from "../lib/managed-fs.js";
import { parseExecutionManifest } from "../schemas/execution-manifest.js";
import {
  moveBetweenStates,
  detectInProgressHandEdit,
  removeInProgressSnapshot,
} from "../state/manifest-state-machine.js";

/**
 * Strip keys with `undefined` values before YAML stringification.
 * Mirrors the pattern used in `scan-sources.ts` and `mark-withdrawn.ts`.
 */
function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

/**
 * Atomically complete a claimed story.
 *
 * @param opts.targetRepoRoot - Absolute path to the target repository root.
 * @param opts.ref - Manifest ref (e.g. `"native:01HZ..."` or `"bmad:1.1"`).
 * @param opts.sessionUlid - ULID of the calling dev session. Must match the
 *   `claimed_by` field in the `in-progress/` manifest.
 * @param opts.role - Optional role label for `writeManagedFile`'s canonical-fs
 *   guard. Defaults to `"orchestrator"`.
 * @returns `{ ref, absPath }` — the ref and absolute path of the newly-moved
 *   `done/` manifest.
 *
 * @throws {InProgressHandEditError} When the `in-progress/` manifest has been
 *   hand-edited since claim.
 * @throws {ManifestNotFoundError} When the ref does not exist in `in-progress/`.
 * @throws {MalformedExecutionManifestError} When the manifest fails schema
 *   validation.
 * @throws {WrongClaimantError} When the caller's session ULID does not match
 *   the manifest's `claimed_by` field (including when `claimed_by` is absent).
 * @throws {CrossFilesystemMoveError} When the state directories are on
 *   different filesystems (EXDEV).
 */
export async function completeStory(opts: {
  targetRepoRoot: string;
  ref: string;
  sessionUlid: string;
  role?: string;
}): Promise<{ ref: string; absPath: string }> {
  const { targetRepoRoot, ref, sessionUlid, role = "orchestrator" } = opts;

  const stateRoot = path.join(targetRepoRoot, ".flow", "state");
  const absInProgressPath = path.join(stateRoot, "in-progress", `${ref}.yaml`);
  const absDonePath = path.join(stateRoot, "done", `${ref}.yaml`);

  // Step 1: Hand-edit guard (AC5 / FR14a; Story 5.29 — sidecar-driven baseline).
  // For completeStory the ref MUST be in in-progress/ (otherwise step 2 throws).
  // The guard is unconditional — always call it on entry. It loads the sidecar
  // baseline internally; no baseline-derivation call is needed here.
  await detectInProgressHandEdit({ targetRepoRoot, ref });

  // Step 2: Load the in-progress/ manifest.
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

  // Step 3: Claimant check (AC4).
  // Treat absent claimed_by as a mismatch — such a manifest is malformed.
  if (manifest.claimed_by !== sessionUlid) {
    throw new WrongClaimantError({
      ref,
      expectedSessionUlid: sessionUlid,
      actualSessionUlid: manifest.claimed_by ?? "<unset>",
    });
  }

  // Step 4: Atomic transition (AC3 / FR19).
  // moveBetweenStates is the single-syscall rename primitive (Story 1.6).
  // After this returns, the manifest lives at absDonePath.
  await moveBetweenStates({
    targetRepoRoot,
    ref,
    from: "in-progress",
    to: "done",
  });

  // Step 5: Field rewrite.
  // Set status to "done". Preserve claimed_by verbatim for retros.
  // STRIP any stale `blocked_by` (fix/run-isolation-coordination-honesty): a
  // story can reach completion after one or more NEEDS-CHANGES rounds stamped
  // `blocked_by: reviewer-verdict-needs-changes` on the in-progress manifest. A
  // DONE manifest must never carry a block reason — leaving it produced the
  // contradictory "status: done + blocked_by: …" record behind PR #355. Drop it
  // here (mirrors blockOrphanNoTranscript's deliberate claimed_by strip).
  const { blocked_by: _dropBlockedBy, ...manifestWithoutBlock } = manifest;
  const updatedManifest = {
    ...manifestWithoutBlock,
    status: "done" as const,
    // claimed_by is already present and preserved by the spread above.
  };
  const reparsed = parseExecutionManifest(updatedManifest, {
    absPath: absDonePath,
  });
  const yamlText = yamlStringify(
    stripUndefined(reparsed as unknown as Record<string, unknown>),
    { lineWidth: 0 },
  );

  await writeManagedFile({
    absPath: absDonePath,
    contents: yamlText,
    targetRepoRoot,
    mcpToolContext: { toolName: "completeStory", role },
  });

  // Step 6: Remove the claim-time sidecar (Story 5.29).
  // Best-effort — a stale sidecar with no in-progress manifest is harmless,
  // but tidying keeps the directory clean and avoids confusing diagnostics.
  await removeInProgressSnapshot({ targetRepoRoot, ref });

  return { ref, absPath: absDonePath };
}
