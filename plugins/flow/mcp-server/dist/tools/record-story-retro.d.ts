/**
 * `recordStoryRetro` MCP tool — Story 6.1.
 *
 * Attaches structured retro entries (`lessons[]`, `failure_class`,
 * `duration_seconds`) to a `done/<ref>.yaml` manifest after a story has
 * completed. Reviewer-side tool (Story 6.1, FR11, FR55).
 *
 * Behaviour:
 *   1. Validate `payload` via `parseStoryRetroPayload`
 *      (throws `MalformedStoryRetroPayloadError`).
 *   2. Resolve `done/<ref>.yaml`. If absent at `done/`, check
 *      `in-progress/`, `to-do/`, `blocked/` — if found, throw
 *      `StoryNotInDoneStateError({ ref, foundIn })`. If absent
 *      everywhere, throw `ManifestNotFoundError`.
 *   3. Read the done manifest via `readManifest`.
 *   4. Shallow-overwrite `lessons`, `failure_class`, `duration_seconds` on
 *      the manifest. Do not touch any other field (`rework_count` is owned
 *      by the dev/reviewer cycle).
 *   5. Re-parse the merged document through `parseExecutionManifest` — the
 *      deterministic seam: every write goes back through the validator
 *      before hitting disk.
 *   6. Write via `writeManagedFile` with `mcpToolContext`.
 *
 * **Idempotency:** the merge is a deterministic shallow overwrite, the
 * validator is pure, and YAML stringification with `lineWidth: 0` +
 * `stripUndefined` is byte-stable. Re-running with an identical payload
 * produces a byte-identical file.
 *
 * **No hand-edit guard.** This tool operates on `done/` manifests, which
 * are not subject to the in-progress hand-edit guard
 * (`detectInProgressHandEdit` is keyed to the in-progress layer).
 * Hand-edits to `done/` manifests are operator territory; retro
 * overwrites are the documented intent.
 *
 * FR11 — retro fields on story manifests.
 * FR55 — reviewer records story-level retros.
 */
export interface RecordStoryRetroOptions {
    /** Absolute path to the target repository root. */
    targetRepoRoot: string;
    /** Manifest ref (e.g. `"bmad:6.1"` or `"native:01HZ..."`). */
    ref: string;
    /** Raw retro payload — validated inside via `parseStoryRetroPayload`. */
    payload: unknown;
    /** Optional role label for `writeManagedFile`'s canonical-fs guard.
     *  Defaults to `"generalist-reviewer"` (the documented v1 caller). */
    role?: string;
}
/**
 * Attach a retro payload to a `done/<ref>.yaml` manifest.
 *
 * @returns `{ ref, absPath }` — the ref and absolute path of the
 *   rewritten `done/` manifest.
 *
 * @throws {MalformedStoryRetroPayloadError} When `payload` fails schema
 *   validation (closed-enum violation, missing `failure_class` on a
 *   `pitfall`, unknown key, etc.).
 * @throws {StoryNotInDoneStateError} When the manifest exists but lives
 *   in `to-do/`, `blocked/`, or `in-progress/` rather than `done/`.
 * @throws {ManifestNotFoundError} When the ref does not exist in any
 *   state directory.
 * @throws {MalformedExecutionManifestError} When the merged manifest
 *   fails schema validation (e.g. the on-disk `done/` manifest was
 *   already malformed for an unrelated reason).
 */
export declare function recordStoryRetro(opts: RecordStoryRetroOptions): Promise<{
    ref: string;
    absPath: string;
}>;
