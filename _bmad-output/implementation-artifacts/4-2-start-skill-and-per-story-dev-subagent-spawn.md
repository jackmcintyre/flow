# Story 4.2: `/start` skill and per-story dev subagent spawn

story_shape: user-surface

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin operator on a primed backlog**,
I want **to type `/crew:start` and have the dev session claim the next ready story, spawn a clean-context dev subagent assembled from the `generalist-dev` persona, and terminate naturally when the queue is empty**,
so that **my backlog drains end-to-end without manual intervention and without a mega-agent's context drifting across stories.**

### What this story is, in one sentence

Ship the three pieces that wire the v1 dev loop's entry point: (1) the `/crew:start` slash-command skill at `plugins/crew/skills/start/SKILL.md` that runs the dev-session loop; (2) the in-loop logic that picks the next claimable story from `.crew/state/to-do/` (filtered by `isClaimable` from Story 3.6), calls `claimStory` (Story 4.1), and on success spawns a per-story dev subagent via Claude Code's `Task` tool with a clean context; (3) the persona-assembly path that reads the `generalist-dev` persona file once at spawn time and uses `persona body (Domain + Mandate + Out of mandate + Prompt) + Knowledge section` as the subagent's system prompt — per Architecture §Agent invocation model. The skill prints story summaries as it spawns, surfaces typed errors verbatim, and terminates with a deterministic "queue drained" line when `to-do/` and `in-progress/` are both empty.

### What this story fixes (and why it needs its own story)

Story 4.1 just landed the `claimStory` / `completeStory` MCP primitives — atomic state transitions, dependency check, hand-edit refusal. None of those primitives have an operator-visible caller yet. Until this story lands:

- The operator has no way to launch the dev loop. `/crew:start` does not exist; nothing observes the backlog and acts on it.
- `claimStory` cannot be called from the chat surface — only programmatically by tests.
- The architecture's clean-context-per-story invariant (FR24, Architecture §Per-story subagent) is unimplemented: no caller spawns subagents via the `Task` tool, no caller assembles the persona system prompt at spawn, and no caller terminates the loop deterministically.

This story is the user-facing entry point to Epic 4. It is deliberately scoped to **claim + spawn + terminate** — the dev subagent's handoff to the reviewer (Story 4.3), `git push` / `gh pr create` (Story 4.4), reviewer subagent (4.6), risk-tier (4.9), auto-merge (4.10b), and yield protocol (4.11) all layer on top. Without 4.2, every later Epic 4 story is paper.

### This story does NOT

- (a) Touch `_bmad-output/implementation-artifacts/sprint-status.yaml` or any other file under `_bmad-output/implementation-artifacts/`. The orchestrator owns status transitions. The dev agent MUST NOT edit any status / state file when implementing this story.
- (b) Implement the dev subagent's actual implementation behaviour. The dev subagent's prompt is the `generalist-dev` persona; what it *does* with that prompt (read AC, write code, run tests) is the subagent's own remit and is constrained by its `permissions/generalist-dev.yaml` allowlist. This story ships the spawn mechanism, not the subagent's internal logic.
- (c) Implement the locked handoff phrase parser, the dev → reviewer transition, the rework-signal counter, or the reviewer subagent spawn. Those are Story 4.3's deliverables. The dev subagent spawned here runs until it terminates of its own accord; the `/crew:start` loop simply moves to the next claimable story after the spawn returns.
- (d) Implement `git push`, `gh pr create`, branch naming, or commit shape. Story 4.4 owns those. The dev subagent in this story may attempt them (its persona permits `pr-create`), but no `/start`-side parsing or PR-shape enforcement is built here.
- (e) Implement the `block-story` MCP tool (FR20), the rework loop (FR28), or `blocked_by` handling. The dev subagent calls `blockStory` directly if it needs to; this story does not add new state-transition tools. `block-story` is a separate story (Epic 4 backlog).
- (f) Implement heartbeat, stale-claim detection, recovery from session death, or relaunch semantics (FR23). Those are Epic 5 (`heartbeat.ts`, `archive-cycle.ts`).
- (g) Implement the orchestration session (`/<plugin>:watch`, FR16) or any inter-session coordination beyond what the filesystem provides. `/crew:start` is one session; orchestration is another.
- (h) Implement telemetry (`agent.invoke`, `reviewer.verdict`). Story 4.12 owns telemetry plumbing. The skill is silent with respect to JSONL.
- (i) Implement the yield protocol (FR99–FR104) or domain-routing. Story 4.11 owns that.
- (j) Implement risk-tier classification or auto-merge. Stories 4.9 / 4.9b / 4.10 / 4.10b.
- (k) Re-implement `claimStory`, `isClaimable`, `readPersona`, `instantiatePersona`, the workspace resolver, or `parseExecutionManifest`. All shipped — this story imports and wires them.
- (l) Add a `--force` claim path, a `--skip-deps` flag, or any operator override of `DependenciesNotReadyError` / `InProgressHandEditError`. Refusals are unconditional, mirroring Story 3.7 / 4.1.
- (m) Generate ULIDs anywhere except for the session identifier passed to `claimStory`. Story refs are produced by the planner (Story 3.4) and stamped in source-story files; the dev session does not invent new refs.
- (n) Add a queue-prioritisation strategy beyond "first claimable manifest in alphabetical ref order." Sophisticated priority (age, label, urgency) is post-v1.
- (o) Read or write the source story file directly. The dev subagent reads source stories via the `readSourceStory` MCP tool exposed in its `permissions/generalist-dev.yaml` — the `/start` skill itself never reads source-story files.

---

## Acceptance Criteria

> AC1 is verbatim from the epic with the user-surface tag applied per `plugins/crew/docs/user-surface-acs.md`. AC2 / AC3 are the epic's spawn-mechanics and termination ACs — each judged individually for user-surface status. AC4 is the epic's integration AC (not user-surface). AC5 is the deterministic content-structure check the brief requires; it inspects the on-disk `SKILL.md` file and is tagged user-surface because the file path is part of the install/README discoverability contract.

**AC1 (user-surface):**
**Given** a target repo with at least one claimable story in `<targetRepoRoot>/.crew/state/to-do/` (status `to-do`, `withdrawn: false`, all `depends_on` refs present in `done/`),
**When** the operator types `/crew:start` in Claude Code,
**Then** the chat surface (a) prints a single-line header `dev session — workspace: <targetRepoRoot> — session: <sessionUlid>`, (b) prints a per-claim line of shape `claiming <ref> — <title>` followed by `spawning generalist-dev subagent (clean context)`, and (c) the dev subagent runs as a `Task`-tool spawn whose system prompt is the assembled `generalist-dev` persona text (frontmatter-stripped body of `<targetRepoRoot>/team/generalist-dev/PERSONA.md` — see § Implementation strategy — including the `## Knowledge` section), with a fresh context isolated from the calling session. _(FR15, FR24)_

