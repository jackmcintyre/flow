# Story 8.19: Drain pauses and pings the operator on genuine ambiguity

story_shape: substrate
Status: ready-for-dev

## Story

As an **operator running an unattended drain**,
I want **a story that hits a genuine decision the dev cannot responsibly make to pause into a human-needed state and notify me with the specific question, instead of the dev guessing or the run going silent**,
So that **I am pulled in only when a real decision needs me, the rest of the drain proceeds unattended, and an under-specified story never ships a guessed-at implementation**.

This was raised after the first real end-to-end drain (2026-05-30): the operator asked whether agents could surface questions mid-run. The drain is intentionally headless — subagents cannot hold an interactive conversation — so the right shape is not chat but a deliberate pause-into-human-needed surface: the dev signals a genuine decision point, the drain parks that one story for a human (carrying the question), notifies the operator, and continues. This complements the existing risk/agreement auto-merge pause (which is about merge trust, not story ambiguity) and the existing planner-yield phrase (which is about under-specified scope) — this story is specifically about a decision a human must make to proceed correctly.

## Dependencies

- Builds on the existing `pausedForHuman` result bucket in the drain and the existing dev locked-phrase / yield precedent. No hard prerequisite, but should be authored after the drain-result surface (already shipped) so the new outcome reuses that channel rather than inventing a parallel one.

## Acceptance Criteria

**AC1 — a dev can emit a structured "needs human decision" signal carrying the question (integration):**

There is a defined, parseable way for the dev step to signal that the story has hit a decision a human must make, carrying the question text, distinct from a normal handoff, a domain-yield, and a hard block. The drain's dev-transcript processing recognises this signal and routes the story to a human-needed outcome rather than treating it as a successful handoff or a silent failure. A vitest drives the dev step emitting this signal and asserts the story is routed to the human-needed outcome with the question text preserved verbatim — not to completed, and not to a generic blocked-with-no-reason.
vitest: plugins/crew/mcp-server/src/tools/__tests__/dev-needs-human-signal.test.ts

**AC2 — the paused story carries the question into the operator-facing result and does not block the rest of the run (integration):**

A story paused for a human decision lands in the human-needed result bucket carrying its question text and ref, the dev does NOT open a PR or guess an implementation for it, and the drain continues to the next claimable story rather than halting the whole run. A drain integration test (seams stubbed) with one ambiguous story and one normal story asserts the ambiguous one appears in the human-needed bucket with its question and the normal one still completes.
vitest: plugins/crew/mcp-server/src/tools/__tests__/drain-pause-on-ambiguity.test.ts

**AC3 — the operator is notified when a story pauses for a decision (integration):**

When a story pauses for a human decision, the drain emits an operator notification naming the ref and the question through whatever notification seam the run supports, and this notification path is exercised so a future change cannot silently drop it. The test asserts a notification carrying the ref and question is emitted (via an injected notifier seam) when a story pauses, and that no notification is emitted for a story that completes normally.
vitest: plugins/crew/mcp-server/src/tools/__tests__/drain-pause-on-ambiguity.test.ts

## Notes

This is the design-heavier of the two observability stories — settle the design choices below as part of implementation and record the decisions in the completion notes; do not silently pick one without saying so.

Open design points (each needs a deliberate choice): (1) **The dev signal.** The dev persona already has locked phrases for handoff, domain-yield, and a `blockStory` path for hard blocks. A "needs a human DECISION" signal is none of those — pick whether it is a new locked phrase parsed from the transcript, a dedicated CLI seam the dev calls (preferred, per the deterministic-seam discipline — a tool-written signal is load-bearing where prose is not), or an extension of the block taxonomy with a `needs-human-decision` reason. (2) **The notification seam.** Workflow subagents run headless; the orchestrating layer is what can notify. Decide whether the drain workflow surfaces the pause in its returned result only (operator sees it on completion), or also pushes a notification mid-run — and through what channel the workflow can actually reach. Keep the binding contract "the question reaches the operator with the ref"; do not hard-wire a specific notifier the runtime may not expose. (3) **Distinguishing genuine ambiguity from a dev that just gives up.** Guard against this becoming an escape hatch the dev overuses — the signal should require a concrete question, and it is reasonable to note (not necessarily enforce this story) that overuse is a calibration concern for the retro loop.

Relevant code: the drain loop and its result buckets are in `plugins/crew/workflows/drain.workflow.js`; dev-transcript processing is `plugins/crew/mcp-server/src/tools/process-dev-transcript.ts`; the dev persona is `plugins/crew/catalogue/generalist-dev.md`; the hard-block path is the `blockStory` tool. Reuse the existing `pausedForHuman` bucket rather than adding a parallel outcome unless there is a clear reason the two must differ (if they do differ, say why in the completion notes).

This is a code change touching the dev/orchestration seam: rebuild and commit `dist/` in the same change (CI fails on `src`/`dist` drift), keep the diff scoped, and run the full `pnpm build` and `pnpm test` from `plugins/crew/mcp-server` green before opening the PR. It is a `medium`-risk change (edits the orchestration path and the dev contract) and is expected to pause the auto-merge gate for a human merge — that is correct. Do not write or edit any execution manifest or `.crew/state` file; the tools own the ledger.
