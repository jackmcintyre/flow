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
 *                             `reviewer.verdict` within the same story flow.
 *                             PRIMARY join is on `story_id` (the story ref the
 *                             invoke and the verdict BOTH carry); a `session_id`
 *                             join is the fallback for invokes with no story ref.
 *                             See issue #390 — the original session-only join
 *                             could never fire because the invoke's `session_id`
 *                             (Claude Code harness session) and the verdict's
 *                             `session_id` (run ULID from `mintSessionUlid`) come
 *                             from different namespaces and never match.
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
// Skill-tier table
// ---------------------------------------------------------------------------

/**
 * Three-tier model for skill effectiveness scoring:
 *
 * - `execution`  — drives stories to READY FOR MERGE; scored by the verdict
 *                  join (existing logic). Unknown skills fall back to this tier
 *                  (conservative — prevents false-positive ratios for new skills
 *                  that the table has not yet catalogued).
 * - `planning`   — orchestrates the cycle; scored on invoke presence
 *                  (useful_fire_count = invoke_count, ratio 1.0 whenever invoked).
 * - `cockpit`    — informational / read-only; scored on invoke presence (same
 *                  as planning). A cockpit skill cannot produce a verdict by
 *                  construction, so grading it on the verdict join would always
 *                  return 0 — a false signal.
 */
type SkillTier = "execution" | "planning" | "cockpit";

/**
 * Exhaustive tier table for the currently-shipped flow: skill palette.
 * Unknown names fall back to `"execution"` (conservative).
 */
const SKILL_TIER_TABLE: Record<string, SkillTier> = {
  // Execution tier — drives stories through the build-and-review path.
  "flow:run": "execution",

  // Planning / authoring tier — orchestrates the cycle.
  "flow:plan": "planning",
  "flow:hire": "planning",
  "flow:retro": "planning",

  // Cockpit / read-only tier — informational tools.
  "flow:dashboard": "cockpit",
  "flow:ready": "cockpit",
  "flow:ask": "cockpit",
  "flow:help": "cockpit",
};

/**
 * Look up the tier for a given skill name.
 * Unknown names fall back to `"execution"` so new skills are never
 * silently granted a false-positive score.
 */
function getSkillTier(skillName: string): SkillTier {
  return SKILL_TIER_TABLE[skillName] ?? "execution";
}

// ---------------------------------------------------------------------------
// Output schema & type
// ---------------------------------------------------------------------------

/**
 * Per-skill effectiveness stats. `.strict()` so unknown-key injection is
 * rejected (mirrors `AgreementMetricResultSchema`'s posture).
 *
 * `skill_tier` is optional so existing callers that only read the three
 * numeric fields keep compiling without change; it is populated for every
 * skill emitted by the new code path.
 */
const PerSkillEffectivenessSchema = z
  .object({
    invoke_count: z.number().int().nonnegative(),
    useful_fire_count: z.number().int().nonnegative(),
    effectiveness_ratio: z.number().min(0).max(1),
    skill_tier: z.enum(["execution", "planning", "cockpit"]).optional(),
  })
  .strict();

type PerSkillEffectiveness = z.infer<typeof PerSkillEffectivenessSchema>;

/**
 * Attribution state of the result — lets the retro consumer tell apart worlds
 * that both yield `useful_fire_count: 0` everywhere (issue #390):
 *
 * - `"no-completed-flows"` — no execution-tier `READY FOR MERGE` verdict
 *   existed AND no planning/cockpit-tier skill was invoked in this window.
 *   A wall of zero ratios here means "nothing to attribute", NOT "every skill
 *   is useless" — the retro MUST NOT ground a skill-retire/skill-revise on it.
 * - `"attributed"` — EITHER at least one `READY FOR MERGE` verdict existed to
 *   join against (for execution-tier skills), OR at least one planning/cockpit
 *   tier skill was invoked (tier-appropriate useful fire). Either condition
 *   means the per-skill ratios are a real effectiveness signal.
 *
 * Reported on EVERY result (including the empty/zero-invocation cases, where it
 * is `"no-completed-flows"`).
 */
