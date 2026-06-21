# Story 9.2: Author seam — feature to drafted story

story_shape: substrate
Status: ready-for-dev

## Story

As a **plugin operator**,
I want **to describe a feature in plain language and get back a drafted story spec that has already passed the discipline checks and is parked in the backlog as not-ready**,
So that **I can propose work without hand-writing a spec, and nothing I propose can be built until it has been judged and blessed**.

This is the **author seam** of the intake cockpit (gate 1): the operator's half of "propose a feature." It deliberately reuses the existing native-authoring machinery rather than rebuilding it — the draft is written by the same `writeNativeStory` path the planner uses, validated by the same authoring-time discipline checks (Story 3.5), materialised into the backlog by the same scan, and defaulted **not-ready** by the Story 9.1 brake. What is new is a thin operator surface (a skill + a lean single-draft author subagent) and one piece of hardening: the discipline gate is enforced **at the write tool, fail-closed**, not left to the author subagent's prose to remember. That closes the prose-mandate gap (the planner *asks* its subagent to validate before writing; this story makes a violating write *impossible*), per the project's deterministic-seam principle.

The author here is intentionally simpler than the full interactive planner: one plain-language feature in, one draft story out — no four-step elicitation loop, no whole-backlog review. The drafted story's quality target is the rubric; this story enforces the rubric's **Tier 0** (the machine-checkable veto) at authoring time. The **Tier 1** panel judgment is Story 9.3.

## Dependencies

- **Consumes Story 9.1's `ready` field + not-ready default** — a freshly authored draft lands in the backlog with `ready: false`, so it is not claimable until blessed.
- **Reuses Epic 3's authoring machinery** — `writeNativeStory`, the authoring-time discipline validator (`validatePlannerBacklog` / `validateStoryAgainstDiscipline`, Story 3.5), `scanSources`, and the native adapter.
- **Feeds Story 9.3** — the judge panel grades the drafts this seam produces; and the Story 9.1 brake keeps them unclaimable until blessed.
- The merged rubric is the quality target the author writes toward; this story enforces its Tier 0.

## Acceptance Criteria

**AC1 — a draft that fails the discipline gate is never written (integration):**

The write path is fail-closed on discipline: a candidate story that violates an authoring-time discipline rule (e.g. a state-mutating story with no integration AC) is rejected by the write tool itself with a typed error naming the violations, and no file is written. The gate does not depend on the author subagent remembering to validate first — even a direct write of a violating story is refused. A vitest drives the write path with a state-mutating candidate that lacks an integration AC and asserts: a typed discipline error is raised carrying the violation code(s), and no native-story file appears on disk.
vitest: plugins/crew/mcp-server/src/tools/__tests__/write-native-story.test.ts

**AC2 — a passing draft materialises as a not-ready backlog item (integration):**

A candidate that passes the discipline gate is written, and after a scan it appears as a backlog manifest defaulted **not-ready** — present in the backlog but not claimable by the drain until the operator blesses it. A vitest authors a passing candidate through the seam, runs the scan, and asserts: the manifest exists in the backlog state, reads not-ready, and the claim entry point does not return it.
vitest: plugins/crew/mcp-server/src/tools/__tests__/author-seam.test.ts

**AC3 — discipline violations are returned to the operator for revision, not swallowed (integration):**

When the gate refuses a draft, the seam surfaces the specific violation codes back to the operator (the refuse-and-revise path) rather than silently dropping the draft or writing a broken one. The operator can revise the feature framing and retry; nothing is written until a draft passes. A vitest drives the seam with a failing candidate and asserts the returned result carries the violation codes and writes nothing, then drives a corrected candidate and asserts it writes.
vitest: plugins/crew/mcp-server/src/tools/__tests__/author-seam.test.ts

**AC4 — the `/crew:author` skill drives the seam (artifact):**

A skill defines the operator command: it takes a plain-language feature description, spawns the author subagent, runs the deterministic validate-then-write, and reports the draft's ref and its not-ready status. Its frontmatter lists the author tools in `allowed_tools`; its body never instructs a direct story-file write or git call — every write flows through the tool. The file exists at the skill path and is shaped like the other crew skills.
artifact: plugins/crew/skills/author/SKILL.md

**AC5 — the author subagent is a lean single-draft author (artifact):**

