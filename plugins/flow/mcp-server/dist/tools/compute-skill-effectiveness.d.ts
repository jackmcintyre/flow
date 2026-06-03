/**
 * `computeSkillEffectiveness` helper — Story 6.8.
 *
 * Pure, deterministic, no LLM — the skill-side analogue of `computeAgreement`
 * (architecture: "matches NFR23 style"). Reads every `*.jsonl` file under
 * `<targetRepoRoot>/.flow/telemetry/`, parses lines via `TelemetryEventSchema`,
 * keeps `skill.invoke` and `reviewer.verdict` events, joins each invocation to
 * a later `READY FOR MERGE` verdict in the same story flow, and reports per
 * skill:
 *
 *   - `invoke_count`        — count of `skill.invoke` events for the skill.
 *   - `useful_fire_count`   — invocations followed by a `READY FOR MERGE`
 *                             `reviewer.verdict` within the same story flow
 *                             (join on `session_id`, and on `story_id` too when
 *                             both events carry one).
 *   - `effectiveness_ratio` — `useful_fire_count / invoke_count` (`0` when the
 *                             skill fired but no useful fire followed; never
 *                             `NaN` — a skill with `invoke_count === 0` does
 *                             not appear in the map at all).
 *
 * Returns a `.strict()` typed result mirroring `AgreementMetricResultSchema`:
 * a per-skill map plus `window_size`, `sample_size`, and `malformed_lines`.
 *
 * ### Determinism
 * Same telemetry → same numbers. The only IO is the injected (or real)
 * directory listing + file reads; no clock, no network. Files are read in
 * deterministic lex order; events are sorted newest-first by `ts` with a stable
 * `session_id` tie-break before the window is applied.
 *
 * ### The window
 * `window` bounds which most-recent `skill.invoke` events are considered (sort
 * all invocations newest-first by `ts`, take the first `window`). `window_size`
 * reports the requested bound; `sample_size` reports the number of invocations
 * actually inside the window (≤ `window`). `reviewer.verdict` events are NOT
 * windowed — a windowed invocation may join a verdict that itself fell outside
 * the invocation window, which is correct (the window selects which
 * invocations to score, not which verdicts may resolve them).
 *
 * ### Edge cases (pinned by AC2/AC3 + Implementation Notes)
 * - **Zero invocations.** Returns the documented empty result: an empty
 *   `per_skill` map (NOT an error, NOT `null` — callers always get a shape).
 * - **Invoked-but-never-useful skill.** `useful_fire_count: 0`,
 *   `effectiveness_ratio: 0` (not `NaN`).
 * - **Invocation with no `story_id`.** Counts toward `invoke_count`; it joins
 *   on `session_id` only. It is KEPT in the denominator (recommended in the
 *   Implementation Notes) — a user-slash-command outside a story flow can still
 *   be a useful fire if a same-session `READY FOR MERGE` verdict follows it.
 * - **Multiple invokes before one verdict.** EACH invocation that has a
 *   qualifying later verdict counts as a useful fire (the rule is per-
 *   invocation, not per-story); a story with two invokes and one
 *   `READY FOR MERGE` scores both as useful. Documented + tested.
 * - **Malformed JSONL lines** are skipped and counted in `malformed_lines`,
 *   never fatal.
 * - **Under-count on the fallback capture seam.** If a SKILL.md first-step
 *   skips its `recordSkillInvoke` call, that invocation is simply absent from
 *   the telemetry — the ratio stays meaningful over the captured invocations,
 *   but it is NOT a claim of total coverage. Surfaced in the story docs, not
 *   silently capped here.
 *
 * Story 6.8 · Architecture: skill-calibration-loop.md.
 */
import { z } from "zod";
/**
 * Default window — the most-recent `skill.invoke` events considered. Chosen to
 * mirror `computeAgreement`'s default rolling window; the consumer (the retro
 * analyst's retirement criterion) overrides it per its observation window.
 */
export declare const DEFAULT_SKILL_EFFECTIVENESS_WINDOW = 50;
/**
 * Per-skill effectiveness stats. `.strict()` so unknown-key injection is
 * rejected (mirrors `AgreementMetricResultSchema`'s posture).
 */
export declare const PerSkillEffectivenessSchema: z.ZodObject<{
    invoke_count: z.ZodNumber;
    useful_fire_count: z.ZodNumber;
    effectiveness_ratio: z.ZodNumber;
}, z.core.$strict>;
export type PerSkillEffectiveness = z.infer<typeof PerSkillEffectivenessSchema>;
/**
 * Zod schema for the `computeSkillEffectiveness` return value. Mirrors
 * `AgreementMetricResultSchema`: a deterministic, `.strict()` result with the
 * per-skill map plus the window/sample/malformed bookkeeping. The empty case
 * is an empty `per_skill` map (NOT `null`) — callers always get a shape.
 */
export declare const SkillEffectivenessResultSchema: z.ZodObject<{
    per_skill: z.ZodRecord<z.ZodString, z.ZodObject<{
        invoke_count: z.ZodNumber;
        useful_fire_count: z.ZodNumber;
        effectiveness_ratio: z.ZodNumber;
    }, z.core.$strict>>;
    window_size: z.ZodNumber;
    sample_size: z.ZodNumber;
    malformed_lines: z.ZodNumber;
}, z.core.$strict>;
export type SkillEffectivenessResult = z.infer<typeof SkillEffectivenessResultSchema>;
export interface ComputeSkillEffectivenessOptions {
    targetRepoRoot: string;
    /** Most-recent `skill.invoke` events to score. Defaults to `DEFAULT_SKILL_EFFECTIVENESS_WINDOW`. */
    window?: number;
    /**
     * Test seam: inject a fake directory reader. Returns the sorted list of
     * `.jsonl` filenames in the telemetry dir. Production callers do not pass this.
     */
    readTelemetryDirImpl?: (dirPath: string) => Promise<string[]>;
    /**
     * Test seam: inject a fake file reader. Production callers do not pass this.
     */
    readFileImpl?: (filePath: string) => Promise<string>;
}
/**
 * Compute per-skill effectiveness from `skill.invoke` events joined to
 * downstream `READY FOR MERGE` reviewer verdicts.
 *
 * Always returns a result shape (never `null`, never throws on empty/malformed
 * input). Throws `SkillEffectivenessWindowInvalidError` only on an invalid
 * `window` value.
 *
 * Story 6.8.
 */
export declare function computeSkillEffectiveness(opts: ComputeSkillEffectivenessOptions): Promise<SkillEffectivenessResult>;
