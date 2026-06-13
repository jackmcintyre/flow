---
name: flow:retro
description: "Run the cycle-level retro-analyst over the cycle's done manifests, telemetry, prior proposals, and rule registry to produce one retro-proposal markdown file."
allowed_tools: [getStatus, gatherRetroInputs, readCatalogue, Task, summariseRetroProposal, readBacklogInventory]
---

<!-- Behavioural contract source: _bmad-output/implementation-artifacts/6-2-retro-skill-and-retro-analyst-subagent.md § AC1 -->

# /flow:retro

# What this skill does

Runs the cycle-level retrospective. It gathers a deterministic input bundle from the cycle's outcomes — every `done/` execution manifest (with its structured `lessons[]`), the telemetry event summary, the list of prior retro proposals, and (when present) the rule registry — then spawns the **retro-analyst** subagent via Claude Code's `Task` tool against the catalogue prompt at `plugins/flow/catalogue/retro-analyst.md`. The subagent reasons over the bundle, surfaces patterns, and writes **exactly one** proposal markdown file under `<target-repo>/.flow/retro-proposals/<ISO>.md` via the `writeRetroProposal` tool. The proposal is diff-then-confirm: the analyst proposes, you (the operator) accept or reject in a later step (Epic 6b).

The skill is a thin orchestrator. The deterministic *facts* the analyst reasons over are gathered by the `gatherRetroInputs` tool, not scraped from prose — the load-bearing seam is the tool-gathered bundle plus the analyst's read-only permission surface (`permissions/retro-analyst.yaml`), not this skill's prose.

The retro works against **any adapter**. There is no branch on adapter name — `getStatus` is called to surface the active adapter and trigger the workspace resolver, but the gather + analyse flow is adapter-agnostic.

# Prerequisites

- A target repo with `.flow/config.yaml` resolvable (or auto-detectable by the workspace resolver).
- A hired `retro-analyst` persona is NOT required — the subagent is spawned from the catalogue prompt directly (the `Task` system prompt is assembled from `readCatalogue`, not from a `team/` persona copy).
- At least one `done/` manifest is recommended (the analyst can still run against an empty cycle — it will write a proposal file with an empty `proposals` array).

# Steps

1. **Identify `targetRepoRoot`.** Use the current Claude Code workspace root as `targetRepoRoot`.

2. **Resolve the active adapter.** Call `getStatus({ targetRepoRoot })` as the FIRST MCP call. This (i) triggers the workspace resolver if `.flow/config.yaml` is absent, (ii) confirms an active adapter is resolvable, and (iii) lets `NoAdapterMatchedError` surface BEFORE any gather attempt. Capture the `adapter` field to surface it to the operator. **Do NOT branch on the adapter** — the retro runs identically against every adapter. On any typed error (`NoAdapterMatchedError`, `UnknownAdapterError`, `AmbiguousAdapterError`), surface the error verbatim and stop.

