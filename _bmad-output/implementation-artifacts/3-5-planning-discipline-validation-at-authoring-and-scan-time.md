# Story 3.5: Planning-discipline validation at authoring and scan time

story_shape: user-surface

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin operator priming a backlog**,
I want **planning-discipline rules enforced — integration ACs required on state-mutating stories, implicit cross-story dependencies surfaced, ship-gate refusal at backlog finalisation, and the same checks re-run on `scan-sources` so BMad-authored stories cannot drift past discipline silently**,
so that **the backlog the dev loop drains is not silently broken in the way bugfix-1 was — passing structural ACs hiding broken behaviour, implicit dependencies hiding wiring assumptions, and "done" sprints without an end-to-end gate.**

### What this story is, in one sentence

Replace the pass-through `validateAgainstDiscipline` on both adapters with a real validator that detects the four discipline failure modes from `_bmad-output/_archive/planning-discipline.md` (state-mutating-needs-integration-AC, implicit `depends_on`, missing ship-gate, BMad-side scan-time block), wire it into (a) the planner's pre-write commit step so authoring is refused with a user-facing prompt before a malformed story reaches disk, and (b) `scan-sources` so manifests for source stories violating discipline land in `blocked/` with `blocked_by: planning-discipline`, not in `to-do/` where the dev loop would claim them.

### What this story fixes (and why it needs its own story)

Stories 3.1–3.4 ship the adapter contract, the `validateAgainstDiscipline()` seam (currently pass-through on both `BmadAdapter` and `NativeAdapter`), the `scan-sources` `discipline-violation` skip branch (currently dead code because both adapters return their input unchanged), the execution-manifest schema, and the planner subagent. The discipline rules themselves exist in `_bmad-output/_archive/planning-discipline.md` — they were authored in the sprint-orchestrator era and are explicitly inherited by the crew PRD (CLAUDE.md §Process notes: *"the five planning-discipline rules from `_archive/planning-discipline.md` are the bar for every story we author"*).

Nothing today actually enforces them. The planner can write a state-mutating story with no integration AC. `scan-sources` will materialise a BMad story missing the same. The orchestrator will let the dev loop claim it. Bugfix-1's failure mode (six green ACs, three broken implementations) is reachable again. This story closes that loop end-to-end for FR5, FR6, FR7, and Architecture Gap 1 (BMad-side discipline enforcement at scan time).

### This story does NOT

- (a) Touch `_bmad-output/implementation-artifacts/sprint-status.yaml` — the orchestrator owns status transitions. The dev agent MUST NOT edit any status/state file when implementing this story.
- (b) Change the `PlanningAdapter` interface signature, the `SourceStory` shape, or the `DisciplineViolation`/`DisciplineViolationReason` types in `mcp-server/src/adapters/adapter.ts`. Story 3.1 already defined the contract with `code: "missing-integration-ac" | "implicit-depends-on" | "missing-ship-gate"` — that union is the binding enumeration; this story implements detectors against it without widening it.
- (c) Re-implement `scan-sources`, the execution-manifest writer, or the state-machine directory layout. The existing seam in `scan-sources.ts` (lines 186–196) already routes `discipline-violation` results into `result.skippedRefs` with `reason: "discipline-violation"`. This story extends that path to **also** write a manifest into `blocked/` so the operator and the orchestrator can see the block; it does not rewrite the surrounding loop.
- (d) Implement the re-open / discard-a-feature flow (Story 3.6) or the hand-edit allowance (Story 3.7). The discipline validator is a pure function over `SourceStory`; it has no knowledge of mid-cycle re-planning. If a blocked manifest is later edited by hand to satisfy discipline, the next `scan-sources` pass naturally re-evaluates (the validator runs on every scan).
- (e) Author new dev / reviewer / orchestrator behaviour. The dev loop's reaction to a `blocked_by: planning-discipline` manifest (skip, surface, prompt for unblock) is the orchestrator's concern in Epic 5. This story produces the block; it does not consume it.
- (f) Mutate the catalogue except to extend the planner's `## Prompt` section with the discipline-validation step. No new role, no new persona, no permission-allowlist changes beyond confirming the planner can call the new `validatePlannerBacklog` MCP tool.
- (g) Build the `risk_tier` classifier (FR40a) or any other classifier beyond the four discipline detectors. Risk tier is unrelated to discipline; planner prompts the user for it manually per Story 3.4.
- (h) Change BMad's source files. The BMad adapter validates the **normalised** `SourceStory` it produces — it does not write back to the BMad tree. A BMad source story missing an integration AC produces a blocked manifest; the operator fixes the source story in BMad, then re-runs `/crew:scan`.
- (i) Implement a "state-mutating detector" beyond a deterministic heuristic over file-path globs in `implementation_notes` and explicit frontmatter hints. Semantic detection ("does this story *actually* mutate state") is out of scope; the heuristic is conservative — false positives are acceptable (operator can dismiss in the planner conversation), false negatives are not.
- (j) Detect Rule 4 ("AC checks must be runnable") or Rule 5 ("Author the integration AC first") or Rule 6 ("Commit sprint-status.yaml before launching a sprint") from the archived discipline doc. Rule 4 is a `lintSprint`-style concern deferred to the dev/reviewer loop; Rule 5 is an authoring practice not a structural check; Rule 6 is sprint-launch-specific and the crew product is continuous-flow.

---

## Acceptance Criteria

> Verbatim from epic for AC1–AC5, with user-surface tags applied per `plugins/crew/docs/user-surface-acs.md`. AC6 is the deterministic content-structure check required by the spec brief (LLM outputs are non-deterministic; structural anchors make ACs verifiable without human judgement).

