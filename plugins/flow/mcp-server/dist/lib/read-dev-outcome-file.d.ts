/**
 * Shared helper: read, parse, and validate the `dev-outcome.json` file
 * written by `runDevTerminalAction`.
 *
 * Mirrors the pattern of `lib/read-reviewer-result-file.ts` (Story 4.6 revision 2):
 * - Returns `null` on ENOENT (file absent — fallback to transcript scanning).
 * - Throws `DevOutcomeFileMalformedError` on malformed JSON or any validation miss.
 *   A malformed file is a machine-write failure and must NOT silently fall back.
 *
 * Signature deliberately matches `readReviewerResultFile(targetRepoRoot, sessionUlid)`
 * so both helpers are compositionally symmetric.
 *
 * Story 4.8b Task 3 / AC2–AC4.
 */
export interface DevOutcome {
    prUrl: string;
    prNumber: number;
    branch: string;
    commitSha: string;
}
/**
 * Deterministically derive the absolute path to a story's `dev-outcome.json`
 * within a session, namespaced per ref (Story native:01KT3YDHM10FPQ77N22BTJP9AF).
 *
 * Layout: `<targetRepoRoot>/.flow/state/sessions/<sessionUlid>/<sanitised-ref>/dev-outcome.json`.
 *
 * A drain run shares ONE session ULID across every story it processes, so the
 * dev-outcome (PR-pointer) record must be namespaced per story ref — otherwise a
 * later/concurrent story clobbers an earlier one's PR record and crash-recovery
 * can resume an unbuilt story against a sibling's already-merged PR (the
 * 2026-06-02 cross-attribution regression). Mirrors `reviewerResultFilePath`
 * (Story 8.15) and reuses the same `sanitiseRefForPathSegment` helper so the
 * writer and every reader derive an identical on-disk path.
 *
 * Used by BOTH the writer (`runDevTerminalAction`) and every reader so they
 * cannot disagree on where a story's PR record lives.
 */
export declare function devOutcomeFilePath(targetRepoRoot: string, sessionUlid: string, ref: string): string;
/**
 * Read, parse, and validate the `dev-outcome.json` file written by
 * `runDevTerminalAction`. Returns `null` when the file is absent (ENOENT).
 * Throws `DevOutcomeFileMalformedError` on malformed JSON or unexpected shape.
 *
 * Story native:01KT3YDHM10FPQ77N22BTJP9AF: now takes the story `ref` and reads
 * from the per-ref namespaced path so two stories sharing one session ULID keep
 * independent PR records.
 *
 * @param targetRepoRoot - Absolute path to the target repository root.
 * @param sessionUlid - ULID of the calling session.
 * @param ref - Story ref, used to derive the per-story dev-outcome path.
 */
export declare function readDevOutcomeFile(targetRepoRoot: string, sessionUlid: string, ref: string): Promise<DevOutcome | null>;
