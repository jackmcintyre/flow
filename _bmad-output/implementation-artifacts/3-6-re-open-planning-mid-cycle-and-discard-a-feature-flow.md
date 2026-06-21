# Story 3.6: Re-open planning mid-cycle and discard-a-feature flow

story_shape: user-surface

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin operator priming and shepherding a continuous-flow backlog**,
I want **to re-open `/crew:plan` mid-cycle to add new stories, edit a pending story that is still in `to-do/`, or discard a previously built feature — with the discard flow producing a `revert/deprecate` story for the native adapter and a `mark-withdrawn` manifest write for external adapters (BMad) plus a reminder to close the source story in that tool**,
so that **I can correct course on a live backlog without restarting from scratch, and without the dev loop ever claiming a story I have since decided to withdraw**.

### What this story is, in one sentence

Extend `/crew:plan` so a second (and subsequent) invocation does not just re-author from a blank slate: it surfaces the current backlog (existing native stories + execution manifests under `.crew/state/`), offers three branching actions — **add** (existing Story 3.4 path), **edit-pending** (rewrite a `to-do/`-state story), and **discard** (withdraw a feature) — refuses to mutate stories that are already in `in-progress/`, and routes the discard action through two new MCP primitives (`writeNativeStory` extended to author a `revert/deprecate` story for native, and a new `markWithdrawn` MCP tool that flips `withdrawn: true` on an execution manifest for external adapters). The dev loop's claim path is updated to skip any manifest with `withdrawn: true`.

### What this story fixes (and why it needs its own story)

Story 3.4 ships the first-invocation `/crew:plan` flow — fresh planning conversation, write new native stories, exit. Story 3.5 added the discipline gate. Neither covers re-opening the planner against an existing backlog, nor the discard semantics. Today, re-running `/crew:plan` produces a fresh batch as if nothing exists — the operator can accidentally re-author duplicates, cannot edit a pending story that has a typo, and has no first-class path to withdraw a feature that has already shipped. The `withdrawn` field has been on the manifest schema since Story 3.2 (`execution-manifest.ts` line 105) but nothing writes it. Architecture §FR78 names `mark-withdrawn.ts` as the planned MCP tool surface for the external-adapter discard path. This story closes those three loops (FR8, FR14 read-only-in-progress guard, FR78 discard) end-to-end. It is the final user-facing planner story in Epic 3 before Story 3.7 (plain-language guideline + direct-edit allowance).

### This story does NOT

