# Story 8.20: True drain parallelism (part 1) — each dev edits in its own worktree

story_shape: substrate
Status: ready-for-dev

## Story

As a **plugin maintainer**,
I want **the drain's dev subagent to edit and build each story inside its own dedicated git worktree — so the orchestrating checkout is never the dev's editing surface, and everything dirty in a story's worktree is unambiguously that story's own work**,
So that **concurrent drains against the same repository become safe by construction — no cross-contaminated edits, no cleanup that reverts a sibling's in-flight work — removing the unwritten "one drain at a time" rule**.

This story delivers the **isolation substrate**, not the concurrent dispatch itself: making each dev's editing surface per-worktree is what makes parallelism *safe*. Actually running N stories at once requires restructuring the serial drain loop into bounded-concurrency dispatch — that is the **part-2 follow-up (Story 8.22)**, which stands on this story. Do not change the drain loop here.

Story 8.16 (PR #212) isolated the drain dev's git **work product**: the branch, commit, and PR are produced in a per-story worktree and the orchestrating checkout is restored clean after each run. But the dev still **edits and builds** in the shared orchestrating checkout, because the workflow runtime pins the subagent's working directory there and it cannot change it. 8.16 works around this by snapshotting the checkout's dirty paths immediately before the dev edits, then transplanting only the dev's own changed paths (current-dirty minus that baseline) into the worktree afterwards, and reverting those paths in the checkout on cleanup. That is correct for **serial** drains but breaks for **concurrent** ones: two devs editing the same checkout cross-pollute each other's baseline-diff attribution (each sees the other's edits as "its own" changes), and one flow's cleanup reverts files the other is still actively editing.

The fix is to make the dev's **editing surface** the worktree, by spawning the dev with its working directory set to the worktree rather than to the orchestrating checkout. This also **removes a whole class of fragile logic**: a worktree cut clean from the base means every dirty path in it *is* the dev's work, so the baseline-snapshot-and-subtract attribution 8.16 needed disappears entirely — the explicit-path transplant collapses back to a plain whole-worktree stage. The correctness floor 8.16 fought for (no stray pre-existing change in a commit) is then preserved *structurally* rather than by careful bookkeeping.

This approach rests on one capability that must be confirmed before building (see Notes — **precondition spike**): the runtime must be able to root the dev subagent in the worktree. The dev's own file-editing tools are sandboxed to their working directory, so the dev cannot write into a worktree outside that root — the editing surface must *be* the worktree, not a path handed to a checkout-rooted dev.

## Dependencies

- Builds directly on Story 8.16's worktree helper and the drain workflow's dev step, and follows the same isolated-worktree precedent the reviewer already uses for the PR branch (Story 5.26). It supersedes 8.16's transplant-after-edit mechanism with edit-in-place-inside-the-worktree, and in doing so removes the baseline-diff attribution. It must preserve 8.16's correctness floor even when only one drain runs: no stray pre-existing change is ever swept into a story's commit, and the orchestrating checkout is left untouched.
- **Precondition spike (do this before claiming the build):** confirm the drain runtime can spawn the dev subagent rooted in a worktree (a per-agent working-directory override, or the workflow substrate's own per-agent worktree isolation primitive). If it cannot, edit-in-worktree is infeasible and this story must be re-scoped — surface that from the spike rather than discovering it mid-build.
- The concurrent-dispatch follow-up (Story 8.22) depends on this story; it is out of scope here.

## Acceptance Criteria

**AC1 — the dev edits inside its own worktree; the orchestrating checkout never holds the dev's edits (integration):**

Given a drain claims a story, the dev's file edits and build occur inside a git worktree distinct from the orchestrating checkout, such that `git -C <orchestrating-checkout> status --porcelain` never reports the dev's files as dirty at any point during or after the dev step — there is no transplant-then-restore window in which the shared checkout holds the edits. A vitest exercises the drain's dev step (gh/network terminal action stubbed) against a temp git repo and asserts the dev's changes appear only in the worktree and the orchestrating checkout stays clean throughout.
vitest: plugins/crew/mcp-server/src/tools/__tests__/dev-edits-in-worktree.test.ts

**AC2 — a pre-existing dirty change in the checkout never rides into the story commit (integration):**

Given the orchestrating checkout holds an unrelated uncommitted change present before and during the dev step, that change appears in neither the story's worktree nor its commit — preserving the correctness floor Story 8.16 guaranteed, now structurally (the worktree is cut clean from the base, so only the dev's own edits exist in it). A vitest seeds a stray dirty file, runs the dev step, and asserts the resulting commit's file list excludes the stray file and the stray file is left untouched in the checkout.
vitest: plugins/crew/mcp-server/src/tools/__tests__/dev-edits-in-worktree.test.ts

**AC3 — two workers against the same repo concurrently produce two correct, non-cross-contaminated commits with no double-claim and no git-lock failure (integration):**

Given two stories built concurrently against the same repository: the atomic claim hands each worker a distinct story (one ref is never claimed twice), each worker's concurrent worktree creation and commit succeed without failing on shared-`.git` lock contention, and each resulting commit contains exactly that story's own changes — no file authored by the sibling leaks in, none of a worker's own files go missing, and neither worker sees the other's claimed work-queue entry. A vitest drives two real claim→worktree→commit flows concurrently (gh/network stubbed) against one temp git repo and asserts these properties.
vitest: plugins/crew/mcp-server/src/tools/__tests__/concurrent-drains-isolation.test.ts

**AC4 — cleanup is concurrency- and crash-safe; no worktree leaks (integration):**

After a story completes or its dev step fails, its worktree is removed without disturbing any sibling worktree still in use; a failure in one flow neither wedges nor reaps another flow's worktree, and no orphaned worktree for the failed story survives the step. In addition, a worktree left behind by a worker from a prior, now-dead session is reaped on a subsequent drain — not leaked because the stale-reap keyed only on the live session. The test asserts a mid-build failure in one flow leaves a concurrent flow's worktree intact, that no leftover worktree for the failed story survives, and that a stale worktree from a dead session is reaped on the next run.
vitest: plugins/crew/mcp-server/src/tools/__tests__/concurrent-drains-isolation.test.ts

## Notes

This is **part 1 (the isolation substrate)** of the true-parallelism work; the **part-2 follow-up (`bmad:8.22`)** restructures the serial drain loop into bounded-concurrency dispatch and is what actually runs N stories at once. This story makes that safe by construction — keep the drain loop serial here and prove isolation in the tests by driving the dev step / worktree helper concurrently.

**Precondition spike (do first, before building):** the crux is the constraint 8.16 worked around rather than solved — the runtime pins the dev subagent's working directory to the orchestrating root, and the dev's file-editing tools are sandboxed to that root, so the dev cannot write into a worktree outside it. The only viable shape is therefore to spawn the dev with its working directory **set to** the worktree (the editing surface must *be* the worktree); handing the dev absolute worktree paths is blocked by that sandbox and must not be proposed. Confirm the runtime can do this — a per-agent working-directory override, or the workflow substrate's own per-agent worktree isolation primitive. If neither exists, stop and re-scope (e.g. orchestrate the whole per-story flow in a worktree) rather than building on a capability the runtime lacks.

Design points to settle and record in the completion notes: (1) **Editing surface = worktree.** Resolve via the spike above; prefer the runtime's own isolation primitive if it exists over hand-managed worktrees the runtime is unaware of — the latter can collide with any worktree the runtime itself creates, and must be reconciled with the runtime's concurrency model. (2) **Drop the baseline-diff machinery.** Once the dev edits in a clean worktree, the snapshot-dirty-paths baseline and the current-minus-baseline transplant are no longer needed; remove that now-dead plumbing rather than leaving it inert, while keeping AC2's regression guard. (3) **Worktree location.** Today the worktree nests inside the orchestrating checkout under the gitignored state directory; for parallel editing prefer a sibling location *outside* the checkout (so a dev's file search/scan never recurses into a nested self-copy), or explicitly prove the nesting is harmless. (4) **Crash-orphan reaping.** A worker that dies mid-build leaves a worktree keyed by its dead session id; the existing stale-reap only matches the live session's path, so cross-session leftovers accumulate. The crash-recovery scan already identifies dead sessions — have it also reap their leftover worktrees (AC4).

