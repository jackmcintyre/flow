# Story 6.8: `skill.invoke` telemetry and skill-effectiveness helper

story_shape: substrate
Status: ready-for-dev

## Story

As a **plugin maintainer**,
I want **every skill invocation to emit a `skill.invoke` telemetry event and a deterministic helper to compute per-skill effectiveness from those events joined to review outcomes**,
So that **skill retirement and revision are data-driven, not vibes-driven — the retro analyst (Story 6.6's symmetric skill path) can see which skills actually earn their slot and which have gone quiet or useless**.

This story makes the skill side of the calibration loop **observable**. Story 6.7 built the apply surface (skills can be created/revised/superseded/retired); this story adds the measurement that tells the analyst *when* to revise or retire. It has two deterministic halves and one design decision. The deterministic halves: (1) a `skill.invoke` telemetry event + a `recordSkillInvoke` single-write-path tool, and (2) a `computeSkillEffectiveness` pure helper that reads `skill.invoke` events, joins them to review verdicts, and reports per-skill `invoke_count`, `useful_fire_count`, and `effectiveness_ratio` — no LLM, mirroring the shipped `computeAgreement`. The design decision is the **invocation-capture seam**: how `recordSkillInvoke` actually fires on each invocation (see Implementation Notes — recommended path + a verification step, because no runtime seam observes skill invocations today).

## Dependencies

- **Pairs with Story 6.7** (the skill apply surface). This story measures the skills 6.7 produces; 6.7 does not depend on this.
- **Consumes the telemetry plumbing (shipped, Epic 1):** `logTelemetryEvent` (`lib/logger.ts`), the `.strict()` discriminated `TelemetryEventSchema` (`schemas/telemetry-events.ts`), and the per-month `.crew/telemetry/<YYYY-MM>.jsonl` append path.
- **Consumes the verdict events (shipped, Epic 4/5):** `reviewer.verdict` (carrying the verdict enum + `pr_number`) and `reviewer.verdict.merge_action` — the join partners for "useful fire" (an invocation followed by a READY-FOR-MERGE in the same story).
- **Mirrors `computeAgreement` (shipped):** `tools/compute-agreement.ts` is the exact precedent for a deterministic telemetry-reading helper with injected read seams — `computeSkillEffectiveness` follows its structure.
- **Is the data feed Story 6.6's symmetric skill-retirement logic relies on:** the architecture's skill retirement criterion uses invoke counts + useful-fire ratio over a window, which this helper computes.

## Acceptance Criteria

**AC1 — a `skill.invoke` telemetry event and a `recordSkillInvoke` write-path land exactly one valid event (integration):**

A `skill.invoke` variant is added to the `.strict()` discriminated `TelemetryEventSchema`, carrying `data: { skill_name, skill_path, skill_version, skill_scope: project | persona | plugin, invocation_source: user-slash-command | agent-call }` on top of the telemetry base (`ts`, `session_id`, `agent`, optional `story_id`). A `recordSkillInvoke` tool validates its input and emits exactly one such event via `logTelemetryEvent` (which stamps `ts`). A vitest calls `recordSkillInvoke` and asserts exactly one well-formed `skill.invoke` line lands in telemetry with all five `data` fields, and asserts the schema rejects an unknown `skill_scope` or `invocation_source` (closed enums, no fallback).
vitest: plugins/crew/mcp-server/src/tools/__tests__/record-skill-invoke.test.ts

**AC2 — `computeSkillEffectiveness` reports per-skill invoke/useful-fire/ratio deterministically (integration):**

A pure `computeSkillEffectiveness` helper (no LLM) reads `.crew/telemetry/*.jsonl` over a configurable window, and for each skill reports `invoke_count` (count of `skill.invoke` events), `useful_fire_count` (invocations followed by a `READY FOR MERGE` `reviewer.verdict` within the same story — join on `session_id` + `story_id`), and `effectiveness_ratio` (`useful_fire_count / invoke_count`). It is fully deterministic — same telemetry yields the same numbers — and reads through injected file/dir seams like `computeAgreement`. A vitest seeds a known distribution of `skill.invoke` + `reviewer.verdict` events and asserts the per-skill `invoke_count`, `useful_fire_count`, and `effectiveness_ratio` match by hand, including a skill that fired but was never followed by a READY-FOR-MERGE (ratio 0) and a skill invoked once and followed by one (ratio 1).
vitest: plugins/crew/mcp-server/src/tools/__tests__/compute-skill-effectiveness.test.ts

**AC3 — `computeSkillEffectiveness` handles empty, malformed, and windowed inputs like `computeAgreement` (integration):**

With no `skill.invoke` events, the helper returns a documented empty result (empty per-skill map or `null`), never an error. Malformed JSONL lines are skipped and counted (a `malformed_lines` field), not fatal. The configurable window bounds which events are considered, and the result reports the `window_size` / `sample_size` actually used. A vitest drives the helper over an empty telemetry dir, a dir with malformed lines mixed in, and a window narrower than the event set, asserting the documented empty result, the malformed-line count, and the window bound.
vitest: plugins/crew/mcp-server/src/tools/__tests__/compute-skill-effectiveness.test.ts

**AC4 — the invocation-capture seam emits a `skill.invoke` for crew skill invocations (integration):**

A capture seam is wired so that invoking a crew skill produces a `skill.invoke` event without the operator doing anything. The chosen mechanism is documented and verified (see Implementation Notes: **preferred** — a plugin invocation hook that calls `recordSkillInvoke`, matching the architecture's "skill runtime wrapper"; **fallback if the harness exposes no such hook** — instrument the crew skills' first step to call `recordSkillInvoke`, mirroring the shipped `recordYield` / `recordStoryRetro` precedent). The dev verifies hook availability before choosing, documents the mechanism and its coverage/limitation (a prose-call seam can be skipped under load — note it), and proves the seam end-to-end. A vitest (or, where a hook can't be unit-tested, an asserted integration check) exercises the seam for at least one crew skill and asserts a valid `skill.invoke` event lands with the correct `skill_name`, `skill_version` (resolved from the skill frontmatter), `skill_scope`, and `invocation_source`.
vitest: plugins/crew/mcp-server/src/tools/__tests__/record-skill-invoke.test.ts

**AC5 — `recordSkillInvoke` and `computeSkillEffectiveness` are registered with the DomainError envelope (artifact):**

Both tools are registered in `register.ts` with the standard `DomainError` envelope, grouped with the other telemetry/retro-path tools. The `skill.invoke` event is part of the `.strict()` union (no silent fallback variant), and `computeSkillEffectiveness` returns a `.strict()` typed result schema mirroring `AgreementMetricResultSchema`.
artifact: plugins/crew/mcp-server/src/tools/register.ts

## Definition of Done

- [ ] All five ACs met.
- [ ] `pnpm --dir plugins/crew/mcp-server test` green; the two new test files cover every integration AC clause.
- [ ] `pnpm --dir plugins/crew/mcp-server build` green; `dist/` rebuilt and staged in the same commit (CI fails on `src`/`dist` drift).
- [ ] PR opens against `main`. CI green.
- [ ] Reviewer cycle clean — AC1–AC4 are runnable vitest, AC5 is file-presence/registration; the reviewer's runnable-AC pass should be all-green.
- [ ] `computeSkillEffectiveness` is pure and deterministic (injected read seams, no clock-dependence beyond the window), with hand-checkable numbers — it does not call an LLM.
- [ ] The invocation-capture mechanism (AC4) is documented in the completion notes, including which option was chosen, why, and its coverage limitation.
- [ ] Scope held: no change to the skill apply surface (6.7) or the gate (6.4); this story only observes + measures.

## Implementation Notes

### The invocation-capture seam (the one real design decision)

**The gap:** today no runtime seam observes a skill invocation. Skills are SKILL.md slash-commands run by Claude Code (user) or by an agent via Task; the MCP server is a passive tool provider and never sees the invocation. So `skill.invoke` needs a trigger. Resolve it in this order:

1. **Preferred — a plugin invocation hook.** If the Claude Code plugin harness exposes a hook that fires on slash-command / skill invocation (e.g. a settings-level pre/post hook), wire it to call `recordSkillInvoke`. This is the architecture's "skill runtime wrapper" and the deterministic-seam-correct answer — it cannot be skipped under load. **The dev must verify hook availability in the current harness first** (this is an open capability question; do not assume it exists).
2. **Fallback — instrument the crew skills' first step.** If no such hook exists, have each crew SKILL.md call `recordSkillInvoke` as its first action, mirroring the **shipped** `recordYield` (reviewer skill) and `recordStoryRetro` precedents. This is a prose-call seam: the project's standing lesson is that "MUST-call-X" prose can be skipped under load (under-counting invocations). Accept and **document** that limitation; it degrades the count, not correctness (the ratio is still meaningful over the invocations that were captured).

Either way, the **write-path** (`recordSkillInvoke` + the event schema) and the **read-path** (`computeSkillEffectiveness`) are deterministic and fully testable now (AC1–AC3); only the trigger depends on the chosen seam (AC4). Keep `recordSkillInvoke` the single write-path so there is exactly one place the event is shaped, regardless of trigger.

### The `skill.invoke` event (architecture-pinned shape)

Add to `schemas/telemetry-events.ts`, on `TelemetryEventBase`:

```ts
export const SkillInvokeEventSchema = TelemetryEventBase.extend({
  type: z.literal("skill.invoke"),
  data: z.object({
    skill_name: z.string().min(1),                 // "<plugin>:<command>"
    skill_path: z.string().min(1),
    skill_version: z.string().min(1),              // from the skill frontmatter (Story 6.7)
    skill_scope: z.enum(["project", "persona", "plugin"]),
    invocation_source: z.enum(["user-slash-command", "agent-call"]),
  }).strict(),
}).strict();
```

Add it to the `TelemetryEventSchema` discriminated union (keep `.strict()` — surprise keys/variants are bugs). `skill_version` resolves from the skill file's frontmatter (the schema Story 6.7 authored); a plugin-scope skill that predates versioning can default to its shipped version.

### `computeSkillEffectiveness` (mirror `computeAgreement` exactly)

Follow `tools/compute-agreement.ts`:

- `computeSkillEffectiveness({ targetRepoRoot, window?, readTelemetryDirImpl?, readFileImpl? })`.
- List `.crew/telemetry/*.jsonl` (deterministic lex sort), parse each line via `TelemetryEventSchema.safeParse`, skip + count malformed.
- Partition `skill.invoke` and `reviewer.verdict` events; for each `skill.invoke`, a "useful fire" is a later `reviewer.verdict` of `READY FOR MERGE` sharing the same `session_id` (and `story_id` when both carry one). Per skill: `invoke_count`, `useful_fire_count`, `effectiveness_ratio`.
- Return a `.strict()` result schema mirroring `AgreementMetricResultSchema`: a per-skill map plus `window_size`, `sample_size`, `malformed_lines`. Document the empty case (empty map or `null`).
- Inject the read seams so AC2/AC3 are deterministic with no real filesystem clock.

### Files touched

**NEW:**
- `plugins/crew/mcp-server/src/tools/record-skill-invoke.ts` — the single write-path tool.
- `plugins/crew/mcp-server/src/tools/compute-skill-effectiveness.ts` — the pure helper.
- `plugins/crew/mcp-server/src/tools/__tests__/record-skill-invoke.test.ts` — AC1, AC4.
- `plugins/crew/mcp-server/src/tools/__tests__/compute-skill-effectiveness.test.ts` — AC2, AC3.

**UPDATE:**
- `plugins/crew/mcp-server/src/schemas/telemetry-events.ts` — add `SkillInvokeEventSchema` to the union.
- `plugins/crew/mcp-server/src/tools/register.ts` — register both tools.
- The crew SKILL.md files and/or the plugin hook config — only on the fallback path (AC4), to wire the capture seam.

### Existing seams to wire into (do not reinvent)

- **Telemetry:** `logTelemetryEvent` (`lib/logger.ts`) — stamps `ts`, validates against the union, appends one JSONL line. `recordSkillInvoke` calls this once.
- **Helper precedent:** `computeAgreement` (`tools/compute-agreement.ts`) — copy its window/skip/malformed/return structure and the `readTelemetryDirImpl` / `readFileImpl` injection seams.
- **Verdict events:** `ReviewerVerdictEventSchema` / `ReviewerVerdictMergeActionEventSchema` in `telemetry-events.ts` — the join partners; reuse the verdict-enum value `READY FOR MERGE`.
- **Skill frontmatter:** the `SkillFrontmatterSchema` from Story 6.7 — `skill_version` / `skill_scope` resolve from it.
- **Prose-call precedent (fallback only):** `recordYield` (reviewer skill first-class tool call) and `recordStoryRetro` — the shipped pattern for a skill invoking an MCP tool as a step.
- **Test conventions:** mirror `compute-agreement`'s tests for the helper; the tmpRoot + telemetry-read pattern for `recordSkillInvoke`.

### Edge cases worth surfacing in dev/review

- **Zero invocations / zero useful fires.** Documented empty result and ratio `0` (not `NaN`) for an invoked-but-never-useful skill; pin both.
- **Invocation with no `story_id`.** A user-slash-command outside a story flow has no `story_id` — it counts toward `invoke_count` but can never be a "useful fire" (no story verdict to join). Decide and document whether such invocations are excluded from the ratio denominator or kept; recommend keeping them with a note.
- **Multiple invokes before one verdict.** If a skill fires twice in one story before a READY-FOR-MERGE, decide whether both count as useful fires or only the last; document the rule and test it.
- **Under-count on the fallback seam.** If a SKILL.md skips its `recordSkillInvoke` first-step, the invoke is missed. The ratio stays meaningful over captured invocations; surface the limitation rather than implying total coverage (the "no silent caps" discipline).
- **Closed enums.** An unknown `skill_scope` / `invocation_source` must fail validation, not fall through — AC1 pins this.

### Risk + build notes (drain context)

- This is a `low`-to-`medium`-risk change: it adds a telemetry event + two read/write tools and (on the fallback path) edits SKILL.md first-steps. No canonical-state mutation beyond appending telemetry. The auto-merge gate may still pause if the classifier reads the SKILL.md edits as surface changes — that's acceptable.
- Code change touching schema + tools + (maybe) skills/hooks: rebuild and commit `dist/` in the same change; full `pnpm build` + `pnpm test` green from `plugins/crew/mcp-server` before the PR.
- Telemetry is append-only via the logger; do not write `.crew/telemetry` directly.

### References

- Epic 6 file, Story 6.8 block.
- Story 6.7 (the skill apply surface + frontmatter schema this measures): `_bmad-output/implementation-artifacts/6-7-skill-proposal-application-create-revise-supersede-retire.md`.
- Architecture: `_bmad-output/planning-artifacts/architecture/skill-calibration-loop.md` — the `skill.invoke` event shape, the `computeSkillEffectiveness` tool, and the retirement criterion that consumes the ratio.
- Helper precedent: `tools/compute-agreement.ts` (deterministic telemetry helper with injected read seams).
- Standing lesson on prose-call seams: load-bearing side-effects belong in tool-layer seams, not "MUST-call-X" prose — the reason a hook is preferred over instrumented SKILL.md.
