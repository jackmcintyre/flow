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
export declare function claimStory(opts: {
    targetRepoRoot: string;
    ref: string;
    sessionUlid: string;
    role?: string;
}): Promise<{
    ref: string;
    absPath: string;
}>;
