---
date: 2026-05-27 (post-canary steering session)
author: Jack (via steering interview) + Claude (drafting)
scope: **Major** — touches success criteria, Epic 6 shape, Epic 7 priority, and authorises a new top-priority Epic 5 substrate workstream
trigger: Steering handoff repositioning crew as a proof-point artifact rather than a market-bound product
supersedes: none — co-exists with sprint-change-proposal-2026-05-27.md (5.13) and sprint-change-proposal-2026-05-27-5-15.md (5.15)
status: **PROPOSED — awaiting sign-off before any artefact mutation**
---

# Sprint Change Proposal — Strategic Reframe + Parser Blocker

## 1. Issue Summary

The 2026-05-27 steering session redefined crew's success bar. crew is **no longer being assessed as a monetisable product**; it is a **proof-point/portfolio artifact** to anchor Jack's career-transition narrative. This invalidates the current PRD success criterion (which is built around an external stranger installing cold) and re-orders the epic sequence.

In parallel, the first dogfood canary surfaced a substrate blocker: **`/flow:start` hangs before writing any code due to story-file parsing brittleness**. This is the proximate gate on the new ship goal (crew building itself) and outranks all other Epic 5 leftover work.

## 2. Impact Analysis

### Artefact impact

| Artefact | Impact |
|---|---|
| `prd-crew-v1/success-criteria.md` | **Rewrite** "single test of success" — self-bootstrap is the proximate gate; external-stranger install becomes a later/stretch gate. Recalibrate measurable outcomes table. |
| `prd-crew-v1/executive-summary.md` | **Light edit** — soften "replace the product engineering team" framing toward "demonstrate the scaffolding pattern." Keep the six pillars; they survive the reframe. |
| `prd-crew-v1/user-personas.md` | **Light edit** — Maya remains the *eventual* target user; Jack-as-operator is the v1 user. De-emphasise Maya as the v1 gate. |
| `epics/epic-list.md` | **Re-sequence** — Epic 5 substrate (parser) jumps the queue; Epic 6 splits into 6a/6b; Epic 7 deferred past self-bootstrap. |
| `epics/epic-5-...md` | **Append** Story 5.14 (parser POC) + Story 5.18 (structural-parser refactor, protected backlog with trigger). Also stub 5.13b (scan-sources to-do drift-check) and 5.16 (picomatch dep). |
| `epics/epic-6-...md` | **Split scope marker** — Epic 6a = retro emits typed proposals (Stories 6.1–6.3); Epic 6b = proposals mutate standards/skills/team (Stories 6.4–6.13). 6b deferred past self-bootstrap; must have an authored migration path, not be dropped. |
| `epics/epic-7-...md` | **Status note** — Epic 7 deferred. "External-stranger install" is the writeup-supporting gate, not the ship gate. |
| `sprint-status.yaml` | **Backlog inserts** for 5.13b, 5.14, 5.16, 5.18. No status flips on existing rows. |
| Architecture | **No change.** Parser refactor (5.18) is an internal substrate change that fits existing patterns; if 5.18 ends up large enough to warrant an ADR, author at that time. |

### Technical impact

- 5.14 (parser POC) is small: tighten the planner output template until the current scan/validation layer accepts it consistently. Crew controls both sides of the contract in POC, drift is containable.
- 5.18 (structural parser) is a meaningful refactor: AST-style markdown parsing, extract semantic fields tolerantly. Sized at spec-author time, not now.
- 5.13b is small: closes the to-do-branch drift-check gap surfaced in PR #159 retro.
- 5.16 (picomatch) is trivial: missing transitive dep on fresh clone.

### Dogfood resumption

Dogfood was unblocked 2026-05-27 (memory `project_dogfood_paused_until_l1`). The parser blocker does not re-block dogfood policy — it just means autonomous `/flow:start` will currently fail-fast on the planner→scan handoff. Manual `/ship-story` continues to work for substrate.

## 3. Recommended Approach

**Phased application.** This proposal is Major scope but mechanically additive — no story rows are deleted or re-numbered. Apply in three independently-revertable phases:

### Phase A — Authorise investigation (no artefact writes)
Resolve the two open unknowns from the handoff before authoring any 5.14 spec:
- Where the drift originates — pinned planner template vs LLM generation step.
- Which exact parser is choking — scan-layer (`scanSources` / `listClaimableTodos`) vs handoff/verdict parser.
Output: a short diagnosis note in `_bmad-output/postmortems/2026-05-27-parser-brittleness-diagnosis.md` (precedent: existing `2026-05-25-dogfood-rollback.md`).

### Phase B — Stub the new stories
Once Phase A diagnosis lands, stub 5.13b / 5.14 / 5.16 / 5.18 in epic-5 + sprint-status. Spec authoring happens inside `/ship-story <id>` Step 4 via `/bmad-create-story` (memory `feedback_never_handwrite_stories`).

Ship order under Phase B:
1. **5.14** — parser POC clamp. Unblocks self-bootstrap canary.
2. **5.16** — picomatch dep. Trivial; pair-ship or hot-fix.
3. **5.13b** — scan-sources to-do drift-check. Closes #159 retro debt.
4. **Self-bootstrap canary attempt** — one clean autonomous `/flow:start`. If it works, the proximate ship gate is met.
5. **5.18** — structural parser. Protected by an explicit trigger condition in the story body: *"author before any external-planner integration or before merging any change that adds a non-BMad adapter input shape."*

