---
date: 2026-05-31 (native re-foundation correct-course pass)
author: Jack (PM decisions) + Claude (analysis + drafting)
scope: **Moderate** — backlog reorganization only (retire 1 story, rescope Epic 7, re-sequence Epic 6b). No PRD change, no architecture rewrite, no code. Folds the native re-foundation plan §10 into the live backlog.
trigger: Epic 10 (native re-foundation, stories 10.1–10.7) is authored and merged to `main` (PR #240, `bb7dc4c`); §8 decisions ratified. The native-refoundation plan §10 flagged a correct-course pass as due "when N.x authoring begins" — that point has arrived. Three pre-native backlog items are now stale against the pivot.
supersedes: Story 5.18 (structural story-parser). Rescopes Epic 7 (7.1–7.7) and re-sequences Epic 6b (6.9–6.14) against the native cutover.
status: **DRAFT — pending PM review.** Operator (Jack) was away at authoring time; this proposal drives the analysis autonomously and parks genuine open calls in §5 rather than blocking. The sprint-status edits in §4 are applied in the same PR (status/notes only — no story content authored).
---

# Sprint Change Proposal — Native Re-foundation Correct-Course (§10)

## 1. Issue Summary

The native re-foundation is now real on `main`: Epic 10 (stories 10.1–10.7) is authored and merged (PR #240), and the §8 design decisions are ratified (auto-memory `project_native_refoundation_decisions_ratified`). The plan that produced Epic 10 — `native-refoundation-plan-2026-05-31.md` — closed with a **§10 "correct-course implications"** note flagging three pre-native backlog items that go stale the moment the team owns a strict, generated native story format and treats BMad as ingest-only.

That moment has arrived, so the §10 pass is due. The three items:

1. **Story 5.18 (structural story-parser)** only ever existed to tolerate BMad's human-authored sloppiness. A strict *generated* native format has nothing sloppy to parse — the story is obsolete.
2. **Epic 7 (install-canary, 7.1–7.7)** was authored against a BMad-shaped example and the retired `/start`+`/watch` orchestration. The native pivot moves the ground under it; its stories reference surfaces that no longer exist.
3. **Epic 6b (calibration loop)** splits cleanly under the pivot: the calibration *engine* (6.4–6.8) is independent and already mostly merged, while the persona/team cluster (6.9–6.14) is entangled with the judging work via ratified decision #5 (**Quality Lead and build-side reviewer HARMONIZE** onto one evolving standards registry) and must wait behind the native cutover.

Left unreconciled, the board over-states ready work (5.18 looks shippable), and whoever authors Epic 7 next would build against dead surfaces.

## 2. Impact Analysis

**Headline: this is bookkeeping, not replan.** No PRD shard changes; no architecture rewrite; no code. The pivot's *design* already landed in Epic 10 — this pass only re-files the three downstream backlog items so the board matches the ratified direction.

### Artefact impact

| Artefact | Impact |
|---|---|
| `prd-crew-v1/**` | **No change.** Operator experience, scope, success criteria all hold; the engine swaps, the product doesn't. |
| `architecture/**` | **No change in this pass.** The native topology is captured by Epic 10; no architecture doc edits are required to retire/rescope/sequence backlog rows. |
| `epics/epic-5-…md` (Story 5.18) | **Supersede.** 5.18's "structural parser / sprint-status-as-authoritative" charter is absorbed by Epic 10's strict generated format + Tier-0 validator (10.3). Mark superseded; do not delete (provenance). |
| `epics/epic-7-…md` (7.1–7.7) | **Rescope (pre-authoring).** Stories are backlog rows, not yet authored as specs. Annotate the rescope intent now; re-author via `bmad-create-story` *after* the native cutover (10.6), so the example is built native-shaped against live surfaces. |
| `epics/epic-6-…md` (6b) | **Re-sequence, no content change.** Split 6b into the independent calibration engine (6.4–6.8, parallel) and the cutover-blocked persona/team cluster (6.9–6.14). Carry decision #5 (QL/reviewer HARMONIZE) as the dependency that gates the cluster. |
| `sprint-status.yaml` | **Edits in this PR:** one status flip (5.18 → cancelled) + inline rescope/sequence notes on Epic 7 and 6.9–6.14 rows. No story content authored. |
| UX specs | **N/A** — crew is a CLI plugin, no UI. |

### Technical impact

None direct (planning-only). One **must-not-lose** caveat carried from the workflow-pivot proposal: 5.18's *sibling* Epic-5 fixes (5.14/5.17 parser-widening, etc.) are **already merged and stay**; only 5.18 itself — the unbuilt structural-parser story — is retired. Retiring 5.18 removes no shipped code.

## 3. Recommended Approach

**Direct adjustment** (modify the plan in place; no rollback, no MVP cut). The three moves are independent and individually low-risk:

### Move 1 — Retire Story 5.18 (structural story-parser)

- **What:** Flip `5-18-structural-story-parser` from `backlog` → `cancelled` with a superseded-by note.
- **Why:** 5.18's own background frames it as the home for "the deeper *`sprint-status.yaml` is canonically authoritative for execution state*" question — a tolerate-BMad-sloppiness concern. Owning a strict, generated native format (Epic 10: 10.1 enriched AC, 10.2 tasks/sources, **10.3 Tier-0 fail-closed validator**) means there is nothing sloppy left to parse. §10 confirms the retire.
- **Residual:** the "what is canonically authoritative" question is absorbed by the native manifest + Tier-0 validator; nothing is orphaned.

### Move 2 — Rescope Epic 7 (install-canary, 7.1–7.7)

Re-anchor the install-canary to the native world **before** any of its stories are authored as specs. Concretely, the rescope each story needs at authoring time:

| Story | Stale assumption (today) | Rescope (post-native) |
|---|---|---|
| 7.1 | Bundled **BMad-shaped** example repo (`adapter: bmad`) | Native-shaped example (native is the primary adapter; BMad demoted to ingest-only per plan §5/§6). Open call in §5 on whether to *also* seed a BMad fixture to canary the ingest seam. |
| 7.2 | README step 8 = run `/start` and `/watch` | Both retired (#210; `/watch` cancelled). Re-point the install path at the **drain** workflow (`/flow:crew-drain`) + the intake cockpit (`/ready`, `/board`). |
| 7.3 | E2e canary drives `/start` | Drive the **drain** end-to-end (author → judge → QL → ready → drain → merge), matching plan §7's "prove the pipeline" scenario. |
| 7.4b | Plain-language pass over Story **5.5** surface tags | 5.5 is cancelled (assumed the retired watch loop). Re-anchor to the live drain/result-bucket surfaces. |
| 7.5 | Troubleshooting guide inventories failure paths from Stories **5.4 / 5.5 / 5.8** | All three cancelled. Re-anchor to the drain's exit-reason/result-bucket failure taxonomy (Epic 8 surfaces). |

7.4, 7.6, 7.7 are largely surface-agnostic (timed run, telemetry-summary, paper-test) and need only light touch-up. **No Epic 7 story is authored in this pass** — this records the rescope so re-authoring (via `bmad-create-story`, after the 10.6 cutover) starts from the right shape.

### Move 3 — Re-sequence Epic 6b

Split the existing 6b tranche along the native dependency line:

- **Calibration engine (6.4–6.8) — independent, drains in parallel.** Rule registry + skill-proposal application + telemetry. 6.4 done; 6.5/6.7/6.8 merged (PRs #237–#239, flipped to `done` in the companion ledger PR); only 6.5b and 6.6 remain. No dependency on the native pivot — keep draining.
- **Persona/team cluster (6.9–6.14) — waits behind the native cutover (Epic 10 / 10.6).** Per decision #5 (ratified **HARMONIZE**), the Quality Lead and the build-side reviewer share **one evolving standards registry**. The Quality Lead is the home for the rubric the calibration loop sharpens — so 6b's standards-evolution and the Epic 9/10 judging work are now the *same* registry. The persona/team cluster cannot land coherently until that unified registry exists, which is the cutover. Sequence 6.9–6.14 after 10.6.

**Rationale for the whole approach:** each move only re-files backlog state to match a direction already ratified in Epic 10. Risk is near-zero (reversible status edits; no code; no authored specs). Effort: minutes. Timeline impact: removes one false-ready story and prevents wasted authoring of dead-surface Epic 7 stories.

## 4. Detailed Change Proposals

### 4.1 sprint-status.yaml edits (applied in this PR)

```yaml
# Move 1 — retire 5.18
-  5-18-structural-story-parser: backlog
+  5-18-structural-story-parser: cancelled  # native re-foundation §10: strict generated format leaves nothing sloppy to parse; charter absorbed by Epic 10 (10.3 Tier-0). See sprint-change-proposal-2026-05-31-native-refoundation-correct-course.md

# Move 2 — Epic 7 rescope notes (status stays backlog; re-author post-10.6)
   7-1-bundled-bmad-shaped-example-target-repo: backlog  # rescope: native-shaped example (BMad → ingest-only); re-author post-cutover. See SCP 2026-05-31 native-refoundation.
   7-2-readme-install-path-with-verifiable-checkpoints: backlog  # rescope: /start+/watch retired → drain + intake cockpit. See SCP 2026-05-31.
   7-3-e2e-canary-vitest-drive-of-the-canonical-scenario: backlog  # rescope: drive the drain (author→judge→QL→ready→drain→merge). See SCP 2026-05-31.
   7-4b-plain-language-pass-over-orchestration-surfaces: backlog  # rescope: Story 5.5 surfaces cancelled → re-anchor to drain/result-bucket surfaces. See SCP 2026-05-31.
   7-5-authoritative-troubleshooting-guide: backlog  # rescope: 5.4/5.5/5.8 failure paths cancelled → re-anchor to drain exit-reason taxonomy. See SCP 2026-05-31.

# Move 3 — Epic 6b sequencing notes (persona/team cluster waits behind native cutover 10.6)
   6-9-persona-knowledge-append-via-proposed-md-and-accept-proposal: backlog  # sequence: persona/team cluster waits behind native cutover (Epic 10/10.6); QL/reviewer HARMONIZE (decision #5) shares one standards registry. See SCP 2026-05-31.
   6-10-team-change-proposals-and-apply-team-change: backlog  # sequence: behind 10.6 (decision #5 HARMONIZE). See SCP 2026-05-31.
   6-11-outcome-stats-and-constructive-to-defensive-ratio: backlog  # sequence: behind 10.6. See SCP 2026-05-31.
   6-12-archive-cycle-and-cycle-boundaries: backlog  # sequence: behind 10.6. See SCP 2026-05-31.
   6-13-persona-files-version-controlled-and-bad-append-recovery: backlog  # sequence: behind 10.6. See SCP 2026-05-31.
   6-14-hand-editable-persona-files-defaults-template-minimal-valid: backlog  # sequence: behind 10.6 (decision #5 HARMONIZE); existing 6.9-prereq note retained. See SCP 2026-05-31.
```

> Calibration engine (6.4–6.8) is **not** re-sequenced — it stays in flight (6.5/6.7/6.8 → done in the companion ledger PR; 6.5b/6.6 remain ready-for-dev). The Epic 7 and 6.9–6.14 rows keep `backlog`; only inline notes are added so re-authoring starts from the right shape.

### 4.2 Epic-file annotations (deferred to authoring time — NOT in this PR)

Epic 7's per-story rescope and 6b's re-sequence are recorded here in the proposal and as sprint-status notes. The **epic markdown** (`epics/epic-7-…md`, `epics/epic-6-…md`) is left untouched in this PR because revising story *content* must go through `bmad-create-story`, not a hand-edit (project rule: never hand-write stories). The epic files are re-authored when their stories are picked up — Epic 7 after the 10.6 cutover; 6.9–6.14 likewise.

## 5. Open Decisions for Jack

Genuine calls parked here rather than blocking the pass:

1. **Epic 7 bundled example — native-only, or native + BMad ingest fixture?** A native-only example is simplest and matches "native is primary." But seeding a small BMad fixture would also canary the §5 BMad→native **ingest seam** end-to-end — arguably the highest-risk one-off in the pivot. *Recommendation: native primary + a minimal BMad fixture purely to exercise ingest, decided at 7.1 authoring time.*
2. **Epic 7 re-authoring timing.** Re-author 7.1–7.7 now (rescope-in-place, accept some churn if the cutover shifts details) or wait until after 10.6? *Recommendation: wait for 10.6 — the example shape depends on native being the live adapter, so authoring earlier risks re-work.*
3. **5.18 full-retire confirmation.** Retiring 5.18 assumes the "what is canonically authoritative for execution state" question is fully absorbed by Epic 10's manifest + Tier-0 validator. If you want a thin residual story to *assert* that authority explicitly (rather than rely on it implicitly), say so and it can be authored fresh under Epic 10. *Recommendation: full retire; the Tier-0 validator already owns the invariant.*

None of these blocks the §4.1 edits — they all concern *future* authoring, which is downstream of the 10.6 cutover.

## 6. Implementation Handoff

**Scope classification: Moderate** (backlog reorganization; no PRD/architecture/code). Mechanically additive and reversible — one status flip + inline notes; no rows deleted or renumbered; no specs authored.

**This PR delivers:**
1. This proposal doc.
2. The §4.1 sprint-status edits (5.18 → cancelled; Epic 7 + 6.9–6.14 rescope/sequence notes).

**Follow-on (not this PR), gated on PM review + the 10.6 cutover:**
- Re-author Epic 7 (7.1–7.7) native-shaped via `bmad-create-story`.
- Pick up 6.9–6.14 once the unified QL/reviewer standards registry exists.
- Calibration engine (6.5b, 6.6) continues to drain independently in the meantime.

**Success criterion for this proposal:** the board no longer shows 5.18 as ready work, and Epic 7 / 6.9–6.14 carry an explicit rescope/sequence marker so no one authors them against dead surfaces.
