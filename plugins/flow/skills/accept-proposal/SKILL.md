---
name: flow:accept-proposal
description: "Apply one retro proposal by id through the diff-then-confirm gate: preview the change, show the diff, require an explicit yes, then commit it — idempotently."
allowed_tools: [getStatus, acceptProposal]
---

<!-- Behavioural contract source: _bmad-output/implementation-artifacts/6-4-accept-proposal-id-skill-diff-then-confirm-gate.md § AC7 -->

# /flow:accept-proposal

# What this skill does

Applies **exactly one** retro proposal — named by its id — through the unified `/accept-proposal <id>` gate (FR61). Every retro proposal kind (rule, rule-retirement, skill-create/revise/supersede/retire, team-change) flows through this one user-gated path. The gate is **diff-then-confirm**: it shows you exactly what would change, waits for your explicit yes, and only then commits the change to canonical state. Re-running the same id never double-applies (NFR10).

The skill is a thin orchestrator over the `acceptProposal` MCP tool. The load-bearing decision — preview vs. apply — lives in the **tool layer**, not in this prose. A subagent or CLI cannot hold an interactive prompt, so the confirm gate is modelled as **two tool calls**:

1. A **preview** call (no `confirm`) returns a human-readable diff and changes nothing.
2. A **confirm** call (`confirm: true`) applies the change, commits it in a single commit, stamps the proposal `applied`, and emits one telemetry event.

The operator's "yes" is what turns the first call into the second. A declined apply is simply never making the confirm call — nothing changed, fully re-runnable.

**This skill never instructs a direct file mutation or a direct git call.** Every mutation flows through the `acceptProposal` gate tool, which owns the commit (through the plugin's git wrapper — no force, no `--no-verify`) and the proposal-file stamp.

# Prerequisites

- A target repo with `.flow/config.yaml` resolvable (or auto-detectable by the workspace resolver).
- At least one proposal file under `<target-repo>/.flow/retro-proposals/` containing the id you want to apply. Run `/flow:retro` first if there are none.

# Inputs

- `<id>` — the proposal id (a ULID) to apply. Find it in the proposal markdown file produced by `/flow:retro` (each proposal's H2 header carries its id), or in the file frontmatter.

# Steps

1. **Identify `targetRepoRoot`.** Use the current Claude Code workspace root.

2. **Resolve the active adapter (status check).** Call `getStatus({ targetRepoRoot })` as the FIRST MCP call so the workspace resolver runs and any typed config error (`NoAdapterMatchedError`, `UnknownAdapterError`, `AmbiguousAdapterError`) surfaces before anything else. The accept-proposal flow is adapter-agnostic — do NOT branch on the adapter. On any typed error, surface it verbatim and stop.

3. **Preview the change.** Call `acceptProposal({ targetRepoRoot, proposalId: <id> })` **without** `confirm`. This:
   - locates the proposal by id (`ProposalNotFoundError` if no proposal matches; `AmbiguousProposalIdError` if the id somehow appears in two files — a bug, surface verbatim and stop),
   - returns `{ status: "preview", proposalId, type, diff }` and changes nothing on disk.

   If the returned `status` is `already-applied`, the proposal was applied in a prior run. Report `appliedSha` and `appliedAt` to the operator and stop — there is nothing to do (NFR10).

4. **Render the diff to the operator and require an explicit yes.** Show the `diff` string from the preview verbatim, with the proposal `type` and `id`. Ask the operator a direct yes/no: *"Apply this change? (yes/no)"*. Do NOT proceed on anything other than an explicit affirmative. On "no" (or anything ambiguous), stop — nothing has changed, and the command is safe to re-run later.

5. **On an explicit yes, confirm the apply.** Call `acceptProposal({ targetRepoRoot, proposalId: <id>, confirm: true })`. The tool runs the proposal kind's registered apply handler, commits the handler's changed paths together with the proposal-file `applied` stamp in a **single commit** through the plugin git wrapper, emits one `retro.proposal.applied` telemetry event, and returns `{ status: "applied", appliedSha, idempotencyKey }`. Report the `appliedSha` to the operator and exit.

# Failure modes

- **`ProposalNotFoundError`** — no proposal with that id exists across the proposal files (the message names how many files were scanned). Check the id, or run `/flow:retro` to produce proposals. Surface verbatim and stop.
- **`AmbiguousProposalIdError`** — the id matched in two proposal files. Proposal ids are minted unique, so this is a bug: the operator must remove or fix the duplicate file named in the error. Surface verbatim and stop.
- **`ProposalKindNotApplicableYetError`** — the gate has no registered apply handler for this proposal's kind yet. The error names the kind and the story that ships its apply path (e.g. rule applies land in Story 6.5, skill applies in Story 6.7, team-change in Story 6.10). This is a fail-closed by design — the gate refuses to half-apply an un-handled kind. Surface verbatim and stop; the proposal is untouched and can be applied once the handler ships.
- **`already-applied`** (a status, not an error) — a prior run already applied this proposal. The gate is a no-op; report the prior `appliedSha`/`appliedAt` and stop. Re-running is always safe.
- **Operator declines at step 4** — nothing changed. The command is fully re-runnable later; no recovery needed.
