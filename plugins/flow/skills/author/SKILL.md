---
name: flow:author
description: "Propose a feature in plain language and get back a drafted story spec that has already passed the discipline checks and is parked in the backlog as not-ready."
allowed_tools: [Task, readCatalogue, readBacklogInventory, validatePlannerBacklog, writeNativeStory, getStatus]
---

<!-- Behavioural contract source: _bmad-output/implementation-artifacts/9-2-author-seam-feature-to-drafted-story.md -->

# /flow:author

# What this skill does

This is the **author seam** of the intake cockpit (Epic 9, gate 1) — the operator's half of "propose a feature." You describe a feature in plain language; the plugin spawns a lean author subagent that drafts **one** story spec, runs it through the deterministic discipline gate, and writes it to the backlog **parked not-ready**.

Nothing you propose here can be built until it has been judged and approved. A drafted story is never auto-ready: it sits in the backlog behind the readiness brake (Story 9.1) until it passes the judge panel (Story 9.3) and you approve it via `/flow:ready`. If you ask "why can't I build the thing I just authored?" — because it has not been judged yet. That is the gate working.

This seam reuses the existing native-authoring machinery rather than rebuilding it:
- the draft is written by the same `writeNativeStory` path the planner uses,
- validated by the same authoring-time discipline checks (Story 3.5), enforced **fail-closed at the write tool** — a violating draft is impossible, not merely discouraged,
- **auto-materialised into the backlog immediately** by `writeNativeStory` itself — no separate `/flow:scan` step is needed after authoring,
- defaulted **not-ready** by the Story 9.1 brake.

What is new is this thin operator surface plus a lean single-draft author subagent. The author is deliberately simpler than the full planner: one feature in, one draft out — no four-step elicitation loop, no whole-backlog review. For an interactive multi-story planning conversation, use `/flow:plan` instead.

# Prerequisites

A target repo with `.flow/config.yaml` resolved to a **`native`** adapter. (The author seam authors native-adapter stories; BMad workspaces use BMad's own authoring skills via `/flow:plan`.) The skill calls `getStatus` to resolve the adapter and surfaces any adapter-resolution error verbatim.

# Steps

1. **Identify the target repo root** (the current Claude Code workspace root) as `targetRepoRoot`.

2. **Resolve the active adapter.** Call `getStatus({ targetRepoRoot })`. If the resolved `adapter` is not `native`, tell the operator that `/flow:author` is native-only and point them at `/flow:plan` for their adapter; stop. On a typed adapter-resolution error, surface it verbatim and stop.

3. **Capture the feature description.** Use the plain-language feature description the operator gave when invoking the skill. If none was given, ask for one. Do not constrain its form.

4. **Build de-dup context.** Call `readBacklogInventory({ targetRepoRoot })` so the author subagent can avoid drafting a near-duplicate of an existing backlog item. Surface a typed error (e.g. a malformed manifest) verbatim and stop.

5. **Spawn the author subagent** via Claude Code's `Task` tool:
   - Read `readCatalogue({ role: "author" })` and use its `Prompt` section verbatim as the system prompt.
   - Append an `<initial-context>` block containing: `targetRepoRoot` (resolved absolute path), the operator's `feature_description`, and the `backlog_inventory` array from step 4.
   - The subagent runs the deterministic **validate-then-write**: it calls `validatePlannerBacklog` for an early friendly check, then calls `writeNativeStory`, which enforces the discipline gate fail-closed and returns `{ ref, path }`. The skill is a thin orchestrator — it does not duplicate the subagent's authoring logic, and it never drafts the story itself.

6. **Refuse-and-revise.** If the write tool refuses a draft, the subagent surfaces the specific violation codes back to you and proposes a revised framing. Nothing is written until a draft passes. Relay the codes and the revision offer; let the operator revise the feature framing and retry. The skill never tries to "fix" a violation by editing a manifest itself.

7. **Report the draft.** When the subagent emits its locked handoff phrase `Handoff — draft <ref> authored, not-ready, awaiting judgment`, report to the operator:
   - the draft's **short handle** (first 8 characters of the ULID for native refs) alongside the full **ref** — e.g. `[01KT1NR9] native:01KT1NR9F6133VHY601SF3BD5N`. Display the short handle as the primary identifier; include the full ref for completeness.
   - that it is **not-ready** (parked in the backlog behind the readiness brake — not claimable until judged and approved),
   - the next step: run `/flow:ready <ref>` to grade and approve it — the readiness cockpit now runs the judge panel as part of approving, so you see the per-lens verdict before you admit the story to the build loop. The draft is already in the backlog (materialisation is automatic — no separate scan step is needed). To re-sync if you edit the story file directly afterwards, run `/flow:plan`.

8. **Approval happens in `/flow:ready`, not here.** This skill never marks a story ready. A freshly drafted story is parked not-ready behind the readiness brake; to admit it, the operator runs `/flow:ready <ref>`, which grades it with the diverse-lens judge panel and — on their explicit approval — flips it ready. Do not call `markStoryReady` from this skill, and never offer an inline approval that would bypass the grade.

Never write to a story file or a manifest directly, never edit `.flow/state/**` or `.flow/native-stories/**` by hand, and never run a git command from this skill — every write flows through the `writeNativeStory` tool, which owns the discipline gate and the atomic write. Your job is to relay the operator's feature description to the author subagent and report the result.

# Failure modes

- **Wrong adapter:** `getStatus` resolves a non-native adapter. `/flow:author` is native-only; point the operator at `/flow:plan`.
- **The draft violates a discipline rule:** `writeNativeStory` throws `DisciplineViolationError` carrying the violation codes (e.g. `missing-integration-ac`) and writes nothing. This is the refuse-and-revise path (step 6) — surface the codes, revise the framing, retry. It is the gate working, not a tool failure.
- **A backlog manifest is malformed:** `readBacklogInventory` propagates `MalformedExecutionManifestError`, naming the file and offending field. Fix the manifest (or re-run `/flow:plan` to re-materialise) and retry.
- **No adapter / fresh repo:** `getStatus` surfaces `NoAdapterMatchedError`. Suggest `/flow:hire` to initialise the team and create the `.flow/native-stories/` directory first.
