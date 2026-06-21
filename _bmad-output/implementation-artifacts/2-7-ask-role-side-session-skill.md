# Story 2.7: `/ask <role>` side-session skill

Status: ready-for-dev

<!-- Spec-only output. The orchestrator owns sprint-status.yaml transitions; this file does NOT modify it. -->

## Story

As a **plugin operator (Maya / Jack mid-dev-loop)**,
I want **a `/crew:ask <role> "<question>"` slash command that opens a side-session against an already-hired role with the role's persona prompt assembled, the user's question delivered, and the response printed back — non-mutating by contract: the role MAY read PR comments (via `gh pr view`), story manifests, persona files, and `docs/standards.md` to answer, but ALL canonical-state mutations (story manifest, registry, telemetry, persona files) are refused at the allowlist layer**,
so that **I can lean on a hired role for one-off translation / clarification (e.g. "planner, translate this reviewer verdict comment") without breaking the dev loop or mutating canonical state (FR76, FR109).**

### What this story is, in one sentence

Ship `plugins/crew/skills/ask/SKILL.md` (new slash command with `allowed_tools: [Read, Task]`) that (a) parses the operator's `<role>` and `<question>` arguments, (b) verifies the role is hired by calling `readPersona({ targetRepoRoot, role })`, (c) assembles the side-session system prompt from the persona's `## Prompt` section verbatim followed by a load-bearing `<ask-mode>` block that pins the read-only contract for the subagent, (d) spawns a Claude Code `Task` subagent with the assembled prompt and the operator's question, and (e) prints the subagent's response back verbatim — paired with a new `permissions/ask-mode.yaml` overlay (or equivalent enforcement; see Task 4) such that the MCP server refuses any canonical-state-mutating tool call from the side-session at the `_meta.role` allowlist boundary (Story 1.4 contract).

### What this story fixes (and why it needs its own story)

Story 2.4's `/crew:hire` spawns the hiring-manager subagent. Story 2.6's `/crew:team` reads team state without an LLM. Today there is NO operator-facing surface to **interrogate a hired role mid-dev-loop without polluting the main session's context or mutating canonical state**. An operator who wants to ask "planner, what does this reviewer comment mean?" must:

- Quote-and-paste the comment into the main session and hope the on-loop agent translates it (pollutes context, no persona prompt assembled).
- Read the persona file by hand and ad-hoc the question (no LLM in the loop, no answer).
- Open a fresh Claude Code session and recreate the persona by copy-paste (no enforcement that the side-session is non-mutating).

That breaks three contracts:

- **FR76** — "The planning agent can be consulted in a separate session about an open reviewer verdict comment without breaking the dev loop (`ask a non-dev agent to translate` affordance)."
- **FR109** — "The user can open a side-session with a specific hired role via slash-command (`/<plugin>:ask <role>`) without mutating dev-loop state — used to ask the planner to translate a reviewer comment, the security specialist to explain a finding, etc."
- The Story 1.4 permission-enforcement contract — `tools_allow` allowlists are the canonical refuse-boundary for canonical-state writes; a side-session against a hired role must run through that boundary, not around it.

This story closes all three. It is also the v1 reference implementation for **the "read-only LLM-in-loop side-session" pattern** that Epic 6+ retros and Epic 3+ debugger consultations will reuse — pinning the read-only contract enforcement HERE (one skill, one ask-mode allowlist overlay, one prompt-assembly idiom) means future side-session skills don't have to reinvent the refuse-boundary.

Sibling Story 2.6 (`/crew:team`) is the deterministic counterpart — same fixture data (persona files), opposite end of the LLM-in-loop axis. Story 2.7 closes the same `team/` source-of-truth read for LLM-driven consultation.

### What this story does NOT