3. **Gather the deterministic input bundle.** Call `gatherRetroInputs({ targetRepoRoot })`. This returns the typed bundle `{ doneManifests, telemetrySummary, priorProposals, ruleRegistry }`:
   - `doneManifests` — every `done/` manifest, alphabetical, schema-validated.
   - `telemetrySummary` — `{ events, skipped_count }`; corrupt log lines are skipped and counted in `skipped_count`.
   - `priorProposals` — `{ path, iso_timestamp }[]`, ascending; contents NOT loaded.
   - `ruleRegistry` — parsed `docs/discipline-rules.yaml`, or `null` when absent (6a phase: the registry doesn't exist yet — `null` is expected, NOT an error).

   **If `gatherRetroInputs` surfaces a `MalformedExecutionManifestError` (or any other typed error), surface it verbatim and stop** — a corrupt `done/` manifest is a hard stop; the operator must fix it before the retro can run.

4. **Spawn the retro-analyst subagent.** Read `readCatalogue({ role: "retro-analyst" })` and use its `Prompt` section verbatim as the `Task` system prompt. Invoke Claude Code's `Task` tool with that system prompt and an `<initial-context>` block carrying the gathered bundle:
   ```
   targetRepoRoot: <targetRepoRoot>
   adapter: <adapter>
   doneManifests: <the doneManifests array from step 3>
   telemetrySummary: <the telemetrySummary object from step 3>
   priorProposals: <the priorProposals array from step 3>
   ruleRegistry: <the ruleRegistry value from step 3 — may be null>
   ```
   The subagent reasons over the bundle and calls `writeRetroProposal` exactly once. The skill does NOT call `writeRetroProposal` itself — that is the analyst's only write affordance.

5. **Exit condition.** The retro-analyst subagent emits the locked terminal handoff phrase: `Handoff to operator — retro proposal ready for review at <path>`. When that phrase appears:
   a. Extract the `<path>` from the handoff phrase.
   b. Call `summariseRetroProposal({ absPath: <path> })` — this reads the written file and returns `{ totalCount, noProposals, proposals: [{ type, rationale, id }] }`.
   c. Render the summary inline to the operator:
      - If `noProposals` is true: "This cycle yielded no recommended changes."
      - Otherwise: list each proposal as "- **\<type\>** (\<id\>): \<rationale\>" and conclude with "Total: \<totalCount\> proposal(s). Proposal file: \<path\>."
   d. Exit. The proposal is ready for human review; accepting/applying it is a later step (Epic 6b).

   **Do NOT** relay the summary from the subagent's prose — always call `summariseRetroProposal` on the written file path so the inline summary is derived from the same frontmatter source of truth as the file itself.

6. **Offer to queue fix-worthy proposals as backlog stories (operator-gated).** After rendering the summary (step 5), present the operator with the list of proposals. For each proposal in the summary:
   - A proposal is **fix-worthy** when its `type` is any concrete change variant (every proposal type in the closed schema is fix-worthy — an empty `proposals` array means nothing warranted a fix, and step 5d already exited).
   - An empty `proposals` array was already handled in step 5c ("This cycle yielded no recommended changes.") — skip step 6 entirely.

   For each fix-worthy proposal, ask the operator a single yes/no question:

   > Finding: **\<type\>** (\<id\>): \<rationale\>. Queue this as a backlog story? (yes / no)

   - If the operator says **no** (or skips): move on. Do not draft a story.
   - If the operator says **yes**: proceed to sub-step 6a.

   6a. **Build de-dup context.** Call `readBacklogInventory({ targetRepoRoot })` once (you may reuse this result across all proposals in the same retro session). Surface a typed error verbatim and stop if it fires.

   6b. **Spawn the author subagent** via Claude Code's `Task` tool to draft a story for the confirmed proposal:
   - Read `readCatalogue({ role: "author" })` and use its `Prompt` section verbatim as the `Task` system prompt.
   - Append an `<initial-context>` block containing: `targetRepoRoot`, a `feature_description` that faithfully translates the retro finding into a plain-language feature request (cite the proposal's `type`, `id`, and `rationale`), and the `backlog_inventory` from step 6a.
   - The author subagent calls `writeNativeStory` — it is the ONLY path that may call `writeNativeStory`. **The retro skill itself MUST NOT call `writeNativeStory` directly.** This boundary is load-bearing: the retro-analyst's permission surface excludes `writeNativeStory` and that constraint must not be bypassed.
   - When the author subagent emits its locked handoff phrase `Handoff — draft <ref> authored, not-ready, awaiting judgment`, extract the `<ref>` and report it to the operator: "Draft **\<ref\>** queued as not-ready — judge and bless it via `/flow:judge` then `/flow:ready` when ready to build."

   6c. **On a refuse-and-revise from the author:** If the author subagent surfaces a `DisciplineViolationError` (the drafted story violated a discipline rule), relay the violation codes and the revision offer to the operator verbatim. Nothing was written. Offer to retry with a revised framing; do NOT silently re-attempt without operator input.

   **Operator-gated diff-then-confirm contract:** Never draft a story silently. The operator must confirm each proposal individually before anything is written to the backlog. One proposal = one confirm = one draft (or none). Do not batch-confirm or assume the operator's intent.

# Failure modes

- **`NoAdapterMatchedError`** (fresh repo without source stories): surface the error verbatim. Run `/flow:hire` first to establish the team, then add source stories before running a retro.
- **`UnknownAdapterError`** / **`AmbiguousAdapterError`**: surface verbatim. The operator must fix or author `.flow/config.yaml`.
- **`MalformedExecutionManifestError`** (a `.yaml` in `.flow/state/done/` is corrupt): surfaced by `gatherRetroInputs`. Surface verbatim and stop — the operator must fix or remove the malformed manifest before re-running the retro. Unlike a corrupt telemetry line (which is skipped + counted), a corrupt done/ manifest is a hard stop because it would silently drop a story's outcomes from the cycle analysis.
- **Corrupt telemetry lines:** NOT a failure. `gatherRetroInputs` skips them and returns the count in `telemetrySummary.skipped_count`. The analyst is instructed to note a non-zero `skipped_count` in its rationale rather than crash.
- **`CatalogueRoleNotFoundError`** (from `readCatalogue`): the `retro-analyst.md` catalogue file is missing from the plugin tree. This is a plugin-packaging bug; surface the error verbatim.
- **The subagent terminates without the locked handoff phrase:** the analyst did not complete a proposal write. Inspect the subagent's final output for a yield phrase or an error. The retro can be re-run; `writeRetroProposal` refuses to overwrite an existing proposal (immutable artifacts), so a partial write does not corrupt prior proposals.
