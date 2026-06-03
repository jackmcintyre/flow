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
export declare function reattachOrphan(opts: ReattachOrphanOptions): Promise<ReattachOrphanResult>;