A catalogue prompt defines the author role: one plain-language feature in, one draft story out — distinct from the planner's interactive four-step loop. Its `allowed_tools` include the validate and write tools and the backlog-inventory read; it is instructed to author the integration-AC spine first (the rubric's floor) and to hand off via the locked phrase. The file exists at the catalogue path and mirrors the planner catalogue's shape.
artifact: plugins/crew/catalogue/author.md

**AC6 — a written draft emits exactly one telemetry event (integration):**

A new closed-enum telemetry event records a draft authored, carrying the ref and title. Exactly one event is emitted per written draft and none on a refused/violating candidate. The event variant is added additively to the telemetry discriminated union, preserving its strict posture. A vitest authors one passing draft and asserts a single event lands with the right ref, and asserts no event is emitted for a refused candidate.
vitest: plugins/crew/mcp-server/src/tools/__tests__/author-seam.test.ts

## Definition of Done

- [ ] All six ACs met.
- [ ] `pnpm --dir plugins/crew/mcp-server test` green; the new/updated test files cover every integration AC clause.
- [ ] `pnpm --dir plugins/crew/mcp-server build` green; `dist/` rebuilt and staged in the same commit (CI fails on `src`/`dist` drift).
- [ ] PR opens against `main`. CI green.
- [ ] Reviewer cycle clean — AC1–AC3 and AC6 are runnable vitest, AC4–AC5 are file-presence.
- [ ] The discipline gate is enforced at the write tool (fail-closed), not only in subagent prose — a direct violating write is refused.
- [ ] Schema and telemetry changes are additive only; the not-ready default from Story 9.1 is reused, not re-implemented.

## Implementation Notes

### Scope discipline — what this story does and does NOT build

**Builds (the seam + the hardening):** the `/crew:author` skill, a lean author subagent catalogue prompt, the fail-closed discipline check inside the write path, and the draft-authored telemetry event.

**Does NOT build (reuse or defer):** the discipline rules themselves (reuse `validateStoryAgainstDiscipline`, Story 3.5); the not-ready brake (reuse Story 9.1); the **Tier 1 panel judgment** of draft quality (Story 9.3 — this story enforces only the machine-checkable Tier 0); ordering/sequencing (Story 9.5). The author produces a *draft*; whether it is *good enough to bless* is the judge panel's call, not this seam's.

### Wire existing machinery (do not reinvent)

The reusability map is near-total — only the operator surface and one guard are new:
- **Validate:** `validatePlannerBacklog` / `validateStoryAgainstDiscipline` (the Story 3.5 authoring-time gate) already checks integration-AC presence for state-mutating stories and implicit `depends_on`. Reuse it verbatim as Tier 0.
- **Write:** `writeNativeStory` already generates the ULID, renders the four-section body, round-trips through `parseNativeStory`, and writes atomically. The only change: make it **call the discipline validator and refuse (typed error) before writing** — the deterministic gate (see below).
- **Materialise:** `scanSources` already turns native stories into to-do manifests with `ready: false` hard-written (Story 9.1). Reuse — the skill may invoke the scan or leave it to an explicit `/crew:scan`.
- **Brake:** the `ready: false` default and the claim filter are Story 9.1's; this story only relies on them.

### The deterministic-seam hardening (the one real code change)

The planner relies on its subagent's behavioural contract ("MUST call `validatePlannerBacklog` before every `writeNativeStory`") — a prose mandate, exactly the pattern that drifts under load. This story moves the gate into the tool layer:

- Inside `writeNativeStory`, before the atomic write, run `validateStoryAgainstDiscipline` on the candidate; on violation, throw a typed `DisciplineViolationError` carrying the violation codes and write nothing.
- This is additive and fail-closed: a passing story writes exactly as before; a violating story can no longer be written, whether the caller validated first or not. The subagent's pre-write validate call becomes a UX nicety (early, friendly refusal), not the thing the guarantee rests on.
- Keep the heuristic conservative (false-positives on "state-mutating" are acceptable; false-negatives are not) — mirror `isStateMutatingByHeuristic`.

### The author subagent (lean, not the planner)

