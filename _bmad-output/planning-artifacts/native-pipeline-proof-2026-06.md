# Native pipeline — end-to-end proof (Epic 10.7)

**Date:** 2026-06-01 · **Repo:** crew (`main`, trunk) · **Adapter:** native
**Spec:** `_bmad-output/implementation-artifacts/10-7-prove-pipeline-end-to-end.md`
**Run kit:** `.crew/10-7-run-kit.md` · **Rubric:** `rubric-story-quality-2026-05-31.md`

This is the terminal validation of Epic 10: the native planning→build→merge pipeline,
exercised on a genuine feature, with the gates grading a real authoring (not a hand-written
story). It records the three acceptance criteria, the calibration signals surfaced, and the
follow-up work the run exposed.

---

## TL;DR

The native pipeline ran the full arc with no hand-holding on the mechanics:

**author → scan → 5-lens judge → Quality Lead `rework` → re-author → re-judge → QL `ready` + bless → drain → dev built a real test → reviewer `READY FOR MERGE` → CI green → auto-merge gate paused `needs-human`.**

- **AC1 (pipeline → merge):** ✅ done. PR **#257** ran reviewer-approved + CI-green + mergeable, paused `needs-human` (medium-risk), and the operator **merged it** (governance B) — commit `1b7063f` on `main`.
- **AC2 (operator spot-check):** ✅ **Match** — Jack confirmed the round-2 verdicts are what a human applying the rubric would reach; two calibration discrepancies logged (below).
- **AC3 (Tier-0 / Verifiability teeth):** ✅ a deliberately hollow draft was bounced — Tier-0 passed its shape, the **Verifiability lens failed** its lack of behaviour.

The gate showed real teeth: it caught a genuine spec gap (round-1 `rework`), the rework loop fixed it (round-2 clean sweep), and a hollow string-presence draft was rejected. The pipeline reaches top-tier quality **through the gate** (author→judge→rework), not the author's first pass alone.

---

## The feature

**Drain fault-injection harness** — a re-derivation of stale backlog 5.6, re-anchored to the
drain (the sole orchestration path). Additive vitest test infrastructure that injects faults
into the drain's seams and proves the no-silent-failures contract holds: every claimed story
lands in exactly one outcome bucket with a reason; one fault never aborts the run or poisons a
sibling; mutating seams fail loud (pause/block), observability seams degrade silent. Chosen
because it is real, low-intent-risk (additive test infra), and exercises the whole pipeline.

---

## AC1 — the pipeline, end to end

### Authoring + judging (two rounds)

| | Round 1 | Round 2 (after rework) |
|---|---|---|
| Draft ref | `native:01KT18TSGD1K26JJEE9PJ9W10B` | `native:01KT19N3H7WZCF1SKQSWDGARF4` |
| Title | "Drain fault-injection harness — prove the no-silent-failures contract…" | "Prove the unattended drain reports every story honestly when its seams misbehave" |
| Judge session | `01KT190JKSW8FH6KV8PCRQN7CX` | `01KT19PE3GN0FM1T509712G7CZ` |
| Tier-0 | pass | pass |
| Structure (planner) | ✅ pass | ✅ pass |
| Verifiability (orchestrator) | ✅ pass | ✅ pass |
| Discipline (generalist-reviewer) | ✅ pass | ✅ pass |
| Domain (generalist-dev) | ✅ pass | ✅ pass |
| Considered (retro-analyst) | ❌ **fail** | ✅ pass |
| QL adjudication | **rework** (round 1 of K=2) | **ready** → blessed |

**Lens→role binding** (note for AC2 and the hiring follow-up): the judge's *designed* binding
wants `architect` (Structure) and `test-specialist` (Verifiability), neither of which is on the
hired roster. They were remapped to **planner** (Structure) and **orchestrator** (Verifiability);
Discipline/Domain/Considered used the default reviewer/dev/retro-analyst.

**Round-1 Considered failure (the substance):** the lens flagged that the spec didn't resolve
*which boundary* the harness asserts at, claiming a mutating hard-reject would "escape" the run.
The author reworked the spec to (a) state the harness drives the whole `drain.workflow.js` body
including the `drainWorker` pool + per-worker try/catch (so a hard-reject is caught as
`worker-threw`, not escaping), (b) split the garble vs hard-reject sub-cases by their distinct
buckets/reasons, and (c) wire `notify` as a 5th injected global. Round 2 passed all five lenses.

### Build → review → gate (the drain)

- **Drain session:** `01KT1A2VD8ERZ32F7WAWP4MQVJ` (launched via the `crew-drain` workflow,
  `maxStories: 1`). Drain result: `completed: [native:01KT19N3…]`, `blocked: []`,
  `pausedForHuman: [{ prNumber: 257, reason: "medium-risk" }]`. Working tree stayed clean — **no leak.**
- **PR #257** — branch `story/native-01kt19n3…`, base `main`, **+1102/−0, 3 files all-added**
  (`drain-fault-injection.test.ts` + its compiled `dist/`). Purely additive; scope held.
