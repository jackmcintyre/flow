# Reference — the run result shape and exit reasons

> **Goal:** read what the unattended run reports when it finishes and
> immediately tell whether the queue fully emptied, whether anything paused for
> you, and whether anything was blocked — without re-deriving the answer from
> the workflow source.

This is the companion reference to the
[unattended run runbook](./unattended-run-runbook.md). The runbook covers
how to queue stories and launch the `flow-run` workflow
(`plugins/flow/workflows/internal/run.workflow.js`); this doc explains the structured
object the run **returns** when it stops.

The whole return object is the run's **no-silent-failures surface**: every
story it claims lands in exactly one of four outcome buckets, and the run as a
whole carries exactly one machine-readable exit reason. If a claimed story
isn't in one of the buckets, that's a defect — not an expected state.

## The return shape

When the run finishes it returns a single object:

```json
{
  "sessionUlid": "01J…",
  "runReason": "queue-emptied",
  "queueEmptied": true,
  "completed": ["bmad:8.12", "bmad:8.13"],
  "merged": [{ "ref": "bmad:8.12", "prNumber": 204 }],
  "pausedForHuman": [{ "ref": "bmad:8.13", "prNumber": 205, "reason": "needs-human" }],
  "blocked": [{ "ref": "bmad:8.99", "blocked_by": "dev-no-handoff" }]
}
```

| Field | Type | What it is |
|-------|------|------------|
| `sessionUlid` | string | The run's session id (launcher-minted, or minted in-script for a standalone run). Ties the result to the journal. |
| `runReason` | string | The single run-level exit reason. See [§ Exit reasons](#exit-reasons-runreason). |
| `queueEmptied` | boolean | `true` only when `runReason === 'queue-emptied'`. The headline "did the queue fully empty?" flag. See [§ The `queueEmptied` flag](#the-queueemptied-flag). |
| `completed` | string[] | Refs that earned a green reviewer verdict this run. |
| `merged` | object[] | `{ ref, prNumber }` for each PR the auto-merge gate actually merged. |
| `pausedForHuman` | object[] | `{ ref, prNumber, reason }` for each green story the gate left for a human to merge. |
| `blocked` | object[] | `{ ref, blocked_by }` for each story that could not finish. |

## The four per-story outcome buckets

Every story the run **claims** is accounted for in exactly one of these four
arrays by the time the run returns. This is the no-silent-failures contract: a
claimed story is never dropped on the floor.

### `completed` — a green verdict

The reviewer returned a **green verdict** (`done-ready-for-merge`) and the
story was atomically moved from `in-progress/` to `done/`. The ref is pushed to
`completed`.

`completed` is the record that the *work* finished and passed review. It is
**not** the record that the PR landed — that's `merged`. Every story that
reaches the auto-merge gate is in `completed` first; the gate then decides
between `merged` and `pausedForHuman` for that same ref.

### `merged` — the gate actually merged it

After a green verdict, the run runs the **auto-merge gate**. When the gate's
decision is `auto-merge`, the gate itself performs the merge and the
`{ ref, prNumber }` is pushed to `merged`. This is the fully-unattended happy
path: the work passed review *and* the PR landed with no human in the loop.

A ref in `merged` is also in `completed` — `merged` is the strict subset of
green stories that the gate took all the way.

### `pausedForHuman` — the gate applied a `needs-human` label

After a green verdict, when the gate does **not** decide `auto-merge`, it leaves
the PR for a human to merge — typically by applying a `needs-human` label — and
the `{ ref, prNumber, reason }` is pushed to `pausedForHuman`. The `reason` is
the gate's own decision/reason string, surfaced verbatim so you know *why* it
paused (for example: no agreement history yet, a higher risk tier, or a gate
threshold not met).

`pausedForHuman` means the work is done and review is green — only the **merge**
is waiting on you. These PRs are ready to eyeball and merge by hand. Like
`merged`, every ref here is also in `completed`.

### `blocked` — the story could not finish

The story was claimed but could not reach a green verdict. The
`{ ref, blocked_by }` is pushed to `blocked`, where `blocked_by` names the
failure point — for example:

- `dev-no-handoff` — the dev's transcript never emitted the locked handoff
  phrase, so the dev did not finish cleanly.
- a parse/processing failure on the dev or reviewer transcript (e.g. `pd-failed`).
- `done-blocked-reviewer-needs-changes` after the rework cap was exhausted.
- `verdict-failed` or another non-green reviewer outcome.

`blocked` is the surface that makes failures **loud**: the run never fakes a
handoff or a green verdict. If a story can't finish, it lands here with a reason
rather than being silently skipped.

## Exit reasons (`runReason`)

`runReason` is the single run-level reason the loop stopped. It carries the
distinction between *the queue genuinely emptied* and *the run stopped for some
other reason*:

| `runReason` | Meaning |
|-----------------|---------|
| `queue-emptied` | The claim step found no more ready stories — a **genuine full empty**. The only value for which `queueEmptied` is `true`. |
| `max-stories-reached` | The optional `maxStories` safety cap was hit before the queue emptied. The run stopped on purpose; there may be more ready stories. |
| `waiting-on-in-progress` | The claim step found stories that aren't yet claimable because something is still in progress (or dependencies aren't satisfied). The run stopped without fully emptying. |
| *claim / blocked failure reasons* | Any other claim or processing failure is surfaced **verbatim** as the `runReason` (e.g. a claim parse error or a `blocked_by`-style reason from the seam). |

The non-`queue-emptied` reasons all mean the same headline thing: the queue did
**not** fully empty. The specific value tells you *why* it stopped so you can act
— raise the cap, wait for the in-progress work, or investigate the failure.

## The `queueEmptied` flag

`queueEmptied` is a convenience boolean that is `true` **only** when
`runReason === 'queue-emptied'`.

This is deliberate: hitting the `maxStories` cap, waiting on in-progress work,
or stopping on an error is **not** a full empty, so each of those is correctly
reported as `queueEmptied: false` even though stories may have been completed and
merged along the way. In other words, `queueEmptied` answers exactly one question —
*"did the queue empty out?"* — and never conflates "we did some work" with "the
queue is now empty."

To read a result at a glance:

- `queueEmptied: true` → the queue is empty; the run did everything it could.
- `queueEmptied: false` → the queue still has claimable (or soon-to-be-claimable)
  work, or the run stopped early; check `runReason` for why.

In either case, the four buckets tell you what happened to the stories the run
*did* claim — and the [`summariseRunResult`](../mcp-server/src/lib/summarise-run-result.ts)
helper renders the whole thing as a single line for a quick read.
