# Story 3.7: Plain-language guideline and direct-edit allowance

story_shape: user-surface

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **non-engineer plugin operator who primes and shepherds a continuous-flow backlog**,
I want **(a) the planner agent to produce story bodies and ACs I can read on skim without a technical glossary, and (b) the freedom to hand-edit any execution manifest while it sits in `to-do/` or `blocked/` — with subsequent skill invocations honouring my edits — while any hand-edit to an `in-progress/` manifest is flagged and refused on the next skill invocation**,
so that **I am never blocked by jargon when checking whether a story matches my intent, and never silently break a story the dev loop is mid-flight against**.

### What this story is, in one sentence

Land FR77 (plain-language guideline) by adding an explicit subsection to the planner catalogue prompt that directs the planner to write ACs accessible to a non-engineer reading code at skim level, AND land FR14 (direct-edit allowance) by (i) documenting the allowance for `to-do/` and `blocked/` manifests (no plumbing change required — `scan-sources` already preserves operator edits per Story 3.2 AC3 / Story 3.5), and (ii) adding a `detectInProgressHandEdit` invariant: a new pure predicate plus a one-shot guard that every state-mutating MCP tool calls on entry, which detects any `in-progress/<ref>.yaml` whose on-disk `source_hash` no longer matches the source story's current hash AND whose other operator-editable fields (`narrative`, `acceptance_criteria`, `implementation_notes`, `depends_on`, `title`) have been mutated relative to what `scan-sources` would have written. On detection, the guard refuses to proceed and surfaces a verbatim diagnostic naming the offending ref and the offending fields.

### What this story fixes (and why it needs its own story)

Two threads close in this story:

- **FR77 — plain-language guideline.** The PRD calls this out as a non-testable stylistic guideline shaped via the planner's persona. The planner catalogue prompt today (post-Story 3.4 / 3.5 / 3.6) tells the planner to write ACs at the user-value level, but never says "and write them so a non-engineer can read them on skim." Without that explicit anchor, the planner drifts into LLM-default jargon — "exit code 42", "Zod schema parse", "MCP tool seam" — which defeats the whole point of the planner for Jack's persona (an ex-scrum-master, not an engineer, per the project CLAUDE.md). Story 3.7 makes the guideline explicit in the prompt so retros can cite it, and so the AC5 anchor test pins it on disk.
- **FR14 — direct-edit allowance.** The execution-manifest layer is operator-observable (the operator can open `.crew/state/to-do/<ref>.yaml` in any editor and see plain YAML). v1's contract is that the operator MAY hand-edit a `to-do/` or `blocked/` manifest (fix a typo in the title, sharpen an AC, add an implementation note) and the next skill invocation MUST honour the edit. The wiring for this is already partially in place — `scan-sources` preserves operator hand-edits on hash-refresh (see `scan-sources.ts` line 437–438, which explicitly cites Story 3.7) — but the read path (every MCP tool that parses a manifest) has never been audited end-to-end to confirm the operator's bytes are the bytes the dev loop sees. The corresponding negative — hand-edits to `in-progress/` — is undocumented and unenforced. An operator who edits an `in-progress/` manifest mid-flight can silently desync the dev agent's context from the manifest the orchestrator is tracking; the dev loop has no signal that the artefact under it changed. Story 3.7 closes the gap with an explicit "I see your edit, I refuse to proceed" guard.

This story is the final story in Epic 3. After it, the backlog layer is complete: adapters, manifest layer, planner, discipline gate, re-open / discard, plain-language guideline, hand-edit allowance.

### This story does NOT

- (a) Touch `_bmad-output/implementation-artifacts/sprint-status.yaml` or any other file under `_bmad-output/implementation-artifacts/`. The orchestrator owns status transitions. The dev agent MUST NOT edit any status/state file when implementing this story.
- (b) Change the `PlanningAdapter` interface signature in `mcp-server/src/adapters/adapter.ts`. The hand-edit guard is a tool-layer concern operating on execution manifests, which are adapter-agnostic at the file layer.
- (c) Change the execution-manifest schema (`schemas/execution-manifest.ts`). No new fields are introduced. The hand-edit guard works by comparing the existing `source_hash` field against a freshly-computed source hash, and by comparing the manifest's operator-editable fields against what `scan-sources` would write for the current source story. The `withdrawn` flip from Story 3.6 is orthogonal — a hand-edit to `withdrawn: true` in `to-do/` is permitted (it's a manual discard); a hand-edit to `withdrawn: false` in `in-progress/` is caught by the same in-progress guard as any other edit.
- (d) Implement an automated AC for the plain-language guideline beyond the catalogue-prompt-shape anchor (AC1 below). The PRD is explicit: FR77 is non-testable — behaviour shaping happens through retros, not through asserting on LLM output. AC1's deterministic on-disk anchor (literal substring present in the catalogue file) is the strongest gate the story brief permits.
- (e) Add a UI affordance for hand-editing — operators edit YAML in their preferred text editor. No new skill or chat surface is introduced for editing. The skill-side delta is the new guard called by tools on entry.
- (f) Re-hash unchanged manifests on every skill invocation. The hand-edit guard for `in-progress/` runs only when a tool that touches the in-progress layer is invoked, and only re-hashes the source story for refs the tool would otherwise operate on. v1 does NOT walk the full state directory and re-hash every manifest defensively.
- (g) Replay or reconcile hand-edits across state-machine moves. If the operator hand-edits a `to-do/` manifest and the dev loop subsequently claims the story (moves to `in-progress/`), the operator's edits are carried into `in-progress/` verbatim via the existing `moveBetweenStates` rename primitive (no content rewrite). The guard's "is this still the same content `scan-sources` would write?" check is computed against the moved-into-in-progress baseline, which is the same bytes as the moved-out-of-to-do version (rename, not copy+rewrite).
- (h) Mutate manifests itself. The story produces (i) one prompt addition, (ii) one predicate, (iii) one guard helper, and (iv) documentation. No new MCP tool. No new write surface.
- (i) Define behaviour for hand-edits to `done/` manifests. `done/` is the dev loop's terminal state; an operator hand-edit there is harmless (no future tool transitions out of `done/` in v1 — Epic 6's retro layer reads but does not mutate `done/`). The guard is scoped to `in-progress/` only.
- (j) Add a "force override" flag. The refusal is unconditional — if the operator wants to hand-edit an in-progress story, they MUST first wait for it to land in `done/` or `blocked/`, OR discard it via Story 3.6's `/crew:plan` discard flow. v1 does not surface a `--i-know-what-im-doing` bypass.
- (k) Touch BMad source story files. The hand-edit allowance is for execution manifests under `<target-repo>/.crew/state/`, not for source stories in BMad's tree. BMad source edits are handled by the existing `scan-sources` source-hash refresh path (Story 3.2 AC3) which is unchanged here.

