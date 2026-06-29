/**
 * Zod schemas for retro proposals — Story 6.3.
 *
 * A retro proposal is a typed, structured suggestion emitted by the
 * retro-analyst subagent at the end of a calibration cycle. Each cycle's
 * proposals are written to a single immutable markdown file at
 * `<target-repo>/.flow/retro-proposals/<ISO>.md` (`writeRetroProposal`,
 * Story 6.3 AC1). Operators read the file by hand and decide what to apply
 * via Epic 6b's `/accept-proposal` flow.
 *
 * The schema covers the **full surface** of calibration changes via a
 * `z.discriminatedUnion("type", [...])` over exactly seven literals:
 *
 *   1. `rule`             — propose a new rule (operator-readable criterion).
 *   2. `rule-retirement`  — propose retiring or relaxing an existing rule.
 *   3. `skill-create`     — propose a new skill (frontmatter + body).
 *   4. `skill-revise`     — propose revising an existing skill's body.
 *   5. `skill-supersede`  — propose retiring one skill AND creating its
 *                            replacement (two-half acceptance at apply time
 *                            in Epic 6b; the schema captures both halves
 *                            in one record).
 *   6. `skill-retire`     — propose retiring an existing skill outright.
 *   7. `team-change`      — propose hiring or unhiring a role.
 *
 * **Deterministic seam (memory `feedback_default_to_deterministic_seams`):**
 *  - Every variant is `.strict()` — no silent acceptance of unknown keys.
 *  - The discriminator is a closed `z.literal` per variant — no
 *    `z.string()` fallback.
 *  - Path-traversal is rejected inside `PathInsideRepoSchema` so that any
 *    `proposed_path` / `target_skill_path` / `superseded_skill_path`
 *    that escapes the target repo (absolute path, `..` segment) fails
 *    validation at write time.
 *
 * **Apply-time round-trip (Epic 6b):** `/accept-proposal` will re-read the
 * markdown file, `yaml.parse` the frontmatter, and re-validate through
 * `parseRetroProposalFile`. The schemas here are designed to survive both
 * write-time AND apply-time validation passes.
 *
 * (Story 6.3 — FR58, FR59, FR106, Architecture §Skill calibration loop)
 */

import { z } from "zod";
import { MalformedRetroProposalError } from "../errors.js";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * ULID shape — 26 chars, Crockford's base32 (A–Z 0–9 minus I L O U).
 * Mirrors the regex used implicitly by the `ulid` package.
 */
const UlidSchema = z
  .string()
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "must be a ULID");

/**
 * ISO-8601 UTC timestamp shape. `z.string().datetime({ offset: false })`
 * accepts both `...Z` and offset-less forms; we narrow further to require
 * the literal trailing `Z` so the on-disk artifact is always UTC.
 */
const IsoTimestampSchema = z
  .string()
  .datetime({ offset: false })
  .refine((s) => s.endsWith("Z"), "must be UTC (trailing 'Z')");

/**
 * Kebab-cased role name matching the catalogue convention
 * (lowercase letters, digits, and hyphens only — no leading hyphen
 * enforcement; the catalogue itself owns that). (FR106)
 */
const RolePathSchema = z
  .string()
  .regex(/^[a-z0-9-]+$/, "kebab-cased role name (a–z, 0–9, '-')");

/**
 * A path that MUST stay inside the target repo — refuses absolute paths
 * (anything starting with `/`) and any `..` segment (defense in depth
 * against path-traversal smuggling). Used for `proposed_path`,
 * `target_skill_path`, and `superseded_skill_path`. (Story 6.3 AC4)
 */
const PathInsideRepoSchema = z
  .string()
  .min(1)
  .refine((s) => !s.startsWith("/"), "must be repo-relative (no leading '/')")
  .refine(
    (s) => !s.split("/").includes(".."),
    "must not contain '..' segments (path-traversal)",
  );

// ---------------------------------------------------------------------------
// Per-variant schemas (one per literal in RETRO_PROPOSAL_TYPES)
// ---------------------------------------------------------------------------

