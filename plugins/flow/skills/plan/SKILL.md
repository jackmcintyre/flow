---
name: flow:plan
description: "Open a planning conversation, or draft a single story in one shot with `/flow:plan <feature>`. On native repos, spawn the planner subagent to author stories; on BMad repos, point you at BMad's authoring skills and materialise the backlog automatically."
allowed_tools: [Task, readBacklogInventory, getStatus, scanSources, readCatalogue, validatePlannerBacklog, writeNativeStory]
---

# /flow:plan

# What this skill does

Opens a planning conversation. For `adapter: native` repos, this skill spawns the planner subagent via Claude Code's `Task` tool against the catalogue prompt at `plugins/flow/catalogue/planner.md`; the subagent drives the conversation and writes ULID-named story files under `<target-repo>/.flow/native-stories/` — each story is materialised into the backlog automatically by `writeNativeStory` as it is written, with no separate scan step required. For `adapter: bmad` repos, this skill points you at BMad's authoring skills (`/bmad-create-story`, `/bmad-edit-prd`) and automatically materialises newly authored stories into execution manifests on exit — no separate scan command is needed.

**Two ways in:** bare `/flow:plan` opens the full multi-story planning conversation; `/flow:plan <feature>` (a plain-language feature description as the argument) is the one-shot fast path — it drafts **one** story from your sentence with no conversation. The fast path is native-only; see the **Fast path** section below.

**Hand-edit refresh (both adapters):** If you edit a source story file directly outside the planning conversation, run `/flow:plan` again to pick up the changes. The planning flow calls the scan capability before presenting results, so re-running `/flow:plan` is the supported replacement for the retired `/flow:scan` command.

# Fast path — one-shot authoring (`/flow:plan <feature>`)

When the operator invokes this skill with a plain-language **feature description** as the argument, draft a single story from it directly — no planning conversation, no multi-story elicitation. This is the lean "propose one feature" seam (Epic 9 — the readiness review); it spawns a lean **author** subagent (distinct from the conversational planner) that produces exactly one draft.

The drafted story is never auto-ready: it is written **parked not-ready** behind the readiness brake (Story 9.1). To grade and approve it, the operator runs `/flow:ready <ref>` (which runs the judge panel as part of approving). Nothing the fast path drafts can be built until it is graded and approved — that is the gate working.

When a feature-description argument is present, run these steps and do NOT open the planning conversation below:

1. **Identify the target repo root** (the current Claude Code workspace root) as `targetRepoRoot`.
2. **Resolve the active adapter.** Call `getStatus({ targetRepoRoot })`. If the resolved `adapter` is **not** `native`, tell the operator that one-shot authoring is native-only and that BMad workspaces author via BMad's own skills (`/bmad-create-story`), then run bare `/flow:plan` (the conversation/BMad-pointer branch below) instead; stop the fast path. On a typed adapter-resolution error, surface it verbatim and stop.
3. **Capture the feature description** from the argument. Do not constrain its form.
4. **Build de-dup context.** Call `readBacklogInventory({ targetRepoRoot })` so the author subagent can avoid drafting a near-duplicate of an existing backlog item. Surface a typed error (e.g. a malformed manifest) verbatim and stop.
5. **Spawn the author subagent** via Claude Code's `Task` tool: read `readCatalogue({ role: "author" })` and use its `Prompt` section verbatim as the system prompt, then append an `<initial-context>` block containing `targetRepoRoot` (resolved absolute path), the operator's `feature_description`, and the `backlog_inventory` array from step 4. The subagent runs the deterministic **validate-then-write** (`validatePlannerBacklog` for an early friendly check, then `writeNativeStory`, which enforces the discipline gate fail-closed and auto-materialises the draft into the backlog — no separate scan step). The skill is a thin orchestrator and never drafts the story itself.
6. **Refuse-and-revise.** If the write tool refuses a draft, the subagent surfaces the specific violation codes and proposes a revised framing. Relay the codes and the revision offer; let the operator revise the framing and retry. Nothing is written until a draft passes. Never "fix" a violation by editing a manifest directly.
7. **Report the draft.** When the subagent emits its locked handoff phrase `Handoff — draft <ref> authored, not-ready, awaiting judgment`, report: the draft's **short handle** (first 8 chars of the ULID) alongside the full **ref**; that it is **not-ready** (parked behind the brake, not claimable until graded and approved); and the next step — run `/flow:ready <ref>` to grade and approve it. The draft is already in the backlog (materialisation is automatic). Approval happens in `/flow:ready`, never here: do not call `markStoryReady` from this skill.