---

## Acceptance Criteria

> AC1–AC3 are verbatim from the epic with `user-surface` tagging applied per `plugins/crew/docs/user-surface-acs.md`. AC4 is the epic's integration AC. AC5 is the deterministic content-structure check required by the spec brief (LLM outputs are non-deterministic; structural anchors make ACs verifiable without human judgement).

**AC1:**
**Given** the planner catalogue prompt at `plugins/crew/catalogue/planner.md`,
**When** it is reviewed,
**Then** the `## Prompt` section contains a verbatim `### Plain-language guideline` subsection that explicitly directs the planner to write story bodies and acceptance criteria accessible to a non-engineer who reads code at skim level — the subsection MUST use the literal phrase `non-engineer who reads code at skim level`, MUST instruct the planner to avoid jargon (specifically calling out implementation detail like exit codes, internal function names, schema field names, and MCP tool names as examples), and MUST cite FR77 by name. _(FR77, guideline)_
<!-- Not user-surface: AC1 governs an internal catalogue/prompt file the operator does not read or invoke directly; it is the anchor for the planner's prompt-level behaviour, which manifests in chat as user-surface output but is itself substrate. -->

**AC2 (user-surface):**
**Given** an execution manifest at `<target-repo>/.crew/state/to-do/<ref>.yaml` (or `<target-repo>/.crew/state/blocked/<ref>.yaml`),
**When** I open the file in a text editor, change one of the operator-editable fields (`title`, `narrative`, `acceptance_criteria`, `implementation_notes`, `depends_on`, or `withdrawn`), save, and subsequently invoke any plugin skill that reads that manifest (e.g. `/crew:scan`, `/crew:status`, `/crew:plan` in re-open mode),
**Then** the skill MUST surface my edited values (not the pre-edit values), the read path MUST go through `parseExecutionManifest` (so schema-violating edits surface as `MalformedExecutionManifestError` with a human-readable diagnostic), and a subsequent `/crew:scan` invocation MUST NOT overwrite the edited fields unless the source story's `source_hash` has also changed (in which case only `source_hash` and `source_path` are rewritten — operator edits to other fields are preserved per the existing `scan-sources` behaviour at `scan-sources.ts` line 435–443). _(FR14 first half)_
<!-- User-surface: AC2 names `/crew:scan`, `/crew:status`, and `/crew:plan` (rubric i — slash command literals) and the file path `<target-repo>/.crew/state/to-do/<ref>.yaml` (rubric iii — a path the operator opens by name per docs). The operator observes their edits sticking via subsequent skill invocations. -->

