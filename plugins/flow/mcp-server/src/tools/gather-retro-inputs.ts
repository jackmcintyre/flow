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
import {
  extractLessonsFromBody,
  selectRetirableLessons,
  type ParsedLesson,
  type RetirableLessonCandidate,
} from "../lib/lesson-archive.js";
import { parsePersonaFile } from "../lib/persona-file.js";

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
 * Per-role retirable lesson signal surfaced in the retro input bundle so the
 * retro-analyst can draft a `lesson-retirement` proposal without re-scanning
 * persona files in prose.
 *
 * Story native:01KV7FGDTQ8FSJ2EEPHHGK0KRQ.
 */
interface RetirableLessonsEntry {
  /** The kebab role id whose Knowledge section carries the dead lessons. */
  role: string;
  /** Lessons that have never been recalled and are old enough to be retired. */
  candidates: RetirableLessonCandidate[];
}

/**
 * A lesson that appears (by content similarity) in two or more roles' Knowledge
 * sections. Surfaced in the retro input bundle so the retro-analyst can draft a
 * `shared-skill-promotion` proposal recommending the lesson be extracted into one
 * shared skill that every sharing role can reference.
 *
 * Story native:01KV7FJHK9CAAS860MJAG70QVS.
 */
interface CrossRoleSharedLesson {
  /**
   * Verbatim lesson text from the first role that holds it.
   * The analyst uses this as the basis for the shared skill description.
   */
  lesson_text: string;
  /**
   * Lesson id from the representative role (the first alphabetically).
   * Provides provenance for the proposal.
   */
  lesson_id: string;
  /** The roles (kebab ids) that share this lesson, sorted alphabetically. */
  roles: string[];
  /**
   * Jaccard similarity score (0–1) between the lesson token sets of the first
   * and second role instances. Higher = more confident the lessons are the same point.
   */
  similarity: number;
}

/**
 * A pair of near-duplicate lessons detected in a single role's Knowledge section.
 * Surfaced in the retro input bundle so the retro-analyst can propose consolidating
 * them into a single sharper lesson.
 *
 * Story native:01KV7FFZ5PJKCW6Z6RVJ71XY6T.
 */
interface NearDuplicateLessonPair {
  /** The kebab role id whose Knowledge section holds both lessons. */
  role: string;
  /** The first duplicate lesson. */
  lesson_a: ParsedLesson;
  /** The second duplicate lesson. */
  lesson_b: ParsedLesson;
  /**
   * Jaccard similarity score (0–1) between the combined text fields of both
   * lessons. Higher = more similar. Used for ordering when multiple pairs exist.
   */
  similarity: number;
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
  /**
   * Near-duplicate lesson pairs detected in hired roles' Knowledge sections.
   *
   * Each entry names the role and the two lessons that express the same point,
   * ordered by Jaccard similarity score descending (highest confidence first).
   * The retro-analyst MUST consume this pre-computed signal to draft
   * `lesson-consolidation` proposals — it MUST NOT re-scan persona files in
   * prose, mirroring the `fireCountSignal` and `recurringFriction` disciplines.
   *
   * Empty when: (a) no roles are hired, (b) all roles have zero or one lesson,
   * or (c) no pair in any role exceeds the similarity threshold.
   *
   * Story native:01KV7FFZ5PJKCW6Z6RVJ71XY6T.
   */
  nearDuplicateLessonPairs: NearDuplicateLessonPair[];
  /**
   * Per-role retirable lesson signal — lessons that have never been recalled
   * and have never been tied to a good outcome (proxy: use_count=0 +
   * last_used_at absent) over an age floor (default: 14 days / ~3 cycles).
   *
   * The retro-analyst MUST draft `lesson-retirement` proposals from this
   * pre-computed signal — it MUST NOT re-scan persona files or re-derive
   * usefulness in prose, mirroring the `fireCountSignal` and
   * `nearDuplicateLessonPairs` disciplines.
   *
   * Empty when: (a) no roles are hired, or (b) all lessons in all roles have
   * been recalled at least once (or are too new).
   *
   * Story native:01KV7FGDTQ8FSJ2EEPHHGK0KRQ.
   */
  retirableLessons: RetirableLessonsEntry[];
  /**
   * Cross-role shared lesson signal — lessons that appear (by content
   * similarity) in two or more roles' Knowledge sections.
   *
   * Each entry names the shared lesson text, the representative lesson id,
   * all sharing roles, and the pairwise Jaccard similarity score. The
   * retro-analyst MUST draft `shared-skill-promotion` proposals from this
   * pre-computed signal — it MUST NOT re-scan persona files or re-derive
   * similarity in prose, mirroring the `nearDuplicateLessonPairs` and
   * `retirableLessons` disciplines.
   *
   * Empty when: (a) no roles are hired, (b) fewer than two roles have
   * lessons, or (c) no lesson pair across different roles exceeds the
   * similarity threshold.
   *
   * Story native:01KV7FJHK9CAAS860MJAG70QVS.
   */
  crossRoleSharedLessons: CrossRoleSharedLesson[];
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
  /**
   * Optional age floor override for the retirable lesson selector (in ms).
   * Defaults to `DEFAULT_AGE_FLOOR_MS` (14 days). Test seam.
   * (Story native:01KV7FGDTQ8FSJ2EEPHHGK0KRQ)
   */
  retirableAgeFloorMs?: number;
  /**
   * Optional injectable clock for the retirable lesson selector.
   * Defaults to `() => new Date()`. Test seam.
   * (Story native:01KV7FGDTQ8FSJ2EEPHHGK0KRQ)
   */
  retirableNow?: () => Date;
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

