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

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { parse as yamlParse } from "yaml";
import { readCycleState, type CycleState } from "../schemas/cycle-state.js";
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
} from "../lib/failure-class-fire-counts.js";
import { type FrictionKind } from "./record-agent-friction.js";
import {
  computeSkillEffectiveness,
  type SkillEffectivenessResult,
} from "./compute-skill-effectiveness.js";
import {
  renderGateWriteNativeStory,
  type WriteNativeStoryInput,
} from "./write-native-story.js";
import { readBacklogInventory } from "./read-backlog-inventory.js";
import { resolveWorkspace } from "../state/workspace-resolver.js";

/** Month-bucket filename pattern matching the Story 1.5 logger contract. */
const TELEMETRY_FILE_REGEX = /\.jsonl$/;

/**
 * One entry in the `recurringFriction` array — a friction kind that recurred
 * at or above the threshold (count >= 2) within the cycle.
 */
interface RecurringFrictionEntry {
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
interface MechanicalFailureDraft {
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
const MECHANICAL_FAILURE_THRESHOLD = 2;

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
export async function gatherRetroInputs(
  opts: GatherRetroInputsOptions,
): Promise<RetroInputs> {
  const { targetRepoRoot, fireCountConfig } = opts;

  // Resolve the cycle window. An explicit `cycleState` (the test seam) wins;
  // otherwise read the on-disk cycle-state file. `null` ⇒ no boundary ⇒
  // full-history baseline (Story native:01KT484NY4HCBPBTT6VEY1Q0CS / AC4). The
  // boundary instant is the cycle's `opened_at`, parsed once into epoch millis.
  const cycleState =
    opts.cycleState !== undefined
      ? opts.cycleState
      : await readCycleState(targetRepoRoot);
  const windowStartMs = cycleState ? Date.parse(cycleState.opened_at) : null;

  const doneManifests = await gatherDoneManifests(targetRepoRoot, windowStartMs);
  const telemetrySummary = await gatherTelemetry(targetRepoRoot, windowStartMs);
  const priorProposals = await gatherPriorProposals(targetRepoRoot);
  const ruleRegistry = await gatherRuleRegistry(targetRepoRoot);

  // Compute fire-count signal for the analyst. Only available when the registry
  // exists; null in the 6a phase.
  let fireCountSignal: RetroInputs["fireCountSignal"] = null;
  if (ruleRegistry !== null) {
    const registryTyped = ruleRegistry as { rules: DisciplineRule[] };
    const result = computeFailureClassFireCounts(
      { doneManifests, telemetrySummary, ruleRegistry: registryTyped },
      fireCountConfig,
    );
    fireCountSignal = {
      promotionCandidates: result.promotionCandidates,
      retirementCandidates: result.retirementCandidates,
    };
  }

  // Compute recurring friction signal from telemetry events.
  // Only friction that recurs at threshold (count >= 2) is surfaced.
  const recurringFriction = computeRecurringFriction(telemetrySummary.events);

  // Compute per-skill effectiveness signal (Story 6.8). The helper reads the
  // cycle's skill.invoke + reviewer.verdict telemetry and joins each invocation
  // to a downstream READY FOR MERGE verdict. It always returns a safe shape
  // (an empty per_skill map when no telemetry exists), so no null-guard is
  // needed and the retro never fails on an absent signal.
  const skillEffectiveness = await computeSkillEffectiveness({ targetRepoRoot });

  // Draft hardening stories for recurring mechanical failures
  // (Story native:01KT6RHTE3YME1ZAD5VRQAKDSW). This is a write side-effect of
  // the retro loop; the drafting only fires on native-adapter repos (where
  // writeNativeStory applies). On non-native repos it short-circuits to [].
  const threshold = opts.mechanicalFailureThreshold ?? MECHANICAL_FAILURE_THRESHOLD;
  const mechanicalFailuresDrafted = await draftHardeningStories(
    targetRepoRoot,
    doneManifests,
    threshold,
    opts.sessionUlid,
  );

  return { doneManifests, telemetrySummary, priorProposals, ruleRegistry, fireCountSignal, recurringFriction, skillEffectiveness, mechanicalFailuresDrafted };
}

// ---------------------------------------------------------------------------
// done/ manifests
// ---------------------------------------------------------------------------

/**
 * Read every `.yaml` under `.flow/state/done/` (excluding `.snapshot.yaml`
 * sidecars), in alphabetical filename order, parsed via
 * `parseExecutionManifest`. Errors propagate.
 *
 * When `windowStartMs` is non-null (a cycle is open), a manifest is included
 * only when its completion time is at or after the window start. A done/
 * manifest carries no completion timestamp field, so its completion time is the
 * file's mtime — `completeStory` writes the manifest into `done/` at completion,
 * so the mtime is the completion instant. Manifests completed before the cycle
 * opened are excluded (Story native:01KT484NY4HCBPBTT6VEY1Q0CS / AC2). When
 * `windowStartMs` is `null` (no cycle), every manifest is included (baseline).
 */
async function gatherDoneManifests(
  targetRepoRoot: string,
  windowStartMs: number | null,
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

    // Cycle scoping: skip manifests completed before the window opened. The
    // completion instant is the file mtime (see fn JSDoc). The stat precedes
    // the read so an out-of-window manifest is not even parsed.
    if (windowStartMs !== null) {
      const stat = await fs.stat(absPath);
      if (stat.mtimeMs < windowStartMs) {
        continue;
      }
    }

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
 *
 * When `windowStartMs` is non-null (a cycle is open), only events whose `ts` is
 * at or after the window start are returned; events from before the cycle
 * opened are excluded (NOT counted as skipped — they are valid, just
 * out-of-window). When `windowStartMs` is `null` (no cycle), every valid event
 * is returned (the existing baseline). Story
 * native:01KT484NY4HCBPBTT6VEY1Q0CS / AC2 + AC4.
 */
async function gatherTelemetry(
  targetRepoRoot: string,
  windowStartMs: number | null,
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

      // Cycle scoping: drop events timestamped before the window opened. These
      // are valid events outside the current cycle, NOT corrupt lines, so they
      // do not increment skipped_count.
      if (windowStartMs !== null && Date.parse(result.data.ts) < windowStartMs) {
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
// hardening story drafting (Story native:01KT6RHTE3YME1ZAD5VRQAKDSW)
// ---------------------------------------------------------------------------

/**
 * Draft hardening stories for recurring mechanical failures.
 *
 * Groups `pitfall` lessons from done manifests by `failure_class`. For each
 * class that meets or exceeds `threshold` (default 2), checks whether a
 * not-ready or in-progress hardening story for that class already exists in the
 * backlog (deduplication). Qualifying classes get a new native story authored
 * via `renderGateWriteNativeStory` and parked as not-ready.
 *
 * Only runs on native-adapter repos. On non-native repos returns [].
 *
 * @param targetRepoRoot  Absolute path to the repo root.
 * @param doneManifests   The cycle's done manifests (already gathered).
 * @param threshold       Recurrence count to trigger a draft (default 2).
 * @param sessionUlid     Optional session ULID for telemetry on drafted stories.
 */
async function draftHardeningStories(
  targetRepoRoot: string,
  doneManifests: ExecutionManifest[],
  threshold: number,
  sessionUlid?: string,
): Promise<MechanicalFailureDraft[]> {
  // Only native-adapter repos support writeNativeStory.
  let workspace;
  try {
    workspace = await resolveWorkspace({ targetRepoRoot });
  } catch {
    // Cannot resolve workspace (e.g. missing config.yaml) — skip gracefully.
    return [];
  }
  if (workspace.activeAdapterName !== "native") {
    return [];
  }

  // --- Step 1: collect pitfall lessons with failure_class from done manifests ---
  const classCounts = new Map<string, number>();
  for (const manifest of doneManifests) {
    for (const lesson of manifest.lessons ?? []) {
      if (lesson.kind === "pitfall" && lesson.failure_class) {
        classCounts.set(
          lesson.failure_class,
          (classCounts.get(lesson.failure_class) ?? 0) + 1,
        );
      }
    }
  }

  // --- Step 2: find classes that exceed the threshold ---
  const qualifying: Array<{ failure_class: string; count: number }> = [];
  for (const [fc, count] of classCounts) {
    if (count >= threshold) {
      qualifying.push({ failure_class: fc, count });
    }
  }
  qualifying.sort((a, b) => a.failure_class.localeCompare(b.failure_class));

  if (qualifying.length === 0) {
    return [];
  }

  // --- Step 3: deduplication — skip if a pending hardening story already exists ---
  let existingHardeningClasses: Set<string>;
  try {
    const inventory = await readBacklogInventory({
      targetRepoRoot,
    });
    existingHardeningClasses = buildExistingHardeningSet(inventory.backlog_inventory);
  } catch {
    // If inventory read fails, proceed without dedup (safe: may draft duplicates
    // but will not crash the retro).
    existingHardeningClasses = new Set();
  }

  // --- Step 4: draft hardening stories for qualifying, non-duplicate classes ---
  const drafted: MechanicalFailureDraft[] = [];
  for (const { failure_class, count } of qualifying) {
    if (existingHardeningClasses.has(failure_class)) {
      // Already has a pending hardening story — skip.
      continue;
    }

    const input: WriteNativeStoryInput = buildHardeningStoryInput(
      failure_class,
      count,
      targetRepoRoot,
      sessionUlid,
    );

    let result;
    try {
      result = await renderGateWriteNativeStory(input, targetRepoRoot, "author");
    } catch {
      // A discipline-gate rejection or other write failure should not crash the
      // retro. Skip this failure class and continue.
      continue;
    }

    drafted.push({
      failure_class,
      recurrence_count: count,
      hardening_story_ref: result.ref,
      hardening_story_path: result.path,
    });
  }

  return drafted;
}

/**
 * Build the set of failure_class values that already have a pending (not-ready
 * or in-progress) hardening story in the backlog. The deduplication marker is
 * embedded in the story title: `"[Hardening] Guard against <failure_class>"`.
 */
function buildExistingHardeningSet(
  inventory: Array<{ ref: string; title: string; state: string; withdrawn: boolean }>,
): Set<string> {
  const existing = new Set<string>();
  const HARDENING_PREFIX = "[Hardening] Guard against ";

  for (const item of inventory) {
    // Skip done or withdrawn items — they are not "pending".
    if (item.state === "done" || item.withdrawn) {
      continue;
    }
    // The title encodes the failure_class as: "[Hardening] Guard against <fc>"
    if (item.title.startsWith(HARDENING_PREFIX)) {
      const fc = item.title.slice(HARDENING_PREFIX.length).trim();
      if (fc.length > 0) {
        existing.add(fc);
      }
    }
  }

  return existing;
}

/**
 * Build the `WriteNativeStoryInput` for a hardening story that proposes a code
 * guard against a specific failure class.
 *
 * `targetRepoRoot` is passed so the Zod schema validation (`.min(1)`) passes.
 * `renderGateWriteNativeStory` receives `targetRepoRoot` separately as its own
 * second argument and uses that for all path operations — `input.targetRepoRoot`
 * is only consumed by the schema validator.
 */
function buildHardeningStoryInput(
  failure_class: string,
  recurrence_count: number,
  targetRepoRoot: string,
  sessionUlid?: string,
): WriteNativeStoryInput {
  const title = `[Hardening] Guard against ${failure_class}`;
  const sanitizedFc = failure_class.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  return {
    targetRepoRoot,
    title,
    narrative: {
      role: "non-engineer operator",
      want: `a code-level guard that prevents the recurring "${failure_class}" failure`,
      so_that: `the team stops repeating this mechanical mistake (recurred ${recurrence_count} times this cycle)`,
    },
    acceptance_criteria: [
      {
        text: `**Given** the retro has identified "${failure_class}" as a recurring failure class (${recurrence_count} occurrences), **When** a dev implements this hardening, **Then** a code guard exists that makes the "${failure_class}" failure detectable at build or test time.`,
        kind: "integration",
        verification: {
          type: "vitest",
          target: `plugins/flow/mcp-server/src/__tests__/hardening-${sanitizedFc}.test.ts`,
        },
      },
    ],
    tasks: [
      {
        text: `Identify the code seam responsible for the "${failure_class}" failure class and add a deterministic guard (test, schema check, or runtime assertion) that catches it before it escapes to the dev loop.`,
        ac_refs: ["AC1"],
      },
    ],
    cited_sources: [
      "plugins/flow/mcp-server/src/tools/gather-retro-inputs.ts",
    ],
    depends_on: [],
    sessionUlid: sessionUlid ?? "retro-loop",
  };
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
