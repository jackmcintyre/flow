# Project: flow

## What this project is

`flow` is a locally-installable Claude Code plugin that lets a non-engineer plan, ship, review,
and learn from software with agile-grade rigour, using a project-shaped team of long-lived AI
agents.

The endgame it's built toward: replace the traditional product engineering team with AI tooling.
Someone primes a continuous-flow backlog with a planning conversation, walks away, and comes back
to a stack of merged PRs.

The plugin lives under `plugins/flow/`. Start at `plugins/flow/README.md` for the command surface
and `plugins/flow/docs/README-install.md` for install checkpoints.

## Repository layout

- `plugins/flow/` — the plugin: MCP server (`mcp-server/`, TypeScript), skills, role catalogue, docs.
- `_bmad-output/` holds local-only planning and implementation work (the PRD under
  `planning-artifacts/prd-crew-v1/`, epics, architecture, and story specs). Gitignored: kept on
  the maintainer's machine, not published.

## Engineering conventions

- **Trunk-based on `main`.** `main` is the protected, always-releasable trunk — all changes land
  via PR with required CI; never push directly. Tag releases/snapshots rather than maintaining a
  second branch.
- **Plugin build output is tracked in git.** `plugins/flow/mcp-server/dist/{index,cli}.js` are
  committed because `/plugin install` copies the tree as-is and won't run a build step. If you
  change `src/`, rebuild and commit the bundles in the same change — CI fails on drift. See
  `plugins/flow/docs/README-install.md` § Build artefacts.
- **Planning discipline.** Authored stories are held to a planning-discipline bar — each must be
  independently verifiable, scoped to one concern, and carry explicit acceptance criteria and
  cited sources — enforced at scan and review time.
- **Dev loop.** For plugin development, see `plugins/flow/docs/dev-loop.md`.
