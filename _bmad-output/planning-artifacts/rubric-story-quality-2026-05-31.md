# Rubric — Story Quality (Gate 1) — 2026-05-31

**Status:** First working draft (Jack PM + Claude, 2026-05-31). Extends the design note §6 first-cut into a usable grading artifact. Story 9.3's judge panel and Story 9.4's Quality Lead reference *this* doc; the design note keeps the short summary.

**What this is.** The rubric is one artifact wearing three hats: the **author's target** (what a good story looks like), the **judge panel's grading sheet** (what each lens scores), and the **Quality Lead's bar** (the line for `ready`). It judges the **spec, not the implementation** — build-time tracking (file lists, dev records, definition-of-done) belongs to gate 2 (the drain's reviewer), not here.

**Tool-agnostic by design.** The rubric's *essence* is a set of properties a good story has. Those properties are expressed today through the current (BMad) substrate's markers (`**ACn:**`, `vitest:`/`artifact:`, `depends_on:`). When crew owns a strict native format, the *essence is unchanged* — only the serialization moves. Each check below states the **principle** first, then "**today:**" the substrate marker that expresses it. Grade against the principle; use the marker as the mechanical check.

---

## 1. How scoring works

Two tiers, run in order. A draft must clear **Tier 0** before the panel spends judgment on it.

