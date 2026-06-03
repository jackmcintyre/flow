/**
 * `blockOrphanNoTranscript` MCP tool — Story 5.11 Task 3.
 *
 * Handles the no-transcript path of the orphan-recovery branch in `/flow:start`.
 * When the operator chooses `reattach` but no persisted transcript exists, this
 * tool:
 *   1. Moves the manifest from `in-progress/` to `blocked/` via `moveBetweenStates`.
 *   2. Loads the now-blocked manifest from `blocked/<ref>.yaml`.
 *   3. Stamps `blocked_by: "orphan-no-transcript"` via `writeManifest`.
 *   4. Returns the verbatim AC3 chat log line.
 *
 * The two operations (move + stamp) run in order. If the move succeeds but the
 * field-write fails, the manifest lands in `blocked/` without `blocked_by` —
 * recoverable by the operator (matches the existing pattern from
 * `processDevTranscript`'s grammar-drift branch). No compound primitive is
 * introduced.
 *
 * Adds `orphan-no-transcript` to the de-facto `blocked_by` taxonomy established
 * by Stories 4.3b / 4.5. Story 5.1 will formalise the taxonomy when it ships.
 *
 * Architecture §MCP Tool Naming — camelCase verb-noun: `blockOrphanNoTranscript`.
 * Story 5.11 Task 3.1–3.5.
 */
export interface BlockOrphanNoTranscriptResult {
    chatLog: string[];
}
export interface BlockOrphanNoTranscriptOptions {
    targetRepoRoot: string;
    ref: string;
    staleUlid: string;
}
/**
 * Block an orphaned in-progress manifest that has no persisted transcript.
 *
 * Moves the manifest from `in-progress/` to `blocked/` and stamps
 * `blocked_by: "orphan-no-transcript"`.
 *
 * @param opts.targetRepoRoot - Absolute path to the target repository root.
 * @param opts.ref - Manifest ref (e.g. `"native:01HZ..."` or `"bmad:1.1"`).
 * @param opts.staleUlid - The stale session ULID from the manifest's `claimed_by`.
 *
 * @returns `{ chatLog }` — a one-entry array with the blocked log line.
 *
 * @throws {ManifestNotFoundError} When the ref is absent from `in-progress/`.
 * @throws {MalformedExecutionManifestError} When the manifest fails schema validation.
 */
export declare function blockOrphanNoTranscript(opts: BlockOrphanNoTranscriptOptions): Promise<BlockOrphanNoTranscriptResult>;