/**
 * The `applied` block stamped onto an individual proposal by the
 * `/accept-proposal` gate after a successful confirmed apply (Story 6.4 AC3).
 *
 * - `applied_at`      — ISO-8601 UTC timestamp of the apply.
 * - `applied_sha`     — the commit sha from the git wrapper (single commit
 *                       carrying the handler's changed paths + the proposal
 *                       file stamp).
 * - `idempotency_key` — the proposal's stable `id` (a ULID). Re-runs match
 *                       on this persisted block; the gate returns
 *                       `already-applied` without re-applying (AC4).
 *
 * `.strict()` — no silent acceptance of unknown keys, consistent with every
 * other variant. The block is OPTIONAL on the base: existing proposal files
 * written before Story 6.4 (no `applied` key) still parse cleanly.
 */
const AppliedBlockSchema = z
  .object({
    applied_at: IsoTimestampSchema,
    applied_sha: z.string().min(1),
    idempotency_key: UlidSchema,
  })
  .strict();

export type AppliedBlock = z.infer<typeof AppliedBlockSchema>;

/**
 * Shared base shared across every variant — `id`, `created_at`, `rationale`,
 * plus the optional `applied` stamp (Story 6.4).
 * `z.object` (no `.strict()` here) so the per-variant `.extend(...).strict()`
 * applies on the final shape (zod merges + strict on extend correctly).
 *
 * `applied` is additive and optional: a proposal authored by `writeRetroProposal`
 * carries no `applied` key, and `parseRetroProposalFile` round-trips it cleanly
 * either way. The `/accept-proposal` gate is the only writer of this block.
 */
const ProposalBase = z.object({
  id: UlidSchema,
  created_at: IsoTimestampSchema,
  rationale: z.string().min(1),
  applied: AppliedBlockSchema.optional(),
});

/**
 * `rule` — propose a new operator-readable rule.
 * (Story 6.3 AC3 / FR59)
 */
const RuleProposalSchema = ProposalBase.extend({
  type: z.literal("rule"),
  text: z.string().min(1),
  target_failure_class: z.string().min(1),
  recommended_promotion_level: z.enum(["must", "should", "advisory"]),
}).strict();

/**
 * `rule-retirement` — propose retiring or relaxing an existing rule.
 * (Story 6.3 AC6 / FR64a)
 */
const RuleRetirementProposalSchema = ProposalBase.extend({
  type: z.literal("rule-retirement"),
  target_rule_id: UlidSchema,
  fire_count_over_window: z.number().int().nonnegative(),
  recommended_action: z.enum(["retire", "relax"]),
}).strict();

/**
 * Shared field-shape for skill-create payloads. Used directly by
 * `SkillCreateProposalSchema` (top-level discriminator variant) AND
 * embedded under `replacement` inside `SkillSupersedeProposalSchema` —
 * see implementation note below on why the embedded form is `z.object(
 * SkillCreateBody).strict()` rather than nesting the full
 * `SkillCreateProposalSchema` (no inner `type` discriminator).
 */
const SkillCreateBody = {
  proposed_path: PathInsideRepoSchema,
  frontmatter_description: z.string().min(1),
  body: z.string().min(1),
};

/**
 * `skill-create` — propose a new skill (frontmatter + body).
 * (Story 6.3 AC4 / FR59)
 */
const SkillCreateProposalSchema = ProposalBase.extend({
  type: z.literal("skill-create"),
  ...SkillCreateBody,
}).strict();

/**
 * `skill-revise` — propose revising an existing skill's body.
 * (Story 6.3 AC6 / Architecture §Skill calibration loop)
 */
const SkillReviseProposalSchema = ProposalBase.extend({
  type: z.literal("skill-revise"),
  target_skill_path: PathInsideRepoSchema,
  revised_body: z.string().min(1),
  version_bump: z.enum(["patch", "minor"]),
}).strict();