- **Tier 0 — deterministic veto.** Machine-checkable, pass/fail, *before* the panel. Any miss bounces the draft back to the author with the specific failure named. No human judgment, no partial credit. This is the cheap filter that stops the panel wasting cycles on a malformed draft.
- **Tier 1 — panel judgment.** Five lenses, each scored by a **different** judge role (lens diversity is non-negotiable — a panel that shares the author's blind spots rubber-stamps; that scar is documented). Each lens returns **pass/fail + what it missed** — a sentence naming the specific gap, never a bare verdict and never prose-only. The Quality Lead synthesizes the five verdicts, breaks ties, and decides **pass-or-escalate**: a clean sweep is `ready`; a split or a close call after K rounds escalates to the operator rather than auto-passing.

**The verdict is data, not prose.** Every criterion reduces to `{criterion, pass: bool, missed: string}`. "Looks good to me" is not a verdict. (Deterministic-seam discipline: the load-bearing decision lives in a validated artifact, not in a judge's narration.)

---

## 2. Tier 0 — deterministic veto (any miss bounces the draft)

| # | Principle | Today (substrate marker) |
|---|-----------|--------------------------|
| T0-1 | **Required sections present.** Story statement (role/want/so-that), acceptance criteria, dependencies, every task mapped to an AC, dev-notes citing real references. | The spec's section headings; tasks reference `ACn`. |
| T0-2 | **Every AC is well-formed and carries a verification marker.** No AC without a stated way to check it. | `**ACn:**` Given/When/Then shape; each AC carries `vitest:` and/or `artifact:`. |
| T0-3 | **A state-mutating story has at least one integration AC** that exercises the real path, not a mock. | ≥1 AC whose body drives the real tool/flow and asserts an observable outcome; marked as the integration AC. |
| T0-4 | **Cross-story dependencies are explicit and machine-readable** — never a prose "see story X". | Listed in `depends_on:` (or the Dependencies section's enforced links). |
| T0-5 | **Every technical claim cites a source path.** No claim about how the system works without a file the author actually read. | Dev-notes reference concrete `path/to/file.ts` seams. |
| T0-6 | **Every named check is runnable.** A test command or file path that doesn't exist (or a regex that can't match the intended line) is a broken AC, not a passing one. | The `vitest:` file/path resolves; the `artifact:` path is real; no invented flags (`vitest --grep` does not exist). |

> T0-2/T0-3/T0-6 are the direct fix for the bugfix-1 failure mode: three of six stories shipped under green ACs that verified *a string appeared in source*, not *the behaviour worked*. Tier 0 makes the shape mandatory; Tier 1 (Verifiability) judges whether the shape has teeth.

---

## 3. Tier 1 — panel lenses

Each lens: **what it asks**, **scoreable checks** (each independently pass/fail-able), and a **worked PASS vs FAIL** drawn from real crew stories. Judge role in brackets.

### 3.1 Structure  *[Architect]*

**Asks:** Is this *one* completable unit — not secretly three, not half of one?

**Scoreable checks:**
- Exactly one observable outcome is the spine of the story (see Granularity, §4).
- No AC depends on a sibling AC's side effect to be testable — each stands on its own.
- The story can be claimed, built, reviewed, and merged as a single PR without "and also" work leaking in.

**PASS** — *Story 9.1 (readiness brake):* one spine ("a non-`ready` story is never claimed; flipping it to `ready` makes the drain pick it up"). Field + filter + tool + skill all serve that single outcome.
**FAIL** — a draft that adds the `ready` brake **and** the author seam (propose-a-feature) **and** the dashboard in one story: three orthogonal outcomes, three PRs' worth, three integration ACs. Split.

### 3.2 Verifiability  *[QA / Test]*  — **the deepest lens; this is where our scars live**

**Asks:** Once the proposed work is built, could a correctly-written test be made to fail if the described behaviour were missing? Grade PINNABILITY-ONCE-BUILT — not whether the code or test already exists today.

**Scoreable checks:**
- Each AC asserts a behaviour, not the presence of a string. ("A string appears in a file" is an automatic fail unless the file's *existence/shape* is itself the user-facing contract.) This is the canonical REAL FAIL.
- The integration AC drives the **real** path end-to-end (real tool, real fixture state), not mocks of the thing under test.
- The named test would **fail before the proposed change and pass after it** — i.e. it pins the behaviour, it doesn't just co-exist with it. A check that would be met equally before and after the change pins nothing.
- Setup → action → assertion on a concrete, inspectable outcome (git state, manifest contents, emitted event, returned value).
- **The absence of not-yet-written code or tests is never a fail.** That is the normal, expected state of a plan. Net-new behaviour the plan proposes to build must not be faulted for not yet existing; it is sufficient that once built, a test *could* pin it.

**PASS** — *Story 9.1 AC1:* "a vitest seeds two dependency-satisfied manifests — one not-ready, one ready — and asserts the claim entry point returns the ready one and never the not-ready one; then marks the not-ready item ready and asserts it now selects it." Real claim path, real fixtures, the assertion fails the instant the filter is wrong.
**FAIL** — the bugfix-1 scar: `pattern: "status.*\"failed\""`. Matches "failed" anywhere — a comment, an error string, a doc-string. Green forever, proves nothing. The behaviour ("the write uses the failed status correctly") is never exercised.

### 3.3 Discipline  *[Reviewer / Lead]*

**Asks:** Is the scope exactly the stated need, does the change leave the whole system green, and is the proof-of-correctness AC the spine?

**Scoreable checks:**
- **No scope creep:** nothing built beyond the stated need; a "Does NOT build / deferred" note draws the line explicitly.
- **System stays green** *(the ship-gate, ported to continuous flow)*: the change leaves the **entire** build and test suite green end-to-end — not just the new test in isolation. There is no terminal "ship-gate story" in continuous flow; instead **every story is its own ship gate** — its integration AC exercises the real path, and its definition-of-done requires the *full* suite + build green before the PR. Surprise breakage under green ACs is the failure this catches.
- **The integration AC is the spine, written first.** If the author couldn't write the assertion that proves the change works, the story isn't ready — the behaviour is under-defined or unobservable. (Planning-discipline rule 5.)

**PASS** — *Story 9.1:* change is "additive and default-closed", carries an explicit "Does NOT build" list (no author seam, no dashboard), and the DoD requires the full `pnpm build` + `pnpm test` green, not just the new file. The spine AC (AC1) is written first.
**FAIL** — a story that adds the `ready` filter but only unit-tests the new predicate in isolation. The new test is green; a sibling claim-path test that the change quietly broke is never run before the PR. The system is *not* green end-to-end — the per-story ship gate failed.

### 3.4 Domain  *[Domain expert]*

**Asks:** Are the claims grounded in files actually read, are versions pinned, and does the design fit existing patterns?

**Scoreable checks:**
- Every "the system does X" claim traces to a cited file the author read (cross-checks T0-5, but here the judge *verifies the cite is real and says what the story claims*).
- Versions/deps are pinned, not guessed from memory.
- The approach mirrors an existing precedent where one exists, rather than inventing a parallel pattern.

**PASS** — *Story 9.1:* "`ready` is the polarity-flipped twin of the existing `withdrawn` flag" — names the real precedent (`mark-withdrawn.ts`, the `withdrawn` manifest field, the claim filter that already honours it) and builds the new thing in its image.
**FAIL** — a story that invents a brand-new `readiness-store.json` sidecar and a bespoke parser, with no mention of the `withdrawn` precedent that already solves the same shape. Ungrounded, and it accretes a parallel pattern.

### 3.5 Considered  *[Quality Lead / Adversarial]*  — **the bar Jack set: risk-tiered cold-dev sufficiency**

**Asks:** Was this *thought through*? Could a cold dev build it without stopping to ask, and have the failure modes been anticipated? The bar **scales with the story's risk tier** — lean on small stories, teeth where risk is real.

**Scoreable checks (by risk tier):**

- **Low risk:** the spec **names what could break**, and the **single highest-risk failure mode is pinned by an AC**. Bar = "you've thought about how this fails, and the worst case is covered by a test."
- **Medium / high risk:** **cold-dev sufficiency** — a dev who has never seen the story could build it with **zero clarifying questions**. Every claim is sourced, every non-obvious decision is defaulted (not left open), every dependency is named, and any open question is either resolved or explicitly flagged with its build-time default. The cold dev this serves is *literally the drain*.
- **Highest risk (Quality Lead's discretion):** escalate to a **pre-mortem** — assume it shipped and broke; the spec must already answer "why?". The 2–3 questions a skeptic would ask are surfaced and answered, and the one assumption that sinks the story if wrong is named explicitly.

**PASS** — *Story 9.1's "Edge cases worth surfacing" section:* default-closed safety ("a reviewer might flag 'the drain claims nothing' — that is correct on an un-blessed backlog; AC1/AC5 pin it"), `ready`/`withdrawn` orthogonality, no status-machine coupling, idempotency across process boundaries, round-trip stability. A cold dev hits none of these as surprises — they're pre-answered. The top risk (gating live orchestration) is pinned by AC1 + flagged as a deliberate pause-for-human.
**FAIL** — a spec that adds the `ready` filter cleanly but is **silent on what happens to an un-blessed backlog** (the drain correctly claims nothing — but the builder/reviewer hits that question mid-build, reads it as a bug, and either reverts the brake or escalates). Well-formed, but not thought through.

> **Granularity escape hatch for "Considered":** the bar is *thinking surfaced*, not *words added*. A two-line "Risk: X → covered by AC2" beats a page of defensive prose. Reward insight, not verbosity — over-stuffing context is itself a Structure/Discipline smell.

---

## 4. Granularity — a property the rubric checks, not a number

Lean small by default; the floor and ceiling keep "small" from tipping into "shattered".

- **Floor (Verifiability):** the slice must carry **one real, observable end-to-end behaviour of its own**. No integration AC of its own → it's a fragment → fold it into the story whose behaviour it serves.
- **Ceiling (Structure):** if the integration AC needs **more than one orthogonal assertion** → it's two jobs → split.
- **Right size = the smallest slice that still has one observable outcome a judge can verify.** Tighter ACs validate easier and resist rubber-stamping; the integration-AC floor stops over-slicing, which would pay a per-story orchestration tax (each story is a full claim → dev → review → gate → merge cycle + worktree + PR) and re-open the integration-gap risk the ship-gate rule exists to catch.

---

## 5. The verdict (what the panel emits)

Machine-checkable, schema-shaped — never prose-only:

```
Tier 0:  pass | fail(list of failed check ids)        # any fail → bounce, panel does not run
Tier 1:  per lens → { lens, pass: bool, missed: string }   # five entries, one per lens
Quality Lead synthesis → { decision: "ready" | "escalate" | "rework",
                           rationale: string,
                           escalation_reason?: string }
```

- **All five lenses pass** → Quality Lead may set `ready`.
- **Any lens fails** → `rework` with the specific `missed` strings returned to the author.
- **Split panel or a close call persisting after K rounds** → `escalate` to the operator. Never auto-pass a close call. (The drain claims only `ready`; nothing ships unblessed.)
- **Judge-the-judge:** the retro/calibration loop (Epic 6b) measures whether `ready` verdicts correlate with clean merges vs. rework, and feeds corrections back to the Quality Lead's bar. The one role that holds the bar is the one role that gets measured.

---

## 6. Sources & provenance

The rubric distills, it doesn't invent:

- **Design note** `_bmad-output/planning-artifacts/design-note-2026-05-31-native-planning-and-judging.md` — §5 (judging mechanism, lens diversity, Quality Lead), §6 (the two-tier first cut this extends).
- **Planning-discipline (the 5 rules)** `_bmad-output/_archive/planning-discipline.md` — rule 1 (integration AC) → Tier 0 / Verifiability floor; rule 2 (explicit deps) → T0-4; rule 3 (ship gate) → Discipline "system stays green per story"; rule 4 (runnable ACs) → T0-6; rule 5 (integration AC first) → Discipline spine.
- **AC markers + the user-surface gate** `plugins/crew/docs/user-surface-acs.md` — the marker conventions and why "a string appears in a file" is the canonical anti-pattern.
- **Worked targets** `_bmad-output/implementation-artifacts/9-1-readiness-brake-and-minimal-intake-cockpit.md` (the PASS examples above) and `_bmad-output/implementation-artifacts/6-4-accept-proposal-id-skill-diff-then-confirm-gate.md` (gold-standard AC shape, idempotency, scope discipline).
- **The scar** bugfix-1 (the FAIL examples): green ACs that verified presence, not behaviour — the reason Verifiability is the deepest lens.

---

## 7. Open for Jack / next pass

- **Risk-tier source.** "Considered" keys off the story's risk tier — confirm it reuses the drain's existing `classifyRiskTier` rather than a separate planning-side classifier.
- **K (escalation rounds).** How many panel rounds before a close call escalates to the operator? (Proposed default: 2.)
- **Lens → role binding.** §3 proposes a judge role per lens; confirm against the hired roster (and where the Quality Lead sits) when Story 9.4 lands the role.
- **Pre-mortem trigger.** Pre-mortem is Quality-Lead discretion on the highest-risk stories — decide whether that's purely judgment or also auto-triggered above a risk threshold.
