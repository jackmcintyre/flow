import { z } from "zod";
import { MalformedExecutionManifestError } from "../errors.js";
import { ChangeTypeSchema } from "./risk-tiering-spec.js";
import { LessonSchema } from "./story-retro.js";

/**
 * Zod schema for execution manifests.
 *
 * **Producer:** `scan-sources.ts` creates manifests; Story 4.1 adds two more:
 *   - New source stories → `to-do/<ref>.yaml` with `status: "to-do"`.
 *   - Discipline violations → `blocked/<ref>.yaml` with `status: "blocked"`
 *     and the `blocked_by` / `discipline_violations` fields populated
 *     (Story 3.5 Task 6.2).
 *   - `claimStory` writes `"in-progress"` on the `to-do → in-progress`
 *     transition (Story 4.1 FR17).
 *   - `completeStory` writes `"done"` on the `in-progress → done` transition
 *     (Story 4.1 FR19).
 *
 * **Consumer:** Every future reader MUST go through `parseExecutionManifest`
 * rather than calling `ExecutionManifestSchema.parse` directly.
 *
 * **Status vocabulary (Story 4.1 widening):** This schema accepts `"to-do"`,
 * `"blocked"`, `"in-progress"`, and `"done"`. Previous stories asserted that
 * `"in-progress"` was rejected — those assertions MUST be flipped to assert
 * acceptance. The widening is additive: existing `to-do/` and `blocked/`
 * manifests parse unchanged.
 *
 * **Strict mode:** `.strict()` is intentional — unknown keys are rejected so
 * additive future fields force a coordinated schema bump rather than silent
 * acceptance via Zod's default `strip` mode. Story 4.1 added `claimed_by` and
 * widened the `status` enum; a `yaml.stringify(parseExecutionManifest(...))`
 * round-trip of an `in-progress/` or `done/` manifest preserves all fields.
 *
 * Field order mirrors the intended on-disk YAML field order so that a
 * `yaml.stringify(schema.parse(obj))` round-trip produces stable output.
 */
