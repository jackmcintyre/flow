import { z } from "zod";

/**
 * Discriminated-union schema for the v1 telemetry event set
 * (Story 1.5 / Implementation-patterns §5 / NFR21 / NFR14).
 *
 * **Closed set in v1.** Adding a new event type means adding a new
 * schema entry plus a `type` literal — no implicit extension. Every
 * payload is `.strict()` so unknown keys are rejected at the boundary.
 * No `data: z.record(...)` escape hatch. No body/diff/contents strings
 * that could leak PII (NFR14).
 *
 * The discriminator is `type`, dotted (`domain.event`). Pinned by
 * Implementation-patterns §5.
 */

/**
 * Fields common to every telemetry event.
 *
 * - `ts`: ISO-8601 UTC timestamp with millisecond precision (Z-suffixed).
 * - `session_id`: opaque caller-supplied identifier (caller's
 *   responsibility to enforce a ULID shape if desired).
 * - `agent`: kebab-cased role name (matches the catalogue convention
 *   and the RolePermissions role regex from Story 1.4).
 * - `story_id`: optional opaque identifier (typically `<adapter>:<source-id>`).
 */
export const TelemetryEventBase = z
  .object({
    ts: z
      .string()
      .datetime({ offset: false })
      .refine((s) => s.endsWith("Z"), "must be UTC"),
    session_id: z.string().min(1),
    agent: z
      .string()
      .min(1)
      .regex(/^[a-z0-9-]+$/),
    story_id: z.string().min(1).optional(),
  })
  .strict();

/**
 * `agent.invoke` — per-agent-invocation telemetry (FR65). Carries
 * runtime and (optionally) token counts. No string payloads (NFR14).
 */
export const AgentInvokeEventSchema = TelemetryEventBase.extend({
  type: z.literal("agent.invoke"),
  data: z
    .object({
      runtime_ms: z.number().int().nonnegative(),
      tokens_in: z.number().int().nonnegative().optional(),
      tokens_out: z.number().int().nonnegative().optional(),
    })
    .strict(),
}).strict();

/**
 * `telemetry.invalid` — the failure-recording event emitted by the
 * logger when a caller's event fails its Zod schema (AC2 / NFR6 / FR70).
 * Only carries surfacing fields — never the offending payload (NFR14).
 */
export const TelemetryInvalidEventSchema = TelemetryEventBase.extend({
  type: z.literal("telemetry.invalid"),
  data: z
    .object({
      attempted_type: z.string().min(1),
      zod_path: z.string(),
      zod_message: z.string().min(1),
    })
    .strict(),
}).strict();

/**
 * `reviewer.verdict` — per-reviewer-verdict telemetry (FR66). Emitted inside
 * `postReviewerComments` on POST success. No body/diff/contents strings (NFR14).
 * The `timed_out` flag is `true` only on the AC3 substitution path (8-min cap).
 */
export const ReviewerVerdictEventSchema = TelemetryEventBase.extend({
  type: z.literal("reviewer.verdict"),
  data: z
    .object({
      pr_number: z.number().int().positive(),
      verdict: z.enum(["READY FOR MERGE", "NEEDS CHANGES", "BLOCKED", "reviewer-failure"]),
      standards_version: z.string().regex(/^\d+\.\d+\.\d+$/),
      plugin_version: z.string().regex(/^\d+\.\d+\.\d+$/),
      timed_out: z.boolean(),
    })
    .strict(),
}).strict();

/**
 * `reviewer.verdict.merge_action` — retroactive merge-action event (FR66).
 * Emitted by `recordPrCloseAction` (typically Story 5.3's polling loop).
 * Join key for `compute-agreement` (Story 4.10): `(pr_number, session_id)`.
 */
export const ReviewerVerdictMergeActionEventSchema = TelemetryEventBase.extend({
  type: z.literal("reviewer.verdict.merge_action"),
  data: z
    .object({
      pr_number: z.number().int().positive(),
      merge_action: z.enum(["merged", "closed-unmerged", "still-open"]),
      resolved_at: z
        .string()
        .datetime({ offset: false })
        .refine((s) => s.endsWith("Z"), "must be UTC"),
    })
    .strict(),
}).strict();

/**
 * `dev.budget_exceeded` — emitted by `recordAgentInvoke` when cumulative dev
 * subagent runtime for a story crosses the 30-min budget (NFR3). One-shot per
 * `(story_id, current_month)` pair. Story 5.3's polling loop reads this to
 * surface stuck stories to the operator.
 */