**AC1 (user-surface):**
**Given** a state-mutating native story authored without an integration AC during a `/crew:plan` conversation,
**When** the planner attempts to commit it (i.e. calls the new `validatePlannerBacklog` MCP tool as the pre-write check before invoking `writeNativeStory`),
**Then** the planner detects the omission, refuses the write, and surfaces a user-facing prompt naming the offending story title and the missing field, asking the operator to add an integration AC before the file is written. _(FR5)_
<!-- User-surface: AC1 governs observable behaviour of the planner subagent inside a `/crew:plan` (rubric i) session. The operator sees the refusal prompt in the Claude Code chat (rubric iv — a UI element the user observes). The validator itself is internal, but the AC asserts what the operator sees, which is the user-surface concern. -->

**AC2 (user-surface):**
**Given** a native story whose body implicitly depends on another story (the other story's `ref` or `title` is named verbatim in the narrative or in an AC's prose, but is missing from `depends_on`),
**When** the planner reviews it via `validatePlannerBacklog` before commit,
**Then** the planner detects the implicit dependency, refuses the write, and prompts the operator to either add the named ref to `depends_on` or rephrase the prose to remove the reference. _(FR6)_
<!-- User-surface: same rationale as AC1 — observable planner refusal during a `/crew:plan` conversation (rubric i, rubric iv). -->

**AC3 (user-surface):**
**Given** a backlog being finalised by the planner with no story flagged as the ship-gate (no story in the pending-write batch carries `ship_gate: true` in its frontmatter / planner-input metadata, and no existing native story in `<target-repo>/.crew/native-stories/` carries it either),
**When** the planner attempts to finalise the conversation (i.e. emit the locked handoff phrase),
**Then** `validatePlannerBacklog` refuses, the planner does not emit the handoff, and the operator is prompted to either designate one of the pending stories as the ship-gate or author a dedicated ship-gate story before finalising. _(FR7)_
<!-- User-surface: governs the final visible step of `/crew:plan` (rubric i) — the locked handoff phrase the operator reads at end-of-conversation. The refusal text and the prompt are both observed in chat (rubric iv). -->

**AC4 (user-surface):**
**Given** a BMad source story under the active adapter's `stories_root` whose normalised `SourceStory` is state-mutating (per the heuristic in Task 1) but has zero acceptance criteria tagged `kind: "integration"`,
**When** `/crew:scan` runs (invoking the `scanSources` MCP tool, which calls `BmadAdapter.validateAgainstDiscipline()`),
**Then** the resulting execution manifest is written to `<target-repo>/.crew/state/blocked/<ref>.yaml` (not `to-do/`) with `status: blocked`, `blocked_by: "planning-discipline"`, and a `discipline_violations:` block citing the missing field; the `/crew:scan` summary output names the blocked ref and the rule code (`missing-integration-ac`). _(Architecture Gap 1, FR5 scan-time mirror)_
<!-- User-surface: AC4 names the slash command `/crew:scan` (rubric i) AND the file-path pattern `<target-repo>/.crew/state/blocked/<ref>.yaml` which the install/README docs name as part of the state-machine surface the operator inspects (rubric iii). The summary line printed by the skill is observed in chat (rubric iv). -->

**AC5 (integration):**
vitest covers each of the four enforcement paths against fixtures: (a) planner pre-write rejects missing-integration-AC; (b) planner pre-write rejects implicit `depends_on`; (c) planner pre-write rejects missing ship-gate; (d) `scan-sources` against a BMad fixture missing an integration AC produces a `blocked/` manifest with the expected `blocked_by` and `discipline_violations` shape. Each path asserts both the structured return value of `validateAgainstDiscipline` / `validatePlannerBacklog` AND the on-disk artefact (manifest YAML for path (d); refusal-message string contents for paths (a)–(c)).

**AC6:**
**Given** the planner catalogue prompt at `plugins/crew/catalogue/planner.md`,
**When** the file is inspected,
**Then** its `## Prompt` section contains a verbatim "Discipline validation — pre-write check" subsection naming `validatePlannerBacklog` as the MCP tool the planner MUST call before every `writeNativeStory` call AND before emitting the handoff phrase, and enumerates the four refusal codes (`missing-integration-ac`, `implicit-depends-on`, `missing-ship-gate`, `state-mutating-without-integration-ac`) as the violation set the planner relays verbatim to the operator on refusal.
<!-- Not user-surface: AC6 governs an internal catalogue/prompt file the operator does not read or invoke directly; it is the structural anchor that makes the prompt-level behavioural contract (AC1–AC3) verifiable without exercising the LLM. The README/install docs do not name this file; the operator interacts with the planner via `/crew:plan`, not by reading the prompt file. -->

---

## Behavioural contract

The discipline validator has two execution paths: (1) the planner subagent calls `validatePlannerBacklog` before writing, and (2) every adapter's `validateAgainstDiscipline` runs inside `scan-sources` for the source-tree mirror. Both paths are bound by the invariants below. The planner is LLM-driven; the validator is pure code. The contract distinguishes between the two.

### Validator (pure code — `mcp-server/src/validators/planning-discipline.ts`)

