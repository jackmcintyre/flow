# Design Note — Native planning + two-gate "generate-and-judge" architecture (2026-05-31)

**Status:** Direction agreed (Jack, PM, 2026-05-31). Scoping/sequencing deferred. MVP to be built on the current (BMad) substrate first; the native-format re-foundation comes later.

**Author:** Jack (PM) + Claude — working/thinking session, 2026-05-31.

**Relates to:** extends the planning-adapter architecture (Epic 3); has correct-course implications for the BMad-substrate stories and Epics 5/6b/7 (see §8). Builds on the deterministic-seam principle and the "never hand-write stories" rule.

---

## 1. The one-paragraph version

The crew product gets one coherent spine: **the same project-shaped team plans and builds through two gates, both run the same way — the team produces, the team judges, and only a pass moves on.** A PM-facing *intake cockpit* lets a non-engineer propose, specify, and sequence features; an *author* drafts each into a strict, well-structured story; a *diverse judge panel* (plus a dedicated **Quality Lead**) grades it against a rubric we own; passes become **ready**; the existing *drain* claims only *ready* stories and runs them dev → review → merge. The retro/calibration loop (Epic 6b) evolves the rubric and the personas, so both gates get smarter over time. **BMad drops from "the planning substrate" to "a one-off on-ramp."**

---

## 2. Why move off BMad (the root cause)

Most of our substrate tax — the reviewer AC-regex divergence (verified nothing, silently), the AC-marker gap that blocked every story, em-dash heading drift, discipline-validator false-positives, the bulk of Epic-5/8 parser-hardening churn — is **one bug wearing different hats: we consume BMad's human-prose story format as a machine interchange format, and we don't control that format.** Stories are an interchange format between planning and execution; interchange formats should be machine-first and strict, not human-prose-first.

Owning a strict native format attacks the root cause. It also likely **retires the structural-parser story (5.18)**: a permissive parser was only ever needed to tolerate BMad's human-authored sloppiness; if we *generate* strict, there is nothing sloppy to parse.

We are not starting from zero — the adapter seam and a native adapter + planner already exist (Epic 3.4). This is **promoting the native path to primary**, not inventing it. Caveat: the native path is scaffolded but unproven at the authoring-quality bar; that's where the real work and risk sit.

---

## 3. Keep BMad's information model; drop its serialization

What's good about a BMad story is its **information model** — rich context, ACs with verification markers, discipline rules. What hurts is its **loose markdown serialization**. The native format = the same rigor in a strict, validated schema we own. This is *not* less planning discipline; it's the same discipline in a format we control.

**BMad becomes one generalized ingest seam, not a bespoke parser.** "Point an LLM at a folder of docs → native draft → human review." BMad output is just one input shape (a Notion export, a PRD, a pile of markdown are others). One-off, one-way, reviewed — a seeding on-ramp, never a live sync. (LLM transforms are lossy: fine for seeding, fatal as a dependency.)

---

## 4. The intake cockpit (gate 1) and the two-gate pipeline

Today `flow:plan` is a one-shot conversation, `flow:scan` dumps everything into `to-do/`, and the drain claims anything claimable. There is **no PM-facing surface to shape, sequence, and *release* a backlog over time, and no readiness brake.** That missing surface is literally step one of the stated success target ("primes a continuous-flow backlog… walks away").

**Two-gate pipeline:**
- **Gate 1 — PM owns it:** proposed → specified → **ready**. PM proposes a feature in plain language; an author drafts it into a strict story; the judge panel grades it; passes become *ready*. PM curates and sequences.
- **Gate 2 — machine owns it:** the drain claims only *ready*; dev builds; review judges; merge. Nothing ships unblessed.

The **ready gate** is the load-bearing new idea — a readiness state the PM controls, distinct from "exists in the backlog." It's what makes "the dev loop picks it up when it's ready" real.

The **grouping tables become a generated view of gate-1 state, not a hand-maintained file.** (This resolves the original "build the tables" ask: the tables are an *output* of the cockpit, not an artifact someone curates by hand.)

---

## 5. The judging mechanism (the riskiest part)

Generate-and-judge is the shape we already trust on the build side (dev → reviewer → gate). This applies it one step earlier, to planning. Two non-negotiables, both learned from scars:

