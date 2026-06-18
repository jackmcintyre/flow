---
name: flow:retro
description: "Run the cycle-level retro-analyst over the cycle's done manifests, telemetry, prior proposals, and rule registry to produce recommendations — then review each one and, on your explicit yes, apply it through the diff-then-confirm gate or queue it as a backlog story."
allowed_tools: [getStatus, gatherRetroInputs, readCatalogue, Task, summariseRetroProposal, readBacklogInventory, openCycle, acceptProposal]
---

<!-- Behavioural contract source: _bmad-output/implementation-artifacts/6-2-retro-skill-and-retro-analyst-subagent.md § AC1 -->

# /flow:retro

# What this skill does

Runs the cycle-level retrospective. It gathers a deterministic input bundle from the cycle's outcomes — every `done/` execution manifest (with its structured `lessons[]`), the telemetry event summary, the list of prior retro proposals, and (when present) the rule registry — then spawns the **retro-analyst** subagent via Claude Code's `Task` tool against the catalogue prompt at `plugins/flow/catalogue/retro-analyst.md`. The subagent reasons over the bundle, surfaces patterns, and writes **exactly one** proposal markdown file under `<target-repo>/.flow/retro-proposals/<ISO>.md` via the `writeRetroProposal` tool. The retro then **walks you through acting on each recommendation in the same flow** (this absorbs the former standalone `/flow:accept-proposal` command): for every un-applied proposal — those just produced **and** any left pending from earlier runs — you choose to **apply it now** through the diff-then-confirm gate, **queue it as a backlog story**, or **skip** it. The analyst proposes; nothing changes canonical state until your explicit yes.

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

   **Do NOT** relay the summary from the subagent's prose — always call `summariseRetroProposal` on the written file path so the inline summary is derived from the same frontmatter source of truth as the file itself.

6. **Advance the cycle (conditional on successful proposal write).** The locked handoff phrase from step 5 (`Handoff to operator — retro proposal ready for review at <path>`) confirms `writeRetroProposal` returned successfully. **Only when that phrase appeared** in the subagent output — call `openCycle({ targetRepoRoot, sessionUlid })` and surface the result to the operator in plain language:

   > Cycle advanced to `<cycleUlid>`, new window opens at `<openedAt>`.

   Where `<cycleUlid>` and `<openedAt>` are the fields returned by `openCycle`.

   **Conditional constraint:** This call is gated strictly on the locked handoff phrase appearing in the subagent output. Do NOT call `openCycle` if the subagent terminated without the handoff phrase (proposal write failed or incomplete) — a failed write must not advance the cycle. Do NOT call `openCycle` inside the retro-analyst subagent itself or inside `writeRetroProposal` — the trigger belongs in this orchestrating skill, after the durable write is confirmed.

   After surfacing the message, proceed to step 7 to review and act on the recommendations.

