# Native Re-foundation — Plan & Gap Analysis (2026-05-31)

**Status:** Design draft (Claude, 2026-05-31) for Jack (PM) to ratify. Follows the cockpit (Epic 9) reaching done. Extends `design-note-2026-05-31-native-planning-and-judging.md` and `rubric-story-quality-2026-05-31.md` with a code-grounded gap analysis and a concrete re-foundation plan.

**One-line:** The native re-foundation is **mostly already built** — the native format, its parser/writer, and the entire two-gate cockpit all run on the native adapter today. The real remaining work is **narrow and specific**: make the native *schema* actually carry everything the *rubric* grades, finish Tier-0 in code, build the one-off BMad→native ingest, cut over, and **prove** the pipeline produces stories that meet the bar.

---

## 1. The reframe (what the code grounding changed)

The design note framed the native path as "scaffolded but unproven" and the re-foundation as a large future epic. A read of the actual code says it's further along than that — and the remaining gap is sharper than "build a native format":

**Already built and wired (on the `native` adapter, not BMad):**
- A native story format + parser (`parse-native-story.ts`) + writer (`writeNativeStory`) that **fails closed**: a draft that doesn't parse cannot be written.
- The execution-manifest schema (23 fields) that every story becomes — the machine representation the drain consumes.
- The **whole cockpit**: `flow:author` (drafts a native story), `flow:judge` (five-lens panel writing file-based verdicts), the **Quality Lead** (`adjudicateQualityLead` → `ready | rework | escalate`, blesses only via the 9.1 readiness brake), and `flow:board` (backlog view generated from live state).
- `classifyRiskTier` (the "Considered" lens's tiered bar) and the readiness brake (`markStoryReady` + the claim filter).

**So the re-foundation is "promote native to primary + close the specific gaps," not a rewrite.** Below are the gaps, in priority order.

---

## 2. The core gap: the schema is thinner than the rubric

The design note's keystone idea is **"the native format and the rubric are the same artifact — the strict schema *is* the grading sheet."** Today that identity does **not** hold. The native format is too thin to carry what the rubric grades:

| Rubric Tier-0 demand | Carried as a structured field today? |
|---|---|
| T0-1 Required sections + **every task mapped to an AC** | Title/Narrative/ACs yes; **tasks → AC mapping: NO** (no tasks field) |
| T0-2 Every AC carries a **verification marker** (`vitest:`/`artifact:`) | **NO** — the AC is `{ text, kind }`; the marker (if present) is buried in free prose, not a field |
| T0-3 State-mutating story has ≥1 integration AC | Yes (validator coded) |
| T0-4 Cross-story deps explicit in `depends_on` | Yes |
| T0-5 Every technical claim **cites a source path** | **NO** — implementation_notes is free text; no structured `cited_sources` |
| T0-6 Every named check is **runnable** (path/file resolves) | **NO** — nothing to resolve, because the marker isn't a field |

Consequence: four of six Tier-0 checks can't be machine-enforced because the data they'd check isn't structured. The judge panel and Quality Lead are real, but they grade prose the format doesn't pin. **Closing this gap is the heart of the re-foundation** — it's what makes "schema = rubric" literally true and retires the class of bugs the move was meant to kill (verification-by-string-match, AC-marker drift).

---

## 3. Proposed enriched native schema

Make every rubric-graded property a **structured field**, so Tier-0 is a schema/validator check and the judges grade substance, not shape. Concretely, the native story (and `SourceStory`/manifest, which must carry it through to the drain) gains:

- **`narrative`** → keep, but encourage `{ role, want, so_that }` shape for T0-1 checkability.
- **`acceptance_criteria[]`** → each AC becomes:
  - `id` (`AC1`, `AC2`, …)
  - `kind`: `integration | unit` *(exists)*
  - `statement`: the Given/When/Then behaviour *(exists, as `text`)*
  - **`verification`: `{ type: "vitest" | "artifact", target: string }`** *(NEW — T0-2/T0-6: a real, resolvable check per AC)*
- **`tasks[]`**: each `{ text, ac_refs: string[] }` *(NEW — T0-1: every task maps to ≥1 AC)*
- **`cited_sources[]`: `string[]`** (repo-relative paths the author read) *(NEW — T0-5)*
- **`depends_on[]`** *(exists — T0-4)*
- **`risk_tier`** carried from `classifyRiskTier` so the "Considered" lens applies the right bar *(plumb into the draft, not just post-review)*

With these fields present, **Tier-0 becomes a pure function of the schema**: markers exist (T0-2), targets resolve (T0-6), tasks map (T0-1), sources cited and resolvable (T0-5), ≥1 integration AC (T0-3), deps explicit (T0-4). The bug class the whole move targets — "a string appears in a file" passing as verification — becomes structurally unrepresentable.

> This is a change to the *current* thin native format: `parse-native-story.ts`, `write-native-story.ts`, the `SourceStory`/`AC` types, the execution-manifest schema, and the BMad parser's `SourceStory` output all gain these fields. It is the bulk of the re-foundation's real code work — and it is **bounded and concrete**, not open-ended.

---

## 4. Tier-0 completion in code

The discipline validator codes 3 of the 6 Tier-0 checks today (integration-AC, implicit-deps, ship-gate). With §3's fields in place, add the missing deterministic checks, **fail-closed at write (`writeNativeStory`) and scan (`/flow:scan`)**:

- **T0-2:** every AC has a `verification` block.
- **T0-6:** each `verification.target` resolves — the `vitest:` file exists / the `artifact:` path is real; reject invented flags.
- **T0-5:** `cited_sources` non-empty and each path resolves.
- **T0-1:** every `tasks[].ac_refs` resolves to a real AC id.

These are cheap, deterministic, and they're the "cheap filter that stops the panel wasting cycles" the rubric §1 describes.

---

## 5. BMad → native ingest seam (one-off, one-way)

Build the migration the design note names: a one-off, LLM-assisted transform, reusing the existing BMad parser as the front door.

- **Path:** `parseBmadStory` → `SourceStory` → (LLM enriches to the §3 shape: infer per-AC verification, tasks, cited sources from the prose) → discipline gate → `writeNativeStory`.
- **One-way, reviewed, never a live sync** (LLM transforms are lossy — fine for seeding, fatal as a dependency).
- Runs over the live `bmad:*` backlog once to seed `.flow/native-stories/`. Stories that can't be enriched to clear Tier-0 surface for human fix-up, not silent drop.

---

## 6. Cutover plan

1. Ship §3 (enriched schema) + §4 (Tier-0 completion) behind the existing native adapter — no behaviour change for live BMad work yet.
2. Run §5 ingest over the live backlog into `.flow/native-stories/`; reconcile/triage anything that won't clear Tier-0.
3. Flip the repo's active adapter to `native`; BMad becomes **ingest-only** (the parser stays as an on-ramp; the live backlog is now native).
4. Regenerate `flow:board` from native state; confirm the drain claims native `ready` stories.
5. Retire the BMad-substrate scaffolding that the move obsoletes (see §9).

Cutover is reversible up to step 3 (both adapters coexist; native is additive until the flip).

---

## 7. Proving the pipeline (the real risk)

The design note's honest caveat: the native path is "unproven at the authoring-quality bar." The machinery exists; whether it *produces good stories* is untested. The re-foundation isn't done until we've **run a real feature end-to-end through the cockpit** — `flow:author` → `flow:judge` (five lenses) → Quality Lead → `ready` → drain → merge — and confirmed the output clears the rubric a human would apply. This is a validation story, not a code story, and it's where the residual risk actually sits. Do it on a low-risk real feature, with a human spot-check of the judge verdicts against the rubric.

---

## 8. Open decisions for Jack (only you can set these)

These gate the design; none is a code question:

1. **The enriched-schema fields (§3).** Ratify the per-AC `verification`, `tasks[]`, and `cited_sources[]` additions — or adjust. This is the one big "shape" call.
2. **The "Considered" bar.** The rubric's softest, most valuable lens (risk-tiered cold-dev sufficiency) is your taste to set. Confirm it keys off `classifyRiskTier` (recommended — it already exists) and pin the low/medium/high bars.
3. **K — escalation rounds.** How many panel rounds before a close call escalates to you? (Rubric proposes 2.)
4. **Ship-gate equivalent.** Confirm the "every story is its own ship gate" interpretation (each story's integration AC + full-suite-green DoD) replaces a terminal ship-gate story in continuous flow.
5. **Quality Lead vs build-side reviewer.** Harmonize (shared accumulated standards) or keep separate. Deferrable, but it shapes Epic 6b sequencing.

---

## 9. Proposed epic skeleton (stories — authored after §8 is ratified)

A native-refoundation epic, lean-small per the rubric, in dependency order:

- **N.1 — Enrich the native AC with a structured `verification` block** (schema + parser + writer + manifest; the per-AC marker). *Spine of the whole epic.*
- **N.2 — Add `tasks[] → ac_refs` and `cited_sources[]` to the native format** (schema + parser + writer + manifest).
- **N.3 — Complete Tier-0 in the discipline validator** (T0-1/T0-2/T0-5/T0-6, fail-closed at write + scan).
- **N.4 — Plumb `risk_tier` into the draft** so the Considered lens grades at author time, not just post-review.
- **N.5 — BMad → native ingest seam** (one-off enrich-and-write migration; live-backlog import).
- **N.6 — Cutover** (flip active adapter to native; BMad ingest-only; board regenerated from native).
- **N.7 — Prove the pipeline end-to-end** (validation story: a real feature through author→judge→QL→ready→drain→merge, with a human rubric spot-check).

(Authored via `bmad-create-story` / the established Explore-then-write method, never hand-written, once §8 is settled.)

---

## 10. Correct-course implications (the pass the design note flagged is now due)

- **5.18 (structural parser) → retire.** It only ever existed to tolerate BMad's human sloppiness; owning a strict, *generated* format means there's nothing sloppy to parse. Confirmed by the design note.
- **Epic 7 (install-canary) → rescope.** 7.1 assumes a "BMad-shaped example repo"; 7.2/7.4b/7.5 reference retired surfaces. The native pivot shifts these further — rescope before authoring.
- **Epic 6b sequencing.** The Quality Lead is the home for the rubric the calibration loop evolves, so 6b and the judging work are entangled (design note §8). The calibration engine (6.5–6.8, ready-for-dev) is independent and can drain in parallel; the persona/team cluster (6.9–6.14) can wait behind the cutover.
- Run this as a `bmad-correct-course` pass when N.x authoring begins.

---

## 11. Recommended sequence

1. **Jack ratifies §8** (especially the §3 schema fields and the "Considered" bar) — the unblock.
2. **Author N.1–N.4** (the schema enrichment + Tier-0) — bounded, high-leverage code; drains like any other batch.
3. **N.5 ingest + N.6 cutover** — the migration.
4. **N.7 prove** — the validation gate; only after this is the re-foundation "real."
5. **Correct-course (§10)** folded in at N.x authoring.

The calibration drain (6.5–6.8) runs in parallel throughout — it's independent of the native pivot.