- **MUST** be a pure function: input is a `SourceStory` (or `SourceStory[]` for the backlog-level ship-gate check); output is `SourceStory` (or the original array) on pass, or `DisciplineViolation` on fail. No I/O. No exceptions for discipline failures — failures return a `DisciplineViolation` discriminated by `kind: "discipline-violation"` per the existing `adapter.ts` contract.
- **MUST NEVER** mutate its inputs. Returns the original object reference unchanged on pass; constructs a fresh `DisciplineViolation` on fail.
- **MUST** populate `DisciplineViolationReason.code` exclusively from the existing union in `adapter.ts` (`missing-integration-ac` | `implicit-depends-on` | `missing-ship-gate`). If a new rule needs a new code, the dev agent MUST widen the union in `adapter.ts` first (a one-line type change that Story 3.1 explicitly anticipated: *"Story 3.5 will widen `code` to cover its full enforcement enumeration"*). Two new codes are needed for this story's full scope: `state-mutating-without-integration-ac` (AC4 / Architecture Gap 1) is the BMad-source mirror of `missing-integration-ac` — the dev agent MAY keep them as a single code or split; if split, the union widens to add `state-mutating-without-integration-ac`. The catalogue prompt (AC6) MUST enumerate whichever final shape the dev chooses.
- **MUST** detect state-mutating stories conservatively. The v1 heuristic: a story is state-mutating if any of its `implementation_notes`, AC text, or narrative match (case-insensitive) any of the path globs in `STATE_MUTATING_GLOBS` (a constant in the validator module). Initial globs: `**/state/**`, `**/manifest*`, `**/sprint-status.yaml`, `mark-story-*.ts`, `scan-sources.ts`, `write-native-story.ts`, plus any token matching `/\b(mutates?|writes?|persists?|commits?)\s+(state|manifest|status|backlog)\b/i`. False positives are acceptable; false negatives are the failure mode bugfix-1 demonstrated and MUST NOT slip.
- **MUST** detect implicit `depends_on` as follows: any token in the story's narrative or AC text matching the ref pattern `/\b(native|bmad):[A-Za-z0-9.\-:_]+\b/` that is NOT present in the story's `depends_on` array constitutes a violation. The detail string MUST name every implicit ref found.
- **MUST** detect missing ship-gate at the backlog level only. A single-story `validateAgainstDiscipline(story)` call MUST NOT raise `missing-ship-gate` — that rule is meaningless without backlog context. The backlog-level entry point is `validateBacklog(stories: SourceStory[], { existingStories: SourceStory[] })`; ship-gate detection inspects the union of `stories` and `existingStories` and reports the violation against the synthetic "backlog" pseudo-ref (`backlog:<targetRepoRoot-hash>`).
- **MUST** identify ship-gate stories by an explicit metadata flag, not by inferring from narrative. For native stories: `ship_gate: true` in a YAML frontmatter block at the top of the source `.md` file. For BMad stories: presence of the literal substring `ship-gate` in `raw_frontmatter.tags` or equivalent BMad-side tagging convention captured by the BMad parser. The BMad parser MAY need a small extension to expose this flag through `raw_frontmatter`; if not already exposed, this story extends `parse-bmad-story.ts` to surface it (Task 4).
- **MUST NOT** call any other discipline rule than the four enumerated above (FR5, FR6, FR7, Architecture Gap 1). Rules 4–6 from `_archive/planning-discipline.md` are explicitly out of scope per `does NOT` (j).
- **MUST** be deterministic — given the same `SourceStory` inputs, return byte-identical `DisciplineViolation` output. No timestamps, no UUIDs, no environment reads.

### `validatePlannerBacklog` MCP tool (the planner's pre-write gate)

- **MUST** be a new MCP tool at `plugins/crew/mcp-server/src/tools/validate-planner-backlog.ts`, registered in `register.ts` alongside `writeNativeStory` and `scanSources`.
- **MUST** accept input shape `{ targetRepoRoot: string; pendingStories: PendingStoryInput[] }` where `PendingStoryInput` is the planner's in-memory candidate story shape (title, narrative, ACs, depends_on, implementation_notes, ship_gate: boolean) — i.e. the same shape `writeNativeStory` accepts plus the explicit `ship_gate` flag and the explicit `state_mutating: boolean | "auto"` field (`"auto"` runs the heuristic; `true`/`false` overrides it for operator-driven exceptions).
- **MUST** resolve the workspace via `resolveWorkspace(targetRepoRoot)`. If the active adapter is not `native`, the tool MUST throw `WrongAdapterError` (already added in Story 3.4) — discipline validation at planner-time is native-only in v1 (BMad authoring runs in BMad; BMad discipline is enforced at scan-time per AC4).
- **MUST** synthesise `SourceStory` shapes from the `PendingStoryInput[]` (no ULID — the validator does not need one, so a placeholder like `native:pending-<index>` is acceptable for the validation call only) and invoke (a) per-story `validateAgainstDiscipline` on `NativeAdapter` for each pending, (b) `validateBacklog` for the ship-gate check (passing the pending batch plus already-on-disk native stories as `existingStories`).
- **MUST** return `{ ok: true }` on full pass, or `{ ok: false; violations: DisciplineViolation[] }` on any failure — never throw on discipline failure. Throwing is reserved for wrong-adapter / malformed-input / I/O errors. The planner's prompt-level instruction (per AC6) is to relay the violation list verbatim to the operator.
- **MUST NOT** write any file. The validator's job is to refuse the write; the planner is what surfaces the refusal. Writing is `writeNativeStory`'s job and only happens after `validatePlannerBacklog` returns `{ ok: true }`.

### Planner catalogue prompt (LLM-driven — `plugins/crew/catalogue/planner.md`)

- **MUST** include a new "Discipline validation — pre-write check" subsection in the `## Prompt` section that mandates calling `validatePlannerBacklog` before every `writeNativeStory` invocation and before emitting the locked handoff phrase. This is the AC6 anchor.
- **MUST**, on `{ ok: false }` from the tool, surface the violation list verbatim to the operator with a fixed preamble: `"Planning-discipline check refused this story batch. Fix the items below and ask me to retry:"` followed by the violations as a numbered list (`1. <code> on <ref-or-title>: <detail>`). The planner MUST NOT paraphrase; the codes and details are the authoritative refusal surface.
- **MUST NEVER** call `writeNativeStory` after a `{ ok: false }` return without re-calling `validatePlannerBacklog` and receiving `{ ok: true }`. This is the load-bearing invariant: the validator is the gate; the planner is the messenger.
- **MUST NOT** try to "fix" the violation autonomously (e.g. inject a synthetic integration AC). The operator's input is required. The planner MAY propose a candidate fix in plain language, but MUST NOT write the corrected story until the operator approves.
- **MUST** preserve all existing behavioural invariants from Story 3.4's planner contract (no out-of-domain work, no `gh` writes, ULIDs generated at write time, four-section body shape, etc.).

