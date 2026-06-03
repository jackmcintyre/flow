import { rename, mkdir, stat, readFile, unlink } from "node:fs/promises";
import * as path from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import {
  CrossFilesystemMoveError,
  InProgressHandEditError,
  InvalidStateNameError,
  ManifestNotFoundError,
} from "../errors.js";
import type { ExecutionManifest } from "../schemas/execution-manifest.js";
import { parseExecutionManifest } from "../schemas/execution-manifest.js";
import { atomicWriteFile } from "../lib/managed-fs.js";

/**
 * The canonical state-machine directory names. A manifest at
 * `<targetRepoRoot>/.flow/state/<state>/<ref>.yaml` is
 * "in" the named state by virtue of its parent directory. (NFR8)
 */
export const STATE_NAMES = [
  "to-do",
  "in-progress",
  "blocked",
  "done",
] as const;

export type StateName = (typeof STATE_NAMES)[number];

export interface MoveResult {
  from: StateName;
  to: StateName;
  ref: string;
  absFromPath: string;
  absToPath: string;
}

/**
 * Narrow filesystem-injection seam used for testing the EXDEV /
 * spy-on-call-count paths. Production callers must NOT pass `fsImpl` —
 * the default binds to `node:fs/promises`. The interface deliberately
 * exposes ONLY `rename`, `mkdir`, `stat` so a maintainer cannot
 * accidentally introduce a copy+delete fallback (which would violate
 * NFR8's single-syscall atomicity).
 */
export interface FsImpl {
  rename(from: string, to: string): Promise<void>;
  mkdir(dir: string, opts: { recursive: true }): Promise<unknown>;
  stat(p: string): Promise<unknown>;
}

const DEFAULT_FS_IMPL: FsImpl = {
  rename: (from, to) => rename(from, to),
  mkdir: (dir, opts) => mkdir(dir, opts),
  stat: (p) => stat(p),
};

function isStateName(value: string): value is StateName {
  return (STATE_NAMES as readonly string[]).includes(value);
}

/**
 * Move a manifest between two canonical state directories via a
 * single `fs.rename(2)` syscall. This is the ONLY file in
 * `mcp-server/src/**` permitted to invoke `rename` against a
 * state-machine path (enforced by a static guard in
 * `tests/canonical-fs-guard.test.ts`).
 *
 * The function is a pure structural primitive — it does NOT read or
 * write manifest contents, does NOT emit telemetry, does NOT acquire
 * locks. POSIX `rename(2)` (and the macOS/Linux equivalents) is itself
 * the atomicity guarantee within a single filesystem. Cross-filesystem
 * moves are explicitly out of v1 scope: an `EXDEV` errno surfaces as
 * a typed `CrossFilesystemMoveError` with no copy+delete fallback.
 *
 * See Story 1.6, `core-architectural-decisions.md` lines 27–40,
 * NFR8 / NFR9 / NFR19.
 */
export async function moveBetweenStates(opts: {
  targetRepoRoot: string;
  ref: string;
  from: StateName;
  to: StateName;
  fsImpl?: FsImpl;
}): Promise<MoveResult> {
  const { targetRepoRoot, ref, from, to } = opts;
  const fsImpl = opts.fsImpl ?? DEFAULT_FS_IMPL;

  // 1. Validate state names. No filesystem touch.
  if (!isStateName(from) || !isStateName(to)) {
    throw new InvalidStateNameError({
      attemptedFrom: from,
      attemptedTo: to,
      allowedStates: STATE_NAMES,
      reason: "unknown state name",
    });
  }

  // 2. Compute paths.
  const stateRoot = path.join(targetRepoRoot, ".flow", "state");
  const absFromPath = path.join(stateRoot, from, ref + ".yaml");
  const absToPath = path.join(stateRoot, to, ref + ".yaml");

  // 3. Path-escape guard (mirrors managed-fs.ts line 85). The `ref`
  //    parameter is not regex-validated; this is the last line of
  //    defense against `ref` values like `../../etc/passwd`.
  for (const absPath of [absFromPath, absToPath]) {
    const rel = path.relative(stateRoot, absPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new InvalidStateNameError({
        attemptedFrom: from,
        attemptedTo: to,
        allowedStates: STATE_NAMES,
        reason: "path escapes state root",
      });
    }
  }

  // 4. Ensure destination directory exists. `fs.rename` does NOT
  //    create parent directories itself.
  await fsImpl.mkdir(path.dirname(absToPath), { recursive: true });

  // 5. Single rename syscall. NO copy+delete fallback on EXDEV.
  try {
    await fsImpl.rename(absFromPath, absToPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EXDEV") {
      throw new CrossFilesystemMoveError({
        absFromPath,
        absToPath,
        ref,
        originalCode: "EXDEV",
      });
    }
    if (code === "ENOENT") {
      throw new ManifestNotFoundError({
        ref,
        expectedAbsPath: absFromPath,
        fromState: from,
      });
    }
    throw err;
  }

  return { from, to, ref, absFromPath, absToPath };
}

