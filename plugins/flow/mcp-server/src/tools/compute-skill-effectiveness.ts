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

import * as path from "node:path";
import { promises as fs } from "node:fs";
import { z } from "zod";
import { TelemetryEventSchema } from "../schemas/telemetry-events.js";
import type {
  SkillInvokeEvent,
  ReviewerVerdictEvent,
} from "../schemas/telemetry-events.js";
import { SkillEffectivenessWindowInvalidError } from "../errors.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default window — the most-recent `skill.invoke` events considered. Chosen to
 * mirror `computeAgreement`'s default rolling window; the consumer (the retro
 * analyst's retirement criterion) overrides it per its observation window.
 */
export const DEFAULT_SKILL_EFFECTIVENESS_WINDOW = 50;

/** The verdict value that counts an invocation as a "useful fire". */
const USEFUL_VERDICT = "READY FOR MERGE" as const;

// ---------------------------------------------------------------------------
// Output schema & type
// ---------------------------------------------------------------------------

/**
 * Per-skill effectiveness stats. `.strict()` so unknown-key injection is
 * rejected (mirrors `AgreementMetricResultSchema`'s posture).
 */
export const PerSkillEffectivenessSchema = z
  .object({
    invoke_count: z.number().int().nonnegative(),
    useful_fire_count: z.number().int().nonnegative(),
    effectiveness_ratio: z.number().min(0).max(1),
  })
  .strict();

export type PerSkillEffectiveness = z.infer<typeof PerSkillEffectivenessSchema>;

/**
 * Zod schema for the `computeSkillEffectiveness` return value. Mirrors
 * `AgreementMetricResultSchema`: a deterministic, `.strict()` result with the
 * per-skill map plus the window/sample/malformed bookkeeping. The empty case
 * is an empty `per_skill` map (NOT `null`) — callers always get a shape.
 */
export const SkillEffectivenessResultSchema = z
  .object({
    per_skill: z.record(z.string(), PerSkillEffectivenessSchema),
    window_size: z.number().int().positive(),
    sample_size: z.number().int().nonnegative(),
    malformed_lines: z.number().int().nonnegative(),
  })
  .strict();

