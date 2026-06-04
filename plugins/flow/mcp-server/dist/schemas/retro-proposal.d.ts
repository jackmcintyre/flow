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
export declare const AppliedBlockSchema: z.ZodObject<{
    applied_at: z.ZodString;
    applied_sha: z.ZodString;
    idempotency_key: z.ZodString;
}, z.core.$strict>;
export type AppliedBlock = z.infer<typeof AppliedBlockSchema>;
/**
 * `rule` — propose a new operator-readable rule.
 * (Story 6.3 AC3 / FR59)
 */
export declare const RuleProposalSchema: z.ZodObject<{
    id: z.ZodString;
    created_at: z.ZodString;
    rationale: z.ZodString;
    applied: z.ZodOptional<z.ZodObject<{
        applied_at: z.ZodString;
        applied_sha: z.ZodString;
        idempotency_key: z.ZodString;
    }, z.core.$strict>>;
    type: z.ZodLiteral<"rule">;
    text: z.ZodString;
    target_failure_class: z.ZodString;
    recommended_promotion_level: z.ZodEnum<{
        advisory: "advisory";
        must: "must";
        should: "should";
    }>;
}, z.core.$strict>;
/**
 * `rule-retirement` — propose retiring or relaxing an existing rule.
 * (Story 6.3 AC6 / FR64a)
 */
export declare const RuleRetirementProposalSchema: z.ZodObject<{
    id: z.ZodString;
    created_at: z.ZodString;
    rationale: z.ZodString;
    applied: z.ZodOptional<z.ZodObject<{
        applied_at: z.ZodString;
        applied_sha: z.ZodString;
        idempotency_key: z.ZodString;
    }, z.core.$strict>>;
    type: z.ZodLiteral<"rule-retirement">;
    target_rule_id: z.ZodString;
    fire_count_over_window: z.ZodNumber;
    recommended_action: z.ZodEnum<{
        relax: "relax";
        retire: "retire";
    }>;
}, z.core.$strict>;
/**
 * `skill-create` — propose a new skill (frontmatter + body).
 * (Story 6.3 AC4 / FR59)
 */
export declare const SkillCreateProposalSchema: z.ZodObject<{
    id: z.ZodString;
    created_at: z.ZodString;
    rationale: z.ZodString;
    applied: z.ZodOptional<z.ZodObject<{
        applied_at: z.ZodString;
        applied_sha: z.ZodString;
        idempotency_key: z.ZodString;
    }, z.core.$strict>>;
    proposed_path: z.ZodString;
    frontmatter_description: z.ZodString;
    body: z.ZodString;
    type: z.ZodLiteral<"skill-create">;
}, z.core.$strict>;
/**
 * `skill-revise` — propose revising an existing skill's body.
 * (Story 6.3 AC6 / Architecture §Skill calibration loop)
 */
