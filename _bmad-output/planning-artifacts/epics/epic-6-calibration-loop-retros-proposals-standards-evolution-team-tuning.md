# Epic 6: Calibration Loop — Retros, Proposals, Standards Evolution, Team Tuning

Story-level retros + a cycle-level retro produce user-gated proposals that mutate rule registry, skills, personas, and team composition. The standard and the team get sharper.

## Phasing (2026-05-27 reframe)

Epic 6 ships in two tranches:

- **6a (proximate, in scope for v1):** Stories 6.1–6.3 — retro runs, captures structured lessons, emits typed proposal markdown. **No mutation surface.** The output is inert markdown; humans (Jack) decide what, if anything, to apply by hand.
- **6b (after self-bootstrap proven):** Stories 6.4–6.13 — proposals mutate `docs/standards.md`, skills, personas, and team composition via the `/accept-proposal <id>` diff-then-confirm gate. This is the actual calibration loop closing on itself.

6b cannot be dropped; 6a's emitted proposals are inert without it. The phasing exists to defer the standards-evolution complexity until self-bootstrap is demonstrably stable. The 6a → 6b path is what makes Epic 6 a real calibration loop and not just a retro-collection feature.

See `_bmad-output/planning-artifacts/sprint-change-proposal-2026-05-27-reframe.md` and memory `project_epic_6_phased`.

## Story 6.1: Story-level retro entries via `record-story-retro`

As a plugin maintainer,
I want every story completion to attach structured retro entries to its manifest,
So that the cycle-level retro has parseable data to roll up.

**Acceptance Criteria:**

**Given** a story moving from `in-progress/` to `done/`,
**When** the reviewer's terminal action runs,
**Then** `record-story-retro` writes `lessons[]` (each with `kind: pitfall | pattern | tool-quirk | discipline`, `text`, optional `failure_class`, optional `routed_to`), `failure_class`, `duration_seconds`, `rework_count` into the manifest. _(FR11, FR55)_ `artifact: plugins/flow/mcp-server/src/tools/record-story-retro.ts`

**Given** any lesson, **When** validated, **Then** `kind` is required and constrained to the four allowed values; `failure_class` is required when `kind: pitfall`. _(FR11)_ `artifact: plugins/flow/mcp-server/src/schemas/story-retro.ts`

**AC3 (integration):** vitest covers happy-path retro write + each kind value. `vitest: plugins/flow/mcp-server/src/tools/__tests__/record-story-retro.test.ts`

## Story 6.2: `/retro` skill and retro-analyst subagent

As a plugin operator,
I want `/<plugin>:retro` to run the cycle-level retro analyst over the cycle's manifests, telemetry, and rule registry,
So that I get a single proposal markdown summarising what to change.

**Acceptance Criteria:**

**Given** a cycle with stories in `done/` and a populated telemetry log,
**When** I run `/<plugin>:retro`,
**Then** the retro-analyst subagent reads every done manifest, the current JSONL telemetry, the rule registry, and the prior retro proposals (for context). _(FR56, FR57)_ `artifact: plugins/flow/skills/retro/SKILL.md`

**Given** the retro-analyst, **When** it runs, **Then** it cannot mutate the rule registry, `docs/standards.md`, sprint-history, or plugin skills directly — only emit a proposal markdown. _(FR60)_ `artifact: plugins/flow/catalogue/retro-analyst.md`

**AC3 (integration):** vitest drives `/retro` against a fixture cycle and asserts the agent's allowlist refuses canonical-state writes. `vitest: plugins/flow/mcp-server/src/tools/__tests__/retro-skill.test.ts`

## Story 6.3: Retro proposal markdown with seven proposal types

As a plugin operator,
I want every cycle's retro to produce a single proposal markdown file under `.flow/retro-proposals/<ISO>.md` carrying any of seven proposal types,
So that the calibration loop covers learning what not to do, what to always do, and how to evolve the team.

**Acceptance Criteria:**

**Given** the retro-analyst output, **When** parsed, **Then** it produces a single file at `<target-repo>/.flow/retro-proposals/<ISO-timestamp>.md`. _(FR58)_ `artifact: plugins/flow/mcp-server/src/tools/write-retro-proposal.ts`

**Given** any proposal in the file, **When** validated, **Then** its `type` is one of `rule | rule-retirement | skill-create | skill-revise | skill-supersede | skill-retire | team-change`. _(FR59, Architecture §Skill calibration loop)_ `artifact: plugins/flow/mcp-server/src/schemas/retro-proposal.ts`

