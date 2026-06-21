# Story 8.22: True drain parallelism (part 2) — drain dispatches stories to concurrent workers

story_shape: substrate
Status: ready-for-dev

## Story

As a **plugin maintainer**,
I want **the drain to claim and process several stories at once — up to a sane concurrency cap — instead of strictly one at a time, with each story still landing in exactly one result bucket**,
So that **a backlog of ready stories drains in parallel wall-clock time rather than serially, now that per-dev editing isolation makes concurrent runs safe**.

This is **part 2** of the true-parallelism work. Part 1 (Story 8.20) makes each dev's editing surface its own worktree, so two stories built at once can no longer corrupt each other's edits. This story turns that latent safety into actual throughput: the drain's main loop is strictly serial today — it claims one story, runs it end-to-end (dev → review → verdict → gate), and only then claims the next. This story restructures that loop to dispatch several claimed stories concurrently, bounded by a cap, aggregating their outcomes into the existing result buckets.

The hard requirement is that concurrency changes **throughput only, never correctness**. Every story still lands in exactly one of completed / merged / pausedForHuman / blocked; the drain reason stays honest; a per-worker failure is isolated — it neither aborts the whole run nor poisons a concurrently-running sibling; and crash-recovery still works. The no-silent-failures result surface (Story 8.14) is the contract this composes *with*, not around.

## Dependencies

- **Hard prerequisite: Story 8.20** (per-dev editing isolation). Running this loop concurrently before 8.20's worktree isolation lands would reproduce the exact cross-contamination collision that motivated both stories (two devs editing one shared checkout). Do not implement until 8.20 is merged.
- Builds on the drain's result-bucket and exit-reason surface (Story 8.14) and the atomic claim. Composes with crash-recovery: orphan resume runs before the main loop, as today — this story keeps that ordering and makes only the main loop concurrent.

## Acceptance Criteria

**AC1 — the drain processes multiple claimed stories concurrently, bounded by a configured cap (integration):**

The drain claims and runs more than one story at a time up to a configured maximum concurrency, rather than strictly serially; given a backlog larger than the cap, at most `cap` stories are in flight at once and every story is eventually processed exactly once. A vitest drives the drain (seams stubbed) against a backlog of several stories with the cap set low, and asserts that more than one story is in flight simultaneously, that the number in flight never exceeds the cap, and that each story is processed exactly once.
vitest: plugins/crew/mcp-server/src/tools/__tests__/drain-concurrent-dispatch.test.ts

**AC2 — concurrency changes throughput only, not the result (integration):**

For a given backlog and a fixed set of stubbed per-story outcomes, the set of result buckets (completed / merged / pausedForHuman / blocked) and the drain reason are identical whether the drain runs serially (cap 1) or concurrently (cap greater than 1) — no story is lost, double-counted, or mis-bucketed under concurrency. A vitest runs the same backlog at cap 1 and at cap N and asserts the two structured results are equal, modulo the ordering of entries within a bucket.
vitest: plugins/crew/mcp-server/src/tools/__tests__/drain-concurrent-dispatch.test.ts

**AC3 — a per-worker hard failure is isolated; the run and its siblings survive (integration):**

A story whose worker hard-fails (a dev error, a seam failure, a build crash) lands in the blocked-or-paused bucket carrying its reason and does NOT abort the whole drain or disturb any concurrently-running sibling; the other in-flight stories still complete and land in their correct buckets. A vitest injects a hard failure into one concurrent worker and asserts the run completes, the failed story is bucketed with its reason preserved, and every sibling story reaches its expected bucket.
vitest: plugins/crew/mcp-server/src/tools/__tests__/drain-concurrent-dispatch.test.ts

## Notes

This is the throughput half of the true-parallelism work; the isolation half it stands on is `bmad:8.20`. Keep the change scoped to the drain's main loop and its result aggregation — do not touch the per-dev worktree mechanism (that is 8.20's surface). Settle the design choices below as part of implementation and record the decisions in the completion notes; do not silently pick one without saying so.

Design points to settle: (1) **The concurrency cap.** Pick a sane default and decide where it is configured (a drain arg, mirroring the existing `maxStories` / `maxRework` knobs). If the workflow substrate exposes its own concurrent-agent cap, mirror or defer to it rather than inventing a conflicting second limit. (2) **The dispatch shape.** Prefer the workflow substrate's own concurrency primitives (a bounded `parallel`/`pipeline` with per-item failure isolation — a throwing item drops to a null result rather than aborting the whole batch) over hand-rolled `Promise.all`, so one worker's failure can never take down the run or its siblings; if hand-rolling is unavoidable, replicate that per-item isolation explicitly. (3) **Result aggregation under concurrency.** The result buckets are mutated in place by the serial loop today; under concurrency, ensure per-worker bucket writes do not race — collect each worker's outcome and merge after, or use append-only pushes that are safe under the runtime's concurrency model — and confirm the drain reason is derived once from the merged result, not from whichever worker finishes last. (4) **Crash-recovery ordering.** Orphan resume still runs before the concurrent main loop; confirm that a resumed story and a freshly-claimed story can never both pick up the same ref under concurrency (the atomic claim already guards the to-do queue; verify the resume path composes with it).

Already-solid — do not re-litigate: claiming is atomic (a single-syscall rename — one worker wins, the loser gets a clean miss), so two concurrent claims can never hand out the same story; the result-bucket / drain-reason surface (Story 8.14) is the honest-exit contract to preserve exactly.

Relevant code: the serial main loop (`for (let i = 0; ; i++)` over `claimNextStory`) and `processStory` in `plugins/crew/workflows/drain.workflow.js`; the result-bucket and drain-reason surface from `bmad:8.14`; the atomic claim `claimNextStory` / `claimStory`; and the per-dev editing isolation from `bmad:8.20`, which this story requires.

This is a change to the orchestration loop: keep the diff scoped to the drain workflow loop + its result aggregation + the new tests (and a small concurrency-cap knob if added). If the change touches `mcp-server/src`, rebuild and commit `dist/` in the same change (CI fails on `src`/`dist` drift); run the full `pnpm build` and `pnpm test` from `plugins/crew/mcp-server` green before opening the PR. It is a `medium`-risk change (it restructures the orchestration loop) and is expected to pause the auto-merge gate for a human merge — that is correct. Do not write or edit any execution manifest or `.crew/state` file; the tools own the ledger. Literal refs (`bmad:8.20`, `bmad:8.22`) and state paths (`.crew/state`, `sprint-status.yaml`) are kept here in Notes and out of the AC text above so the planning-discipline scanner does not false-positive.
