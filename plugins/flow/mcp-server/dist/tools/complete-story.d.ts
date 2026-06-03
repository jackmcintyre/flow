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
export declare function completeStory(opts: {
    targetRepoRoot: string;
    ref: string;
    sessionUlid: string;
    role?: string;
    /** Optional clock override — test seam for deterministic timestamps. */
    now?: () => Date;
}): Promise<{
    ref: string;
    absPath: string;
}>;