**AC3 (user-surface):**
**Given** an execution manifest at `<target-repo>/.crew/state/in-progress/<ref>.yaml`,
**When** I open the file in a text editor, change any of the operator-editable fields named in AC2, save, and subsequently invoke any plugin skill or MCP tool that would operate on that ref (e.g. the orchestrator's claim path, `/crew:status`, or any future Epic 4/5 tool acting on the in-progress layer),
**Then** the invocation MUST detect the hand-edit on entry via the new `detectInProgressHandEdit` guard and refuse to proceed, emitting the verbatim diagnostic: `"Refusing: <ref> in in-progress/ has been hand-edited (fields: <comma-separated field names>). v1 does not support editing stories mid-flight. Wait for the story to land in done/ or blocked/, or discard it via /crew:plan."` The refusal MUST surface as a typed `InProgressHandEditError` (new error type in `mcp-server/src/errors.ts`) so callers can pattern-match, and the offending manifest's bytes MUST NOT be modified by the guard itself. _(FR14 second half — "orchestration surfaces the violation in v1")_
<!-- User-surface: AC3 names `/crew:status` and `/crew:plan` (rubric i — slash command literals) and the file path `<target-repo>/.crew/state/in-progress/<ref>.yaml` (rubric iii — path the operator opens by name per docs). The verbatim refusal diagnostic is observed by the operator in the chat when the next skill runs. -->

**AC4:**
vitest covers hand-edit acceptance in `to-do/` and refusal in `in-progress/`, plus the supporting predicate behaviour. Specifically: (a) seed a tmpdir target repo with a `to-do/<ref>.yaml` manifest; hand-edit `title` and `narrative` on disk; assert that parsing the manifest via `parseExecutionManifest` returns the edited values; assert that running `scan-sources` against the same source story (no source change) leaves the edited values intact and is a no-op write (mtime stable on the manifest file); (b) seed a tmpdir with a `to-do/<ref>.yaml` whose `acceptance_criteria` the operator has hand-edited; mutate the source story so its hash changes; run `scan-sources`; assert the operator's `acceptance_criteria` edits are preserved AND `source_hash` and `source_path` are updated (this is the existing `scan-sources` invariant — the test pins it explicitly under Story 3.7); (c) seed a tmpdir with an `in-progress/<ref>.yaml` manifest; hand-edit any operator-editable field; call `detectInProgressHandEdit({ targetRepoRoot, ref, sourceHash: "abc123", sourceFields: { title: "T", narrative: "N", acceptance_criteria: ["AC1"], implementation_notes: "", depends_on: [], withdrawn: false } })` directly; assert it throws `InProgressHandEditError` with the verbatim diagnostic shape from AC3 AND that the offending field names are listed in the error payload; (d) repeat (c) but without a hand-edit; assert the guard returns `{ ok: true }` (no throw); (e) blocked-layer edit acceptance — seed a `blocked/<ref>.yaml` manifest with operator-edited fields; parse and assert the edits are visible; (f) malformed-edit refusal — hand-edit a `to-do/<ref>.yaml` so it violates the schema (e.g. remove the `title` field); assert the next `parseExecutionManifest` call throws `MalformedExecutionManifestError` (existing behaviour — test pins it). Tests are co-located with the existing manifest/state-machine tests.
<!-- Not user-surface: AC4 is the integration-test surface. Tests are not observed by the operator. -->

**AC5:**
**Given** the planner catalogue prompt at `plugins/crew/catalogue/planner.md`,
**When** the file is read from disk,
**Then** the literal substring `### Plain-language guideline` appears in the `## Prompt` section, AND the literal substring `non-engineer who reads code at skim level` appears within that subsection, AND the literal substring `FR77` appears within that subsection. A grep-style deterministic test asserts all three substrings are present (this is the structural anchor required by the spec brief because the planner's runtime behaviour is LLM-driven and non-deterministic — the on-disk anchor is verifiable without exercising the LLM).
<!-- Not user-surface: AC5 governs an internal catalogue/prompt file the operator does not invoke or open directly; it is the structural anchor that pins the prompt-level guideline (AC1's observable effect surfaces in chat as user-surface output, but the AC itself asserts on-disk file contents). -->

---

## Behavioural contract

Story 3.7 has three deliverables: (1) the planner catalogue prompt gains a `### Plain-language guideline` subsection (LLM-shaping; non-testable beyond the on-disk anchor); (2) a new `detectInProgressHandEdit` predicate / guard ships under `mcp-server/src/state/` and is called on entry by every tool that operates on the in-progress layer; (3) the operator-facing READMEs document the allowance and the refusal. Each is bound by the invariants below.

### Planner catalogue prompt (LLM-driven — `plugins/crew/catalogue/planner.md`)

- **MUST** include a new `### Plain-language guideline` subsection in the `## Prompt` section, after the existing `### Discipline validation — pre-write check` subsection and before the existing `### Re-open mode — backlog review and discard flow` subsection. (Insertion site: between the two existing subsections to maintain a natural reading order — discipline first, then style, then re-open semantics.)
- **MUST** contain the literal phrase `non-engineer who reads code at skim level` (verbatim — the AC5 grep test asserts this).
- **MUST** cite `FR77` by name (the AC5 grep test asserts this).
- **MUST** name at least four concrete examples of jargon the planner should avoid, drawn from this story's language: exit codes, internal function names, schema field names, MCP tool names. Phrase as "MUST NOT write ACs that name…" so the planner reads the prohibition in the same absolute-modal voice as the rest of the prompt.
- **MUST** preserve every existing behavioural invariant from Story 3.4's planner contract, Story 3.5's discipline-gate contract, and Story 3.6's re-open contract. This subsection extends; it does not replace.
- **MUST NOT** weaken Story 3.4's "user-value level" invariant. The plain-language guideline is a stylistic refinement of the existing user-value rule, not a substitute. ACs MUST still describe what the user does or observes; the guideline adds "and phrase it without jargon."
- **MUST NOT** introduce any new tool-call instruction. The planner's tool-allow surface (Read, Edit, Task, writeNativeStory, validatePlannerBacklog, markWithdrawn, readBacklogInventory, heartbeat) is unchanged.
- **MUST NEVER** be removed by future prompt edits without a coordinated bump of AC5's grep test. The subsection heading is the anchor; the AC5 test is the alarm.

### `detectInProgressHandEdit` predicate / guard (pure code — new helper)

- **MUST** be a new exported function `detectInProgressHandEdit` in `plugins/crew/mcp-server/src/state/manifest-state-machine.ts` (co-located with the existing `moveBetweenStates` and `isClaimable` primitives — single source of truth for state-machine concerns).
- **MUST** have signature `async function detectInProgressHandEdit(opts: { targetRepoRoot: string; ref: string; sourceHash: string; sourceFields: OperatorEditableFields }): Promise<{ ok: true } | never>` where `OperatorEditableFields = Pick<ExecutionManifest, "title" | "narrative" | "acceptance_criteria" | "implementation_notes" | "depends_on" | "withdrawn">`. The function throws `InProgressHandEditError` on detection; returns `{ ok: true }` on no-edit. (Pure read; never writes.)
- **MUST** read the on-disk manifest at `<targetRepoRoot>/.crew/state/in-progress/<ref>.yaml` via `fs.readFile` + `yaml.parse` + `parseExecutionManifest`. A `MalformedExecutionManifestError` from the parse step MUST propagate unchanged — a malformed in-progress manifest is a worse failure than a hand-edit and the caller surfaces it via existing FR13 handling.
- **MUST** consider the manifest hand-edited if EITHER (i) the on-disk `source_hash` differs from `opts.sourceHash` (the source story has changed but `scan-sources` cannot refresh `in-progress/` manifests — Story 3.2 AC3 — so any hash mismatch on `in-progress/` is by definition a hand-edit relative to what the scanner would write), OR (ii) any field in `OperatorEditableFields` on disk differs from the corresponding field in `opts.sourceFields` (the canonical source-of-truth view at scan-time). The "fields differ" check uses deep-equal semantics: array order matters (acceptance_criteria, depends_on); object key order does not.
- **MUST** include the list of changed field names in the thrown `InProgressHandEditError` payload so the caller's error formatter can interpolate them into the verbatim diagnostic from AC3.
- **MUST** be pure with respect to writes: never modifies the manifest, never moves it, never emits telemetry on its own (telemetry is the caller's responsibility — see Epic 1.5's JSONL pino plumbing).
- **MUST** be deterministic: identical inputs produce identical outputs / errors. No timestamp dependence, no cwd dependence beyond `targetRepoRoot`.
- **MUST NOT** be called on every skill invocation defensively. Callers only invoke it for refs they are about to operate on. v1 does not implement a "walk the in-progress directory at startup and refuse if any ref is hand-edited" guard — too expensive, and the per-ref guard catches every operative path.
- **MUST NEVER** be invoked against `to-do/`, `blocked/`, or `done/` manifests. Hand-edits there are permitted (`to-do/`, `blocked/`) or harmless (`done/`).
- **MUST NEVER** swallow `ManifestNotFoundError` (the ref isn't in `in-progress/`). Caller-level routing decides what to do when a ref is in a different state — this guard is in-progress-specific.

### `InProgressHandEditError` (new typed error)

- **MUST** be a new exported class in `plugins/crew/mcp-server/src/errors.ts`, alongside `ManifestNotFoundError`, `MalformedExecutionManifestError`, `WrongAdapterError`, etc. Extends `Error`. Carries `ref: string`, `changedFields: readonly string[]`, `absPath: string` properties.
- **MUST** include the verbatim diagnostic from AC3 in `error.message`, with the `<ref>` and `<comma-separated field names>` substituted. Format the field list comma-separated in alphabetical order for determinism.
- **MUST NEVER** be caught and downgraded by upstream callers. This is a hard refusal; the only response is for the operator to wait or discard.

### Operator-visible refusal surface (every caller that uses the guard)

- The guard is called by the caller; the caller is responsible for surfacing the error to the operator. v1 has zero callers today — Epic 4's claim path is the first real consumer. This story ships the predicate and the error type; callers wiring up is Epic 4/5's pickup.
- **MUST**, in the README documentation (Task 4 below), name `/crew:status` and `/crew:plan` as the two surfaces an operator might see the refusal through in v1, on the basis that those skills already read the state directory and will be wired to the guard in subsequent stories. The story does NOT add the wiring to those two skills itself; it documents the contract so future wiring stories cite this anchor.
- **MUST NOT** introduce a silent log-and-continue path. The refusal is unconditional.

### Hand-edit allowance for `to-do/` and `blocked/` (documentation + test pin)

- **MUST** be documented in `plugins/crew/docs/README-install.md` (or the install docs the README points to) as: operators may open any `.yaml` under `.crew/state/to-do/` or `.crew/state/blocked/` in a text editor, change `title`, `narrative`, `acceptance_criteria`, `implementation_notes`, `depends_on`, or `withdrawn`, and the next skill invocation MUST honour the edit. The doc MUST name the corresponding refusal for `in-progress/` so the operator knows the layer is read-only mid-flight.
- **MUST** be pinned by a vitest test (AC4 cases (a), (b), (e), (f)) so future schema or scan-sources changes that accidentally clobber operator edits regress visibly.
- **MUST NOT** introduce any new write path. The allowance is "the operator's editor is the write surface; the plugin's read path is the consumer." `scan-sources`'s existing preserve-on-hash-refresh behaviour is the only piece of the plugin that interacts with operator edits, and it's correct already (Story 3.2 AC3 + `scan-sources.ts` line 437–438 comment cites Story 3.7 directly).

### Negative-capability invariants

- **MUST NEVER** modify any file under `_bmad-output/implementation-artifacts/`. The dev agent does not touch `sprint-status.yaml`.
- **MUST NEVER** add new schema fields to `ExecutionManifestSchema`. The guard works with the existing fields.
- **MUST NEVER** silently rewrite an `in-progress/` manifest under any circumstance. The only writer to `in-progress/` is the orchestrator's claim path (Epic 4/5).
- **MUST NEVER** allow the guard's refusal to be bypassed by an environment variable, CLI flag, or workspace-config field in v1. The hard refusal is the design — bypass mechanisms are deferred.
- **MUST NEVER** call `gh`, the network, the shell, or any process outside the MCP server.
- **MUST NEVER** treat a `withdrawn: true` flip in `in-progress/` as a special case. The guard treats it like any other field mutation and refuses. Operators wishing to withdraw an in-progress story MUST use Story 3.6's `/crew:plan` discard flow against an external-adapter ref (which writes to the manifest atomically via `markWithdrawn`, NOT a hand-edit) or wait for the story to drain into `done/` / `blocked/`.

---

## Tasks / Subtasks

- [x] **Task 1 — Add `### Plain-language guideline` subsection to planner catalogue (AC: 1, 5)**
  - [x] 1.1 Edit `plugins/crew/catalogue/planner.md`. Insert a new H3 subsection `### Plain-language guideline` in the `## Prompt` section, AFTER the existing `### Discipline validation — pre-write check` subsection and BEFORE the existing `### Re-open mode — backlog review and discard flow` subsection. The position is load-bearing: discipline first (gate), style next (refinement), re-open last (mode switch).
  - [x] 1.2 Subsection content MUST include verbatim (these literal strings are what the AC5 grep test asserts):
    - The literal heading `### Plain-language guideline`.
    - The literal phrase `non-engineer who reads code at skim level`.
    - The literal token `FR77`.
  - [x] 1.3 Body of the subsection encodes the prompt-level invariants from § Behavioural contract → Planner catalogue prompt, verbatim where the contract uses MUST / MUST NOT / MUST NEVER absolute modals. Include the four jargon examples (exit codes, internal function names, schema field names, MCP tool names) as a MUST NOT enumeration so the planner internalises concrete avoidances.
  - [x] 1.4 Add an HTML anchor comment immediately above the heading: `<!-- Story 3.7 AC5 anchor — do NOT remove or rename this subsection heading. Tests grep for it. -->` (mirrors the Story 3.5 / Story 3.6 anchor comments above their subsections).
  - [x] 1.5 Confirm the existing Story 3.4 user-value-level invariant and the existing Story 3.5 discipline-gate language are unchanged. The new subsection extends; it does not replace.

- [x] **Task 2 — `detectInProgressHandEdit` predicate / guard (AC: 3, 4)**
  - [x] 2.1 Add `export async function detectInProgressHandEdit(...)` to `plugins/crew/mcp-server/src/state/manifest-state-machine.ts` per the signature in § Behavioural contract → guard. Co-located with `moveBetweenStates` and `isClaimable`.
  - [x] 2.2 Implementation flow: compute `absPath = <targetRepoRoot>/.crew/state/in-progress/<ref>.yaml` → `fs.readFile` (propagate `ENOENT` as a typed `ManifestNotFoundError` with `fromState: "in-progress"`) → `yaml.parse` → `parseExecutionManifest` (propagate `MalformedExecutionManifestError`) → compare `manifest.source_hash` against `opts.sourceHash` → compare each `OperatorEditableFields` field against `opts.sourceFields` using deep-equal semantics → build the `changedFields` array → if non-empty, throw `InProgressHandEditError`; else return `{ ok: true }`.
  - [x] 2.3 Implement deep-equal for `OperatorEditableFields` via a small inline helper (no new dependency). `acceptance_criteria` and `depends_on` use array-order-sensitive comparison; `narrative`, `title`, `implementation_notes`, `withdrawn` are scalar.
  - [x] 2.4 Add the new `InProgressHandEditError` class to `plugins/crew/mcp-server/src/errors.ts`. Properties: `ref: string`, `changedFields: readonly string[]`, `absPath: string`. Constructor builds `message` from the AC3 verbatim diagnostic template; field list is comma-separated, alphabetised.
  - [x] 2.5 Export `InProgressHandEditError` from the errors module's barrel (same pattern as existing errors).
  - [x] 2.6 Add a TSDoc block on `detectInProgressHandEdit` citing this story and the FR14 second half, noting that Epic 4/5 callers MUST invoke this guard on entry for any ref they would operate on in the in-progress layer.

- [x] **Task 3 — Unit + integration tests (AC: 4)**
  - [x] 3.1 Add `plugins/crew/mcp-server/src/state/__tests__/detect-in-progress-hand-edit.test.ts` covering AC4 cases (c) and (d): seed a tmpdir target repo with an `in-progress/<ref>.yaml` manifest written via the canonical `scan-sources` → `moveBetweenStates` path so the bytes match the canonical shape. Then:
    - (c1) hand-edit `title` only; call the guard; assert `InProgressHandEditError` thrown with `changedFields: ["title"]` and message matching the AC3 template.
    - (c2) hand-edit `acceptance_criteria` (reorder one AC); assert detection AND that order-sensitive deep-equal catches the reorder.
    - (c3) hand-edit `withdrawn: false → true`; assert detection (the guard treats this like any other field).
    - (c4) source hash drift (no manifest edit, but the supplied `opts.sourceHash` differs from the on-disk value); assert detection with `changedFields: ["source_hash"]`.
    - (d) no edit, no drift; assert `{ ok: true }`.
  - [x] 3.2 Add `plugins/crew/mcp-server/src/tools/__tests__/hand-edit-allowance.integration.test.ts` covering AC4 cases (a), (b), (e), (f):
    - (a) hand-edit `to-do/` title + narrative; assert `parseExecutionManifest` returns edited values; run `scan-sources` against the unchanged source story; assert edited values preserved AND manifest mtime stable (no rewrite).
    - (b) hand-edit `to-do/` acceptance_criteria; mutate source story (change a single character → new hash); run `scan-sources`; assert `acceptance_criteria` edits preserved AND `source_hash` / `source_path` updated. (Pins the existing Story 3.2 AC3 behaviour under Story 3.7's contract.)
    - (e) hand-edit `blocked/` title; assert `parseExecutionManifest` returns edited value.
    - (f) hand-edit `to-do/` to violate the schema (delete the `title` field on disk); assert `parseExecutionManifest` throws `MalformedExecutionManifestError` with the existing diagnostic shape.
  - [x] 3.3 Both test files use `vitest` (project precedent) and tmpdir fixtures. No reinvented test setup.

- [x] **Task 4 — Documentation (AC: 2, 3)**
  - [x] 4.1 Edit `plugins/crew/docs/README-install.md`. Added `## Editing stories on disk` section documenting the allowance for `to-do/` and `blocked/`, the refusal for `in-progress/`, and the verbatim AC3 diagnostic. Cites FR14.
  - [x] 4.2 `plugins/crew/README.md` does not surface editing guidance — no cross-reference needed.

- [x] **Task 5 — AC5 grep-style test (AC: 5)**
  - [x] 5.1 Added `plugins/crew/mcp-server/src/catalogue/__tests__/planner-prompt-shape.plain-language.test.ts`. Loads `plugins/crew/catalogue/planner.md` from disk and asserts the three AC5 literal substrings are present.
  - [x] 5.2 Ordering assertions included: subsection appears AFTER discipline-gate and BEFORE re-open sections.
  - [x] 5.3 Deterministic — pure file-read + substring assertion. No LLM, no network.

- [x] **Task 6 — Wire-up and build (AC: all)**
  - [x] 6.1 `detectInProgressHandEdit` and `InProgressHandEditError` exported from their respective modules. `OperatorEditableFields` type also exported.
  - [x] 6.2 Rebuilt `plugins/crew/mcp-server/dist/` and committed per CLAUDE.md §Process notes.
  - [x] 6.3 No regression in existing planner-prompt-shape tests (Story 3.5 / 3.6 anchors preserved — all 49 test files pass).
  - [x] 6.4 No regression in existing scan-sources integration tests — 571/571 tests green.

---

## Architecture compliance

- `PlanningAdapter` interface (`mcp-server/src/adapters/adapter.ts`) is unchanged. The hand-edit guard is a tool-layer / state-machine-layer concern that operates on execution manifests, which are adapter-agnostic at the file layer.
- `ExecutionManifestSchema` (`schemas/execution-manifest.ts`) is unchanged. The guard works with the existing fields — `source_hash` for drift detection, and the operator-editable subset for edit detection.
- The state-machine directory layout (Story 1.6 / Story 3.2) is unchanged. The guard is read-only with respect to the filesystem; it never moves or rewrites any manifest.
- `planning-adapter-model.md` §Two-layer model is the binding source: the execution layer (`.crew/state/<state>/<ref>.yaml`) is the plugin's own; the operator's editor is a legitimate write surface against `to-do/` and `blocked/`. This story is the explicit operator-visible side of that model.
- `core-architectural-decisions.md` is unchanged — no new architectural decision is introduced. The hand-edit allowance and refusal are the operator-visible surface of an already-existing decision (Story 1.6's state-machine directory layout + Story 3.2's source-hash-based drift detection).
- `architecture-validation-results.md` Gap 1 (planning-discipline at scan time) is closed by Story 3.5; this story does not interact. Gap 3 (FR78 discard semantics) is closed by Story 3.6; this story does not interact.
- The atomic-write contract (`atomicWriteFile` from `lib/managed-fs.ts`, Story 1.6) is the binding write primitive for every plugin-side write. This story introduces zero new writes — the guard is pure read.
- Source-drift handling (Architecture §Source-drift handling, Story 3.2 AC3) is orthogonal but adjacent. The guard treats source-hash drift on `in-progress/` as a hand-edit because `scan-sources` cannot refresh `in-progress/` manifests (Story 3.2 AC3: "manifests not in `to-do/` are not touched"). The interaction is documented in the guard's TSDoc.
- The Story 3.5 discipline gate runs at authoring time (planner-side) and at scan time (`scan-sources`-side via `validateAgainstDiscipline`). It does NOT re-run on hand-edited `to-do/` or `blocked/` manifests in this story — the operator owns their edits; if the edit produces a discipline-violating manifest, the next `scan-sources` invocation re-runs the gate against the source story (NOT the hand-edited manifest). Hand-edits that introduce discipline violations therefore surface naturally on the next scan via existing Story 3.5 wiring.
- The Story 3.6 `withdrawn` semantics are preserved. Hand-edit `to-do/<ref>.yaml` flipping `withdrawn: false → true` is permitted (it is the operator manually withdrawing without going through `/crew:plan`); the next `isClaimable` check (Story 3.6) sees `withdrawn: true` and the dev loop skips. The guard refuses this same edit in `in-progress/`.

## Library / framework requirements

- **`zod`** — already a dep; reused for parse paths via `parseExecutionManifest`. No version bump.
- **`yaml`** — already a dep; reused for the guard's `yaml.parse` call. No version bump.
- **No new runtime deps.** Deep-equal is implemented inline (the comparison surface is small — six fields, scalars + arrays of objects with known shape — a hand-rolled comparator is correct and avoids pulling in `lodash.isequal` or similar).
- **No new test deps.** vitest is the runner; existing fixture helpers handle tmpdir setup.

## File-structure requirements

NEW files (do not exist today):

- `plugins/crew/mcp-server/src/state/__tests__/detect-in-progress-hand-edit.test.ts` (Task 3.1).
- `plugins/crew/mcp-server/src/tools/__tests__/hand-edit-allowance.integration.test.ts` (Task 3.2).
- `plugins/crew/mcp-server/src/catalogue/__tests__/planner-prompt-shape.plain-language.test.ts` (Task 5.1) — or co-located in an existing planner-prompt-shape test file (recommended default: new file for isolation).

UPDATE files (exist today; story modifies):

- `plugins/crew/catalogue/planner.md` — new `### Plain-language guideline` subsection (Task 1).
- `plugins/crew/mcp-server/src/state/manifest-state-machine.ts` — new `detectInProgressHandEdit` export (Task 2.1 – 2.3).
- `plugins/crew/mcp-server/src/errors.ts` — new `InProgressHandEditError` export (Task 2.4 – 2.5).
- `plugins/crew/docs/README-install.md` — new `## Editing stories on disk` section (Task 4.1).
- `plugins/crew/mcp-server/dist/` — rebuild and commit per `CLAUDE.md` §Process notes (Task 6.2).

NO files to delete.

## Testing requirements

- vitest is the test runner (precedent: every existing `*.test.ts` in the MCP server tree).
- The `detect-in-progress-hand-edit` unit test (Task 3.1) covers AC4 cases (c) and (d) deterministically against tmpdir fixtures. Each assertion is a pure call into the guard; no LLM or network involvement.
- The hand-edit-allowance integration test (Task 3.2) covers AC4 cases (a), (b), (e), (f). The mtime-stability assertion uses `fs.stat().mtimeMs` (mirrors the Story 3.6 `markWithdrawn` idempotency pattern). The malformed-edit assertion uses `expect(...).rejects.toThrowError(MalformedExecutionManifestError)`.
- The AC5 grep-style test (Task 5.1) is pure file-read + substring match. No fixture setup beyond reading `plugins/crew/catalogue/planner.md` from the repo.
- All three test files run via the existing `pnpm --filter ./plugins/crew/mcp-server test` (or equivalent project script — confirm before adding scripts).
- The `InProgressHandEditError` is tested transitively via the guard test (Task 3.1) — every error throw asserts the error type and the message shape. A separate unit test for the error class is not required.
- No new test harness is needed. If the existing `scan-sources` integration test file already exports a tmpdir+seed helper, Task 3.2's tests SHOULD reuse it; if not, lift the seed logic into a local helper rather than a shared module (premature DRY).

## Previous-story intelligence

- **Story 3.1** landed the `PlanningAdapter` interface and registry. No interaction at the adapter layer; the guard operates on manifests.
- **Story 3.2** landed `scan-sources`, the execution-manifest schema, and the source-hash capture. Critical context for this story: `scan-sources.ts` line 435–443 already preserves operator hand-edits on hash refresh — the comment block at line 437–438 ("Operator hand-edits to narrative, acceptance_criteria, withdrawn etc. are preserved per Story 3.7's hand-edit allowance") cites Story 3.7 directly. This story is the explicit pin under that behaviour; no `scan-sources` change is required.
- **Story 3.3** landed the BMad adapter. No interaction.
- **Story 3.3b** landed adapter-config-seam-in-`resolveWorkspace`. The guard does not call `resolveWorkspace` (it's a pure file read by absolute path, given `targetRepoRoot` + `ref`); future callers do.
- **Story 3.4** landed the native adapter, the planner subagent, and the `/crew:plan` skill. This story extends the planner catalogue prompt only; no skill change.
- **Story 3.5** landed `validatePlannerBacklog` and the discipline gate. This story preserves Story 3.5's behaviour entirely; the new `### Plain-language guideline` subsection sits adjacent to but does NOT replace `### Discipline validation — pre-write check`.
- **Story 3.6** landed `/crew:plan` re-open mode, `markWithdrawn`, and `isClaimable`. This story preserves all of Story 3.6's invariants. The `withdrawn` semantics are unchanged; the guard treats a `withdrawn` field edit in `in-progress/` like any other field edit (refused).
- **Story 1.6** landed the atomic-rename state-machine primitive. The guard inherits the "in-progress is owned by the dev loop, mid-flight" model — Story 1.6 is the structural basis for why hand-edits to `in-progress/` are dangerous.
- **Story 1.8** introduced the `user-surface` AC tag convention. This story tags AC2 and AC3 as `user-surface` because they name slash commands (rubric i) and file paths the operator opens by name per docs (rubric iii). AC1, AC4, AC5 are substrate (internal prompt file, integration tests, on-disk anchor).
- **`bugfix-1` retro lesson:** stories ship under green ACs while hiding silent breakage. The hand-edit refusal in `in-progress/` is a direct application of the lesson — silently honouring an in-progress hand-edit is exactly the kind of "looks fine, breaks downstream" failure mode the retro warned about. The explicit refusal is the cure.
- **Pre-PR smoke gate (Story 1.8):** AC2 and AC3 are `user-surface`, so the gate requires either an `automated_e2e_verified` event from the Task 3 tests (deterministic harness driving the relevant tools / skill paths) OR an `user_surface_verified` event with verbatim Claude Code output of the refusal diagnostic from a real operator run. The Task 3.2 hand-edit-allowance test covers AC2 deterministically. AC3's `user-surface` aspect — operator seeing the refusal in chat — is currently consumer-less (no skill or tool wires the guard in v1); the deterministic Task 3.1 test covers the guard's behaviour, but the chat-observable surface emerges only when Epic 4/5 wires the first caller. The pre-PR smoke gate may therefore need an operator-paste of a synthetic `/crew:status` invocation against an `in-progress/`-hand-edited fixture — flag for the operator when running ship-story.

## Project-context reference

- **Authoritative PRD:** `_bmad-output/planning-artifacts/prd-crew-v1/` (sharded). Functional requirements cited: FR14 (direct-edit allowance — `to-do/` and `blocked/` writeable, `in-progress/` not), FR77 (plain-language guideline — non-testable, shaped via planner prompt).
- **Authoritative architecture:** `_bmad-output/planning-artifacts/architecture/planning-adapter-model.md` (§Two-layer model — operator's editor is a legitimate write surface against the execution layer's `to-do/` and `blocked/`), `core-architectural-decisions.md` (atomic state-machine moves — the basis for why `in-progress/` is read-only mid-flight).
- **User-surface AC convention:** `plugins/crew/docs/user-surface-acs.md` (the gate-binding rubric and tag regex `^\*\*AC(\d+)\s*\(user-surface\)\s*:\*\*`).
- **Build-output rule:** project `CLAUDE.md` §Process notes — `plugins/crew/mcp-server/dist/` must be rebuilt and committed in the same change. CI fails on drift.
- **Communication style:** per project `CLAUDE.md` §How to talk to Jack — terse, PM-language, recommend defaults, no engineering-judgement asks at the spec-author layer.
- **Negative-capability anchor:** `sprint-status.yaml` and everything under `_bmad-output/implementation-artifacts/` is owned by the orchestrator. This story MUST NOT touch any of it.
- **Memory-pinned conventions:** dependency versions default to latest stable resolved by pnpm (no new deps in this story); no `cd` into subdirs (every path in this spec is absolute or rooted at the worktree's CWD); never amend or skip hooks; never commit to local main.

---

## Story completion status

Status: review

Ultimate context engine analysis completed — comprehensive developer guide created.

Notes for the dev agent:
- Five ACs total (AC1–AC4 from the epic + AC5 added per spec brief for deterministic catalogue-prompt content-structure).
- ACs tagged `user-surface`: AC2 and AC3 (both name `/crew:scan`, `/crew:status`, `/crew:plan` slash commands AND the `.crew/state/...` file paths the operator opens per the install docs). AC1, AC4, AC5 are substrate (internal catalogue file content, integration-test surface, on-disk grep anchor respectively). The pre-PR gate's user-surface coverage requirement is therefore AC2 + AC3 — both covered deterministically by the Task 3 tests, with the AC3 chat-observable side flagged for operator verification once Epic 4/5 wires the first caller.
- The Behavioural contract section is required for `user-surface` stories per the spec brief and IS present — see § Behavioural contract above. The planner catalogue prompt extension (Task 1) is the load-bearing carrier for FR77; the `detectInProgressHandEdit` predicate + `InProgressHandEditError` (Task 2) is the load-bearing carrier for FR14's in-progress refusal; the documented `to-do/` / `blocked/` allowance (Task 4) plus the test-pinning of `scan-sources`'s existing preserve-on-refresh behaviour (Task 3.2 cases (a), (b), (e), (f)) is the load-bearing carrier for FR14's first half.
- Do NOT modify `sprint-status.yaml` or any file under `_bmad-output/implementation-artifacts/` during implementation. The orchestrator owns status. The guard is a pure read against `<target-repo>/.crew/state/in-progress/<ref>.yaml`; no plugin-side write paths are introduced by this story.
- Two design defaults the dev agent should follow without asking:
  - When implementing deep-equal for `OperatorEditableFields`, hand-roll a small inline helper rather than pulling in `lodash.isequal`. The comparison surface is small (six fields with known shapes) and the project memory rule on dependency versions favours not adding deps speculatively.
  - When adding the AC5 grep test, prefer a new test file (`planner-prompt-shape.plain-language.test.ts`) over extending the existing Story 3.5 / 3.6 shape tests. Per-story isolation makes future prompt edits easier to regress-test and easier to read in PR diffs.
- No new MCP tool ships in this story. The `InProgressHandEditError` is the surface upstream callers will pattern-match against once Epic 4/5 wires the first consumer of `detectInProgressHandEdit`. v1 of this story is "ship the predicate + the error + the prompt + the docs; consumer wiring is Epic 4/5's pickup."
- The `scan-sources` preserve-on-hash-refresh behaviour at `scan-sources.ts` line 435–443 is already correct and explicitly cites this story in its comment. Do NOT modify `scan-sources.ts`. Task 3.2's tests pin the existing behaviour rather than introduce new behaviour.

---

## Dev Agent Record

### Completion Notes

Implemented all six tasks per the story spec. Key implementation decisions:

- `detectInProgressHandEdit` is co-located with `moveBetweenStates` and `isClaimable` in `manifest-state-machine.ts` as specified. The function is async, pure-read, and exports `OperatorEditableFields` type for callers.
- Deep-equal for `OperatorEditableFields` is hand-rolled inline (six fields, known shapes) — no new runtime dependency added.
- `InProgressHandEditError` builds its message with the verbatim AC3 diagnostic; field list is alphabetically sorted for determinism.
- `readFile` is imported from `node:fs/promises` in the state machine (only read-shaped API — no banned write binding added).
- The `### Plain-language guideline` subsection is inserted between the discipline-gate and re-open subsections as specified, with the Story 3.7 AC5 anchor comment.
- Integration tests construct a fresh native-adapter workspace from scratch (with proper `**Given**/**When**/**Then**` formatted stories) rather than reusing the native fixture, which had a different AC format that failed `parseNativeStory`'s validator.
- All test code uses `atomicWriteFile` for writes to avoid triggering the canonical-fs-guard static check (which scans `src/**` including `__tests__/` subdirs).
- 571/571 tests green across 49 test files.

### File List

- `plugins/crew/catalogue/planner.md` — added `### Plain-language guideline` subsection (Task 1)
- `plugins/crew/mcp-server/src/errors.ts` — added `InProgressHandEditError` export (Task 2.4)
- `plugins/crew/mcp-server/src/state/manifest-state-machine.ts` — added `detectInProgressHandEdit`, `OperatorEditableFields`, `operatorFieldsEqual` exports; added `readFile` import (Task 2.1–2.6)
- `plugins/crew/docs/README-install.md` — added `## Editing stories on disk` section (Task 4.1)
- `plugins/crew/mcp-server/src/state/__tests__/detect-in-progress-hand-edit.test.ts` — new file (Task 3.1)
- `plugins/crew/mcp-server/src/tools/__tests__/hand-edit-allowance.integration.test.ts` — new file (Task 3.2)
- `plugins/crew/mcp-server/src/catalogue/__tests__/planner-prompt-shape.plain-language.test.ts` — new file (Task 5)
- `plugins/crew/mcp-server/dist/` — rebuilt (Task 6.2)

### Change Log

- 2026-05-21: Story 3.7 implemented — plain-language guideline prompt extension (FR77) and detectInProgressHandEdit guard (FR14 second half)
