# Story 9.4: Quality Lead — adjudication + escalation

story_shape: substrate
Status: ready-for-dev

## Story

As a **plugin operator**,
I want **a dedicated Quality Lead role that synthesises the judge panel's verdicts and decides ready / escalate-to-me / rework**,
So that **there is one owner of the quality bar, close calls come to me instead of being auto-passed, and a blessed story has actually cleared the panel**.

This is the **adjudication** half of gate 1, and the role that makes the bar a *thing someone owns*. Story 9.3 emits a panel verdict (the five lens results); the **Quality Lead** reads it, applies the rubric's synthesis rule, and decides: a clean sweep may become `ready`; any lens fail is `rework` with the specific misses returned to the author; a split panel or a close call that persists after K rounds (default **2**) **escalates to the operator** rather than auto-passing. On a `ready` decision it blesses the draft through the existing brake tool (Story 9.1's `markStoryReady`) — never a direct manifest write. The decision reduces to a machine-checkable verdict; the Lead's *judgment* lives on the close calls, not in prose narration of the obvious ones.

The Quality Lead is the **home of the bar that the calibration loop (Epic 6b) evolves** — the retro-analyst sets the standard, the Quality Lead applies it — and it is itself measured (judge-the-judge: do its `ready` verdicts correlate with clean merges?). That accountability is what keeps a single owner from calcifying.

## Dependencies

- **Consumes Story 9.3's panel verdict** (the five lens results).
- **Reuses Story 9.1's `markStoryReady`** to bless on a clean pass (never a direct write).
- **Reuses the role/persona machinery** (catalogue + permissions + instantiate + spawn) to define and run the new role.
- **Depends on the rubric's synthesis rule** (`rubric-story-quality-2026-05-31.md` §5) for the decision logic, and its open question **K = 2** (escalation rounds).

## Acceptance Criteria

**AC1 — the Quality Lead role is defined and instantiable (artifact):**

A role catalogue file and a role permission spec define the Quality Lead — its domain, mandate, out-of-mandate, prompt, and locked phrases — shaped like the other catalogue roles, so the persona machinery can instantiate it into the team. The files exist at the catalogue and permission paths and parse against the catalogue/permission schemas.
artifact: plugins/crew/catalogue/quality-lead.md

**AC2 — adjudication synthesises the panel verdict by the rubric's rule, deterministically (integration):**

Given a panel verdict, the Quality Lead's decision follows the rubric's synthesis rule in the tool layer: all five lenses pass → `ready`-eligible; any lens fails → `rework` carrying the failed lenses' `missed` strings; a split that persists after K rounds (default 2) → `escalate`. A vitest feeds an all-pass verdict (asserts `ready`), a one-lens-fail verdict (asserts `rework` with the miss), and a split verdict at the K-th round (asserts `escalate`).
vitest: plugins/crew/mcp-server/src/tools/__tests__/quality-lead.test.ts

**AC3 — a clean pass blesses the draft through the existing brake tool (integration):**

On a `ready` decision the Quality Lead marks the draft ready by calling the Story 9.1 brake tool, not by writing the manifest directly; a `rework` or `escalate` decision leaves the draft not-ready. A vitest drives an all-pass adjudication and asserts the draft's readiness flag flips via the brake tool, and drives an `escalate` adjudication and asserts the draft stays not-ready.
vitest: plugins/crew/mcp-server/src/tools/__tests__/quality-lead.test.ts

**AC4 — a close call escalates to the operator and never auto-passes (integration):**

A split panel, or a close call still unresolved after K rounds, yields an `escalate` decision surfaced to the operator with a rationale; nothing is blessed. A vitest drives a split panel through K rounds and asserts the result is `escalate` with a populated `escalation_reason`, and that the readiness flag was never set.
vitest: plugins/crew/mcp-server/src/tools/__tests__/quality-lead.test.ts

**AC5 — the adjudication verdict is written as schema-shaped data (integration):**

The Quality Lead emits a verdict — decision (`ready` | `escalate` | `rework`), rationale, and an escalation reason when escalating — validated against a schema and persisted as the canonical record the dashboard (9.5) and the calibration loop read. A vitest asserts the emitted verdict validates against the schema and carries the decision and rationale.
vitest: plugins/crew/mcp-server/src/tools/__tests__/quality-lead.test.ts

**AC6 — the role carries negative capability (artifact):**

The Quality Lead's permission spec grants only what adjudication needs (read the panel verdict, bless via the brake tool, write its own verdict) and withholds capabilities outside its mandate (e.g. it cannot merge, push, or edit code), mirroring the reviewer's negative-capability posture. The permission file exists and lists a bounded `tools_allow`.
artifact: plugins/crew/permissions/quality-lead.yaml

## Definition of Done