7. **Review and act on pending recommendations (operator-gated).** After rendering the summary (step 5) and advancing the cycle (step 6), assemble the full set of **un-applied** proposals and walk the operator through each one. This step absorbs the former standalone `/flow:accept-proposal` command — the diff-then-confirm apply gate now lives here.

   7a. **Assemble the pending set.** Combine two sources:
   - the proposals from the file just written (the step 5b summary), and
   - the un-applied proposals from earlier runs: for each path in the `priorProposals` list from step 3, call `summariseRetroProposal({ absPath: <path> })` and collect its `proposals`.

   Keep only proposals whose `applied` flag is `false` (every `summariseRetroProposal` proposal entry carries an `applied` boolean). An already-applied proposal is never re-offered. If the combined pending set is empty, tell the operator there is nothing to act on (step 5c already rendered "no recommended changes" for an empty current run) and exit.

   7b. **For each pending proposal, offer three actions.** Present the proposal and ask the operator to choose exactly one:

   > Recommendation: **\<type\>** (\<id\>): \<rationale\>. **Apply** it now, **queue** it as a backlog story, or **skip**? (apply / queue / skip)

   - **skip** (or no / no answer): move on, nothing changes.
   - **apply** → sub-step 7c (the diff-then-confirm gate).
   - **queue** → sub-step 7d (draft a backlog story).

   Handle one proposal at a time — one proposal, one choice, one action (or none). Never batch-apply, batch-queue, or assume the operator's intent.

   7c. **Apply now — the diff-then-confirm gate.** The load-bearing decision lives in the `acceptProposal` tool, modelled as two calls; this skill never mutates a file or runs git directly.
   - **Preview:** call `acceptProposal({ targetRepoRoot, proposalId: <id> })` **without** `confirm`. If it returns `status: "already-applied"`, report the prior `appliedSha`/`appliedAt` and move on (idempotent no-op — should not occur after the 7a filter). Otherwise it returns `{ status: "preview", type, diff }` and changes nothing on disk.
   - **Show the diff and require an explicit yes.** Render the `diff` verbatim with the proposal `type` and `id`, and ask *"Apply this change? (yes/no)"*. Proceed only on an explicit affirmative; on anything else, stop — nothing changed, fully re-runnable later.
   - **Confirm:** on an explicit yes, call `acceptProposal({ targetRepoRoot, proposalId: <id>, confirm: true })`. The tool runs the proposal kind's registered apply handler, commits the changed paths together with the proposal-file `applied` stamp in a single commit through the plugin git wrapper (no force, no `--no-verify`), emits one `retro.proposal.applied` event, and returns `{ status: "applied", appliedSha }`. Report the `appliedSha` and move on to the next proposal.
   - If `acceptProposal` throws `ProposalKindNotApplicableYetError` (no apply handler for this kind yet — it names the kind and the story that ships its handler), relay the typed message verbatim; the proposal is untouched. Where the change is really build work, offer the **queue** path (7d) instead.

   7d. **Queue as a backlog story.** When the operator chooses **queue**:
   - **Build de-dup context.** Call `readBacklogInventory({ targetRepoRoot })` once (reuse the result across proposals in the same retro session). Surface a typed error verbatim and stop if it fires.
   - **Spawn the author subagent** via Claude Code's `Task` tool to draft a story for the chosen proposal: read `readCatalogue({ role: "author" })` and use its `Prompt` section verbatim as the `Task` system prompt; append an `<initial-context>` block containing `targetRepoRoot`, a `feature_description` that faithfully translates the retro finding into a plain-language feature request (cite the proposal's `type`, `id`, and `rationale`), and the `backlog_inventory`. The author subagent calls `writeNativeStory` — it is the ONLY path that may call `writeNativeStory`. **The retro skill itself MUST NOT call `writeNativeStory` directly** — the retro-analyst's permission surface excludes it and that constraint must not be bypassed.
   - When the author subagent emits its locked handoff phrase `Handoff — draft <ref> authored, not-ready, awaiting judgment`, extract the `<ref>` and report: "Draft **\<ref\>** queued as not-ready — grade and approve it via `/flow:ready <ref>` when ready to build."
   - **On a refuse-and-revise:** if the author surfaces a `DisciplineViolationError`, relay the violation codes and the revision offer verbatim. Nothing was written. Offer to retry with a revised framing; do NOT silently re-attempt without operator input.

   **Operator-gated contract:** Never apply a change or draft a story silently. The operator confirms each proposal individually — one proposal = one explicit choice = one action (or none). Applying commits to canonical state through the gate; queuing writes a not-ready draft. Do not batch-confirm or assume intent.

# Failure modes

- **`NoAdapterMatchedError`** (fresh repo without source stories): surface the error verbatim. Run `/flow:hire` first to establish the team, then add source stories before running a retro.
- **`UnknownAdapterError`** / **`AmbiguousAdapterError`**: surface verbatim. The operator must fix or author `.flow/config.yaml`.
- **`MalformedExecutionManifestError`** (a `.yaml` in `.flow/state/done/` is corrupt): surfaced by `gatherRetroInputs`. Surface verbatim and stop — the operator must fix or remove the malformed manifest before re-running the retro. Unlike a corrupt telemetry line (which is skipped + counted), a corrupt done/ manifest is a hard stop because it would silently drop a story's outcomes from the cycle analysis.
- **Corrupt telemetry lines:** NOT a failure. `gatherRetroInputs` skips them and returns the count in `telemetrySummary.skipped_count`. The analyst is instructed to note a non-zero `skipped_count` in its rationale rather than crash.
- **`CatalogueRoleNotFoundError`** (from `readCatalogue`): the `retro-analyst.md` catalogue file is missing from the plugin tree. This is a plugin-packaging bug; surface the error verbatim.
- **Apply gate errors (step 7c):** `acceptProposal` surfaces typed errors verbatim — `ProposalNotFoundError` (id not found across proposal files), `AmbiguousProposalIdError` (the id matched two files — a bug; fix the duplicate), or `ProposalKindNotApplicableYetError` (no registered apply handler for the kind yet — the proposal is untouched and can be queued as a story or applied once the handler ships). A declined apply (no explicit yes) changes nothing and is fully re-runnable.
- **The subagent terminates without the locked handoff phrase:** the analyst did not complete a proposal write. Inspect the subagent's final output for a yield phrase or an error. The retro can be re-run; `writeRetroProposal` refuses to overwrite an existing proposal (immutable artifacts), so a partial write does not corrupt prior proposals.