- **Reviewer verdict:** `READY FOR MERGE`. All 5 ACs are runnable-vitest and **passed**
  (`exitCode 0`) against the real test file.
- **CI:** `build` ✅ pass.
- **The merged artifact is genuine, not a fake-pass.** The test reads the real workflow source,
  runs the whole body through injected seams, and across 6 tests asserts the honesty invariant
  (exactly-one-bucket, non-empty reasons, no-throw) under every fault class — with
  `worker-threw`-specific and `toEqual`-deep assertions. (Its AC3 test now empirically proves the
  round-1 Considered worry wrong — the `worker-threw` backstop fires through the body runner.)
- **Auto-merge gate:** paused `needs-human` (medium-risk). **Final merge is the operator's hand**
  per governance B — the agent never merges a `needs-human` PR.

**Status:** PR #257 **merged** by the operator (governance B) — commit `1b7063f` on `main`. **AC1 closed.**

---

## AC2 — operator spot-check (Jack)

**Conclusion: MATCH** — the round-2 verdicts are what a human applying the rubric would reach; the bless stands.

| Checklist item | Outcome |
|---|---|
| Considered graded at the story's *actual* risk_tier (not a re-default) | ✅ graded at **medium** (the persisted manifest tier) — though that tier is itself `fallback`-medium (see discrepancy 1) |
| Verifiability checked real behaviour, not string-presence | ✅ confirmed — and AC3 independently proves the lens distinguishes the two |
| Structure / Discipline / Domain read as a human would judge | ✅ grounded, cite real `drain.workflow.js` line numbers, no rubber-stamp |
| Record conclusion | **Match**, two calibration discrepancies logged (not silent failures) |

---

## AC3 — Tier-0 / Verifiability teeth (hollow-draft bounce)

A deliberately hollow draft (`native:01KT1B1PTPGYA9QYQVB0HVBQ0W`, "Record the last-scan
timestamp") whose sole AC was a string-presence check — *"the string `lastScannedAt` appears in
the file"* — the canonical bugfix-1 anti-pattern.

- **Tier-0 (write + scan):** passed it — it is *structurally* well-formed (Given/When/Then shape,
  a verification marker). Tier-0 vetoes shape, not teeth.
- **Verifiability lens (judge session `01KT1B33DTDJ44Q485KEBFY7AZ`):** ❌ **failed** — "an
  `artifact:` check that asserts a literal source-string rather than observable behaviour… green
  forever even if scan stamps nothing… the token could sit in a comment, a type annotation, or
  dead code." Named the scar exactly.

This is the two-tier design working: Tier-0 = deterministic shape veto; Verifiability (Tier-1) =
does the shape have teeth. A hollow AC cannot pass the panel.

---

## Calibration discrepancies (logged for Epic 6b — the judge-the-judge loop)

1. **Risk classifier returns empty paths → everything is `fallback`-medium.** Observed at *both*
   author/scan time (`risk_tier: medium`, `matched_rule: fallback`, `paths: []`) **and** the
   auto-merge gate (`riskTier: medium`, `matched_rule: fallback`, `paths: []`, but `diff_size: 581`).
   Net effect: a purely-additive test PR cannot classify **low**, so the **hands-off low-risk
   auto-merge path cannot currently fire** — every PR pauses `needs-human`. This is the single most
   material finding of the run. → **follow-up story: fix the risk classifier's changed-path extraction.**
2. **Round-1 Considered lens over-fired.** Its headline reason (a hard-reject would "escape" the
   run) was provably wrong — and the test that got built proves the `worker-threw` backstop fires.
   The two smaller points it raised were real and improved the spec, so the rework was net-positive,
   but the fail itself was partly miscalibrated.

---

## Follow-up work surfaced

- **Hire a `test-specialist`** (and consider `architect`); **codify the lens→role binding** so the
  judge panel doesn't improvise. Verifiability — the deepest, scar-bearing lens — was bound to
  `orchestrator` only because no QA role is hired. (Operator's standing question on this run.)
- **Fix the risk-classifier path extraction** (discrepancy 1) — unblocks the low-risk auto-merge path.
- **Wrap the planning segment in a workflow** (gate-1 mirror of the drain): the 5-judge fan-out +
  aggregate + adjudicate + rework loop is textbook Workflow shape, and would make the panel
  deterministic/un-skippable instead of skill-prose-driven (the fragility class we've been burned by).
- **Author-seam richness:** the native author's first pass is leaner than top-tier BMad (no
  Files-touched map, no DoD checklist, thinner risk reasoning) — the rework loop closed the gap here,
  but lifting the first pass would reduce rework rounds.

---

## Verdict

**Epic 10.7 is proven.** The native pipeline authored, judged, reworked, re-judged, blessed, built,
reviewed, and gated a real feature end-to-end; the operator spot-check confirmed the gate's judgment;
and the gate demonstrably rejects a hollow draft. PR #257 was merged by the operator (governance B,
commit `1b7063f`) — **Epic 10 is closed.** The calibration signals above are the expected output of a
first real run, not failures — they become the Epic 6b backlog.
