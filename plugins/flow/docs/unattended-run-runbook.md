# Operator runbook — unattended multi-story run

> **Goal:** queue a stack of low-risk stories, launch the run, walk away, and
> come back to a stack of merged (or human-pending) PRs — without re-deriving the
> invocation from the workflow source each time.

This runbook walks the end-to-end operator flow for the `flow-run` workflow
(`plugins/flow/workflows/internal/run.workflow.js`). For each story the run claims the
next ready story, runs the generalist-dev to implement it and open a PR, runs the
reviewer, derives a verdict, and runs the auto-merge gate. It does this entirely
through one-shot CLI seams, so no persistent MCP server sits on the run path.
The main loop runs up to `maxConcurrency` stories at once (Story 8.22, default 2);
each dev works inside its **own per-story git worktree** (Story 8.20), so
concurrent devs never cross-contaminate edits. It also recovers crash-orphaned
stories left by a prior run before claiming new work.

## 1. Queue the stories

The run only ever works the **claimable to-do queue** — it cannot author
stories. Before you launch it, get the stories you want run into that queue:

1. **Author or confirm the stories.** Each should be a real, ready-for-dev
   story spec in your backlog. For an unattended run, favour **low-risk**
   stories — docs-only or purely-additive changes — so the auto-merge gate can
   take them the whole way without a human eyeball. (Risk tiers are defined in
   [`risk-tiering.md`](./risk-tiering.md).)
2. **Materialise the stories.** For native-adapter repos, stories are materialised
   into `.flow/state/to-do/` automatically when authored via `/flow:plan` or
   `/flow:author`. For BMad-adapter repos, run `/flow:plan` after authoring BMad
   stories — the planning flow scans on exit automatically. Only stories that
   land in `to-do/` are claimable by the run. If you have hand-edited a source
   story file directly, re-run `/flow:plan` to pick up the changes.
3. **Approve the stories with `/flow:ready`.** Materialised stories land in `to-do/` as
   **not ready**. The readiness brake (Story 9.1) is fail-closed: the run claims
   **nothing** until you approve it. Mark each story you want run as `ready` via
   `/flow:ready` (the underlying `markStoryReady` is also a one-shot CLI seam, so
   the same approval works mid-run when the MCP server is down). A plan→launch with
   no approval runs zero stories — that is the brake working, not a bug.

After approving, confirm the manifests are present (`.flow/state/to-do/`) and
`ready` before launching. A story whose dependencies are not yet in
`.flow/state/done/` will not be claimed until those deps complete.

## 2. Launch the run

> **Canonical launch path: `/flow:run`**
>
> The `/flow:run` skill (Story native:01KTMKPHNDMBFS4APB5RKGZWR4) is the
> canonical way to start the run. It automatically resolves `targetRepoRoot`
> from the Claude Code workspace and `cli` from the plugin install location,
> pre-flight-checks both paths, and forwards any optional run knobs you name.
> Use it in preference to constructing the raw Workflow invocation by hand.
>
> ```text
> /flow:run
> /flow:run maxStories=3
> /flow:run maxConcurrency=1 devReviewerModel=opus
> ```
>
> The raw Workflow invocation documented below remains valid as a fallback when
> the skill is unavailable (e.g. working from a dev `--plugin-dir` checkout
> that predates Story native:01KTMKPHNDMBFS4APB5RKGZWR4).

### Raw Workflow invocation (fallback)

Run the `flow-run` workflow directly via the Workflow tool. It takes three inputs:

