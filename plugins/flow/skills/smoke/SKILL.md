---
name: flow:smoke
description: Stand up a clean smoke-harness scratch repo and chain skip-hiring → plan → scan with assertion checkpoints so smokes start from a known-good state.
allowed_tools: [createSmokeScratchRepo, getTeamSnapshot, readBacklogInventory, listClaimableTodos]
---

# What this skill does

`/flow:smoke <label>` creates a disposable scratch repo pre-seeded with a valid git history, a minimal `.flow/config.yaml`, and a `.crew/standards.md`, then walks through the four setup steps (`skip-hiring → plan → scan`) with a tool-layer checkpoint after each one. Every checkpoint emits a `[smoke] step N (<name>): ok` log line on success or a `[smoke] step N (<name>): FAILED — <reason>` line and an immediate halt on failure.

Step 5 delivers a handoff message and returns control to the operator. The start step is deliberately **not** auto-invoked — the whole point of the smoke is for the operator to observe it themselves.

# Prerequisites

- Claude Code running with `--plugin-dir <path-to-plugins/flow>` (or the plugin installed via `/plugin install`). Every `allowed_tools` entry is an MCP tool served by the flow plugin; if any tool call returns `tool not found`, stop immediately and check `--plugin-dir`.
- A `label` argument provided by the operator (kebab-case, e.g. `story-1-13`). Passed to `createSmokeScratchRepo` as the `label` field.

# Steps

## Step 1 — scratch-repo

Call `createSmokeScratchRepo({ label })`. Capture `scratchRoot` from the returned JSON.

Checkpoint: confirm the returned `scratchRoot` path exists and that **both** `.flow/config.yaml` and `.crew/standards.md` are present inside it.

- On success: print `[smoke] step 1 (scratch-repo): ok` followed by `scratch_root: <scratchRoot>`.
- On failure: print `[smoke] step 1 (scratch-repo): FAILED — <reason>` and halt.

## Step 2 — skip-hiring

Operator invokes `/flow:skip-hiring` against the scratch repo (pass `scratchRoot` as the target repo root).

Checkpoint: call `getTeamSnapshot({ targetRepoRoot: scratchRoot })`. Assert the returned roster has ≥1 role whose persona frontmatter populates **both** `hired_at` and `catalogue_version`. (This is the exact frontmatter defect that surfaced in the Story 4.6 smoke trials — fail fast here so it never reaches the start step.)

- On success: print `[smoke] step 2 (skip-hiring): ok`.
- On failure: print `[smoke] step 2 (skip-hiring): FAILED — <reason>` and halt.

## Step 3 — plan

Operator invokes `/flow:plan` against the scratch repo, then exits the planner with a minimal authored backlog (one trivial source story is sufficient).

Checkpoint: call `readBacklogInventory({ targetRepoRoot: scratchRoot })`. Assert ≥1 source story is now present in the inventory.

- On success: print `[smoke] step 3 (plan): ok`.
- On failure: print `[smoke] step 3 (plan): FAILED — <reason>` and halt.

## Step 4 — scan

Operator invokes `/flow:scan` against the scratch repo.

Checkpoint: call `listClaimableTodos({ targetRepoRoot: scratchRoot })`. Assert ≥1 manifest is now present in `.flow/state/to-do/`.

- On success: print `[smoke] step 4 (scan): ok`.
- On failure: print `[smoke] step 4 (scan): FAILED — <reason>` and halt.

## Step 5 — start

Print `[smoke] step 5 (start): ok` followed by `Ready. Run /flow:start in this scratch repo.` and return control to the operator.

# Failure modes

The `[smoke] step N (<name>): FAILED — <reason>` pattern applies to all step failures. Documented root causes by step:

**(a) scratch-repo creation failure** — filesystem error propagated verbatim from `createSmokeScratchRepo`. Check that `parentDir` (default: `os.tmpdir()`) is writable and has sufficient space.

**(b) `hired_at` / `catalogue_version` missing from persona frontmatter** (Step 2 regression signal) — re-check `instantiatePersona`'s frontmatter writer. This is the Story 4.6 regression signal; if it reappears, the persona materialisation path has drifted.

**(c) Planner exited without authoring any source story** (Step 3) — the planner subagent completed but wrote no `writeNativeStory` call. Retry with explicit instructions to author at least one story before exiting.

**(d) `/flow:scan` produced zero claimable manifests** (Step 4) — most often a source-story shape defect. See memory `project_native_scan_silent_skip`: `/flow:scan` returns all-zero counts when no file matches the expected ULID regex. Inspect the native-stories directory for filenames that don't match the ULID pattern.

**(e) Operator forgot `--plugin-dir`** — every MCP tool call will fail with `tool not found`. Restart Claude Code with the correct `--plugin-dir <path-to-plugins/flow>` flag.

# Out of scope (deferred)

- Auto-invoking the start step after step 4. The smoke is deliberately an observation exercise; chaining start would defeat the purpose.
- Persisting scratch-repo state across operator sessions. The scratch dir is disposable; use `cleanup` if you want to reclaim disk space after the smoke.
- Parameterising the standards template. The smoke always uses the shipped `docs/standards-example.md`.