export const DevBudgetExceededEventSchema = TelemetryEventBase.extend({
  type: z.literal("dev.budget_exceeded"),
  data: z
    .object({
      cumulative_runtime_ms: z.number().int().nonnegative(),
      budget_ms: z.number().int().positive(),
      triggering_invocation_runtime_ms: z.number().int().nonnegative(),
    })
    .strict(),
}).strict();

/**
 * `yield.handoff` — emitted by `processReviewerYield` when a generalist
 * reviewer's yield is successfully routed to a hired specialist (FR103, NFR29).
 * Only emitted on the success branch; routing-failure and self-yield branches
 * write no JSONL. Story 4.11.
 *
 * `agent` at the event-base level is set to `from_role` (who emitted the yield).
 * `data.from_role` is duplicated so downstream consumers reading only `data`
 * (e.g. retro tools projecting handoffs) don't need to climb up the envelope.
 */
export const YieldHandoffEventSchema = TelemetryEventBase.extend({
  type: z.literal("yield.handoff"),
  data: z
    .object({
      from_role: z.string().min(1),
      to_role: z.string().min(1),
      domain: z.string().min(1),
    })
    .strict(),
}).strict();

/**
 * `retro.proposal.applied` — emitted by the `/accept-proposal` gate
 * (`acceptProposal`) on a successful confirmed apply (Story 6.4 AC5). Exactly
 * one event per apply; NONE on preview, on a declined apply, on an idempotent
 * no-op, or on a fail-closed unregistered kind.
 *
 * - `id`              — the proposal's ULID.
 * - `proposal_type`   — the proposal's kind (one of the seven retro-proposal
 *                       discriminator literals).
 * - `applied_sha`     — the commit sha from the git wrapper.
 * - `idempotency_key` — the proposal's stable id (mirrors the `applied` block).
 *
 * No body/diff/contents strings (NFR14) — only surfacing fields.
 */
export const RetroProposalAppliedEventSchema = TelemetryEventBase.extend({
  type: z.literal("retro.proposal.applied"),
  data: z
    .object({
      id: z.string().min(1),
      proposal_type: z.enum([
        "rule",
        "rule-retirement",
        "skill-create",
        "skill-revise",
        "skill-supersede",
        "skill-retire",
        "team-change",
        "persona-append",
        "lesson-to-skill",
      ]),
      applied_sha: z.string().min(1),
      idempotency_key: z.string().min(1),
    })
    .strict(),
}).strict();

/**
 * `backlog.readiness_changed` — emitted by `markStoryReady` (Story 9.1, Epic 9
 * intake cockpit) on a real readiness toggle of a backlog item. Exactly ONE
 * event per real toggle; NONE on an idempotent no-op (the flag already holds
 * the requested value) or on the typed-error path (the ref is not an
 * un-claimed backlog item).
 *
 * - `ref`   — the backlog item's reference (`<adapter>:<source-id>`). Also
 *             mirrored into the envelope `story_id` so consumers reading only
 *             the envelope can join.
 * - `ready` — the NEW flag value after the toggle (`true` = blessed for the
 *             claim path; `false` = parked back behind the brake).
 *
 * Added additively to the discriminated union; `.strict()` posture preserved
 * (no body/diff/contents strings — NFR14).
 */
export const BacklogReadinessChangedEventSchema = TelemetryEventBase.extend({
  type: z.literal("backlog.readiness_changed"),
  data: z
    .object({
      ref: z.string().min(1),
      ready: z.boolean(),
    })
    .strict(),
}).strict();

/**
 * `draft.authored` — emitted by `writeNativeStory` (Story 9.2, Epic 9 author
 * seam) once a candidate story has PASSED the fail-closed discipline gate and
 * been written to disk. Exactly ONE event per written draft; NONE on a refused
 * / discipline-violating candidate (the write throws `DisciplineViolationError`
 * before the event is reachable) and NONE on the wrong-adapter or
 * round-trip-parse failure paths (which throw before the write completes).
 *
 * - `ref`   — the freshly-minted draft ref (`native:<ULID>`). Also mirrored into
 *             the envelope `story_id` so consumers reading only the envelope can
 *             join.
 * - `title` — the draft's human-readable title.
 *
 * Added additively to the discriminated union; `.strict()` posture preserved
 * (no body/diff/contents strings — NFR14).
 */
export const DraftAuthoredEventSchema = TelemetryEventBase.extend({
  type: z.literal("draft.authored"),
  data: z
    .object({
      ref: z.string().min(1),
      title: z.string().min(1),
    })
    .strict(),
}).strict();