**Given** a `rule` proposal, **When** validated, **Then** it carries `text`, `target_failure_class`, and `recommended_promotion_level`. _(FR59)_ `artifact: plugins/flow/mcp-server/src/schemas/retro-proposal.ts`

**Given** a `skill-create` proposal, **When** validated, **Then** it carries `proposed_path`, `frontmatter_description`, and `body`. _(FR59)_ `artifact: plugins/flow/mcp-server/src/schemas/retro-proposal.ts`

**Given** a `team-change` proposal, **When** validated, **Then** it carries `action: hire | unhire`, `target_role`, `justification`, `predicted_impact` (which failure classes are expected to change). _(FR106)_ `artifact: plugins/flow/mcp-server/src/schemas/retro-proposal.ts`

**AC6 (integration):** vitest covers parsing and Zod validation of each proposal type. `vitest: plugins/flow/mcp-server/src/schemas/__tests__/retro-proposal.test.ts`

## Story 6.4: `/accept-proposal <id>` skill — diff-then-confirm gate

As a plugin operator,
I want every proposal kind to flow through one user-gated apply path with a diff-then-confirm UX,
So that no canonical-state mutation lands without me seeing what changed.

**Acceptance Criteria:**

**Given** a proposal id,
**When** I run `/<plugin>:accept-proposal <id>`,
**Then** the plugin renders a diff of the proposed change and waits for explicit confirmation before applying. _(FR61)_

**Given** an already-applied proposal id,
**When** I run `/accept-proposal <id>` again,
**Then** the skill no-ops with a clear "already applied" message. _(NFR10)_

**Given** any apply path, **When** mutation succeeds, **Then** the change is committed via the plugin's git wrapper and the proposal is marked applied (next retro sees this).

**Given** any accepted proposal, **When** apply succeeds, **Then** an `applied:` block is written to the proposal markdown's frontmatter (`applied_at`, `applied_sha`, `idempotency_key`) AND a `retro.proposal` JSONL event records the apply; subsequent `/accept-proposal` calls on the same id read the frontmatter block and no-op. _(FR61, NFR10)_

**AC4 (integration):** vitest drives accept-proposal against (a) a fresh rule proposal, (b) a re-applied id, (c) a refused (user-cancelled) apply.

## Story 6.5: Rule registry parser and `apply-rule-proposal`

As a plugin maintainer,
I want the rule registry parsed with comment preservation and an apply tool that mutates it on accepted proposals,
So that the registry stays the single source of truth without losing human-authored context.

**Acceptance Criteria:**

**Given** the rule registry at `<target-repo>/docs/discipline-rules.yaml`,
**When** parsed with the comment-preserving `yaml` package,
**Then** the parse round-trips comments without loss. _(Architecture)_

**Given** an accepted `rule` proposal,
**When** `apply-rule-proposal` runs,
**Then** the rule is appended/edited in `discipline-rules.yaml` with `introduced_at` set to now (ISO-8601) and `id` set to a new ULID. _(FR62)_

**Given** the registry post-apply, **When** validated against the rule-registry Zod schema, **Then** every rule has `id`, `text`, `target_failure_class`, `introduced_at`, optional `level: must | should | advisory`. _(FR62)_

**AC4 (integration):** vitest covers parse-roundtrip + append-rule + schema validation; asserts comments survive a write cycle.

## Story 6.5b: `regenerate-standards`, version bump, and ≤10-cap re-enforcement

As a plugin operator,
I want `docs/standards.md` deterministically regenerated from the registry on every accepted rule change,
So that the standards doc and the registry never drift.

**Acceptance Criteria:**

**Given** the rule registry post-apply,
**When** `regenerate-standards` runs,
**Then** `docs/standards.md` is rewritten from the registry deterministically (same registry → identical bytes). _(FR48)_

**Given** a regenerated `docs/standards.md`,
**When** re-parsed,
**Then** its `version` is bumped from the prior version (monotonic). _(FR48)_

**Given** a registry that would produce more than 10 criteria,
**When** `regenerate-standards` runs,
**Then** the operation refuses with a `StandardsCapExceededError` citing the offending criteria count; the registry write from Story 6.5 is reverted via the git wrapper. _(FR46)_

**AC4 (integration):** vitest covers (a) regenerate-determinism (same input → same output), (b) version bump, (c) cap exceedance refusal with registry rollback.

## Story 6.6: Promotion threshold and rule retirement

As a plugin operator,
I want the retro analyst to flag `failure_class` promotion thresholds and propose retiring rules whose target class has stopped firing,
So that the standards doc grows from observed misses *and* relaxes when a rule stops earning its slot.

**Acceptance Criteria:**