### `scanSources` integration (the BMad scan-time path)

- **MUST**, on `validateAgainstDiscipline` returning a `DisciplineViolation`, write a `blocked_by: "planning-discipline"` manifest into `<target-repo>/.crew/state/blocked/<ref>.yaml` AND record the ref in `result.skippedRefs` with `reason: "discipline-violation"` and `detail` = the first violation's `detail` string (the existing seam in `scan-sources.ts` lines 188–196 already covers the `skippedRefs` half; this story extends it to also write the blocked manifest). The render-summary text MUST include the blocked refs as a separate line so `/crew:scan` output names them.
- **MUST NEVER** create a manifest in both `blocked/` and `to-do/` simultaneously for the same ref. If a ref appears in both `to-do/` and `blocked/` at startup (possible if a prior write-to-do → unlink-blocked sequence was interrupted), `scan-sources` MUST log a warning and delete the `blocked/` manifest (`to-do/` wins); this guard runs before the per-story loop. Manifests already in `in-progress/` or `done/` are NEVER touched. The new "write to blocked" path applies only when no manifest exists anywhere AND the source story violates discipline.
- **MUST** re-evaluate discipline when `currentState === "blocked"` AND the story's `source_hash` has changed since the blocked manifest was written. Three outcomes of re-evaluation:
  - (a) Validator now passes → delete the `blocked/` manifest and write a new `to-do/` manifest (promotion path).
  - (b) Validator still fails → rewrite the `blocked/` manifest with the updated `source_hash` and latest `discipline_violations` (update path).
  - (c) `source_hash` unchanged → **MUST NOT** rewrite the blocked manifest (mtime-stable). Skip quietly with `reason: "not-in-to-do"`.
- **MUST NEVER** touch a manifest in `in-progress/` or `done/` regardless of `source_hash` changes. Those states are unconditionally owned by the dev loop / orchestrator.
- **MUST** include the new `discipline_violations:` field in the blocked manifest's YAML, shape: `[{ code: string, field: string, detail: string }]`. This field is added to the `ExecutionManifestSchema` Zod schema in `mcp-server/src/schemas/execution-manifest.ts`. It is optional on all other manifests (absent for any manifest not blocked by planning-discipline).

### Negative-capability invariants

- **MUST NEVER** modify `sprint-status.yaml` or any file under `_bmad-output/implementation-artifacts/` during runtime. The validator is a read-only pure function; the MCP tool and the scan-time integration write only to `<target-repo>/.crew/state/blocked/` (manifest layer).
- **MUST NEVER** call out to the network, shell, or any process outside the MCP server.
- **MUST NEVER** silently downgrade a discipline failure to a warning. The contract is refusal: planner refuses to write; scan-sources refuses to materialise into `to-do/`.

---

## Tasks / Subtasks

- [ ] **Task 1 — Discipline-validator pure module (AC: 1, 2, 3, 4, 5)**
  - [ ] 1.1 Create `plugins/crew/mcp-server/src/validators/planning-discipline.ts` exporting two pure functions: `validateStoryAgainstDiscipline(story: SourceStory, opts?: { stateMutating?: boolean }): SourceStory | DisciplineViolation` and `validateBacklogAgainstDiscipline(stories: SourceStory[], opts: { existingStories: SourceStory[]; backlogPseudoRef?: string }): DisciplineViolation[]`. Pure (no I/O); deterministic.
  - [ ] 1.2 Implement the state-mutating heuristic. Export `STATE_MUTATING_GLOBS: readonly string[]` and `STATE_MUTATING_TOKEN_RE: RegExp` as constants. Heuristic: a story is state-mutating if any of `implementation_notes`, AC text, or narrative match any of the globs (use minimatch-style glob matching against tokens / file paths within the text — a regex translation is acceptable since these are content searches, not real fs globs) OR matches `STATE_MUTATING_TOKEN_RE` (`/\b(mutates?|writes?|persists?|commits?)\s+(state|manifest|status|backlog)\b/i`). The `opts.stateMutating` override (when explicitly `true` or `false`) bypasses the heuristic — used by the planner when the operator dismisses a false positive.
  - [ ] 1.3 Implement missing-integration-AC detection: if `stateMutating === true` AND the story's `acceptance_criteria` array contains zero entries with `kind === "integration"`, emit a `DisciplineViolationReason` with `code: "missing-integration-ac"`, `field: "acceptance_criteria"`, `detail: "State-mutating story has no integration-tagged AC. Add at least one AC tagged (integration) that exercises the changed code path end-to-end."`.
  - [ ] 1.4 Implement implicit-depends-on detection: scan `narrative` and every AC `text` for the ref-pattern regex; for every match not in `story.depends_on`, emit a `DisciplineViolationReason` with `code: "implicit-depends-on"`, `field: "depends_on"`, `detail: "Story body references ref '<found-ref>' but it is missing from depends_on. Add it or rephrase to remove the cross-story reference."`. Multiple implicit refs produce multiple `DisciplineViolationReason` entries inside a single `DisciplineViolation`.
  - [ ] 1.5 Implement ship-gate detection in `validateBacklogAgainstDiscipline`. Combine `stories` and `existingStories`; check whether any has the ship-gate flag (sourced from `raw_frontmatter.ship_gate === true` for native, or the BMad tags check from Task 4). If none, return one `DisciplineViolation` with `ref: opts.backlogPseudoRef ?? "backlog:default"`, a single `DisciplineViolationReason` with `code: "missing-ship-gate"`, `field: "backlog"`, `detail: "No story in the backlog is flagged as the ship-gate. Designate one story (set ship_gate: true) or author a dedicated ship-gate story that depends_on every other story."`. Otherwise return `[]`.
  - [ ] 1.6 Widen the `DisciplineViolationReason.code` union in `mcp-server/src/adapters/adapter.ts` if and only if the dev agent chooses to split `missing-integration-ac` into a separate code for the BMad-scan-time path. **Recommended default:** keep a single code `"missing-integration-ac"`. The blocked manifest's `discipline_violations[].code` is the same value whether triggered at planner-time or scan-time. (Lower complexity. The catalogue prompt enumerates the three-code form.)
  - [ ] 1.7 Add a `__tests__/planning-discipline.test.ts` co-located unit suite covering: state-mutating heuristic positive cases (file-path tokens, mutator verbs), state-mutating heuristic negative cases (pure-doc stories, prose without trigger tokens), missing-integration-AC pass+fail, implicit-depends-on pass+fail+multi-ref, ship-gate pass+fail, override behaviour (`stateMutating: false` suppresses the integration-AC check even on a heuristic-positive story).