1. **Judges are different lenses, not the author's twin.** Reviewers rubber-stamp when they share the author's blind spots (documented scar). So: the QA persona grades verifiability, the architect grades structure, the domain expert grades correctness, and one adversarial judge is briefed to *reject*. Role diversity is what turns this from theatre into a real filter.
2. **The verdict reduces to a machine-checkable gate, not prose.** Load-bearing decisions live in written, validated artifacts; prose mandates drift under load. The panel outputs "passed criterion X: yes/no + what it missed," schema-checked, with a hard stop rule: pass, or after K rounds escalate the close calls to the PM.

**The Quality Lead** is a dedicated team role — *not* the sole grader. It owns the rubric, synthesizes the panel's verdicts, breaks ties, decides pass-or-escalate, and accumulates judging knowledge over time. Foreperson of the jury, not the jury. Crucially it is the **home for the quality bar that the calibration loop (Epic 6b) evolves** — the retro-analyst *sets* the standard; the Quality Lead *applies* it. Guardrail: a role that both holds and accumulates the bar can calcify, so (a) the diverse panel keeps it honest, (b) PM escalations feed back via retro, and (c) the retro loop should **judge the judge by outcomes** (did its "ready" verdicts correlate with clean merges vs. rework?). It's the one role that should itself be measured.

**Naming:** "Quality Lead" (recommended) or "Assessor"; avoid "Critic" (too negative) and "QA" (too test-specific — it also judges plans). Name is secondary to the shape.

---

## 6. The rubric (first cut — **extended** in the dedicated rubric doc)