**Given** a `failure_class` whose fire count hits a configurable promotion threshold within the cycle window,
**When** the retro analyst runs,
**Then** the proposal carries a `rule` proposal targeting that class. _(FR64)_

**Given** a rule whose target `failure_class` has not fired for ≥ M consecutive cycles (default M=5, configurable),
**When** the retro analyst runs,
**Then** the proposal carries a `rule-retirement` proposal with `target_rule_id`, `fire_count_over_window`, and `recommended_action: retire | relax`. _(FR64a)_

**Given** an accepted `rule-retirement` proposal, **When** `apply-rule-proposal` (retirement path) runs, **Then** the rule is removed from `discipline-rules.yaml` (or `level:` demoted to advisory) and `docs/standards.md` is regenerated. _(FR64a)_

**AC4 (integration):** vitest covers both promotion and retirement against seeded telemetry.

## Story 6.7: Skill proposal application — create, revise, supersede, retire

As a plugin operator,
I want every skill-shaped proposal kind to apply through the same gate as rules,
So that "what should always happen" gets codified, revised, and retired with the same discipline as "what shouldn't."

**Acceptance Criteria:**

**Given** an accepted `skill-create` proposal, **When** `apply-skill-proposal` runs, **Then** a new skill file is written at the proposed path with frontmatter (`name`, `description`, `allowed_tools`, `version: 0.1.0`, `introduced_at`, `source_lesson_refs`); refuses to overwrite an existing file. _(FR63)_

**Given** an accepted `skill-revise` proposal, **When** `apply-skill-revision` runs, **Then** the prior skill body is archived under `<skill>.history/<version>.md`, the frontmatter `version` is bumped, and the body is replaced.

**Given** an accepted `skill-supersede` proposal pair, **When** applied, **Then** the create-half writes the new skill and the retire-half archives the old; either half can be accepted independently.

**Given** an accepted `skill-retire` proposal, **When** `apply-skill-retirement` runs, **Then** the skill file is moved to `_archived/<name>.md` with `retired_at` stamped; history is preserved.

**AC5 (integration):** vitest covers each of the four apply paths.

## Story 6.8: `skill.invoke` telemetry and skill-effectiveness helper

As a plugin maintainer,
I want every skill invocation to emit a `skill.invoke` event and a deterministic helper to compute per-skill effectiveness,
So that skill retirement is data-driven rather than vibes-driven.

**Acceptance Criteria:**

**Given** any skill invocation (user-typed or agent-call), **When** the skill runtime wrapper fires, **Then** a `skill.invoke` event lands in JSONL with `skill_name`, `skill_path`, `skill_version`, `skill_scope: project | persona | plugin`, `invocation_source: user-slash-command | agent-call`. _(Architecture §Skill calibration loop)_

**Given** the telemetry log,
**When** `compute-skill-effectiveness` runs over a configurable window,
**Then** it returns per-skill `invoke_count`, `useful_fire_count` (READY-FOR-MERGE-followed), and `effectiveness_ratio` — pure deterministic, no LLM. _(NFR23 style)_

**AC3 (integration):** vitest seeds telemetry and asserts the helper's numbers match by hand.

## Story 6.9: Persona-knowledge append via `.proposed.md` and accept-proposal

As a plugin operator,
I want persona knowledge appends to land via a diff-then-confirm filesystem gate,
So that my agents cannot silently rewrite their own memory.

**Acceptance Criteria:**

**Given** a hired role at session end proposing an append to its persona,
**When** the proposal is written,
**Then** it lands at `<target-repo>/team/<role>/PERSONA.proposed.md` (sibling, not in-place edit). _(FR94, FR95, NFR26)_

**Given** a `.proposed.md` sibling,
**When** I run `/<plugin>:accept-proposal <persona-append-id>`,
**Then** the diff renders, on confirm the content is merged into `PERSONA.md`'s `## Knowledge` section, and the `.proposed.md` is deleted. _(FR95, NFR26)_

**Given** an `.proposed.md` left unresolved,
**When** the next session starts for that role,
**Then** the agent operates against `PERSONA.md` *without* the pending append (no silent inclusion). _(NFR26)_

**AC4 (integration):** vitest covers propose → accept and propose → ignore → next-session paths.

## Story 6.10: Team-change proposals and `apply-team-change`

As a plugin operator,
I want accepted team-change proposals to flow through the hiring manager for hires and archive personas for unhires,
So that the team evolves through the same user-gated path as rules and skills.

**Acceptance Criteria:**

**Given** an accepted `team-change` proposal with `action: hire`,
**When** `apply-team-change` runs,
**Then** it hands off to the hiring manager to draft the persona file from the catalogue template, user-confirms, then `instantiate-persona` writes it. _(FR107)_