<!-- User-surface: names the slash-command literal `/crew:start` (rubric i). The chat-surface output lines and the `Task`-tool spawn are both directly observable by the operator (rubric iv). AC1's chat surface is runnable today: every dependency — `claimStory`, `isClaimable`, `readPersona`, `Task`, the workspace resolver — is shipped. No deferred caller. (Per `plugins/crew/docs/user-surface-acs.md` § "Don't tag an AC user-surface if its chat surface depends on a deferred caller.") -->

**AC2 (user-surface):**
**Given** the dev subagent's prompt assembly inside `/crew:start`,
**When** the subagent is spawned,
**Then** the persona file at `<targetRepoRoot>/team/generalist-dev/PERSONA.md` is read exactly once per spawn (via `buildPersonaSpawnPrompt`, which internally calls `readPersona` once) — captured in memory for that spawn only — and the subagent is NOT given any tool affordance that would let it re-read its own persona mid-flight (no `readPersona` and no `buildPersonaSpawnPrompt` in the dev subagent's tool surface for this story; the persona text is already inside its system prompt). On a subsequent claim within the same `/crew:start` session, `buildPersonaSpawnPrompt` is invoked again so a persona edit between stories is picked up at the next spawn. _(Architecture §Agent invocation model — "one read at spawn; subagent doesn't re-read mid-flight")_

<!-- User-surface (judgement call): AC2 governs the spawn mechanism rather than naming a slash-command literal or a copy-by-name path. The "Task-tool spawn with assembled prompt" is the Claude Code UI surface the operator observes (rubric iv) — a new subagent appears in the Task tool UI panel, distinguishable from the calling session by its fresh context. Per `user-surface-acs.md` rubric (iv) plus epic-3-retro guidance: the spawn surface is load-bearing for the dev loop and merits user-surface evidence (an automated test or operator-pasted Task-tool UI output). -->

**AC3 (user-surface):**
**Given** a target repo where `<targetRepoRoot>/.crew/state/to-do/` and `<targetRepoRoot>/.crew/state/in-progress/` are both empty (no `.yaml` files in either directory),
**When** the operator types `/crew:start`,
**Then** the skill terminates without spawning any subagent and prints exactly one line: `queue drained — to-do/ and in-progress/ are both empty. Stop here, or run /crew:plan to add work.` (verbatim copy of the line, used as a deterministic anchor for the integration test in AC4). The skill exits with no error. _(FR22)_

<!-- User-surface: names the slash-command literal `/crew:start` (rubric i). The "queue drained" line is the operator's observable chat surface — they read it directly when the loop terminates (rubric iv). The exact wording is the deterministic anchor required for the integration test under AC4 and matches the pattern in `plan/SKILL.md` of using verbatim pointer text. -->

**AC4 (integration):**
vitest covers four branches against a fixture target repo:
- (a) **Happy multi-claim:** seed three independent stories (no `depends_on` between them) in `to-do/`. Drive `/crew:start`'s underlying claim-and-spawn function through the test seam (see § Implementation strategy). Assert (i) three subagent-spawn invocations were issued in the order of `isClaimable`-filtered ref enumeration, (ii) each spawn received a freshly-assembled persona prompt (the `buildPersonaSpawnPrompt` test double is called three times — once per spawn), (iii) each spawn was issued with `subagent_type: "general-purpose"` (or the agreed Task-tool subagent shape — see § Implementation strategy) and the assembled system prompt as the `prompt` field, (iv) `claimStory` was called three times with the same `sessionUlid` for the `/start` invocation, and (v) the final state has all three manifests in `in-progress/` (or `done/` if the test seam simulates completion).
- (b) **Queue drained:** seed empty `to-do/` and `in-progress/`. Drive `/crew:start`. Assert the verbatim line from AC3 is in the captured chat output and zero spawns were issued.
- (c) **Deps-not-ready surfacing:** seed two stories with `B.depends_on = [A]`; `A` is in `to-do/`, `B` is in `to-do/`. Drive `/crew:start`. Assert (i) `A` is claimed and spawned, (ii) `B` is skipped in the same loop pass because its dep is not in `done/` (the loop's pre-claim filter calls `isDependencyReady` or catches `DependenciesNotReadyError` from `claimStory`), (iii) no `DependenciesNotReadyError` text is printed to chat for stories the pre-filter declined — the error is for stories the operator explicitly targeted, not for filter-eligibility (see § Error surfacing).
- (d) **Hand-edit refusal surfacing:** seed `in-progress/<ref>.yaml` for an unrelated previously-claimed story and hand-edit one of its operator-editable fields on disk. Pre-place a claimable story in `to-do/`. Drive `/crew:start`. The expected behaviour: the skill claims the to-do/ ref normally (the hand-edited in-progress/ ref is not re-touched by this skill — the guard runs only on the ref being operated on, per Story 3.7's caller contract). The integration test asserts the hand-edited manifest is unchanged and the new claim succeeded. (A separate negative test: directly call `claimStory` on the hand-edited ref via the seam; assert `InProgressHandEditError` surfaces in chat verbatim with the changed-field list — this exercises the error-surfacing path required by AC1's "errors are surfaced verbatim" implicit contract.)

**AC5 (user-surface):**
**Given** the `/crew:start` skill file at `plugins/crew/skills/start/SKILL.md`,
**When** the file is inspected,
**Then** the file MUST contain:
- (i) front-matter `name` field exactly equal to `crew:start` (anchor: `^name: crew:start$` in the YAML frontmatter, MULTILINE);
- (ii) front-matter `allowed_tools` array that includes at minimum `Task`, `buildPersonaSpawnPrompt`, `claimStory`, and `getStatus` (anchor: each appears as a list item under the `allowed_tools:` key);
- (iii) a `# Steps` section (H1 or H2, both accepted) that contains the verbatim string `spawn the generalist-dev subagent via Claude Code's Task tool` somewhere in its prose;
- (iv) the verbatim queue-drained line from AC3 — `queue drained — to-do/ and in-progress/ are both empty. Stop here, or run /crew:plan to add work.` — present in the SKILL.md body (so the skill prints it verbatim rather than improvising wording each run);
- (v) a `# Failure modes` section that names at least the four typed errors the skill surfaces verbatim: `DependenciesNotReadyError`, `InProgressHandEditError`, `WrongClaimantError`, and `NoAdapterMatchedError`.

<!-- User-surface: AC5 references the install-doc-discoverable skill file path `plugins/crew/skills/start/SKILL.md` (rubric iii — `plugins/crew/docs/README-install.md` enumerates skill files during install checkpoints) AND the slash-command surface `/crew:start` (rubric i). The deterministic content-structure anchors (front-matter regex, verbatim string match, section header presence) make the AC mechanically checkable — required by the brief because LLM-generated SKILL.md prose is otherwise non-deterministic. -->

---

## Behavioural contract

The `/crew:start` skill is a thin orchestrator that drives an LLM loop; the dev subagent it spawns is itself LLM-driven. Both surfaces are governed by prompt-level invariants stated in absolute modal language. Every invariant maps to an AC or a `does NOT` clause above and exists so future SKILL.md / persona edits can be reviewed against a fixed contract. The SKILL.md MUST cite this section by file path (`_bmad-output/implementation-artifacts/4-2-start-skill-and-per-story-dev-subagent-spawn.md § Behavioural contract`) in an HTML comment near the top so a future skill-editor can find the source of the invariants.

### `/crew:start` skill prompt invariants

- **MUST** print the per-claim line `claiming <ref> — <title>` BEFORE issuing the `Task`-tool spawn, so the operator sees what is about to happen. The story title comes from the parsed execution manifest's `title` field; if absent / unreadable, the line MUST degrade to `claiming <ref> — <title-unavailable>` rather than failing the loop.
- **MUST** spawn the dev subagent via Claude Code's `Task` tool — never via a direct shell-out, a Bash invocation, a chained `/`-prefixed skill call, or any in-process function call that would share the calling session's context. The clean-context guarantee (FR24, Architecture §Agent invocation model) is structural: only `Task` provides it.
- **MUST** call `buildPersonaSpawnPrompt({ targetRepoRoot, role: "generalist-dev" })` exactly once per spawn; that tool internally reads the persona file exactly once. The skill MUST never reuse a cached prompt string across spawns within the same `/crew:start` session. A persona edit between two stories MUST be picked up on the next spawn. _(per AC2; per Architecture §Persona injection)_
- **MUST NEVER** call `buildPersonaSpawnPrompt` (or instantiate any persona) during the queue-drained path. When `to-do/` and `in-progress/` are both empty, the skill terminates BEFORE any persona read, BEFORE any `claimStory` call, and BEFORE any `Task` spawn. _(per AC3)_
- **MUST** print the queue-drained line verbatim — `queue drained — to-do/ and in-progress/ are both empty. Stop here, or run /crew:plan to add work.` — character-for-character, no improvisation, no paraphrase, no added emoji or punctuation. The integration test pins this; rephrasing breaks the deterministic anchor. _(per AC3, AC5(iv))_
- **MUST** surface typed errors verbatim. When `claimStory` throws `DependenciesNotReadyError`, `InProgressHandEditError`, `WrongClaimantError`, `ManifestNotFoundError`, `MalformedExecutionManifestError`, or `NoAdapterMatchedError`, the skill MUST print the error's `name` and `message` verbatim to chat and continue or terminate per the failure-mode rules in SKILL.md. The skill MUST NOT swallow, paraphrase, or downgrade a `DomainError`.
- **MUST NEVER** modify `sprint-status.yaml`, any `.crew/state/<state>/<ref>.yaml` manifest directly, any file under `.git/`, or any source story file. The skill's only write surface is the chat output and the `Task`-spawn invocation. State transitions happen exclusively through `claimStory` (and, when later stories land, `completeStory` / `blockStory`). _(per does-NOT clauses (a), (k))_
- **MUST** generate the session ULID once at `/crew:start` invocation and re-use it for every `claimStory` call in that session. The ULID identifies "this dev session" — Story 4.1's `claimStory` stamps it as `claimed_by`. Each `/crew:start` invocation is one session; subsequent invocations get new ULIDs.
- **MUST** call `getStatus({ targetRepoRoot })` as the first MCP call in every `/crew:start` invocation. This (i) triggers the workspace resolver if `.crew/config.yaml` is absent, (ii) confirms an active adapter is resolvable, and (iii) lets `NoAdapterMatchedError` surface BEFORE any claim attempt. _(per failure modes in SKILL.md)_
- **MUST NOT** call `scanSources`, `writeNativeStory`, `markWithdrawn`, or any planner-layer tool. The dev session reads `.crew/state/to-do/` as-is; if the operator wants to refresh source stories first, that is `/crew:scan`'s job and the operator runs it explicitly.
- **MUST** filter the `to-do/` candidate set through `isClaimable` (Story 3.6) BEFORE calling `claimStory`. A withdrawn ref MUST NOT be passed to `claimStory`. _(per Story 4.1's TSDoc which delegates the filter to `/start`)_
- **MUST** iterate the candidate set in stable ref-alphabetical order. No randomness, no priority heuristic in v1 — every `/crew:start` invocation on the same backlog state produces the same claim sequence.
- **MUST NOT** await the dev subagent's "completion" in a way that blocks the queue. The `Task`-tool spawn returns when the subagent finishes; the skill then moves to the next claimable ref. If the subagent terminates without calling `completeStory` / `blockStory`, the manifest stays in `in-progress/`; that is Story 4.3's / Story 4.12's recovery surface, not this skill's.

### `generalist-dev` persona prompt invariants (assembled at spawn)

The persona file at `plugins/crew/catalogue/generalist-dev.md` already encodes the dev role's mandate. Story 4.2 does not rewrite the persona body; it MAY extend the `## Prompt` section with the following invariants if they are not already present, and MUST verify on inspection that each is present in the assembled spawn prompt. (The persona is hired via `/crew:hire` and lives at `<targetRepoRoot>/team/generalist-dev/PERSONA.md` — Story 2.4. The spawn reads from the team/ copy, not the catalogue.)

- **MUST** claim and work exactly one story per spawn — the ref passed in the spawn's initial context. The subagent MUST NOT iterate the queue itself or attempt a second `claimStory` call.
- **MUST** call `completeStory` with the spawn's session ULID and ref as its terminal MCP call on success. On failure (irrecoverable error, story under-specified, etc.) it MUST call `blockStory` (Story 4.3+ deliverable; until that lands the subagent surfaces a `BLOCKED` chat line and exits — the manifest stays in `in-progress/`).
- **MUST NEVER** read or write any other story's manifest in `<targetRepoRoot>/.crew/state/`. The only refs the subagent operates on are the one it was spawned for.
- **MUST NEVER** modify the persona file at `<targetRepoRoot>/team/generalist-dev/PERSONA.md` from within the subagent (no self-editing; Story 6's `accept-proposal` flow is the only path).
- **MUST** yield with the catalogue's locked yield phrase if the work falls in a hired specialist's domain. _(per existing persona mandate; per FR99–FR104, fully wired in Story 4.11.)_

---

## Tasks / Subtasks

- [ ] **Task 1 — Create the `/crew:start` skill file (AC: 1, 3, 5)**
  - [ ] 1.1 Create directory `plugins/crew/skills/start/` and file `plugins/crew/skills/start/SKILL.md`. Front-matter MUST exactly match AC5(i)/(ii): `name: crew:start`, a `description:` one-liner, and `allowed_tools:` list including (at minimum) `Task`, `buildPersonaSpawnPrompt`, `claimStory`, `getStatus`. Add `readBacklogInventory` if the queue-pre-scan implementation chooses to use that tool (see § Implementation strategy); otherwise omit it.
  - [ ] 1.2 Body sections (in order): `# /crew:start`, `# What this skill does` (one paragraph; describe the claim-spawn-terminate loop), `# Prerequisites` (mirror `plan/SKILL.md` style — workspace resolved, at least one source story scanned), `# Steps` (numbered list — see Step 1.3 below), `# Failure modes` (must list the four typed errors from AC5(v) with one-paragraph operator-facing explanations each), `# Termination conditions` (queue-drained behaviour with the verbatim line from AC3 / AC5(iv)).
  - [ ] 1.3 The `# Steps` section's prose MUST contain — verbatim, somewhere in the body — the string `spawn the generalist-dev subagent via Claude Code's Task tool` (AC5(iii) anchor). The steps in order:
    1. Identify `targetRepoRoot` as the current Claude Code workspace root.
    2. Call `getStatus({ targetRepoRoot })`. On `NoAdapterMatchedError` / `UnknownAdapterError` / `AmbiguousAdapterError`, surface verbatim and stop.
    3. Generate a session ULID. (Implementation: see § Implementation strategy — the skill calls a thin helper or relies on the MCP server to mint one. ULID generation MUST NOT be left to LLM improvisation; see Task 2.)
    4. Print the header line `dev session — workspace: <targetRepoRoot> — session: <sessionUlid>`.
    5. Loop: pre-scan `<targetRepoRoot>/.crew/state/to-do/` for claimable refs (see Task 3). If the candidate set is empty AND `<targetRepoRoot>/.crew/state/in-progress/` is empty, print the AC3 queue-drained line verbatim and exit.
    6. For each candidate ref in alphabetical order:
       a. Pre-check `depends_on` against `done/` (cheap directory stat — avoid a wasted `claimStory` call when the dep filter is the gate; see Task 3). If any dep is missing, skip the ref silently within the same pass.
       b. Print `claiming <ref> — <title>`.
       c. Call `claimStory({ targetRepoRoot, ref, sessionUlid, role: "orchestrator" })`. On any typed error other than `DependenciesNotReadyError`, surface verbatim, log to chat, and continue with the next candidate. On `DependenciesNotReadyError` (race: a dep landed between pre-check and claim), surface and continue.
       d. On success: call `buildPersonaSpawnPrompt({ targetRepoRoot, role: "generalist-dev" })` to obtain the assembled system prompt (the tool internally reads the persona file once per call — see § Implementation strategy).
       e. Print `spawning generalist-dev subagent (clean context)`.
       f. Invoke Claude Code's `Task` tool with the assembled system prompt and an `<initial-context>` block containing `ref`, `title`, `sessionUlid`, `targetRepoRoot`, and the manifest's relative path on disk. Mirror the `<initial-context>` shape used by `plan/SKILL.md` (Step 4).
       g. When the `Task` spawn returns, continue the loop.
    7. After the loop exits because the candidate set is empty AND `in-progress/` is empty, print the queue-drained line and exit.
  - [ ] 1.4 Add an HTML comment near the top of SKILL.md citing the Behavioural contract section of this spec by full path (per the rule under § Behavioural contract).
  - [ ] 1.5 No `--help`, no `--dry-run`, no flag parsing in v1. The skill takes no arguments; the workspace root is implicit.

- [ ] **Task 2 — Session ULID minting (AC: 1, 2, 4)**
  - [ ] 2.1 The skill MUST NOT ask the LLM to "generate a ULID" — that path is non-deterministic and risks collision / shape drift. Add a small MCP tool or expose a helper for session-ULID minting. **Default decision:** introduce `mintSessionUlid` MCP tool returning `{ sessionUlid: string }` where the string is a freshly generated ULID via the `ulid` npm package (already a transitive dep via Story 3.2's native-story refs; confirm during implementation — if not present, add `ulid` to `plugins/crew/mcp-server/package.json` dependencies pinned to latest stable).
  - [ ] 2.2 The tool lives at `plugins/crew/mcp-server/src/tools/mint-session-ulid.ts`. It is pure: no IO, no filesystem touch, no telemetry. The tool exists solely so the LLM-driven skill cannot improvise ULIDs.
  - [ ] 2.3 Register the tool in `plugins/crew/mcp-server/src/tools/register.ts` alongside `claimStory` / `completeStory`. Tool name follows the camelCase verb-noun convention (Architecture §MCP Tool Naming).
  - [ ] 2.4 Add `mintSessionUlid` to the SKILL.md's `allowed_tools` array. The `permissions/generalist-dev.yaml` MUST NOT include this tool — the dev subagent does not mint ULIDs.

- [ ] **Task 3 — Claimable-candidate enumerator (AC: 1, 3, 4)**
  - [ ] 3.1 The skill needs to enumerate `.crew/state/to-do/<ref>.yaml` files, parse each via `parseExecutionManifest`, filter by `isClaimable`, and emit `{ ref, title, depends_on }`. **Decision:** rather than have the SKILL.md prose enumerate filesystem operations (which Claude Code's skill-runner cannot reliably do without a tool), expose a thin MCP tool `listClaimableTodos` returning `{ todos: Array<{ ref: string; title: string; depends_on: readonly string[] }> }` in stable alphabetical order.
  - [ ] 3.2 Implement `plugins/crew/mcp-server/src/tools/list-claimable-todos.ts`. It reads the `to-do/` directory of the resolved target repo, parses each manifest via `parseExecutionManifest`, filters via `isClaimable(manifest)` from `state/manifest-state-machine.ts`, sorts by ref ascending, and returns the projection. On a malformed manifest, propagate `MalformedExecutionManifestError` verbatim (the skill surfaces it). No write side-effects.
  - [ ] 3.3 Add a companion `listInProgress` MCP tool — or extend `listClaimableTodos` with a `{ todos: [...], inProgressCount: number }` shape — so the skill can decide the queue-drained condition without a separate filesystem call. Default: extend the existing tool; one round-trip is cheaper than two.
  - [ ] 3.4 Register the tool in `register.ts`. Add to the SKILL.md `allowed_tools`. The dev subagent's permissions MUST NOT include this tool (it is `/start`-only).
  - [ ] 3.5 Dep-readiness pre-check: rather than a third tool, fold the dep check into `listClaimableTodos` by extending its return shape with `depsReady: boolean` per ref. The tool stats `<targetRepoRoot>/.crew/state/done/<dep>.yaml` for each `dep` in `depends_on`; if all present, `depsReady: true`. The skill then claims only refs where `depsReady` is true and skips others silently (per AC4(c)).

- [ ] **Task 4 — Persona-prompt assembly helper (AC: 1, 2, 4)**
  - [ ] 4.1 The skill needs the assembled system-prompt text for the `Task` spawn. The persona file's `sections` already contain `Domain`, `Mandate`, `Out of mandate`, `Prompt`, and `Knowledge`. Per Architecture §Persona injection: the spawn prompt is the catalogue prompt body + persona knowledge section. **Decision:** introduce a `buildPersonaSpawnPrompt` MCP tool that takes `{ targetRepoRoot, role }`, calls `readPersona` internally, and returns `{ systemPrompt: string }`. This (a) centralises the assembly contract so a future persona-format change updates one place, (b) lets the deterministic test in AC4 mock a single tool rather than two, and (c) keeps the skill's prose simple ("call `buildPersonaSpawnPrompt`, pass result to Task").
  - [ ] 4.2 Implement `plugins/crew/mcp-server/src/tools/build-persona-spawn-prompt.ts`. Composition order (load-bearing — pins the architecture decision):
    ```
    # <Role display name> — Persona

    ## Domain
    <Domain section verbatim>

    ## Mandate
    <Mandate section verbatim>

    ## Out of mandate
    <Out of mandate section verbatim>

    ## Prompt
    <Prompt section verbatim>

    ## Knowledge
    <Knowledge section verbatim>
    ```
    The frontmatter (`role:`, `domain:`, `model_tier:`, `tools_allow:`, `gh_allow:`, `locked_phrases:`, `hired_at:`, `catalogue_version:`) is NOT included in the spawn prompt — it is plugin-runtime metadata, not LLM instructions. The five `##` sections are concatenated verbatim from the parsed `PersonaFile.sections`.
  - [ ] 4.3 The locked phrases live in the persona frontmatter, not the prompt body. To ensure the subagent knows them, append (after the Knowledge section) a sentinel block:
    ```
    ## Locked phrases (do not paraphrase)
    - Handoff: "<locked_phrases.handoff verbatim>"
    - Yield: "<locked_phrases.yield verbatim>"
    - Verdict: "<locked_phrases.verdict verbatim>"
    ```
    This is the single source where locked-phrase strings cross from frontmatter into LLM-readable text. Document the contract in TSDoc.
  - [ ] 4.4 Register in `register.ts`. Add `buildPersonaSpawnPrompt` to the SKILL.md `allowed_tools`. The dev subagent's `permissions/generalist-dev.yaml` MUST NOT include this tool (the subagent doesn't assemble its own prompt; the orchestrator does).
  - [ ] 4.5 Edge case: if `<targetRepoRoot>/team/generalist-dev/PERSONA.md` does not exist (operator skipped `/crew:hire`), `readPersona` throws `PersonaFileNotFoundError`. The tool propagates it verbatim. The skill surfaces the error and stops — the operator MUST run `/crew:hire` (or `/crew:skip-hiring`) before `/crew:start`.

- [ ] **Task 5 — Update `permissions/generalist-dev.yaml` ONLY if necessary (AC: 2)**
  - [ ] 5.1 Inspect `plugins/crew/permissions/generalist-dev.yaml`. The current allowlist (per Story 2.2 / 2.3 / 4.1) is:
    ```yaml
    tools_allow:
      - claimStory
      - completeStory
      - blockStory
      - readSourceStory
      - lookupStandards
      - recordYield
      - heartbeat
      - classifyRiskTier
    ```
    Per AC2: the subagent MUST NOT be able to re-read its own persona mid-flight. `readPersona` is NOT in the current list — good. **Do NOT add `readPersona` to `generalist-dev.yaml` in this story.** If `claimStory` is missing (Story 4.1 may have already added it), confirm via direct read. The dev subagent does need `claimStory` only if the architecture later moves claim into the subagent itself — in v1 the **/crew:start** orchestrator claims, and the subagent is handed the already-claimed ref. **Decision:** leave `claimStory` in the dev permissions for now (Story 4.1 already added it; removing it is out of scope), but document in the spec that the subagent in this story does NOT call `claimStory` itself.
  - [ ] 5.2 No new permission entries are required for Story 4.2 in `generalist-dev.yaml`. If the implementation discovers a missing entry (e.g. the dev subagent needs to read the manifest it was claimed for), surface it as a follow-up story rather than expand the permission set mid-implementation.

- [ ] **Task 6 — Register all new MCP tools in `register.ts` (AC: all)**
  - [ ] 6.1 Edit `plugins/crew/mcp-server/src/tools/register.ts`. Add three `server.registerTool` calls: `mintSessionUlid`, `listClaimableTodos`, `buildPersonaSpawnPrompt`. Follow the existing pattern (mirror Story 4.1's `claimStory` / `completeStory` registration).
  - [ ] 6.2 Update tool-count assertions in the test files Story 4.1 touched: `mcp-server/tests/ask-mode-enforcement.test.ts`, `mcp-server/tests/ask-skill.test.ts`, `mcp-server/tests/get-team-snapshot.test.ts`. Bump from 15 to 18.

- [ ] **Task 7 — Unit tests for new tools (AC: 1, 2, 3, 4)**
  - [ ] 7.1 `mcp-server/src/tools/__tests__/mint-session-ulid.test.ts` — assert (a) returns a string of length 26 matching the ULID regex, (b) two consecutive calls return different ULIDs, (c) the string is monotonic over a short loop (ULID property).
  - [ ] 7.2 `mcp-server/src/tools/__tests__/list-claimable-todos.test.ts` — fixture tmpdir target repo. Cases: (a) empty `to-do/` returns `{ todos: [], inProgressCount: 0 }`; (b) three claimable refs return them alphabetically; (c) a withdrawn ref is filtered out; (d) a ref with one unmet dep returns `depsReady: false`; (e) a ref with all deps in `done/` returns `depsReady: true`; (f) malformed manifest propagates `MalformedExecutionManifestError`; (g) `inProgressCount` reflects directory contents.
  - [ ] 7.3 `mcp-server/src/tools/__tests__/build-persona-spawn-prompt.test.ts` — fixture target repo with a hired `generalist-dev` persona. Cases: (a) returns a string that begins with `# Generalist Dev — Persona` and contains the four `## Domain` / `## Mandate` / `## Out of mandate` / `## Prompt` headings in order; (b) contains the `## Knowledge` heading after `## Prompt`; (c) contains the appended `## Locked phrases` block with each phrase verbatim; (d) frontmatter is absent from the output (no `role:` / `domain:` keys appear); (e) `PersonaFileNotFoundError` propagates if the persona file is absent.
  - [ ] 7.4 All test files follow the existing pattern under `mcp-server/src/tools/__tests__/` (vitest, tmpdir fixtures via `mkdtemp`, no mock of `node:fs`, adapter mocking via the existing seam where simpler).

- [ ] **Task 8 — Integration test for `/crew:start` (AC: 4)**
  - [ ] 8.1 Add `mcp-server/src/skills/__tests__/start-skill.integration.test.ts` (new directory `skills/` under `mcp-server/src/` is acceptable; alternatively co-locate under `tools/__tests__/`). The integration test does NOT run the actual Claude Code skill-runner (no harness for that exists in v1); instead it tests the **claim-spawn-loop function** that the skill's prose maps to. Decision: extract the loop body into a pure function `runStartLoop({ targetRepoRoot, sessionUlid, taskSpawn, listTodos, claim, buildPrompt })` where `taskSpawn`, `listTodos`, `claim`, `buildPrompt` are injection points (the test seam — production callers wire to the real MCP tools and the real `Task` tool).
  - [ ] 8.2 Place the loop function at `plugins/crew/mcp-server/src/skills/start-loop.ts`. It accepts injectable dependencies for `Task`-tool invocation and the three MCP tools; the skill's prose calls a wrapper that resolves the production dependencies. (This is the test seam — it lets vitest drive the loop without a Claude Code harness.)
  - [ ] 8.3 The integration test covers AC4 branches (a)–(d) as enumerated above. The `Task`-tool spawn is captured by a fake (a function that records its call args); assertions inspect the captured argument list per AC.
  - [ ] 8.4 The loop function MUST be plain TypeScript — no `console.log`, no LLM-side state. Chat output is produced by returning a `chatLog: string[]` array from the function so tests can assert verbatim line presence.

- [ ] **Task 9 — Build artefacts and final checks (AC: all)**
  - [ ] 9.1 Run `pnpm build` at the plugin root. Commit `plugins/crew/mcp-server/dist/` per CLAUDE.md §Process notes.
  - [ ] 9.2 Run the full vitest suite. All existing tests MUST remain green. New tools' tool-count assertions in the three Story 4.1-touched test files MUST be bumped from 15 to 18.
  - [ ] 9.3 No telemetry emit. Story 4.12 owns telemetry.
  - [ ] 9.4 No `console.log` / `console.error` in any new tool or in `start-loop.ts`. Errors flow through typed-error contracts; chat output flows through the returned `chatLog`.
  - [ ] 9.5 Static-fs-guard check: the new tool files MUST NOT import `rename` / `writeFile` from `node:fs`. They are pure readers (the directory enumerator) or pure functions (the persona-prompt builder, the ULID minter). The existing `canonical-fs-guard.test.ts` enforces this; failing it blocks the build.

---

## Implementation strategy

### Why a test seam (the `start-loop.ts` extraction)

Claude Code's skill-runner is a black box from the plugin's perspective: it reads `SKILL.md`, presents the prose to the LLM, and the LLM drives the MCP tools. There is no v1 harness for running a skill end-to-end programmatically (per `core-architectural-decisions.md` §Deferred — "Claude-Code-stub harness for full agent behaviour"). To deliver AC4's deterministic integration test, the skill's loop body MUST be extractable to a function that vitest can drive with stubbed dependencies. Hence `runStartLoop` in `start-loop.ts`. The SKILL.md prose is intentionally thin — it describes what to call in what order, and the loop function (invoked via tool composition) does the work.

### Move-then-spawn sequence

`claimStory` is called BEFORE the `Task` spawn (not after). Rationale:
- If the claim throws, the spawn never happens. Wasted spawns are expensive (clean-context overhead).
- The spawn receives the already-claimed ref in its initial context — the subagent does not race against a sibling spawn for the same ref.
- Story 4.1's `claimStory` atomic move is the coordination primitive; the spawn is a consequence of the successful move, not a competitor for it.

### Persona-spawn-prompt assembly: where the team/ copy wins

The persona file is read from `<targetRepoRoot>/team/generalist-dev/PERSONA.md`, NOT from the plugin's catalogue at `plugins/crew/catalogue/generalist-dev.md`. Rationale (per Architecture §Persona injection and Story 2.3): the team/ copy is the operator-owned, hire-time-stamped, knowledge-appendable persona. The catalogue is the shipped template. Once an operator runs `/crew:hire`, the team/ copy diverges from the catalogue (the Knowledge section accumulates over time via Story 6's `appendPersonaKnowledge`). The spawn MUST read the team/ copy so accumulated knowledge is in scope. If the team/ copy is absent, the spawn fails — `/crew:hire` is a prerequisite. This is the same precondition `/crew:plan` and every other agent-spawning skill imposes.

### Chat-surface error wording

The skill prints typed errors as `<ErrorName>: <message>` on one line per error, mirroring the precedent set by `plan/SKILL.md` (which surfaces `NoAdapterMatchedError` / `MalformedExecutionManifestError` verbatim). No JSON wrapping, no stack traces, no decorative prefixes. The operator reads the error class name (which carries the failure semantics) and the message (which carries the offending ref / file path).

### "queue drained" exit code semantics

The skill exits normally — it does not throw, it does not return an error. The verbatim line is the operator's signal. Future Epic 5 work (orchestration session, `/<plugin>:watch`) MAY re-invoke `/crew:start` on a schedule; the queue-drained line is benign and idempotent.

### Why a ULID-minting MCP tool instead of inline `Math.random`

LLM-driven skills cannot reliably generate cryptographically-shaped strings. Story 3.4's native adapter uses ULIDs for story refs and ships the `ulid` package in the MCP-server deps to keep ULID generation in TypeScript. Story 4.2 mints session ULIDs the same way: through a dedicated MCP tool the skill calls. This eliminates the "LLM guessed a 26-char alphanumeric string" failure mode.

---

## Architecture compliance

- **`Task` tool is the only canonical subagent-spawn primitive.** Architecture §Per-story subagent pins this — "Spawn a Claude Code subagent via the Task tool with a clean context per story." No direct shell-out, no in-process call. `plan/SKILL.md` Step 4 sets the precedent for plugin-internal `Task` spawning.
- **Persona injection at spawn time, single read.** Architecture §Persona injection: "Dev/reviewer skill assembles subagent's system prompt = catalogue prompt body + persona knowledge section, read from the persona file at spawn time. One read at spawn; subagent doesn't re-read mid-flight." Implementation pins this via `buildPersonaSpawnPrompt` + dev-subagent permissions that exclude `readPersona`.
- **Filesystem is the only coordination surface (NFR19).** The `/start` loop coordinates exclusively through `.crew/state/<state>/<ref>.yaml` rename atomicity. No in-memory queue, no lockfile, no daemon. Two concurrent `/crew:start` invocations against the same backlog race exclusively at the `claimStory` layer — Story 4.1's chaos test pins that invariant.
- **MCP tool naming.** Three new tools follow camelCase verb-noun: `mintSessionUlid`, `listClaimableTodos`, `buildPersonaSpawnPrompt`. Flat namespace, no dotted prefixes (per `implementation-patterns-consistency-rules.md` § 4).
- **No new MCP server, no new package.** All work lands inside the existing `plugins/crew/mcp-server/` package. No new top-level skill directory beyond `plugins/crew/skills/start/`.
- **Skill front-matter is shipped, not generated.** The `name` / `description` / `allowed_tools` are part of the source tree and travel with `/plugin install` per CLAUDE.md §Process notes. Tool-allowlist edits MUST be committed.
- **No `gh` invocation from `/start`.** Story 4.4 owns `gh`. The skill itself never touches `gh`; the dev subagent does, via its `pr-create` allowlist.
- **No source-side writes.** The skill is read-only against source stories. The dev subagent's `readSourceStory` is the only path that touches them, and only as a reader.
- **`docs/standards.md` is untouched.** Review-layer concern (Story 4.6); not relevant here.

## Library / framework requirements

- **No new top-level dependencies.** `ulid` is already present (Story 3.4); confirm in `plugins/crew/mcp-server/package.json`. If absent, add pinned to latest stable via `pnpm add ulid` in the worktree (per Memory: "default to latest stable; pnpm resolves, then pin").
- **`yaml` for SKILL.md front-matter** is a non-issue — Claude Code parses skill front-matter itself; the plugin doesn't.
- **TypeScript conventions** per § 6 of `implementation-patterns-consistency-rules.md`: kebab-case filenames (`mint-session-ulid.ts`, `list-claimable-todos.ts`, `build-persona-spawn-prompt.ts`, `start-loop.ts`), named exports only, no `any`, typed errors extending `DomainError`.

## File structure requirements

New files:
- `plugins/crew/skills/start/SKILL.md`
- `plugins/crew/mcp-server/src/tools/mint-session-ulid.ts`
- `plugins/crew/mcp-server/src/tools/list-claimable-todos.ts`
- `plugins/crew/mcp-server/src/tools/build-persona-spawn-prompt.ts`
- `plugins/crew/mcp-server/src/skills/start-loop.ts`
- `plugins/crew/mcp-server/src/tools/__tests__/mint-session-ulid.test.ts`
- `plugins/crew/mcp-server/src/tools/__tests__/list-claimable-todos.test.ts`
- `plugins/crew/mcp-server/src/tools/__tests__/build-persona-spawn-prompt.test.ts`
- `plugins/crew/mcp-server/src/skills/__tests__/start-skill.integration.test.ts`

Modified files (UPDATE, not NEW — read fully before editing):
- `plugins/crew/mcp-server/src/tools/register.ts` — register three new tools. No edits to existing registrations.
- `plugins/crew/mcp-server/tests/ask-mode-enforcement.test.ts` — tool-count assertion 15 → 18.
- `plugins/crew/mcp-server/tests/ask-skill.test.ts` — tool-count assertion 15 → 18.
- `plugins/crew/mcp-server/tests/get-team-snapshot.test.ts` — tool-count assertion 15 → 18.

Files explicitly NOT modified:
- `plugins/crew/permissions/generalist-dev.yaml` — see Task 5; no permission entries change in this story.
- `plugins/crew/catalogue/generalist-dev.md` — the catalogue is the shipped template; if the persona body needs minor extension for Story 4.2's invariants (see § Behavioural contract — `generalist-dev` persona prompt invariants), that is a follow-up story to keep Story 4.2's diff narrow. The team/ copy on a freshly-hired repo already encodes the v1 mandate.
- `plugins/crew/mcp-server/src/state/manifest-state-machine.ts` — `isClaimable` is imported, not modified.

Build output (regenerate, do not hand-edit):
- `plugins/crew/mcp-server/dist/` — committed per CLAUDE.md §Process notes.

## Testing requirements

- **vitest** (project precedent). Co-locate tool tests with the production module under `__tests__/`; integration test under `mcp-server/src/skills/__tests__/`.
- **Tmpdir fixtures.** No mutation of repo state. Use `node:fs/promises mkdtemp` + `afterEach` cleanup. Mirror the pattern from `claim-story.test.ts` / `complete-story.test.ts`.
- **No mocking of `node:fs`.** Real renames against tmpdirs; real reads against fixture target repos.
- **`Task`-tool stubbing in the integration test.** The production `Task` invocation cannot be exercised by vitest (no Claude Code in the test process). The seam in `start-loop.ts` accepts a `taskSpawn` function injection; tests pass a fake that records calls. AC4(a) asserts the recorded calls.
- **Coverage target.** Every branch in AC4 has a named test. The persona-assembly tool covers happy + absent-persona paths.
- **Chat-output verbatim assertions.** AC3's queue-drained line and AC5's verbatim string anchors are asserted with `expect(chatLog).toContain("queue drained — to-do/ and in-progress/ are both empty. Stop here, or run /crew:plan to add work.")` — no regex, exact-string match. Drift will break the test, which is the desired behaviour.
- **SKILL.md content-structure check (AC5).** Add `mcp-server/src/skills/__tests__/start-skill-content.test.ts` that reads the on-disk `plugins/crew/skills/start/SKILL.md`, splits its YAML front-matter, and asserts:
  - `name === "crew:start"` (exact),
  - `allowed_tools` superset of `["Task", "buildPersonaSpawnPrompt", "claimStory", "getStatus"]`,
  - body contains the verbatim AC5(iii) string,
  - body contains the verbatim AC3 queue-drained line,
  - body's `# Failure modes` section names all four error classes.
  This test is the structural anchor required by the spec brief — LLM outputs are non-deterministic; a deterministic file-content check is mandatory.

## Previous story intelligence

- **Story 4.1 (just landed):** Shipped `claimStory` and `completeStory`. The spec at `_bmad-output/implementation-artifacts/4-1-claim-story-dependency-check-and-complete-story-mcp-tools.md` § Architecture compliance explicitly names Story 4.2 as the next consumer: "`isClaimable` is NOT invoked by `claimStory` in this story… Story 4.2's `/start` skill is the layer that picks the next ready story (and that layer SHOULD use `isClaimable` to filter the queue)." Story 4.2 owns the filter. Story 4.1's `claimStory(opts)` accepts an optional `role` parameter defaulting to `"orchestrator"`; the `/start` skill passes `"orchestrator"` (Task 1.3.6c).
- **Story 3.7:** Shipped `detectInProgressHandEdit`. Story 4.1 wired it into `claimStory` / `completeStory`. Story 4.2's `/start` skill does NOT call the guard directly — it goes through `claimStory`, which guards on entry per Story 4.1 AC5. The hand-edit refusal surfaces verbatim via `claimStory`'s thrown `InProgressHandEditError`.
- **Story 3.6:** Shipped `isClaimable` predicate. Story 4.2 uses it to filter the candidate set in `listClaimableTodos` BEFORE calling `claimStory`. A withdrawn ref MUST NOT reach `claimStory` — Story 4.1's TSDoc names this layering rule.
- **Story 3.4:** Shipped `/crew:plan` skill at `plugins/crew/skills/plan/SKILL.md` — the precedent for the `Task`-tool spawn pattern in a skill, the `<initial-context>` block shape, the `allowed_tools` front-matter, the failure-modes section structure. Story 4.2's SKILL.md mirrors this pattern.
- **Story 3.2:** `parseExecutionManifest` is the canonical reader. `listClaimableTodos` routes through it. `MalformedExecutionManifestError` propagation contract is unchanged.
- **Story 2.3:** Shipped `readPersona` and the persona-file parser. The `## Knowledge` section is verified by the parser to appear after `## Prompt`. Story 4.2's `buildPersonaSpawnPrompt` relies on the parsed `sections` map; if `parsePersonaFile` accepts the file, the assembler can trust the section order.
- **Story 2.4 / 2.5:** Shipped `/crew:hire` and `instantiatePersona`. A successful `/crew:hire` (or `/crew:skip-hiring`) is a prerequisite for `/crew:start`; without it the team/ copy is absent and `readPersona` throws. Document in SKILL.md `# Prerequisites`.
- **Story 1.7 / 1.7a (retro lesson):** Both shipped under 4/4 green ACs but their user-surface contract (slash command + install path) was never exercised live; eight bugs surfaced when Jack tried the install. Story 4.2 is the next major user-surface story in Epic 4. The pre-PR smoke gate (Story 1.8) will require evidence — either `automated_e2e_verified` (the AC4 integration test counts via the test-seam path) OR `user_surface_verified` (operator pastes verbatim Claude Code output of `/crew:start` against a fixture target repo). Both routes are open; the ship-story orchestrator picks whichever the operator chooses.
- **Lesson from canonical-fs guard (Story 1.6 retro):** the static test forbids non-whitelisted files from importing write-shaped `node:fs` APIs. The new tool files in Story 4.2 are pure readers or pure functions; they MUST NOT `import { rename, writeFile } from "node:fs/promises"`. If the implementation finds itself reaching for a write API, route through `writeManagedFile` instead.
- **Lesson from Epic 3 retro (2026-05-21):** "Don't ship user-surface ACs whose chat surface depends on a deferred caller." Story 4.2 explicitly ensures AC1's chat surface is runnable today — every dependency is shipped (Story 4.1's `claimStory`, Story 2.3's `readPersona`, Story 1.7+'s workspace resolver, Claude Code's `Task` tool which has been available since Story 3.4's `/crew:plan` proved the pattern). No paper promises.

## References

- Epic source: `_bmad-output/planning-artifacts/epics/epic-4-dev-review-loop-the-engineering-heart.md` § Story 4.2 (lines 38–54).
- PRD: `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md` FR15 (line 28), FR22 (line 35), FR24 (line 40), FR25 (line 41).
- Predecessor spec (claim/complete primitives): `_bmad-output/implementation-artifacts/4-1-claim-story-dependency-check-and-complete-story-mcp-tools.md`.
- Predecessor spec (Task-spawn pattern): `_bmad-output/implementation-artifacts/3-4-native-adapter-planner-subagent-and-plan-skill.md` § Behavioural contract.
- Architecture: `_bmad-output/planning-artifacts/architecture/core-architectural-decisions.md` § Agent invocation model (lines 77–82) — per-story subagent + persona injection + verdict marker.
- Architecture: `_bmad-output/planning-artifacts/architecture/project-structure-boundaries.md` (skills/ layout lines 29–40; mcp-server/src/tools/ inventory lines 62–87).
- Architecture: `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` (MCP tool naming § 4, TypeScript conventions § 6, locked phrases § 7).
- User-surface AC convention: `plugins/crew/docs/user-surface-acs.md`.
- Source: `plugins/crew/skills/plan/SKILL.md` (Task-spawn precedent).
- Source: `plugins/crew/skills/scan/SKILL.md` (verbatim-output precedent).
- Source: `plugins/crew/mcp-server/src/tools/claim-story.ts` (Story 4.1).
- Source: `plugins/crew/mcp-server/src/tools/read-persona.ts` (Story 2.3).
- Source: `plugins/crew/mcp-server/src/lib/persona-file.ts` (parser; section extraction).
- Source: `plugins/crew/mcp-server/src/state/manifest-state-machine.ts` (`isClaimable` line 334).
- Source: `plugins/crew/catalogue/generalist-dev.md` (catalogue role definition with locked phrases).
- Source: `plugins/crew/permissions/generalist-dev.yaml` (current allowlist — do not modify per Task 5).

### Project Structure Notes

- New `plugins/crew/skills/start/` directory follows the precedent of `plugins/crew/skills/plan/`, `plugins/crew/skills/scan/`, etc. — one directory per skill, with `SKILL.md` inside.
- New `plugins/crew/mcp-server/src/skills/` directory introduces the "skill loop body" location. Alternative placement under `tools/` was considered and rejected — these are loop-bodies, not MCP tools (they orchestrate tools rather than being one). Mirrors the precedent of `state/` (state-machine code) and `lib/` (cross-cutting utilities). The path is enumerated only here; if the architecture review prefers a different home (e.g. `lib/skill-loops/`), the dev agent SHOULD surface a Q to the operator BEFORE implementing rather than picking unilaterally.
- No changes to the plugin's top-level layout, `plugin.json` manifest, or marketplace metadata.
- Plugin semver: Story 4.2 is an additive change (new skill, new tools, no breaking-format edits). A minor bump on `plugins/crew/.claude-plugin/plugin.json` is appropriate but NOT required if Story 4.1 already bumped this cycle's version — confirm at implementation time.

## Dev Agent Record

### Agent Model Used

_Filled by the dev agent at implementation time._

### Debug Log References

_Filled by the dev agent at implementation time._

### Completion Notes List

_Filled by the dev agent at implementation time._

### File List

_Filled by the dev agent at implementation time._

### Change Log

_Filled by the dev agent at implementation time._