/**
 * `skill-supersede` — propose retiring one skill AND creating its
 * replacement. The "two-half acceptance" semantics (Epic 6b lets the
 * operator accept either half independently) is the apply-tool's concern
 * — the schema captures both halves in one record.
 *
 * **Implementation note (Dev — Story 6.3):** the `replacement` field
 * embeds the *fields* of a `skill-create` proposal via
 * `z.object(SkillCreateBody).strict()` rather than nesting the full
 * `SkillCreateProposalSchema`. This avoids a double-discriminator inside
 * a discriminated-union variant (the outer `type: "skill-supersede"` is
 * the discriminator; the inner replacement does NOT need its own `type`).
 *
 * (Story 6.3 AC6 / Architecture §Skill calibration loop)
 */
const SkillSupersedeProposalSchema = ProposalBase.extend({
  type: z.literal("skill-supersede"),
  superseded_skill_path: PathInsideRepoSchema,
  replacement: z.object(SkillCreateBody).strict(),
}).strict();

/**
 * `skill-retire` — propose retiring an existing skill outright.
 *
 * `last_invoked_at` is `z.nullable()` rather than `z.optional()`:
 * `null` is the explicit "no data — skill never fired" value; an absent
 * field would mean "didn't measure," which is a different statement.
 * Operators reading the proposal markdown should see an explicit
 * `last_invoked_at: null`, not the key missing entirely.
 *
 * (Story 6.3 AC6)
 */
const SkillRetireProposalSchema = ProposalBase.extend({
  type: z.literal("skill-retire"),
  target_skill_path: PathInsideRepoSchema,
  last_invoked_at: IsoTimestampSchema.nullable(),
}).strict();

/**
 * `team-change` — propose hiring or unhiring a role.
 *
 * Refuses empty `affected_failure_classes`: a team change with no predicted
 * impact has no observable signal at apply time and is therefore not a
 * meaningful proposal. (Story 6.3 AC5 / FR106)
 */
const TeamChangeProposalSchema = ProposalBase.extend({
  type: z.literal("team-change"),
  action: z.enum(["hire", "unhire"]),
  target_role: RolePathSchema,
  justification: z.string().min(1),
  predicted_impact: z
    .object({
      affected_failure_classes: z.array(z.string().min(1)).min(1),
    })
    .strict(),
}).strict();

/**
 * Durability routing context — the raw inputs the retro-analyst provides so
 * `writeRetroProposal` can apply the deterministic routing heuristic
 * (Story native:01KT6RH6XJFE2E09WMEHJ03JBD).
 *
 * All three fields are optional: when absent the heuristic falls back to
 * 'note' (the safest default). When present, the writer uses them to route
 * the lesson and stores the computed recommendation in `durability_recommendation`.
 *
 *  - `recurrence`  — how many times this lesson has appeared across done/
 *    manifests (1 = first time, 2+ = repeated).
 *  - `role_count`  — distinct roles in which the lesson was observed.
 *  - `story_count` — distinct stories in which the lesson was observed.
 */
const DurabilityRoutingContextSchema = z
  .object({
    recurrence: z.number().int().min(1),
    role_count: z.number().int().min(1).optional(),
    story_count: z.number().int().min(1).optional(),
  })
  .strict();

export type DurabilityRoutingContext = z.infer<
  typeof DurabilityRoutingContextSchema
>;

/**
 * The computed durability recommendation — written into the frontmatter by
 * `writeRetroProposal` so the on-disk artifact is self-describing and
 * round-trips cleanly at apply time. Operators see the plain-language reason
 * in the body; the structured `recommendation` field supports tooling.
 *
 * (Story native:01KT6RH6XJFE2E09WMEHJ03JBD)
 */
const DurabilityRecommendationSchema = z
  .object({
    recommendation: z.enum(["note", "skill", "code"]),
    reason: z.string().min(1),
  })
  .strict();

export type DurabilityRecommendation = z.infer<
  typeof DurabilityRecommendationSchema
>;