# Prerequisites

A target repo. `.flow/config.yaml` SHOULD be present (auto-detected on first invocation by the workspace resolver — see `docs/README-install.md` checkpoint 5). If absent, the skill calls `getStatus` to trigger the resolver and surfaces any adapter-resolution error verbatim. At least one planning tool must be detectable (BMad stories root or a `.flow/native-stories/` directory) for the resolver to succeed without a config file.

# Steps

0. **Argument check (run first).** If the operator passed a plain-language feature description as the argument, run the **Fast path — one-shot authoring** section above instead of the steps below, and stop. Otherwise — no argument — open the full planning conversation below.

1. **Identify the target repo root.** Use the current Claude Code workspace root as `targetRepoRoot`.

2. **Resolve the active adapter.** Call `getStatus({ targetRepoRoot })` to resolve the active adapter. Capture the `adapter` field from the response. If the call fails with a typed error (`NoAdapterMatchedError`, `UnknownAdapterError`, etc.), surface the error verbatim and stop — the failure modes section covers each case.

3. **Branch on the resolved adapter name.**

4. **`adapter: native` branch:** Before spawning the subagent, call `readBacklogInventory({ targetRepoRoot })` to build the backlog inventory and determine mode:
   - The tool scans all four state directories and the `.flow/native-stories/` directory server-side, returns typed `{ mode, backlog_inventory }` JSON. **If the call surfaces a `MalformedExecutionManifestError` (or any other typed error), surface it verbatim and stop — the operator must fix the malformed manifest before re-opening planning.**
   - `mode` is `"first-run"` when the inventory is empty; `"re-open"` when at least one entry exists. `backlog_inventory` is an array of `{ ref, title, state, withdrawn }` objects.
   - spawn the planner subagent via Claude Code's `Task` tool against the catalogue prompt at `plugins/flow/catalogue/planner.md`. Assemble the `Task` system prompt as follows:
     - Read `readCatalogue({ role: "planner" })` and use its `Prompt` section verbatim as the system prompt.
     - Append an `<initial-context>` block containing:
       - `targetRepoRoot`: the resolved absolute path.
       - `mode`: `"first-run"` or `"re-open"` (string literal).
       - `backlog_inventory`: the array built above (empty array `[]` on first-run).
       - `existing_native_stories`: a JSON array of refs already under `<targetRepoRoot>/.flow/native-stories/` (kept for Story 3.4 backward compatibility).
       - `existing_manifests`: a JSON array of refs already under `<targetRepoRoot>/.flow/state/to-do/` (kept for Story 3.4 backward compatibility).
   - The planner subagent runs the planning conversation (four-step loop on first-run or action-menu on re-open) and calls `writeNativeStory` / `markWithdrawn` for each approved action. The skill is a thin orchestrator — do not duplicate the subagent's conversational logic.
   - **The four-step planning loop (`mode === "first-run"` or when operator chooses `add` from the re-open action menu).** The subagent drives this loop; the skill does not branch on the action choice.
   - **Exit condition (native branch):** the planner subagent emits the catalogue's terminal locked phrase: `Handoff to generalist-dev — story <story-id> ready to claim`. When that phrase appears, the skill reports each newly drafted story and points the operator at `/flow:ready <ref>` to grade and approve it, then exits. Stories are already materialised in the backlog — `writeNativeStory` calls the scan capability internally on each write, so no separate scan step is needed. If you have hand-edited a source story file directly, re-run `/flow:plan` to pick up the changes.
   - **Approval happens in `/flow:ready`, not here (native branch).** This skill never marks a story ready. Each drafted story is parked not-ready behind the readiness brake; to admit it, the operator runs `/flow:ready <ref>`, which grades it with the diverse-lens judge panel and — on their explicit approval — flips it ready. Do not call `markStoryReady` from this skill, and never offer an inline approval that would bypass the grade.

