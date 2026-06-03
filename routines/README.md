# Routines

Remote Claude Code agents that run on a cron schedule against this repo.
Each one wakes up, clones the repo fresh, runs its prompt, and reports
findings as a GitHub issue.

## Why this folder exists

The prompt for each routine lives here as the source of truth. The
cloud copy registered with Claude Code's scheduled-trigger system is
the *deployed* version. When you want to tune a prompt:

1. Edit the file here.
2. Open the routine in the Claude Code web UI and paste the new prompt
   in to update the deployed copy.
3. Commit the edit so the source of truth stays in sync.

Editing the cloud copy without updating the file here will drift —
future edits will reference the wrong baseline.

## The routines

Five detectors that surface findings as labelled GitHub issues, and one
fixer that consumes a detector's issues and opens PRs to resolve them.

| # | Name              | Cadence            | Label             | What it does                                                                                  |
| - | ----------------- | ------------------ | ----------------- | --------------------------------------------------------------------------------------------- |
| 1 | drift-digest      | Daily 08:30 Sydney | `drift-digest`    | Diffs merged PRs against epic acceptance criteria                                             |
| 2 | backlog-readiness | Weekly Mon 09:30   | `backlog-ready`   | Checks the next epic is fully shaped before work starts                                       |
| 3 | docs-freshness    | Weekly Mon 10:00   | `docs-freshness`  | Catches stale paths / claims in CLAUDE.md and top-level docs                                  |
| 4 | platform-tracker  | Weekly Mon 10:30   | `platform-track`  | Watches Claude Code platform changes that affect flow                                         |
| 5 | dist-drift        | Daily 09:00 Sydney | `dist-drift`      | Catches built `dist/` drifting from `src/` overnight                                          |
| 6 | issue-fixer-docs  | Daily 11:00 Sydney | `auto-fix` (PR)   | Picks up the oldest open `docs-freshness` issue and opens a PR fixing it (or comments if not) |

All times above are Australia/Sydney local; the cron expressions in
each routine's frontmatter are UTC. The crons are currently pinned to
AEST (UTC+10), so during AEDT (UTC+11, roughly October to April) every
routine fires one hour later in Sydney than the table claims. Re-shift
the cron values by an hour at each DST changeover if the schedule
matters.

## Conventions

### Detector routines (1–5)

- **Bail silently.** Every detector checks whether it has anything
  material to report and exits cleanly without opening an issue if
  not. An empty digest is worse than no digest.
- **One issue per run.** Don't fan out into multiple issues — one
  issue, labelled, with the date in the title.
- **GitHub label.** Each detector uses its own label so you can
  filter or mute one without losing the others.
- **Read-only on the codebase.** Detectors surface findings as
  issues; humans (or the fixer routine) decide what to do with them.
  Platform-tracker is the one exception — it opens a snapshot-refresh
  PR when its tracked diff baseline needs updating.

### Fixer routines (6)

- **One PR per run, maximum.** Even if many issues are open, only
  the oldest eligible one gets processed each run.
- **Stay in scope.** The PR diff is limited to the files and lines
  cited in the source issue. No bonus cleanups.
- **Skip triaged issues.** If a previous fixer run left a
  `Could not auto-fix:` comment, the issue is a human's job — the
  fixer leaves it alone.
- **Never close issues directly.** Closing happens via GitHub when a
  PR with `Closes #N` is merged.

## When routines should be re-pointed at a different repo

Today every routine targets `jackmcintyre/crew`. When the AI Engineering
Team plugin starts being used against real downstream repos, several of
these (especially #3 docs-freshness and #5 dist-drift) become candidates
to fork per-target-repo. That's a future decision — for now they all
watch flow itself.