/**
 * `panel.graded` — emitted by `runJudgePanel` (Story 9.3, Epic 9 gate 1 Tier 1)
 * once the judge panel has assembled a complete `PanelVerdict` for a draft.
 * Exactly ONE event per completed panel run; NONE on a panel that fails loudly
 * (a missing lens, a duplicate judge role, or a malformed lens-verdict file all
 * throw before this line).
 *
 * - `ref`           — the draft's reference (`<adapter>:<source-id>`). Also
 *                     mirrored into the envelope `story_id` so consumers reading
 *                     only the envelope can join.
 * - `tier0`         — the Tier-0 status carried on the panel verdict.
 * - `risk_tier`     — the draft's classified risk tier (low|medium|high), which
 *                     selected the Considered-lens bar.
 * - `passed_lenses` — count of lenses that PASSED (0–5).
 * - `failed_lenses` — count of lenses that FAILED (0–5). `passed + failed` is
 *                     always 5 (the five Tier-1 lenses).
 *
 * The panel writes NO readiness flag — that decision is Story 9.4's. This event
 * records that grading happened, not that the draft was blessed.
 *
 * Added additively to the discriminated union; `.strict()` posture preserved
 * (no body/diff/contents strings — NFR14, no per-lens `missed` strings leaked).
 */
export const PanelGradedEventSchema = TelemetryEventBase.extend({
  type: z.literal("panel.graded"),
  data: z
    .object({
      ref: z.string().min(1),
      tier0: z.enum(["pass", "fail"]),
      risk_tier: z.enum(["low", "medium", "high"]),
      passed_lenses: z.number().int().nonnegative(),
      failed_lenses: z.number().int().nonnegative(),
    })
    .strict(),
}).strict();

/**
 * `quality.adjudicated` — emitted by `adjudicateQualityLead` (Story 9.4, Epic 9
 * gate 1 adjudication) once the Quality Lead has synthesised a panel verdict into
 * a decision. Exactly ONE event per adjudication, on EVERY decision (including
 * `ready`) — the calibration loop's judge-the-judge input correlates `ready`
 * verdicts with downstream merge outcomes, so a `ready` adjudication must be
 * recorded too. NONE on a malformed-panel hard failure (which throws before this
 * line).
 *
 * - `ref`       — the draft's reference (`<adapter>:<source-id>`). Also mirrored
 *                 into the envelope `story_id` so consumers reading only the
 *                 envelope can join.
 * - `decision`  — the synthesised decision (`ready` | `escalate` | `rework`).
 * - `round`     — the adjudication round that produced the decision (1-based).
 * - `escalated` — `true` iff `decision === "escalate"` (a convenience flag for the
 *                 dashboard / loop; derivable from `decision`).
 *
 * The verdict's `rationale` / `escalation_reason` strings are NOT in the event
 * (NFR14 — no free-text payloads in telemetry); the canonical record carrying them
 * is the `adjudication-verdict.json` file the tool persists in the session dir.
 *
 * Added additively to the discriminated union; `.strict()` posture preserved.
 */
export const QualityAdjudicatedEventSchema = TelemetryEventBase.extend({
  type: z.literal("quality.adjudicated"),
  data: z
    .object({
      ref: z.string().min(1),
      decision: z.enum(["ready", "escalate", "rework"]),
      round: z.number().int().positive(),
      escalated: z.boolean(),
    })
    .strict(),
}).strict();

/**
 * `skill.invoke` — per-skill-invocation telemetry (Story 6.8, FR-skill-calibration).
 * Emitted by `recordSkillInvoke` (the single write-path) when a flow skill fires.
 * The architecture pins the shape (architecture/skill-calibration-loop.md): it
 * carries the skill identity + version + scope + invocation source so
 * `computeSkillEffectiveness` can attribute a downstream `reviewer.verdict` of
 * `READY FOR MERGE` to the specific skill body that fired.
 *
 * - `skill_name`        — `<plugin>:<command>` (e.g. `flow:plan`).
 * - `skill_path`        — absolute path to the skill file that fired.
 * - `skill_version`     — semver-ish version from the skill frontmatter
 *                         (Story 6.7); a plugin-scope skill that predates
 *                         versioning defaults to its shipped plugin version.
 * - `skill_scope`       — closed enum (`project | persona | plugin`). No
 *                         silent fallback variant — an unknown scope is a bug.
 * - `invocation_source` — closed enum (`user-slash-command | agent-call`).
 *
 * Both `skill_scope` and `invocation_source` are CLOSED enums: an unknown
 * value fails validation rather than falling through (the "no silent
 * fallback" discipline). `story_id` (envelope) is present only when the skill
 * fired inside a story flow; a user-slash-command outside a story has none.
 *
 * Added additively to the discriminated union; `.strict()` posture preserved
 * (no body/diff/contents strings — NFR14).
 */
