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
 *     sidecars (Story 5.29) are excluded.
 *
 *   - `telemetrySummary`: every event from `<targetRepoRoot>/.flow/telemetry/*.jsonl`
 *     in the **current cycle window** (v1: every `.jsonl` file present at
 *     gather time — cycle boundaries land in Story 6.12), parsed line-by-line
 *     through `TelemetryEventSchema`. Malformed lines (bad JSON or failed Zod)
 *     are skipped, COUNTED, and the count is returned as `skipped_count` so
 *     the analyst can flag corrupt logs without the run crashing. Files are
 *     read in alphabetical order; events preserve in-file line order.
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

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parse as yamlParse } from "yaml";
import {
  parseExecutionManifest,
  type ExecutionManifest,
} from "../schemas/execution-manifest.js";
import {
  TelemetryEventSchema,
  type TelemetryEvent,
  type AgentFrictionEvent,
} from "../schemas/telemetry-events.js";
import { parseRuleRegistry, type DisciplineRule } from "../schemas/discipline-rules.js";
import {
  computeFailureClassFireCounts,
  type PromotionCandidate,
  type RetirementCandidate,
  type FireCountConfig,
  type WindowingSeam,
  SINGLE_WINDOW_SEAM,
} from "../lib/failure-class-fire-counts.js";
import { readCycleState } from "../lib/cycle-state.js";
import { type FrictionKind } from "./record-agent-friction.js";

/** Month-bucket filename pattern matching the Story 1.5 logger contract. */
const TELEMETRY_FILE_REGEX = /\.jsonl$/;

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
  priorProposals: Array<{ path: string; iso_timestamp: string }>;
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
   * Optional cycle opened_at timestamp override — test seam.
   * When provided, acts as the lower bound for filtering done manifests
   * (by `completed_at`) and telemetry events (by `ts`).
   * When absent, the cycle state is read from `.flow/cycle-state.json`.
   * Pass `null` explicitly to force the no-cycle baseline (full history).
   */
  cycleOpenedAt?: string | null;
}

/**
 * Gather the retro input bundle. See module JSDoc for full behaviour.
 *
 * When a cycle is active (`.flow/cycle-state.json` present), only done
 * manifests whose `completed_at >= cycle.opened_at` and telemetry events
 * whose `ts >= cycle.opened_at` are included — giving the analyst a clean,
 * bounded window for the current cycle.
 *
 * When no cycle has ever been opened (absent file), all available history is
 * returned (the baseline behaviour preserved by AC4).
 *
 * @throws {MalformedExecutionManifestError} When a `done/` manifest fails
 *   schema validation. A corrupt done/ manifest is a hard stop — unlike
 *   telemetry lines, it is not skippable.
 */
export async function gatherRetroInputs(
  opts: GatherRetroInputsOptions,
): Promise<RetroInputs> {
  const { targetRepoRoot, fireCountConfig } = opts;

  // Resolve the cycle boundary.
  // `cycleOpenedAt` in opts overrides the file read (test seam).
  // `null` = no cycle (full history).
  let cycleOpenedAt: string | null;
  if (opts.cycleOpenedAt !== undefined) {
    // Caller explicitly provided an override (including null = no cycle).
    cycleOpenedAt = opts.cycleOpenedAt;
  } else {
    // Read from disk.
    const cycleState = await readCycleState(targetRepoRoot);
    cycleOpenedAt = cycleState !== null ? cycleState.opened_at : null;
  }

  const allDoneManifests = await gatherDoneManifests(targetRepoRoot);
  const allTelemetry = await gatherTelemetry(targetRepoRoot);
  const priorProposals = await gatherPriorProposals(targetRepoRoot);
  const ruleRegistry = await gatherRuleRegistry(targetRepoRoot);

  // Apply cycle-boundary filtering when a cycle is active.
  const doneManifests = filterManifestsByCycle(allDoneManifests, cycleOpenedAt);
  const telemetrySummary = filterTelemetryByCycle(allTelemetry, cycleOpenedAt);

  // Build the windowing seam for the fire-count helper — mirrors the same
  // boundary used above so the promotion/retirement signals are consistent.
  const windowing: WindowingSeam = cycleOpenedAt !== null
    ? buildCycleWindowingSeam(cycleOpenedAt)
    : SINGLE_WINDOW_SEAM;

  // Compute fire-count signal for the analyst. Only available when the registry
  // exists; null in the 6a phase.
  let fireCountSignal: RetroInputs["fireCountSignal"] = null;
  if (ruleRegistry !== null) {
    const registryTyped = ruleRegistry as { rules: DisciplineRule[] };
    const result = computeFailureClassFireCounts(
      { doneManifests, telemetrySummary, ruleRegistry: registryTyped },
      fireCountConfig,
      windowing,
    );
    fireCountSignal = {
      promotionCandidates: result.promotionCandidates,
      retirementCandidates: result.retirementCandidates,
    };
  }

  // Compute recurring friction signal from telemetry events.
  // Only friction that recurs at threshold (count >= 2) is surfaced.
  const recurringFriction = computeRecurringFriction(telemetrySummary.events);

  return { doneManifests, telemetrySummary, priorProposals, ruleRegistry, fireCountSignal, recurringFriction };
}