5. **`adapter: bmad` branch:** Call `readBacklogInventory({ targetRepoRoot })` the same way as Step 4 (the tool skips the native-stories scan on BMad workspaces). On typed errors, surface verbatim and stop. Determine `mode` from the returned `mode` field.
   - **First-run (no manifests yet):** print the following fixed pointer block verbatim, then automatically call `scanSources({ targetRepoRoot })` to materialise any stories that have been authored since the last scan. Print the scan result verbatim. Do NOT prompt the operator to run a scan manually — materialisation is automatic.

     ```
     BMad adapter detected. The flow plugin does not author BMad stories directly.
     Use BMad's own authoring skills instead:

     - /bmad-create-story  — author the next story in your backlog
     - /bmad-edit-prd      — edit the PRD before story authoring

     Once you have authored your stories, run /flow:plan to materialise them
     into per-story execution manifests under .flow/state/to-do/.
     ```

     Do NOT spawn the planner subagent on this branch in first-run mode.

   - **Re-open mode (at least one manifest exists):** print the same BMad-pointer block verbatim AND append the following one-line discard offer on a new line after the block:

     ```
     To withdraw a story from execution, run /flow:plan and choose 'discard' against the ref — the plugin will mark the manifest withdrawn (the source story in BMad remains your responsibility to close).
     ```

     Then spawn the planner subagent with the BMad-branch system prompt and the `<initial-context>` block (including `mode: "re-open"` and `backlog_inventory`). The subagent's BMad-branch behaviour (refuses `writeNativeStory`; only new write affordance is `markWithdrawn`) is preserved. The discard offer is what gives the operator an interactive surface for withdrawal in re-open mode.

   - **Exit condition (BMad branch):** the operator types `done` or the planner subagent emits the locked handoff phrase (re-open mode only). The skill automatically calls `scanSources({ targetRepoRoot })` on exit and prints the result verbatim — this picks up any stories authored or hand-edited since the last scan, so the operator never needs to run a separate scan command.

6. **Exit.** Both branches end with confirmation of what was written (native) or a pointer to the next step (BMad).

# Failure modes

- **`NoAdapterMatchedError`** (fresh repo without source stories): surface the error message verbatim. Suggest `/flow:hire` first to initialise the team, then add source stories (native: create the `.flow/native-stories/` directory; BMad: run `/bmad-create-story`).
- **`UnknownAdapterError`** (`.flow/config.yaml` names an unregistered adapter): surface the error message verbatim. The operator must edit the `adapter:` key in `.flow/config.yaml`.
- **`WrongAdapterError`** from `writeNativeStory` (programming bug — the routing in Step 3 should prevent this): surface the error for filing. This indicates a logic error in the skill or a race condition between adapter resolution and the write call.
- **`AmbiguousAdapterError`** (two adapters' `detect()` both returned true): surface verbatim. The operator must author `.flow/config.yaml` manually to pick one.
- **`MalformedExecutionManifestError`** (a `.yaml` file in `.flow/state/` is corrupt): surface verbatim and stop. The operator must fix or remove the malformed manifest before re-opening planning.

# Re-open mode

Re-open mode activates on any invocation where the target repo already has at least one execution manifest under `.flow/state/` OR (native branch) at least one ULID-pattern `.md` file under `.flow/native-stories/`.

**Detection rule:** any `.yaml` file in `<targetRepoRoot>/.flow/state/{to-do,in-progress,blocked,done}/` OR (native only) any `<ULID>.md` file in `<targetRepoRoot>/.flow/native-stories/` → `mode = "re-open"`. Zero such files → `mode = "first-run"`.

**`backlog_inventory` shape passed to the planner:**
```
[
  { ref: "native:<ULID>", title: "Story title", state: "to-do", withdrawn: false },
  { ref: "native:<ULID>", title: "Another story", state: "in-progress", withdrawn: false },
  { ref: "bmad:1.1", title: "BMad story", state: "done", withdrawn: false },
  { ref: "native:<ULID>", title: "Source only", state: "native-source-only", withdrawn: false },
]
```

**Action menu the planner presents (re-open mode):**
```
1. add — author a new story
2. edit-pending — rewrite a story currently in to-do/
3. discard — withdraw a feature (built or pending)
```

The planner subagent handles routing from the action menu (see `### Re-open mode — backlog review and discard flow` in the planner catalogue prompt). The skill does NOT branch on the operator's action choice; the subagent does.
