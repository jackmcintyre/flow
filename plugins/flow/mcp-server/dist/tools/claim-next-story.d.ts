/**
 * `claimNextStory` MCP tool — Story 4.3b Task 1.
 *
 * Wraps a single iteration of the outer claim-loop: enumerates claimable
 * to-do manifests, picks the first `depsReady: true` candidate, atomically
 * claims it, and returns either a spawn-dev signal or a terminal signal.
 *
 * **Behavioural contract source:**
 * `_bmad-output/implementation-artifacts/4-3b-harness-task-spawn-seam-for-rundevsession.md § Behavioural contract`
 *
 * The SKILL.md prose drives the outer iteration loop by calling this tool
 * repeatedly until it returns `{ next: "queue-drained" }` or
 * `{ next: "waiting-on-in-progress" }`. This keeps the prose's control flow
 * to a simple switch on `next` — no manual `to-do/` parsing, no ref picking,
 * no `claimStory` / `listClaimableTodos` calls from the prose layer.
 *
 * Chat lines flow through the returned `chatLog: string[]` — no console.*.
 * Errors propagate as typed `DomainError`s; `register.ts` wraps them into
 * `isError: true` content responses.
 *
 * Story 4.3b Task 1.1–1.6.
 */
/** Verbatim queue-drained line from AC3 / AC5(iv) — do not paraphrase. */
export declare const QUEUE_DRAINED_LINE = "queue drained \u2014 to-do/ and in-progress/ are both empty. Stop here, or run /flow:plan to add work.";
/** Verbatim waiting-on-in-progress line — do not paraphrase. */
export declare const WAITING_ON_IN_PROGRESS_LINE = "waiting on in-progress work \u2014 no claimable todos this pass. Stop here or wait for in-progress stories to complete.";
export interface ClaimNextStoryOptions {
    targetRepoRoot: string;
    sessionUlid: string;
}
export type ClaimNextStoryResult = {
    next: "spawn-dev";
    ref: string;
    title: string;
    manifestPath: string;
    chatLog: string[];
} | {
    next: "queue-drained";
    chatLog: string[];
} | {
    next: "waiting-on-in-progress";
    chatLog: string[];
};
/**
 * Claim the next ready story from the to-do queue.
 *
 * Single-iteration outer claim-loop step: the SKILL.md prose calls this in
 * a loop until it returns `queue-drained` or `waiting-on-in-progress`.
 *
 * @param opts.targetRepoRoot - Absolute path to the target repository root.
 * @param opts.sessionUlid - ULID minted by `mintSessionUlid`; stamped as
 *   `claimed_by` in the in-progress manifest.
 * @returns A discriminated-union result with `next` as the control-flow signal.
 */
export declare function claimNextStory(opts: ClaimNextStoryOptions): Promise<ClaimNextStoryResult>;