- [ ] **Task 2 — `NativeAdapter.validateAgainstDiscipline` real implementation (AC: 1, 2, 5)**
  - [ ] 2.1 Edit `plugins/crew/mcp-server/src/adapters/native/index.ts`. Replace the pass-through `validateAgainstDiscipline` (lines 175–177 today) with a call to `validateStoryAgainstDiscipline(story)` from Task 1. Per-story call only — no backlog-level ship-gate check here (that's `validatePlannerBacklog`'s job). The `stateMutating` heuristic runs against the story text.
  - [ ] 2.2 Confirm the existing TSDoc `@see` comment points to this story spec. Update if it still says "Story 3.5 will replace it" — the replacement is now this story.
  - [ ] 2.3 Native adapter does NOT consume `raw_frontmatter.ship_gate` at single-story validation time. Ship-gate is a backlog-level concept (Task 1.5 / Task 5).

- [ ] **Task 3 — `BmadAdapter.validateAgainstDiscipline` real implementation (AC: 4, 5)**
  - [ ] 3.1 Edit `plugins/crew/mcp-server/src/adapters/bmad/index.ts`. Replace the pass-through `validateAgainstDiscipline` (lines 292–294 today) with a call to `validateStoryAgainstDiscipline(story)` from Task 1. Per-story call.
  - [ ] 3.2 The BMad adapter's ship-gate detection at scan-time is **deferred**: `scan-sources` validates one story at a time per the existing loop (`scan-sources.ts` line 185). Backlog-level ship-gate enforcement at scan-time is a separate concern — for v1, the planner enforces ship-gate at authoring time only. BMad-authored backlogs rely on the operator's BMad-side authoring discipline; `validateAgainstDiscipline` at scan-time catches the missing-integration-AC half (the bugfix-1 failure mode) which is the dominant value per Architecture Gap 1.
  - [ ] 3.3 Confirm the existing TSDoc `@see` comment points to this story spec.

- [ ] **Task 4 — BMad parser: surface `ship_gate` from frontmatter / tags (AC: deferred-to-Task-5 ship-gate path; consumed if/when BMad backlog-level enforcement is added)**
  - [ ] 4.1 Inspect `plugins/crew/mcp-server/src/adapters/bmad/parse-bmad-story.ts`. If BMad frontmatter already carries a tags / labels field, ensure `raw_frontmatter.ship_gate` is set to `true` when the tags array contains the literal `ship-gate` (case-insensitive). If BMad frontmatter has no such field, set `raw_frontmatter.ship_gate` to `undefined` and add a parser-level comment that ship-gate detection for BMad stories is operator-driven (not v1 enforced).
  - [ ] 4.2 This task is structural plumbing only; no behavioural change in this story. It is here so a future Story 3.x can light up BMad-side ship-gate enforcement without re-touching the parser.
  - [ ] 4.3 Add a unit test in `plugins/crew/mcp-server/src/adapters/bmad/__tests__/parse-bmad-story.ship-gate.test.ts` that asserts the field is surfaced (or `undefined`) per the chosen behaviour.

- [ ] **Task 5 — `validatePlannerBacklog` MCP tool (AC: 1, 2, 3, 5)**
  - [ ] 5.1 Create `plugins/crew/mcp-server/src/tools/validate-planner-backlog.ts`. Zod input schema:
    ```
    {
      targetRepoRoot: string,
      pendingStories: Array<{
        title: string,
        narrative: string,
        acceptance_criteria: Array<{ text: string, kind: "integration" | "unit" }>,
        implementation_notes?: string,
        depends_on: string[],
        ship_gate: boolean,
        state_mutating: boolean | "auto"
      }>
    }
    ```
  - [ ] 5.2 Output shape: `{ ok: true } | { ok: false; violations: DisciplineViolation[] }`. Never throws on discipline failure. Throws `WrongAdapterError` when the resolved adapter is not `native`. Throws Zod parse error on malformed input. Throws an explicit error on `pendingStories.length === 0` (caller bug — the planner should never call with empty).
  - [ ] 5.3 Implementation flow: `resolveWorkspace` → guard adapter is `native` → synthesise `SourceStory[]` from `pendingStories` (use `native:pending-<index>` as a placeholder ref; `raw_path: ""`, `raw_frontmatter: { ship_gate: pending.ship_gate }`, `source_hash: ""` — none of these placeholders are inspected by the validator) → call `validateStoryAgainstDiscipline` for each (passing `{ stateMutating: pending.state_mutating === "auto" ? undefined : pending.state_mutating }`) → call `validateBacklogAgainstDiscipline` against the pending batch plus an inventory of already-on-disk native stories (read via `NativeAdapter.listSourceStories()`) → aggregate all failures into `violations[]`.
  - [ ] 5.4 Register the tool in `plugins/crew/mcp-server/src/tools/register.ts` next to `writeNativeStory`. Allowlist it in `plugins/crew/permissions/planner.yaml` under `tools_allow`.
  - [ ] 5.5 Add an integration test at `plugins/crew/mcp-server/src/tools/__tests__/validate-planner-backlog.integration.test.ts` covering each of AC1, AC2, AC3 against synthetic pending batches in a tmpdir target repo configured as `adapter: native`.

