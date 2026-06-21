# Story 9.3: Judge panel — rubric grading

story_shape: substrate
Status: ready-for-dev

## Story

As a **plugin operator**,
I want **a diverse-lens judge panel to grade a drafted story against the rubric and emit a machine-checkable per-criterion verdict**,
So that **thin or unverifiable drafts are caught before they can be blessed, and the verdict is data the Quality Lead (or I) can act on — not prose to interpret**.

This is the **Tier 1** half of gate 1. Story 9.2 produces a Tier-0-clean draft; this story runs the panel that judges its *quality*. The panel spawns one judge per rubric Tier-1 lens — **Structure, Verifiability, Discipline, Domain, Considered** — each from a **different role**, because a panel that shares the author's blind spots rubber-stamps (that scar is documented and is the whole reason lens diversity is non-negotiable). Each judge emits a per-lens verdict `{lens, pass, missed}` captured to a **file**, reusing the deterministic verdict-capture pattern the reviewer already uses (`reviewer-result.json`) — the panel reads files, never transcripts. The **Considered** lens bar scales with the draft's risk tier (reuse the existing classifier).

The panel does **not** decide `ready`. It produces the verdict set; Story 9.4 (the Quality Lead) adjudicates it. Keeping grading and adjudication separate is deliberate: the panel is many narrow lenses, the Lead is one synthesiser.

## Dependencies

- **Consumes Story 9.2's drafts** and the merged **rubric** (`rubric-story-quality-2026-05-31.md`) — the lenses and their scoreable checks come straight from it.
- **Reuses the reviewer's verdict-capture seam** (`runReviewerSession` writes a deterministic result file; `readReviewerResultFile` reads it) and the **risk classifier** (`classifyRiskTier`) for the Considered bar.
- **Reuses the persona spawn machinery** (`buildPersonaSpawnPrompt`) to spawn each lens judge from its role.
- **Feeds Story 9.4** — the Quality Lead reads this panel verdict to decide ready/escalate/rework.

## Acceptance Criteria

**AC1 — each lens judge emits a machine-checkable verdict to a file, not prose (integration):**

A single lens judge grades a draft against its assigned rubric lens and writes a verdict `{lens, pass, missed}` to a deterministic result file (the same per-session result-file layout the reviewer uses); a reader returns the parsed verdict. The panel consumes the file, never the judge's transcript. A vitest drives one injected judge, asserts a well-formed verdict file is written with the lens, the boolean, and a non-empty `missed` string on a fail, and asserts the reader round-trips it.
vitest: plugins/crew/mcp-server/src/tools/__tests__/judge-panel.test.ts

**AC2 — the panel runs the full set of diverse lenses, one role per lens (integration):**

The panel spawns one judge per Tier-1 lens (structure, verifiability, discipline, domain, considered), each from a distinct role, and collects all lens verdicts into a single panel verdict keyed by lens. No lens is skipped; no two lenses share one judge. A vitest runs the panel with injected judges over a draft and asserts all five lens verdicts are present, each keyed to its lens and tagged with a distinct judging role.
vitest: plugins/crew/mcp-server/src/tools/__tests__/judge-panel.test.ts

**AC3 — a draft that fails a lens is recorded as failing, with the specific miss (integration):**

A draft whose acceptance criterion only asserts that a string appears in a file fails the Verifiability lens, and the panel verdict records that lens as failed with a `missed` string naming the gap (asserts presence, not behaviour). A passing draft records that lens as passed. A vitest feeds a string-presence-only draft and asserts the verifiability lens verdict is fail with a populated `missed`, and feeds a behaviour-asserting draft and asserts it passes.
vitest: plugins/crew/mcp-server/src/tools/__tests__/judge-panel.test.ts

**AC4 — the Considered-lens bar scales with the draft's risk tier (integration):**

The panel classifies the draft's risk tier through the existing classifier and applies the rubric's tiered Considered bar: a low-risk draft passes on "names what could break + pins the top failure"; a higher-risk draft that lacks cold-dev sufficiency (an open question with no defaulted answer) fails the Considered lens. A vitest drives a high-tier draft with an unresolved open decision (asserts Considered fails) and a low-tier draft meeting the lighter bar (asserts Considered passes).
vitest: plugins/crew/mcp-server/src/tools/__tests__/judge-panel.test.ts

**AC5 — the panel emits a schema-shaped verdict and does not decide ready (integration):**

