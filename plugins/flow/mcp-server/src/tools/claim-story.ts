/**
 * `claimStory` MCP tool — Story 4.1.
 *
 * Atomically claims a story for dev work (FR17):
 *   1. Guards against in-progress hand-edits via `detectInProgressHandEdit` (FR14a).
 *   2. Loads the `to-do/` manifest.
 *   3. Checks that all `depends_on` refs are present in `done/` (FR18).
 *   4. Moves the manifest from `to-do/` to `in-progress/` via `moveBetweenStates`
 *      (atomic rename — the single coordination surface).
 *   5. Rewrites the manifest with `status: "in-progress"` and `claimed_by: sessionUlid`.
 *
 * **Sequencing rationale:** The move-then-rewrite sequence is chosen over
 * rewrite-then-move because `moveBetweenStates` is the canonical atomicity
 * primitive — using it first means another concurrent claim sees the `to-do/`
 * ENOENT immediately (rename is atomic), and the rewrite is an in-place update
 * on the winner's manifest. The narrow window between rename and rewrite is
 * observable as "an `in-progress/<ref>.yaml` whose `status` is still `to-do`
 * and `claimed_by` is absent" — this is acceptable because (a) no other tool
 * inspects `status` on the in-progress layer (the directory is ground truth),
 * and (b) the hand-edit guard's baseline check sees the rewritten manifest,
 * not the transient one.
 *
 * **`isClaimable` is NOT invoked here.** Story 4.2's `/start` skill is the
 * layer that picks the next ready story (using `isClaimable` to filter the
 * candidate queue). `claimStory` is a primitive: given a ref, claim it if deps
 * are ready and the manifest is not hand-edited. If `/start` hands `claimStory`
 * a withdrawn ref, the parse step surfaces `withdrawn: true` and the queue-
 * selection logic is the layer that prevents that.
 *
 * **No `--force` bypass.** The hand-edit refusal is unconditional (Story 3.7).
 *
 * FR17 — atomic claim, FR18 — dependency check, FR14a — hand-edit guard.
 *
 * **Story 5.29 — sidecar snapshot.** After moving the manifest to `in-progress/`
 * and rewriting it with `claimed_by`, `claimStory` writes a sidecar baseline at
 * `.flow/state/in-progress/<ref>.snapshot.yaml` capturing the source-hash and
 * operator-editable fields at claim time. `detectInProgressHandEdit` reads this
 * sidecar as the baseline; it no longer re-reads the source story.
 *
 * See also: `moveBetweenStates` (manifest-state-machine.ts),
 *           `detectInProgressHandEdit` (manifest-state-machine.ts),
 *           `writeInProgressSnapshot` (manifest-state-machine.ts).
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { InProgressHandEditError, ManifestNotFoundError } from "../errors.js";
import { writeManagedFile } from "../lib/managed-fs.js";
import { parseExecutionManifest } from "../schemas/execution-manifest.js";
import {
  moveBetweenStates,
  detectInProgressHandEdit,
  writeInProgressSnapshot,
} from "../state/manifest-state-machine.js";
import { DependenciesNotReadyError } from "../errors.js";

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
 * Atomically claim a story for dev work.
 *
 * @param opts.targetRepoRoot - Absolute path to the target repository root.
 * @param opts.ref - Manifest ref (e.g. `"native:01HZ..."` or `"bmad:1.1"`).
 * @param opts.sessionUlid - ULID of the calling dev session. Stamped as
 *   `claimed_by` in the moved manifest.
 * @param opts.role - Optional role label for `writeManagedFile`'s canonical-fs
 *   guard. Defaults to `"orchestrator"`.
 * @returns `{ ref, absPath }` — the ref and absolute path of the newly-moved
 *   `in-progress/` manifest.
 *
 * @throws {InProgressHandEditError} When the ref is already in `in-progress/`
 *   and has been hand-edited since claim.
 * @throws {ManifestNotFoundError} When the ref does not exist in `to-do/`.
 * @throws {MalformedExecutionManifestError} When the manifest fails schema
 *   validation.
 * @throws {DependenciesNotReadyError} When one or more `depends_on` refs are
 *   not yet in `done/`.
 * @throws {CrossFilesystemMoveError} When the state directories are on
 *   different filesystems (EXDEV).
 */