- [ ] **Task 6 — `scan-sources` integration: write blocked manifest on discipline-violation (AC: 4, 5)**
  - [ ] 6.1 Edit `plugins/crew/mcp-server/src/tools/scan-sources.ts`. Locate the existing `discipline-violation` branch (lines 188–196 today). Currently it only records the ref in `result.skippedRefs` and `continue`s. Extend it to also: (a) compose a manifest from the source story (use the existing `composeManifest` helper but override `status` to `"blocked"`), (b) attach a new `blocked_by: "planning-discipline"` field, (c) attach `discipline_violations: <violations array from the DisciplineViolation result>`, (d) write to `<target-repo>/.crew/state/blocked/<ref>.yaml` via the same `writeManagedFile` path used for `to-do/`, (e) only write if no manifest exists in any state dir for that ref (preserves the existing "scan does not touch claimed work" invariant from `scan-sources.ts` lines 261–267).
  - [ ] 6.2 Extend `ExecutionManifestSchema` in `plugins/crew/mcp-server/src/schemas/execution-manifest.ts` to add two optional fields: `blocked_by?: "planning-discipline" | "source-drift" | string` (string fallback for forward-compat) and `discipline_violations?: Array<{ code: string, field: string, detail: string }>`. Both default to absent; only populated for blocked manifests.
  - [ ] 6.3 Extend `ScanResult` (and `renderScanResult`) in `scan-sources.ts` to include a new `blockedRefs: string[]` array. Render summary adds a `blocked:` line. The existing `skippedRefs` entries for `reason: "discipline-violation"` remain (the two lists overlap by design — `skippedRefs` is the legacy seam, `blockedRefs` is the new operator-facing surface).
  - [ ] 6.4 Update the integration test at `plugins/crew/mcp-server/src/tools/__tests__/scan-sources.integration.test.ts` (or add a new test file if appropriate) to assert AC4 against a BMad fixture missing an integration AC: scan twice (idempotency must still hold on the blocked path), assert the manifest YAML on disk contains `status: blocked`, `blocked_by: planning-discipline`, and the expected `discipline_violations[]` shape, and assert `result.blockedRefs` names the ref.

- [ ] **Task 7 — Planner catalogue prompt extension (AC: 1, 2, 3, 6)**
  - [ ] 7.1 Edit `plugins/crew/catalogue/planner.md`. Append a new subsection `### Discipline validation — pre-write check` to the `## Prompt` section, after the existing four-step planning loop and before any handoff section.
  - [ ] 7.2 Subsection content MUST include verbatim:
    - "Before every `writeNativeStory` call, you MUST call `validatePlannerBacklog` with the full pending batch (every story not yet written in this conversation) plus the `ship_gate` and `state_mutating` flags collected from the operator."
    - "If `validatePlannerBacklog` returns `{ ok: false }`, you MUST refuse to write and relay the violations to the operator verbatim using this preamble: `Planning-discipline check refused this story batch. Fix the items below and ask me to retry:` followed by the violations as a numbered list. You MUST NOT paraphrase the codes or details."
    - "The four refusal codes you may surface are: `missing-integration-ac`, `implicit-depends-on`, `missing-ship-gate`, and `state-mutating-without-integration-ac` (the last is the scan-time mirror of the first — you will not see it at planner-time unless the validator widens, but enumerate it for forward-compat)."
    - "Before emitting the locked handoff phrase, you MUST call `validatePlannerBacklog` one final time over the full set of stories you wrote in this conversation, to catch any ship-gate-missing condition that only becomes visible at backlog level."
  - [ ] 7.3 Add the literal string `validatePlannerBacklog` to `tools_allow` in `plugins/crew/permissions/planner.yaml` (if not already added by Task 5.4).
  - [ ] 7.4 Preserve every existing invariant in the planner prompt — do not remove, narrow, or contradict the Story 3.4 behavioural contract section. The new subsection extends; it does not replace.
  - [ ] 7.5 The catalogue prompt MUST contain the literal strings `validatePlannerBacklog`, `missing-integration-ac`, `implicit-depends-on`, `missing-ship-gate`, and `state-mutating-without-integration-ac` so the AC6 deterministic-content test can grep for them.

- [ ] **Task 8 — `/crew:scan` skill: surface blocked refs verbatim (AC: 4)**
  - [ ] 8.1 Inspect `plugins/crew/skills/scan/SKILL.md`. The skill's `# Steps` section already prints `renderScanResult`'s output verbatim per Story 3.2. Confirm the Task 6.3 render change is automatically surfaced; no skill-level edit is needed beyond confirming the verbatim-print contract.
  - [ ] 8.2 If the skill currently filters or paraphrases the render output, edit it to print the full text including the new `blocked:` line. Add a one-line note to the skill body that blocked refs are the operator's cue to fix the source story and re-scan.

- [ ] **Task 9 — Wire-up + documentation (AC: 4, 6)**
  - [ ] 9.1 Update `plugins/crew/docs/README-install.md`: add a one-paragraph section on planning-discipline blocks. Name the four codes and the operator's remediation path (edit the source story; re-run `/crew:scan`).
  - [ ] 9.2 Confirm `plugins/crew/README.md` (if present) does not need editing — the install README is the canonical surface for state-machine semantics.
  - [ ] 9.3 Rebuild and commit `plugins/crew/mcp-server/dist/` per the project's "build output is tracked in git" rule (CLAUDE.md §Process notes). CI fails on drift.
  - [ ] 9.4 Add a fixture under `plugins/crew/mcp-server/src/adapters/bmad/fixtures/` (or extend an existing one) containing a state-mutating BMad story with zero integration ACs. Used by the Task 6.4 integration test.
  - [ ] 9.5 Add a fixture under `plugins/crew/mcp-server/src/adapters/native/fixtures/` containing a native story with an implicit `depends_on` (references another ref in prose but omits from `depends_on`). Used by the Task 5.5 integration test.

