# Epic 10: Native Re-foundation — Promote the Native Format to Primary

**Goal:** Make the native story format the primary substrate and close the one gap that matters: today the native *schema* is thinner than the *rubric* grades, so four of the six Tier-0 checks can't be machine-enforced (per-AC verification marker, task→AC mapping, cited sources). This epic makes every rubric-graded property a **structured field**, finishes Tier-0 in code (fail-closed at write + scan), builds a one-off BMad→native ingest, cuts over to native-primary (BMad ingest-only), and **proves** the pipeline end-to-end on a real feature. The keystone: **the strict schema *is* the grading sheet** — "a string appears in a file" passing as verification becomes structurally unrepresentable. This is not a rewrite — the native format, its parser/writer, and the entire two-gate cockpit (`flow:author` → `flow:judge` → Quality Lead → `flow:board`) already run on the native adapter (Epic 9); this epic promotes it and closes the specific gaps.

> **Source of truth:** `_bmad-output/planning-artifacts/native-refoundation-plan-2026-05-31.md` (the code-grounded gap analysis and re-foundation plan). Extends `design-note-2026-05-31-native-planning-and-judging.md` (two-gate architecture, Quality Lead) and `rubric-story-quality-2026-05-31.md` (the canonical grading artifact — Tier 0 deterministic veto + Tier 1 panel lenses). Reuses the Epic 2 team/persona layer, the Epic 3 adapter/manifest/scan layer, and the Epic 6 standards/rubric surface; promotes the native adapter shipped in Epic 9 to primary.
>
> **Ratified design decisions (Jack, 2026-05-31 — plan §8):** (1) Enriched schema: each AC gains `verification {type: vitest|artifact, target}`; the format gains `tasks[]` (each `{text, ac_refs[]}`), `cited_sources[]`, `risk_tier` (from `classifyRiskTier`), and a **structured** `narrative {role, want, so_that}`. (2) The "Considered" lens keys off the existing `classifyRiskTier` (no new classifier); rubric §3.5 bars as written; pre-mortem on highest-risk stories is Quality-Lead discretion (not auto-triggered). (3) K = 2 judge-panel rounds before a split/close call escalates to the operator. (4) Every story is its own ship gate (integration AC + full-suite-green DoD); no terminal ship-gate story. (5) Quality Lead and build-side reviewer **harmonize** — both gates draw from one evolving standards registry.
>
> **The enriched native AC/story shape (the §3 target the authoring must hit):**
> ```
> narrative: { role, want, so_that }            # structured (T0-1)
> acceptance_criteria[]:
>   - id: AC1                                    # AC1, AC2, …
>     kind: integration | unit
>     statement: "Given … when … then …"
>     verification: { type: vitest|artifact, target: <resolvable path> }   # T0-2/T0-6
> tasks[]: { text, ac_refs: [AC1, …] }           # every task maps to ≥1 AC (T0-1)
> cited_sources[]: [<repo-relative path the author read>]                  # T0-5
> depends_on[]                                    # explicit cross-story deps (T0-4) — exists
> risk_tier: low|medium|high                      # carried from classifyRiskTier
> ```
> With these fields present, Tier-0 becomes a pure function of the schema/validator.
>
> **These story blocks are intentionally thin stubs** (title + one-line scope only). Per the never-hand-write rule, `bmad-create-story` authors each full spec (user-story + acceptance criteria) into the implementation-artifact. Do **not** hand-author ACs here.
>
> **Sequencing:** 10.1 (the spine — per-AC `verification` field) → 10.2 (the rest of the schema: tasks/cited_sources/structured narrative) → 10.3 (complete Tier-0 in the validator) → 10.4 (plumb `risk_tier` into the draft) → 10.5 (BMad→native ingest) → 10.6 (cutover) → 10.7 (prove). 10.1–10.4 are the bounded, high-leverage schema+Tier-0 batch; 10.5–10.6 are the migration; 10.7 is the validation gate — the arc is not "real" until it passes.
>
> **⚠️ Build-order constraint:** 10.3 touches the discipline-validator / standards surface, which the Epic 6 calibration drain (6.5–6.8) also touches. Do **not** build 10.3 (or any story mutating that surface) while the calibration drain is live — author the specs now, build after Track A lands. The other stories are independent of that surface.
>
> **Correct-course implications (plan §10, fold in at authoring):** retire Story 5.18 (structural parser — owning a strict generated format means nothing sloppy to parse); rescope Epic 7 (install-canary assumes BMad-shaped surfaces the pivot obsoletes); sequence Epic 6b (calibration engine 6.5–6.8 is independent and drains in parallel; the persona/team cluster waits behind cutover). Run as a `bmad-correct-course` pass.