export type SkillEffectivenessResult = z.infer<typeof SkillEffectivenessResultSchema>;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

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
export async function computeSkillEffectiveness(
  opts: ComputeSkillEffectivenessOptions,
): Promise<SkillEffectivenessResult> {
  const { targetRepoRoot, window: rawWindow, readTelemetryDirImpl, readFileImpl } = opts;

  // ------------------------------------------------------------------
  // Step 1: Validate window (mirrors computeAgreement's AC2c guard).
  // ------------------------------------------------------------------
  const window = rawWindow ?? DEFAULT_SKILL_EFFECTIVENESS_WINDOW;
  if (!Number.isFinite(window) || !Number.isInteger(window) || window <= 0) {
    throw new SkillEffectivenessWindowInvalidError({
      window,
      reason: "must be a positive integer",
    });
  }

  // ------------------------------------------------------------------
  // Step 2: List *.jsonl files (deterministic lex order).
  // ------------------------------------------------------------------
  const telemetryDir = path.join(targetRepoRoot, ".flow", "telemetry");

  const emptyResult: SkillEffectivenessResult = {
    per_skill: {},
    window_size: window,
    sample_size: 0,
    malformed_lines: 0,
  };

  let jsonlFiles: string[];
  try {
    if (readTelemetryDirImpl) {
      jsonlFiles = await readTelemetryDirImpl(telemetryDir);
    } else {
      const entries = await fs.readdir(telemetryDir, { withFileTypes: true });
      jsonlFiles = entries
        .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
        .map((e) => e.name)
        .sort();
    }
  } catch (err: unknown) {
    if (
      err !== null &&
      typeof err === "object" &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return emptyResult; // telemetry dir absent → documented empty result
    }
    throw err;
  }

  if (jsonlFiles.length === 0) {
    return emptyResult; // no *.jsonl files → documented empty result
  }

  // ------------------------------------------------------------------
  // Step 3: Parse all lines; partition skill.invoke + reviewer.verdict.
  // ------------------------------------------------------------------
  const invokes: SkillInvokeEvent[] = [];
  const verdicts: ReviewerVerdictEvent[] = [];
  let malformed_lines = 0;

  for (const filename of jsonlFiles) {
    const filePath = path.join(telemetryDir, filename);
    const raw = readFileImpl
      ? await readFileImpl(filePath)
      : await fs.readFile(filePath, "utf8");

    for (const rawLine of raw.split("\n")) {
      const line = rawLine.trim();
      if (line === "") {
        continue; // empty/trailing-newline lines — skip silently, not malformed
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        malformed_lines++;
        continue;
      }

      const result = TelemetryEventSchema.safeParse(parsed);
      if (!result.success) {
        malformed_lines++;
        continue;
      }

      const event = result.data;
      if (event.type === "skill.invoke") {
        invokes.push(event);
      } else if (event.type === "reviewer.verdict") {
        verdicts.push(event);
      }
      // All other valid event types are silently discarded (not malformed).
    }
  }

  if (invokes.length === 0) {
    // No skill.invoke events → documented empty per-skill map (malformed lines
    // still reported; the window is still echoed).
    return { ...emptyResult, malformed_lines };
  }

  // ------------------------------------------------------------------
  // Step 4: Sort invocations newest-first by ts (stable session_id
  // tie-break) and apply the window — keep the most-recent `window`.
  // ------------------------------------------------------------------
  const sortedInvokes = [...invokes].sort((a, b) => {
    if (b.ts !== a.ts) {
      return b.ts < a.ts ? -1 : 1; // descending ts
    }
    return a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : 0;
  });
  const windowedInvokes = sortedInvokes.slice(0, window);

  // ------------------------------------------------------------------
  // Step 5: Index READY FOR MERGE verdicts by session_id for the join.
  // Each entry holds the verdicts' (ts, story_id) so the per-invocation
  // join can require a LATER verdict in the SAME story flow.
  // ------------------------------------------------------------------
  type VerdictKey = { ts: string; storyId?: string };
  const usefulVerdictsBySession = new Map<string, VerdictKey[]>();

  for (const v of verdicts) {
    if (v.data.verdict !== USEFUL_VERDICT) {
      continue;
    }
    const list = usefulVerdictsBySession.get(v.session_id) ?? [];
    list.push({ ts: v.ts, storyId: v.story_id });
    usefulVerdictsBySession.set(v.session_id, list);
  }

  // ------------------------------------------------------------------
  // Step 6: Walk the windowed invocations; tally per skill.
  // A "useful fire": a later READY FOR MERGE verdict in the same session
  // (and same story_id when BOTH the invoke and the verdict carry one).
  // ------------------------------------------------------------------
  const tally = new Map<string, { invoke: number; useful: number }>();

  for (const inv of windowedInvokes) {
    const skill = inv.data.skill_name;
    const entry = tally.get(skill) ?? { invoke: 0, useful: 0 };
    entry.invoke++;

    const candidates = usefulVerdictsBySession.get(inv.session_id) ?? [];
    const isUseful = candidates.some((v) => {
      // The verdict must come strictly after the invocation.
      if (!(v.ts > inv.ts)) {
        return false;
      }
      // When BOTH carry a story_id, they must match. When the invocation has
      // no story_id (e.g. a user-slash-command outside a story), the
      // session_id + later-ts join alone qualifies.
      if (inv.story_id !== undefined && v.storyId !== undefined) {
        return v.storyId === inv.story_id;
      }
      return true;
    });

    if (isUseful) {
      entry.useful++;
    }
    tally.set(skill, entry);
  }

  // ------------------------------------------------------------------
  // Step 7: Assemble the per-skill map (ratio 0, never NaN).
  // ------------------------------------------------------------------
  const per_skill: Record<string, PerSkillEffectiveness> = {};
  for (const [skill, counts] of tally) {
    per_skill[skill] = {
      invoke_count: counts.invoke,
      useful_fire_count: counts.useful,
      effectiveness_ratio: counts.invoke === 0 ? 0 : counts.useful / counts.invoke,
    };
  }

  return {
    per_skill,
    window_size: window,
    sample_size: windowedInvokes.length,
    malformed_lines,
  };
}