- [ ] All six ACs met.
- [ ] `pnpm --dir plugins/crew/mcp-server test` green; the new test file covers every integration AC clause.
- [ ] `pnpm --dir plugins/crew/mcp-server build` green; `dist/` rebuilt and staged in the same commit.
- [ ] PR opens against `main`. CI green.
- [ ] Reviewer cycle clean — AC2–AC5 runnable vitest, AC1/AC6 file-presence.
- [ ] The bless action goes through the Story 9.1 brake tool — no direct manifest write.
- [ ] The decision rule lives in the tool layer; only close calls rest on the Lead's judgment.

## Implementation Notes

### Scope discipline — what this story does and does NOT build

**Builds:** the `quality-lead` role (catalogue + permissions), the adjudication logic (the rubric's synthesis rule in the tool layer), the adjudication verdict schema + persistence, the escalation path, and the bless-via-brake wiring.

**Does NOT build:** the panel or the lens verdicts (Story 9.3); the readiness field/brake (Story 9.1 — reuse `markStoryReady`); the judge-the-judge measurement (Epic 6b consumes this verdict; this story only emits it).

### Wire existing machinery (do not reinvent)

- **Role definition:** add `catalogue/quality-lead.md` (mirror `catalogue/generalist-reviewer.md`'s frontmatter + sections + locked phrases) and `permissions/quality-lead.yaml` (mirror `permissions/generalist-reviewer.yaml`, bounded). The existing `readCatalogue`, `instantiatePersona`, `buildPersonaSpawnPrompt`, `lookupRoleByDomain`, and `loadRolePermissions` then handle it with zero new machinery.
- **Bless:** call Story 9.1's `markStoryReady` for the `ready` decision — the brake tool is the only path that flips readiness.
- **Decision rule:** encode the rubric §5 synthesis (all-pass → ready; any-fail → rework; split/after-K → escalate) as a pure function over the `PanelVerdict`; the persona provides judgment only where the rule says "close call."

### The adjudication verdict (the deterministic seam)

- Define an `AdjudicationVerdict` schema: `{ ref, decision: "ready"|"escalate"|"rework", rationale: string, escalation_reason?: string, round: number }`, persisted alongside the panel verdict in the session dir.
- `K` (default 2) is a parameter, not a magic constant — surface it so the rubric's open question can be tuned.

### Files touched

**NEW:**
- `plugins/crew/catalogue/quality-lead.md` — the role (AC1).
- `plugins/crew/permissions/quality-lead.yaml` — bounded permissions (AC6).
- `plugins/crew/mcp-server/src/tools/quality-lead-adjudicate.ts` — the adjudication tool.
- `plugins/crew/mcp-server/src/schemas/adjudication-verdict.ts` — the verdict schema.
- `plugins/crew/mcp-server/src/tools/__tests__/quality-lead.test.ts` — AC2–AC5.

**UPDATE:**
- `plugins/crew/mcp-server/src/tools/register.ts` — register the adjudication tool.
- `plugins/crew/mcp-server/src/schemas/telemetry-events.ts` — add an adjudication event additively (the calibration loop's judge-the-judge input).

### Existing seams to wire into (do not reinvent)

- **Role/persona:** `read-catalogue.ts`, `instantiate-persona.ts`, `build-persona-spawn-prompt.ts`, `lookup-role-by-domain.ts`, `state/load-role-permissions.ts`; the catalogue/permission exemplars `catalogue/generalist-reviewer.md` + `permissions/generalist-reviewer.yaml`.
- **Brake:** Story 9.1's `markStoryReady` (the only readiness-flip path).
- **Panel verdict:** Story 9.3's `PanelVerdict` schema + its result files.
- **Synthesis rule + K:** rubric `_bmad-output/planning-artifacts/rubric-story-quality-2026-05-31.md` §5.

### Edge cases worth surfacing in dev/review

- **Never auto-pass a close call.** The whole point of escalation is that ambiguity reaches the operator; a split panel must not resolve itself to `ready`. AC4 pins this.
- **Bless only through the brake.** A direct manifest write would bypass the one chokepoint that keeps readiness operator-owned; AC3 pins the brake-tool path.
- **The Lead is measured.** The adjudication verdict is the calibration loop's input for judge-the-judge — emit it even on `ready`, so the loop can later correlate verdicts with merge outcomes.

### Risk + build notes

- **Medium** risk: introduces a role that can flip readiness (gates what the drain may build). Bounded by negative capability (AC6) and the brake-only path (AC3). Rebuild + commit `dist/`; full build + test green before PR.

### References

- Rubric synthesis rule + K: `_bmad-output/planning-artifacts/rubric-story-quality-2026-05-31.md` §5, §7 (K default 2; judge-the-judge).
- Design note (the Quality Lead role, the calibration-loop home, judge-the-judge guardrail): `_bmad-output/planning-artifacts/design-note-2026-05-31-native-planning-and-judging.md` §5.
- Story 9.1 (the brake this blesses through) and Story 9.3 (the panel verdict this adjudicates).
- Role precedent: `catalogue/generalist-reviewer.md` + `permissions/generalist-reviewer.yaml` (negative capability).