---

## Architecture compliance

- `PlanningAdapter` interface from `mcp-server/src/adapters/adapter.ts` is the binding contract. `validateAgainstDiscipline(story)` keeps its existing synchronous signature `SourceStory | DisciplineViolation`. The validator is consumed unchanged by `scan-sources.ts` (the seam at lines 186–196 already routes the `DisciplineViolation` discriminant correctly).
- `DisciplineViolationReason.code` is an enumerated union (Story 3.1). This story populates the existing three codes. Widening the union is permitted but optional per Task 1.6; the recommended default is to keep the union as-is.
- The execution-manifest layer (Story 3.2 schema, `scan-sources` writer) is extended with two optional fields (`blocked_by`, `discipline_violations`) that compose with the existing state-machine directory layout. The four state dirs (`to-do/`, `in-progress/`, `blocked/`, `done/`) and the atomic `fs.rename` contract are unchanged — this story only adds a new entry path into `blocked/`.
- Adapter registration order in `registry.ts` is unchanged. The native adapter's discipline implementation is identical to the BMad adapter's (both delegate to `validateStoryAgainstDiscipline`); the difference is in the planner-time surface (`validatePlannerBacklog` is native-only because BMad authoring lives in BMad).
- Source-drift handling (Architecture §Source-drift handling) is orthogonal to discipline. A manifest can be blocked by `planning-discipline` OR `source-drift` but not both at once in v1; the `blocked_by` field is a single string.
- The "no short-circuit on `getActiveAdapter()` Branch B" rule from `registry.ts` is irrelevant here — discipline runs after adapter resolution.

## Library / framework requirements

- **`zod`** — already a dep of the MCP server. Reused for the new `validate-planner-backlog` input schema and the extended `ExecutionManifestSchema`. Do not bump version.
- **`minimatch` or equivalent glob library** — the state-mutating heuristic uses path-glob matching against text tokens. If a minimatch-shaped library is already a transitive dep, reuse it. Otherwise the heuristic MAY be implemented with a hand-rolled glob-to-regex helper (the globs are simple: `**/state/**`, `mark-story-*.ts`, etc., all expressible as regex). **Recommended default:** hand-rolled regex translation (zero new deps, lower complexity).
- **No new runtime deps beyond what's already in the MCP server.** Per the user-memory rule on dependency versions, if any new dep is added, let pnpm resolve, then pin.

## File-structure requirements

NEW files (do not exist today):

- `plugins/crew/mcp-server/src/validators/planning-discipline.ts` (note: `validators/` directory already exists per `ls`)
- `plugins/crew/mcp-server/src/validators/__tests__/planning-discipline.test.ts`
- `plugins/crew/mcp-server/src/tools/validate-planner-backlog.ts`
- `plugins/crew/mcp-server/src/tools/__tests__/validate-planner-backlog.integration.test.ts`
- `plugins/crew/mcp-server/src/adapters/bmad/__tests__/parse-bmad-story.ship-gate.test.ts` (or co-located in the existing BMad test file)
- A BMad fixture story file under `plugins/crew/mcp-server/src/adapters/bmad/fixtures/` exercising the missing-integration-AC violation (Task 9.4).
- A native fixture story file under `plugins/crew/mcp-server/src/adapters/native/fixtures/.crew/native-stories/` exercising the implicit-depends-on violation (Task 9.5).

UPDATE files (exist today; story modifies):

- `plugins/crew/mcp-server/src/adapters/adapter.ts` — only if Task 1.6 widens the `code` union (not recommended in v1).
- `plugins/crew/mcp-server/src/adapters/native/index.ts` — replace pass-through `validateAgainstDiscipline`.
- `plugins/crew/mcp-server/src/adapters/bmad/index.ts` — replace pass-through `validateAgainstDiscipline`.
- `plugins/crew/mcp-server/src/adapters/bmad/parse-bmad-story.ts` — surface `ship_gate` from frontmatter/tags (Task 4).
- `plugins/crew/mcp-server/src/schemas/execution-manifest.ts` — add optional `blocked_by`, `discipline_violations` fields.
- `plugins/crew/mcp-server/src/tools/scan-sources.ts` — write blocked manifest on `discipline-violation`; extend `ScanResult` with `blockedRefs`; extend `renderScanResult` with the `blocked:` line.
- `plugins/crew/mcp-server/src/tools/scan-sources.integration.test.ts` (or wherever the existing scan-sources tests live) — assert AC4 path.
- `plugins/crew/mcp-server/src/tools/register.ts` — register `validatePlannerBacklog`.
- `plugins/crew/catalogue/planner.md` — append the discipline pre-write subsection (AC6 anchor).
- `plugins/crew/permissions/planner.yaml` — add `validatePlannerBacklog` to `tools_allow`.
- `plugins/crew/skills/scan/SKILL.md` — confirm verbatim-print of `renderScanResult`; add the one-line operator note.
- `plugins/crew/docs/README-install.md` — add the planning-discipline section.
- `plugins/crew/mcp-server/dist/` — rebuild and commit per CLAUDE.md.

## Testing requirements

