---
name: flow:ready
description: "The intake cockpit — list backlog items with readiness and dependency state; to approve one, grade it with the diverse-lens judge panel, see the verdict, then admit it to the run (or park, or discard an un-built draft)."
allowed_tools: [listClaimableTodos, markStoryReady, discardDraft, Task, getStatus, readBacklogInventory, buildPersonaSpawnPrompt, resolveLensRoles, writeLensVerdict, aggregateJudgePanel, mintSessionUlid]
---

<!-- Behavioural contract source: _bmad-output/implementation-artifacts/9-1-readiness-brake-and-minimal-intake-cockpit.md + 9-3-judge-panel-rubric-grading.md (merged: judge folded into the intake cockpit) -->

# /flow:ready

# What this skill does

This is the **intake cockpit** for the readiness brake (Epic 9). The run only ever claims a backlog item once you have explicitly marked it **ready** — a freshly-scanned item sits in the backlog but is *not claimable* until you approve it here.

The cockpit has two gears:

- **Bare `/flow:ready`** — the **cheap, instant read**: list every un-claimed backlog item with its readiness flag and dependency state. No judging, no LLM, no cost beyond the file reads. This is the "show me the backlog" view.
- **`/flow:ready <ref>` to approve** — when you want to **admit** an item to the claim queue, the cockpit first **grades it** with the diverse-lens judge panel, shows you the per-lens verdict, and only then asks you to approve / park / discard. You never approve blind, and grading only ever runs for the one item you are about to approve — never for the whole backlog.

**Unapproving** an item (parking it back behind the brake) and **discarding** an un-built draft are direct, cheap actions — they never run the panel.

Readiness is a flat operator flag on the item's manifest, orthogonal to its status. Marking an item ready does **not** move it between states, does **not** start any build, and does **not** touch git — it only flips the gate the run checks before claiming. Every mutation flows through the `markStoryReady` or `discardDraft` tools; this skill never edits a manifest file directly, never deletes a file directly, and never runs a git command.

# Prerequisites

A target repo with `.flow/config.yaml` resolved and at least one backlog item under `<target-repo>/.flow/state/to-do/` (run `/flow:plan` first if the backlog is empty — the planning flow materialises stories automatically). The approve path additionally needs a hired team large enough to staff the five-lens panel.

# Steps

1. Identify the target repo root (the current Claude Code workspace root) as `targetRepoRoot`.

2. **Render the cockpit (always).** Call the `listClaimableTodos` MCP tool with `{ targetRepoRoot }`. It returns `todos: [{ ref, title, shortHandle, depends_on, depsReady, ready }]` for every un-claimed backlog item, plus `inProgressCount`. Render the backlog as a readable table or list. For each item show:
   - `shortHandle` alongside `ref` and `title` as the primary identifier (e.g. `[01KT1NR9] native:01KT1NR9… — My story title`). The short handle is always non-empty and far more readable at a glance.
   - **ready** — `ready` (approved, claimable) or `not ready` (behind the brake).
   - **deps** — `deps ready` when `depsReady` is true; otherwise `waiting on: <unmet depends_on refs>`.
   - A one-line note that an item is only claimed by the run when it is BOTH `ready` AND `deps ready`.
   If `todos` is empty, say the backlog has no un-claimed items and point the operator at `/flow:plan` (which materialises stories automatically).

3. **Approve path — grade, then admit (`/flow:ready <ref>`).** When the operator targets an un-claimed item to **approve / admit** (named at invocation, or chosen after seeing the cockpit), grade it with the judge panel BEFORE flipping readiness:

   a. Resolve the workspace via `getStatus({ targetRepoRoot })`; surface a typed resolution error verbatim and stop.

   b. **Read the draft.** Read the draft spec text so the judges can grade it. Read its execution manifest and, if it carries a persisted `risk_tier` (stamped at scan time — Story 10.4), set `draft.riskTier` to that value so the Considered lens is graded at the persisted tier. Leave `draft.riskTier` unset for legacy/BMad drafts with no persisted tier — the panel classifies from the draft's paths.

   c. **Bind lenses to roles.** Mint (or reuse) a session ULID for this panel run — the per-lens verdict files are namespaced under it. Obtain the lens→role binding by calling `resolveLensRoles({ targetRepoRoot })` — the ONLY permitted source. It runs maximum bipartite matching over the hired team and returns `{ lensRoles }` with all five lenses (**Structure, Verifiability, Discipline, Domain, Considered**) assigned to five DISTINCT roles, preferring a specialist when one is hired. Do NOT hand-enumerate a binding. If it throws `LensJudgeUnavailableError`, the roster is too small to staff the panel — surface the error verbatim and stop (the item stays not-ready).

   d. **Spawn one judge per lens** via Claude Code's `Task` tool — five spawns, one per lens, each from its bound role. Build each judge's system prompt from its role via `buildPersonaSpawnPrompt({ targetRepoRoot, role })`, then append: the **lens name** and its scoreable checks (rubric §3), the **draft spec text**, the draft's **risk tier** (so the Considered judge applies the rubric §3.5 tiered bar), and an instruction to call `writeLensVerdict` exactly once with its `{lens, role, pass, missed}` verdict (`missed` must be non-empty — name the specific gap on a fail). The judge's reasoning is free; only the verdict file is load-bearing. A judge MUST NOT write the readiness flag or any manifest.

   e. **Aggregate.** After all five judges have written their files, call `aggregateJudgePanel({ targetRepoRoot, sessionUlid, draft, lensRoles })`. It uses the draft's persisted `riskTier` when present and otherwise classifies from the draft's paths, reads the five per-lens files, assembles and validates the `PanelVerdict { tier0, lenses }`, and emits one `panel.graded` telemetry event. It writes **no** readiness flag and **no** manifest.

   f. **Report the verdict.** Surface, per lens: the lens name, pass/fail, and the `missed` string. Lead with the headline (clean sweep vs. which lenses failed), then the per-lens detail.

   g. **Ask for the decision** — present a single choice: **approve** (admit it to the claim queue), **park** (leave it not-ready), or **discard** (permanently remove an un-built draft). The grade is advisory: the operator MAY approve despite a failing lens, or park a clean sweep. Then act on their choice via step 4 / 5 / 6. Only the operator's explicit "approve" flips readiness — never a judge subagent, never the panel.

