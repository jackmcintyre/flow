# flow

flow is a Claude Code plugin that drives a continuous-flow backlog through dev and review agents, each story judged against a written standard. Plan and spec your backlog with a tool built for it (I use BMAD); flow runs it.

It's an experiment, in active development. It runs end to end on its own repo but isn't a finished product, so expect rough edges. The why behind it is in the [repository README](../../README.md).

## Install

Six checkpoints from clone to "the plugin sees my repo": [`docs/README-install.md`](docs/README-install.md).

## Available skills

- `/flow:init` - scaffold a fresh repo into a Flow workspace (`.flow/config.yaml`, state dirs, `docs/standards.md`) and print a how-it-works orientation. Run it first in a new repo.
- `/flow:hire` - open a hiring conversation; the hiring manager reads your repo and proposes a starting team (or `/flow:hire default` for the default roster).
- `/flow:plan` - open a planning conversation, or draft a single story in one shot with `/flow:plan <feature>`.
- `/flow:ready` - the intake cockpit: list backlog items with readiness and dependency state, grade one with the diverse-lens judge panel, then admit it to the run.
- `/flow:run` - the stateless per-story run loop (claim, dev, review, verdict, auto-merge gate) with per-dev worktree isolation.
- `/flow:retro` - run the cycle-level retro-analyst over the cycle's done manifests and telemetry, then apply or queue each recommendation.
- `/flow:dashboard` - one-shot cockpit: plugin/repo status, the outstanding backlog grouped by epic, and your hired team.
- `/flow:help` - context-aware next-action advisor, grounded in the live state of your project.
- `/flow:ask` - ask a single question to a hired role and get one answer (non-mutating side-session).

## Standards doc

Every reviewer verdict reads `<target-repo>/docs/standards.md`. The install walkthrough's checkpoint 5 copies the shipped template (`plugins/flow/docs/standards-example.md`) into your target repo.
