/**
 * `processReviewerYield` MCP tool — Story 4.11 Task 4.
 *
 * Composes `yield-parser` + `lookupRoleByDomain` (FR99) + `buildPersonaSpawnPrompt`
 * + `logTelemetryEvent` into a single deterministic seam. The SKILL.md prose
 * (in the future wiring story) calls this BEFORE `postReviewerComments` /
 * `processReviewerTranscript` when the reviewer Task returns.
 *
 * Returns a discriminated `next:` value:
 *  - `"no-yield"` — the common path; pass through to the existing flow.
 *  - `"spawn-specialist-reviewer"` — FR100 success branch; caller spawns the specialist.
 *  - `"done-blocked-routing-failure"` — FR100 failure branch; no hired role matched.
 *  - `"done-blocked-routing-self-yield"` — AC2c guard; specialist tried to yield to its own domain.
 *
 * **Chain-depth cap (v1 = 1):**
 * This tool is called by SKILL.md prose AFTER the *generalist* reviewer's Task
 * returns. The wiring story (not this story) is responsible for NOT calling
 * `processReviewerYield` after a *specialist* reviewer Task — i.e. a specialist's
 * transcript is never re-parsed for yields. The `fromRole` parameter carries the
 * role that just ran; the self-yield guard (step v) catches the trivial loop.
 * Multi-specialist chain support is deferred.
 *
 * **Telemetry:**
 * A `yield.handoff` event is emitted ONLY on the success branch (FR103, NFR29).
 * Telemetry failure is non-fatal — the spawn prompt is returned regardless.
 *
 * **Manifest stamp:**
 * Failure branches write `blocked_by: "routing-failure"` or `blocked_by:
 * "routing-self-yield"` to the in-progress manifest. Atomic write via
 * `writeManifest` (Story 1.6's primitive).
 *
 * Story 4.11 Task 4.1–4.5. References: FR99, FR100, FR101, FR102, FR103, FR104, NFR29.
 */
export type ProcessReviewerYieldResult = {
    next: "no-yield";
    chatLog: string[];
} | {
    next: "spawn-specialist-reviewer";
    toRole: string;
    specialistPrompt: string;
    chatLog: string[];
} | {
    next: "done-blocked-routing-failure";
    chatLog: string[];
} | {
    next: "done-blocked-routing-self-yield";
    chatLog: string[];
};
export interface ProcessReviewerYieldOptions {
    targetRepoRoot: string;
    sessionUlid: string;
    ref: string;
    fromRole: string;
    reviewerTranscript: string;
    manifestPath: string;
}
/**
 * Process the reviewer subagent's transcript for a yield phrase, and route
 * the review to the appropriate specialist if one is found.
 *
 * Algorithm (AC1 unpacked, 1e):
 *  (i)   Call `parseYield` on the reviewer's transcript.
 *  (ii)  If `ok: false`, return `no-yield` (chatLog empty — common path is silent).
 *  (iii) If `ok: true`, call `lookupRoleByDomain({ targetRepoRoot, domain })`.
 *  (iv)  If `role === null`, stamp manifest `blocked_by: "routing-failure"` and
 *        return `done-blocked-routing-failure`.
 *  (v)   If `role === fromRole` (self-yield: specialist named its own domain),
 *        stamp `blocked_by: "routing-self-yield"` and return the guard response.
 *  (vi)  Else call `buildPersonaSpawnPrompt({ targetRepoRoot, role })`, emit
 *        `yield.handoff` telemetry, return `spawn-specialist-reviewer`.
 *
 * @param opts.targetRepoRoot - Absolute path to the target repository root.
 * @param opts.sessionUlid - ULID of the calling session.
 * @param opts.ref - Story ref (e.g. `"native:01HZ..."`).
 * @param opts.fromRole - Role that just ran (kebab-case, e.g. `"generalist-reviewer"`).
 * @param opts.reviewerTranscript - The reviewer subagent's complete final message, verbatim.
 * @param opts.manifestPath - Absolute path to the in-progress manifest YAML.
 */
export declare function processReviewerYield(opts: ProcessReviewerYieldOptions): Promise<ProcessReviewerYieldResult>;