**Given** an accepted `team-change` proposal with `action: unhire`,
**When** `apply-team-change` runs,
**Then** the persona file is moved to `<target-repo>/team/_archived/<role>/PERSONA.md` with `unhired_at` stamped — archived, not deleted. _(FR107)_

**Given** an unhired role's archived persona, **When** the user reads it, **Then** it's still plain Markdown and accessible. _(NFR25)_

**AC4 (integration):** vitest covers hire + unhire apply paths.

## Story 6.11: Outcome stats and constructive-to-defensive ratio

As a plugin operator,
I want a deterministic helper that reports rule fire counts before and after introductions, team-composition changes, and a constructive-to-defensive ratio,
So that the calibration loop is observable without an LLM in the loop.

**Acceptance Criteria:**

**Given** `discipline-rules.yaml` with `introduced_at` per rule,
**When** `compute-outcome-stats` runs,
**Then** it returns fire counts before/after each rule's `introduced_at` plus delta. _(FR68)_

**Given** team-composition changes recorded in telemetry, **When** the helper runs, **Then** fire counts are reported before/after each hire and unhire. _(FR110)_

**Given** the proposal history,
**When** the helper runs,
**Then** it exposes a `constructive_to_defensive_ratio` (accepted skill proposals / accepted rule proposals over the window). _(Architecture §Skill calibration loop)_

**AC4 (integration):** vitest seeds proposals + telemetry and asserts ratio + per-rule + per-team-change numbers.

## Story 6.12: `archive-cycle` and cycle boundaries

As a plugin operator,
I want each drained cycle's state archived to `_bmad-output/sprint-history/<cycle>-<ts>.yaml`,
So that historical retros, outcome stats, and writeup analysis survive across cycles.

**Acceptance Criteria:**

**Given** a cycle whose `done/` is the only non-empty state directory,
**When** `archive-cycle` is invoked,
**Then** the cycle's manifests, retro proposals, and a telemetry summary are written to `<target-repo>/.flow/sprint-history/<cycle-id>-<ISO>.yaml` and the active state directories are reset. _(FR69)_

**Given** an already-archived cycle id,
**When** `archive-cycle` is invoked again,
**Then** the operation no-ops with a clear message. _(NFR10)_

**AC3 (integration):** vitest covers archive + re-archive.

## Story 6.13: Persona files version-controlled and bad-append recovery

As a plugin operator,
I want persona files committed in the target repo so I can `git revert` a bad append,
So that a polluted persona is recoverable without manual editing of files I don't fully understand.

**Acceptance Criteria:**

**Given** an accepted persona-knowledge append, **When** applied, **Then** the change lands as a git-committable diff via the plugin's git wrapper. _(FR97, NFR27)_

**Given** a polluted persona file,
**When** the user runs `git revert <sha>` on the offending commit,
**Then** subsequent session starts pick up the reverted persona without further intervention. _(NFR27)_

**AC3 (integration):** vitest covers append → revert → next-read cycle.

## Story 6.14: Hand-editable persona files (defaults, template, minimal-valid)

As a plugin operator,
I want persona files I can comfortably open and edit by hand — with sensible defaults filled in, a documented minimal-valid shape, and a template I can copy when authoring a custom role,
So that tuning a persona doesn't require knowing the full schema or reverse-engineering an existing file.

**Context:** Surfaced in the Epic 2 retro (PR #76). A fixture failed schema on a missing `model_tier` field — the symptom of a broader usability gap: persona files are technically YAML/Markdown but operators can't reasonably hand-edit them without a working example and known-good defaults. This story closes that gap before the persona-knowledge append flow (6.9) lands and we ask operators to read/diff persona files routinely.

**Acceptance Criteria:**

**Given** a persona file with optional fields omitted,
**When** the persona loader reads it,
**Then** missing fields (e.g. `model_tier`) resolve to documented defaults rather than failing schema validation. _(FR-tbd)_

**Given** the persona schema,
**When** an operator looks for a minimal-valid template,
**Then** `plugins/flow/templates/persona.minimal.md` (or equivalent docs path) exists, is referenced from the docs index, and is itself a valid persona file. _(NFR-tbd)_

**Given** the custom-role hire flow,
**When** a new persona is instantiated without a catalogue entry,
**Then** the generated file uses the template above as its starting shape (not a raw schema dump). _(FR-tbd)_

**AC4 (integration):** vitest covers (a) load-with-defaults, (b) template validates against the schema, (c) custom-role instantiation produces a file matching the template's shape.

---
