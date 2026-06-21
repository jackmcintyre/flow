# Story 10.7: Prove the pipeline end-to-end

story_shape: validation
Status: ready-for-dev

## Story

As the operator (and the PM staking the product thesis on this),
I want a real low-risk feature run all the way through the native cockpit — `crew:author` → `crew:judge` (five lenses) → Quality Lead → `ready` → drain → merge — with a human spot-check of the judge verdicts against the rubric,
so that the re-foundation is proven to **produce stories that meet the bar a human would apply**, not merely to run without error. The machinery exists (Epic 9) and the schema now carries everything the rubric grades (10.1–10.4); whether it yields *good* stories is the one thing untested. This is a validation story — its deliverable is evidence (a recorded run + a spot-check), not new product code — and it is the gate that makes the arc "real".

## Dependencies

- **Depends on 10.6** (cutover complete — the proof runs on the native-primary pipeline) and transitively on 10.1–10.5.
- **Is the terminal validation of Epic 10.** Nothing in the epic is "done" until this passes.
- **Touches no production code** (it exercises the existing cockpit + drain). Its artifacts are a run record and a spot-check note.

## Acceptance Criteria

**AC1 — a real feature traverses author → judge → QL → ready → drain → merge on native, green (integration):**

A real low-risk feature is authored natively via `crew:author` (producing an enriched §3 native story that clears Tier-0), graded by the five-lens `crew:judge` panel, adjudicated by the Quality Lead to `ready`, blessed, claimed by the drain, built, reviewed, and merged with the full suite green — entirely through the native path, no BMad surface in the loop. The run is recorded (the merged PR + the captured cockpit/drain output). Observable spine: one real feature ships end-to-end on native, hands-off through the gates a human only spot-checks.

artifact: _bmad-output/planning-artifacts/native-pipeline-proof-2026-NN.md

**AC2 — a human spot-check confirms the judge verdicts match the rubric (no rubber-stamp) (integration):**

A human reads the five per-lens verdicts (each `{ lens, pass, missed }`) and the Quality Lead synthesis for the proof story and confirms they are the verdicts a human applying the rubric would reach — in particular that the Considered lens graded at the story's actual `risk_tier` (10.4) and that Verifiability genuinely checked behaviour, not string-presence. The spot-check is recorded with its conclusion (match / discrepancies). A discrepancy does not fail the story silently — it is logged as a rubric/calibration follow-up.

artifact: _bmad-output/planning-artifacts/native-pipeline-proof-2026-NN.md

**AC3 — Tier-0 is shown to have teeth in the same run (integration):**

As part of the proof, a deliberately thin draft (e.g. an AC whose verification is missing, or a "string appears in a file" assertion with no real check) is run through the native author/scan path and is **bounced** — by Tier-0 at scan or by the Verifiability lens at judging — not passed. This demonstrates the gate rejects the bug-class the re-foundation targets, on the live pipeline. Recorded alongside the passing run.

artifact: _bmad-output/planning-artifacts/native-pipeline-proof-2026-NN.md

## Definition of Done

- [ ] All three ACs met.
- [ ] The proof story's own PR (the real feature) merged green with the full suite passing — it is its own ship gate.
- [ ] The proof record (`native-pipeline-proof-*.md`) is written: the feature chosen, the authored native story, the five verdicts + QL synthesis, the human spot-check conclusion, and the Tier-0-bounce evidence.
- [ ] Any spot-check discrepancy is captured as a follow-up (rubric tweak or Quality-Lead calibration input) — feeding the Epic 6b harmonized standards registry (per the ratified decision #5).
- [ ] Reviewer cycle clean on the proof feature.

## Implementation Notes

### Scope discipline — what this story does and does NOT build

**Builds:** evidence. A documented end-to-end run of a real low-risk feature through the native cockpit + drain, a human spot-check of the verdicts, and a Tier-0-has-teeth demonstration. No new product code.

**Does NOT build:**
- Any new tool, schema, or skill — it uses the existing cockpit (`crew:author`/`crew:judge`/`crew:ready`/`crew:board`) and the drain.
- Rubric or Quality-Lead changes — discrepancies are *logged* as follow-ups, not fixed here (that is Epic 6b's calibration loop).

### How to run it (the validation procedure)

1. Pick a **real, low-risk** feature (a genuine small improvement to crew, not a toy) so the proof is honest.
2. `crew:author` it → confirm the native story clears Tier-0 (10.1–10.3) and carries a sensible `risk_tier` (10.4).
3. `crew:judge` → capture the five per-lens verdicts; `crew:ready`/Quality Lead → adjudicate to `ready` (or escalate, per K=2).
4. Drain it (claim → dev → review → gate → merge) on a branch to `main`; full suite green.
5. **Spot-check:** a human compares the verdicts to the rubric and records the conclusion.
6. Run the deliberately-thin draft (AC3) and record that it is bounced.
7. Write the proof record; log any discrepancy as a calibration follow-up.

### Edge cases worth surfacing in dev/review

- **Pre-mortem (this is where the residual risk lives):** assume the proof "passed" but the story was actually weak — the gates rubber-stamped. The defenses: AC2 (a human spot-check, not the machine, is the final judge of quality) and AC3 (an independent demonstration that the gate rejects a known-bad draft). The one assumption that sinks the arc: that a clean machine run equals a good story. AC2 is the explicit check on that assumption — do not skip it.
- **Choose a genuinely low-risk but real feature.** A toy proves nothing; a high-risk feature confounds the proof with unrelated difficulty. Low-risk-but-real is the target.
- **Parallel-safety:** running the drain for this proof must respect the same one-drain-at-a-time discipline (no concurrent drain against the repo). Schedule it when no other drain (e.g. an Epic 6 calibration drain) is live.
- **If the spot-check finds discrepancies**, the arc is not invalidated — it has produced exactly the calibration signal Epic 6b consumes. Record it; don't paper over it.

### Risk + build notes (drain context)

- **Risk tier: medium** (a real feature ships, but chosen low-risk; the validation itself adds no code). The honest residual risk of the *whole epic* concentrates here — hence the human spot-check is the load-bearing AC.
- **Build/verify:** the proof feature's own DoD (full suite + build green) is its ship gate; the proof record is the deliverable.
- **Build-order:** last in the epic — after cutover (10.6).

### References

- [Source: _bmad-output/planning-artifacts/native-refoundation-plan-2026-05-31.md §7] — proving the pipeline is the real residual risk; run a real feature end-to-end with a human spot-check of verdicts vs rubric.
- [Source: _bmad-output/planning-artifacts/rubric-story-quality-2026-05-31.md §3] — the rubric the spot-check applies (five lenses; Verifiability behaviour-not-string; Considered risk-tiered bar).
- [Source: plugins/crew/skills/{author,judge,ready,board}/SKILL.md] — the cockpit surfaces the proof exercises.
- [Source: _bmad-output/implementation-artifacts/10-4-plumb-risk-tier-into-native-draft.md, 10-6-cutover-native-primary-bmad-ingest-only.md] — the risk-tier plumbing and the cutover the proof validates.