- (a) Touch `_bmad-output/implementation-artifacts/sprint-status.yaml` or any other file under `_bmad-output/implementation-artifacts/`. The orchestrator owns status transitions. The dev agent MUST NOT edit any status/state file when implementing this story.
- (b) Change the `PlanningAdapter` interface signature in `mcp-server/src/adapters/adapter.ts`. `markWithdrawn` is a tool-layer concern, not an adapter-interface concern — both adapters' manifests live in the same execution layer (`.crew/state/`), so manifest mutation is adapter-agnostic at the file level.
- (c) Implement a hand-edit allowance for execution manifests in `to-do/` or `blocked/`. That is Story 3.7's scope (FR14 second half). This story's edit-pending path mutates the **source story file** (the native `.md` under `.crew/native-stories/<ref>.md` for native, or — out of scope here — the BMad story file for BMad). Edit-pending is native-only in v1 for the same reason authoring is native-only: external adapters own their source tree.
- (d) Re-implement `scanSources` or the state-machine directory layout. The edit-pending path may produce a re-write of an existing native story file; the next `scan-sources` invocation handles `source_hash` refresh per Story 3.2 AC3 (manifests still in `to-do/` get their hash updated; manifests not in `to-do/` are not touched).
- (e) Implement the orchestrator/dev-loop's reaction to `withdrawn: true` beyond a single load-bearing predicate: `manifest.withdrawn === true` ⇒ skip (do not claim). The richer surfacing (operator-facing summary of withdrawn refs, retro inclusion, etc.) is Epic 5 orchestrator scope. This story produces the withdrawal; it does not yet consume it for telemetry.
- (f) Delete any source story file or any execution manifest. Native discard authors a NEW story (`revert/deprecate <original-title>`); external discard writes `withdrawn: true` on the manifest. The original native story and the original execution manifest persist on disk so the history (and any in-flight verdict footers, lessons, etc.) remains traceable. This story NEVER unlinks a `.md` or `.yaml` file in `<target-repo>/.crew/`.
- (g) Add a BMad-side "close the story in BMad" action. The plugin cannot mutate BMad's source tree (read-only contract per `planning-adapter-model.md` §Two-layer model). The BMad branch of the discard flow surfaces a reminder string to the operator and exits; closing the BMad story is the operator's manual step in BMad's own UI / skills.
- (h) Detect or refuse "discarding a story still in-progress" beyond the existing read-only-in-progress guard. The operator may discard a story whose original execution manifest is in `done/` (the documented FR78 case — discard a *built* feature). Discarding a story whose original manifest is in `in-progress/` is permitted (the operator may want to abandon mid-stream); the dev loop's next claim attempt sees `withdrawn: true` and skips. The orchestrator's reaction to mid-flight withdrawal is Epic 5's concern.
- (i) Add a richer in-conversation diff UI. Edit-pending re-writes the native story file end-to-end (treating the existing AC set as the operator's editable starting point). v1 does not show a structured diff in chat; the operator approves the rewritten body as a whole.
- (j) Change the planner's locked handoff phrase grammar. The same `Handoff to generalist-dev — story <story-id> ready to claim` phrase is emitted at the end of every successful flow (add, edit-pending, discard). Discard's `<story-id>` is the ref of the NEW `revert/deprecate` story (native) or the ref of the withdrawn manifest (external).

---

## Acceptance Criteria

> Verbatim from epic for AC1–AC4, with user-surface tags applied per `plugins/crew/docs/user-surface-acs.md`. AC5 is the deterministic content-structure check required by the spec brief (LLM outputs are non-deterministic; structural anchors make ACs verifiable without human judgement).

**AC1 (user-surface):**
**Given** a target repo with stories present in `<target-repo>/.crew/state/to-do/`, `<target-repo>/.crew/state/in-progress/`, and `<target-repo>/.crew/state/done/` (i.e. a primed, partially-executed backlog) and `adapter: native` configured,
**When** I run `/crew:plan` a second time,
**Then** the planner subagent surfaces a current-backlog summary (counts per state directory, plus a list of refs and titles) and offers three actions to the operator — `add` (new story), `edit-pending` (rewrite a story currently in `to-do/`), `discard` (withdraw a built or pending feature); the planner MUST NOT offer `edit-pending` against any ref whose manifest is in `in-progress/` and MUST refuse to proceed if the operator names such a ref (surface the refusal verbatim: `"Story <ref> is in-progress and cannot be edited. Wait for it to land in done/ or blocked/, or discard it instead."`). _(FR8, FR14)_
<!-- User-surface: AC1 governs the observable behaviour of `/crew:plan` (rubric i — slash command literal) on its second invocation. The backlog summary and the three-action prompt are observed in the Claude Code chat (rubric iv — UI element the operator observes). The refusal string is verbatim observable surface. -->

**AC2:**
**Given** the operator chooses `discard` against a ref `native:<ULID>` whose execution manifest is in `done/` (or `to-do/` or `blocked/`),
**When** the planner runs the discard flow on the native branch,
**Then** the planner calls `writeNativeStory` with a new story whose `title` begins with the literal prefix `revert/deprecate: ` followed by the original story's title, whose `narrative` cites the original ref in `depends_on`, whose `acceptance_criteria` describes the reversal at user-value level, and whose `implementation_notes` names the files / surfaces to undo; the original native story file (`<target-repo>/.crew/native-stories/<original-ULID>.md`) and the original execution manifest are NOT deleted, modified, or moved. The new revert story enters the backlog as a fresh `to-do/` manifest on the next `/crew:scan`. _(FR78, Architecture Gap 3, `planning-adapter-model.md` §FR78 row)_
<!-- Not user-surface: AC2 governs internal planner→`writeNativeStory` behaviour; the operator observes the planner's confirmation, but the AC asserts the structural shape of the resulting source file (filename pattern, title prefix, depends_on contents) — these are inspected by tests, not observed in chat. The chat-side observable is covered by AC1's action prompt and the AC5 catalogue anchor. -->

**AC3:**
**Given** the operator chooses `discard` against a ref `bmad:<source-id>` (or any external-adapter ref) whose execution manifest exists anywhere under `<target-repo>/.crew/state/`,
**When** the planner runs the discard flow on the external-adapter branch,
**Then** the planner calls a new `markWithdrawn` MCP tool with `{ targetRepoRoot, ref }`; the tool reads the existing manifest from whichever state directory it lives in (`to-do/`, `in-progress/`, `blocked/`, or `done/`), flips `withdrawn: false → true` in-place (same directory, same filename), re-serialises the manifest deterministically via the existing YAML writer, and writes back via the atomic-rename primitive; the planner then surfaces a fixed reminder string to the operator: `"Manifest marked withdrawn. Close the source story in <adapter-name> manually — the plugin cannot edit the source tool's tree."` Idempotency: calling `markWithdrawn` on an already-`withdrawn: true` manifest MUST succeed without rewriting the file (mtime-stable). _(FR78, `planning-adapter-model.md` §FR78 row)_
<!-- Not user-surface: AC3 governs the internal `markWithdrawn` MCP tool and the manifest-on-disk shape after withdrawal. The reminder string is observed in chat, but the AC's load-bearing assertions (manifest bytes, idempotency, no source-tree write) are substrate. AC1's chat-observable action prompt covers the user-surface side. -->

**AC4:**
vitest covers the three branches (add / edit-pending / discard) for both adapters end-to-end, plus the read-only-in-progress guard. Specifically: (a) native add — round-trip a single-story planning conversation against a tmpdir target repo with `adapter: native` and an existing primed backlog; assert the new story file is written and the existing files are untouched; (b) native edit-pending — drive the planner to rewrite a story whose manifest is in `to-do/`; assert the source file's bytes change and the manifest's `source_hash` updates on the next `scan-sources` call; (c) native discard — drive the planner through the discard flow; assert a new `revert/deprecate:` story file appears, original files are untouched, and the new story carries the original ref in `depends_on`; (d) BMad add — assert the planner refuses to author and prints the BMad pointer (Story 3.4 invariant preserved); (e) BMad edit-pending — assert the planner refuses with `"Edit-pending is native-only in v1. Edit the source story in <adapter-name> and run /crew:scan."`; (f) BMad discard — drive `markWithdrawn` against a BMad fixture manifest; assert the manifest bytes flip `withdrawn` to `true` in the same state directory, idempotent on second call; (g) in-progress guard — for both adapters, attempt `edit-pending` against an in-progress ref; assert the planner emits the locked refusal string and never calls any write tool; (h) dev-loop skip — assert (via a unit test against the claim path or a stub call to the orchestrator's claim helper, whichever is the smallest seam) that a manifest with `withdrawn: true` is filtered out of the claim candidate set.
<!-- Not user-surface: AC4 is the integration-test surface. Tests are not observed by the operator. -->

**AC5:**
**Given** the planner catalogue prompt at `plugins/crew/catalogue/planner.md`,
**When** the file is inspected,
**Then** its `## Prompt` section contains a verbatim `### Re-open mode — backlog review and discard flow` subsection that (i) instructs the planner on first turn of a re-opened conversation to read the existing-backlog inventory provided in `<initial-context>` and present the add / edit-pending / discard action menu, (ii) names the literal `markWithdrawn` MCP tool as the external-adapter discard primitive, (iii) names the literal title prefix `revert/deprecate: ` as the native-adapter discard story shape, (iv) enumerates the in-progress refusal string verbatim (`"Story <ref> is in-progress and cannot be edited. Wait for it to land in done/ or blocked/, or discard it instead."`), and (v) enumerates the external-adapter reminder string verbatim (`"Manifest marked withdrawn. Close the source story in <adapter-name> manually — the plugin cannot edit the source tool's tree."`).
<!-- Not user-surface: AC5 governs an internal catalogue/prompt file the operator does not read or invoke directly; it is the structural anchor that makes the prompt-level behavioural contract (AC1's action menu and refusal strings) verifiable without exercising the LLM. -->

---

## Behavioural contract

The re-open flow has three execution paths: (1) the `/crew:plan` skill assembles a richer `<initial-context>` block for the planner subagent's second-and-subsequent invocations; (2) the planner subagent presents the action menu and routes to the correct write tool; (3) a new `markWithdrawn` MCP tool mutates manifests in-place. Each is bound by the invariants below. The planner is LLM-driven; the skill and the MCP tool are pure code. The contract distinguishes between the three.

### `/crew:plan` skill (`plugins/crew/skills/plan/SKILL.md`)

- **MUST** detect re-open mode by inspecting the resolved workspace before spawning the subagent: re-open mode is when ANY of `<targetRepoRoot>/.crew/state/to-do/`, `.crew/state/in-progress/`, `.crew/state/blocked/`, `.crew/state/done/` contains at least one `.yaml` manifest, OR (native branch only) when `<targetRepoRoot>/.crew/native-stories/` contains at least one `.md` file matching the ULID pattern.
- **MUST**, in re-open mode, extend the existing `<initial-context>` block with two additional fields: `mode: "re-open"` (string literal; absent or `"first-run"` on a clean repo) and `backlog_inventory:` — an array of objects shaped `{ ref: string, title: string, state: "to-do" | "in-progress" | "blocked" | "done" | "native-source-only", withdrawn: boolean }`. The skill builds this array by reading every `.yaml` under `.crew/state/<state>/` (parsing through `parseExecutionManifest` for `title`, `withdrawn`) and, on the native branch only, supplementing with any `.md` files under `.crew/native-stories/` whose ULID does not yet have a manifest (those entries get `state: "native-source-only"`).
- **MUST NOT** call any write tool itself. The skill assembles context; the subagent (or the new `markWithdrawn` tool, called by the subagent) does all writes.
- **MUST**, on the BMad branch, still print the existing Story 3.4 BMad-pointer block verbatim AND additionally append a one-line discard offer: `"To withdraw a story from execution, run /crew:plan and choose 'discard' against the ref — the plugin will mark the manifest withdrawn (the source story in <adapter-name> remains your responsibility to close)."` This append happens only in re-open mode (i.e. when at least one manifest exists). On a fresh BMad repo with no manifests yet, the unchanged Story 3.4 BMad-pointer block prints verbatim with no append.
- **MUST** still spawn the planner subagent on the native branch even in re-open mode — the subagent is the single conversational surface; it handles add / edit-pending / discard via the action menu. The skill does NOT branch on the action choice; the subagent does.
- **MUST**, on the BMad branch in re-open mode, ALSO spawn the planner subagent (with the BMad-pointer text and the discard offer in `<initial-context>`) so the operator can drive a discard via `markWithdrawn` from inside the same conversation. The subagent's BMad-branch behaviour (no `writeNativeStory`) is preserved; the only NEW write affordance it gains on the BMad branch is `markWithdrawn`. (This is a deliberate scope widening from Story 3.4 where the BMad branch did not spawn the subagent at all — re-open mode needs an interactive surface for discard.)
- **MUST NOT** change the Story 3.4 first-run flow's observable behaviour. A fresh repo with zero manifests still produces the exact Story 3.4 chat surface — the new context fields are absent or set to `mode: "first-run"`, `backlog_inventory: []`.

### Planner catalogue prompt (LLM-driven — `plugins/crew/catalogue/planner.md`)

- **MUST** include a new `### Re-open mode — backlog review and discard flow` subsection in the `## Prompt` section, after the existing `### Discipline validation — pre-write check` subsection and before the `### Scope reminder` subsection. This is the AC5 anchor.
- **MUST**, on entering a conversation where `<initial-context>.mode === "re-open"`, FIRST emit a backlog-summary turn that lists `backlog_inventory` grouped by state directory (counts + ref/title pairs), THEN present the action menu as a numbered list: `1. add — author a new story`, `2. edit-pending — rewrite a story currently in to-do/`, `3. discard — withdraw a feature (built or pending)`. The planner MUST wait for the operator's choice before proceeding.
- **MUST**, on action `edit-pending`, refuse if the named ref's `state` in `backlog_inventory` is `"in-progress"` — emit verbatim: `"Story <ref> is in-progress and cannot be edited. Wait for it to land in done/ or blocked/, or discard it instead."` and re-present the action menu.
- **MUST**, on action `edit-pending` against the BMad branch, refuse with verbatim: `"Edit-pending is native-only in v1. Edit the source story in <adapter-name> and run /crew:scan."` and re-present the action menu.
- **MUST**, on action `edit-pending` against a valid `native:<ULID>` ref whose state is `to-do` (or `blocked` or `native-source-only`), read the existing native story via `readSourceStory(ref)`, walk the operator through the existing narrative / ACs / depends_on / implementation_notes, accept their edits, run the discipline gate (`validatePlannerBacklog` per Story 3.5 — the gate runs against the edited body as a single pending story), and on `{ ok: true }` call `writeNativeStory` with the new content. The `writeNativeStory` call writes a NEW ULID-named file (a new ref) because the tool generates a fresh ULID on every invocation. The planner MUST then surface to the operator: `"Replaced <old-ref> with <new-ref>. Run /crew:scan to refresh manifests. The old source file remains on disk for traceability."` The planner MUST NOT delete the old source file. (The next `scan-sources` pass treats the old ref as removed-from-source and the new ref as added; the old manifest in `to-do/` is left in place per the existing `scan-sources` invariant — `scan-sources` never deletes manifests. Operator can hand-discard the old ref via the discard flow if they want it out of the dev-loop's view.)
  - **Design note (not an invariant):** A future story may add a "rename source ref" operation that preserves the ULID across an edit. v1 takes the simpler write-new-ULID path because the alternative would require either (a) overwriting an existing ULID-named file (violates the "ULIDs are write-once" property the native adapter relies on for sort order) or (b) a new MCP tool. The operator's mental model is "edits produce a new revision"; this matches it.
- **MUST**, on action `discard` against a `native:<ULID>` ref, call `writeNativeStory` with: `title: "revert/deprecate: " + <original-title>`, `narrative` citing the original ref in plain language ("This story reverses the feature shipped by `<original-ref>` (<original-title>). The operator chose to withdraw it on <date placeholder — planner emits ISO date>."), `acceptance_criteria` (at least one AC tagged `integration` per discipline rules — the planner asks the operator what "fully reverted" looks like and drafts the AC at user-value level), `depends_on: [<original-ref>]`, `implementation_notes` (planner-drafted list of likely files/surfaces to undo, marked as a starting point not a binding contract). Run the discipline gate before writing. The planner MUST NOT modify the original native story file or the original execution manifest.
- **MUST**, on action `discard` against a `<adapter>:<source-id>` ref where `<adapter> !== "native"`, call `markWithdrawn({ targetRepoRoot, ref })`. On success, emit verbatim: `"Manifest marked withdrawn. Close the source story in <adapter-name> manually — the plugin cannot edit the source tool's tree."` Do NOT call `writeNativeStory` on the external-adapter discard branch (the planner would be authoring a native revert story against a BMad ref — wrong layer).
- **MUST**, after every successful add / edit-pending / native-discard / external-discard, emit the locked handoff phrase verbatim: `Handoff to generalist-dev — story <story-id> ready to claim` where `<story-id>` is the ref of the new story (for add / edit-pending / native-discard) or the ref of the just-withdrawn manifest (for external-discard).
- **MUST NEVER** call `markWithdrawn` against a `native:<ULID>` ref. Native discard is `writeNativeStory` + revert-story authoring; `markWithdrawn` is the external-adapter primitive. Conflating them would skip the discipline gate (the revert story needs validation; the withdrawn manifest does not).
- **MUST** preserve every existing behavioural invariant from Story 3.4's planner contract AND Story 3.5's discipline-gate contract. This subsection extends; it does not replace.
- **MUST NEVER** discard a story autonomously based on the planner's own judgement. Discard is an explicit operator action; the planner only routes.

### `markWithdrawn` MCP tool (pure code — new tool)

- **MUST** be a new MCP tool at `plugins/crew/mcp-server/src/tools/mark-withdrawn.ts`, registered in `register.ts` alongside `writeNativeStory` and `scanSources`. The architecture's planned path is `mark-withdrawn.ts` (per `project-structure-boundaries.md` line 86); use that filename verbatim.
- **MUST** accept input shape `{ targetRepoRoot: string; ref: string }` validated via Zod. `ref` is the canonical `<adapter>:<source-id>` shape; the tool MUST NOT regex-validate the source-id portion (adapter-specific).
- **MUST** resolve the workspace via `resolveWorkspace(targetRepoRoot)` — this also wires the adapter context per Story 3.3b.
- **MUST** locate the manifest by scanning the four state directories in canonical order (`to-do`, `in-progress`, `blocked`, `done`) for `<ref>.yaml`. The first match wins. If no match is found, throw a typed `ManifestNotFoundError` (existing error type — see `mcp-server/src/errors.ts`).
- **MUST** read the manifest via the canonical reader `parseExecutionManifest` (existing helper in `schemas/execution-manifest.ts`). Malformed manifests surface the existing `MalformedExecutionManifestError`; do not catch and downgrade.
- **MUST**, on a manifest where `withdrawn === true` already, return `{ ref, alreadyWithdrawn: true, state: <state-name> }` WITHOUT rewriting the file. Idempotency requirement: no mtime touch on no-op (mirrors the existing `scan-sources` idempotency contract).
- **MUST**, on a manifest where `withdrawn === false` (or absent, defaulting to false per schema), construct a new manifest object identical to the parsed one but with `withdrawn: true`, re-serialise via the same YAML stringification path used by `scan-sources` (use the same `yaml.stringify` call signature; field order is preserved by the schema-driven shape), and write back to the SAME absolute path via the atomic-write primitive (`atomicWriteFile` from `lib/managed-fs.ts`). The manifest MUST NOT move between state directories — `withdrawn` is orthogonal to state.
- **MUST** return `{ ref, alreadyWithdrawn: false, state: <state-name>, absPath: <string> }` on a successful flip.
- **MUST NEVER** modify any field other than `withdrawn`. The manifest's `status`, `ref`, `acceptance_criteria`, `depends_on`, `source_hash`, `verdict`, `lessons`, etc. are preserved byte-identical (modulo `withdrawn: true`).
- **MUST NEVER** delete or move any file. The tool is a single in-place rewrite.
- **MUST NEVER** call out to the network, shell, or any process outside the MCP server.
- **MUST** throw `WrongAdapterError` if `ref` starts with `<active-adapter>:` and `<active-adapter>` is `native` — the planner's contract is to use `writeNativeStory` for native discard, not `markWithdrawn`. This guard prevents the planner from mis-routing. (Edge case: a mixed-adapter repo where `ref` starts with `native:` but the active adapter is BMad — the tool MUST still proceed in that case; the guard is "active adapter is native" not "ref namespace is native".) (Note: `ManifestNotFoundError` and `WrongAdapterError` already exist per Story 3.4.)
- **MUST** be deterministic: re-running against the same manifest produces byte-identical output (idempotency invariant).

### Dev-loop skip predicate (preserves Epic 5's seam)

- **MUST** add a single predicate `isClaimable(manifest: ExecutionManifest): boolean` to the existing manifest-state-machine module (`mcp-server/src/state/manifest-state-machine.ts`) returning `manifest.withdrawn === false && manifest.status === "to-do"`. This is the load-bearing "withdrawn means skipped" assertion; it lives next to the other state-machine primitives so Epic 5's claim path imports it from one place. The predicate MUST be pure — no I/O.
- **MUST NOT** add a claim-path implementation in this story. Epic 5 owns the claim loop. This story produces the predicate and asserts a unit test of it; orchestrator consumption is Epic 5's pickup.
- **MUST NEVER** silently treat `withdrawn: true` as a soft signal. Once flipped, the manifest is permanently out of the dev loop's claim candidate set (unless an operator hand-edits it back; that capability is FR14 / Story 3.7's territory).

### Negative-capability invariants

- **MUST NEVER** modify any file under `_bmad-output/implementation-artifacts/`. The dev agent does not touch `sprint-status.yaml`.
- **MUST NEVER** delete a source story file (`.md` under `.crew/native-stories/`) or an execution manifest (`.yaml` under `.crew/state/`). Discard authors / mutates; it does not delete.
- **MUST NEVER** mutate a source story under an external adapter's tree (e.g. `_bmad-output/planning-artifacts/stories/`). The plugin is read-only against external source layers.
- **MUST NEVER** call `gh` from the planner or from `markWithdrawn`. The Story 3.4 `gh_allow: [pr-view]` allowlist remains the upper bound for the planner; `markWithdrawn` has no `gh` access at all.
- **MUST NEVER** present an `edit-pending` action against an `in-progress/` ref. The planner enforces this at prompt level; the skill encodes the state in `backlog_inventory` so the planner has the data to enforce.

---

## Tasks / Subtasks

- [ ] **Task 1 — Backlog-inventory builder in the `/crew:plan` skill (AC: 1, 5)**
  - [ ] 1.1 Edit `plugins/crew/skills/plan/SKILL.md`. Extend Step 4 (`adapter: native` branch) and add equivalent Step 4b logic for `adapter: bmad` re-open mode. The skill MUST, before spawning the subagent, read every `.yaml` under `<targetRepoRoot>/.crew/state/{to-do,in-progress,blocked,done}/`, parse each via `parseExecutionManifest`, and accumulate a `backlog_inventory` array of `{ ref, title, state, withdrawn }`. On the native branch, also list every `.md` under `<targetRepoRoot>/.crew/native-stories/` matching the ULID pattern whose `native:<ULID>` ref does not appear in any manifest; add those as `state: "native-source-only"`, `withdrawn: false`, with `title` parsed from the file's first H1.
  - [ ] 1.2 Determine `mode`: if `backlog_inventory.length === 0`, `mode = "first-run"`; otherwise `mode = "re-open"`. Pass both fields into the `<initial-context>` JSON block alongside the existing Story 3.4 fields (`targetRepoRoot`, `existing_native_stories`, `existing_manifests`). The existing two fields remain; `backlog_inventory` is the new authoritative inventory and supersedes them for re-open behaviour, but the old fields are kept for Story 3.4 backward compatibility.
  - [ ] 1.3 On the BMad branch, in re-open mode only, append the one-line discard offer (verbatim per Behavioural contract) to the existing BMad-pointer block. Then spawn the planner subagent with the BMad-branch system prompt (which the catalogue planner already handles via the Story 3.4 `adapter: bmad` MUST-refuse-to-author invariant). On first-run BMad, the existing Story 3.4 behaviour (print pointer, do not spawn subagent) is preserved.
  - [ ] 1.4 Add a skill-side guard: if reading any `.yaml` under `.crew/state/` throws `MalformedExecutionManifestError`, surface the error verbatim and stop. Do not silently drop malformed manifests — the operator needs to fix them before re-opening planning (per the existing FR13 contract).

- [ ] **Task 2 — Planner catalogue prompt extension (AC: 1, 2, 3, 5)**
  - [ ] 2.1 Edit `plugins/crew/catalogue/planner.md`. Append a new subsection `### Re-open mode — backlog review and discard flow` to the `## Prompt` section, AFTER the existing `### Discipline validation — pre-write check` subsection and BEFORE the existing `### Scope reminder` subsection. This is the AC5 anchor.
  - [ ] 2.2 Subsection content MUST include verbatim (these literal strings are what the AC5 grep-test asserts):
    - The literal heading `### Re-open mode — backlog review and discard flow`.
    - The literal tool name `markWithdrawn` (the external-adapter discard primitive).
    - The literal title prefix `revert/deprecate: ` (the native-adapter revert story shape).
    - The literal refusal string `"Story <ref> is in-progress and cannot be edited. Wait for it to land in done/ or blocked/, or discard it instead."`
    - The literal refusal string `"Edit-pending is native-only in v1. Edit the source story in <adapter-name> and run /crew:scan."`
    - The literal reminder string `"Manifest marked withdrawn. Close the source story in <adapter-name> manually — the plugin cannot edit the source tool's tree."`
    - The literal action-menu labels `1. add — author a new story`, `2. edit-pending — rewrite a story currently in to-do/`, `3. discard — withdraw a feature (built or pending)`.
  - [ ] 2.3 Body of the subsection encodes the prompt-level invariants from § Behavioural contract → Planner catalogue prompt, verbatim where the contract uses MUST / MUST NOT / MUST NEVER absolute modals.
  - [ ] 2.4 Add `markWithdrawn` to `tools_allow` in the planner frontmatter (top of `planner.md`) — sibling of the existing `writeNativeStory` and `validatePlannerBacklog` entries.
  - [ ] 2.5 Add `markWithdrawn` to `tools_allow` in `plugins/crew/permissions/planner.yaml`.
  - [ ] 2.6 Preserve every existing invariant in the planner prompt — do not remove, narrow, or contradict the Story 3.4 or Story 3.5 sections. The new subsection extends; it does not replace.

- [ ] **Task 3 — `markWithdrawn` MCP tool (AC: 3, 4)**
  - [ ] 3.1 Create `plugins/crew/mcp-server/src/tools/mark-withdrawn.ts`. Zod input schema: `{ targetRepoRoot: z.string().min(1), ref: z.string().min(1) }`. Output type: `{ ref: string; alreadyWithdrawn: boolean; state: StateName; absPath: string }`.
  - [ ] 3.2 Implementation flow: `resolveWorkspace` → scan the four state directories (`STATE_NAMES` from `manifest-state-machine.ts`) for `<ref>.yaml` (first match wins) → throw `ManifestNotFoundError` if none → throw `WrongAdapterError` if `workspace.activeAdapterName === "native"` (per § Behavioural contract — the planner should not be calling `markWithdrawn` on native; the guard catches mis-routing) → read file → `parseExecutionManifest` (canonical reader) → if `withdrawn === true`, return `{ alreadyWithdrawn: true, ... }` without writing → else construct `{ ...parsed, withdrawn: true }`, stringify via the existing YAML writer used by `scan-sources` (lift the helper into a shared module if needed — see Task 3.5), write atomically.
  - [ ] 3.3 Register the tool in `plugins/crew/mcp-server/src/tools/register.ts` next to `validatePlannerBacklog`. The `description` field MUST cite FR78 verbatim: `"Mark an execution manifest withdrawn (FR78). External-adapter discard path. Native discard uses writeNativeStory with a revert/deprecate story instead."`.
  - [ ] 3.4 Add an integration test at `plugins/crew/mcp-server/src/tools/__tests__/mark-withdrawn.integration.test.ts` covering AC3's contract: (a) flip a BMad-fixture manifest in `done/` from `withdrawn: false → true`; assert manifest bytes change as expected and the state directory does not change; (b) re-call against the same ref; assert the second call returns `{ alreadyWithdrawn: true }` and the file mtime does NOT change (idempotency); (c) attempt against a non-existent ref; assert `ManifestNotFoundError`; (d) attempt against a `native` adapter workspace; assert `WrongAdapterError`; (e) attempt against a manifest in `in-progress/`; assert success (the in-progress guard is the planner's responsibility, not the tool's — the tool is layer-agnostic).
  - [ ] 3.5 If `scan-sources` does not already expose its YAML-stringify helper as a shared function, extract it into `mcp-server/src/lib/manifest-yaml.ts` (or co-locate in `schemas/execution-manifest.ts`) so both `scan-sources` and `mark-withdrawn` use the same writer. Field order and quoting style MUST match — otherwise a re-scan after a withdraw could produce a spurious rewrite. Recommended default: keep the writer co-located with the schema (single source of truth for serialisation shape).

- [ ] **Task 4 — `isClaimable` predicate (AC: 4)**
  - [ ] 4.1 Add `export function isClaimable(manifest: ExecutionManifest): boolean { return manifest.withdrawn === false && manifest.status === "to-do"; }` to `plugins/crew/mcp-server/src/state/manifest-state-machine.ts`. Pure; no I/O.
  - [ ] 4.2 Add a co-located unit test that covers: `withdrawn: false, status: "to-do"` → true; `withdrawn: true, status: "to-do"` → false; `withdrawn: false, status: "blocked"` → false; `withdrawn: true, status: "done"` → false. Four cases, deterministic.
  - [ ] 4.3 Add a TSDoc comment citing this story and noting that Epic 5's claim path imports this predicate as the single load-bearing "withdrawn means skipped" gate.

- [ ] **Task 5 — End-to-end integration tests (AC: 4)**
  - [ ] 5.1 Add `plugins/crew/mcp-server/src/skills/__tests__/plan-reopen.integration.test.ts` (or co-locate with existing planner integration tests at the existing path) covering the seven branches of AC4 — (a) through (g). Each branch operates against a tmpdir target repo with the relevant adapter config and a pre-seeded backlog. The tests drive the planner subagent via the same harness Story 3.4 uses (or, if that harness exercises the LLM, swap it for a deterministic conversation script — preferable for v1 — that exercises the planner's prompt-level routing without depending on LLM behaviour).
  - [ ] 5.2 Branch (h) — dev-loop skip — is a small unit test against `isClaimable` (covered by Task 4.2). Keep it co-located with the predicate, not in the planner integration suite.
  - [ ] 5.3 Add a fixture under `plugins/crew/mcp-server/src/adapters/bmad/fixtures/` with a manifest in `done/` carrying `withdrawn: false`; used by the Task 3.4 idempotency test and the Task 5.1 BMad-discard branch.
  - [ ] 5.4 Add a fixture under `plugins/crew/mcp-server/src/adapters/native/fixtures/` with a pre-seeded `.crew/state/` tree (one ref each in `to-do/`, `in-progress/`, `done/`) and matching native source files in `.crew/native-stories/`; used by the native-branch AC4 paths.

- [ ] **Task 6 — `/crew:plan` skill: re-open branch documentation (AC: 1)**
  - [ ] 6.1 Edit `plugins/crew/skills/plan/SKILL.md`. Add a new section `# Re-open mode` after the existing `# Failure modes` section explaining (i) the re-open detection rule (any `.yaml` under `.crew/state/` OR any ULID `.md` under `.crew/native-stories/`), (ii) the `backlog_inventory` shape passed to the planner, (iii) the action menu the planner presents.
  - [ ] 6.2 Update the existing Step 4 description to reference the new `<initial-context>` fields (`mode`, `backlog_inventory`) and note that the four-step planning loop runs only when `mode === "first-run"` OR when the operator chooses `add` from the re-open action menu.
  - [ ] 6.3 Update Step 5 (the BMad branch) to add the discard-offer append rule (verbatim line, only in re-open mode).

- [ ] **Task 7 — Documentation and wire-up (AC: 1, 3, 5)**
  - [ ] 7.1 Update `plugins/crew/docs/README-install.md`: add a one-paragraph section on the discard flow. Name both branches (native = revert story; external = `mark-withdrawn` + manual close in source tool). Cite FR78. Add a one-line bullet on how to confirm a withdrawal landed: inspect the manifest under `.crew/state/<state>/<ref>.yaml` for `withdrawn: true`.
  - [ ] 7.2 Confirm `plugins/crew/README.md` (if present) does not need editing — the install README is the canonical operator-facing surface.
  - [ ] 7.3 Rebuild and commit `plugins/crew/mcp-server/dist/` per the project's "build output is tracked in git" rule (`CLAUDE.md` §Process notes). CI fails on drift.
  - [ ] 7.4 Confirm the catalogue prompt edits in Task 2 produce no regressions in the existing Story 3.4 catalogue-prompt-shape test and the existing Story 3.5 catalogue-prompt-shape test (both grep for literal anchors that this story preserves).
  - [ ] 7.5 Add an AC5 grep-style test at `plugins/crew/mcp-server/src/catalogue/__tests__/planner-prompt-shape.reopen.test.ts` (or extend an existing planner-prompt-shape test) that loads `plugins/crew/catalogue/planner.md` from disk and asserts the literal strings from Task 2.2 are all present in the `## Prompt` section.

---

## Architecture compliance

- `PlanningAdapter` interface from `mcp-server/src/adapters/adapter.ts` is unchanged. Discard is a tool-layer concern (per-adapter routing happens in the planner prompt, not in the adapter interface). `markWithdrawn` operates on execution manifests, which are adapter-agnostic.
- The execution-manifest schema (Story 3.2) already carries the `withdrawn` field — no schema change required. The schema's comment at line 102–104 explicitly anticipates this story: *"`false` for new manifests written by `scan-sources`. Story 3.6 (`/plan` discard flow) flips this to `true`. On idempotent re-scan, `scan-sources` does NOT overwrite an existing `true` value."* This story is the explicit follow-up.
- The state-machine directory layout (Story 1.6 / Story 3.2) is unchanged. Withdrawal is orthogonal to state — a withdrawn manifest stays in its current state directory. The orchestrator's claim path filters by `withdrawn === false` via the new `isClaimable` predicate (Task 4) rather than moving withdrawn manifests to a separate directory.
- `planning-adapter-model.md` §FR78 row is the binding source for the external-adapter discard semantics: *"For external adapters, the user does this in their planning tool and marks `withdrawn: true` in our manifest. The plugin's `/<plugin>:plan` skill for external adapters offers a 'mark as withdrawn' affordance that does the manifest write."* This story implements the "mark as withdrawn affordance" verbatim.
- `project-structure-boundaries.md` line 86 names the file path verbatim: `mark-withdrawn.ts`. Use that filename in Task 3.1 — do not rename.
- `architecture-validation-results.md` line 69 (Gap 3) names this story's scope explicitly: *"FR78 discard semantics for external adapters. For BMad-config repos, 'discard a built feature' requires the user to close the story in BMad and the manifest to record the withdrawal."* This story closes Gap 3.
- The atomic-write contract (`atomicWriteFile` from `lib/managed-fs.ts`, Story 1.6) is the binding write primitive. `markWithdrawn` MUST use it — no direct `fs.writeFile`. The `moveBetweenStates` primitive is irrelevant (no directory move on withdrawal).
- Source-drift handling (Architecture §Source-drift handling) is orthogonal. A manifest can be `withdrawn: true` AND `blocked_by: source-drift` simultaneously; the two fields are independent. The dev loop's `isClaimable` predicate filters on `withdrawn` first, which short-circuits drift-blocking logic for withdrawn refs.
- The Story 3.5 discipline gate runs on the revert/deprecate story authored on the native-discard branch (Task 2 covers this — the planner calls `validatePlannerBacklog` before `writeNativeStory` for the revert story, same as any other native write). The revert story therefore MUST satisfy the same discipline rules (e.g. at least one integration AC if state-mutating, explicit `depends_on`, ship-gate constraints if part of a batch). Practically: a revert story IS state-mutating (it un-mutates the prior change) so it MUST carry at least one integration AC.

## Library / framework requirements

- **`zod`** — already a dep. Reused for the new `markWithdrawn` input schema. Do not bump version.
- **`yaml`** — already a dep (used by `scan-sources` for stringify and parse). Reused for `markWithdrawn`'s re-serialisation. Per the project memory rule on dependency versions, if a new dep is needed (none expected), let pnpm resolve, then pin.
- **No new runtime deps.** The planner subagent runs against the existing Claude Code `Task` tool seam (Story 3.4); no new SDK or library involvement at this story's layer.

## File-structure requirements

NEW files (do not exist today):

- `plugins/crew/mcp-server/src/tools/mark-withdrawn.ts` (Task 3).
- `plugins/crew/mcp-server/src/tools/__tests__/mark-withdrawn.integration.test.ts` (Task 3.4).
- `plugins/crew/mcp-server/src/skills/__tests__/plan-reopen.integration.test.ts` or co-located equivalent (Task 5.1).
- `plugins/crew/mcp-server/src/catalogue/__tests__/planner-prompt-shape.reopen.test.ts` or co-located equivalent (Task 7.5).
- New BMad fixture manifest under `plugins/crew/mcp-server/src/adapters/bmad/fixtures/` (Task 5.3).
- New native fixture tree under `plugins/crew/mcp-server/src/adapters/native/fixtures/` with pre-seeded `.crew/state/` and `.crew/native-stories/` (Task 5.4).
- `plugins/crew/mcp-server/src/lib/manifest-yaml.ts` — optional shared YAML writer (Task 3.5 — recommended default is to co-locate with the schema instead; if the existing scan-sources writer is already exportable from `execution-manifest.ts` or a sibling, reuse it and skip this new file).

UPDATE files (exist today; story modifies):

- `plugins/crew/skills/plan/SKILL.md` — backlog-inventory builder, re-open detection, BMad-branch discard offer (Task 1, Task 6).
- `plugins/crew/catalogue/planner.md` — new `### Re-open mode` subsection; add `markWithdrawn` to `tools_allow` (Task 2).
- `plugins/crew/permissions/planner.yaml` — add `markWithdrawn` to `tools_allow` (Task 2.5).
- `plugins/crew/mcp-server/src/tools/register.ts` — register `markWithdrawn` (Task 3.3).
- `plugins/crew/mcp-server/src/state/manifest-state-machine.ts` — add `isClaimable` predicate (Task 4).
- `plugins/crew/mcp-server/src/tools/scan-sources.ts` — only if the YAML writer needs extracting for reuse (Task 3.5). If the writer is already exportable, no edit needed.
- `plugins/crew/docs/README-install.md` — discard-flow section (Task 7.1).
- `plugins/crew/mcp-server/dist/` — rebuild and commit per `CLAUDE.md` §Process notes (Task 7.3).

## Testing requirements

- vitest is the test runner (precedent: every existing `*.test.ts` in the MCP server tree).
- `markWithdrawn` integration test (Task 3.4) covers AC3's contract end-to-end against tmpdir target repos with both adapter configurations. Each idempotency assertion uses `fs.stat().mtimeMs` to confirm the file was NOT rewritten on the second call (mirrors the existing `scan-sources` idempotency contract).
- Re-open integration tests (Task 5.1) cover AC4 branches (a)–(g) against fixtures. Where the planner is exercised via LLM, prefer a deterministic conversation-script harness (the planner's branching is prompt-driven, not LLM-creative — a scripted runner suffices). If a scripted runner does not exist yet, the dev agent MAY exercise the routing logic at the catalogue-prompt-shape layer (assert the prompt encodes the right branching) AND at the tool-call boundary (assert that given the right `<initial-context>`, the right MCP tool would be called) without spinning up an LLM. Final v1 surface-of-truth: the catalogue-prompt-shape test (deterministic) + the per-tool integration tests (deterministic). LLM end-to-end is nice-to-have, not required.
- `isClaimable` unit test (Task 4.2) is a single co-located test file with four cases.
- AC5 (catalogue prompt content-structure) is covered by Task 7.5 — a deterministic grep-style test that loads `planner.md` from disk and asserts every literal string from Task 2.2 is present in the `## Prompt` section.
- Two-pass idempotency assertion is required on the `markWithdrawn` path. The first call flips; the second call no-ops; mtime stable on the second call. This is the same idempotency invariant `scan-sources` honours on `to-do/` and `blocked/`; `markWithdrawn` inherits it.

## Previous-story intelligence

- **Story 3.1** landed the `PlanningAdapter` interface and the registry. No interaction at the adapter-interface layer in this story — discard routes are tool-layer.
- **Story 3.2** landed the execution-manifest schema with `withdrawn: z.boolean().default(false)` already present (line 105). The schema comment at lines 102–104 explicitly anticipates this story.
- **Story 3.3** landed the BMad adapter. No interaction in this story — `markWithdrawn` operates on manifests, not on the BMad source tree.
- **Story 3.3b** moved adapter-config seam into `resolveWorkspace`. `markWithdrawn` benefits from this — its `resolveWorkspace` call returns a fully-wired workspace without needing per-adapter configure helpers.
- **Story 3.4** landed the native adapter, the planner subagent, the `/crew:plan` skill, and the `writeNativeStory` MCP tool. This story extends the skill's `<initial-context>` and the planner's prompt — it does not modify `writeNativeStory` itself. The Story 3.4 BMad-branch (no-subagent-spawn) behaviour is preserved on first-run; re-open mode spawns the subagent on BMad too so the discard flow has a conversational surface.
- **Story 3.5** landed `validatePlannerBacklog` and the discipline gate. The native-discard revert story (this story's Task 2 / AC2) routes through the same gate — the planner calls `validatePlannerBacklog` before `writeNativeStory` for the revert story, same as any other native write. The discipline rules MUST be satisfied by the revert story; the planner enforces this via Story 3.5's contract.
- **Story 1.6 / Story 1.8 / Story 1.11** — the atomic-rename primitive, the user-surface AC tag convention, the dev:install loop. This story is `user-surface` because AC1 names `/crew:plan` (rubric i) and the chat-observable action menu (rubric iv); the pre-PR smoke gate will require an automated harness covering AC1 OR operator-pasted verbatim Claude Code output of the action-menu flow.
- **Architecture Gap 3** (`architecture-validation-results.md` line 69): FR78 discard semantics for external adapters. This story closes the gap by shipping `markWithdrawn` and the BMad-branch discard offer.
- **`bugfix-1` retro lesson:** discard is a state-machine concern (withdrawal is orthogonal to state directory). v1 honours this by NOT moving withdrawn manifests to a separate directory; the predicate filters on the `withdrawn` field. This is the lower-complexity choice and preserves traceability (a withdrawn `done/` manifest stays in `done/` so retro analysis can still see it).

## Project-context reference

- **Authoritative PRD:** `_bmad-output/planning-artifacts/prd-crew-v1/` (sharded). Functional requirements cited: FR8 (re-open mid-cycle), FR14 (read-only in-progress), FR77 (plain-language guideline — orthogonal but the planner's discard prompts MUST honour it), FR78 (discard a built feature).
- **Authoritative architecture:** `_bmad-output/planning-artifacts/architecture/planning-adapter-model.md` (esp. §FR78 row in the Implications table, §Two-layer model), `project-structure-boundaries.md` (line 86 names `mark-withdrawn.ts`), `architecture-validation-results.md` (Gap 3, line 69).
- **User-surface AC convention:** `plugins/crew/docs/user-surface-acs.md` (the gate-binding rubric and tag regex `^\*\*AC(\d+)\s*\(user-surface\)\s*:\*\*`).
- **Build-output rule:** `plugins/crew/CLAUDE.md` (per project CLAUDE.md §Process notes) — `dist/` must be rebuilt and committed in the same change.
- **Communication style:** speak to Jack in PM language per `/Users/jackmcintyre/projects/crew/CLAUDE.md` §How to talk to Jack. Recommend defaults; do not pause for engineering judgement.
- **Negative-capability anchor:** `sprint-status.yaml` and everything under `_bmad-output/implementation-artifacts/` is owned by the orchestrator. This story MUST NOT touch any of it.

---

## Story completion status

Status: ready-for-dev

Ultimate context engine analysis completed — comprehensive developer guide created.

Notes for the dev agent:
- Five ACs total (AC1–AC4 from the epic + AC5 added per spec brief for deterministic catalogue-prompt content-structure).
- ACs tagged `user-surface`: AC1 only. AC2 / AC3 / AC4 / AC5 are substrate (internal adapter behaviour, integration-test assertion, internal catalogue file respectively). The pre-PR gate's user-surface coverage requirement is therefore AC1; the Task 5.1 scripted-conversation integration test should be sufficient to produce an `automated_e2e_verified` event for AC1 (drives `/crew:plan` in re-open mode and asserts the action menu surface).
- The Behavioural contract section is required for `user-surface` stories per the spec brief and IS present — see § Behavioural contract above. The catalogue-prompt extension in Task 2 is the load-bearing carrier for the planner-side half of that contract; the `markWithdrawn` MCP tool (Task 3) is the load-bearing carrier for the external-adapter side; the `isClaimable` predicate (Task 4) is the load-bearing carrier for the dev-loop skip.
- Do NOT modify `sprint-status.yaml` or any file under `_bmad-output/implementation-artifacts/` during implementation. The orchestrator owns status. Withdrawal writes to `<target-repo>/.crew/state/<state>/<ref>.yaml` only (manifest layer); native discard writes to `<target-repo>/.crew/native-stories/<new-ULID>.md` only (source layer).
- The recommended Task 3.5 default is to co-locate the YAML writer with the existing schema (avoid creating a new `lib/manifest-yaml.ts` unless the existing writer is genuinely not exportable). Single source of truth for the serialisation shape is more important than file-layout aesthetics.
- The native edit-pending path writes a NEW ULID file (per Behavioural contract → Planner § edit-pending). The old file persists; the operator can discard it via the same flow if they want it out of view. v1 does not implement "rename-in-place" because it would require either overwriting an existing ULID file (breaks the write-once property) or a new MCP tool. The simpler write-new-ULID path matches the operator's "edits produce a new revision" mental model.
- Two-pass idempotency on `markWithdrawn` is required (Task 3.4 (b)). The existing `scan-sources` idempotency contract (NFR10) is the precedent — `withdraw` inherits it.
- The dev loop's withdrawn-skip predicate (Task 4) ships in this story but is consumed by Epic 5. The unit test (Task 4.2) is the assertion surface for AC4 branch (h). Do not implement a claim loop in this story.