Already-solid — do not re-litigate: claiming is atomic (a single-syscall rename — one worker wins, the loser gets a clean miss), so double-claim is safe under true concurrency; `git worktree add --detach` already composes with concurrency and keeps the base branch usable in the orchestrating checkout; the build and `gh pr create` already run with the repo root pointed at the worktree.

Relevant code: the 8.16 worktree helper `plugins/crew/mcp-server/src/lib/dev-story-worktree.ts` (the runtime-cwd comment near the top, the snapshot/transplant in `materialiseDevStoryWorktree`, and the orchestrating-checkout-restore in its `cleanup()`); the drain dev step and the **serial main loop** in `plugins/crew/workflows/drain.workflow.js` (left unchanged here — restructured in `bmad:8.22`); the git seam `plugins/crew/mcp-server/src/tools/run-dev-terminal-action.ts` (builds and opens the PR with the repo root pointed at the worktree via `gitRoot`); and the sibling worktree precedent `plugins/crew/mcp-server/src/lib/materialise-pr-branch-worktree.ts` (Story 5.26). There is a static `canonical-fs-guard` test governing which files may spawn `git` directly — reconcile any new worktree spawning with it exactly as 8.16 did; read that guard before wiring.

This is a code change touching the orchestration path and the git seam: rebuild and commit `dist/` in the same change (CI fails on `src`/`dist` drift), keep the diff scoped to the dev step + the dev terminal action + the worktree helper + the new tests (+ any small git helper addition), and run the full `pnpm build` and `pnpm test` from `plugins/crew/mcp-server` green before opening the PR. It is a `medium`-risk change (edits existing orchestration source and the git seam) and is expected to pause the auto-merge gate for a human merge — that is correct. Do not write or edit any execution manifest or `.crew/state` file; the tools own the ledger. Literal refs (`bmad:8.20`, `bmad:8.22`) and state paths (`.crew/state`, `sprint-status.yaml`) are kept here in Notes and out of the AC text above so the planning-discipline scanner does not false-positive.