const SkillEffectivenessAttribution = z.enum([
  "no-completed-flows",
  "attributed",
]);

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
    /**
     * Whether there was anything to attribute useful fires to. See
     * `SkillEffectivenessAttribution`. Distinguishes "no completed flows" from
     * "attributed zero useful fires" so the retro signal is not misread as
     * universal skill ineffectiveness (issue #390).
     */
    attribution: SkillEffectivenessAttribution,
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
    // No telemetry at all → nothing to attribute (never "every skill useless").
    attribution: "no-completed-flows",
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
  // Index the SAME useful verdicts by story_id too — the primary join key now
  // that the invoke and verdict session_id namespaces are known to diverge
  // (issue #390). A skill.invoke stamped with the active story ref joins a
  // verdict carrying that same ref regardless of session_id.
  const usefulVerdictsByStory = new Map<string, VerdictKey[]>();
  // Count of READY FOR MERGE verdicts available to attribute against — drives
  // the `attribution` field (issue #390): zero means "no completed flows", so a
  // wall of zero ratios is NOT a claim that every skill is useless.
  let usefulVerdictCount = 0;

  for (const v of verdicts) {
    if (v.data.verdict !== USEFUL_VERDICT) {
      continue;
    }
    usefulVerdictCount++;
    const key: VerdictKey = { ts: v.ts, storyId: v.story_id };
    const list = usefulVerdictsBySession.get(v.session_id) ?? [];
    list.push(key);
    usefulVerdictsBySession.set(v.session_id, list);
    if (v.story_id !== undefined) {
      const storyList = usefulVerdictsByStory.get(v.story_id) ?? [];
      storyList.push(key);
      usefulVerdictsByStory.set(v.story_id, storyList);
    }
  }

  // ------------------------------------------------------------------
  // Step 6: Walk the windowed invocations; tally per skill.
  //
  // "Useful fire" is tier-dependent (tier table above):
  //
  //   execution tier (default for unknown skills):
  //     A later READY FOR MERGE verdict in the SAME story flow.
  //     Two join keys tried (issue #390):
  //       1. story_id — primary key (invoke + verdict carry the same ref
  //          despite divergent session_id namespaces).
  //       2. session_id — legacy key for invokes with no story_id.
  //
  //   planning / cockpit tier:
  //     Presence-based: every invocation is a useful fire by definition.
  //     These skills are architecturally decoupled from the build-and-review
  //     path; scoring them on the verdict join would always return 0 — a
  //     false signal that would fill the retro inbox with retire/revise
  //     proposals for perfectly healthy tools.
  //
  // ------------------------------------------------------------------
  const tally = new Map<string, { invoke: number; useful: number; tier: SkillTier }>();

  // Track whether ANY planning/cockpit skill was invoked — used to widen
  // the attribution field (a cockpit-only cycle with no done stories is
  // still "attributed", not "no-completed-flows").
  let anyNonExecutionInvoke = false;

  for (const inv of windowedInvokes) {
    const skill = inv.data.skill_name;
    const tier = getSkillTier(skill);
    const entry = tally.get(skill) ?? { invoke: 0, useful: 0, tier };
    entry.invoke++;

    let isUseful = false;

    if (tier === "planning" || tier === "cockpit") {
      // Presence-based: every invocation is a useful fire.
      isUseful = true;
      anyNonExecutionInvoke = true;
    } else {
      // execution tier: verdict-join criterion (existing logic, unchanged).

      // Primary join: same story_id, later verdict. Fires whenever the invoke
      // carries a story_id matching a useful verdict's story_id.
      if (inv.story_id !== undefined) {
        const byStory = usefulVerdictsByStory.get(inv.story_id) ?? [];
        isUseful = byStory.some((v) => v.ts > inv.ts);
      }

      // Fallback join: same session_id, later verdict. Used when the story_id
      // join did not fire — chiefly invokes with no story_id (outside a flow).
      if (!isUseful) {
        const bySession = usefulVerdictsBySession.get(inv.session_id) ?? [];
        isUseful = bySession.some((v) => {
          if (!(v.ts > inv.ts)) {
            return false;
          }
          // When BOTH carry a story_id, they must match (don't credit a verdict
          // from a different story that happens to share a session). When the
          // invocation has no story_id, the session + later-ts join qualifies.
          if (inv.story_id !== undefined && v.storyId !== undefined) {
            return v.storyId === inv.story_id;
          }
          return true;
        });
      }
    }

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
      skill_tier: counts.tier,
    };
  }

  // Attribution is "attributed" when EITHER:
  //   - at least one READY FOR MERGE verdict existed for execution-tier scoring,
  //   - OR at least one planning/cockpit-tier skill was invoked (presence-based).
  // Only "no-completed-flows" when neither condition is met (truly nothing to
  // attribute — a cycle with no done stories AND no planning/cockpit activity).
  const isAttributed = usefulVerdictCount > 0 || anyNonExecutionInvoke;

  return {
    per_skill,
    window_size: window,
    sample_size: windowedInvokes.length,
    malformed_lines,
    attribution: isAttributed ? "attributed" : "no-completed-flows",
  };
}