  // Detect near-duplicate lesson pairs across all hired roles
  // (Story native:01KV7FFZ5PJKCW6Z6RVJ71XY6T). This is a pure read — no writes.
  const nearDuplicateLessonPairs = await gatherNearDuplicateLessonPairs(targetRepoRoot);

  // Compute per-role retirable lesson signal
  // (Story native:01KV7FGDTQ8FSJ2EEPHHGK0KRQ). This is a pure read — no writes.
  const retirableLessons = await gatherRetirableLessons(targetRepoRoot, {
    ageFloorMs: opts.retirableAgeFloorMs,
    now: opts.retirableNow,
  });

  // Detect cross-role shared lessons
  // (Story native:01KV7FJHK9CAAS860MJAG70QVS). This is a pure read — no writes.
  const crossRoleSharedLessons = await gatherCrossRoleSharedLessons(targetRepoRoot);

  return { doneManifests, telemetrySummary, priorProposals, ruleRegistry, fireCountSignal, recurringFriction, skillEffectiveness, mechanicalFailuresDrafted, nearDuplicateLessonPairs, retirableLessons, crossRoleSharedLessons };
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
    // Supply a real risk_reasoning so the write gate does not refuse with
    // placeholder-risk. The highest risk for a hardening story is that the
    // guard is too narrow and misses the real trigger — caught by the
    // integration AC asserting the failure is detectable at build or test time.
    risk_reasoning: `Highest risk: the guard is too narrow and misses the real "${failure_class}" trigger — caught by the integration AC asserting the failure is detectable at build or test time.`,
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
// near-duplicate lesson detection (Story native:01KV7FFZ5PJKCW6Z6RVJ71XY6T)
// ---------------------------------------------------------------------------

/**
 * Jaccard similarity between two token sets derived from the combined
 * `applies_when` + `detail` text of a lesson.
 *
 * Tokenises by splitting on whitespace/punctuation and lowercasing.
 * Returns a score in [0, 1] where 1 = identical token sets.
 */
export function lessonSimilarity(a: ParsedLesson, b: ParsedLesson): number {
  const tokensA = tokenise(`${a.applies_when} ${a.detail}`);
  const tokensB = tokenise(`${b.applies_when} ${b.detail}`);

  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersectionSize = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersectionSize++;
  }