- New catalogue prompt `catalogue/author.md`: input is one operator feature description; output is one draft story authored via `writeNativeStory`. No four-step elicitation, no whole-backlog review. `allowed_tools`: the validate + write tools + `readBacklogInventory` (for de-dup awareness) + `heartbeat`.
- Instruct it to **write the integration-AC spine first** (the rubric's granularity floor and Verifiability lens) and to default to a single observable outcome (the rubric's ceiling). On a `DisciplineViolationError`, surface the codes to the operator and offer a revised framing.
- Locked handoff phrase mirroring the planner's (e.g. `"Handoff — draft <ref> authored, not-ready, awaiting judgment"`).

### Files touched

**NEW:**
- `plugins/crew/skills/author/SKILL.md` — the operator seam (AC4).
- `plugins/crew/catalogue/author.md` — the lean author subagent prompt (AC5).
- `plugins/crew/mcp-server/src/tools/__tests__/author-seam.test.ts` — AC2, AC3, AC6.

**UPDATE:**
- `plugins/crew/mcp-server/src/tools/write-native-story.ts` — add the fail-closed discipline check before write (AC1); emit the draft-authored telemetry event (AC6).
- `plugins/crew/mcp-server/src/schemas/telemetry-events.ts` — add the draft-authored event variant additively (AC6).
- `plugins/crew/mcp-server/src/errors.ts` — add the typed `DisciplineViolationError` (extend `DomainError`).
- `plugins/crew/mcp-server/src/tools/__tests__/write-native-story.test.ts` — AC1.

### Existing seams to wire into (do not reinvent)

- **Discipline validator:** `validateStoryAgainstDiscipline` + `isStateMutatingByHeuristic` in `plugins/crew/mcp-server/src/validators/planning-discipline.ts`; the tool wrapper `validatePlannerBacklog`.
- **Write path:** `writeNativeStory` in `plugins/crew/mcp-server/src/tools/write-native-story.ts` (ULID, render, `parseNativeStory` round-trip, atomic write).
- **Scan + not-ready default:** `scanSources` `composeManifest` writes `ready: false` (Story 9.1).
- **Skill + subagent shape:** mirror `plugins/crew/skills/plan/SKILL.md` (native branch: spawn subagent from `readCatalogue`) and `plugins/crew/catalogue/planner.md` (behavioural contract, locked handoff).
- **Telemetry + errors:** the discriminated event union + `logTelemetryEvent`; the `DomainError` envelope and tool registration in `tools/register.ts`.

### Edge cases worth surfacing in dev/review

- **A direct write must still be gated.** The whole point of the hardening is that the guarantee does not rest on the subagent. AC1 tests the tool directly, not through the subagent.
- **Refuse-and-revise, not half-write.** A violating candidate writes nothing — no partial native-story file, no manifest. The operator gets the codes and retries.
- **Not-ready is the default, always.** A drafted feature is never auto-`ready`; it must pass the judge panel (9.3) and a blessing before the drain can claim it. A reviewer might ask "why can't I build the thing I just authored?" — because it has not been judged; that is the gate working.
- **De-dup awareness.** The author reads the backlog inventory so it does not author a near-duplicate of an existing story; this is best-effort, not a hard gate.

### Risk + build notes

- **Medium** risk: it changes the write path (adds a fail-closed gate). Additive and fail-closed, but it touches authoring — expect the auto-merge gate to pause for a human merge. Rebuild and commit `dist/` in the same change; full `pnpm build` + `pnpm test` green before the PR.
- Do not write or edit any state/manifest file directly — authoring goes through `writeNativeStory`; materialisation through `scanSources`.

### References

- Epic 9 framing + the author-seam slice: the Epic 9 epic file and the design note `_bmad-output/planning-artifacts/design-note-2026-05-31-native-planning-and-judging.md`.
- The rubric (the author's target; Tier 0 enforced here, Tier 1 in 9.3): `_bmad-output/planning-artifacts/rubric-story-quality-2026-05-31.md`.
- Authoring-time discipline (Story 3.5): the planning-discipline validator and `validatePlannerBacklog`.
- Story 9.1 (the not-ready brake this builds on): `_bmad-output/implementation-artifacts/9-1-readiness-brake-and-minimal-intake-cockpit.md`.
- Deterministic-seam discipline (move the load-bearing decision out of subagent prose into the tool): the project's standing principle — the reason the gate moves into `writeNativeStory`.
