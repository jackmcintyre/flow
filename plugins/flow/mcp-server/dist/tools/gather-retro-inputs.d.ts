/**
 * `gatherRetroInputs` MCP tool — Story 6.2 AC3 (FR56).
 *
 * Assembles the deterministic input bundle that the `/flow:retro` skill
 * hands to the retro-analyst subagent. This is the **input-gathering
 * seam**: a pure, side-effect-free read across the cycle's done manifests,
 * telemetry, prior proposals, and (when present) the rule registry.
 *
 * The bundle is the deterministic spine of the retro run. The analyst is
 * an LLM with read-only affordances (Story 6.2 AC5 negative-capability
 * surface); this tool guarantees that the *facts* it reasons over are
 * tool-gathered and schema-validated, not scraped from prose. See project
 * memory `feedback_default_to_deterministic_seams`.
 *
 * Returned shape `{ doneManifests, telemetrySummary, priorProposals, ruleRegistry }`:
 *
 *   - `doneManifests`: every `.yaml` under `<targetRepoRoot>/.flow/state/done/`,
 *     in deterministic alphabetical filename order, each parsed via
 *     `parseExecutionManifest`. A malformed manifest propagates as
 *     `MalformedExecutionManifestError` (NOT swallowed) — a corrupt done/
 *     manifest is a hard stop, not a skippable line. `.snapshot.yaml`
 *     sidecars (Story 5.29) are excluded. When a work cycle is open (the
 *     `.flow/cycle-state.json` file is present), this is scoped to manifests
 *     completed at or after the cycle's `opened_at` instant — a manifest's
 *     completion time is its file mtime (the done/ manifest is written by
 *     `completeStory` at completion). Story native:01KT484NY4HCBPBTT6VEY1Q0CS.
 *
 *   - `telemetrySummary`: every event from `<targetRepoRoot>/.flow/telemetry/*.jsonl`
 *     in the **current cycle window**, parsed line-by-line through
 *     `TelemetryEventSchema`. When a cycle is open, events are scoped to those
 *     whose `ts` is at or after the cycle's `opened_at`; when no cycle has ever
 *     been opened, every `.jsonl` event present at gather time is included
 *     (the existing baseline). Malformed lines (bad JSON or failed Zod) are
 *     skipped, COUNTED, and the count is returned as `skipped_count` so the
 *     analyst can flag corrupt logs without the run crashing. Files are read in
 *     alphabetical order; events preserve in-file line order. Story
 *     native:01KT484NY4HCBPBTT6VEY1Q0CS (the cycle-boundary work deferred by
 *     Story 6.12).
 *
 *   - `priorProposals`: `{ path, iso_timestamp }` for every existing
 *     `<targetRepoRoot>/.flow/retro-proposals/*.md`, sorted by ISO timestamp
 *     ascending. File contents are NOT loaded — the analyst reads them via
 *     the `Read` tool if needed (keeps the bundle bounded). `iso_timestamp`
 *     is derived from the filename stem (the writer keys files by ISO
 *     timestamp — Story 6.3).
 *
 *   - `ruleRegistry`: parsed contents of `<targetRepoRoot>/docs/discipline-rules.yaml`
 *     via the comment-preserving `yaml` package, or `null` when the file is
 *     absent. Absence is NOT an error (6a phase: the registry doesn't exist
 *     yet; Story 6.5 introduces it). The analyst proceeds with
 *     `ruleRegistry: null`.
 *
 * **No writes. No network. No clock dependency.** Pure parameterised IO.
 */
import { type CycleState } from "../schemas/cycle-state.js";
import { type ExecutionManifest } from "../schemas/execution-manifest.js";
import { type TelemetryEvent } from "../schemas/telemetry-events.js";
import { type PromotionCandidate, type RetirementCandidate, type FireCountConfig } from "../lib/failure-class-fire-counts.js";
import { type FrictionKind } from "./record-agent-friction.js";
import { type SkillEffectivenessResult } from "./compute-skill-effectiveness.js";
/**
 * One entry in the `recurringFriction` array — a friction kind that recurred
 * at or above the threshold (count >= 2) within the cycle.
 */
export interface RecurringFrictionEntry {
    /** The friction kind (closed enum from `AgentFrictionEventSchema`). */
    kind: FrictionKind;
    /** How many `agent.friction` events of this kind occurred in the cycle. */
    count: number;
}
/**
 * One entry in `mechanicalFailuresDrafted` — a recurring mechanical failure
 * (pitfall lessons sharing a `failure_class`) for which a hardening story was
 * drafted and parked in the backlog as not-ready.
 *
 * Story native:01KT6RHTE3YME1ZAD5VRQAKDSW.
 */
export interface MechanicalFailureDraft {
    /** The `failure_class` that triggered the draft. */
    failure_class: string;
    /** How many done-manifest pitfall lessons share this failure_class. */
    recurrence_count: number;
    /** The native ref of the newly-drafted hardening story. */
    hardening_story_ref: string;
    /** Absolute path to the newly-drafted hardening story file. */
    hardening_story_path: string;
}
/** Threshold: a failure_class must recur at least this many times to trigger a draft. */
export declare const MECHANICAL_FAILURE_THRESHOLD = 2;
/**
 * The deterministic input bundle handed to the retro-analyst subagent.
 */