### Phase C — Rewrite the PRD success criterion + Epic 6 split
This is the load-bearing PRD edit. Do it **after** Phase B's self-bootstrap canary attempt so the success-criteria rewrite is grounded in observed behaviour, not speculation. Touch:
- `success-criteria.md` (rewrite single-test-of-success + measurable outcomes)
- `executive-summary.md` (soften framing)
- `user-personas.md` (de-emphasise Maya as v1 gate)
- `epic-list.md` (re-sequence; split Epic 6 marker)
- Epic 6/7 files (status notes only; no story deletions)

Drive this phase via `/bmad-correct-course` to keep the PRD-edit discipline intact; do not hand-edit.

### What's explicitly *not* changing

- **Epic 6 is not dropped** — only phased. 6a (retro emits proposals) must ship before declaring v1 done; 6b (mutations) must have an authored path.
- **No story renumbering.** All existing IDs stay; new stories take the next available slots.
- **Carried debt items already memorised stay deferred** — the Epic 4 AC-marker retrofit (memory `feedback_reviewer_contract_carried_debt`) and the reviewer-contract change remain at the Epic 6→7 boundary.

## 4. Detailed Change Proposals (Phase B stubs — not yet applied)

### 4.1 Epic 5 file — appended story blocks (proposed wording, to be authored by `/bmad-create-story`)

- **5.13b — `scanSources` to-do-branch drift-check.** Closes PR #159 retro debt; small substrate.
- **5.14 — Planner output template clamp for parser POC.** Tighten template until scan layer accepts consistently. Carries explicit "temporary scaffolding" note linking forward to 5.18.
- **5.16 — `picomatch` missing transitive dep on fresh clone.** Trivial; ship paired or hot-fix.
- **5.18 — Structural / AST-style story parser.** Protected backlog. Story body MUST carry the trigger condition (`"author before any external-planner integration..."`) so the refactor can't quietly become permanent debt.

### 4.2 sprint-status.yaml inserts

```yaml
5-13b-scan-sources-to-do-drift-check: backlog
5-14-planner-template-clamp-parser-poc: backlog
5-16-picomatch-missing-fresh-clone-dep: backlog
5-18-structural-story-parser: backlog
```
(5.14 number is free — the prior 5.15 proposal noted 5.14 was "deliberately skipped — no pre-existing claim." We now claim it.)

### 4.3 Epic 6 split marker (Phase C — proposed wording)

Insert a "Phasing" subsection near the top of epic-6:

> **Phasing (added 2026-05-27 reframe):** Epic 6 ships in two tranches.
> - **6a (proximate):** Stories 6.1–6.3 — retro runs, captures structured lessons, emits typed proposal markdown.
> - **6b (after self-bootstrap proven):** Stories 6.4–6.13 — proposals mutate `docs/standards.md`, skills, personas, and team composition via the diff-then-confirm gate.
>
> 6b cannot be dropped; 6a's emitted proposals are inert without it. The phasing exists to defer the standards-evolution complexity until self-bootstrap is demonstrably stable.

### 4.4 Epic 7 status note (Phase C — proposed wording)

Insert near the top of epic-7:

> **Status (2026-05-27 reframe):** Epic 7 is deferred past the self-bootstrap ship gate. Its canonical scenario ("external stranger installs cold and reaches first merged PR in <1hr") is the writeup-supporting gate, not the v1 ship gate. The bundled example + canary suite still ships, but timing follows 6b, not 6a.

## 5. Open Decisions for Jack

Before any of this lands, one PM call:

**Q1 — Phase ordering.** Phases B and C are independent. Two coherent orderings:
- (a) **B then C** (recommended): fix the substrate, run the canary, then rewrite the success criterion grounded in what actually happened. Lower risk of PRD churn.
- (b) **C then B**: rewrite the PRD first so the reframe is on the record before any more code lands. Cleaner artefact narrative for the eventual writeup, but commits to a success criterion the canary might force us to revise.

**Q2 — Epic 6 phasing language.** Either:
- (a) **In-place phasing marker** (recommended above): one subsection inside epic-6, no file split.
- (b) **Split into epic-6a / epic-6b files**: cleaner separation but disrupts existing story numbering references.

**Q3 — 5.18's protection mechanism.** The handoff calls for "an explicit backlog item with a clear trigger." Two options:
- (a) **Trigger condition in story body** (recommended): natural-language "MUST author before X" gate; relies on Claude reading the spec.
- (b) **CI guard**: a check that fails if any non-BMad adapter ships while 5.18 is `backlog`. Higher friction, harder to game.

## 6. Implementation Handoff

**If approved:** start with **Phase A** — investigate, write the diagnosis note, return for Phase B authorisation. Do not stub stories or touch the PRD until Phase A diagnosis lands.

**Success criteria for this proposal:**
- Phase A produces a diagnosis specific enough to author 5.14's spec without speculation.
- Phase B's 5.14 → 5.16 → 5.13b sequence yields one clean autonomous `/flow:start` cycle.
- Phase C's PRD rewrite is shorter than the current success-criteria.md (the reframe is a focus exercise, not a scope expansion).