/**
 * `persona-append` — append a durable lesson to a hired role's Knowledge section.
 *
 * When applied via the `/accept-proposal` gate, the handler reads the role's
 * persona file (`team/<target_role>/PERSONA.md`), appends the lesson as a
 * structured lesson block to the `## Knowledge` section, and re-serialises
 * the full file.
 *
 * `target_role` reuses `RolePathSchema` (kebab-cased role name matching the
 * catalogue convention). `lesson` is the verbatim lesson text.
 *
 * Optional structured fields (Story native:01KT6Q8PSDZQKM57VFRHFJ3RP4):
 *  - `kind`         — lesson kind from LESSON_KINDS; defaults to "pattern" when absent.
 *  - `applies_when` — short summary for /flow:team display; defaults to `lesson` text.
 *  - `failure_class`— required when kind is "pitfall" (mirrors LessonSchema contract).
 *  - `source_ref`   — optional story ref provenance.
 *
 * Routing context fields (Story native:01KT6RH6XJFE2E09WMEHJ03JBD):
 *  - `routing_context` — recurrence/role_count/story_count inputs; when present,
 *    `writeRetroProposal` runs the durability heuristic and stores the result in
 *    `durability_recommendation` in the on-disk frontmatter.
 *  - `durability_recommendation` — the computed recommendation (note|skill|code)
 *    with a plain-language reason. Set by `writeRetroProposal`; do not pre-fill
 *    unless you are a deterministic tool (the writer owns this field).
 *
 * (Story 6.9 — persona-knowledge write-back keystone)
 * (Story native:01KT6Q8PSDZQKM57VFRHFJ3RP4 — structured lesson storage)
 * (Story native:01KT6RH6XJFE2E09WMEHJ03JBD — durability routing)
 */
const PersonaAppendProposalSchema = ProposalBase.extend({
  type: z.literal("persona-append"),
  target_role: RolePathSchema,
  lesson: z.string().min(1),
  // Optional structured fields — carried when the learning loop emits them.
  kind: z.enum(["pitfall", "pattern", "tool-quirk", "discipline"]).optional(),
  applies_when: z.string().min(1).optional(),
  failure_class: z.string().min(1).optional(),
  source_ref: z.string().min(1).optional(),
  // Durability routing — Story native:01KT6RH6XJFE2E09WMEHJ03JBD.
  routing_context: DurabilityRoutingContextSchema.optional(),
  durability_recommendation: DurabilityRecommendationSchema.optional(),
}).strict();

/**
 * `promote-lesson-to-skill` — promote a lesson from a role's Knowledge section
 * into a standalone skill file so that multiple roles can share the same know-how.
 *
 * When applied via the `/accept-proposal` gate, the handler:
 *  1. Creates a new skill file at `proposed_skill_path` (reuses the skill-create
 *     path; fails with SkillAlreadyExistsError if the path is already occupied).
 *  2. Appends a skill reference entry to the originating role's `## Skills` section
 *     in PERSONA.md (name + `when_to_use` one-liner).
 *
 * Fields:
 *  - `target_role`          — the originating role whose Knowledge section supplied
 *                              this lesson (kebab-cased, matches the catalogue convention).
 *  - `lesson_id`            — the ULID of the structured lesson block in the role's
 *                              `## Knowledge` section to promote (provides provenance).
 *  - `proposed_skill_path`  — repo-relative path for the new skill file under
 *                              `.flow/skills/` (path-traversal rejected by
 *                              PathInsideRepoSchema).
 *  - `skill_description`    — operator-readable one-liner for the skill's frontmatter
 *                              `description` field.
 *  - `skill_body`           — the full Markdown body of the skill file.
 *  - `when_to_use`          — the one-line reference text appended to the originating
 *                              role's `## Skills` section (name + trigger).
 *
 * (Story native:01KT6RHQ1K4KQMASAXNEK6MY7E — promote reusable lesson to shared skill)
 */
