---
name: crew:judge
description: "Run the diverse-lens judge panel over a drafted story and report the per-lens verdict to the operator. Grades quality against the rubric; it does not bless the draft."
allowed_tools: [Task, getStatus, readBacklogInventory, buildPersonaSpawnPrompt, writeLensVerdict, aggregateJudgePanel]
---

<!-- Behavioural contract source: _bmad-output/implementation-artifacts/9-3-judge-panel-rubric-grading.md -->

# /crew:judge

# What this skill does

This is the **Tier 1** half of gate 1 — the judge panel that grades a *drafted* story's **quality** against the rubric (`_bmad-output/planning-artifacts/rubric-story-quality-2026-05-31.md`). Story 9.2 produces a Tier-0-clean draft; this skill runs the panel that judges whether the draft is good enough to be blessed.

The panel spawns **one judge per Tier-1 lens** — **Structure, Verifiability, Discipline, Domain, Considered** — each from a **different role**. Lens diversity is non-negotiable: a panel that shares the author's blind spots rubber-stamps (that scar is documented, and it is the whole reason no two lenses share a judge). Each judge emits a per-lens verdict `{lens, pass, missed}` to a **file** (via `writeLensVerdict`), reusing the deterministic verdict-capture pattern the reviewer already uses. The panel reads the **files**, never a judge's transcript.

**This skill does NOT decide `ready`.** It produces the verdict set and reports it to you; it writes **nothing** to the readiness flag or any manifest. Adjudication — turning a verdict set into ready / escalate / rework — is the Quality Lead's call (Story 9.4). Keeping grading and adjudication separate is deliberate: the panel is many narrow lenses; the Lead is one synthesiser.

# Prerequisites

A target repo with a hired team and a drafted story to judge. The skill calls `getStatus` to resolve the workspace and surfaces any resolution error verbatim.

# Steps

1. **Identify the target repo root** (the current Claude Code workspace root) as `targetRepoRoot`, and resolve the workspace via `getStatus({ targetRepoRoot })`. Surface a typed resolution error verbatim and stop.

2. **Identify the draft to judge.** Use the draft `ref` the operator named when invoking the skill. If none was given, call `readBacklogInventory({ targetRepoRoot })` and ask the operator which backlog item to judge. Read the draft spec text so the judges can grade it. Read the draft's execution manifest and, if it carries a persisted `risk_tier` (stamped at scan time from the story's declared paths — Story 10.4), set `draft.riskTier` to that value so the panel grades the Considered lens at the persisted tier rather than recomputing it from an empty author-time diff. Leave `draft.riskTier` unset for legacy/BMad drafts with no persisted tier — the panel will classify from the draft's paths as before.

3. **Mint or reuse a session ULID** for this panel run (the per-lens verdict files are namespaced under it). Bind the five lenses to five **distinct** roles — the default binding is Structure→architect, Verifiability→test-specialist, Discipline→generalist-reviewer, Domain→generalist-dev, Considered→retro-analyst; override only to match the hired roster, and never bind two lenses to the same role.

4. **Spawn one judge per lens** via Claude Code's `Task` tool — five spawns, one per lens, each from its bound role:
   - Build the judge's system prompt from its role via `buildPersonaSpawnPrompt({ targetRepoRoot, role })`, then append: the **lens name** and its scoreable checks (from the rubric §3), the **draft spec text**, the draft's **risk tier** (so the Considered judge applies the rubric §3.5 tiered bar), and an instruction to call `writeLensVerdict` exactly once with its `{lens, role, pass, missed}` verdict (`missed` must be non-empty — name the specific gap on a fail).
   - The judge's reasoning is free; only the verdict file is load-bearing. The judge MUST NOT write the readiness flag or any manifest.

5. **Aggregate the panel verdict.** After all five judges have written their files, call `aggregateJudgePanel({ targetRepoRoot, sessionUlid, draft, lensRoles })`. It uses the draft's persisted `riskTier` when present (single source of truth — Story 10.4) and otherwise classifies the tier from the draft's declared paths; then it reads the five per-lens files, assembles the `PanelVerdict { tier0, lenses }`, validates it, and emits one `panel.graded` telemetry event. It writes **no** readiness flag and **no** manifest.

6. **Report the verdict to the operator.** Surface, per lens: the lens name, pass/fail, and the `missed` string. Lead with the headline (clean sweep vs. which lenses failed), then the per-lens detail. Make clear this is a **grade, not a blessing**: the draft is not `ready` and is not claimable until the Quality Lead adjudicates (Story 9.4) and you bless it via `/crew:ready`.

# Guardrails

- **Never write the readiness flag or a manifest from this skill.** The panel grades; it does not bless. The only writes are the per-lens verdict files (through `writeLensVerdict`) and the `panel.graded` telemetry event (through `aggregateJudgePanel`). Do not edit `.crew/state/**` by hand and do not run a git command.
- **Lens diversity is structural.** Never collapse two lenses onto one judge — `aggregateJudgePanel` refuses a shared-role roster (`DuplicateLensJudgeError`) and an unbound lens (`LensJudgeUnavailableError`). Fix the binding; do not work around it.
- **The panel reads files, not transcripts.** If a judge narrates a verdict but does not call `writeLensVerdict`, its lens file is absent and aggregation fails loudly (`LensVerdictFileMalformedError`). That is the gate working — a missing lens is the rubber-stamp failure in disguise. Re-spawn the judge so it writes its file.

# Failure modes

- **A lens has no role / a role is shared:** `aggregateJudgePanel` throws `LensJudgeUnavailableError` or `DuplicateLensJudgeError`. Fix the lens→role binding (one distinct role per lens) and re-run.
- **A judge wrote no / a malformed verdict file:** `aggregateJudgePanel` throws `LensVerdictFileMalformedError` (absent file, bad JSON, schema failure, or a fail with an empty `missed`). Re-spawn that lens's judge with the instruction to call `writeLensVerdict` once with a non-empty `missed`.
- **Risk-tiering spec missing / malformed:** the risk classifier propagates `MalformedRiskTieringSpecError` / `ShippedRiskTieringDefaultMissingError` verbatim. Fix or restore `docs/risk-tiering.md` and re-run.