- vitest is the test runner (precedent: every existing `*.test.ts` in the MCP server tree).
- Unit suite (Task 1.7) covers the pure validator in isolation against synthetic `SourceStory` objects. Fast; no fs/no I/O.
- Integration suite for `validatePlannerBacklog` (Task 5.5) covers AC1, AC2, AC3 against a tmpdir target repo with `adapter: native`. Each path asserts both the tool return value and the absence of any `writeNativeStory`-side effect.
- Integration suite for `scan-sources` (Task 6.4) covers AC4 against a BMad fixture. Two-pass idempotency is preserved on the blocked path: re-scanning a story already blocked must not rewrite the manifest (existing `to-do/` idempotency contract applies symmetrically to `blocked/`).
- AC6 (catalogue prompt content-structure) is covered by a deterministic grep-style test — recommend a new `plugins/crew/mcp-server/src/catalogue/__tests__/planner-prompt-shape.test.ts` (or co-locate with similar existing tests) that loads `plugins/crew/catalogue/planner.md` from disk and asserts the literal strings from Task 7.5 are present in the `## Prompt` section.
- Two-pass idempotency assertion is required on the AC4 path: when `source_hash` is unchanged, re-running `/crew:scan` against an already-blocked BMad story MUST NOT rewrite the manifest (mtime-stable). This mirrors the existing `to-do/` idempotency contract (`scan-sources.ts` AC2/NFR10 commentary). A third path must also be covered: when the source story is edited (new `source_hash`) and the validator still fails, the blocked manifest MUST be rewritten with the new hash and latest violations (not mtime-stable in this case).

## Previous-story intelligence

- **Story 3.1** landed the `PlanningAdapter` interface, the `DisciplineViolation` type, and the `validateAgainstDiscipline()` method signature. The TSDoc on the interface explicitly says: *"Adapters that have not yet implemented real discipline checks return the input story unchanged. This is the default conformant behaviour. Story 3.5 lands the real validator for each adapter."* This story is the explicit follow-up.
- **Story 3.2** landed the `scan-sources` MCP tool with a documented seam for discipline. The comment in `scan-sources.ts` line 27 reads: *"`reason: "discipline-violation"` is reserved for Story 3.5; v1 never produces it (all adapters' `validateAgainstDiscipline` is pass-through)."* This story removes that "v1 never produces it" caveat.
- **Story 3.3** landed the BMad adapter with a pass-through `validateAgainstDiscipline` (lines 292–294) and a `@see` comment pointing here. This story replaces that pass-through.
- **Story 3.3b** moved adapter-config seam into `resolveWorkspace`. No interaction with discipline; the validator is config-independent.
- **Story 3.4** landed the native adapter, the planner subagent, the `/crew:plan` skill, and the `writeNativeStory` MCP tool. This story is the **gate before `writeNativeStory`** — every planner write path is now preceded by `validatePlannerBacklog`. The Story 3.4 Behavioural contract explicitly says the planner *"MUST NEVER enforce planning-discipline rules ... Those land in Story 3.5"*; this story flips that to MUST.
- **Bugfix-1 retro** (`_bmad-output/_archive/planning-discipline.md`) is the canonical source for why these rules exist. Read it before implementing. The four discipline rules implemented here are Rules 1, 2, and 3 from that doc (Rule 4–6 are deferred per `does NOT` (j)).
- **Story 1.8** introduced the user-surface AC tag and the pre-PR smoke gate (`plugins/crew/docs/user-surface-acs.md`). This story is `user-surface` because the planner's refusal prompts and the `/crew:scan` blocked-ref surface are both observable in Claude Code; the pre-PR gate will require either an automated harness covering AC1–AC4 (the Task 5.5 + 6.4 integration tests qualify) OR operator-pasted verbatim Claude Code output of each user-surface AC's flow.

## Project-context reference

- **Authoritative PRD:** `_bmad-output/planning-artifacts/prd-crew-v1/` (sharded). Functional requirements cited: FR5, FR6, FR7.
- **Authoritative architecture:** `_bmad-output/planning-artifacts/architecture/planning-adapter-model.md` §Adapter contract, §Execution manifest, §Source-drift handling. Architecture Gap 1 (BMad-side discipline enforcement at scan time) is the binding source for AC4.
- **Discipline doctrine:** `_bmad-output/_archive/planning-discipline.md` — Rules 1, 2, 3 are implemented here. Rules 4–6 are out of scope per `does NOT` (j).
- **User-surface AC convention:** `plugins/crew/docs/user-surface-acs.md` (the gate-binding rubric and tag regex).
- **Build-output rule:** `plugins/crew/CLAUDE.md` (per project CLAUDE.md §Process notes) — `dist/` must be rebuilt and committed in the same change.
- **Communication style:** speak to Jack in PM language per `/Users/jackmcintyre/projects/crew/CLAUDE.md` §How to talk to Jack. Recommend defaults; do not pause for engineering judgement.

---

## Story completion status

Status: ready-for-dev

Ultimate context engine analysis completed — comprehensive developer guide created.

Notes for the dev agent:
- Six ACs total (AC1–AC5 from the epic + AC6 added per spec brief for deterministic catalogue-prompt content-structure).
- ACs tagged `user-surface`: AC1, AC2, AC3, AC4. AC6 untagged (internal catalogue file). AC5 tagged `(integration)` per epic verbatim.
- The Behavioural contract section is required for `user-surface` stories per the spec brief and IS present — see § Behavioural contract above. The catalogue prompt extension in Task 7 is the load-bearing carrier for the planner-side half of that contract.
- Do NOT modify `sprint-status.yaml` or any file under `_bmad-output/implementation-artifacts/` during implementation. The orchestrator owns status. The validator and the MCP tool only write into `<target-repo>/.crew/state/blocked/` (manifest layer) and only via the existing `writeManagedFile` path.
- The recommended Task 1.6 default is to NOT widen the `DisciplineViolationReason.code` union. Three codes cover every path in v1 (`missing-integration-ac` covers both planner-time and scan-time missing-integration-AC; the catalogue prompt enumerates the four-code form for forward-compat only — the fourth code is documentation, not runtime).
- AC4 / Task 6 introduces the `blocked/` write path from `scan-sources`. Two-pass idempotency on `blocked/` is required (the test in Task 6.4 asserts it). The existing `to-do/` idempotency contract (NFR10) is the precedent.