const PromoteLessonToSkillProposalSchema = ProposalBase.extend({
  type: z.literal("promote-lesson-to-skill"),
  target_role: RolePathSchema,
  lesson_id: z.string().min(1),
  proposed_skill_path: PathInsideRepoSchema,
  skill_description: z.string().min(1),
  skill_body: z.string().min(1),
  when_to_use: z.string().min(1),
}).strict();

/**
 * `build-story` — a recommendation to queue a new build-and-review story rather
 * than an approve-and-apply change.
 *
 * This variant is the designated output for any skill-change candidate that targets
 * the product's core machinery (i.e. its `target_skill_path` / `proposed_path` is
 * NOT under `.flow/skills/`). Such a change cannot be applied through the
 * diff-then-confirm gate — it requires a real code-review story — so
 * `writeRetroProposal` classifies it at write time and emits this type instead of
 * the original `skill-*` variant.
 *
 * **No apply handler is registered for this type.** Accepting a `build-story`
 * proposal via `/accept-proposal` fails closed with
 * `ProposalKindNotApplicableYetError` by design — the intent is always "queue this
 * through the normal author/queue/ship path," never "apply via the gate."
 *
 * Fields:
 *  - `suggested_title`       — a one-line story title the operator can hand to the
 *                              planner verbatim.
 *  - `skill_change_context`  — the original skill-change intent (what path, what kind
 *                              of change) captured as a plain string for provenance.
 *
 * (Story native:01KV76P2DW42BPBPT4ZQ0FS63Y — engine-safety classifier)
 */
const BuildStoryProposalSchema = ProposalBase.extend({
  type: z.literal("build-story"),
  suggested_title: z.string().min(1),
  skill_change_context: z.string().min(1),
}).strict();

/**
 * `lesson-consolidation` — propose merging two near-duplicate lessons in a role's
 * Knowledge section into a single sharper lesson.
 *
 * When applied via the `/accept-proposal` gate, the handler:
 *  1. Reads the role's `team/<target_role>/PERSONA.md`.
 *  2. Removes both source lesson blocks (identified by `lesson_a_id` and
 *     `lesson_b_id`) from the Knowledge section.
 *  3. Appends a new structured lesson block carrying `merged_lesson` as the
 *     `detail` field (and `applies_when` derived from the merged text).
 *
 * Fields:
 *  - `target_role`    — the role whose Knowledge section holds both duplicates.
 *  - `lesson_a_id`    — the id of the first lesson to consolidate.
 *  - `lesson_b_id`    — the id of the second lesson to consolidate.
 *  - `lesson_a_text`  — verbatim text of the first lesson (for preview rendering).
 *  - `lesson_b_text`  — verbatim text of the second lesson (for preview rendering).
 *  - `merged_lesson`  — the single proposed combined lesson text; what the operator
 *                       approves or rejects. Shown before approval so the operator
 *                       is never asked to approve a merge blind (AC3).
 *
 * (Story native:01KV7FFZ5PJKCW6Z6RVJ71XY6T — retro consolidation)
 */
const LessonConsolidationProposalSchema = ProposalBase.extend({
  type: z.literal("lesson-consolidation"),
  target_role: RolePathSchema,
  lesson_a_id: z.string().min(1),
  lesson_b_id: z.string().min(1),
  lesson_a_text: z.string().min(1),
  lesson_b_text: z.string().min(1),
  merged_lesson: z.string().min(1),
}).strict();

/**
 * `lesson-retirement` — propose retiring a set of never-earned-keep lessons from
 * a hired role's always-shown Knowledge section.
 *
 * When applied via the `/accept-proposal` gate, the handler:
 *  1. Reads the role's `team/<target_role>/PERSONA.md`.
 *  2. Removes each named lesson block (identified by id in `lesson_retirements`)
 *     from the live Knowledge section via `demoteLessonsFromBody`.
 *  3. Archives each removed lesson to `team/<role>/_archived/<id>.json` via
 *     `archiveLessons` — nothing is deleted, all retired lessons remain
 *     retrievable on demand via `recallLesson`.
 *
 * Fields:
 *  - `target_role`        — the role whose Knowledge section holds the dead lessons.
 *  - `lesson_retirements` — the list of lessons to retire; each entry carries the
 *                           lesson `id` and the `reason` the retro computed.
 *
 * (Story native:01KV7FGDTQ8FSJ2EEPHHGK0KRQ — retire dead lessons)
 */
