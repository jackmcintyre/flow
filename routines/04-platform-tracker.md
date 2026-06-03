---
name: platform-tracker
cron: "30 0 * * 1"         # 10:30 Sydney Monday (Monday 00:30 UTC)
label: platform-track
enabled: true
model: claude-sonnet-4-6
mcp_connections:
  - context7
---

# Claude Code platform tracker

Watches Claude Code and the Claude Code plugin SDK for changes that
could affect flow. Pulls the latest docs via Context7, diffs against a
tracked snapshot in `routines/snapshots/platform.md`, and surfaces any
new plugin manifest fields, deprecated APIs, new MCP capabilities, or
breaking changes.

The point is to make Jack the *informed* party on platform changes
instead of the surprised party.

---

## Prompt

You are running as a scheduled remote agent against the
`jackmcintyre/crew` repository. The repo is already cloned. You have
read access, `git`, tools to read and write GitHub (PRs, issues,
labels), and the **Context7** MCP connector for fetching current
library/SDK documentation. Use whichever GitHub-write mechanism is
available in your environment.

## Task

Detect material changes in Claude Code's platform surface area since
the last snapshot, and report ones that affect flow.

## Steps

1. **Load the previous snapshot.** Read
   `routines/snapshots/platform.md` if it exists. This file is the
   record of what the platform looked like at the last successful run.
   If it does not exist (first run), treat the snapshot as empty.

2. **Fetch current platform docs via Context7.** Use the Context7 MCP
   tools to pull current documentation for:
   - Claude Code (CLI, hooks, settings, slash commands, skills, MCP
     server integration, plugins, plugin manifest).
   - The Claude Agent SDK if it surfaces material changes for plugin
     authors.

   For each, capture: feature list, breaking changes, deprecations, new
   capabilities. Stick to *fact-changes*, not prose rewrites.

3. **Build a new snapshot.** A short, structured markdown summary —
   maybe 50-150 lines — covering:
   - Plugin manifest fields and their meaning.
   - Slash-command and skill conventions.
   - Hook event names and payload shapes.
   - MCP server integration points.
   - Anything else relevant to a Claude Code plugin author.

   Don't reproduce the full docs — just the parts a plugin author needs
   to track. The goal is to enable diffing across runs.

4. **Diff.** Compare the previous snapshot (step 1) to the new one
   (step 3). Identify added, removed, and modified items. Classify
   each:
   - **Breaking for flow** — would require a code change in
     `plugins/flow/` to keep working.
   - **Opportunity for flow** — new capability that could improve flow.
   - **Informational** — change that doesn't affect flow today but is
     worth knowing.

5. **Decide whether to report.** If the snapshot is unchanged or only
   informational changes exist with no breaking or opportunity items,
   **exit silently — no issue**. The snapshot still updates (next step).

6. **Update the snapshot in the repo.** Even if you don't open an issue,
   if the new snapshot differs from the previous, commit it on a new
   branch named `platform-snapshot-YYYY-MM-DD`, push it, and open a
   pull request titled `chore(routines): platform snapshot YYYY-MM-DD`
   with body "Automated snapshot refresh from the platform-tracker
   routine." If push or PR creation fails, don't sweat it — the issue
   is still the primary deliverable.

7. **Open the issue** if there are breaking or opportunity items.
   Create a GitHub issue with:
   - **Title:** `Platform tracker — YYYY-MM-DD`
   - **Label:** `platform-track` (if the label doesn't exist, create
     it with colour `1D76DB` and description "Claude Code platform
     changes affecting flow").
   - **Body:** see structure below.

## Issue body structure

```
## Breaking for flow

<For each: what changed, where in the docs, what file(s) in `plugins/flow/` are affected, suggested action. Include source URL if Context7 returned one.>

## Opportunity for flow

<For each: what's new, what flow could use it for, rough effort level (small/medium/large), source URL.>

## Informational (no action)

<Bulleted list of other changes worth knowing but not actionable today.>

---

Snapshot diff committed via PR: <link to the snapshot PR, if one was opened>
```

## Important

- **Be precise about source.** If Context7 returns a doc URL or version
  tag for a claim, include it. The user needs to be able to verify.
- **First run.** On the first run, the snapshot is empty, so everything
  is "new." Don't open a huge issue listing every Claude Code feature
  ever — instead, write the snapshot and open a small issue saying
  "First snapshot established. Watching from here."
- **If Context7 is not available,** exit silently and log "Context7 not
  reachable" to stdout. Don't try to substitute with web fetches.
- **Snapshot PR + issue are the only writes.** No other commits, no
  other PRs.