export interface RetroInputs {
    /** Every done/ manifest, alphabetical by filename, schema-validated. */
    doneManifests: ExecutionManifest[];
    /** Telemetry events for the current cycle window plus the skipped count. */
    telemetrySummary: {
        events: TelemetryEvent[];
        /** Count of telemetry lines that failed JSON.parse or Zod validation. */
        skipped_count: number;
    };
    /** Prior proposals as `{ path, iso_timestamp }`, ascending by timestamp. */
    priorProposals: Array<{
        path: string;
        iso_timestamp: string;
    }>;
    /** Parsed discipline-rules registry, or null when the file is absent. */
    ruleRegistry: unknown | null;
    /**
     * Deterministic fire-count signal derived by `computeFailureClassFireCounts`
     * (Story 6.6). The retro-analyst MUST draft proposals from these computed
     * candidates — it MUST NOT recount fires in prose.
     *
     * `null` when the rule registry is absent (6a phase: no registry yet).
     */
    fireCountSignal: {
        promotionCandidates: PromotionCandidate[];
        retirementCandidates: RetirementCandidate[];
    } | null;
    /**
     * All `agent.friction` events from the cycle's telemetry JSONL files,
     * grouped by `kind`. Only friction that recurs at threshold (count >= 2)
     * is included — one-off noise is excluded. Empty array when no recurring
     * friction was recorded.
     *
     * The retro-analyst MUST draft proposals from these computed entries — it
     * MUST NOT recount friction from raw telemetry, mirroring the
     * `fireCountSignal` discipline.
     *
     * Story native:01KT2RAXBSQ91Y80Z51DD26KPX.
     */
    recurringFriction: RecurringFrictionEntry[];
    /**
     * Deterministic per-skill effectiveness signal computed by
     * `computeSkillEffectiveness` (Story 6.8). `per_skill` maps each skill that
     * fired in the cycle to its `invoke_count`, `useful_fire_count`, and
     * `effectiveness_ratio` (useful fires / invocations). A skill that fired but
     * never preceded a `READY FOR MERGE` verdict scores `effectiveness_ratio: 0`.
     *
     * The helper always returns a safe shape — `per_skill` is an empty map when
     * no `skill.invoke` telemetry exists — so the retro never fails on an absent
     * signal. The retro-analyst MUST cite `invoke_count` and `effectiveness_ratio`
     * from `per_skill` when drafting skill-retire or skill-revise proposals — it
     * MUST NOT recount invocations from raw telemetry, mirroring the
     * `fireCountSignal` and `recurringFriction` disciplines.
     *
     * Story native:01KT49PKTMJPJM7WMCB67TA6EY.
     */
    skillEffectiveness: SkillEffectivenessResult;
    /**
     * Hardening stories drafted during this retro run for recurring mechanical
     * failures. Each entry records the `failure_class`, the recurrence count,
     * and the newly-drafted story's ref and path. Empty when no failure class
     * meets the threshold or all qualifying classes already have a pending
     * hardening story in the backlog.
     *
     * Story native:01KT6RHTE3YME1ZAD5VRQAKDSW.
     */
    mechanicalFailuresDrafted: MechanicalFailureDraft[];
}
export interface GatherRetroInputsOptions {
    /** Absolute path to the target repository root. */
    targetRepoRoot: string;
    /**
     * Optional config for the fire-count helper. Undocumented omissions use
     * defaults (promotionThreshold=3, retirementWindows=5, relaxFloor=1).
     */
    fireCountConfig?: FireCountConfig;
    /**
     * Optional cycle-state override (Story native:01KT484NY4HCBPBTT6VEY1Q0CS).
     *
     * Test seam. When omitted, the tool reads `.flow/cycle-state.json` itself
     * (production path). Pass `null` to force the no-cycle baseline (full
     * history) regardless of any file on disk, or a `CycleState` to force a
     * specific window. Production callers (the MCP/CLI handler) never pass this.
     */
    cycleState?: CycleState | null;
    /**
     * Optional session ULID for telemetry on drafted hardening stories.
     * When omitted, hardening story telemetry uses "retro-loop" as the agent
     * session marker. (Story native:01KT6RHTE3YME1ZAD5VRQAKDSW)
     */
    sessionUlid?: string;
    /**
     * Optional override for the mechanical failure recurrence threshold.
     * Defaults to `MECHANICAL_FAILURE_THRESHOLD` (2). Test seam.
     */
    mechanicalFailureThreshold?: number;
}
/**
 * Gather the retro input bundle. See module JSDoc for full behaviour.
 *
 * @throws {MalformedExecutionManifestError} When a `done/` manifest fails
 *   schema validation. A corrupt done/ manifest is a hard stop — unlike
 *   telemetry lines, it is not skippable.
 */
export declare function gatherRetroInputs(opts: GatherRetroInputsOptions): Promise<RetroInputs>;