  const unionSize = tokensA.size + tokensB.size - intersectionSize;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

/**
 * Tokenise a string into a lowercase word token set, stripping punctuation.
 * Very short tokens (< 3 chars) and stop-words are excluded to prevent
 * common words from inflating similarity scores.
 */
function tokenise(text: string): Set<string> {
  const STOP_WORDS = new Set([
    "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "is", "it", "its", "as", "be", "was",
    "are", "not", "do", "if", "so", "no", "we", "you",
  ]);
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().split(/[\s\p{P}]+/u)) {
    const tok = raw.trim();
    if (tok.length >= 3 && !STOP_WORDS.has(tok)) {
      tokens.add(tok);
    }
  }
  return tokens;
}

/**
 * Threshold above which two lessons are considered near-duplicates.
 * Chosen to catch substantively overlapping lessons (40%+ token overlap)
 * while avoiding false-positives from lessons that merely share domain
 * vocabulary (< 35% overlap).
 */
const NEAR_DUPLICATE_THRESHOLD = 0.35;

/**
 * Detect near-duplicate lesson pairs across all hired roles.
 *
 * For each hired role (any directory under `<targetRepoRoot>/team/` that
 * contains a valid `PERSONA.md`), extracts the structured lesson blocks from
 * the Knowledge section and flags any pair whose Jaccard similarity exceeds
 * `NEAR_DUPLICATE_THRESHOLD`. Returns only the highest-similarity pair per
 * role (at most one consolidation proposal per role per retro — operators
 * should approve one at a time rather than be flooded with proposals).
 *
 * Returns an empty array on ENOENT (no `team/` directory — no roles hired).
 * Roles with a malformed persona or fewer than two lessons are skipped silently.
 */
async function gatherNearDuplicateLessonPairs(
  targetRepoRoot: string,
): Promise<NearDuplicateLessonPair[]> {
  const teamDir = path.join(targetRepoRoot, "team");

  let roleEntries: string[];
  try {
    roleEntries = await fs.readdir(teamDir);
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }

  const SKIP_DIRS = new Set(["custom", "_archived"]);
  const pairs: NearDuplicateLessonPair[] = [];

  for (const entry of roleEntries) {
    if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(path.join(teamDir, entry));
    } catch { continue; }
    if (!stat.isDirectory()) continue;

    const personaPath = path.join(teamDir, entry, "PERSONA.md");
    let raw: string;
    try {
      raw = await fs.readFile(personaPath, "utf8");
    } catch (err) {
      if (isEnoent(err)) continue;
      throw err;
    }

    let parsed: ReturnType<typeof parsePersonaFile>;
    try {
      parsed = parsePersonaFile(raw, personaPath);
    } catch {
      // Malformed persona — skip this role gracefully.
      continue;
    }

    const lessons = extractLessonsFromBody(parsed.sections.Knowledge);
    if (lessons.length < 2) continue;

    // Find the highest-similarity pair in this role.
    let bestPair: NearDuplicateLessonPair | null = null;
    for (let i = 0; i < lessons.length; i++) {
      for (let j = i + 1; j < lessons.length; j++) {
        const sim = lessonSimilarity(lessons[i]!, lessons[j]!);
        if (sim >= NEAR_DUPLICATE_THRESHOLD) {
          if (bestPair === null || sim > bestPair.similarity) {
            bestPair = {
              role: entry,
              lesson_a: lessons[i]!,
              lesson_b: lessons[j]!,
              similarity: sim,
            };
          }
        }
      }
    }

    if (bestPair !== null) {
      pairs.push(bestPair);
    }
  }

  // Sort descending by similarity so the most confident proposals come first.
  pairs.sort((a, b) => b.similarity - a.similarity);
  return pairs;
}

// ---------------------------------------------------------------------------
// retirable lesson detection (Story native:01KV7FGDTQ8FSJ2EEPHHGK0KRQ)
// ---------------------------------------------------------------------------

