# Sprint Change Proposal — Epic 3 → Epic 4 carry-forward

**Date:** 2026-05-21
**Triggered by:** Epic 3 retrospective (2026-05-21)
**Source doc:** `_bmad-output/implementation-artifacts/epic-3-retro-2026-05-21.md` (local-only; gitignored)
**Scope classification:** **Moderate** — six items, mostly small, but one (Item 1) is a load-bearing AC on Epic 4's first story.

---

## 1. Issue Summary

Epic 3 closed today (eight stories shipped, all merged). The retrospective surfaced six follow-up items that must be carried forward so they're not lost. The retro doc itself lives in `_bmad-output/implementation-artifacts/` which is gitignored — so the items only persist if they escape into BMad's tracked planning artefacts before Epic 4 planning begins.

One item (Item 1) closes a paper-only AC promise from Story 3.7. The other five are polish, governance, or layering refinements on Epic 3 deliverables.

## 2. Impact Analysis

### Epic Impact
- **Epic 4 (next, not started):** Story 4.1 (claim-story) gains one new AC for `detectInProgressHandEdit` wiring. Five other carry-forward items get captured in a new "Carry-forward from Epic 3 retro" section in the epic file for Epic 4 planning to surface.
- **Epic 3 (closed):** No re-opening. All carry-forward items live forward into Epic 4 (or beyond).
- **Epic 6 (calibration):** Item 2 (spec amendment tracking) is governance-shaped and arguably belongs here; flagged for revisit when Epic 4 planning starts.

### Artifact Conflicts
- **PRD `functional-requirements.md` § Story files and backlog management:** FR14 currently states the direct-edit allowance and the no-edit-in-progress rule but doesn't codify the *refusal contract* the guard implements. Append a sub-bullet.
- **Epic 4 file:** Edit Story 4.1's ACs + add carry-forward section.
- **No architecture changes.** All items are implementation/governance refinements.

### Technical Impact
- Story 4.1 implementation gains one additional call site (calls `detectInProgressHandEdit` on entry).
- Five other items are deferred to Epic 4 planning — no immediate implementation impact.

## 3. Recommended Approach

**Direct adjustment** to two artefacts:
1. PRD functional-requirements.md — append one sub-bullet under FR14
2. Epic 4 file — add one AC to Story 4.1 + a new "Carry-forward from Epic 3 retro" section

No new stories authored at this stage. Story authoring happens at Epic 4 planning time; the carry-forward section is the heads-up the planner needs.

## 4. Detailed Change Proposals

### Change A — PRD FR14 sub-bullet

**File:** `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md`
**Section:** § Story files and backlog management
**Anchor:** existing FR14 bullet

**OLD:**
```
- **FR14:** The user can edit any story file directly (text editor) while it is in `to-do/` or `blocked/`. Edits to stories in `in-progress/` are not supported in v1.
```

**NEW:**
```
- **FR14:** The user can edit any story file directly (text editor) while it is in `to-do/` or `blocked/`. Edits to stories in `in-progress/` are not supported in v1.
  - **FR14a:** The plugin can refuse any state-mutating operation on an `in-progress/` story whose on-disk manifest has been hand-edited since claim. Refusal is the responsibility of each caller that operates on the in-progress layer; the shared mechanism is the `detectInProgressHandEdit` predicate (Story 3.7) which throws a typed `InProgressHandEditError` carrying the offending ref and changed fields. The claim path (Story 4.1) is the first required consumer.
```

**Rationale:** Codifies the in-progress refusal as a PRD-level requirement so the contract is durable independent of any one story. Closes the paper-only-AC pattern flagged in Epic 3 retro.

### Change B — Epic 4 Story 4.1 new AC

**File:** `_bmad-output/planning-artifacts/epics/epic-4-dev-review-loop-the-engineering-heart.md`
**Section:** Story 4.1 acceptance criteria

**OLD (the last AC of Story 4.1):**
```
**AC5 (integration):** vitest covers all four branches against a fixture; chaos test asserts no manifest observed in two state dirs across 1,000 concurrent claim attempts.
```

