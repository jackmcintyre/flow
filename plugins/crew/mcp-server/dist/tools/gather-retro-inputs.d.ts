/**
 * `gatherRetroInputs` MCP tool — Story 6.2 AC3 (FR56).
 *
 * Assembles the deterministic input bundle that the `/crew:retro` skill
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
 *   - `doneManifests`: every `.yaml` under `<targetRepoRoot>/.crew/state/done/`,
 *     in deterministic alphabetical filename order, each parsed via
 *     `parseExecutionManifest`. A malformed manifest propagates as
 *     `MalformedExecutionManifestError` (NOT swallowed) — a corrupt done/
 *     manifest is a hard stop, not a skippable line. `.snapshot.yaml`
 *     sidecars (Story 5.29) are excluded.
 *
 *   - `telemetrySummary`: every event from `<targetRepoRoot>/.crew/telemetry/*.jsonl`
 *     in the **current cycle window** (v1: every `.jsonl` file present at
 *     gather time — cycle boundaries land in Story 6.12), parsed line-by-line
 *     through `TelemetryEventSchema`. Malformed lines (bad JSON or failed Zod)
 *     are skipped, COUNTED, and the count is returned as `skipped_count` so
 *     the analyst can flag corrupt logs without the run crashing. Files are
 *     read in alphabetical order; events preserve in-file line order.
 *
 *   - `priorProposals`: `{ path, iso_timestamp }` for every existing
 *     `<targetRepoRoot>/.crew/retro-proposals/*.md`, sorted by ISO timestamp
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
import { type ExecutionManifest } from "../schemas/execution-manifest.js";
import { type TelemetryEvent } from "../schemas/telemetry-events.js";
import { type PromotionCandidate, type RetirementCandidate, type FireCountConfig } from "../lib/failure-class-fire-counts.js";
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
}
export interface GatherRetroInputsOptions {
    /** Absolute path to the target repository root. */
    targetRepoRoot: string;
    /**
     * Optional config for the fire-count helper. Undocumented omissions use
     * defaults (promotionThreshold=3, retirementWindows=5, relaxFloor=1).
     */
    fireCountConfig?: FireCountConfig;
}
/**
 * Gather the retro input bundle. See module JSDoc for full behaviour.
 *
 * @throws {MalformedExecutionManifestError} When a `done/` manifest fails
 *   schema validation. A corrupt done/ manifest is a hard stop — unlike
 *   telemetry lines, it is not skippable.
 */
export declare function gatherRetroInputs(opts: GatherRetroInputsOptions): Promise<RetroInputs>;
