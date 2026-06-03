---
name: flow:hire
description: Open a hiring conversation — the hiring manager reads your repo and proposes a starting team.
allowed_tools: [Read, Task]
---

# /flow:hire

# What this skill does

Opens a project-shaped hiring conversation. The hiring-manager subagent reads your repo at a high level (language, top-level layout, README excerpt, recent commits, dependency manifests), proposes the default roster (`planner`, `generalist-dev`, `generalist-reviewer`, `retro-analyst`, `orchestrator`) plus any catalogue specialists justified by what it observed, and — after you approve — writes a persona file to `{target-repo}/team/{role}/PERSONA.md` for each agreed role. Re-running `/flow:hire` against an already-hired team surfaces the current roster and offers hire-one-more / view-persona / done actions.

# Prerequisites

- A target repo. `.flow/config.yaml` is **not** required — `/flow:hire` is explicitly designed to run on a fresh repo before any config exists.
- The `hiring-manager` catalogue role and `permissions/hiring-manager.yaml` spec ship with the plugin; no operator setup beyond install.

# Steps

1. **Identify the target repo root.** Use the current Claude Code workspace root as `targetRepoRoot`. Do NOT call `getStatus` from inside this skill or its subagent — fresh repos won't have `.flow/config.yaml` yet and adapter resolution will fail. The hiring-manager subagent's allowlist (`readCatalogue`, `instantiatePersona`, `readPersona`, `lookupRoleByDomain`, `readRepoSignals`, `heartbeat`) is deliberately scoped to tools that do not require adapter resolution.
2. **Detect existing roster (mode detection — MUST run BEFORE any proposal is drafted).** List directories under `{targetRepoRoot}/team/` (excluding `custom/` and `_archived/`). Each subdirectory whose name matches a catalogue role id and which contains a `PERSONA.md` file represents an already-hired role — i.e. look for `{targetRepoRoot}/team/{role}/PERSONA.md`. For each such entry, call `readPersona({ targetRepoRoot, role })` to collect `{ role, domain, hired_at }`. If the list is non-empty, the conversation enters RE-ENTRY mode and the subagent emits the re-entry block verbatim instead of a fresh-hire proposal; otherwise fresh-hire mode. The catalogue prompt is authoritative on this — do not draft a fresh-hire proposal until you have confirmed the team directory is missing or contains no `{role}/PERSONA.md` files. Additionally, list `{targetRepoRoot}/team/custom/` if it exists; for each `{role-id}.md` file, call `readCustomRole({ targetRepoRoot, role: {role-id} })` and pass the resulting `CatalogueRole` list to the subagent in the `<initial-context>` block under a new `<custom-roles>` child element. The subagent uses this list per the catalogue's "Custom-role discovery" subsection — both to surface custom roles in proposal / re-entry blocks AND to know which `add {role}` responses to resolve via `readCustomRole` vs `readCatalogue`.
3. **Gather repo signals.** Call `readRepoSignals({ targetRepoRoot })` once and cache the result.
4. **Spawn the hiring-manager subagent** via Claude Code's `Task` tool. Assemble the system prompt as `readCatalogue({ role: "hiring-manager" })`'s `Prompt` section verbatim followed by an `<initial-context>` block containing the serialised `RepoSignals`, `currentRoster` array (empty in fresh-hire mode), and `<custom-roles>...JSON.stringify(customRoles) (array of CatalogueRole, possibly empty)...</custom-roles>`. The subagent's allowlist is enforced by `permissions/hiring-manager.yaml` (`readCatalogue`, `instantiatePersona`, `readPersona`, `lookupRoleByDomain`, `readRepoSignals`, `readCustomRole`, `heartbeat`).
5. **Pass the conversation through.** The skill is a thin orchestrator — the subagent owns the proposal grammar, approve/decline/amend handling, and re-entry actions per the catalogue prompt.
6. **Exit conditions.** Watch for the catalogue's terminal handoff signal — exactly `Handoff to planner — team hired, ready to plan` in fresh-hire mode, or the operator-typed `done` in re-entry mode. The verdict-grammar parser is not invoked here (this is not a reviewer skill).

# Failure modes

- **Adapter-resolution error from any allowlisted tool:** none of the six allowlisted tools should require adapter resolution. A `NoAdapterMatchedError` from `readCatalogue` / `instantiatePersona` / `readPersona` / `lookupRoleByDomain` / `readRepoSignals` / `heartbeat` is a programming bug — surface the error in the reply for the operator to file, but do not abort the hire flow on its account.
- **Catalogue read fails:** `CatalogueRoleNotFoundError` for `hiring-manager` is a plugin-install corruption case — check `plugins/flow/catalogue/hiring-manager.md` is present.
- **`instantiatePersona` refuses with `PersonaAlreadyExistsError`:** the skill prints `Already hired: {role} (no change).` and continues with the remaining approved subset. Mid-conversation partial idempotency is acceptable.
- **User declines all hires:** the skill exits cleanly with `No roles hired. Run /flow:hire again or /flow:skip-hiring to hire the default roster.`. Not a failure.
- **Subagent invents a role outside the catalogue:** the catalogue prompt instructs the subagent to refuse; `readCatalogue` returns `CatalogueRoleNotFoundError` for an invented role and the subagent surfaces the manual escape hatch under `{target-repo}/team/custom/` (FR92).
- **Custom-role file fails validation:** `readCustomRole` throws `CatalogueShapeError`. The skill surfaces the diagnostic verbatim as `Custom role file at {path} failed validation: {message}` and re-prompts. The operator fixes the file and re-runs `/flow:hire`. Not a skill-level failure.
