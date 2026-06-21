---
name: flow:init
description: Initialise a fresh repo as a Flow workspace and show how the tool works — config, state dirs, standards doc, and your next steps in one command.
allowed_tools: [Bash, getStatus, initWorkspace]
version: 0.1.0
---

# /flow:init

# What this skill does

The first command to run in a brand-new repo. It scaffolds the workspace deterministically and prints a short orientation, so `/flow:plan`, `/flow:ready`, and `/flow:run` work immediately — without anyone hand-authoring `.flow/config.yaml` from a fixture.

It does three things:

1. Ensures the directory is a git repo (the run loop needs git).
2. Calls `initWorkspace`, which idempotently writes `.flow/config.yaml`, the `.flow/state/` lanes, `.flow/native-stories/` (native adapter), and seeds `docs/standards.md` from the shipped template.
3. Relays the tool's how-it-works orientation and the recommended next step.

Why this exists: on a brand-new repo no adapter can auto-detect (native detection needs an existing story, BMad needs a stories root), so the workspace resolver dead-ends until an explicit `.flow/config.yaml` exists. `/flow:init` writes that config up front, removing the first-run friction.

# Argument

Optional adapter. Bare `/flow:init` defaults to the **native** adapter; `/flow:init bmad` initialises a BMad workspace instead. Native is the right choice for almost every fresh repo.

# Steps

1. **Identify the target repo root** — the current Claude Code workspace root — as `targetRepoRoot`.

2. **Ensure git.** Check whether the directory is a git repo: run `git -C <targetRepoRoot> rev-parse --is-inside-work-tree` (Bash). If that fails, run `git -C <targetRepoRoot> init`. Both are safe to run on an already-initialised repo.

3. **Scaffold the workspace.** Call `initWorkspace({ targetRepoRoot, adapter })`, where `adapter` is the skill argument when present and omitted otherwise (the tool defaults to native). The tool is idempotent: anything already present is left untouched and reported under "Already present".

4. **Relay the result verbatim.** `initWorkspace` returns a rendered summary (what was created or skipped) followed by a how-it-works orientation and the recommended next step. Print that output as-is — do not summarise, reorder, or rewrite it.

# Notes

- **Idempotent.** Re-running `/flow:init` on an existing workspace is safe — it never overwrites `.flow/config.yaml`, `docs/standards.md`, or any state file.
- This skill does not hire a team or author stories; it prepares the ground and points you at `/flow:hire` next.