const LessonRetirementProposalSchema = ProposalBase.extend({
  type: z.literal("lesson-retirement"),
  target_role: RolePathSchema,
  lesson_retirements: z
    .array(
      z
        .object({
          id: z.string().min(1),
          reason: z.string().min(1),
        })
        .strict(),
    )
    .min(1),
}).strict();

/**
 * `shared-skill-promotion` — recommend promoting a lesson that has been
 * independently recorded by two or more hired roles into a single shared skill
 * so that common know-how lives in one place rather than being copied into
 * each role.
 *
 * This proposal is **recommendation-only** (no auto-apply handler is registered):
 * the operator must explicitly approve via the review-and-confirm step before
 * anything is promoted. The retro analyst identifies the overlap; the operator
 * decides whether and how to implement the shared skill.
 *
 * The expected apply-time workflow (when the operator chooses to act on this):
 *  1. The operator creates a new shared skill file at `proposed_skill_path`.
 *  2. The operator adds a skill reference entry to each sharing role's
 *     `## Skills` section in PERSONA.md.
 *  3. The operator removes (or annotates as superseded) the per-role lesson
 *     copies from each role's `## Knowledge` section.
 *
 * Because this involves multiple personas and a new skill file, it is intentionally
 * NOT auto-applied via the single-step gate — the operator choreographs the
 * multi-role change with full visibility.
 *
 * Fields:
 *  - `sharing_roles`         — the roles (kebab ids) whose Knowledge sections
 *                              both carry the shared lesson. At least two entries.
 *  - `shared_lesson_text`    — the verbatim or representative lesson text from the
 *                              detection; shown to the operator for confirmation.
 *  - `representative_lesson_id` — the lesson id from the first (alphabetically)
 *                              sharing role; provides provenance.
 *  - `proposed_skill_path`   — suggested repo-relative path for the new shared skill
 *                              file (under `.flow/skills/`). The operator may change
 *                              this before acting.
 *  - `skill_description`     — a one-line description for the skill's frontmatter.
 *
 * (Story native:01KV7FJHK9CAAS860MJAG70QVS — cross-role shared lesson promotion)
 */
const SharedSkillPromotionProposalSchema = ProposalBase.extend({
  type: z.literal("shared-skill-promotion"),
  sharing_roles: z.array(RolePathSchema).min(2),
  shared_lesson_text: z.string().min(1),
  representative_lesson_id: z.string().min(1),
  proposed_skill_path: PathInsideRepoSchema,
  skill_description: z.string().min(1),
}).strict();

// ---------------------------------------------------------------------------
// Discriminated union + file-level wrapper
// ---------------------------------------------------------------------------

/**
 * The closed set of proposal-type literals. Exported as a tuple so
 * tests can iterate over it and assert the surface has not silently
 * grown (the AC2 invariant). Adding a new variant requires a
 * coordinated schema-change story. Consumers that enumerate the accepted
 * types (e.g. the `writeRetroProposal` tool description) MUST derive from
 * this constant rather than hardcoding a count — it has already grown
 * 7 → 11 → 13.
 *
 * `build-story` (added Story native:01KV76P2DW42BPBPT4ZQ0FS63Y) is the
 * engine-safety output: the retro writer emits it in place of a `skill-*`
 * proposal whose target path is not under `.flow/skills/`. It has no apply
 * handler (fails closed) so it can never dead-end via the apply gate.
 *
 * `lesson-consolidation` (added Story native:01KV7FFZ5PJKCW6Z6RVJ71XY6T) merges
 * two near-duplicate lessons in a role's Knowledge section into one sharper lesson.
 *
 * `lesson-retirement` (added Story native:01KV7FGDTQ8FSJ2EEPHHGK0KRQ) retires
 * never-earned-keep lessons from a role's always-shown Knowledge section into the
 * archived store, where they remain retrievable on demand.
 *
 * `shared-skill-promotion` (added Story native:01KV7FJHK9CAAS860MJAG70QVS)
 * recommends promoting a lesson shared by two or more roles into a single shared
 * skill. This variant has no auto-apply handler — the operator must approve and
 * act explicitly. Never promotes on its own.
 */