---

## Story 10.1: Enrich the native AC with a structured `verification` block

Scope: add a per-AC `verification: { type: vitest|artifact, target: <path> }` field to the native story format — the `AC` type, `parse-native-story.ts`, `write-native-story.ts` (`writeNativeStory`), the execution-manifest schema, and the BMad parser's `SourceStory` output — fail-closed (a draft whose AC lacks a `verification` block cannot be written). This is the per-AC marker that turns rubric T0-2/T0-6 into a schema check, and the spine the rest of the epic hangs off. *Observable spine: writing a native story whose AC lacks a `verification` block is rejected at write time with the AC named; a well-formed story round-trips parse→write with the `verification` field intact.* (Slice 1.)

## Story 10.2: Add `tasks[] → ac_refs`, `cited_sources[]`, and a structured narrative

Scope: extend the native story format with `tasks[]` (each `{ text, ac_refs: string[] }`), `cited_sources[]: string[]`, and a structured `narrative { role, want, so_that }` — schema + parser + writer + execution-manifest. Builds on 10.1's enriched-format work. *Observable spine: a native story with a task whose `ac_refs` names a non-existent AC id fails to write (the bad ref named); a valid story round-trips with tasks, cited_sources, and the structured narrative intact.* (Slice 2. Depends on 10.1.)

## Story 10.3: Complete Tier-0 in the discipline validator (fail-closed at write + scan)

Scope: with 10.1/10.2's fields present, add the four missing deterministic Tier-0 checks to the discipline validator — T0-1 (every `tasks[].ac_refs` resolves to a real AC id), T0-2 (every AC carries a `verification` block), T0-5 (`cited_sources` non-empty and each path resolves), T0-6 (each `verification.target` resolves: the `vitest:` file exists / the `artifact:` path is real; reject invented flags) — enforced fail-closed at both `writeNativeStory` and `/flow:scan`. The existing three checks (integration-AC, implicit-deps, ship-gate) stay. *Observable spine: a native story citing a non-existent source path (or a verification target that doesn't resolve) is rejected by the validator at scan time, naming the specific failed check id; a clean story passes.* **⚠️ Build only after the Epic 6 calibration drain (6.5–6.8) lands — shared discipline-validator surface.** (Slice 3. Depends on 10.1, 10.2.)

## Story 10.4: Plumb `risk_tier` into the native draft

Scope: carry `risk_tier` from the existing `classifyRiskTier` into the native story draft at author time, so the "Considered" lens grades at the right risk-tiered bar during authoring/judging rather than only post-review. *Observable spine: an authored native story carries a `risk_tier` field derived from `classifyRiskTier`, and the judge panel's Considered lens reads it to select the low/medium/high bar instead of defaulting.* (Slice 4. Depends on 10.1.)

## Story 10.5: BMad → native ingest seam (one-off, one-way)

Scope: a one-off, LLM-assisted, reviewed migration — `parseBmadStory` → `SourceStory` → LLM enriches to the §3 shape (infer per-AC verification, tasks, cited_sources from the prose) → discipline gate → `writeNativeStory`. One-way, never a live sync (LLM transforms are lossy — fine for seeding, fatal as a dependency). Runs over the live `bmad:*` backlog once to seed `.flow/native-stories/`; stories that can't be enriched to clear Tier-0 surface for human fix-up, not silent drop. *Observable spine: running the ingest over a BMad story produces a native story that clears Tier-0, OR surfaces it in a fix-up list with the failed checks named — never silently dropped.* (Slice 5. Depends on 10.1–10.3.)

## Story 10.6: Cutover — native-primary, BMad ingest-only

Scope: flip the repo's active adapter to `native`; BMad becomes ingest-only (the parser stays as an on-ramp; the live backlog is now native); regenerate `flow:board` from native state; confirm the drain claims native `ready` stories. Reversible up to the flip (both adapters coexist; native is additive until then). *Observable spine: after the flip, `flow:board` renders from native state and the drain claims a blessed native `ready` story end-to-end; the BMad authoring surface is no longer the live path.* (Slice 6. Depends on 10.5.)

## Story 10.7: Prove the pipeline end-to-end

Scope: run a real low-risk feature through the full cockpit — `flow:author` → `flow:judge` (five lenses) → Quality Lead → `ready` → drain → merge — and confirm the output clears the rubric a human would apply, with a human spot-check of the judge verdicts against the rubric. A validation story, not a code story; the residual risk of the whole arc lives here. *Observable spine: a real feature authored natively passes the five-lens panel + Quality Lead, is blessed `ready`, claimed by the drain, and merges green — and the human spot-check confirms the judge verdicts match the rubric.* (Slice 7. Depends on 10.6.)
