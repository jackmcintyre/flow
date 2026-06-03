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
}
/**
 * Gather the retro input bundle. See module JSDoc for full behaviour.
 *
 * @throws {MalformedExecutionManifestError} When a `done/` manifest fails
 *   schema validation. A corrupt done/ manifest is a hard stop — unlike
 *   telemetry lines, it is not skippable.
 */
export declare function gatherRetroInputs(opts: GatherRetroInputsOptions): Promise<RetroInputs>;
