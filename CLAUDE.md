# Project: flow

## Who I'm working with

Jack is an **ex scrum master / agile delivery lead, not an engineer**. He has broad experience across roles in technology teams (PM, BA, dev, QA, design adjacency) but doesn't carry deep specialist knowledge in any of them.

On this project, Jack's role is **product manager**: setting vision, prioritising what to build, sequencing sprints, and providing overall guidance. He leans on Claude for the engineering, testing, and analyst depth.

## Project vision

The endgame: **replace the traditional product engineering team with AI tooling**. The product being built in this repo is **AI Engineering Team v1** — a locally-installable Claude Code plugin that lets a non-engineer plan, ship, review, and learn from software with agile-grade rigour, using a project-shaped team of long-lived AI agents.

Success target: a relatively technical non-engineer (like Jack himself, or one external reader of his eventual writeup) installs the plugin on a clean machine, primes a continuous-flow backlog with a planning conversation, walks away, and comes back to a stack of merged PRs they want to keep using — without Jack on the chat.

Authoritative PRD: `_bmad-output/planning-artifacts/prd-crew-v1/` (sharded — start at `index.md`). Epics live alongside in `epics/`, architecture in `architecture/`.

## How to talk to Jack

- **Frame in PM language, not engineer language.** Trade-offs as user impact, sequencing, cost, risk — not implementation detail.
- **Don't dump engineering choices on him.** If a decision requires engineering judgment, pick a default, recommend it, explain the trade-off in plain terms, and ask for a yes/no or a redirect.
- **Plain language for technical concepts.** Examples: "the team's bookkeeping" instead of "MCP state mutations"; "stories that should wake up, don't" instead of "auto-promotion in the ready-queue."
- **When showing options, give a recommendation.** Not "here are A, B, C — pick one." Lead with "I'd recommend B because <reason>; here's what A and C give up."
- **Surface what's strategic, not what's tactical.** He cares about: which sprint is next, what user pain it removes, what risks remain, whether something is shippable. He doesn't care about: which file changed, which Zod field, which TS type.
- **Stay terse.** He reads everything but values brevity. End-of-turn summary: 1-2 sentences.

## What this project is

`flow` is the home of **AI Engineering Team v1** — a Claude Code plugin (Epic 1 in progress) that lets a non-engineer drive a project-shaped team of long-lived AI agents through a continuous-flow backlog.

The repo previously hosted a `sprint-orchestrator` plugin which was used to dog-food the same broad idea against a sprint construct. That plugin was treated as legacy from day one of the new effort and has been removed (2026-05-19); the new product is being built from scratch.

Folders:
- `_bmad-output/planning-artifacts/` — the active PRD (sharded under `prd-crew-v1/`), epics, architecture, and validation reports. **Tracked in git** so remote agents and future readers can ground in them. Its internal `archive/` subfolder is gitignored.
- `_bmad-output/implementation-artifacts/` — authored story specs, `sprint-status.yaml`, and per-epic retros. **Tracked in git** so cloud routines (e.g. `spec-author-topup`) and remote agents can read the backlog state and recently-shipped specs.
- `_bmad-output/_archive/` — superseded briefs, PRDs, sprint backlogs, and the historical record of the sprint-orchestrator era. **Gitignored**.
- `.claude/skills/bmad-*/` — installed BMad skills used for planning. Gitignored.
- `_bmad/` — BMad config/scripts. Gitignored.

## Current posture (post 2026-05-25 rollback)

- **`main` is the trunk** (trunk-based development since 2026-05-31). All PRs target `main`; it is protected (PR + required CI), so never push directly. The old `dev` integration branch is retired — `main` is always-releasable, with no separate promote-to-main step. Tag releases/snapshots rather than maintaining a second branch.
- **Dogfooding (`/flow:start`) is paused** until the three L1 tool defects from `_bmad-output/postmortems/2026-05-25-dogfood-rollback.md` are fixed: (a) dev transcript persistence, (b) orphan-recovery branch in `/flow:start`, (c) MCP idle-reap resilience.
- **Use `/ship-story` for substrate work** in the interim. Manual per-story shipping, one PR at a time, onto `main`.
- **Stop, don't fix forward.** When a tool I'm orchestrating fails unexpectedly, halt the outer loop, summarise state, and ask. Auto-mode does not authorise continuing a multi-step loop that has already failed once. Read the postmortem before any retry of dogfood.

## Process notes

- **Planning lives in `_bmad-output/planning-artifacts/`.** The authoritative PRD (sharded under `prd-crew-v1/`), epics, and architecture all sit here and are tracked in git. Older briefs and backlogs are in `_bmad-output/_archive/`, which stays gitignored.
- **Implementation artifacts live in `_bmad-output/implementation-artifacts/`.** Story specs (one `.md` per story), `sprint-status.yaml`, and per-epic retros all sit here and are tracked in git. The cloud spec-authoring routine reads this folder to compute queue depth and find recently-shipped specs for grounding.
- **The plugin lives under `plugins/flow/`.** Epic 1 (plugin foundation) is in progress.
- **Discipline rules (inherited from sprint-orchestrator era):** the five planning-discipline rules from `_archive/planning-discipline.md` are the bar for every story we author. They're inherited by the new PRD even though the standalone file is archived.
- **Deferred work tracker:** captured inside the relevant brief or PRD's deferred section, with reasoning. Promote to a follow-up workstream when ready.
- **Plugin build output is tracked in git.** `plugins/flow/mcp-server/dist/` is committed because `/plugin install` copies the tree as-is and won't run a build step. If you change `src/`, rebuild and commit `dist/` in the same change — CI fails on drift. See `plugins/flow/docs/README-install.md` § Build artefacts.

## What Jack doesn't want

- Mid-sprint engineering decisions delegated to him in jargon.
- Surprise breakage shipped under green ACs (bugfix-1 was the lesson; planning-discipline.md is the fix).
- Premature optimisation or speculative abstractions.
- Long responses when short ones suffice.
