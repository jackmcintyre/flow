# Success Criteria

> **Reframed 2026-05-27** — proof-point posture, not market-launch. v1 ship gate moved from "external stranger installs cold" to "crew builds itself." Original framing preserved as the **stretch / writeup-supporting gate** below. See `sprint-change-proposal-2026-05-27-reframe.md`.

## The single test of success (scenario, not metric)

**Crew builds itself: one clean autonomous `/flow:start` cycle completes end-to-end on the crew repo — claim → dev → review → merge — without Jack manually intervening in any step.**

If this happens once cleanly, the product works as a self-bootstrapping engineering team. The substrate is autonomous, the calibration mechanism works on its own work-product, and the proof-point for the eventual writeup is in hand.

Substrate-only autonomy with manual reviewer/merge intervention (the canary-1 / canary-2 shape during Epic 5) counts as **partial** — useful as a substrate validation, but not the full gate. The full gate requires no manual hand on any step including the reviewer verdict and the merge.

## User Success (v1 user: Jack-as-operator)

User success looks like:

- **"I primed the backlog, walked away, came back to merged PRs."** Continuous-flow loop ran without babysitting or rescue.
- **"I trusted what shipped without reading every line."** Reviewer + standards did enough work that the user merged on skim, not on full diff inspection, for the majority of stories.
- **"I caught misdirection at the backlog level, not at the diff level."** When agents shipped the wrong thing, the user's recovery was re-priming the queue, not hand-debugging code.
- **"The retro told me something I didn't already know."** At least once per cycle, the retro named a pattern the user wouldn't have noticed unaided.

## Technical Success

- **End-to-end run on Jack's machine** without manual intervention beyond the initial `/flow:start` command.
- **No silent failure modes.** Every agent failure produces a visible artifact (blocker story, `needs-human` label, retro entry, orchestration surface). Nothing fails into a state the user only notices days later.
- **State is recoverable.** Filesystem state (`to-do/` / `in-progress/` / `blocked/` / `done/`) is enough to resume after session death. No daemon dependency.
- **Reviewer trusted enough to auto-merge low-risk.** Verdict-vs-action agreement crosses the auto-merge threshold without producing a regression that ships.

## Stretch / Writeup-Supporting Gate

**"External stranger installs cold and reaches first merged PR in under one hour."**

Deferred past v1 ship per the 2026-05-27 reframe. Pursued only after self-bootstrap is demonstrably stable across multiple cycles. The bundled example + canary suite (Epic 7) ships in service of this stretch gate, with timing following Epic 6b.

A failed external-user attempt at this stretch stage is still a valuable signal — first non-Jack data point on the install path; grist for the eventual writeup.

## Measurable Outcomes

| Outcome | Target | When measured |
|---|---|---|
| Self-bootstrap cycle succeeds (full gate) | ≥1 clean autonomous `/flow:start` cycle, no manual intervention | Within Epic 6a ship |
| Manual-intervention count per cycle | Decreasing across Epic 5; 0 by Epic 6a complete | Per cycle |
| Calibration loop closing | ≥1 accepted rule/skill proposal per cycle | Continuous (after 6b) |
| Silent failures (agent fails without visible artifact) | 0 | Continuous; trip-wire |
| External-user canary (stretch) | ≥1 success | After Epic 7 ships (post-self-bootstrap) |