export const RETRO_PROPOSAL_TYPES = [
  "rule",
  "rule-retirement",
  "skill-create",
  "skill-revise",
  "skill-supersede",
  "skill-retire",
  "team-change",
  "persona-append",
  "promote-lesson-to-skill",
  "build-story",
  "lesson-consolidation",
  "lesson-retirement",
  "shared-skill-promotion",
] as const;

/**
 * The full retro-proposal discriminated union. Thirteen variants, closed enum,
 * no `z.string()` fallback.
 */
export const RetroProposalSchema = z.discriminatedUnion("type", [
  RuleProposalSchema,
  RuleRetirementProposalSchema,
  SkillCreateProposalSchema,
  SkillReviseProposalSchema,
  SkillSupersedeProposalSchema,
  SkillRetireProposalSchema,
  TeamChangeProposalSchema,
  PersonaAppendProposalSchema,
  PromoteLessonToSkillProposalSchema,
  BuildStoryProposalSchema,
  LessonConsolidationProposalSchema,
  LessonRetirementProposalSchema,
  SharedSkillPromotionProposalSchema,
]);

export type RetroProposal = z.infer<typeof RetroProposalSchema>;

/**
 * File-level wrapper schema (AC7).
 *
 * - `iso_timestamp` — UTC ISO-8601 timestamp; matches the filename component.
 * - `cycle_window`  — optional `{ from, to }` describing the calibration
 *                     window the proposals derive from; `null` when not
 *                     specified.
 * - `proposals`     — array of `RetroProposalSchema`. MAY be empty: a retro
 *                     that finds nothing worth proposing is a valid retro
 *                     and produces an empty proposals file (still records
 *                     that the retro ran).
 *
 * `.strict()` on the wrapper.
 */
export const RetroProposalFileSchema = z
  .object({
    iso_timestamp: IsoTimestampSchema,
    cycle_window: z
      .object({ from: IsoTimestampSchema, to: IsoTimestampSchema })
      .strict()
      .nullable(),
    proposals: z.array(RetroProposalSchema),
  })
  .strict();

export type RetroProposalFile = z.infer<typeof RetroProposalFileSchema>;

// ---------------------------------------------------------------------------
// Canonical parser
// ---------------------------------------------------------------------------

/**
 * Canonical parser for retro-proposal files (frontmatter shape).
 *
 * **Every caller MUST go through this helper** — it is the only place that
 * maps Zod validation failures to the typed `MalformedRetroProposalError`.
 * Mirrors `parseExecutionManifest`'s shape.
 *
 * Used by:
 *   - `writeRetroProposal` (Story 6.3) — write-time validation.
 *   - `/accept-proposal` apply tools (Epic 6b) — apply-time re-validation.
 *
 * @param input - The raw parsed YAML object (result of `yaml.parse(rawText)`)
 *                or an in-memory object shaped like the file.
 * @throws {MalformedRetroProposalError} When `input` fails schema
 *   validation.
 */
export function parseRetroProposalFile(input: unknown): RetroProposalFile {
  const result = RetroProposalFileSchema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    const yamlPath = issue.path.length === 0 ? "(root)" : issue.path.join(".");
    throw new MalformedRetroProposalError({
      yamlPath,
      zodMessage: issue.message,
      schemaModule: "mcp-server/src/schemas/retro-proposal.ts",
    });
  }
  return result.data;
}