/**
 * The operator-editable subset of `ExecutionManifest`. These are the fields
 * an operator may legitimately hand-edit in a `to-do/` or `blocked/` manifest.
 * The same fields are what `detectInProgressHandEdit` monitors for mutation in
 * `in-progress/` manifests, where hand-edits are NOT permitted.
 *
 * Story 3.7 — FR14.
 */
export type OperatorEditableFields = Pick<
  ExecutionManifest,
  | "title"
  | "narrative"
  | "acceptance_criteria"
  | "implementation_notes"
  | "depends_on"
  | "withdrawn"
>;

/**
 * Deep-equality helper for `OperatorEditableFields`.
 *
 * Uses order-sensitive comparison for arrays (`acceptance_criteria`, `depends_on`).
 * Scalar fields use strict equality. Intentionally hand-rolled — the comparison
 * surface is small (six fields with known shapes) and adding a dependency like
 * `lodash.isequal` would be speculative. (Story 3.7 — no new deps.)
 */
function operatorFieldsEqual(a: OperatorEditableFields, b: OperatorEditableFields): boolean {
  if (a.title !== b.title) return false;
  if (a.narrative !== b.narrative) return false;
  if (a.implementation_notes !== b.implementation_notes) return false;
  if (a.withdrawn !== b.withdrawn) return false;

  // acceptance_criteria — order-sensitive deep equal on { text, kind } objects.
  if (a.acceptance_criteria.length !== b.acceptance_criteria.length) return false;
  for (let i = 0; i < a.acceptance_criteria.length; i++) {
    const ac_a = a.acceptance_criteria[i]!;
    const ac_b = b.acceptance_criteria[i]!;
    if (ac_a.text !== ac_b.text || ac_a.kind !== ac_b.kind) return false;
  }

  // depends_on — order-sensitive string array.
  if (a.depends_on.length !== b.depends_on.length) return false;
  for (let i = 0; i < a.depends_on.length; i++) {
    if (a.depends_on[i] !== b.depends_on[i]) return false;
  }

  return true;
}

/**
 * Sidecar baseline shape — the operator-editable fields plus `source_hash`,
 * snapshotted at claim time. Written by `writeInProgressSnapshot` (called from
 * `claimStory`), read by `detectInProgressHandEdit`, removed by
 * `removeInProgressSnapshot` on transition out of `in-progress/`.
 */
export interface InProgressSnapshot {
  source_hash: string;
  title: string;
  narrative: string;
  acceptance_criteria: OperatorEditableFields["acceptance_criteria"];
  implementation_notes: string | undefined;
  depends_on: readonly string[];
  withdrawn: boolean;
}

/**
 * Absolute path to the sidecar snapshot file for a given ref.
 */
function snapshotPath(targetRepoRoot: string, ref: string): string {
  return path.join(targetRepoRoot, ".flow", "state", "in-progress", `${ref}.snapshot.yaml`);
}

/**
 * Write the claim-time baseline sidecar for a ref into `.flow/state/in-progress/<ref>.snapshot.yaml`.
 *
 * Called by `claimStory` after the manifest has been moved to `in-progress/`,
 * capturing the source-hash and operator-editable-field values that the manifest
 * was claimed with. `detectInProgressHandEdit` reads this sidecar as the baseline
 * to compare the on-disk manifest against.
 *
 * The sidecar is written via `atomicWriteFile` (POSIX rename(2)) so readers never
 * see a partial file. The path falls under the canonical `.flow/state/**` glob.
 *
 * Story 5.29.
 */