// ---------------------------------------------------------------------------
// Cycle-boundary filtering
// ---------------------------------------------------------------------------

/**
 * Filter done manifests to those whose `completed_at` is at or after
 * `openedAt`. Manifests with no `completed_at` (written before this feature
 * landed) are EXCLUDED from the cycle window — we cannot know when they were
 * completed.
 *
 * When `openedAt` is null, returns the full list unchanged (baseline).
 */
function filterManifestsByCycle(
  manifests: ExecutionManifest[],
  openedAt: string | null,
): ExecutionManifest[] {
  if (openedAt === null) {
    return manifests;
  }
  return manifests.filter(
    (m) => m.completed_at !== undefined && m.completed_at >= openedAt,
  );
}

/**
 * Filter a telemetry summary to events whose `ts` is at or after `openedAt`.
 * The `skipped_count` is preserved from the original summary (not re-counted).
 *
 * When `openedAt` is null, returns the original summary unchanged (baseline).
 */
function filterTelemetryByCycle(
  summary: { events: TelemetryEvent[]; skipped_count: number },
  openedAt: string | null,
): { events: TelemetryEvent[]; skipped_count: number } {
  if (openedAt === null) {
    return summary;
  }
  return {
    events: summary.events.filter((e) => e.ts >= openedAt),
    skipped_count: summary.skipped_count,
  };
}

/**
 * Build a `WindowingSeam` that filters by the cycle's `opened_at` timestamp.
 * Used by the fire-count helper so promotion/retirement signals are cycle-scoped.
 */
function buildCycleWindowingSeam(openedAt: string): WindowingSeam {
  return {
    filterManifests: (manifests) =>
      manifests.filter(
        (m) => m.completed_at !== undefined && m.completed_at >= openedAt,
      ),
    filterEvents: (events) => events.filter((e) => e.ts >= openedAt),
    isQuietEnoughForRetirement: (fireCount, relaxFloor) => fireCount < relaxFloor,
  };
}

// ---------------------------------------------------------------------------
// done/ manifests
// ---------------------------------------------------------------------------

/**
 * Read every `.yaml` under `.flow/state/done/` (excluding `.snapshot.yaml`
 * sidecars), in alphabetical filename order, parsed via
 * `parseExecutionManifest`. Errors propagate.
 */
async function gatherDoneManifests(
  targetRepoRoot: string,
): Promise<ExecutionManifest[]> {
  const doneDir = path.join(targetRepoRoot, ".flow", "state", "done");

  let entries: string[];
  try {
    entries = await fs.readdir(doneDir);
  } catch (err) {
    if (isEnoent(err)) {
      return [];
    }
    throw err;
  }

  // Filter to manifest .yaml files, exclude snapshot sidecars (Story 5.29),
  // and sort alphabetically for deterministic ordering.
  const manifestFiles = entries
    .filter((f) => f.endsWith(".yaml") && !f.endsWith(".snapshot.yaml"))
    .sort();

  const manifests: ExecutionManifest[] = [];
  for (const file of manifestFiles) {
    const absPath = path.join(doneDir, file);
    const raw = await fs.readFile(absPath, "utf8");
    const parsed = yamlParse(raw) as unknown;
    // parseExecutionManifest throws MalformedExecutionManifestError on
    // invalid shape — propagated, not swallowed.
    manifests.push(parseExecutionManifest(parsed, { absPath }));
  }

  return manifests;
}

// ---------------------------------------------------------------------------
// telemetry
// ---------------------------------------------------------------------------

/**
 * Read every `.jsonl` under `.flow/telemetry/` in alphabetical filename
 * order; parse each non-empty line through `TelemetryEventSchema`.
 * Malformed lines (bad JSON or failed Zod) are skipped and counted.
 */