export async function claimStory(opts: {
  targetRepoRoot: string;
  ref: string;
  sessionUlid: string;
  role?: string;
}): Promise<{ ref: string; absPath: string }> {
  const { targetRepoRoot, ref, sessionUlid, role = "orchestrator" } = opts;

  const stateRoot = path.join(targetRepoRoot, ".flow", "state");
  const absToDoPath = path.join(stateRoot, "to-do", `${ref}.yaml`);
  const absInProgressPath = path.join(stateRoot, "in-progress", `${ref}.yaml`);

  // Step 1: Hand-edit guard (AC5 / FR14a; Story 5.29 — sidecar-driven baseline).
  // If the ref is already in in-progress/ (re-entry), call the hand-edit guard
  // and let any thrown InProgressHandEditError propagate. The guard loads the
  // claim-time sidecar internally; no baseline-derivation call is needed here.
  //
  // Exception — crash-recovery re-baseline (this story, AC3):
  // If the guard throws InProgressHandEditError with changedFields: ["_snapshot_missing"]
  // AND the manifest already carries a claimed_by (meaning it was fully claimed in an
  // earlier run that crashed between snapshot-write and completion), re-establish the
  // snapshot from the on-disk manifest so the story is resumable rather than wedged
  // forever. This re-baseline is safe because:
  //   • It only fires when the sidecar is absent — the guard would return ok otherwise.
  //   • It requires claimed_by to be present, distinguishing it from the gap scenario
  //     (winner still running, claimed_by not yet written), which must propagate so
  //     claimNextStory can treat it as a concurrent lost race.
  //   • A genuine operator hand-edit (real field drift, not just missing sidecar)
  //     still surfaces the full changed-field list and propagates as InProgressHandEditError.
  let crashRecoveryRebaselined = false;
  try {
    await fs.stat(absInProgressPath);
    // File exists — ref is already in in-progress/. Guard against hand-edits.
    await detectInProgressHandEdit({ targetRepoRoot, ref });
    // Guard passed — the story was already claimed and is clean. Fall through to
    // the to-do/ load so it throws ManifestNotFoundError(fromState:"to-do"), which
    // claimNextStory catches as a concurrent lost-race signal. This preserves the
    // original re-entry contract.
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      // File does not exist in in-progress/ — proceed with normal claim from to-do/.
    } else if (
      err instanceof InProgressHandEditError &&
      err.changedFields.length === 1 &&
      err.changedFields[0] === "_snapshot_missing"
    ) {
      // Snapshot-missing-only. Read the manifest to check whether claimed_by is set.
      //
      // Two sub-cases:
      //
      // (a) claimed_by PRESENT — crash-recovery case (AC3 of this story):
      //     The claim completed in a prior run (rename + field-rewrite both finished)
      //     but the snapshot write was interrupted before it landed. Re-establish the
      //     snapshot so the story is resumable rather than permanently wedged.
      //
      // (b) claimed_by ABSENT — concurrent gap case (AC1/AC2 of this story):
      //     The winner is still between the atomic rename and its field-rewrite
      //     (claimed_by not yet written). Propagate so claimNextStory treats this as
      //     a concurrent lost race and skips to the next candidate.
      const rawInProgress = await fs.readFile(absInProgressPath, "utf8");
      const parsedInProgress = yamlParse(rawInProgress) as unknown;
      const inProgressManifest = parseExecutionManifest(parsedInProgress, {
        absPath: absInProgressPath,
      });

      if (inProgressManifest.claimed_by) {
        // Sub-case (a): claimed_by present → crash recovery. Re-establish snapshot.
        await writeInProgressSnapshot({
          targetRepoRoot,
          ref,
          manifest: inProgressManifest,
        });
        crashRecoveryRebaselined = true;
      } else {
        // Sub-case (b): claimed_by absent → gap scenario. Propagate as lost race.
        throw err;
      }
    } else {
      // Propagate InProgressHandEditError (real field drift), ManifestNotFoundError,
      // or any other error.
      throw err;
    }
  }

  // Crash-recovery re-baseline succeeded — the snapshot is now written and the
  // story is resumable. Return early so the caller (e.g. the run's orphan-
  // recovery path) can proceed with building the already-claimed story.
  if (crashRecoveryRebaselined) {
    return { ref, absPath: absInProgressPath };
  }

  // Step 2: Load the to-do/ manifest.
  let rawText: string;
  try {
    rawText = await fs.readFile(absToDoPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      throw new ManifestNotFoundError({
        ref,
        expectedAbsPath: absToDoPath,
        fromState: "to-do",
      });
    }
    throw err;
  }

  const parsed = yamlParse(rawText) as unknown;
  const manifest = parseExecutionManifest(parsed, { absPath: absToDoPath });

  // Step 3: Dependency check (AC2 / FR18).
  const missingDeps: string[] = [];
  for (const dep of manifest.depends_on) {
    const depPath = path.join(stateRoot, "done", `${dep}.yaml`);
    try {
      await fs.stat(depPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") {
        missingDeps.push(dep);
      } else {
        throw err;
      }
    }
  }

  if (missingDeps.length > 0) {
    throw new DependenciesNotReadyError({ ref, missingDeps });
  }

  // Step 4: Atomic transition (AC1 / FR17).
  // moveBetweenStates is the single-syscall rename primitive (Story 1.6).
  // After this returns, the manifest lives at absInProgressPath.
  await moveBetweenStates({
    targetRepoRoot,
    ref,
    from: "to-do",
    to: "in-progress",
  });

  // Step 5: Field rewrite.
  // Stamp claimed_by and update status. Re-parse defensively to ensure the
  // widened schema accepts the result. Serialise and write via writeManagedFile
  // (the FR81/NFR16 canonical-write guard).
  const updatedManifest = {
    ...manifest,
    status: "in-progress" as const,
    claimed_by: sessionUlid,
  };
  const reparsed = parseExecutionManifest(updatedManifest, {
    absPath: absInProgressPath,
  });
  const yamlText = yamlStringify(
    stripUndefined(reparsed as unknown as Record<string, unknown>),
    { lineWidth: 0 },
  );

  await writeManagedFile({
    absPath: absInProgressPath,
    contents: yamlText,
    targetRepoRoot,
    mcpToolContext: { toolName: "claimStory", role },
  });

  // Step 6: Sidecar snapshot (Story 5.29).
  // Capture the claim-time baseline as a sidecar at `.flow/state/in-progress/<ref>.snapshot.yaml`.
  // detectInProgressHandEdit reads this sidecar to detect operator hand-edits to
  // the in-progress manifest. The snapshot mirrors the manifest's operator-editable
  // fields + source_hash at claim time; it is removed on transition out of in-progress/.
  await writeInProgressSnapshot({ targetRepoRoot, ref, manifest: reparsed });

  return { ref, absPath: absInProgressPath };
}
