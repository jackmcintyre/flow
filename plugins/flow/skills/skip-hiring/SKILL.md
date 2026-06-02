---
name: flow:skip-hiring
description: Hire the default five-role roster directly — no interactive proposal.
allowed_tools: [Read]
---

# /flow:skip-hiring

# What this skill does

Hires the five default-roster roles (`planner`, `generalist-dev`, `generalist-reviewer`, `retro-analyst`, `orchestrator`) directly — no interactive proposal, no hiring-manager subagent, no repo-signal read. The skill calls `instantiatePersona` for each role in order and prints a one-line confirmation per role. End-to-end in seconds against a fresh repo.

If you want a project-shaped team with specialist additions justified by your repo, use `/flow:hire` instead. `/flow:skip-hiring` is the "I just want to try it" path.

# Prerequisites

- A target repo. `.flow/config.yaml` is **not** required — the skill is explicitly designed to run on a fresh repo before any config exists.
- The five default-roster catalogue files ship with the plugin; no operator setup beyond install.

# Steps

1. **Identify the target repo root.** Use the current Claude Code workspace root as `targetRepoRoot`. Do NOT call `getStatus` from inside this skill — fresh repos may not have `.flow/config.yaml` yet and adapter resolution would fail unnecessarily. The skill's MCP tool surface (`readPersona`, `instantiatePersona`) takes `targetRepoRoot` directly and does not require adapter resolution.

2. **Refuse if a roster already exists.** List `{targetRepoRoot}/team/` (excluding `custom/` and `_archived/`). If ANY subdirectory contains `PERSONA.md`, print the literal line `Team already hired. Run /flow:hire to add more roles, or /flow:team to view the current roster.` and exit cleanly (exit code 0 — not a failure). This is the symmetric guard to `/flow:hire`'s re-entry-mode detection.

3. **Hire the default roster.** For each role in `["planner", "generalist-dev", "generalist-reviewer", "retro-analyst", "orchestrator"]` IN THAT EXACT ORDER, call `instantiatePersona({ targetRepoRoot, role })`. On success, print `Hired: {role} → {result.path}`. On `PersonaAlreadyExistsError` (shouldn't happen after step 2's guard, but defend in depth), print `Already hired: {role} (no change).` and continue. On any other error, surface the error message verbatim and exit non-zero.

4. **Terminal line.** After all five `instantiatePersona` calls complete, print `Default roster hired (5 roles). Run /flow:team to view, or /flow:hire to add more.` and exit cleanly.

# Failure modes

- **Workspace not resolved:** unlike `/flow:hire`, `/flow:skip-hiring` does NOT call `getStatus`, so adapter-resolution errors are not in the failure surface. The MCP tools the skill calls (`readPersona`, `instantiatePersona`) take `targetRepoRoot` directly and do not require `.flow/config.yaml`.
- **`instantiatePersona` refuses with `PersonaAlreadyExistsError`:** handled per step 3 — print `Already hired: {role} (no change).` and continue. Not a skill-level failure.
- **`instantiatePersona` refuses with `CatalogueRoleNotFoundError`:** plugin-install corruption (one of the five default-roster catalogue files is missing). Surface the error verbatim and exit non-zero. Re-install the plugin.
- **Team already hired (step 2 guard tripped):** prints the cross-reference line and exits cleanly. Not a failure.