/**
 * Compute the per-role retirable lesson signal.
 *
 * For each hired role (any directory under `<targetRepoRoot>/team/` that
 * contains a valid `PERSONA.md`), extracts the structured lesson blocks from
 * the Knowledge section and applies `selectRetirableLessons` with the given
 * age floor to find lessons that have never been recalled.
 *
 * Returns only roles with at least one retirable lesson (so the analyst
 * never sees an empty entry). Returns an empty array on ENOENT (no `team/`
 * directory — no roles hired). Roles with a malformed persona are skipped
 * silently.
 */
async function gatherRetirableLessons(
  targetRepoRoot: string,
  opts: { ageFloorMs?: number; now?: () => Date } = {},
): Promise<RetirableLessonsEntry[]> {
  const teamDir = path.join(targetRepoRoot, "team");

  let roleEntries: string[];
  try {
    roleEntries = await fs.readdir(teamDir);
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }

  const SKIP_DIRS = new Set(["custom", "_archived"]);
  const entries: RetirableLessonsEntry[] = [];

  for (const entry of roleEntries) {
    if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(path.join(teamDir, entry));
    } catch { continue; }
    if (!stat.isDirectory()) continue;

    const personaPath = path.join(teamDir, entry, "PERSONA.md");
    let raw: string;
    try {
      raw = await fs.readFile(personaPath, "utf8");
    } catch (err) {
      if (isEnoent(err)) continue;
      throw err;
    }

    let parsed: ReturnType<typeof parsePersonaFile>;
    try {
      parsed = parsePersonaFile(raw, personaPath);
    } catch {
      // Malformed persona — skip this role gracefully.
      continue;
    }

    const lessons = extractLessonsFromBody(parsed.sections.Knowledge);
    if (lessons.length === 0) continue;

    const candidates = selectRetirableLessons(lessons, opts);
    if (candidates.length === 0) continue;

    entries.push({ role: entry, candidates });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// cross-role shared lesson detection (Story native:01KV7FJHK9CAAS860MJAG70QVS)
// ---------------------------------------------------------------------------

/**
 * Similarity threshold above which two lessons (from DIFFERENT roles) are
 * considered to be expressing the same shared point. Mirrors the near-duplicate
 * threshold so the operator sees a consistent signal quality bar.
 */
const CROSS_ROLE_SIMILARITY_THRESHOLD = 0.35;

/**
 * Detect lessons that appear (by content similarity) in two or more roles'
 * Knowledge sections. Each detected shared lesson becomes a
 * `CrossRoleSharedLesson` entry naming all roles that hold it, so the
 * retro-analyst can draft a `shared-skill-promotion` proposal.
 *
 * Algorithm:
 *   1. For each hired role read the parsed lessons from its Knowledge section.
 *   2. Compare every lesson in role A against every lesson in role B (for all
 *      pairs of distinct roles).
 *   3. When the Jaccard similarity exceeds `CROSS_ROLE_SIMILARITY_THRESHOLD`,
 *      record a match and accumulate the matching roles.
 *   4. Deduplicate: a cluster of roles that all share the same core lesson is
 *      emitted as a single `CrossRoleSharedLesson` entry (the lesson text and
 *      id are taken from the alphabetically first role).
 *   5. Sort by similarity descending (highest-confidence pairs first).
 *
 * Returns an empty array on ENOENT (no `team/` directory — no roles hired).
 * Roles with a malformed persona or zero lessons are skipped silently.
 */
async function gatherCrossRoleSharedLessons(
  targetRepoRoot: string,
): Promise<CrossRoleSharedLesson[]> {
  const teamDir = path.join(targetRepoRoot, "team");

  let roleEntries: string[];
  try {
    roleEntries = await fs.readdir(teamDir);
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }

  const SKIP_DIRS = new Set(["custom", "_archived"]);

  // Collect the lesson set for every valid role.
  const roleWithLessons: Array<{ role: string; lessons: ParsedLesson[] }> = [];

  for (const entry of roleEntries) {
    if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(path.join(teamDir, entry));
    } catch { continue; }
    if (!stat.isDirectory()) continue;

    const personaPath = path.join(teamDir, entry, "PERSONA.md");
    let raw: string;
    try {
      raw = await fs.readFile(personaPath, "utf8");
    } catch (err) {
      if (isEnoent(err)) continue;
      throw err;
    }

    let parsed: ReturnType<typeof parsePersonaFile>;
    try {
      parsed = parsePersonaFile(raw, personaPath);
    } catch {
      // Malformed persona — skip this role gracefully.
      continue;
    }

    const lessons = extractLessonsFromBody(parsed.sections.Knowledge);
    if (lessons.length === 0) continue;

    roleWithLessons.push({ role: entry, lessons });
  }

  // Need at least two roles with lessons to find cross-role matches.
  if (roleWithLessons.length < 2) return [];

  // Sort roles alphabetically so the representative role (for lesson_id /
  // lesson_text) is deterministic across runs.
  roleWithLessons.sort((a, b) => a.role.localeCompare(b.role));

  // Compare every lesson in role A against every lesson in role B.
  // We aggregate: for each "representative" lesson (identified by similarity
  // clusters), collect all roles that have a matching lesson.
  //
  // To avoid O(n^4) explosion on large teams, we use a greedy pairwise
  // approach: accumulate a map from a canonical lesson fingerprint to its
  // cluster. Two lessons in different roles are added to the same cluster
  // when their similarity to the cluster's representative exceeds the threshold.

  // Each cluster: { representativeLesson, representativeRole, roles, maxSimilarity }
  interface Cluster {
    representativeLesson: ParsedLesson;
    representativeRole: string;
    roles: Set<string>;
    maxSimilarity: number;
  }

  const clusters: Cluster[] = [];

  // Helper: find the cluster whose representative lesson is most similar to
  // `candidate` (above threshold). Returns the cluster or null.
  function findMatchingCluster(candidate: ParsedLesson, _candidateRole: string): Cluster | null {
    let best: Cluster | null = null;
    let bestSim = CROSS_ROLE_SIMILARITY_THRESHOLD - 0.001; // exclusive lower bound
    for (const cluster of clusters) {
      const sim = lessonSimilarity(cluster.representativeLesson, candidate);
      if (sim > bestSim) {
        bestSim = sim;
        best = cluster;
      }
    }
    return best;
  }

  for (const { role, lessons } of roleWithLessons) {
    for (const lesson of lessons) {
      const matchingCluster = findMatchingCluster(lesson, role);
      if (matchingCluster) {
        // Only add a cross-role match — don't double-count the same role.
        if (!matchingCluster.roles.has(role)) {
          matchingCluster.roles.add(role);
          const sim = lessonSimilarity(matchingCluster.representativeLesson, lesson);
          if (sim > matchingCluster.maxSimilarity) {
            matchingCluster.maxSimilarity = sim;
          }
        }
      } else {
        // Start a new cluster with this lesson as the representative.
        clusters.push({
          representativeLesson: lesson,
          representativeRole: role,
          roles: new Set([role]),
          maxSimilarity: 1.0, // a lesson is 100% similar to itself
        });
      }
    }
  }

  // Keep only clusters that span 2+ roles (shared lessons).
  const shared: CrossRoleSharedLesson[] = [];
  for (const cluster of clusters) {
    if (cluster.roles.size < 2) continue;

    const sortedRoles = [...cluster.roles].sort();
    shared.push({
      lesson_text: `${cluster.representativeLesson.applies_when}: ${cluster.representativeLesson.detail}`.trim(),
      lesson_id: cluster.representativeLesson.id,
      roles: sortedRoles,
      similarity: cluster.maxSimilarity,
    });
  }

  // Sort descending by similarity (highest-confidence first).
  shared.sort((a, b) => b.similarity - a.similarity);
  return shared;
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