4. **Approve / unapprove (toggle readiness).** Call the `markStoryReady` MCP tool with `{ targetRepoRoot, ref: <chosen ref>, ready: <true|false> }`. Use `ready: true` to admit an item (after the operator approves at step 3g); use `ready: false` to park an item back behind the brake — **unapprove never runs the panel**. On a real toggle it reports the new `ready` value and `noop: false`; when the item already held that value it reports `noop: true`. Then re-render the cockpit (step 2) so the operator sees the updated state.

5. **Discard a draft.** If the operator decides to permanently discard a listed un-claimed item, call the `discardDraft` MCP tool with `{ targetRepoRoot, ref: <chosen ref> }`. This removes both the backlog entry and the underlying source draft file so the item cannot be resurrected by a future scan. **Discard never runs the panel.** On success it reports `{ removed: true, noop: false }` — re-render the cockpit. If the ref was already absent it reports `{ removed: false, noop: true }` (clean no-op). On a `NotAnEligibleDraftError`, surface the typed message verbatim and do not retry.

Never write to a manifest file, never delete a file directly, never edit `.flow/state/**`, and never run a git command from this skill — the `markStoryReady` and `discardDraft` tools own every readiness/discard mutation, and the panel's only writes are the per-lens verdict files (through `writeLensVerdict`) and the `panel.graded` telemetry event (through `aggregateJudgePanel`).

# Guardrails

- **Grading does not approve.** The panel produces a verdict and reports it; it writes nothing to the readiness flag or any manifest. Only the operator's explicit approve at step 3g, relayed through `markStoryReady`, admits an item.
- **Lens diversity is structural.** Never collapse two lenses onto one judge — `aggregateJudgePanel` refuses a shared-role roster (`DuplicateLensJudgeError`) and an unbound lens (`LensJudgeUnavailableError`). Fix the binding; do not work around it.
- **The panel reads files, not transcripts.** If a judge narrates a verdict but does not call `writeLensVerdict`, its lens file is absent and aggregation fails loudly (`LensVerdictFileMalformedError`). That is the gate working — re-spawn the judge so it writes its file.
- **Grade only what you are approving.** Never run the panel across the whole backlog — it runs for the single item the operator is admitting. The bare cockpit and the unapprove/discard paths never spawn a judge.

# Failure modes

- **The named ref is not an un-claimed backlog item (toggle path):** `markStoryReady` throws `NotAnEligibleBacklogItemError`. The readiness brake only applies to items still waiting in `to-do/` — an item already claimed (`in-progress/`), completed (`done/`), blocked, withdrawn, or non-existent cannot be toggled. Surface the error verbatim.
- **The named ref is not eligible for discard (discard path):** `discardDraft` throws `NotAnEligibleDraftError` with one of: `not-in-to-do` (claimed/completed/blocked — may not be discarded), `withdrawn` (already retired), `wrong-adapter` (non-native ref; use `/flow:plan` or `markWithdrawn`), or `not-found` (never reached — absent refs return a no-op). Surface the error verbatim and do not delete any file yourself.
- **The roster is too small to staff the panel (approve path):** `resolveLensRoles` / `aggregateJudgePanel` throws `LensJudgeUnavailableError` or `DuplicateLensJudgeError`. Hire more roles (`/flow:hire`) so five distinct roles can be bound, then re-run. The item stays not-ready until graded and approved.
- **A judge wrote no / a malformed verdict file:** `aggregateJudgePanel` throws `LensVerdictFileMalformedError` (absent file, bad JSON, schema failure, or a fail with an empty `missed`). Re-spawn that lens's judge with the instruction to call `writeLensVerdict` once with a non-empty `missed`.
- **Risk-tiering spec missing / malformed:** the risk classifier propagates `MalformedRiskTieringSpecError` / `ShippedRiskTieringDefaultMissingError` verbatim. Fix or restore `docs/risk-tiering.md` and re-run.
- **No `.flow/config.yaml` / no backlog:** if `listClaimableTodos` returns an empty `todos` list, the backlog has nothing to approve yet — run `/flow:plan` to author and materialise source stories.
- **A backlog manifest is malformed:** `listClaimableTodos` propagates `MalformedExecutionManifestError`, naming the file and offending field. Fix the manifest (or re-run `/flow:plan` to re-materialise) and retry.
</content>