**NEW (insert a new AC immediately before AC5, becoming AC5; the integration AC renumbers to AC6):**
```
**Given** a story whose `in-progress/` manifest has been hand-edited since claim, **When** `claim-story` (or any state-mutating MCP tool on the in-progress layer) is called for that ref, **Then** it invokes `detectInProgressHandEdit` from Story 3.7 on entry and refuses to proceed by propagating the typed `InProgressHandEditError` to the caller. _(FR14a, closes Story 3.7 AC3)_

**AC6 (integration):** vitest covers all five branches against a fixture; chaos test asserts no manifest observed in two state dirs across 1,000 concurrent claim attempts.
```

**Rationale:** Closes Story 3.7's AC3 paper promise. The claim path is the obvious first consumer because it's the only state-mutating in-progress operation in Epic 4. Renumbering the integration AC from AC5 to AC6 keeps the integration tag conventional.

### Change C — Epic 4 "Carry-forward from Epic 3 retro" section

**File:** `_bmad-output/planning-artifacts/epics/epic-4-dev-review-loop-the-engineering-heart.md`
**Section:** New section, inserted between the epic title and Story 4.1 (so the planner sees it before authoring any 4.x story)

**Insert verbatim:**

```
## Carry-forward from Epic 3 retro (2026-05-21)

These items were captured during the Epic 3 retrospective. When authoring Epic 4 stories, fold them in as ACs on existing stories where they fit, or spin them out as small standalone stories. None blocks Epic 4 kickoff.

- **[High] `detectInProgressHandEdit` wiring** — already added to Story 4.1 above (closes Story 3.7 AC3 / FR14a).
- **[Medium] Spec amendment tracking.** Story 3.5 needed a mid-flight spec amendment that landed only on local disk because `_bmad-output/implementation-artifacts/` is gitignored. Either un-ignore that directory (with implications for run-state / scratch artefacts), or move spec amendments to a tracked path. Likely needs its own story. May fit better in Epic 6 (calibration / standards evolution) than Epic 4 — revisit at planning time.
- **[Low] Surface I/O warnings in `validatePlannerBacklog`.** Add an `io_warnings?: string[]` field to the structured return. Today when `listSourceStories` throws and the pending batch already contains a ship-gate, the tool returns `{ok: true}` and the I/O error reaches `console.error` only. Real product-correctness gap on a rare path.
- **[Low] Native-source-only dedup in planner inventory display.** When a `.flow/native-stories/<ULID>.md` already has a manifest, the planner lists it twice. Cosmetic but visible during planning.
- **[Low] Move ref-format validation upstream into the planning-discipline gate.** Today malformed `depends_on` refs fail at the writer layer (Story 3.4) rather than at planning-discipline (Story 3.5). Layering improvement.
- **[Low] Friendlier `git rev-parse failed` message on no-HEAD scratch repos.** When operator-smoke uses a fresh `git init` scratch repo, the planner emits a scary-looking error. Doesn't break anything; polish for smoke sessions.
```

**Rationale:** Single durable handoff from Epic 3 retro into Epic 4 planning. Visible to anyone reading the epic. Flags the spec-amendment-tracking item as potentially Epic-6-shaped so it doesn't get force-fit into Epic 4 if Epic 6 is the better home.

## 5. Implementation Handoff

**Scope:** Moderate.

**Actions on approval:**
1. Apply Change A (PRD FR14 sub-bullet).
2. Apply Change B (Epic 4 Story 4.1 AC + renumber).
3. Apply Change C (Epic 4 carry-forward section).
4. Commit + PR — small focused PR titled `chore: capture epic-3 retro carry-forward into PRD + epic-4`.

**No new stories authored at this stage** — story authoring happens at Epic 4 kickoff, where the carry-forward section will surface the remaining items for sequencing decisions.

**Success criteria:**
- All six items are visible in git-tracked planning artefacts.
- Epic 4 planning starts with the High item already integrated as an AC on Story 4.1.
- The Medium item is flagged for placement-decision (Epic 4 vs Epic 6) at Epic 4 kickoff.