> **The full, usable rubric now lives in `_bmad-output/planning-artifacts/rubric-story-quality-2026-05-31.md`** — the evolvable grading artifact Story 9.3's judge panel and Story 9.4's Quality Lead reference. It turns this first cut into scoreable per-lens checks with worked PASS/FAIL examples, adds the **"Considered" lens** (risk-tiered cold-dev sufficiency, Jack's call 2026-05-31), and ports the BMad ship-gate rule into a continuous-flow "every story is its own ship gate" check. The summary below stays as the short version.


The native format and the rubric are the **same artifact**: the strict schema *is* the grading sheet the judges score against. Reframed from "a template the author fills" into "a grading sheet the judges score." It judges the **spec**, not the implementation. (BMad's Dev Agent Record / File List / Definition-of-Done are build-time tracking and belong to the *build* gate, which the reviewer already owns.)

**Tier 0 — deterministic veto (pass/fail by code, before the panel; any miss bounces back to the author):**
- Required sections present: story statement, ACs, every task mapped to an AC, dev-notes with cited references.
- Every AC well-formed: the `**ACn (tag):**` Given/When/Then shape, carrying a verification marker (`artifact:` and/or `vitest:`).
- State-mutating story has ≥1 `kind: "integration"` AC.
- Cross-story deps explicit in `depends_on:`, never prose "see story X".
- Technical claims cite a source path.

**Tier 1 — panel judgment (one lens each; Quality Lead scores against a bar):**
- **Structure** — one completable unit, not secretly three; context sufficient for a cold dev.
- **Verifiability** *(deepest — where our scars live)* — each AC asserts observable *behavior*, not "a string appears in a file"; the integration AC is a real end-to-end exercise, not mocks; the named test would actually fail if the behavior were missing.
- **Discipline** — no scope beyond the stated need; the change leaves the system green end-to-end (no surprise breakage under green ACs); the proof-of-correctness AC is the spine, written first.
- **Domain** — claims grounded in files actually read, not guessed; versions pinned; aligns with existing patterns.

**Granularity is a property the rubric checks, not a number:**
- **Floor (Verifiability):** the slice must carry one real, observable end-to-end behavior of its own. No integration AC of its own → it's a fragment → fold into the story whose behavior it serves.
- **Ceiling (Structure):** if the integration AC needs more than one orthogonal assertion → it's two jobs → split.
- Right size = *the smallest slice that still has one observable outcome a judge can verify.* Lean small by default (tighter ACs validate easier and resist rubber-stamping); the integration-AC floor stops "lean small" tipping into "shattered" — over-slicing pays a per-story orchestration tax (each story is a full claim→dev→review→gate→merge cycle + worktree + PR) and creates the integration-gap risk the ship-gate rule exists to catch.

**Rubric sources (verbatim conventions live here):** `_bmad-output/_archive/planning-discipline.md` (the 5 rules), `.claude/skills/bmad-create-story/template.md` + `checklist.md`, `plugins/flow/docs/user-surface-acs.md` (tag/marker conventions + extraction regex), canonical specs `3-5-…`, `5-15-…`, `5-27-…` under `_bmad-output/implementation-artifacts/`.

---

## 7. Decisions locked (2026-05-31)

- Off BMad-as-substrate → **own a strict native format (= the rubric)**. BMad → one-off generalized ingest seam.
- **Two-gate generate-and-judge architecture**; same team across plan, build, review, retro.
- Judging = **diverse panel + dedicated Quality Lead** (owns rubric, adjudicates, accountable to outcomes).
- **Tier 0 = hard veto; Tier 1 = panel score against a bar.**
- **Granularity = lean small**, bounded by the integration-AC floor and the one-orthogonal-assertion ceiling.
- **MVP on the current approach:** build the *mechanism* (cockpit + panel + Quality Lead) on today's BMad-shaped stories first; swap in the owned native format later. Don't do two hard new things at once.
- Sequencing vs Epic 6b deferred (the Quality Lead entangles the two — see §8).
- **6.14 tracked as its own story, slotted before 6.9** (operator decision 2026-05-31, commit `18d516f`) — it's a usability prereq for 6.9. *(Supersedes the earlier lean to fold it into 6.13.)*

---

## 8. Implications for the existing backlog (flagged, not actioned)

- **Entanglement with Epic 6b:** the Quality Lead is the home for the calibration loop's evolving bar, so the intake/judging work and 6b are no longer cleanly sequential. Sequencing call deferred deliberately.
- **5.18 (structural parser)** likely retired by owning the format.
- **Epic 7 install-canary** assumes a "BMad-shaped example target repo" (7.1) and references retired surfaces (7.2 / 7.4b / 7.5 already flagged needs-rewrite); the native pivot shifts these further. Re-scope when Epic 7 is picked up.
- These need a deliberate `bmad-correct-course` pass when scoping begins; not touched now.

---

## 9. Open questions / extend hooks

- **The "considered" dimension** (context sufficiency / edge-case thought) — softest, most valuable; Jack to define the bar (it's taste, not syntax).
- **Ship-gate equivalent for continuous flow** — the "something proves the whole still works" intent survives as a per-story "system stays green" check, not a final gate story; settle the exact form.
- **Quality Lead vs existing build-side reviewer** — harmonize or keep separate; they should share the same accumulated standards. Defer.
- **Native format detail** — the strict schema itself, drawn from BMad's information model; Jack to extend.
- **Where the Quality Lead role lives** in the role catalogue / hiring roster.

---

## 10. Next steps (proposed, not started)

1. Jack extends the rubric (§6), especially the "considered" bar and the native schema.
2. Scope the MVP — the intake cockpit + author + panel + Quality Lead on the current BMad substrate — as its own epic-sized body of work; author stories via `bmad-create-story` (never hand-write).
3. Defer: native-format re-foundation, BMad→native import of the live backlog, and the 6b sequencing call.

---

## Appendix — current backlog snapshot (point-in-time, 2026-05-31; NOT the canonical tables)

Re-derived from `_bmad-output/implementation-artifacts/sprint-status.yaml`. 23 outstanding = **11 Epic-6b + 8 Epic-7 + 4 Epic-5**:
- **Epic 6b (11 outstanding):** keystone **6.4 done** (accept-proposal diff-then-confirm gate, PR #219); outstanding stubs = 6.5, 6.5b, 6.6, 6.7, 6.8, **6.14**, 6.9, 6.10, 6.11, 6.12, 6.13 — calibration loop. (6.14 now tracked before 6.9, not folded.)
- **Epic 7 (8):** 7.1, 7.2, 7.3, 7.4, 7.4b, 7.5, 7.6, 7.7 — install canary; 7.2/7.4b/7.5 pivot-contaminated (needs rewrite).
- **Epic 5 residual (4):** 5.6 (fault-injection, worth elevating), 5.7 (idempotency test), 5.18 (structural parser — likely retired by this pivot), 5.23 (mark-story-shipped — trigger-gated).

These become managed by the cockpit once it exists; the canonical "tables" will be **generated** from gate-1 state, not hand-maintained.
