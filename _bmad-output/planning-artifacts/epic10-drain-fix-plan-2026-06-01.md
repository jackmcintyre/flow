# Epic 10 drain — fix plan (2026-06-01)

Five things surfaced during the 10.1→10.5 drain. One is a non-issue (kept here so
it's explicitly closed). Ordered by do-this-first. None blocked the batch.

Grounding checked in-code: `cli.ts:60` TOOLS map, `run-auto-merge-gate.ts`
(six-branch decision), `drain.workflow.js:234` (dev isolation flag).

---

## Fix 1 — Put `markStoryReady` on the CLI (QUICK WIN — do first)

**Problem:** The MCP server is down for the whole drain (by design — the drain is
stateless CLI). But `markStoryReady` (the "bless" mutation) was never added to the
CLI's tool map, so blessing the next story needed a hand-written `node` helper all
5 times. It's the only manual step left in the loop.

**Fix:** Import `markStoryReady` into the `cli.ts` TOOLS map (one import + one map
entry — identical to how `completeStory`, `claimNextStory`, `reapStaleWorktrees`
are already wired), add a CLI-shim round-trip test, rebuild + commit `dist/`.

**Effort:** ~30 min. **Risk:** trivial, mechanical. **Value:** bless becomes a
first-class seam; `/flow:ready` and the drain runbook stop needing a node fallback.

---

## Fix 2 — bg-isolation leak (DIAGNOSE → GUARD → durable, in that order)

**Problem:** The drain isolates each dev's edits by asking the harness for a
per-story worktree (`isolation: 'worktree'`, drain.workflow.js:234). In a
**background job** the repo's `worktree.bgIsolation: "none"` setting can suppress
that, pinning the dev's edits to the shared root checkout. Mid-10.2 I saw exactly
that (root dirty, worktree empty) — but it resolved by completion, and the leak
recurred **0/5** across the batch. So: real failure mode, unconfirmed frequency.

**2a — Diagnose (cheap, decides the rest).** Instrument one drain to log the dev
sub-agent's actual working directory. Confirms whether, under `bgIsolation:'none'`,
the dev gets its own worktree (→ no bug, 0/5 was real) or stays in root (→ bug,
10.2 was the tell). Don't build a durable fix for a bug we haven't proven recurs.

**2b — Guard (do regardless, cheap, protective).** After each story the drain
asserts the root checkout is clean; if dirty, it logs a loud warning and
auto-stashes (non-destructive) so the next story's worktree is still cut from a
clean base. Turns a silent leak into a visible, safe one.

**2c — Durable fix (only if 2a confirms recurrence).** Stop depending on the
harness flag: the drain creates the dev worktree itself (`git worktree add`) and
passes that absolute path, so isolation holds no matter the session's bgIsolation
setting. Higher effort; sequence behind the diagnosis.

**Decision for Jack:** keep running drains as background jobs (0/5 + the 2b guard —
recommended), run them foreground (isolation holds, loses walk-away), or flip
`bgIsolation` (deliberate setting; affects other bg work). Recommend **bg + guard**.

---

## Fix 3 — `needs-human` governance (DECISION — little/no code)

**Not a code bug.** The gate already pauses (never merges) on anything that isn't
`low-risk + met-threshold`, and the `needs-human` label is the correct, permanent
record that a human was required. **Do NOT strip it on merge.**

The only open question is *who the human is in an unattended run*:
- **A — any human, incl. the agent acting for Jack** (what this batch did). No change.
- **B — Jack personally merges.** Then the autonomous loop must not merge paused
  PRs — which is already the gate's behaviour; it just means the drain runbook
  shouldn't instruct the agent to merge `needs-human` PRs. Tiny runbook/flag change.

**Recommend:** **B for truly unattended runs** (agent never merges a `needs-human`
PR), **A is fine while you're supervising** (like today). Settle before 10.6/10.7.

---

## Fix 4 — Prove the auto-merge path (VALIDATION — not a code fix)

**Gap, not a bug.** All 5 stories classified medium-risk, so every one paused — the
fully hands-off path (low-risk → auto-merge, no human) never ran this batch. The
self-bootstrap ship-gate needs that path proven at least once.

**Action:** route one genuinely low-risk change (a docs/additive story, or the
backlog's 5.6 fault-injection story) through an unattended drain and confirm
auto-merge fires end-to-end with zero humans. Pure validation run.

---

## Sequencing & how to execute

1. **Fix 1** (markStoryReady → CLI) — now, via `/ship-story`. Quick win.
2. **Fix 2b** (clean-root guard) — next, cheap + protective. `/ship-story`.
3. **Decisions** — Issue 2 run-mode + Issue 3 governance (Jack, ~2 min).
4. **Fix 2a → 2c** — diagnose, then durable fix only if confirmed.
5. **Fix 4** — low-risk story through an unattended drain to prove auto-merge.

**Execution choice:** the quick wins (1, 2b) are small substrate changes → ship via
`/ship-story`, one PR each. The durable isolation fix (2c) is meatier → author it as
a native story (we now have the strict 10.x format) and drain it, which doubles as
more loop mileage. Your call whether to author all four as backlog stories or hand-
ship the two quick wins and backlog the rest.
