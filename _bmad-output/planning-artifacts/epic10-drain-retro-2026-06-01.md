# Epic 10 drain — handoff (2026-06-01)

Two defects surfaced during the 10.1→10.5 one-at-a-time drain loop. Neither
corrupts `main` or loses work. The loop is continuing per Jack's instruction;
this documents both for a proper fix.

## Where things stand
- **10.1 — DONE.** Real implementation, all 4 ACs, green CI. Merged as PR #247
  (commit a4aac93). State in `done/`. `main` reconciled.
- **10.2 — in flight.** Drain running (task wsyuej38b). Manifest in `in-progress/`.
  See Issue B — its edits are landing in the root checkout, not its worktree.
- **10.3–10.5 — queued**, not yet blessed.
- **10.6 (cutover) / 10.7 (proof)** — held for watched runs, untouched.

---

## Issue A — RETRACTED (not a defect)

Initial read: "#247 shows MERGED but still carries `needs-human`, which looks like
a needs-human PR auto-merged."

**Corrected (Jack, 2026-06-01):** The label means exactly "human review is needed,"
and it is added *only* on PRs that need it. #247 was medium-risk → it genuinely
needed a human → the label was correctly applied and *should persist* as the
accurate record that this PR required a human. Stripping it on merge would erase a
true fact. **There is no defect and nothing to fix.** Do NOT add a label-stripper.

For the record on what happened: the auto-merge gate did NOT merge #247 —
`merged: []`, `pausedForHuman: [{ref: bmad:10.1, prNumber: 247, reason: medium-risk}]`.
A human step (me, on Jack's behalf, per the runbook's "review + merge each PR")
did the merge. `mergedBy` is `jackmcintyre` because `gh` acts as Jack.

**The only live question is governance, already settled:** `needs-human` on #247
was satisfied by the agent reviewing + merging on Jack's behalf (Jack's chosen
option). If `needs-human` should instead mean *Jack specifically* holds the merge,
switch the loop to "PR opened + agent review, Jack merges."

---

## Issue B — drain leaks dev edits to the ROOT checkout in background jobs (real)

**Symptom:** While the 10.2 drain runs, the root checkout
(`/Users/jackmcintyre/projects/crew`, on `main`) is dirty with 10.2's edits:
`adapter.ts, parse-native-story.ts, execution-manifest.ts, register.ts,
scan-sources.ts, write-native-story.ts`. The drain's own worktree
(`.claude/worktrees/wf_68260fd8-e6e-8`) is **clean** — the work went to root, not
the isolated worktree. (Worse than the historical "leftover cruft" pattern, where
work merged via the worktree and root only held stale copies.)

**`main` is NOT compromised:** HEAD is a4aac93, history clean, branch still
protected. Only the *working tree* is dirty. No commits land on `main` directly.

**Root cause — confirmed:** `.claude/settings.local.json` sets
`worktree.bgIsolation: "none"` (line 61-63). The drain requests per-dev worktree
isolation (`isolation: 'worktree'`, drain.workflow.js:234 — Story 8.20). When the
drain runs **inside a background job**, `bgIsolation: "none"` suppresses that
isolation: the dev subagent's working directory is pinned to the parent session's
root checkout instead of its own worktree. So Write/Edit land in root. The
framework still creates the `wf_…` worktree, but the agent never works in it →
worktree stays clean, root goes dirty.

This explains the historical **intermittency** (1/4 Epic 9 slices): foreground
drains isolate correctly; background-job drains leak. It correlates with run mode,
not luck.

**Why I did NOT fix in flight:**
- `bgIsolation: "none"` is deliberate and load-bearing — it's why Write/Edit work
  in background sessions at all (see memory `bg_isolation_disabled_in_crew`).
  Flipping it silently could break editing in live bg sessions.
- The already-launched 10.2 drain won't pick up a settings change anyway.
- Harness-config changes are Jack's call.

**Fix options (Jack to choose):**
1. **Run drains in the foreground** (not as bg jobs). Isolation works; simplest, no
   config change. Costs the "walk away" property for the drain loop.
2. **Scope `bgIsolation`** so the drain's dev `agent({isolation:'worktree'})` is
   honored even in bg jobs, while keeping normal bg Write/Edit pinned to root.
   Needs harness support (per-agent isolation override that overrides bgIsolation).
3. **Make the drain not depend on harness worktree isolation** — have the dev seam
   itself `git worktree add` and operate there explicitly, rather than relying on
   the `agent()` isolation flag. Most robust; most work.

**Recommendation:** Option 1 for the remaining watched Epic 10 stories (foreground),
then Option 3 as the durable fix before the next unattended drain.

