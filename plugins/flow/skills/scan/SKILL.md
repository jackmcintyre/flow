---
name: flow:scan
description: Scan the active adapter's source stories into .flow/state/to-do/ execution manifests. Idempotent.
allowed_tools: [Read]
---

# /flow:scan

# What this skill does

Projects your active planning tool's source stories into per-story execution manifests under `<target-repo>/.flow/state/to-do/<ref>.yaml`. Idempotent: re-running this skill after no source changes is a no-op. (Internally the skill invokes the `scan-sources` MCP tool, registered on the crew server.)

# Prerequisites

A target repo with `.flow/config.yaml` resolved (auto-detected on first run by the workspace resolver — see `docs/README-install.md` checkpoint 5). At least one source story present under the active adapter's stories root (e.g. one BMad story under `_bmad-output/planning-artifacts/stories/` if you're on the BMad adapter).

# Steps

1. Invoke the `scanSources` MCP tool with `targetRepoRoot` set to the current workspace root.
2. Print the tool's text response verbatim — including the `blocked:` line introduced in Story 3.5. Do NOT paraphrase, filter, or omit any line of the output. A `blocked:` line naming one or more refs is the operator's cue to fix the source story (add a missing integration AC, declare an implicit dependency, etc.) and re-run `/flow:scan` — the blocked manifest will be re-evaluated on the next scan.

# Failure modes

- **No `.flow/config.yaml` and no adapter matches:** the tool throws `NoAdapterMatchedError`. The skill surfaces the error message verbatim — it already tells the user what to do (init a planning tool or run `/flow:status` to see what the workspace resolver expects).
- **A source story is malformed (e.g. BMad story with no `## Acceptance Criteria` section):** the adapter throws a typed parse error (`MalformedBmadStoryError` for the BMad adapter; future adapters throw their own typed errors). The skill surfaces it verbatim — the operator edits the source file and re-runs the skill.
- **An existing manifest is malformed (someone hand-edited a `to-do/<ref>.yaml` into an invalid shape):** the tool refuses with `MalformedExecutionManifestError`, naming the file path and the offending field. The skill surfaces it verbatim; the operator fixes the manifest and re-runs.

<!-- Path note: the epic at epic-3-backlog-layer-planning-adapters-story-manifests-and-the-planning-conversation.md § Story 3.2 AC4 refers to "skills/scan.md"; the actual v1 layout is skills/scan/SKILL.md per the precedent set by skills/status/SKILL.md. The slash-command surface (/flow:scan) is unaffected. -->