export async function writeInProgressSnapshot(opts: {
  targetRepoRoot: string;
  ref: string;
  manifest: ExecutionManifest;
}): Promise<{ absPath: string }> {
  const { targetRepoRoot, ref, manifest } = opts;
  const absPath = snapshotPath(targetRepoRoot, ref);
  const snapshot: InProgressSnapshot = {
    source_hash: manifest.source_hash,
    title: manifest.title,
    narrative: manifest.narrative,
    acceptance_criteria: manifest.acceptance_criteria,
    implementation_notes: manifest.implementation_notes,
    depends_on: manifest.depends_on,
    withdrawn: manifest.withdrawn,
  };
  const yamlText = yamlStringify(snapshot, { lineWidth: 0 });
  await atomicWriteFile(absPath, yamlText);
  return { absPath };
}

/**
 * Best-effort removal of the sidecar snapshot. Used when a manifest leaves
 * `in-progress/` (to `done/` or back to `to-do/`). A missing sidecar is not
 * an error — the manifest move is the authoritative state transition.
 *
 * Story 5.29.
 */
export async function removeInProgressSnapshot(opts: {
  targetRepoRoot: string;
  ref: string;
}): Promise<void> {
  const { targetRepoRoot, ref } = opts;
  const absPath = snapshotPath(targetRepoRoot, ref);
  try {
    await unlink(absPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return; // best-effort — already gone
    throw err;
  }
}

/**
 * Load the claim-time baseline snapshot for a ref. Returns `null` if the
 * sidecar does not exist — callers decide whether absence is a hand-edit signal
 * or a legitimate "not yet claimed" state.
 *
 * Story 5.29.
 */
async function readInProgressSnapshot(opts: {
  targetRepoRoot: string;
  ref: string;
}): Promise<InProgressSnapshot | null> {
  const { targetRepoRoot, ref } = opts;
  const absPath = snapshotPath(targetRepoRoot, ref);
  try {
    const raw = await readFile(absPath, "utf8");
    const parsed = yamlParse(raw) as InProgressSnapshot;
    return parsed;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Detects whether an `in-progress/` manifest has been hand-edited since it
 * was claimed by the dev loop.
 *
 * **New contract (Story 5.29):** compares the on-disk in-progress manifest
 * against the claim-time manifest snapshot persisted as a sidecar file at
 * `.flow/state/in-progress/<ref>.snapshot.yaml`. **Does not consult the
 * source story file.** Source-hash drift between the manifest and the live
 * source story is no longer a hand-edit signal — that legitimate dev
 * workflow (filling `## Implementation Notes` in the source story) used to
 * trip every close-out before Story 5.29. Source-story tamper detection,
 * if ever needed, is a separate concern (`scan-sources` already handles
 * source-hash drift at the `to-do/` layer).
 *
 * **Guard contract:**
 * - Returns `{ ok: true }` when the on-disk manifest's `source_hash` and all
 *   operator-editable fields match the sidecar snapshot exactly.
 * - Throws `InProgressHandEditError` (with the list of changed fields) when
 *   any field has been mutated. The list includes `"source_hash"` if that
 *   field drifted between manifest and snapshot.
 * - Throws `InProgressHandEditError` with `changedFields: ["_snapshot_missing"]`
 *   when the sidecar is absent. A claimed manifest without its snapshot is a
 *   corrupted state (the operator removed the sidecar; `claimStory` would
 *   never have left it that way). Treating this as a hand-edit signal is
 *   defensible: the operator has interfered with state-machine bookkeeping.
 * - Propagates `MalformedExecutionManifestError` unchanged when the on-disk
 *   manifest is structurally invalid — a malformed manifest is a worse problem
 *   than a hand-edit and must surface via existing FR13 handling.
 * - Propagates `ManifestNotFoundError` when the manifest does not exist at the
 *   expected path — callers route based on state and should not invoke this
 *   guard for refs that are not in `in-progress/`.
 *
 * **Caller contract:**
 * Epic 4/5 callers MUST invoke this guard on entry for any ref they would
 * operate on in the `in-progress/` layer. The guard is NOT called defensively
 * on every skill invocation — only for refs the tool would otherwise act on.
 * (Story 5.29 supersedes Story 3.7's `{ sourceHash, sourceFields }` baseline
 * argument with sidecar-driven baseline loading.)
 *
 * **Pure with respect to writes:** never modifies the manifest, never moves it.
 *
 * @param opts.targetRepoRoot - Absolute path to the target repository root.
 * @param opts.ref - Manifest ref (e.g. `"native:01HZ..."`).
 *
 * @throws {InProgressHandEditError} When a hand-edit is detected.
 * @throws {MalformedExecutionManifestError} When the manifest is structurally invalid.
 * @throws {ManifestNotFoundError} When the manifest does not exist in `in-progress/`.
 */
export async function detectInProgressHandEdit(opts: {
  targetRepoRoot: string;
  ref: string;
}): Promise<{ ok: true }> {
  const { targetRepoRoot, ref } = opts;

  const absPath = path.join(targetRepoRoot, ".flow", "state", "in-progress", ref + ".yaml");

  // Read the on-disk manifest. Propagate ENOENT as ManifestNotFoundError.
  let rawText: string;
  try {
    rawText = await readFile(absPath, "utf8");
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

  // Parse: propagate MalformedExecutionManifestError unchanged.
  const parsed = yamlParse(rawText) as unknown;
  const manifest = parseExecutionManifest(parsed, { absPath });

  // Load the claim-time sidecar snapshot.
  const snapshot = await readInProgressSnapshot({ targetRepoRoot, ref });

  if (snapshot === null) {
    throw new InProgressHandEditError({
      ref,
      changedFields: ["_snapshot_missing"],
      absPath,
    });
  }

  // Detect changed fields by comparing manifest against snapshot.
  const changedFields: string[] = [];

  if (manifest.source_hash !== snapshot.source_hash) {
    changedFields.push("source_hash");
  }

  const snapshotFields: OperatorEditableFields = {
    title: snapshot.title,
    narrative: snapshot.narrative,
    acceptance_criteria: snapshot.acceptance_criteria,
    implementation_notes: snapshot.implementation_notes,
    depends_on: [...snapshot.depends_on],
    withdrawn: snapshot.withdrawn,
  };

  const diskFields: OperatorEditableFields = {
    title: manifest.title,
    narrative: manifest.narrative,
    acceptance_criteria: manifest.acceptance_criteria,
    implementation_notes: manifest.implementation_notes,
    depends_on: manifest.depends_on,
    withdrawn: manifest.withdrawn,
  };

  if (!operatorFieldsEqual(diskFields, snapshotFields)) {
    if (diskFields.title !== snapshotFields.title) changedFields.push("title");
    if (diskFields.narrative !== snapshotFields.narrative) changedFields.push("narrative");
    if (diskFields.implementation_notes !== snapshotFields.implementation_notes)
      changedFields.push("implementation_notes");
    if (diskFields.withdrawn !== snapshotFields.withdrawn) changedFields.push("withdrawn");

    const acA = diskFields.acceptance_criteria;
    const acB = snapshotFields.acceptance_criteria;
    let acDiffers = acA.length !== acB.length;
    if (!acDiffers) {
      for (let i = 0; i < acA.length; i++) {
        if (acA[i]!.text !== acB[i]!.text || acA[i]!.kind !== acB[i]!.kind) {
          acDiffers = true;
          break;
        }
      }
    }
    if (acDiffers) changedFields.push("acceptance_criteria");

    const doA = diskFields.depends_on;
    const doB = snapshotFields.depends_on;
    let doDiffers = doA.length !== doB.length;
    if (!doDiffers) {
      for (let i = 0; i < doA.length; i++) {
        if (doA[i] !== doB[i]) {
          doDiffers = true;
          break;
        }
      }
    }
    if (doDiffers) changedFields.push("depends_on");
  }

  if (changedFields.length > 0) {
    throw new InProgressHandEditError({ ref, changedFields, absPath });
  }

  return { ok: true };
}

/**
 * Single load-bearing predicate for the dev-loop claim path.
 *
 * Returns `true` iff the manifest is eligible to be claimed by the dev loop:
 * the manifest must be in the `to-do` state AND must not have been withdrawn
 * via `/flow:plan discard`. Once `withdrawn: true` is set (Story 3.6), the
 * manifest is permanently out of the claim candidate set until an operator
 * hand-edits it back (Story 3.7's territory).
 *
 * **Pure — no I/O.** Epic 5's claim loop imports this predicate as the single
 * source of truth for "withdrawn means skipped". Co-located here with the
 * other state-machine primitives to ensure it is imported from one place.
 *
 * Story 3.6 — `isClaimable` predicate.
 * Epic 5 pickup: the claim loop calls `isClaimable(manifest)` before claiming.
 */
export function isClaimable(manifest: ExecutionManifest): boolean {
  return manifest.withdrawn === false && manifest.status === "to-do";
}
