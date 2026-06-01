# AI-reviewer-can-merge — guardrail spec (2026-06-01)

**Decision (Jack, 2026-06-01):** the AI reviewer is "the review" for code changes —
a change that edits existing code may **auto-merge on the reviewer's approval**,
under guardrails, with no human eyeball. This redraws the line for what counts as
"needs human," consistent with [[feedback_agent_never_merges_needs_human]] (we're
shrinking what trips it, not overriding it).

Today the gate (`lib/auto-merge-gate.ts`) auto-merges only `low` (docs-only or
100%-new-files). `medium` (anything editing existing code) always pauses. This spec
adds an **earned-trust auto-merge path for medium**, keeps the dangerous classes
always-human, and ramps trust on evidence.

---

## The bar — ALL must hold for a medium PR to auto-merge

1. **CI green** — full project build+test passes (already enforced by the Stage-2
   CI gate; non-negotiable).
2. **Reviewer APPROVED, no changes requested** — not "approved with nits." A clean
   verdict. (Today low auto-merges on agreement alone; medium additionally requires
   an explicit clean reviewer verdict.)
3. **Judge-panel agreement ≥ a HIGH medium-threshold** — strictly higher than the
   low-risk threshold. The K=2 panel must strongly agree the work is correct.
4. **Diff bounded** — under a medium line cap, tighter than low's 300. Big diffs =
   big blast radius → human.
5. **Tier-0 passed** — native story, every AC machine-verifiable, validator green
   (10.3). A story whose ACs aren't checkable can't auto-merge.
6. **Not in the always-human set** (see below).

Fail any → pause + `needs-human` (unchanged behavior).

## Always-human set (never auto-merges, regardless of signals)

- **Migrations / schema changes** — already `high`. Unchanged.
- **The guardrail machinery itself** — the auto-merge gate, the risk classifier,
  the risk-tiering spec (`docs/risk-tiering.md`), permission allowlists, CI
  workflows (`.github/**`), branch-protection config, dependency manifests/lockfiles.
  *Invariant: the system can never auto-merge a change that loosens its own
  guardrails.* This is the single most important rule here.
- **Security/auth-adjacent paths** — a named exclude list (extends the existing
  `path_excludes`).

## Earn it incrementally (don't flip it all on)

- **Start in "provisional" / off-by-default**, behind a track record: medium
  auto-merge activates for a role only after N consecutive human-confirmed clean
  merges (reuse Epic 6's promotion-threshold / calibration machinery — #245).
- **Start with the lowest-blast-radius slice** — e.g. test-only or single-module
  changes — and widen as agreement history proves out.
- The retro loop owns the numbers (threshold, diff cap, N). They start conservative
  and move on evidence, not by guess.

## Safety controls / operability

- **Kill-switch** — a config (`medium_auto_merge: off | provisional | on`) so you
  can disable instantly if something slips. Defaults `off`.
- **Distinct label + audit comment** — every AI-auto-merged PR gets an
  `auto-merged` label and a comment recording the reviewer verdict + agreement
  score + tier evidence, so it's auditable after the fact.
- **"While you were away" digest** — a summary of what auto-merged during an
  unattended run, for after-the-fact review.
- **Easy revert** — auto-merged PRs are squash-merges (already), trivially
  revertable; the digest links each.

## What to build (extends, doesn't reinvent)

- `decideAutoMerge` — replace the medium always-pause branch with the earned-trust
  branch (new reason e.g. `medium-risk-earned-trust`); thread the new inputs
  (reviewer verdict, diff size, tier-0 pass, trust state).
- Gate tool (`run-auto-merge-gate.ts`) — gather + enforce the reviewer-clean,
  diff-cap, path-exclude, tier-0, kill-switch checks before calling the decision fn.
- Classifier / spec — add the always-human path excludes for the guardrail
  machinery; optionally add explicit medium rules.
- Observability — label, audit comment, digest.

This is real, multi-story work with a safety-critical core — it should be **planned
as a small epic** (or folded into the Epic 6 calibration line), authored as native
stories now that we have the strict 10.x format, and itself drained. The first
auto-merged behavior-change is the moment the product crosses from "assists" to
"replaces" — worth doing deliberately.

## Recommended starting calibration (all tunable by the retro loop)

- medium threshold: **above** the low threshold (start strict).
- diff cap: well under 300 lines (start ~150).
- trust: **provisional, off by default**; require a clean track record before
  enabling; first slice = test/single-module changes.
- always-human set: as above, erring inclusive.
