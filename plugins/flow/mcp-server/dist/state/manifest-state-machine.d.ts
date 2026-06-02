import type { ExecutionManifest } from "../schemas/execution-manifest.js";
/**
 * The canonical state-machine directory names. A manifest at
 * `<targetRepoRoot>/.flow/state/<state>/<ref>.yaml` is
 * "in" the named state by virtue of its parent directory. (NFR8)
 */
export declare const STATE_NAMES: readonly ["to-do", "in-progress", "blocked", "done"];
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
    mkdir(dir: string, opts: {
        recursive: true;
    }): Promise<unknown>;
    stat(p: string): Promise<unknown>;
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
export declare function moveBetweenStates(opts: {
    targetRepoRoot: string;
    ref: string;
    from: StateName;
    to: StateName;
    fsImpl?: FsImpl;
}): Promise<MoveResult>;
/**
 * The operator-editable subset of `ExecutionManifest`. These are the fields
 * an operator may legitimately hand-edit in a `to-do/` or `blocked/` manifest.
 * The same fields are what `detectInProgressHandEdit` monitors for mutation in
 * `in-progress/` manifests, where hand-edits are NOT permitted.
 *
 * Story 3.7 — FR14.
 */
export type OperatorEditableFields = Pick<ExecutionManifest, "title" | "narrative" | "acceptance_criteria" | "implementation_notes" | "depends_on" | "withdrawn">;
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
export declare function writeInProgressSnapshot(opts: {
    targetRepoRoot: string;
    ref: string;
    manifest: ExecutionManifest;
}): Promise<{
    absPath: string;
}>;
/**
 * Best-effort removal of the sidecar snapshot. Used when a manifest leaves
 * `in-progress/` (to `done/` or back to `to-do/`). A missing sidecar is not
 * an error — the manifest move is the authoritative state transition.
 *
 * Story 5.29.
 */
export declare function removeInProgressSnapshot(opts: {
    targetRepoRoot: string;
    ref: string;
}): Promise<void>;
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
export declare function detectInProgressHandEdit(opts: {
    targetRepoRoot: string;
    ref: string;
}): Promise<{
    ok: true;
}>;
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
export declare function isClaimable(manifest: ExecutionManifest): boolean;