export const SkillInvokeEventSchema = TelemetryEventBase.extend({
  type: z.literal("skill.invoke"),
  data: z
    .object({
      skill_name: z.string().min(1),
      skill_path: z.string().min(1),
      skill_version: z.string().min(1),
      skill_scope: z.enum(["project", "persona", "plugin"]),
      invocation_source: z.enum(["user-slash-command", "agent-call"]),
    })
    .strict(),
}).strict();

/**
 * `agent.friction` — emitted by `recordAgentFriction` when an agent compensates
 * for a surprising / broken input (Story native:01KT2RAXBSQ91Y80Z51DD26KPX).
 *
 * Friction events are the raw signal for the retro-analyst's `recurringFriction`
 * surface: when the same `kind` of friction recurs at or above the threshold
 * (count >= 2) in a cycle, `gatherRetroInputs` promotes it into
 * `recurringFriction` so the analyst can draft a fix proposal for the broken
 * seam — rather than the problem silently disappearing once the agent stumbles
 * through.
 *
 * - `kind`     — closed enum of the recognised friction categories (no silent
 *                fallback variant — an unknown kind is a bug, not a skip).
 * - `expected` — what the agent expected to receive (min 1 char).
 * - `observed` — what the agent actually received / had to compensate for
 *                (min 1 char). No body/diff/contents strings (NFR14) — keep
 *                these short and structural.
 *
 * The envelope's `agent` field carries the role that experienced the friction;
 * `session_id` is the drain-session ULID; `story_id` is the ref when the
 * friction occurred inside a story flow (optional — tools can emit friction
 * outside a story).
 *
 * Added additively to the discriminated union; `.strict()` posture preserved.
 */
export const AgentFrictionEventSchema = TelemetryEventBase.extend({
  type: z.literal("agent.friction"),
  data: z
    .object({
      kind: z.enum([
        "empty-input",
        "missing-cited-source",
        "forced-fallback",
        "repeated-retry",
      ]),
      expected: z.string().min(1),
      observed: z.string().min(1),
    })
    .strict(),
}).strict();

/**
 * `cycle.opened` — emitted by `openCycle` (Story native:01KT484NY4HCBPBTT6VEY1Q0CS)
 * each time the operator opens a new work cycle. Exactly ONE event per open.
 *
 * - `cycle_ulid`        — the freshly-minted cycle identifier now active.
 * - `prior_cycle_ulid`  — the cycle that was active immediately before this open,
 *                         or `null` on the very first open (no prior cycle).
 * - `archived`          — `true` iff a prior cycle's record was written to the
 *                         cycle-archive before the window reset; `false` on the
 *                         first open (nothing to archive).
 *
 * No body/diff/contents strings (NFR14) — only surfacing fields. The envelope
 * `story_id` is intentionally NOT used here (a cycle is not a story); consumers
 * join on `data.cycle_ulid`.
 *
 * Added additively to the discriminated union; `.strict()` posture preserved.
 */
export const CycleOpenedEventSchema = TelemetryEventBase.extend({
  type: z.literal("cycle.opened"),
  data: z
    .object({
      cycle_ulid: z.string().min(1),
      prior_cycle_ulid: z.string().min(1).nullable(),
      archived: z.boolean(),
    })
    .strict(),
}).strict();

export const TelemetryEventSchema = z.discriminatedUnion("type", [
  AgentInvokeEventSchema,
  TelemetryInvalidEventSchema,
  ReviewerVerdictEventSchema,
  ReviewerVerdictMergeActionEventSchema,
  DevBudgetExceededEventSchema,
  YieldHandoffEventSchema,
  RetroProposalAppliedEventSchema,
  BacklogReadinessChangedEventSchema,
  DraftAuthoredEventSchema,
  PanelGradedEventSchema,
  QualityAdjudicatedEventSchema,
  SkillInvokeEventSchema,
  AgentFrictionEventSchema,
  CycleOpenedEventSchema,
]);

export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;
export type ReviewerVerdictEvent = z.infer<typeof ReviewerVerdictEventSchema>;
export type ReviewerVerdictMergeActionEvent = z.infer<typeof ReviewerVerdictMergeActionEventSchema>;
export type SkillInvokeEvent = z.infer<typeof SkillInvokeEventSchema>;
export type AgentFrictionEvent = z.infer<typeof AgentFrictionEventSchema>;