The panel produces a verdict object — Tier-0 status plus the five lens verdicts — validated against a schema, and writes nothing to the readiness flag (that is Story 9.4's call). A vitest runs the panel and asserts the returned verdict validates against the schema, carries exactly the five lens entries, and that no manifest readiness field was touched by the run.
vitest: plugins/crew/mcp-server/src/tools/__tests__/judge-panel.test.ts

**AC6 — a skill drives the panel over a named draft and surfaces the verdict (artifact):**

A skill runs the panel for a named draft and reports the per-lens verdict to the operator. Its frontmatter lists the panel tool in `allowed_tools`; its body never writes the readiness flag or a manifest directly. The file exists at the skill path and is shaped like the other crew skills.
artifact: plugins/crew/skills/judge/SKILL.md

## Definition of Done

- [ ] All six ACs met.
- [ ] `pnpm --dir plugins/crew/mcp-server test` green; the new test file covers every integration AC clause.
- [ ] `pnpm --dir plugins/crew/mcp-server build` green; `dist/` rebuilt and staged in the same commit.
- [ ] PR opens against `main`. CI green.
- [ ] Reviewer cycle clean — AC1–AC5 runnable vitest, AC6 file-presence.
- [ ] Lens diversity is enforced structurally (one role per lens), not by convention.
- [ ] The panel writes no readiness flag — grading and adjudication stay separate (9.4 owns the decision).

## Implementation Notes

### Scope discipline — what this story does and does NOT build

**Builds:** the panel orchestration (spawn one judge per lens), the per-lens verdict schema + its deterministic result file, the panel-verdict aggregation, the Considered-lens risk-tier coupling, and the `/crew:judge` skill.

**Does NOT build:** the adjudication / ready-or-escalate decision and the Quality Lead role (Story 9.4); the rubric itself (merged — reuse it); Tier 0 (Story 9.2 enforces it at authoring; the panel may re-assert Tier-0 status but does not re-implement the checks).

### Wire existing machinery (do not reinvent)

- **Verdict capture (the key reuse):** the reviewer already derives a verdict by a closed algorithm and persists it to a per-session result file via an atomic write, then reads it back through a typed reader. Mirror that exactly for each lens judge — a per-lens result file with `{lens, pass, missed}` — so the panel's decision rests on files, not narration (deterministic-seam discipline).
- **Risk tier:** the existing classifier returns `low | medium | high` with evidence. Feed it the draft's changed-paths/size signals and use its tier to select the Considered bar from the rubric.
- **Spawn judges:** the persona spawn-prompt builder assembles a role's system prompt; use it to spawn each lens judge from its role, appending the lens's scoreable checks (from the rubric) and a "return `{lens, pass, missed}` to your result file" instruction.
- **Agreement (optional, forward):** the existing agreement helper is the precedent for measuring judge-vs-outcome over time — the calibration loop (6b) will use it to judge-the-judge; this story need only emit the verdicts it will consume.

### The per-lens verdict (the deterministic seam)

- Define a `LensVerdict` schema: `{ lens: "structure"|"verifiability"|"discipline"|"domain"|"considered", role: string, pass: boolean, missed: string }` (`missed` non-empty on fail).
- Each judge writes its `LensVerdict` to a result file under the session dir (mirror the reviewer-result path helper). The panel reads the five files and assembles `PanelVerdict { tier0: "pass"|"fail", lenses: LensVerdict[] }`.
- The judge's *reasoning* is free; only the `{lens, pass, missed}` projection is load-bearing — exactly the reviewer's posture.

### Files touched

**NEW:**
- `plugins/crew/mcp-server/src/tools/judge-panel.ts` — the panel orchestration + aggregation.
- `plugins/crew/mcp-server/src/schemas/lens-verdict.ts` — `LensVerdict` + `PanelVerdict` schemas.
- `plugins/crew/mcp-server/src/tools/__tests__/judge-panel.test.ts` — AC1–AC5.
- `plugins/crew/skills/judge/SKILL.md` — the operator skill (AC6).

**UPDATE:**
- `plugins/crew/mcp-server/src/tools/register.ts` — register the panel tool with the `DomainError` envelope.
- `plugins/crew/mcp-server/src/schemas/telemetry-events.ts` — optionally add a `panel.graded` event (additive).

### Existing seams to wire into (do not reinvent)

- **Reviewer verdict file:** `runReviewerSession` (verdict derivation + atomic result-file write) and `readReviewerResultFile` / `reviewerResultFilePath` in `plugins/crew/mcp-server/src/lib/read-reviewer-result-file.ts` — the layout to mirror for per-lens files.
- **Risk classifier:** `classifyRiskTier` in `plugins/crew/mcp-server/src/tools/classify-risk-tier.ts`.
- **Spawn:** `buildPersonaSpawnPrompt` in `plugins/crew/mcp-server/src/tools/build-persona-spawn-prompt.ts`.
- **Rubric:** `_bmad-output/planning-artifacts/rubric-story-quality-2026-05-31.md` (the lens checks + tiered Considered bar).

### Edge cases worth surfacing in dev/review

- **A lens with no judge available.** If a role for a lens is not hired, the panel must fail loudly (the lens can't be graded), not silently drop the lens and report a clean sweep — a missing lens is the rubber-stamp failure in disguise.
- **`missed` must be populated on fail.** A fail with an empty `missed` is itself malformed — the operator/Lead needs the specific gap to act.
- **The panel never blesses.** A reviewer might expect the panel to mark the draft ready on a clean sweep; it must not — that decision is the Quality Lead's (9.4), who may still escalate a close call.

### Risk + build notes

- **Medium** risk: new multi-agent orchestration + schema, but additive and side-effect-light (writes verdict files, not state). Rebuild + commit `dist/`; full build + test green before PR.

### References

- Rubric (the grading sheet): `_bmad-output/planning-artifacts/rubric-story-quality-2026-05-31.md` (§3 lenses, §3.5 the risk-tiered Considered bar, §5 the verdict shape).
- Design note (judging mechanism, lens diversity): `_bmad-output/planning-artifacts/design-note-2026-05-31-native-planning-and-judging.md` §5.
- Reviewer verdict-capture precedent (the deterministic file seam this mirrors): `runReviewerSession` + `read-reviewer-result-file.ts`.
- The rubber-stamp scar (why lens diversity is structural): the generalist-reviewer rubber-stamp history.