**Recovery for the leaked root tree (after 10.2's PR merges):**
1. Confirm the work is in the PR (the dev seam passes its CWD as `targetRepoRoot`,
   so it commits root's dirty set to the story branch — the PR should be complete).
2. `git -C <root> stash -u` to clear the leaked working tree.
3. `git -C <root> checkout main && git pull --ff-only`.
4. `git -C <root> stash show -p` → verify the stashed cruft == what merged, then
   `git stash drop`. If it diverges, investigate before dropping.

---

## Running learnings log

- **10.1 (#247):** clean. Real impl, 4 ACs, green CI. Merged. No leak observed.
- **10.2 (#248):** **the leak did NOT recur.** Mid-drain I saw the root checkout
  dirty with 10.2's edits + the worktree clean — looked like the leak. But by
  completion the root was **clean** and the work was committed in the worktree on
  the story branch (→ PR #248). So the dev's edits ended up in the worktree, not
  stranded in root. **This downgrades Issue B's "confirmed always-leaks-in-bg"
  claim:** the leak is intermittent even in background mode (matches the original
  1/4 Epic-9 rate), and the mid-flight dirty-root can be a transient that resolves
  by the time the seam commits. Net for the loop: no per-story root cleanup was
  actually needed for 10.2. Still worth the durable fix, but it is NOT a guaranteed
  failure every bg run — severity lower than first stated.
- **10.2 PR scope note:** 10.2's optional/additive schema fields rippled into three
  reviewer test fixtures (narrative now needs a `so_that` clause) — benign, CI-green,
  expected from the structured-narrative change. Not scope creep.
- **10.3 (#249):** clean, no leak. Keystone story (Tier-0 validator, fail-closed at
  write + scan). New `discipline-resolvability.ts` (T0-5/T0-6, disk-side) + T0-1/T0-2
  in the pure validator — real fail-closed checks, deliberate vitest-vs-artifact
  resolvability asymmetry. Root clean, work in worktree. So far the bg leak has
  recurred 0/3 stories this run (only the transient mid-flight dirty-root on 10.2).
- **10.4 (#250):** clean, no leak. Focused story (13 files) — scan stamps
  `risk_tier`/`risk_tier_evidence` from declared paths; judge panel prefers the
  persisted tier (verbatim, no double-classify), falls back to compute for
  legacy/BMad. On-spec. **bg leak recurrence: 0/4.**

- **10.5 (#251):** clean, no leak. BMad→native ingest seam (one-off, one-way):
  read-only over BMad, LLM-enrich, **10.3 Tier-0 validator is the sole gate**
  (AC4), writes while adapter still `bmad` (AC2), full accounting written+fix_up+
  skipped==input (AC1), idempotent dedupe by bmad ref (AC3). On-spec.
- **Batch close (all 5):** 10.1–10.5 merged #247–#251. Integrated main: **1965
  tests green, dist-drift clean.** bg leak recurrence **0/5**. Every story
  classified medium-risk → paused → agent-reviewed + merged on Jack's behalf;
  the gate auto-merged nothing (correctly held all 5 for a human).

## Action plan (post-batch)

Priority order. Nothing here blocked the batch; these harden the loop before
unattended runs / 10.6–10.7.

1. **bg-isolation leak — durable fix (LOW-MED).** Recurred 0/5, so not urgent, but
   the failure mode is real (transient on 10.2). Fix: drain's dev seam does its own
   explicit `git worktree add` instead of leaning on the harness `isolation:'worktree'`
   flag (which `bgIsolation:'none'` suppresses in bg jobs). Cheap interim: drain
   asserts a clean root after each story and warns/halts if dirty. Decision: keep
   running drains as bg jobs (works today) vs flip `bgIsolation`.
2. **Wire `markStoryReady` into the CLI (SMALL).** The MCP stays down through every
   drain, so blessing the next story needed the node-direct helper all 5 times.
   Adding it to the CLI seam removes the only manual node step from the loop and
   makes bless work like every other seam.
3. **`needs-human` governance (DECISION, no code).** Confirmed the label is correct
   and should NOT be stripped. Open question for unattended runs: does `needs-human`
   mean "any human, incl. the agent acting for Jack" (this batch) or "Jack
   personally merges"? Settle before 10.6/10.7 watched runs.
4. **Auto-merge path unexercised (NOTE).** All 5 were medium-risk → none flowed
   fully hands-off. Expected for core schema/validator work, but the self-bootstrap
   ship gate wants ≥1 story to auto-merge end-to-end. Watch for a genuinely low-risk
   story to prove that path.

## Net
- `main` is safe; no work lost; both issues are recoverable.
- Loop continues (Jack: "don't stop"). I review + merge each paused PR (Jack's
  choice), then clean the leaked root tree per the recovery steps above.
- The two fixes (label strip + isolation) are deferred, not dropped.