export const ExecutionManifestSchema = z
  .object({
    /**
     * Story reference, formatted as `<adapter>:<source-id>` (e.g.
     * `bmad:1.1`). Shape is the adapter's responsibility — no regex
     * enforcement here.
     */
    ref: z.string().min(1),

    /**
     * Manifest status.
     * - `"to-do"` — normal scan-sources output (scan-sources).
     * - `"blocked"` — discipline-violation blocked manifests (Story 3.5 Task 6.2).
     * - `"in-progress"` — written by `claimStory` on `to-do → in-progress`
     *   transition (Story 4.1 FR17).
     * - `"done"` — written by `completeStory` on `in-progress → done`
     *   transition (Story 4.1 FR19).
     */
    status: z.enum(["to-do", "blocked", "in-progress", "done"]),

    /**
     * Name of the active adapter at scan time (e.g. `"bmad"`). Stored so
     * a manifest is self-describing even if `.flow/config.yaml` later changes
     * the active adapter.
     */
    adapter: z.string().min(1),

    /**
     * Path to the source story. Stored repo-relative if the raw path falls
     * strictly inside `targetRepoRoot`; otherwise absolute. Repo-relative is
     * preferred to avoid leaking absolute paths into committed manifests.
     * See Task 2.4 in the story spec for the conversion rule.
     */
    source_path: z.string().min(1),

    /**
     * sha256 hex digest of the source story's raw bytes, computed by the
     * adapter's `listSourceStories()` call and persisted verbatim by
     * `scan-sources`. Downstream drift detection (Epic 4+) compares a
     * freshly-computed hash against this stored value.
     */
    source_hash: z.string().regex(/^[0-9a-f]{64}$/),

    /**
     * Story references this manifest depends on. Carried verbatim from
     * `SourceStory.depends_on`. Defaults to `[]`.
     */
    depends_on: z.array(z.string().min(1)).default([]),

    /**
     * Acceptance criteria, carried verbatim from the source story.
     * At least one AC is required — a story with zero ACs is malformed
     * and is refused at parse time. (FR13)
     */
    acceptance_criteria: z
      .array(
        z.object({
          text: z.string().min(1),
          kind: z.enum(["integration", "unit"]),
          /**
           * Structured verification directive carried verbatim from
           * `SourceStory.acceptance_criteria` (Story 10.1).
           *
           * **Optional and additive.** Native-scanned manifests carry it; a
           * legacy manifest written before this field existed — and every
           * BMad-scanned manifest, whose ACs leave `verification` undefined —
           * still parses under `.strict()` because the key is simply absent.
           * Adding the key (rather than relying on passthrough) keeps strict
           * mode intact while admitting the field. Resolvability of `target`
           * is the 10.3 T0-6 check, not enforced here.
           */
          verification: z
            .object({
              type: z.enum(["vitest", "artifact"]),
              target: z.string().min(1),
            })
            .optional(),
        }),
      )
      .min(1),

    /**
     * Human-readable story title. Required in v1 so operators can identify
     * manifests at a glance in their editor.
     */
    title: z.string().min(1),

    /**
     * "As a / I want / so that" paragraph. Carried verbatim from source.
     */
    narrative: z.string().min(1),

    /**
     * Structured narrative parts carried verbatim from
     * `SourceStory.narrative_struct` (Story 10.2).
     *
     * **Optional and additive.** Native-scanned manifests carry it; a legacy
     * manifest, and every BMad-scanned manifest (whose `narrative_struct` is
     * undefined until the 10.5 ingest), still parses under `.strict()` because
     * the key is simply absent. The raw `narrative` string above is always
     * present; this is the structured view.
     */
    narrative_struct: z
      .object({
        role: z.string().min(1),
        want: z.string().min(1),
        so_that: z.string().min(1),
      })
      .optional(),

    /**
     * Structured implementation tasks, each mapped to ≥1 AC id, carried
     * verbatim from `SourceStory.tasks` (Story 10.2).
     *
     * **Optional and additive** — native-scanned manifests carry it; legacy and
     * BMad-scanned manifests omit it. Whole-story T0-1 enforcement (required
     * sections present; every task mapped to an AC) is Story 10.3.
     */
    tasks: z
      .array(
        z.object({
          text: z.string().min(1),
          ac_refs: z.array(z.string().min(1)).min(1),
        }),
      )
      .optional(),

    /**
     * Repo-relative source paths cited by the story, carried verbatim from
     * `SourceStory.cited_sources` (Story 10.2).
     *
     * **Optional and additive** — native-scanned manifests carry it; legacy and
     * BMad-scanned manifests omit it. On-disk resolvability of each path is
     * T0-5 (Story 10.3), not enforced here.
     */
    cited_sources: z.array(z.string().min(1)).optional(),

    /**
     * Optional free-text implementation notes from the source story.
     * Omitted from YAML when `undefined` (use `omitUndefined: true` or
     * strip undefined-keyed pairs before stringifying).
     */
    implementation_notes: z.string().optional(),

    /**
     * `false` for new manifests written by `scan-sources`. Story 3.6
     * (`/plan` discard flow) flips this to `true`. On idempotent re-scan,
     * `scan-sources` does NOT overwrite an existing `true` value.
     */
    withdrawn: z.boolean().default(false),

    /**
     * Operator readiness brake (Story 9.1 — Epic 9 intake cockpit).
     *
     * Orthogonal to BOTH `status` and `withdrawn`: it is NOT a status value and
     * triggers NO state-directory move. `status` is the vertical axis
     * (`to-do → in-progress → done`); `withdrawn` and `ready` are horizontal
     * operator overrides on a `to-do/` manifest.
     *
     * Polarity is the mirror image of `withdrawn`:
     *   - `withdrawn: true`  removes an item from the claim candidate set.
     *   - `ready: true`      is REQUIRED to admit an item into the candidate set.
     *
     * Default `false` so the brake fails closed: a freshly-scanned backlog item
     * is in `to-do/` but is NOT claimable by the dev loop until the operator
     * blesses it via the `markStoryReady` tool (the `/flow:ready` skill). The
     * two flags are independent — a withdrawn item is never claimable regardless
     * of `ready`, and a not-ready item is never claimable regardless of deps.
     *
     * Set by the `markStoryReady` tool; honoured by the `claimNextStory`
     * eligibility filter. Additive and strict-compatible: a manifest authored
     * before this field existed parses cleanly and reads as not-ready (`false`).
     */
    ready: z.boolean().default(false),

    /**
     * When set, names the reason the manifest was placed in `blocked/`
     * instead of `to-do/`. Only populated for blocked manifests.
     *
     * **Closed enum — v1 (Story 5.13, AC2).**
     * This field is a closed `z.enum([...])` of exactly **thirteen** members.
     * Any new block reason requires a deliberate schema-change story — the
     * closed enum is the deterministic seam (project memory
     * `feedback_default_to_deterministic_seams`). Do NOT add a `z.string()`
     * fallback here; the Zod boundary must catch unknown values at write time.
     *
     * Enum member derivation (codebase audit, 2026-05-27):
     *   - `handoff-grammar`              — Story 4.3 (process-dev-transcript)
     *   - `gh-defer`                     — Story 4.5 (process-dev-transcript)
     *   - `gh-retry`                     — Story 4.5 (process-dev-transcript)
     *   - `gh-needs-human`               — Story 4.5 (process-dev-transcript)
     *   - `reviewer-no-session-result`   — Story 4.6 (process-reviewer-transcript)
     *   - `reviewer-verdict-needs-changes` — Story 4.6 (process-reviewer-transcript)
     *   - `reviewer-verdict-blocked`     — Story 4.6 (process-reviewer-transcript)
     *   - `routing-failure`              — Story 4.x (process-reviewer-yield)
     *   - `routing-self-yield`           — Story 4.x (process-reviewer-yield)
     *   - `planning-discipline`          — Story 3.5 (scan-sources)
     *   - `orphan-no-transcript`         — Story 5.11 (block-orphan-no-transcript)
     *   - `reviewer-grammar`             — Story 4.3 RESERVED (no live writer; kept
     *                                      as forward-compat reservation per 4.3 rationale)
     *   - `deps-drift`                   — Story 5.13 NEW (scan-sources deps-drift gate)
     *   - `needs-human-decision`         — Story 8.19 (process-dev-transcript): the
     *                                      dev hit a genuine decision a human must
     *                                      make to proceed correctly. NOT a hard
     *                                      block — the story pauses into the
     *                                      human-needed surface carrying the
     *                                      verbatim question; the manifest is
     *                                      stamped so its paused-for-human state is
     *                                      durable and distinct from a generic block.
     *
     * See `_bmad-output/implementation-artifacts/5-13-*.md § AC2` for the
     * full closed-enum rationale and migration table.
     *
     * Added in Story 3.5 Task 6.2. Closed enum added in Story 5.13.
     */
    blocked_by: z
      .enum([
        "handoff-grammar",
        "gh-defer",
        "gh-retry",
        "gh-needs-human",
        "reviewer-no-session-result",
        "reviewer-verdict-needs-changes",
        "reviewer-verdict-blocked",
        "routing-failure",
        "routing-self-yield",
        "planning-discipline",
        "orphan-no-transcript",
        "reviewer-grammar",
        "deps-drift",
        "needs-human-decision",
      ])
      .optional(),

    /**
     * Structured violation list for manifests blocked by `planning-discipline`.
     * Shape matches `DisciplineViolationReason` from `adapters/adapter.ts`.
     * Absent on all non-blocked manifests.
     *
     * Added in Story 3.5 Task 6.2.
     */
    discipline_violations: z
      .array(
        z.object({
          code: z.string().min(1),
          field: z.string().min(1),
          detail: z.string().min(1),
        }),
      )
      .optional(),

    /**
     * ULID of the session that claimed this story via `claimStory`.
     * Present iff `status === "in-progress" || status === "done"`.
     *
     * The tools enforce this invariant on write; Zod does NOT enforce a
     * cross-field refinement here because doing so would block scan-sources
     * rewrites of `to-do/` manifests that legitimately do not carry
     * `claimed_by`. A story in `in-progress/` without `claimed_by` is
     * treated as malformed by `completeStory` (WrongClaimantError).
     *
     * Added in Story 4.1 (FR17).
     */
    claimed_by: z.string().min(1).optional(),

    /**
     * Count of NEEDS CHANGES verdict rounds the dev/reviewer pair has run on
     * this story. `undefined` ≡ `0`. Incremented in-place by Story 4.3's
     * inner cycle on every NEEDS CHANGES verdict.
     *
     * Added in Story 4.3 (FR28).
     */
    rework_count: z.number().int().nonnegative().optional(),

    /**
     * Count of times the autonomous drain has re-claimed this story after a
     * prior run left it orphaned in `in-progress/` (a crash/interruption).
     * `undefined` ≡ `0`. Incremented in-place by `reattachOrphan` each time the
     * drain auto-resumes the orphan. The drain caps resumes on this count so a
     * genuinely-broken story cannot loop forever — past the cap it is blocked
     * (`orphan-no-transcript`) for a human instead of re-resumed.
     *
     * Distinct from `rework_count` (NEEDS CHANGES rounds within one session);
     * this counts crash-resumptions across sessions. Added in the crash-recovery
     * change (drain auto-resume).
     */
    drain_resume_attempts: z.number().int().nonnegative().optional(),

    /**
     * Risk tier verdict from the classifier (Story 4.9b — FR40a, Pattern §11).
     * Written by `postReviewerComments` after a successful POST/PATCH.
     * Optional so existing manifests (to-do/, blocked/) parse unchanged.
     */
    risk_tier: z.enum(["low", "medium", "high"]).optional(),

    /**
     * Evidence block from the risk-tier classifier (Story 4.9b — Pattern §11).
     * Mirrors the `evidence` sub-object from `RiskTierClassifierResult`.
     * Optional so existing manifests parse unchanged.
     */
    risk_tier_evidence: z
      .object({
        matched_rule: z.string().min(1),
        paths: z.array(z.string()).default([]),
        change_types: z.array(ChangeTypeSchema).default([]),
        diff_size: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),

    /**
     * Structured retro entries attached to a `done/` manifest by
     * `recordStoryRetro` (Story 6.1, FR11, FR55). `LessonSchema` is imported
     * from `./story-retro.js` — single source of truth for the closed `kind`
     * enum + `pitfall` superRefine.
     *
     * Optional on every manifest. Existing manifests (any state directory,
     * any prior shape) parse unchanged — additive only. An empty array
     * (`lessons: []`) is a valid value and round-trips through the
     * `parseExecutionManifest` validator.
     *
     * Added in Story 6.1 AC4.
     */
    lessons: z.array(LessonSchema).optional(),

    /**
     * Story-level failure-class label, attached by `recordStoryRetro`
     * (Story 6.1, FR11). Free-text in v1 by design — Stories 6.2/6.3 will
     * narrow it once the retro-analyst defines the closed set.
     *
     * Added in Story 6.1 AC4.
     */
    failure_class: z.string().min(1).optional(),

    /**
     * Wall-clock duration of the story in seconds, attached by
     * `recordStoryRetro` (Story 6.1, FR11). Non-negative integer.
     *
     * Added in Story 6.1 AC4.
     */
    duration_seconds: z.number().int().nonnegative().optional(),

    /**
     * ISO-8601 UTC timestamp at which `completeStory` moved this manifest
     * from `in-progress/` to `done/`. Stamped by `completeStory` on the
     * `in-progress → done` transition (Story 6.12 cycle-boundary feature).
     *
     * Optional and additive: existing `done/` manifests written before this
     * field existed parse cleanly and are treated as having an unknown
     * completion time (filtered OUT of a cycle window when the cycle is active,
     * unless no cycle has ever been opened — in which case all history is
     * included). Added in the cycle-boundary story.
     */
    completed_at: z
      .string()
      .datetime({ offset: false })
      .refine((s) => s.endsWith("Z"), "must be UTC")
      .optional(),
  })
  .strict();

export type ExecutionManifest = z.infer<typeof ExecutionManifestSchema>;

/**
 * Canonical reader for execution manifests.
 *
 * **Every future reader MUST go through this helper.** Callers should never
 * call `ExecutionManifestSchema.parse` / `.safeParse` directly because this
 * helper is the only place that maps Zod validation failures to the typed
 * `MalformedExecutionManifestError` that downstream tooling (Story 3.5,
 * Story 4.x) pattern-matches against.
 *
 * @param input - The raw parsed YAML object (result of `yaml.parse(rawText)`).
 * @param opts.absPath - Absolute path to the manifest file, for error context.
 * @throws {MalformedExecutionManifestError} When `input` fails schema
 *   validation (missing required field, wrong type, unknown key, etc.).
 */
export function parseExecutionManifest(
  input: unknown,
  opts: { absPath: string },
): ExecutionManifest {
  const result = ExecutionManifestSchema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    const yamlPath = issue.path.length === 0 ? "(root)" : issue.path.join(".");
    throw new MalformedExecutionManifestError({
      absPath: opts.absPath,
      yamlPath,
      zodMessage: issue.message,
      schemaModule: "mcp-server/src/schemas/execution-manifest.ts",
    });
  }
  return result.data;
}