async function gatherTelemetry(
  targetRepoRoot: string,
): Promise<{ events: TelemetryEvent[]; skipped_count: number }> {
  const telemetryDir = path.join(targetRepoRoot, ".flow", "telemetry");

  let entries: string[];
  try {
    entries = await fs.readdir(telemetryDir);
  } catch (err) {
    if (isEnoent(err)) {
      return { events: [], skipped_count: 0 };
    }
    throw err;
  }

  const files = entries.filter((f) => TELEMETRY_FILE_REGEX.test(f)).sort();

  const events: TelemetryEvent[] = [];
  let skipped_count = 0;

  for (const file of files) {
    const absPath = path.join(telemetryDir, file);
    const raw = await fs.readFile(absPath, "utf8");
    const lines = raw.split("\n");

    for (const line of lines) {
      if (line.trim() === "") {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        skipped_count++;
        continue;
      }

      const result = TelemetryEventSchema.safeParse(parsed);
      if (!result.success) {
        skipped_count++;
        continue;
      }

      events.push(result.data);
    }
  }

  return { events, skipped_count };
}

// ---------------------------------------------------------------------------
// prior proposals
// ---------------------------------------------------------------------------

/**
 * List every `.flow/retro-proposals/*.md` as `{ path, iso_timestamp }`,
 * sorted by ISO timestamp ascending. The timestamp is derived from the
 * filename stem (Story 6.3 keys files by ISO timestamp). Contents are NOT
 * loaded — the analyst reads them via the `Read` tool if needed.
 *
 * `path` is the absolute path so the analyst can `Read` it directly.
 */
async function gatherPriorProposals(
  targetRepoRoot: string,
): Promise<Array<{ path: string; iso_timestamp: string }>> {
  const proposalsDir = path.join(targetRepoRoot, ".flow", "retro-proposals");

  let entries: string[];
  try {
    entries = await fs.readdir(proposalsDir);
  } catch (err) {
    if (isEnoent(err)) {
      return [];
    }
    throw err;
  }

  const proposals = entries
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({
      path: path.join(proposalsDir, f),
      // The writer keys the filename by ISO timestamp (Story 6.3):
      // `<isoTimestamp>.md`. Strip the `.md` suffix to recover it.
      iso_timestamp: f.slice(0, -".md".length),
    }));

  // Sort by ISO timestamp ascending. ISO-8601 strings sort
  // lexicographically in chronological order.
  proposals.sort((a, b) => a.iso_timestamp.localeCompare(b.iso_timestamp));

  return proposals;
}

// ---------------------------------------------------------------------------
// rule registry
// ---------------------------------------------------------------------------

/**
 * Read `<targetRepoRoot>/docs/discipline-rules.yaml` through the validated,
 * comment-preserving parser (`parseRuleRegistry`, Story 6.5), or return `null`
 * when absent. Absence is NOT an error — null-tolerance matches the analyst's
 * `ruleRegistry: null` contract. A present-but-malformed registry now raises a
 * typed `RuleRegistryMalformedError` (a corrupt registry is a hard stop, like a
 * corrupt done/ manifest — not a silently-swallowed line).
 *
 * Returns the schema-validated `{ rules }` view (not the comment-carrying
 * Document) — the analyst reasons over the rules, the apply handler is the only
 * caller that needs the comment-preserving Document.
 */
async function gatherRuleRegistry(
  targetRepoRoot: string,
): Promise<unknown | null> {
  const registryPath = path.join(
    targetRepoRoot,
    "docs",
    "discipline-rules.yaml",
  );

  let raw: string;
  try {
    raw = await fs.readFile(registryPath, "utf8");
  } catch (err) {
    if (isEnoent(err)) {
      return null;
    }
    throw err;
  }

  // Validated parse — raises RuleRegistryMalformedError on a bad registry.
  return parseRuleRegistry(raw, "docs/discipline-rules.yaml").data;
}

// ---------------------------------------------------------------------------
// recurring friction
// ---------------------------------------------------------------------------

/**
 * Compute the recurring-friction signal from the cycle's telemetry events.
 *
 * Groups `agent.friction` events by `kind`, then returns only those kinds
 * whose count reaches the threshold (count >= 2). One-off friction (count < 2)
 * is excluded to avoid flooding the retro with noise.
 *
 * The analyst MUST consume `recurringFriction` only — it MUST NOT recount
 * from raw telemetry, mirroring the `fireCountSignal` discipline.
 */
function computeRecurringFriction(events: TelemetryEvent[]): RecurringFrictionEntry[] {
  const RECURRING_THRESHOLD = 2;

  // Accumulate counts per kind.
  const counts = new Map<FrictionKind, number>();
  for (const event of events) {
    if (event.type === "agent.friction") {
      // Narrow to AgentFrictionEvent for type-safe access to data.kind.
      const frictionEvent = event as AgentFrictionEvent;
      const kind = frictionEvent.data.kind;
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
  }

  // Return only kinds at or above the threshold, sorted by kind for determinism.
  const result: RecurringFrictionEntry[] = [];
  for (const [kind, count] of counts) {
    if (count >= RECURRING_THRESHOLD) {
      result.push({ kind, count });
    }
  }
  result.sort((a, b) => a.kind.localeCompare(b.kind));
  return result;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}