export declare const SkillReviseProposalSchema: z.ZodObject<{
    id: z.ZodString;
    created_at: z.ZodString;
    rationale: z.ZodString;
    applied: z.ZodOptional<z.ZodObject<{
        applied_at: z.ZodString;
        applied_sha: z.ZodString;
        idempotency_key: z.ZodString;
    }, z.core.$strict>>;
    type: z.ZodLiteral<"skill-revise">;
    target_skill_path: z.ZodString;
    revised_body: z.ZodString;
    version_bump: z.ZodEnum<{
        minor: "minor";
        patch: "patch";
    }>;
}, z.core.$strict>;
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
export declare const SkillSupersedeProposalSchema: z.ZodObject<{
    id: z.ZodString;
    created_at: z.ZodString;
    rationale: z.ZodString;
    applied: z.ZodOptional<z.ZodObject<{
        applied_at: z.ZodString;
        applied_sha: z.ZodString;
        idempotency_key: z.ZodString;
    }, z.core.$strict>>;
    type: z.ZodLiteral<"skill-supersede">;
    superseded_skill_path: z.ZodString;
    replacement: z.ZodObject<{
        proposed_path: z.ZodString;
        frontmatter_description: z.ZodString;
        body: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>;
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
export declare const SkillRetireProposalSchema: z.ZodObject<{
    id: z.ZodString;
    created_at: z.ZodString;
    rationale: z.ZodString;
    applied: z.ZodOptional<z.ZodObject<{
        applied_at: z.ZodString;
        applied_sha: z.ZodString;
        idempotency_key: z.ZodString;
    }, z.core.$strict>>;
    type: z.ZodLiteral<"skill-retire">;
    target_skill_path: z.ZodString;
    last_invoked_at: z.ZodNullable<z.ZodString>;
}, z.core.$strict>;
/**
 * `team-change` — propose hiring or unhiring a role.
 *
 * Refuses empty `affected_failure_classes`: a team change with no predicted
 * impact has no observable signal at apply time and is therefore not a
 * meaningful proposal. (Story 6.3 AC5 / FR106)
 */
export declare const TeamChangeProposalSchema: z.ZodObject<{
    id: z.ZodString;
    created_at: z.ZodString;
    rationale: z.ZodString;
    applied: z.ZodOptional<z.ZodObject<{
        applied_at: z.ZodString;
        applied_sha: z.ZodString;
        idempotency_key: z.ZodString;
    }, z.core.$strict>>;
    type: z.ZodLiteral<"team-change">;
    action: z.ZodEnum<{
        hire: "hire";
        unhire: "unhire";
    }>;
    target_role: z.ZodString;
    justification: z.ZodString;
    predicted_impact: z.ZodObject<{
        affected_failure_classes: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
}, z.core.$strict>;
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
export declare const DurabilityRoutingContextSchema: z.ZodObject<{
    recurrence: z.ZodNumber;
    role_count: z.ZodOptional<z.ZodNumber>;
    story_count: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export type DurabilityRoutingContext = z.infer<typeof DurabilityRoutingContextSchema>;
/**
 * The computed durability recommendation — written into the frontmatter by
 * `writeRetroProposal` so the on-disk artifact is self-describing and
 * round-trips cleanly at apply time. Operators see the plain-language reason
 * in the body; the structured `recommendation` field supports tooling.
 *
 * (Story native:01KT6RH6XJFE2E09WMEHJ03JBD)
 */
export declare const DurabilityRecommendationSchema: z.ZodObject<{
    recommendation: z.ZodEnum<{
        code: "code";
        note: "note";
        skill: "skill";
    }>;
    reason: z.ZodString;
}, z.core.$strict>;
export type DurabilityRecommendation = z.infer<typeof DurabilityRecommendationSchema>;
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
export declare const PersonaAppendProposalSchema: z.ZodObject<{
    id: z.ZodString;
    created_at: z.ZodString;
    rationale: z.ZodString;
    applied: z.ZodOptional<z.ZodObject<{
        applied_at: z.ZodString;
        applied_sha: z.ZodString;
        idempotency_key: z.ZodString;
    }, z.core.$strict>>;
    type: z.ZodLiteral<"persona-append">;
    target_role: z.ZodString;
    lesson: z.ZodString;
    kind: z.ZodOptional<z.ZodEnum<{
        discipline: "discipline";
        pattern: "pattern";
        pitfall: "pitfall";
        "tool-quirk": "tool-quirk";
    }>>;
    applies_when: z.ZodOptional<z.ZodString>;
    failure_class: z.ZodOptional<z.ZodString>;
    source_ref: z.ZodOptional<z.ZodString>;
    routing_context: z.ZodOptional<z.ZodObject<{
        recurrence: z.ZodNumber;
        role_count: z.ZodOptional<z.ZodNumber>;
        story_count: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    durability_recommendation: z.ZodOptional<z.ZodObject<{
        recommendation: z.ZodEnum<{
            code: "code";
            note: "note";
            skill: "skill";
        }>;
        reason: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
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
export declare const PromoteLessonToSkillProposalSchema: z.ZodObject<{
    id: z.ZodString;
    created_at: z.ZodString;
    rationale: z.ZodString;
    applied: z.ZodOptional<z.ZodObject<{
        applied_at: z.ZodString;
        applied_sha: z.ZodString;
        idempotency_key: z.ZodString;
    }, z.core.$strict>>;
    type: z.ZodLiteral<"promote-lesson-to-skill">;
    target_role: z.ZodString;
    lesson_id: z.ZodString;
    proposed_skill_path: z.ZodString;
    skill_description: z.ZodString;
    skill_body: z.ZodString;
    when_to_use: z.ZodString;
}, z.core.$strict>;
/**
 * The closed set of nine proposal-type literals. Exported as a tuple so
 * tests can iterate over it and assert the surface has not silently
 * grown (the AC2 invariant). Adding a tenth variant requires a
 * coordinated schema-change story.
 */
export declare const RETRO_PROPOSAL_TYPES: readonly ["rule", "rule-retirement", "skill-create", "skill-revise", "skill-supersede", "skill-retire", "team-change", "persona-append", "promote-lesson-to-skill"];
/**
 * The full retro-proposal discriminated union. AC2: exactly nine
 * variants, closed enum, no `z.string()` fallback.
 */
export declare const RetroProposalSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    id: z.ZodString;
    created_at: z.ZodString;
    rationale: z.ZodString;
    applied: z.ZodOptional<z.ZodObject<{
        applied_at: z.ZodString;
        applied_sha: z.ZodString;
        idempotency_key: z.ZodString;
    }, z.core.$strict>>;
    type: z.ZodLiteral<"rule">;
    text: z.ZodString;
    target_failure_class: z.ZodString;
    recommended_promotion_level: z.ZodEnum<{
        advisory: "advisory";
        must: "must";
        should: "should";
    }>;
}, z.core.$strict>, z.ZodObject<{
    id: z.ZodString;
    created_at: z.ZodString;
    rationale: z.ZodString;
    applied: z.ZodOptional<z.ZodObject<{
        applied_at: z.ZodString;
        applied_sha: z.ZodString;
        idempotency_key: z.ZodString;
    }, z.core.$strict>>;
    type: z.ZodLiteral<"rule-retirement">;
    target_rule_id: z.ZodString;
    fire_count_over_window: z.ZodNumber;
    recommended_action: z.ZodEnum<{
        relax: "relax";
        retire: "retire";
    }>;
}, z.core.$strict>, z.ZodObject<{
    id: z.ZodString;
    created_at: z.ZodString;
    rationale: z.ZodString;
    applied: z.ZodOptional<z.ZodObject<{
        applied_at: z.ZodString;
        applied_sha: z.ZodString;
        idempotency_key: z.ZodString;
    }, z.core.$strict>>;
    proposed_path: z.ZodString;
    frontmatter_description: z.ZodString;
    body: z.ZodString;
    type: z.ZodLiteral<"skill-create">;
}, z.core.$strict>, z.ZodObject<{
    id: z.ZodString;
    created_at: z.ZodString;
    rationale: z.ZodString;
    applied: z.ZodOptional<z.ZodObject<{
        applied_at: z.ZodString;
        applied_sha: z.ZodString;
        idempotency_key: z.ZodString;
    }, z.core.$strict>>;
    type: z.ZodLiteral<"skill-revise">;
    target_skill_path: z.ZodString;
    revised_body: z.ZodString;
    version_bump: z.ZodEnum<{
        minor: "minor";
        patch: "patch";
    }>;
}, z.core.$strict>, z.ZodObject<{
    id: z.ZodString;
    created_at: z.ZodString;
    rationale: z.ZodString;
    applied: z.ZodOptional<z.ZodObject<{
        applied_at: z.ZodString;
        applied_sha: z.ZodString;
        idempotency_key: z.ZodString;
    }, z.core.$strict>>;
    type: z.ZodLiteral<"skill-supersede">;
    superseded_skill_path: z.ZodString;
    replacement: z.ZodObject<{
        proposed_path: z.ZodString;
        frontmatter_description: z.ZodString;
        body: z.ZodString;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    id: z.ZodString;
    created_at: z.ZodString;
    rationale: z.ZodString;
    applied: z.ZodOptional<z.ZodObject<{
        applied_at: z.ZodString;
        applied_sha: z.ZodString;
        idempotency_key: z.ZodString;
    }, z.core.$strict>>;
    type: z.ZodLiteral<"skill-retire">;
    target_skill_path: z.ZodString;
    last_invoked_at: z.ZodNullable<z.ZodString>;
}, z.core.$strict>, z.ZodObject<{
    id: z.ZodString;
    created_at: z.ZodString;
    rationale: z.ZodString;
    applied: z.ZodOptional<z.ZodObject<{
        applied_at: z.ZodString;
        applied_sha: z.ZodString;
        idempotency_key: z.ZodString;
    }, z.core.$strict>>;
    type: z.ZodLiteral<"team-change">;
    action: z.ZodEnum<{
        hire: "hire";
        unhire: "unhire";
    }>;
    target_role: z.ZodString;
    justification: z.ZodString;
    predicted_impact: z.ZodObject<{
        affected_failure_classes: z.ZodArray<z.ZodString>;
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    id: z.ZodString;
    created_at: z.ZodString;
    rationale: z.ZodString;
    applied: z.ZodOptional<z.ZodObject<{
        applied_at: z.ZodString;
        applied_sha: z.ZodString;
        idempotency_key: z.ZodString;
    }, z.core.$strict>>;
    type: z.ZodLiteral<"persona-append">;
    target_role: z.ZodString;
    lesson: z.ZodString;
    kind: z.ZodOptional<z.ZodEnum<{
        discipline: "discipline";
        pattern: "pattern";
        pitfall: "pitfall";
        "tool-quirk": "tool-quirk";
    }>>;
    applies_when: z.ZodOptional<z.ZodString>;
    failure_class: z.ZodOptional<z.ZodString>;
    source_ref: z.ZodOptional<z.ZodString>;
    routing_context: z.ZodOptional<z.ZodObject<{
        recurrence: z.ZodNumber;
        role_count: z.ZodOptional<z.ZodNumber>;
        story_count: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    durability_recommendation: z.ZodOptional<z.ZodObject<{
        recommendation: z.ZodEnum<{
            code: "code";
            note: "note";
            skill: "skill";
        }>;
        reason: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>, z.ZodObject<{
    id: z.ZodString;
    created_at: z.ZodString;
    rationale: z.ZodString;
    applied: z.ZodOptional<z.ZodObject<{
        applied_at: z.ZodString;
        applied_sha: z.ZodString;
        idempotency_key: z.ZodString;
    }, z.core.$strict>>;
    type: z.ZodLiteral<"promote-lesson-to-skill">;
    target_role: z.ZodString;
    lesson_id: z.ZodString;
    proposed_skill_path: z.ZodString;
    skill_description: z.ZodString;
    skill_body: z.ZodString;
    when_to_use: z.ZodString;
}, z.core.$strict>], "type">;
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
export declare const RetroProposalFileSchema: z.ZodObject<{
    iso_timestamp: z.ZodString;
    cycle_window: z.ZodNullable<z.ZodObject<{
        from: z.ZodString;
        to: z.ZodString;
    }, z.core.$strict>>;
    proposals: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        id: z.ZodString;
        created_at: z.ZodString;
        rationale: z.ZodString;
        applied: z.ZodOptional<z.ZodObject<{
            applied_at: z.ZodString;
            applied_sha: z.ZodString;
            idempotency_key: z.ZodString;
        }, z.core.$strict>>;
        type: z.ZodLiteral<"rule">;
        text: z.ZodString;
        target_failure_class: z.ZodString;
        recommended_promotion_level: z.ZodEnum<{
            advisory: "advisory";
            must: "must";
            should: "should";
        }>;
    }, z.core.$strict>, z.ZodObject<{
        id: z.ZodString;
        created_at: z.ZodString;
        rationale: z.ZodString;
        applied: z.ZodOptional<z.ZodObject<{
            applied_at: z.ZodString;
            applied_sha: z.ZodString;
            idempotency_key: z.ZodString;
        }, z.core.$strict>>;
        type: z.ZodLiteral<"rule-retirement">;
        target_rule_id: z.ZodString;
        fire_count_over_window: z.ZodNumber;
        recommended_action: z.ZodEnum<{
            relax: "relax";
            retire: "retire";
        }>;
    }, z.core.$strict>, z.ZodObject<{
        id: z.ZodString;
        created_at: z.ZodString;
        rationale: z.ZodString;
        applied: z.ZodOptional<z.ZodObject<{
            applied_at: z.ZodString;
            applied_sha: z.ZodString;
            idempotency_key: z.ZodString;
        }, z.core.$strict>>;
        proposed_path: z.ZodString;
        frontmatter_description: z.ZodString;
        body: z.ZodString;
        type: z.ZodLiteral<"skill-create">;
    }, z.core.$strict>, z.ZodObject<{
        id: z.ZodString;
        created_at: z.ZodString;
        rationale: z.ZodString;
        applied: z.ZodOptional<z.ZodObject<{
            applied_at: z.ZodString;
            applied_sha: z.ZodString;
            idempotency_key: z.ZodString;
        }, z.core.$strict>>;
        type: z.ZodLiteral<"skill-revise">;
        target_skill_path: z.ZodString;
        revised_body: z.ZodString;
        version_bump: z.ZodEnum<{
            minor: "minor";
            patch: "patch";
        }>;
    }, z.core.$strict>, z.ZodObject<{
        id: z.ZodString;
        created_at: z.ZodString;
        rationale: z.ZodString;
        applied: z.ZodOptional<z.ZodObject<{
            applied_at: z.ZodString;
            applied_sha: z.ZodString;
            idempotency_key: z.ZodString;
        }, z.core.$strict>>;
        type: z.ZodLiteral<"skill-supersede">;
        superseded_skill_path: z.ZodString;
        replacement: z.ZodObject<{
            proposed_path: z.ZodString;
            frontmatter_description: z.ZodString;
            body: z.ZodString;
        }, z.core.$strict>;
    }, z.core.$strict>, z.ZodObject<{
        id: z.ZodString;
        created_at: z.ZodString;
        rationale: z.ZodString;
        applied: z.ZodOptional<z.ZodObject<{
            applied_at: z.ZodString;
            applied_sha: z.ZodString;
            idempotency_key: z.ZodString;
        }, z.core.$strict>>;
        type: z.ZodLiteral<"skill-retire">;
        target_skill_path: z.ZodString;
        last_invoked_at: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>, z.ZodObject<{
        id: z.ZodString;
        created_at: z.ZodString;
        rationale: z.ZodString;
        applied: z.ZodOptional<z.ZodObject<{
            applied_at: z.ZodString;
            applied_sha: z.ZodString;
            idempotency_key: z.ZodString;
        }, z.core.$strict>>;
        type: z.ZodLiteral<"team-change">;
        action: z.ZodEnum<{
            hire: "hire";
            unhire: "unhire";
        }>;
        target_role: z.ZodString;
        justification: z.ZodString;
        predicted_impact: z.ZodObject<{
            affected_failure_classes: z.ZodArray<z.ZodString>;
        }, z.core.$strict>;
    }, z.core.$strict>, z.ZodObject<{
        id: z.ZodString;
        created_at: z.ZodString;
        rationale: z.ZodString;
        applied: z.ZodOptional<z.ZodObject<{
            applied_at: z.ZodString;
            applied_sha: z.ZodString;
            idempotency_key: z.ZodString;
        }, z.core.$strict>>;
        type: z.ZodLiteral<"persona-append">;
        target_role: z.ZodString;
        lesson: z.ZodString;
        kind: z.ZodOptional<z.ZodEnum<{
            discipline: "discipline";
            pattern: "pattern";
            pitfall: "pitfall";
            "tool-quirk": "tool-quirk";
        }>>;
        applies_when: z.ZodOptional<z.ZodString>;
        failure_class: z.ZodOptional<z.ZodString>;
        source_ref: z.ZodOptional<z.ZodString>;
        routing_context: z.ZodOptional<z.ZodObject<{
            recurrence: z.ZodNumber;
            role_count: z.ZodOptional<z.ZodNumber>;
            story_count: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        durability_recommendation: z.ZodOptional<z.ZodObject<{
            recommendation: z.ZodEnum<{
                code: "code";
                note: "note";
                skill: "skill";
            }>;
            reason: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>, z.ZodObject<{
        id: z.ZodString;
        created_at: z.ZodString;
        rationale: z.ZodString;
        applied: z.ZodOptional<z.ZodObject<{
            applied_at: z.ZodString;
            applied_sha: z.ZodString;
            idempotency_key: z.ZodString;
        }, z.core.$strict>>;
        type: z.ZodLiteral<"promote-lesson-to-skill">;
        target_role: z.ZodString;
        lesson_id: z.ZodString;
        proposed_skill_path: z.ZodString;
        skill_description: z.ZodString;
        skill_body: z.ZodString;
        when_to_use: z.ZodString;
    }, z.core.$strict>], "type">>;
}, z.core.$strict>;
export type RetroProposalFile = z.infer<typeof RetroProposalFileSchema>;
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
export declare function parseRetroProposalFile(input: unknown): RetroProposalFile;
