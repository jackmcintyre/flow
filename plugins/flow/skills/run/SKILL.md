---
name: flow:run
description: "Stage-1 stateless run: a per-story loop (claim -> dev -> review -> verdict -> auto-merge gate) driven entirely through one-shot CLI seams — NO persistent MCP server on the run path, so the cascade-SIGTERM disconnect cannot occur by construction. The main loop dispatches up to maxConcurrency stories at once (Story 8.22); per-dev worktree isolation (8.20) makes that safe. Recovers crash-orphaned stories first (auto-resume, serial). Story 8.5 + crash-recovery + concurrency."
allowed_tools: [Bash, Workflow]
---

# /flow:run

# What this skill does

Launches the `flow-run` workflow against the current workspace. It resolves the absolute paths that the run requires — the target repo root (from the Claude Code workspace context) and the engine CLI entrypoint (from the plugin install location) — validates them on disk, then invokes the run via the `Workflow` tool. Optional run knobs (`maxStories`, `maxConcurrency`, `devReviewerModel`) are accepted as arguments and forwarded unchanged to the run.

The run is a stateless one-shot loop: it claims every ready-and-claimable story, runs the generalist-dev and reviewer in isolated per-story worktrees, and auto-merges green low-risk PRs. When the queue is exhausted (or the optional `maxStories` cap is hit) the workflow returns and the skill prints the summary.

See `docs/unattended-run-runbook.md` for the full operator playbook, including how to queue stories before launching and how to reconcile after the run.

# Prerequisites

- Plugin installed (MCP server running). The `Workflow` tool is provided by Claude Code, not the flow MCP server — no MCP call is needed to invoke it.
- At least one ready-and-approved story in `.flow/state/to-do/` (use `/flow:plan` to author and materialise stories, then `/flow:ready` to approve them). A run with nothing claimable exits immediately with `runReason: "queue-emptied"` — that is correct behaviour, not a bug.

# Steps

## Step 1 — Identify `targetRepoRoot`

Use the current Claude Code workspace root as `targetRepoRoot`. This is the absolute path of the repo whose stories are being run.

## Step 2 — Resolve and validate `cli`

The plugin is installed at the path held in the `CLAUDE_PLUGIN_ROOT` environment variable. Run:

```bash
echo "$CLAUDE_PLUGIN_ROOT"
```

Set `cli` to `${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/cli.js`.

**Pre-flight check:** verify the file exists before invoking the run:

```bash
test -f "${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/cli.js" && echo "ok" || echo "missing"
```

If the check prints `missing`, stop immediately and emit:

```
Error: the run engine file could not be found at ${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/cli.js.
The plugin may not have been built correctly. Run `pnpm build` from plugins/flow/mcp-server/ and reinstall.
```

Do NOT attempt to start the run.

Also verify `targetRepoRoot` is an absolute path that exists on disk (`test -d "<targetRepoRoot>"`). If it does not exist, stop with a clear message.

## Step 3 — Collect optional run knobs

Accepted optional arguments (from the operator's invocation or conversational context):

| Argument | Run field | Meaning |
|---|---|---|
| `maxStories` | `maxStories` | Safety cap: stop after claiming this many stories. Omit for unbounded ("walk-away") mode. |
| `maxConcurrency` | `maxConcurrency` | Stories built in parallel. Default 2. Set `1` for strict serial. |
| `devReviewerModel` | `devReviewerModel` | Model for dev + reviewer subagents. Default `sonnet`. Use `opus` for higher-quality runs. |

If the operator named none of these, forward no optional fields — the run's own defaults apply.

## Step 4 — Invoke the run via the Workflow tool

Build the `args` JSON object (omit optional fields the operator did not supply):

```json
{
  "targetRepoRoot": "<resolved-targetRepoRoot>",
  "cli": "<CLAUDE_PLUGIN_ROOT>/mcp-server/dist/cli.js",
  "maxStories": <N>,
  "maxConcurrency": <N>,
  "devReviewerModel": "<model>"
}
```

Invoke the `Workflow` tool with:

- **`scriptPath`**: `<CLAUDE_PLUGIN_ROOT>/workflows/run.workflow.js` (absolute — a relative path will double-resolve and fail)
- **`args`**: the JSON string above

> The `scriptPath` **must** be absolute. A relative path is resolved against the plugin directory at runtime, doubling the prefix and failing to find the script.

## Step 5 — Surface the result

When the workflow returns, print the run summary to the operator. Key fields to surface:
- `queueEmptied` — `true` when the queue emptied; `false` when the `maxStories` cap was hit.
- `runReason` — `"queue-emptied"` | `"max-stories-reached"` | `"stalled-in-progress"`.
- `merged` — refs auto-merged by the gate (green + low-risk + CI-green).
- `pausedForHuman` — refs the gate held for a human to merge (needs-human label applied).
- `blocked` — refs the dev or reviewer could not finish cleanly (each carries a `blocked_by` reason).

Remind the operator that `pausedForHuman` PRs require a manual merge before the story can be marked `done`.

### Retro recommendations (surfaced when the queue fully empties)

When `autoRetroOutcome` is present in the result, surface the team's retrospective outcome as a closing block **after** the story counts.

- **`autoRetroOutcome.status === 'ran'` and `pendingProposals` is non-empty:**
  Tell the operator the team also reflected, list each pending recommendation's kind and one-line reason, and point to `/flow:accept-proposal` to review and act on them. Example:

  ```
  Retro: the team reflected and is recommending N change(s) for your review:
    1. [<type>] <rationale>
    2. [<type>] <rationale>
  Run `/flow:accept-proposal` to review and apply each recommendation.
  ```

  The `pendingProposals` array on `autoRetroOutcome` carries `{ type, rationale, id }` for each non-auto-absorbed recommendation. Use it directly — do not re-derive the list.

- **`autoRetroOutcome.status === 'ran'` and `pendingProposals` is empty (all absorbed automatically or none produced):**
  Emit a single clean line — no list, no extra noise:

  ```
  Retro: nothing to review — all recommendations were applied automatically or no recommendations were produced.
  ```

- **`autoRetroOutcome.status === 'skipped'`:** state that the retro was skipped (no stories completed this run).
- **`autoRetroOutcome.status === 'failed'`:** state that the retro did not complete and the cycle was not advanced.
- **`autoRetroOutcome` is `null`** (queue was not fully emptied): omit the retro block entirely.

# Failure modes

- **`CLAUDE_PLUGIN_ROOT` unset or empty:** this variable is set by Claude Code when loading a plugin skill. If it is missing, the plugin is not loaded correctly — run `echo $CLAUDE_PLUGIN_ROOT` to confirm and restart Claude Code with `--plugin-dir <path-to-plugins/flow>` or reinstall via `/plugin install flow@flow`.
- **Engine file missing (`cli.js` not found):** the pre-flight check in Step 2 catches this and stops before the run starts. Rebuild the plugin and reinstall.
- **Run exits immediately with `runReason: "queue-emptied"` and zero stories claimed:** the queue was empty or no story had `ready: true`. Run `/flow:plan` to author and materialise stories, then `/flow:ready` to approve them before launching.
- **Workflow tool not available:** the `Workflow` tool is a Claude Code built-in. If it is not available in this session, the plugin environment is incomplete — restart Claude Code.