| Arg | Required | What it is |
|-----|----------|------------|
| `targetRepoRoot` | yes | Absolute path to the repo being built (the repo whose stories you are running). |
| `cli` | yes | Absolute path to the plugin's compiled CLI entrypoint, `mcp-server/dist/cli.js`. This is the stateless seam transport and lives in the **plugin**, not the target repo. |
| `maxStories` | no | A positive-integer safety cap on stories claimed this run. Omit it to run until the queue is empty. See [§3](#3-unattended-walk-away-mode-vs-the-safety-cap). |
| `maxConcurrency` | no | How many stories the main loop runs at once (Story 8.22). Default 2; set `1` for the historical strictly-serial loop. Per-dev worktree isolation (8.20) makes >1 safe. |

The workflow `args` are delivered as a JSON string. A typical launch passes:

```json
{
  "targetRepoRoot": "/absolute/path/to/your/target/repo",
  "cli": "/absolute/path/to/plugins/flow/mcp-server/dist/cli.js"
}
```

> ### The `scriptPath` MUST be absolute
>
> When you point the Workflow tool at the run script, the `scriptPath` you
> pass **must be an absolute path** (e.g.
> `/Users/you/projects/crew/plugins/flow/workflows/internal/run.workflow.js`).
>
> A **relative** path is resolved against the plugin directory, which **doubles
> the prefix** — the runtime looks for the script under the plugin dir *plus*
> your relative path and fails to find it. Always pass the fully-qualified
> absolute path to `workflows/internal/run.workflow.js`.

The `cli` arg above has the same constraint for the same reason: it is an
absolute path to `mcp-server/dist/cli.js`, never a relative one.

## 3. Unattended "walk away" mode vs. the safety cap

This is the headline behaviour of the run:

- **`maxStories` omitted → unbounded run.** The loop runs until the queue is
  empty. This is the unattended "walk away" mode: launch it, leave, and come
  back to the finished stack. When the queue empties, the workflow returns with
  `runReason: "queue-emptied"` and `queueEmptied: true`.
- **`maxStories` set to a positive integer → capped run.** The loop stops after
  claiming that many stories, even if more remain in the queue. The cap is a
  **safety backstop**, not a queue state: it returns
  `runReason: "max-stories-reached"` and `queueEmptied: false`. Use it when you
  want to babysit the first few stories of a long backlog before letting the
  rest run unattended. (A non-positive or garbage value is treated as omitted —
  i.e. unbounded.)

**Why an unbounded run always terminates:** claiming a story is **atomic** —
`claimNextStory` moves the manifest from `.flow/state/to-do/` to
`.flow/state/in-progress/` in one step, so the to-do queue **strictly shrinks**
by one on every successful claim. Because the queue can only get smaller, the
loop is guaranteed to reach an empty queue and exit; an unbounded run cannot
loop forever.

The run never silently swallows a story. When it finishes, every claimed ref
lands in exactly one bucket of the return object:

- `merged` — the auto-merge gate took the PR all the way.
- `pausedForHuman` — the verdict was green but the gate held the PR for a human
  to merge (the expected Stage-1 outcome before any agreement history exists).
- `completed` — the story passed review (it appears here and in either `merged`
  or `pausedForHuman`).
- `blocked` — the dev or reviewer could not finish cleanly; the ref carries a
  `blocked_by` reason.

### Who merges a `needs-human` PR

**The run never merges a paused PR.** The auto-merge gate merges a PR **only**
when it is low-risk **and** the agreement threshold is met **and** CI is green;
every other outcome applies the `needs-human` label and routes the ref to
`pausedForHuman` — the run does not run `gh pr merge` on it. In a truly
unattended ("walk-away") run, **you merge the `pausedForHuman` PRs yourself** when
you return; the loop will not, and an agent acting on your behalf should not merge
a `needs-human`-labelled PR either. (The `needs-human` label is the permanent,
correct record that a human review was required — leave it in place; do not strip
it on merge.) This is the safe default for unattended runs: the run ships only
what it is allowed to ship hands-off and parks the rest for you.

## 4. After the run

Each dev works inside its **own per-story git worktree** (Story 8.20), so the
orchestrating checkout at `targetRepoRoot` is **not** moved onto a story branch —
it stays where you left it (normally `main`), and the worktrees are reaped at the
end of the run. So unlike the old serial loop, you are **not** left stranded on
the last story's leftover branch.

> **One caveat for background runs.** If this repo's
> `worktree.bgIsolation: "none"` setting suppresses the per-agent worktree in a
> background job, a dev's edits can leak into the shared `targetRepoRoot` checkout.
> The run's **clean-root guard** detects that after each story and
> **non-destructively stashes** the leaked paths (recoverable via `git stash list`
> / `git stash pop`), logging a loud `CLEAN-ROOT GUARD` warning. If you see that
> warning in the run log, check `git stash list` before reconciling.

To reconcile after a run:

1. **Return to the trunk and pull:**

   ```sh
   git checkout main && git pull
   ```

   This pulls down the PRs that merged during the run (and any human merges you
   completed for the `pausedForHuman` set). If a `CLEAN-ROOT GUARD` warning fired,
   inspect `git stash list` first.

2. **Mark the run stories `done` in the sprint-status tracker.** Edit
   `_bmad-output/implementation-artifacts/sprint-status.yaml` and set each
   run story's entry under `development_status:` to `done`. Use the
   workflow's `merged` and `completed` lists as the authoritative record of
   what shipped.

3. **Commit the reconciliation:**

   ```sh
   git add _bmad-output/implementation-artifacts/sprint-status.yaml
   git commit -m "chore(planning): reconcile sprint-status — run stories done"
   ```

Any story that came back in `pausedForHuman` still needs a human to merge its PR
before you mark it `done`; review and merge those first, then reconcile as above.
Any story in `blocked` did not ship — re-queue or re-author it once you've
addressed the `blocked_by` reason.