- (a) Touch `_bmad-output/implementation-artifacts/sprint-status.yaml` — the orchestrator owns status transitions.
- (b) Modify Story 1.4's MCP server permission-enforcement code (`server.ts` `_meta.role` handler, `errors.ts` `PermissionDeniedError`). The story REUSES the existing boundary; the enforcement is a NEW permission spec, not new enforcement logic.
- (c) Mutate or extend `permissions/<catalogue-role>.yaml` files. The per-catalogue-role specs (Story 2.2) are the role's full mandate allowlists; `/crew:ask` runs the role in a **restricted** mode where only read-shaped tools are permitted. Implementation may be either (i) a new `permissions/ask-mode.yaml` overlay loaded ad-hoc by the skill body when spawning the Task, OR (ii) a new well-known role id `ask:<role>` that the permissions loader resolves to an intersection of `permissions/<role>.yaml` and a fixed read-only tool set. Author's discretion in Task 4 — both satisfy the AC; the overlay form is recommended for v1 simplicity.
- (d) Implement persona-knowledge appends (`appendPersonaKnowledge`). The side-session is read-only; if the role surfaces an insight worth retaining, the operator captures it manually in v1 (NFR25 — persona Knowledge is plain Markdown).
- (e) Implement a session-recording / transcript feature. The skill prints the subagent's response and exits. No transcript persisted.
- (f) Implement multi-turn conversation continuity. `/crew:ask` is one-shot: one question, one response. Follow-ups are a fresh `/crew:ask` invocation.
- (g) Implement role chaining / hand-off from the asked role to a different role. The asked role answers in-place; locked-phrase yields (`This sits in <role>'s domain — handing off.`) are surfaced as plain output text but do NOT trigger an automatic re-`/crew:ask` against the yielded-to role.
- (h) Add a new MCP tool. The skill body calls existing MCP tools (`readPersona`; the side-session subagent uses the per-role allowlisted read-shaped tools). The composition lives in skill prose + the subagent's allowlist, not in a new server-side tool.
- (i) Add a new telemetry event type. The closed v1 telemetry set (`agent.invoke`, `telemetry.invalid`) is unchanged. The side-session's subagent invocation emits an `agent.invoke` event per existing convention; the skill body itself does not emit telemetry (operator-facing reads do not, per NFR21).
- (j) Modify `plugins/crew/mcp-server/src/schemas/{catalogue,persona,role-permissions,status-report,repo-signals,plugin-manifest,telemetry-events,workspace-config,standards-doc,team-snapshot}.ts`. If a NEW schema is required for the ask-mode overlay shape, it is added under `mcp-server/src/schemas/ask-mode.ts`; otherwise the overlay reuses `RolePermissionsSchema` from Story 2.2.
- (k) Modify `plugins/crew/mcp-server/src/tools/*.ts`. This story spawns the existing tools through a different `_meta.role` value; no tool's handler changes.
- (l) Modify `plugins/crew/mcp-server/src/lib/{logger,managed-fs,markdown-frontmatter,persona-file,plugin-root,plugin-version,workspace-resolver,gh,repo-signal-detectors,team-stats}.ts`. The permissions loader may grow one new helper if the overlay form is chosen (`lib/ask-mode-overlay.ts`); existing libs are unchanged.
- (m) Modify any catalogue file (`plugins/crew/catalogue/*.md`). The catalogue is unchanged; `/crew:ask` reads the persona, which was copied from the catalogue at hire time.
- (n) Modify `plugins/crew/skills/{status,hire,skip-hiring,team}/SKILL.md`. The new skill is a sibling directory `skills/ask/SKILL.md`.
- (o) Modify `plugins/crew/docs/README-install.md`. `/crew:ask` is post-hire and post-dev-loop-active; it is not part of v1's six-checkpoint install. Epic 7 Story 7.2 may integrate it into the walkthrough; that change is not in this story's scope.
- (p) Resolve the workspace adapter (`resolveWorkspace` / `validateActiveAdapter`). Unlike `/crew:status`, `/crew:ask` does NOT depend on a planning adapter — it depends on `team/<role>/PERSONA.md` (Story 2.3 contract). The skill takes `targetRepoRoot` directly.
- (q) Handle the un-hired-role case by spawning the hiring manager or auto-running `/crew:skip-hiring`. If the role is not hired, the skill prints a deterministic error line naming the role and cross-references `/crew:hire` and `/crew:skip-hiring`; operator action follows.
- (r) Handle the missing-`<question>` case by prompting the operator for input. The skill is one-shot from the slash-command surface; if `<question>` is empty after argument parsing, the skill prints a usage line and exits.
- (s) Surface persona-file malformation as a hard server-side error. `PersonaFileMalformedError` from `readPersona` is caught by the skill body and surfaced as a plain-text diagnostic naming the persona path and the Zod issue (mirroring Story 2.6's per-role error stanza pattern).
- (t) Modify the dispatcher pattern. Tool registration in `tools/register.ts` is unchanged — `/crew:ask` registers no new MCP tools.
- (u) Touch the dev-loop, retro, orchestrator, or any non-side-session flow.

---

## Acceptance Criteria

> **Verbatim mapping.** ACs 1–4 below map to the four epic ACs in `_bmad-output/planning-artifacts/epics/epic-2-team-formation-hiring-personas-and-team-observability.md` § Story 2.7. AC5 is a story-scoped self-consistency addition that hard-pins the skill file shape and the ask-mode allowlist contract (Story 1.8 lesson — user-surface contracts and refuse-boundary contracts are pinned, not advisory). AC6 hard-pins the un-hired-role error surface so the operator-facing diagnostic is deterministic.
>
> **User-surface judgement.** AC1 names the operator-typed slash command `/crew:ask <role> "<question>"` AND the verbatim surface — `user-surface` per rubric (i) and (iv). AC2 pins the refuse-boundary contract — operator never types or observes the internal `tools_allow` allowlist, the `_meta.role` field, or the `PermissionDeniedError` message format directly (the error surfaces THROUGH the side-session subagent's response stream, which is a different observation). NOT `user-surface`. AC3 names the side-session's READ affordance (PR comments, story manifests, persona files, `docs/standards.md`) — these are tool-layer effects the operator does not type, though the resulting response IS observed. The READ ENABLEMENT itself is internal allowlist plumbing; tagged NOT user-surface. AC4 is the vitest integration contract; the operator never types `pnpm --dir plugins/crew test`. NOT `user-surface`. AC5 names `plugins/crew/skills/ask/SKILL.md` only as a self-consistency assertion target. NOT `user-surface`. AC6 names the `/crew:ask` slash command literal AND the verbatim error text the operator reads on screen when the role is not hired — `user-surface` per rubric (i) and (iv). The pre-PR smoke gate (`plugins/crew/docs/user-surface-acs.md`) will require operator-paste-output or an automated-e2e verification event covering AC1 and AC6.

**AC1 (user-surface):**
**Given** a target repo with at least one hired role (per Story 2.3 / 2.4 / 2.5 — a `<target-repo>/team/<role>/PERSONA.md` parseable via `parsePersonaFile`),
**When** the operator runs `/crew:ask <role> "<question>"` from inside Claude Code with that target repo loaded as the workspace (e.g. `/crew:ask planner "explain this reviewer verdict comment: ..."`),
**Then** the skill (a) parses `<role>` and `<question>` from the invocation arguments, (b) calls `readPersona({ targetRepoRoot, role })` exactly once to confirm the role is hired and to fetch the persona's `## Prompt` body, (c) spawns a Claude Code `Task` subagent whose system prompt is the persona's `## Prompt` body verbatim followed by the load-bearing `<ask-mode>` block (see below) AND whose initial user message is the operator's `<question>` verbatim, (d) prints the subagent's response back verbatim to the operator without post-processing.

The `<ask-mode>` block appended to the system prompt is the literal text:

```
<ask-mode>
You are running in /crew:ask mode. This is a non-mutating side-session.

You MAY read:
  - PR comments and PR metadata via `gh pr view` and `gh api` read-only paths.
  - Story manifests at <target-repo>/_bmad-output/planning-artifacts/stories/*.md (or the active adapter's equivalent).
  - Persona files at <target-repo>/team/<role>/PERSONA.md.
  - The standards doc at <target-repo>/docs/standards.md (or the configured standards path).

You MUST NOT mutate canonical state. The MCP server will refuse any tool call
that writes to story manifests, registry, telemetry, or persona files. If you
need to recommend a mutation, surface it as plain text in your reply — the
operator will decide whether to run the corresponding skill (e.g. `/crew:hire`
to hire a missing role, the dev-loop to record a verdict, etc.).

Your reply is the operator's one-shot answer to: <question>
</ask-mode>
```

The skill prints the subagent's final reply verbatim — no Markdown beautification, no header insertion, no "let me explain" prefix. The skill body's `allowed_tools` frontmatter is exactly `[Read, Task]`. _(FR76, FR109)_

<!-- user-surface: AC1 names the slash command literal `/crew:ask` (rubric i), the operator-typed argument grammar `<role> "<question>"` (rubric ii — the operator types the role token and quoted question verbatim into the slash-command picker), and the printed subagent reply the operator reads on screen (rubric iv). The `<ask-mode>` block text is part of the AC because it is the verbatim contract the dev agent must paste into the skill body's prompt-assembly step; it is NOT itself operator-typed, but it is part of the user-facing surface insofar as the subagent's response reflects it. -->

**AC2:**
**Given** the side-session is running (a `Task` subagent spawned by the skill body),
**When** the subagent attempts to call any canonical-state-mutating MCP tool — `instantiatePersona`, `claimStory`, `recordVerdict`, `appendPersonaKnowledge`, `applyRetroProposal`, `logTelemetryEvent` (if exposed), or any future mutator under `mcp-server/src/tools/` whose name starts with a mutation verb per implementation-patterns-consistency-rules §4 (`claim`, `complete`, `record`, `append`, `apply`, `instantiate`, `unhire`, etc.) — **OR** any `gh` subcommand that writes (`pr-create`, `pr-comment`, `pr-review`, `pr-close`, `pr-merge`),
**Then** the call is refused at the existing Story 1.4 permission boundary (`server.ts` `_meta.role` handler returns `PermissionDeniedError`) because the subagent's `_meta.role` resolves to the ask-mode allowlist whose `tools_allow` contains ONLY read-shaped tools (`readPersona`, `readCatalogue`, `lookupRoleByDomain`, `readRepoSignals`, `readCustomRole`, `getStatus`, `getTeamSnapshot`, `lookupStandards` if shipped, `heartbeat`) AND whose `gh_allow` contains ONLY `pr-view` (no `pr-comment`, no `pr-create`, no `pr-review`, no `pr-close`, no `pr-merge`, no `api` write paths). The subagent observes the refusal as a tool error in its own message stream and is expected (per the `<ask-mode>` prompt block) to surface it as plain-text in the final reply rather than retry. _(FR109)_

**AC3:**
**Given** the side-session is running AND the operator's question requires the role to read external context to answer,
**When** the subagent calls `gh pr view <pr-number>` (to fetch a reviewer comment body), reads a story manifest under `<target-repo>/_bmad-output/planning-artifacts/stories/*.md` (or the adapter's equivalent), reads `<target-repo>/team/<role>/PERSONA.md`, or reads `<target-repo>/docs/standards.md` via the `Read` tool or `lookupStandards`,
**Then** the read is **permitted** — the ask-mode allowlist explicitly enables these reads. The non-mutating contract forbids canonical-state **writes**, not reads. This explicitly enables the FR76 translate-a-reviewer-comment affordance. The skill body's `allowed_tools: [Read, Task]` does NOT include `Bash`; the subagent reaches `gh` via the MCP server's `gh` execa wrapper (Story 1.4 contract), which routes through the `gh_allow` allowlist — `pr-view` is the only allowed subcommand. _(FR76, FR109)_

**AC4 (integration):**
**Given** the new `plugins/crew/skills/ask/SKILL.md`, the ask-mode allowlist (file path TBD by Task 4 — see Task 4.2), and the integration harness at `plugins/crew/mcp-server/tests/ask-skill.test.ts`,
**When** `pnpm --dir plugins/crew test` runs,
**Then** vitest asserts, against four temp-dir fixture target repos:
- **(a) Happy path — planner translates a PR comment** (`<TMP_A>`): pre-seeded with the five default-roster personas via `instantiatePersona` (Story 2.3). Stub the `Task`-spawn boundary (the skill body's `Task` call is replaced in the test harness by a direct invocation of the equivalent prompt-assembly logic; alternative: assert on the prompt-string the skill would have passed to `Task` rather than actually spawning a subagent — author's discretion in Task 7). Drive `/crew:ask planner "explain this verdict comment"` against the fixture. Assert (i) `readPersona({ targetRepoRoot: TMP_A, role: "planner" })` was called exactly once, (ii) NO canonical-state mutation occurred on the fixture (no new files under `<TMP_A>/team/`, no telemetry events emitted by the skill body itself, no story manifests written), (iii) the assembled system prompt contains the planner persona's `## Prompt` body verbatim AND the `<ask-mode>` block verbatim, (iv) the assembled user message equals the operator's `<question>` verbatim (no rewriting, no prefix, no quoting).
- **(b) Read-permitted assertion via `gh pr view`** (`<TMP_B>`): pre-seeded with the default roster. Spy on the MCP server's `gh` execa wrapper (via `vi.spyOn(ghModule, "runGh")` or the equivalent existing seam from Story 1.4). Invoke the side-session's subagent with a question that requires reading a PR comment. Assert the `gh pr view` call REACHES the wrapper (i.e. is NOT refused at the allowlist boundary) and that the wrapper's invocation passes the ask-mode role through `_meta.role`. The operator-facing PR is a fixture-mocked `gh` response — no real GitHub call. _(FR76)_
- **(c) Write-refused assertion** (`<TMP_C>`): pre-seeded with the default roster. Drive a side-session in which the subagent attempts (via the test's direct MCP-call simulation) to call `instantiatePersona`, `appendPersonaKnowledge` (if exposed; otherwise any other mutator), `recordVerdict` (if exposed; otherwise simulate via a synthetic mutating tool registered for the test), and `gh pr comment` through the wrapper. Assert each call returns a `PermissionDeniedError` shape (per Story 1.4 — `{ isError: true, content: [{ type: "text", text: <message> }] }`) AND that the error message names the ask-mode role AND the attempted tool AND references the operator's `<ask-mode>` prompt block (i.e. the error is comprehensible to the subagent as "you're in ask mode, this tool is refused"). _(FR109)_
- **(d) Un-hired-role error surface** (`<TMP_D>`): pre-seeded with EMPTY `<TMP_D>/team/` (no personas hired). Drive `/crew:ask security-specialist "..."`. Assert the skill body's response is the deterministic error block from AC6 (verbatim) and that NO subagent is spawned (the `Task` boundary is not invoked).
- **(e) Tool registration unchanged:** assert the MCP `ListTools` response is byte-identical to Story 2.6's eight-tool list (`getStatus`, `readCatalogue`, `instantiatePersona`, `readPersona`, `lookupRoleByDomain`, `readRepoSignals`, `readCustomRole`, `getTeamSnapshot`). `/crew:ask` registers no new MCP tools.
- **(f) Ask-mode allowlist shape assertion:** load the ask-mode allowlist (file or constant per Task 4.2). Assert (i) it parses against the existing `RolePermissionsSchema` from Story 2.2 (or a new compatible `AskModeSchema` if Task 4 chose the role-id form), (ii) `tools_allow` contains ONLY read-shaped tool names (every entry starts with `get`, `read`, `lookup`, or is `heartbeat`), (iii) `gh_allow` is `["pr-view"]` exactly, (iv) `tools_allow` does NOT contain any of: `instantiatePersona`, `appendPersonaKnowledge`, `claimStory`, `recordVerdict`, `applyRetroProposal`, `unhireRole`.

Any failure surfaces a diagnostic naming the failing AC, the fixture, the attempted tool / subcommand, and the expected vs actual error message. _(FR76, FR109)_

**AC5:**
**Given** the new `plugins/crew/skills/ask/SKILL.md`,
**When** the file is read after Task 6,
**Then** (i) the YAML frontmatter parses and `name === "crew:ask"`, (ii) `allowed_tools` is exactly `["Read", "Task"]` (NO `Bash`, NO `Edit` — the skill reads the persona and spawns the subagent; the subagent reaches `gh` via the MCP server's wrapper, not via the skill body's `Bash`), (iii) the body contains the section headers `# What this skill does`, `# Prerequisites`, `# Steps`, `# Failure modes` in that exact order per `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` §8, (iv) the `# Steps` section names `readPersona`, names the `<ask-mode>` block verbatim (the literal text from AC1), and instructs the body to pass the persona's `## Prompt` section followed by the `<ask-mode>` block as the subagent's system prompt, (v) the body references `/crew:ask` at least once and cross-links to `/crew:hire` and `/crew:skip-hiring` (so an operator who runs `/crew:ask` against an un-hired team knows where to go), (vi) the body explicitly states the non-mutating contract in plain language (FR109's load-bearing promise) AND explicitly enumerates the four permitted reads (PR comments, story manifests, persona files, standards doc) per AC3. _(self-consistency; Story 1.8 lesson — skill-shape contracts are tested, not advisory)_

**AC6 (user-surface):**
**Given** a target repo with NO hired role matching the requested role id (either `<target-repo>/team/` is absent / empty, OR no subdirectory matches the requested `<role>`),
**When** the operator runs `/crew:ask <role> "<question>"`,
**Then** the skill prints exactly this text block and exits without spawning any subagent:

```
crew:ask — role "<role>" is not hired in this repo.

Run /crew:hire to hire a project-shaped team (interactive), or /crew:skip-hiring to hire the default roster (planner, generalist-dev, generalist-reviewer, retro-analyst, orchestrator).

If you meant a different role id, run /crew:team to see your current roster.
```

Where `<role>` is the literal token the operator passed. _(FR109)_

<!-- user-surface: AC6 names the `/crew:ask` slash command literal (rubric i), the cross-referenced `/crew:hire`, `/crew:skip-hiring`, and `/crew:team` slash commands in the error text (rubric i), and the entire error block the operator reads on screen verbatim (rubric iv). The dev agent must produce this exact text — paraphrasing breaks the pre-PR gate's operator-paste verification. -->

---

## Tasks / Subtasks

- [ ] **Task 1 — Decide ask-mode allowlist form (AC: 2, 4, 5)**
  - [ ] 1.1 Read `plugins/crew/permissions/hiring-manager.yaml`, `permissions/planner.yaml`, `permissions/generalist-reviewer.yaml` and `plugins/crew/mcp-server/src/schemas/role-permissions.ts` (Story 2.2). Choose between (a) NEW FILE `plugins/crew/permissions/ask-mode.yaml` declaring a `role: ask-mode` whose `tools_allow` is the read-only set from AC2 and whose `gh_allow` is `["pr-view"]`, used uniformly across all `/crew:ask` invocations regardless of which role is asked; OR (b) NEW FILE `plugins/crew/permissions/ask-mode.yaml` PLUS a small overlay helper in `mcp-server/src/lib/ask-mode-overlay.ts` that intersects ask-mode's read-only set with the asked role's `permissions/<role>.yaml`, producing a per-role narrower allowlist; OR (c) NO new file — instead the skill body assembles a literal `tools_allow` array inline and the permissions loader is extended to accept a role id of the form `ask:<role>` that resolves to the read-only intersection.
  - [ ] 1.2 **Recommended choice: option (a) — uniform `permissions/ask-mode.yaml`.** Rationale: simplest enforcement seam (the existing `permissionsLoader` in `server.ts` looks up by role id; passing `_meta.role: "ask-mode"` to the spawned subagent is a one-line skill change), tightest contract (the operator gets the SAME read affordance regardless of which role they ask — predictable failure modes), and clean v1 surface. Option (b) gains nothing for v1 (no catalogue role has a `tools_allow` shape narrower than the ask-mode set for the read-only subset) and adds an overlay seam that has to be tested. Option (c) requires extending the permissions loader's role-resolution semantics, which is a Story 1.4 surface change — out of scope.
  - [ ] 1.3 Author the decision in `# Dev Notes` (this file) with one sentence naming the chosen option and the file path.

- [ ] **Task 2 — Author `permissions/ask-mode.yaml` (AC: 2, 4, 5)**
  - [ ] 2.1 Create `plugins/crew/permissions/ask-mode.yaml`. New file. Conforms to the existing `RolePermissionsSchema` shape from Story 2.2.
  - [ ] 2.2 Exact contents (subject to dev-agent confirmation that all named tools EXIST in the registered tool set as of Story 2.6 — see Task 2.3):
    ```yaml
    role: ask-mode
    tools_allow:
      - heartbeat
      - readPersona
      - readCatalogue
      - lookupRoleByDomain
      - readRepoSignals
      - readCustomRole
      - getStatus
      - getTeamSnapshot
    gh_allow:
      - pr-view
    gh_allow_args: {}
    ```
  - [ ] 2.3 **Pre-author validation.** Before writing the file, list the registered tool names by reading `plugins/crew/mcp-server/src/tools/register.ts` (the eight `server.registerTool({ name: ... })` calls as of Story 2.6). The ask-mode `tools_allow` MUST be a subset of those registered names PLUS `heartbeat` (which is the existing role-heartbeat tool from Story 1.4 / 1.5 — if `heartbeat` is NOT a registered tool name in the current build, omit it; do NOT invent a tool). If `lookupStandards` is registered (Story 1.3), include it; if not, omit. Author's discretion to verify against the current `register.ts` and reduce the list accordingly. The story spec lists the canonical read-shaped tool set; the implementation lists only the subset that actually exists.
  - [ ] 2.4 Do NOT include `instantiatePersona`. Do NOT include `appendPersonaKnowledge` (does not exist in v1, but the omission is a forward-compat contract per AC4(f)(iv)). Do NOT include `recordVerdict`, `claimStory`, `applyRetroProposal`, `unhireRole` (none exist in v1; same forward-compat contract). The negative-capability is encoded as omission per Story 2.2's pattern.
  - [ ] 2.5 The MCP server's permissions loader (Story 1.4) reads `permissions/<role>.yaml` via `plugins/crew/permissions/` path resolution. Confirm by reading the loader implementation that `ask-mode` will be resolved as a peer to `planner`, `generalist-dev`, etc. — i.e. there is NO role-allowlist-of-roles whitelist that would reject the new role id. If the loader maintains such a whitelist (it should not — Story 1.4 was designed for arbitrary role ids), surface the constraint in `# Dev Notes` before authoring the file.

- [ ] **Task 3 — Add `permissions/ask-mode.yaml` to the permissions-shape test (AC: 2, 4, 5)**
  - [ ] 3.1 Read `plugins/crew/mcp-server/tests/permissions-catalogue-parity.test.ts` (Story 2.2). It asserts that every catalogue role has a `permissions/<role>.yaml` and vice versa. `ask-mode` has NO catalogue role; the test must be updated to (a) recognise `ask-mode` as a special-case permission spec OR (b) the test's enforcement loop excludes `ask-mode` explicitly with a comment citing this story.
  - [ ] 3.2 Update the test minimally. Add an explicit exclusion list (`const SPECIAL_PERMISSION_SPECS = ["ask-mode"]`) and skip those in the catalogue-parity assertion. The new test added in Task 7 covers `ask-mode`'s shape independently.
  - [ ] 3.3 Verify the test still passes after the exclusion change.

- [ ] **Task 4 — Resolve `lookupStandards` availability (AC: 3, 4)**
  - [ ] 4.1 Check whether `lookupStandards` is a registered MCP tool by reading `plugins/crew/mcp-server/src/tools/register.ts`. As of Story 2.6, the registered set is `getStatus`, `readCatalogue`, `instantiatePersona`, `readPersona`, `lookupRoleByDomain`, `readRepoSignals`, `readCustomRole`, `getTeamSnapshot` — eight tools. `lookupStandards` was scaffolded in Story 1.3 but registration status varies by build; verify before adding to the ask-mode allowlist.
  - [ ] 4.2 If `lookupStandards` is NOT registered, the `<ask-mode>` prompt block's "standards doc" read is satisfied via direct `Read` (the subagent's allowed tools when spawned via `Task` include `Read` as a default Claude Code primitive). Document this in `# Dev Notes`.
  - [ ] 4.3 If `lookupStandards` IS registered, add it to `permissions/ask-mode.yaml` per Task 2.2.

- [ ] **Task 5 — Author `plugins/crew/skills/ask/SKILL.md` (AC: 1, 3, 5, 6)**
  - [ ] 5.1 Create the directory `plugins/crew/skills/ask/` and file `plugins/crew/skills/ask/SKILL.md`. Match the directory shape used by `plugins/crew/skills/{status,hire,skip-hiring,team}/SKILL.md`. The slash command surfaces as `/crew:ask` per implementation-patterns-consistency-rules §8.
  - [ ] 5.2 Frontmatter (verbatim):
    ```yaml
    ---
    name: crew:ask
    description: Open a non-mutating side-session with a hired role — ask one question, get one answer.
    allowed_tools: [Read, Task]
    ---
    ```
    `allowed_tools` is `[Read, Task]` — NO `Bash` (the subagent reaches `gh` via the MCP server's `gh_allow`-gated execa wrapper, not via the skill body shelling out), NO `Edit` (this is a read-only consultation).
  - [ ] 5.3 Body sections per implementation-patterns-consistency-rules §8: `# What this skill does`, `# Prerequisites`, `# Steps`, `# Failure modes`.
  - [ ] 5.4 `# What this skill does`: one paragraph explaining that `/crew:ask` opens a one-shot side-session against a hired role, with the role's persona prompt assembled and the operator's question delivered. State explicitly that the side-session is non-mutating by contract — the role MAY read PR comments, story manifests, persona files, and `docs/standards.md` to answer, but ALL canonical-state writes are refused at the MCP server boundary. Cross-link `/crew:hire`, `/crew:skip-hiring`, and `/crew:team` so an operator who runs `/crew:ask` against an un-hired team or a wrong role id knows where to go. Name the canonical example (FR76): "Use this to ask the planner to translate a reviewer's verdict comment without breaking the dev loop."
  - [ ] 5.5 `# Prerequisites`: a target repo with the specific `<role>` already hired (i.e. `<target-repo>/team/<role>/PERSONA.md` exists and parses). `.crew/config.yaml` is NOT required (the skill takes `targetRepoRoot` directly; the adapter is not consulted).
  - [ ] 5.6 `# Steps`:
    1. Parse the operator's invocation arguments into `<role>` (single token, kebab-case role id) and `<question>` (the remaining quoted string). If `<question>` is empty or `<role>` is empty after parsing, print the usage line `Usage: /crew:ask <role> "<question>"` and exit.
    2. Identify the target repo root (current Claude Code workspace root as `targetRepoRoot`). Do NOT call `getStatus` — adapter resolution is not needed.
    3. Call `readPersona({ targetRepoRoot, role: <role> })`. If it throws `PersonaFileNotFoundError`, print the AC6 error block verbatim (substituting `<role>` with the operator-typed token) and exit. If it throws `PersonaFileMalformedError`, print `crew:ask — persona for "<role>" is malformed: <zod-message>. Open <target-repo>/team/<role>/PERSONA.md and fix the malformation; git revert <persona-path> is the bail-out.` and exit. Otherwise capture the persona's `## Prompt` section body.
    4. Assemble the side-session system prompt: the persona's `## Prompt` body verbatim, then a blank line, then the literal `<ask-mode>` block from AC1 (with `<question>` substituted to the operator-typed question text — NOT the whole arguments string).
    5. Spawn a Claude Code `Task` subagent. Pass the assembled system prompt and `<question>` as the initial user message. CRITICAL: the `Task` invocation MUST carry `_meta.role: "ask-mode"` (or the equivalent allowlist binding per Task 1's chosen option) so the MCP server's permission boundary refuses any canonical-state mutation. If `Task` invocation surfaces a `_meta`-passing limitation in v1 Claude Code (the harness's `Task` tool may not support per-call `_meta` overrides), document the limitation in `# Dev Notes` and fall back to either (a) a wrapper MCP tool that the skill body invokes (out of scope for this story; defer to Epic 3+), or (b) explicit allowlist enforcement via the subagent's own `allowed_tools` Task argument which Claude Code passes through to the spawned session. The integration test (Task 7) MUST assert the refuse-boundary works against the chosen mechanism.
    6. Print the subagent's final reply verbatim to the operator. No post-processing. No "the planner says:" prefix.
  - [ ] 5.7 `# Failure modes`:
    - **Role not hired:** the skill prints the AC6 error block and exits. Run `/crew:hire` or `/crew:skip-hiring` to hire the role.
    - **Persona file malformed:** the skill prints a diagnostic naming the path and the Zod issue, and exits. Open the persona file directly (it's plain Markdown per NFR25) and fix the malformation; `git revert <persona-path>` is the bail-out.
    - **Empty `<question>`:** the skill prints the usage line and exits. Re-invoke with a quoted question.
    - **The asked role yields to a different role (locked-phrase yield in its reply):** the yield is surfaced as plain text in the printed reply. `/crew:ask` does NOT chain — the operator decides whether to re-invoke against the yielded-to role.
    - **Subagent attempts a canonical-state mutation:** the MCP server refuses at the `_meta.role` boundary; the subagent observes the refusal as a tool error and is expected (per the `<ask-mode>` prompt block) to surface it as plain text in the final reply. No transcript is recorded; the operator sees the surfaced refusal as part of the printed reply.
    - **Subagent attempts a write-shaped `gh` subcommand (`pr-comment`, `pr-create`, `pr-review`):** the `gh_allow` allowlist refuses; same refusal-surface as above.
  - [ ] 5.8 Do NOT spawn additional MCP tool calls from the skill body beyond `readPersona`. The composition of reads (PR comments, story manifests, standards) lives INSIDE the subagent, not the skill body.

- [ ] **Task 6 — Integration tests `ask-skill.test.ts` (AC: 1, 2, 3, 4, 5, 6)**
  - [ ] 6.1 Create `plugins/crew/mcp-server/tests/ask-skill.test.ts`. New file. Pattern after `plugins/crew/mcp-server/tests/hire-skill.test.ts` (Story 2.4) and `plugins/crew/mcp-server/tests/get-team-snapshot.test.ts` (Story 2.6) for the temp-dir + `instantiatePersona` setup idioms.
  - [ ] 6.2 Test file header MUST cite this story (`Story 2.7 AC1–AC6`) and reference `plugins/crew/docs/user-surface-acs.md`. No `.only`, no `.todo`, no `.skip`.
  - [ ] 6.3 Use Story 2.3's `instantiatePersona` to materialise persona files (do NOT hand-craft persona Markdown). For test (c)'s mutating-tool simulation, register a synthetic mutator at test setup if needed — see Task 6.6.
  - [ ] 6.4 **AC4(a) — happy path.** Create `<TMP_A>`. `instantiatePersona` for the five default-roster roles. Drive the skill body's prompt-assembly path directly (NOT via `Task` — instead, isolate the assembly logic in a small helper `assembleAskModePrompt({ personaPromptBody, question })` exported from the skill body OR from a sibling test helper module in `mcp-server/src/lib/ask-mode-prompt.ts`; the helper is pure and testable). Call `assembleAskModePrompt(...)` with the planner's persona prompt body and the operator's question. Assert: (i) the returned system-prompt string contains the planner persona's `## Prompt` body verbatim, (ii) the system-prompt string contains the `<ask-mode>` block verbatim, (iii) the `<question>` placeholder inside the `<ask-mode>` block is substituted with the operator's question text, (iv) the helper does NOT mutate the persona file (`fs.readFile` only).
  - [ ] 6.5 **AC4(b) — `gh pr view` permitted.** Create `<TMP_B>`. `instantiatePersona` for the five default-roster roles. Simulate the subagent's MCP call sequence by invoking the `gh` execa wrapper (Story 1.4) with `_meta.role: "ask-mode"` and subcommand `pr-view`. Assert the call is NOT refused (the wrapper returns the stubbed `gh pr view` payload, not a `PermissionDeniedError`). Use `vi.spyOn` on the underlying `execa` invocation to confirm the subcommand reached the OS-call boundary (or the test stub).
  - [ ] 6.6 **AC4(c) — write-refused.** Create `<TMP_C>`. `instantiatePersona` for the default roster. Simulate (i) an `instantiatePersona` call with `_meta.role: "ask-mode"` against a NEW role id — assert the response is `{ isError: true, content: [{ type: "text", text: <PermissionDeniedError message> }] }` and the error message names `ask-mode` and `instantiatePersona`. (ii) Invoke the `gh` wrapper with `_meta.role: "ask-mode"` and subcommand `pr-comment` — assert refused at the `gh_allow` boundary with a diagnostic naming `ask-mode` and `pr-comment`. (iii) If `appendPersonaKnowledge` is registered in the current build, simulate it with `_meta.role: "ask-mode"` and assert refusal; if NOT registered, document the forward-compat skip in `# Dev Notes` AND register a synthetic mutator tool in the test setup (`server.registerTool({ name: "syntheticMutateForTest", ... })`) and assert the same refusal behaviour against it.
  - [ ] 6.7 **AC6 — un-hired-role error surface.** Create `<TMP_D>` with no `team/`. Drive the skill body's argument-handling path (extract into a small helper if needed for testability; see Task 6.4). Call with `role: "security-specialist"` and any `<question>`. Assert the returned diagnostic text matches the AC6 block byte-for-byte (with `<role>` substituted to `security-specialist`) AND that NO `Task`-spawn boundary was reached (assert the `Task`-spawn helper, mocked at test setup, was never called).
  - [ ] 6.8 **AC4(e) — tool registration unchanged.** Mirror Story 2.6's Task 7.9: create a `createServer()`, call `registerAllTools(server)`, list tools, assert the eight Story 2.6 tools are present and that no NEW tool was added by this story. The count stays at 8.
  - [ ] 6.9 **AC4(f) — ask-mode allowlist shape.** Read `plugins/crew/permissions/ask-mode.yaml` directly. Parse via `RolePermissionsSchema` from Story 2.2. Assert: (i) `role === "ask-mode"`, (ii) every entry in `tools_allow` starts with `get`, `read`, `lookup`, or equals `heartbeat`, (iii) `gh_allow` deep-equals `["pr-view"]`, (iv) `tools_allow` does NOT include any of `["instantiatePersona", "appendPersonaKnowledge", "claimStory", "recordVerdict", "applyRetroProposal", "unhireRole"]`.
  - [ ] 6.10 **AC5 — skill self-consistency.** Read `plugins/crew/skills/ask/SKILL.md` from disk. Assert (i) frontmatter parses and `name === "crew:ask"`, (ii) `allowed_tools` deep-equals `["Read", "Task"]`, (iii) body contains `# What this skill does`, `# Prerequisites`, `# Steps`, `# Failure modes` in that order, (iv) `# Steps` body contains `readPersona` and the verbatim `<ask-mode>` block, (v) body contains `/crew:ask`, `/crew:hire`, `/crew:skip-hiring`, `/crew:team` at least once each, (vi) body contains the literal "non-mutating" (FR109's load-bearing word) and enumerates the four permitted reads (PR comments, story manifests, persona files, standards doc).
  - [ ] 6.11 **AC4(d) — un-hired-role no-subagent-spawn assertion.** Already covered in Task 6.7. Add an explicit `expect(taskSpawnSpy).not.toHaveBeenCalled()` assertion next to the AC6 diagnostic-text assertion.

- [ ] **Task 7 — Build & dist verification (AC: 4)**
  - [ ] 7.1 If Task 4 produced a new source file (e.g. `mcp-server/src/lib/ask-mode-prompt.ts` for the assembly helper), run `pnpm --dir plugins/crew/mcp-server build` and confirm `tsc` compiles cleanly.
  - [ ] 7.2 Per `plugins/crew/docs/README-install.md` § Build artefacts and Story 1.9's contract, the built `mcp-server/dist/` tree is committed. If this story adds source under `src/`, rebuild and commit `dist/` in the same commit as `src/`. `ci-drift-check.test.ts` enforces alignment.
  - [ ] 7.3 The skill file (`plugins/crew/skills/ask/SKILL.md`) and `permissions/ask-mode.yaml` are static assets shipped as-is via `/plugin install`'s file-copy semantics. No bundling step.
  - [ ] 7.4 Verify the existing Story 1.7 self-consistency test (`get-status.test.ts` AC4f, README-install.md six-checkpoint assertion) still passes — this story does NOT modify `README-install.md`.

- [ ] **Task 8 — Verify no other story's contract drifted (AC: 1–6)**
  - [ ] 8.1 Confirm `plugins/crew/mcp-server/src/schemas/{catalogue,persona,role-permissions,status-report,repo-signals,plugin-manifest,telemetry-events,workspace-config,standards-doc,team-snapshot}.ts` are unchanged.
  - [ ] 8.2 Confirm `plugins/crew/mcp-server/src/tools/{get-status,read-catalogue,instantiate-persona,read-persona,lookup-role-by-domain,read-repo-signals,read-custom-role,get-team-snapshot,register}.ts` are unchanged. This story spawns existing tools through a different `_meta.role`; no tool's handler changes.
  - [ ] 8.3 Confirm `plugins/crew/mcp-server/src/lib/{logger,managed-fs,markdown-frontmatter,persona-file,plugin-root,plugin-version,workspace-resolver,gh,repo-signal-detectors,team-stats}.ts` are unchanged. If Task 5.6 step 5 surfaces a `Task`-`_meta`-passing limitation that requires a new helper, document explicitly in `# Dev Notes` AND limit the new helper to a single small file under `lib/ask-mode-prompt.ts` (assembly only — no enforcement logic).
  - [ ] 8.4 Confirm `plugins/crew/mcp-server/src/server.ts` and `errors.ts` are unchanged. The permission-enforcement layer is reused, not modified.
  - [ ] 8.5 Confirm `plugins/crew/catalogue/*.md` is unchanged.
  - [ ] 8.6 Confirm `plugins/crew/permissions/<catalogue-role>.yaml` files (all 10 from Story 2.2) are unchanged. Only `permissions/ask-mode.yaml` is new.
  - [ ] 8.7 Confirm `plugins/crew/skills/{status,hire,skip-hiring,team}/SKILL.md` are unchanged.
  - [ ] 8.8 Confirm `plugins/crew/docs/README-install.md` is unchanged. Epic 7 Story 7.2 will integrate `/crew:ask` into the walkthrough.
  - [ ] 8.9 Confirm root `README.md` is unchanged.
  - [ ] 8.10 Confirm `plugins/crew/mcp-server/tests/{catalogue-shape,permissions-enforcement,persona-machinery,get-status,acceptance,ci-drift-check,repo-signal-detectors,user-surface-convention,pre-pr-gate,dist-shipping,smoke,readme-install,standards-doc,telemetry-logger,validate-active-adapter,workspace-resolver,bmad-adapter,bmad-adapter-acceptance,canonical-fs-guard,manifest-state-machine,git-commit,hire-skill,skip-hiring-and-custom-role,read-custom-role,get-team-snapshot,team-stats}.test.ts` are unchanged. Only `permissions-catalogue-parity.test.ts` is modified (Task 3.2's `ask-mode` exclusion) and `ask-skill.test.ts` is new.

---

## Dev Notes

### Critical context: what was shipped before, what this story builds on

- **Story 1.3** shipped `lookupStandards` for `docs/standards.md`. Whether `lookupStandards` is REGISTERED as an MCP tool (vs being an internal lib only) varies across the build — Task 4 verifies and either adds it to `permissions/ask-mode.yaml` or documents the fallback to direct `Read`.
- **Story 1.4** shipped the MCP dispatcher and `_meta.role` permission enforcement. The boundary is implemented in `mcp-server/src/server.ts` lines 116–150 (the `CallToolRequestSchema` handler). Every MCP call carries `_meta.role`; the server looks up `permissions/<role>.yaml` and refuses any tool not in `tools_allow`. **This story REUSES that boundary** — by passing `_meta.role: "ask-mode"` from the spawned subagent, every mutator call refuses without changing the enforcement code. The refuse-message format (`PermissionDeniedError`) already names the role, attempted tool, and allowed-tool set; the subagent's `<ask-mode>` prompt block primes it to recognise the refusal-shape and surface it as plain text rather than retry.
- **Story 1.5** shipped `lib/logger.ts` + `TelemetryEventSchema`. `/crew:ask` does NOT emit telemetry from the skill body (operator-facing reads are silent per NFR21). The spawned subagent's tool calls do emit `agent.invoke` events per existing convention; the `agent` field on those events is the asked role's id (e.g. `planner`), not `ask-mode` — the side-session is logically still a planner-shaped consultation, just running with a narrowed allowlist.
- **Story 1.7** shipped the skill-shape pattern (`skills/status/SKILL.md`) and the verbatim-print contract. `/crew:ask` mirrors `/crew:status` structurally: skill body assembles inputs, spawns the boundary call, prints the response verbatim.
- **Story 1.8** introduced the `user-surface` AC tag and pre-PR smoke gate. **This story has TWO `(user-surface)` ACs (AC1 and AC6)** — the happy-path `/crew:ask` surface and the un-hired-role error surface. Both will require operator-paste-output or an automated-e2e verification event per Story 1.8's gate.
- **Story 1.8 lesson (PR #76 "Process observation").** Pin user-surface contracts in absolute language. The skill body MUST print the subagent's reply **verbatim** (Task 5.6 step 6) and MUST print the AC6 error block **verbatim** (Task 5.6 step 3). No paraphrasing.
- **Story 1.9** committed `mcp-server/dist/`. If this story modifies `src/`, rebuild and commit `dist/` in the same change. `ci-drift-check.test.ts` enforces.
- **Story 2.1** shipped the catalogue and `CatalogueRoleSchema`. The catalogue is NOT consulted by `/crew:ask` — the persona file is the source of truth (its `## Prompt` section was copied from the catalogue at hire time per Story 2.3's `renderPersonaFile`).
- **Story 2.2** shipped `permissions/<role>.yaml` and `RolePermissionsSchema`. **`permissions/ask-mode.yaml` is a peer of those files** — same schema, different role id. Story 2.2's `permissions-catalogue-parity.test.ts` is updated (Task 3) to recognise `ask-mode` as a special-case spec with no matching catalogue role.
- **Story 2.3** shipped `parsePersonaFile`, `renderPersonaFile`, `readPersona`. **`/crew:ask`'s skill body composes `readPersona`** to fetch the asked role's `## Prompt` body. `PersonaFileNotFoundError` triggers the AC6 surface; `PersonaFileMalformedError` triggers a separate diagnostic per Task 5.6 step 3.
- **Story 2.4** shipped `/crew:hire` and the hiring-manager subagent pattern. **`/crew:ask` mirrors `/crew:hire`'s `Task`-spawn pattern** but with a narrower allowlist (ask-mode vs hiring-manager) and a different prompt-assembly contract (`<ask-mode>` block instead of `<initial-context>` block). Read `plugins/crew/skills/hire/SKILL.md` for the structural template before authoring `skills/ask/SKILL.md`.
- **Story 2.5** shipped `/crew:skip-hiring` and `readCustomRole`. **`/crew:ask` against a custom role works without special-casing** — custom-role personas live at `team/<role-id>/PERSONA.md` per Story 2.5's Design rationale, so `readPersona({ targetRepoRoot, role: <custom-id> })` finds them naturally.
- **Story 2.6** shipped `/crew:team` and `getTeamSnapshot`. **`/crew:team` is the cross-link target in the AC6 error block** — the operator who runs `/crew:ask security-specialist` against an un-hired security-specialist sees a cross-reference to `/crew:team` so they can see who IS hired before retrying.

### Task 1 decision: ask-mode allowlist form

**Decision (recorded by Task 1.3):** Option (a) — uniform `plugins/crew/permissions/ask-mode.yaml`. Single file, single role id (`ask-mode`), passed via `_meta.role` from the spawned subagent. The asked role's catalogue/persona permissions are NOT consulted at side-session time; the ask-mode allowlist is the sole gate. This is the simplest enforcement seam and the tightest contract. See Task 2 for the file contents.

### Task 4 decision: `lookupStandards` availability

**Pending dev-agent verification.** As of Story 2.6, `register.ts` registers eight tools: `getStatus`, `readCatalogue`, `instantiatePersona`, `readPersona`, `lookupRoleByDomain`, `readRepoSignals`, `readCustomRole`, `getTeamSnapshot`. `lookupStandards` was scaffolded in Story 1.3 as a lib helper; whether it is exposed as an MCP tool in the current build varies. Dev-agent checks `register.ts` at task time. If registered, add to `permissions/ask-mode.yaml` `tools_allow`. If not, the `<ask-mode>` prompt block's "standards doc" read is satisfied via the subagent's default `Read` tool (Claude Code primitive, available without MCP routing).

### Task 5.6 step 5 caveat: `_meta` passing through `Task`

**Open question (resolve at implementation time):** Claude Code's `Task` tool surface in v1 may not support explicit per-call `_meta.role` overrides. Two fallback paths:

1. **Subagent `allowed_tools` Task argument.** Claude Code's `Task` accepts an `allowed_tools` array that restricts the spawned session's tool surface. Pass `["Read", "readPersona", "readCatalogue", "lookupRoleByDomain", "readRepoSignals", "readCustomRole", "getStatus", "getTeamSnapshot"]` plus the `gh` MCP wrapper's name (whatever it is — verify against Story 1.4). This achieves the SAME refuse-shape as `_meta.role: "ask-mode"`: any tool not in the array is unreachable by the subagent.
2. **Persona-level `tools_allow` is the existing gate.** When the subagent calls an MCP tool, the call carries `_meta.role: <persona-role>` (the asked role's id, e.g. `planner`) by Claude Code's existing convention. The MCP server looks up `permissions/planner.yaml` and gates accordingly. The asked role's catalogue allowlist already excludes most mutators (planner has `readSourceStory`, `lookupStandards`, `recordYield`, `heartbeat` — no canonical-state writers). **BUT** this fallback DOES NOT cover all roles uniformly — `generalist-dev`'s allowlist includes write-shaped tools by design. The ask-mode contract requires uniform read-only enforcement regardless of which role is asked, so this fallback is INCOMPLETE on its own.

**Recommended composition:** use both. Pass `_meta.role: "ask-mode"` via Claude Code's `Task` `_meta` argument IF supported; if not, fall back to the `allowed_tools` Task-argument approach as the primary enforcement seam. The `<ask-mode>` prompt block is in either case the contract-prose the subagent reads; the allowlist is the unforgeable enforcement.

Dev agent: verify the `Task` tool's argument surface against current Claude Code docs at implementation time. If both `_meta` and `allowed_tools` paths fail, surface a sprint-change-proposal — `/crew:ask`'s read-only contract is load-bearing for FR109 and cannot ship without a working refuse-boundary.

### Files this story creates (NEW)

- `plugins/crew/skills/ask/SKILL.md` — the operator-facing slash-command file.
- `plugins/crew/permissions/ask-mode.yaml` — the narrowed read-only allowlist for the side-session.
- `plugins/crew/mcp-server/tests/ask-skill.test.ts` — integration harness for AC1–AC6.
- (Optional, Task 4-dependent) `plugins/crew/mcp-server/src/lib/ask-mode-prompt.ts` — pure prompt-assembly helper, exported for direct testing. If created, also `mcp-server/dist/lib/ask-mode-prompt.js`.

### Files this story MAY modify (UPDATE, with care)

- `plugins/crew/mcp-server/tests/permissions-catalogue-parity.test.ts` — add `ask-mode` to the special-case exclusion list (Task 3.2).

### Files this story MUST NOT modify

- `_bmad-output/implementation-artifacts/sprint-status.yaml` (orchestrator owns).
- `plugins/crew/catalogue/*.md`.
- `plugins/crew/permissions/<catalogue-role>.yaml` (the 10 catalogue-role spec files from Story 2.2).
- `plugins/crew/skills/{status,hire,skip-hiring,team}/SKILL.md`.
- `plugins/crew/mcp-server/src/server.ts`, `errors.ts` (the Story 1.4 permission boundary is reused, not modified).
- `plugins/crew/mcp-server/src/schemas/*.ts` (no new schema; `ask-mode.yaml` reuses `RolePermissionsSchema`).
- `plugins/crew/mcp-server/src/tools/*.ts` (existing handlers unchanged; ask-mode runs through them with a different `_meta.role`).
- `plugins/crew/mcp-server/src/lib/{logger,managed-fs,markdown-frontmatter,persona-file,plugin-root,plugin-version,workspace-resolver,gh,repo-signal-detectors,team-stats}.ts`.
- `plugins/crew/docs/README-install.md`.
- Root `README.md`.
- All existing tests except `permissions-catalogue-parity.test.ts`.

### Design rationale (load when in doubt)

- **Why a uniform `ask-mode` role instead of per-role narrowed overlays?** Because FR109's contract is uniform: "side-session without mutating dev-loop state." If asking the planner allowed wider reads than asking the security-specialist (or vice versa), the operator's mental model fragments — each `/crew:ask` becomes a guessing game about what's allowed. A uniform ask-mode collapses the contract to "any hired role, same reads, zero writes." Future epics may relax this (e.g. ask-mode-with-knowledge-append for retro consultations) — that's an additive change, not a regression on the v1 contract.
- **Why does `<ask-mode>` block live in the SKILL body rather than the persona file?** Because the persona file is the role's MANDATE prompt — what the role does in the full dev loop. The `<ask-mode>` block is a MODE constraint layered on top for a specific invocation surface. Embedding it in the persona would either (a) confuse the role's mandate at full-mode invocation time (e.g. inside `/crew:hire`-spawned subagents), or (b) require persona files to carry mode-specific subsections that the operator would have to maintain by hand. Layering at skill-assembly time keeps the persona file's contract single-purpose.
- **Why `Read, Task` rather than `Read, Task, Bash` in `allowed_tools` (Task 5.2)?** Because the subagent reaches `gh` through the MCP server's `gh_allow`-gated execa wrapper (Story 1.4) — that's the canonical enforcement seam. If the skill body had `Bash`, an operator-or-bug could shell out around the wrapper, defeating the `gh_allow: [pr-view]` contract. The narrower `[Read, Task]` is the principle-of-least-privilege per NFR12.
- **Why does the un-hired-role error block (AC6) cross-link THREE skills (`/crew:hire`, `/crew:skip-hiring`, `/crew:team`)?** Because the operator's three plausible next actions are: hire interactively, hire the default roster, or check what IS already hired in case of a typo. All three are one-skill-call away; the cross-references make them discoverable without forcing the operator to read docs.
- **Why does the skill print the subagent's reply verbatim (Task 5.6 step 6) rather than reformatting?** Story 1.8 lesson. The skill body is a pipe; the renderer / formatter contract lives in exactly one place (here, the subagent itself). Reformatting in the skill prose would (a) be untestable, (b) potentially mutate locked phrases (e.g. yields) that downstream tools expect, (c) confuse the operator about who said what.
- **Why does `/crew:ask` NOT chain on a yield (Task 5.6 step 7's note)?** Because the operator should choose whether to follow the yield. Auto-chaining would (a) consume tokens silently, (b) bypass the operator's chance to refine the question for the yielded-to role, (c) lose the locked-phrase yield as an observation signal. The yielded-to role is a one-`/crew:ask`-away action; that's the right friction-level for v1.
- **Why is `appendPersonaKnowledge` explicitly OMITTED from `permissions/ask-mode.yaml` (Task 2.4) even though it doesn't exist yet?** Forward-compat. When Epic 3+ ships `appendPersonaKnowledge`, the ask-mode contract must STILL refuse it (the side-session is read-only). Encoding the omission now and asserting it in AC4(f)(iv) prevents a future story from accidentally adding it to the ask-mode allowlist.
- **Why does the skill take `targetRepoRoot` directly rather than calling `getStatus` first?** Because `getStatus` requires adapter resolution (`resolveWorkspace`), which requires `.crew/config.yaml`. An operator may run `/crew:ask` immediately after `/crew:hire` (before configuring an adapter) — the asked role just needs its persona, not the adapter. Both `/crew:hire`, `/crew:skip-hiring`, and `/crew:team` skip adapter resolution; `/crew:ask` follows suit.
- **Why does the integration test isolate the prompt-assembly logic in a helper (Task 6.4)?** Because Claude Code's `Task` tool is not directly testable from inside vitest — spawning a real subagent in a test harness is expensive and non-deterministic. Isolating the assembly logic in a pure helper (`assembleAskModePrompt`) gives a deterministic test boundary for AC1's substantive contract (system prompt = persona prompt + `<ask-mode>` block; user message = `<question>` verbatim) without depending on a live Claude Code session. The "real `Task` actually spawns and the refuse-boundary fires" path is covered by the operator-paste-output verification at PR time (Story 1.8 gate route).

### Architecture references (load these first, dev agent)

- `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` §3 (Catalogue & Persona File Shape) — the `## Prompt` section is the body the skill extracts as the subagent's system prompt.
- `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` §4 (MCP Tool Naming) — reader-vs-mutator naming convention; the ask-mode allowlist's `tools_allow` is the read-set per this convention.
- `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` §7 (Locked Phrases) — yield phrase is `This sits in <role>'s domain — handing off.`; surfaced verbatim in the reply per Task 5.6 step 6 / Failure modes.
- `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` §8 (Skill File Shape) — pins frontmatter and the four required body sections.
- `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` §10 (gh Allowlist File Format) — `permissions/ask-mode.yaml`'s `gh_allow: [pr-view]` complies.
- `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` §12 (Enforcement) — confirms the `tools_allow` allowlist is the canonical write-refuse boundary.
- `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md` FR76 (translate-a-reviewer-comment affordance), FR109 (the `/crew:ask` requirement).
- `_bmad-output/planning-artifacts/prd-crew-v1/non-functional-requirements.md` NFR12 (minimum-necessary tool surface), NFR21 (telemetry is for runtime agent events).
- `plugins/crew/docs/user-surface-acs.md` — the `(user-surface)` tag rubric. AC1 and AC6 are tagged; AC2, AC3, AC4, AC5 are not.
- `plugins/crew/skills/hire/SKILL.md` — reference for the `Task`-spawn pattern.
- `plugins/crew/skills/team/SKILL.md` — reference for the verbatim-print pattern (mirrored from `/crew:status`).
- `plugins/crew/permissions/hiring-manager.yaml` — reference for a narrowed read-mostly allowlist shape.
- `plugins/crew/permissions/planner.yaml` — reference for the asked role's own allowlist (which is NOT consulted at ask-mode time, but informs the contrast with ask-mode's uniform read-only set).
- `plugins/crew/mcp-server/src/server.ts` lines 116–150 — the `_meta.role`-driven permission boundary that ask-mode reuses.
- `plugins/crew/mcp-server/src/schemas/role-permissions.ts` — `RolePermissionsSchema` that `permissions/ask-mode.yaml` parses against.
- `plugins/crew/mcp-server/src/lib/persona-file.ts` — `parsePersonaFile` extracts `sections.Prompt`; the skill body needs the `Prompt` section body.
- `plugins/crew/mcp-server/src/tools/read-persona.ts` — the per-role reader composed in the skill body.
- `_bmad-output/implementation-artifacts/2-4-hiring-manager-agent-and-hire-skill.md` — the `Task`-spawn + `_meta.role` pattern this story mirrors.
- `_bmad-output/implementation-artifacts/2-6-team-snapshot-skill.md` — the verbatim-print skill pattern this story mirrors.

### Testing standards summary

- `vitest` v1.x, co-located `*.test.ts` files under `plugins/crew/mcp-server/tests/`. No `.only`, no `.todo`, no `.skip`.
- Temp-dir fixtures via `fs.mkdtemp`. Clean up in `afterAll` via `fs.rm(..., { recursive: true, force: true })`.
- Module spies via `vi.spyOn(module, "exportName")`. Spy on the `gh` execa wrapper (Task 6.5), on `instantiatePersona` (Task 6.6 — write-refused simulation), and on the `Task`-spawn boundary (Task 6.7 — assert NOT called for un-hired role).
- Pre-seed personas via Story 2.3's `instantiatePersona`. Hand-corruption (if needed for malformed-persona cases) is `fs.writeFile` after `instantiatePersona`.
- Verbatim-string assertions via `===` for whole-line confirmation strings (the AC6 error block, the `<ask-mode>` block).
- Test file header cites this story (`Story 2.7 AC1–AC6`) and references `plugins/crew/docs/user-surface-acs.md` per Story 2.4/2.5/2.6 discipline.

### Project Structure Notes

- New files conform to the existing layout: skill under `skills/<name>/SKILL.md` (directory form, matching `status/`, `hire/`, `skip-hiring/`, `team/`), permissions under `permissions/<role>.yaml`, test under `mcp-server/tests/<name>.test.ts`. If Task 4 produces a helper, it lives under `mcp-server/src/lib/` with a co-located test.
- No new top-level directories. No new `package.json` dependencies.
- If the optional prompt-assembly helper is created, the `mcp-server/dist/` rebuild produces a sibling `dist/lib/ask-mode-prompt.js`. Commit per Story 1.9's `ci-drift-check.test.ts` contract.

### References

- [Source: `_bmad-output/planning-artifacts/epics/epic-2-team-formation-hiring-personas-and-team-observability.md` § Story 2.7]
- [Source: `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md` FR76, FR109]
- [Source: `_bmad-output/planning-artifacts/prd-crew-v1/non-functional-requirements.md` NFR12, NFR21, NFR25]
- [Source: `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` §3, §4, §7, §8, §10, §12]
- [Source: `_bmad-output/implementation-artifacts/2-2-per-role-permission-spec-files.md`]
- [Source: `_bmad-output/implementation-artifacts/2-3-persona-file-machinery-and-persona-mcp-tools.md`]
- [Source: `_bmad-output/implementation-artifacts/2-4-hiring-manager-agent-and-hire-skill.md`]
- [Source: `_bmad-output/implementation-artifacts/2-5-skip-hiring-fast-path-and-custom-escape-hatch.md`]
- [Source: `_bmad-output/implementation-artifacts/2-6-team-snapshot-skill.md`]
- [Source: `plugins/crew/docs/user-surface-acs.md`]
- [Source: `plugins/crew/skills/hire/SKILL.md`]
- [Source: `plugins/crew/skills/team/SKILL.md`]
- [Source: `plugins/crew/permissions/hiring-manager.yaml`]
- [Source: `plugins/crew/permissions/planner.yaml`]
- [Source: `plugins/crew/mcp-server/src/server.ts` lines 116–150]
- [Source: `plugins/crew/mcp-server/src/schemas/role-permissions.ts`]
- [Source: `plugins/crew/mcp-server/src/tools/read-persona.ts`]
- [Source: Story 1.8 lesson — PR #76 "Process observation" comment]

## Dev Agent Record

### Agent Model Used

_TBD by dev agent at implementation time._

### Debug Log References

_TBD._

### Completion Notes List

_TBD._

### File List

_TBD._
