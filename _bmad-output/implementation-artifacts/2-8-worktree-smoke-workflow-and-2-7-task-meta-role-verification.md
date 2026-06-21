# Story 2.8: Worktree-smoke workflow and 2.7 Task `_meta.role` verification

Status: review

<!-- Spec-only output. The orchestrator owns sprint-status.yaml transitions; this file does NOT modify it. -->

## Story

As a **plugin maintainer (Jack / any future operator-smoke participant)**,
I want **(a) a reliable, documented worktree-smoke workflow that exercises `/crew:ask` from a worktree branch inside a real Claude Code session without the unreliable "second `/plugin install` is a no-op" trap that bit ship-story for Story 2.7, AND (b) explicit verification that Claude Code's `Task` tool propagates `_meta.role: "ask-mode"` to MCP tool calls made by spawned subagents — or, if it does NOT, a tested alternative enforcement path so `/crew:ask`'s non-mutating contract is actually enforceable in production**,
so that **(i) every future `(user-surface)`-tagged story whose surface lives behind `/plugin install` has a fast, deterministic operator-smoke recipe (not "uninstall, install, restart, hope"), AND (ii) Story 2.7's FR109 contract — "side-session without mutating dev-loop state" — is end-to-end real, not just spec-asserted at the prompt-assembly seam.**

### What this story is, in one sentence

Ship (a) `plugins/crew/docs/worktree-smoke.md` plus an executable helper script `plugins/crew/scripts/worktree-smoke.sh` that document and automate the `uninstall → install → /reload-plugins` recipe required to pick up worktree-branch plugin changes in a real Claude Code session (closes the cache-reload trap recorded at `~/.claude/projects/-Users-jackmcintyre-projects-crew/memory/project_smoke_test_install.md`), and (b) a verification artefact — either a documented confirmation that Claude Code's `Task` tool propagates `_meta.role` to MCP `CallTool` requests issued by the spawned subagent, OR a tested fallback enforcement path (the `Task`-argument `subagent_type` / `allowed_tools` approach, OR a wrapping MCP tool, OR a session-bootstrap heartbeat that binds the spawned session's role) — captured in `plugins/crew/docs/ask-mode-enforcement.md` and pinned with a new vitest harness `plugins/crew/mcp-server/tests/ask-mode-enforcement.test.ts` that exercises the chosen enforcement path against the existing Story 1.4 permission boundary.

### What this story fixes (and why it needs its own story)

Two unresolved threads from Story 2.7 / Epic 2 ship-story runs converge here:

1. **Worktree-smoke is unreliable.** Story 2.7 is `(user-surface)`-tagged on AC1 and AC6 — meaning the Story 1.8 pre-PR gate demanded operator-paste evidence of `/crew:ask` actually running in real Claude Code before opening the PR. When Jack tried to smoke-test the worktree branch, `/plugin install crew@crew` reported "already installed globally" and silently skipped — the worktree's updated code never loaded, so the smoke gate was either green-on-stale-code or red-on-confused-cache. The recorded fix (see `~/.claude/projects/-Users-jackmcintyre-projects-crew/memory/project_smoke_test_install.md`) is `/plugin uninstall crew@crew → /plugin install crew@crew → /reload-plugins`, but it lives in an automemory note, not in the repo, not in any skill prose, and not in a runnable helper. Every future `(user-surface)` story repeats this rediscovery. This story moves the recipe into the repo, makes it executable, and cross-links it from ship-story's operator-smoke gate so the trap can't reset.
2. **`/crew:ask`'s refuse-boundary may not actually fire in production.** Story 2.7's integration test (`ask-skill.test.ts`) covers the prompt-assembly seam and asserts that the existing Story 1.4 MCP `_meta.role` permission boundary refuses mutating calls when `_meta.role === "ask-mode"`. What it does NOT verify is that Claude Code's `Task` tool actually propagates `_meta.role: "ask-mode"` from the spawning skill's `Task` invocation through to the spawned subagent's MCP `CallTool` requests. If `Task` strips `_meta`, the spawned subagent's calls reach the MCP server with NO `_meta.role` and the permission boundary in `server.ts` lines 132–147 falls through to `ctx = {}` — meaning every mutator is reachable from inside the side-session and FR109's contract silently disappears. Story 2.7's Dev Notes flag this as an open question (Task 5.6 step 5 caveat) and propose two fallback paths; this story is where that question gets answered, the chosen path is implemented (if a fallback is required), and a vitest harness pins the behaviour.

Without (1), every `(user-surface)` story hits the same uninstall-first surprise, and ship-story's pre-PR gate either rubber-stamps stale code or stalls until the operator rediscovers the recipe. Without (2), `/crew:ask`'s headline FR109 promise — non-mutating side-sessions — is a prompt-text suggestion to the subagent, not an enforced contract. Both are load-bearing and neither was closable inside Story 2.7's scope (the worktree-smoke story is operator-facing infrastructure; the `_meta.role` verification requires either Claude Code internals research or new fallback code, both out of scope for 2.7's "ship the skill" mandate).

This story is also the v1 reference for **the "operator-smoke recipe lives in the repo, not in tribal memory" pattern** that ship-story's Story 1.8 gate implicitly assumes — pinning that recipe HERE means every future `(user-surface)` story can cite `plugins/crew/docs/worktree-smoke.md` from its operator-paste-output evidence stanza rather than reinventing the install dance.

### What this story does NOT

- (a) Touch `_bmad-output/implementation-artifacts/sprint-status.yaml` — the orchestrator owns status transitions. This story is spec-only at authoring time; status flips on PR-merge per the existing ship-story contract.
- (b) Re-author `plugins/crew/skills/ask/SKILL.md` from Story 2.7 unless the chosen `_meta.role` enforcement path requires a single small edit (see Task 5). If 2.7's skill body is correct as-shipped (i.e. the `Task` invocation passes `_meta.role: "ask-mode"` and Claude Code propagates it), this story DOES NOT modify the skill body. Any required change is limited to step 5 of the skill body's `# Steps` section AND its `# Failure modes` section; no other section is touched.
- (c) Modify `plugins/crew/permissions/ask-mode.yaml`. The allowlist authored in Story 2.7 is the contract; this story verifies the contract is reachable end-to-end, it does not widen or narrow it.
- (d) Modify the Story 1.4 MCP permission boundary in `plugins/crew/mcp-server/src/server.ts` lines 116–150. If the chosen enforcement path is "Task propagates `_meta.role`" (the AC2 happy case), no server change is needed. If the chosen path is the fallback "spawn-time role-binding heartbeat" (see Task 4 option (b)), the change is additive — a single `bindRoleToSession` reader on the existing handler — and lives in a NEW file, not in `server.ts`. The dispatcher's `_meta.role`-aware refuse logic is REUSED, not replaced.
- (e) Implement a "session transcript" or "session recorder" feature. Worktree-smoke evidence in v1 is operator-pasted output per Story 1.8's gate; the helper script's job is to make picking up new code reliable, NOT to capture session output programmatically.
- (f) Add a CI / GitHub-Actions step that drives Claude Code end-to-end. The Claude Code TUI is not driveable from CI in v1; the operator-smoke route remains the canonical AC1 verification per Story 1.8 AC2's "or (b)" branch. CI's job in this story is limited to the vitest harness for the `_meta.role` enforcement path (Task 7).
- (g) Add or modify any MCP tool registered in `mcp-server/src/tools/register.ts`. The eight-tool list as of Story 2.6 is unchanged. If the chosen enforcement path is "session-bootstrap heartbeat" (Task 4 option (b)), it reuses the existing `heartbeat` tool from Story 1.5; no new tool is registered.
- (h) Change `plugins/crew/docs/user-surface-acs.md` or the pre-PR gate's regex / event semantics. Worktree-smoke is the operator-side recipe that satisfies the existing `user_surface_verified` event shape; the gate itself is unchanged.
- (i) Backfill operator-smoke evidence onto already-shipped stories (1.7 through 2.7). The new recipe is forward-looking; existing PRs are grandfathered per Story 1.8's stance on retroactive enforcement.
- (j) Modify `plugins/crew/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, or any plugin-manifest file. The install-from-worktree mechanics rely on Claude Code's existing `/plugin install` semantics; this story discovers and documents the work-around, it does NOT change install-time behaviour.
- (k) Modify `plugins/crew/docs/README-install.md`. The README documents the FRESH-clone install path for end-users; the worktree-smoke recipe is an internal contributor workflow and lives in a separate doc. Epic 7 may revisit; out of scope here.
- (l) Implement a "wrapper MCP tool" that the skill body invokes to inject `_meta.role` (Story 2.7 Dev Notes Task 5.6 step 5 fallback option). This story EVALUATES that path in Task 4 but does not select it for v1 unless the AC2 verification proves the other two paths unreachable. Author's discretion in Task 4 — but the recommended path is option (a) or (b), not (c).
- (m) Touch `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md`. The patterns doc is the spec for the existing enforcement model; this story exercises that model, it does not extend it.
- (n) Modify `plugins/crew/mcp-server/src/schemas/*.ts` or `plugins/crew/mcp-server/src/lib/*.ts` beyond a single optional new file under `mcp-server/src/lib/` IF the chosen enforcement path requires a session-binding helper (`lib/ask-mode-session-binding.ts`). See Task 4.
- (o) Touch `.claude/skills/ship-story/SKILL.md` to inject the worktree-smoke recipe into the orchestrator. `ship-story` is gitignored at the repo boundary (Story 1.8 Task 2 convention); the recipe lives at `plugins/crew/docs/worktree-smoke.md` and is referenced BY ship-story, not modified within it. The orchestrator-prompt update happens out-of-band if at all.
- (p) Add new telemetry events. Worktree-smoke is operator-side; no `agent.invoke` is emitted by the helper script. The closed v1 telemetry set is unchanged.
- (q) Touch any sibling skill (`status`, `hire`, `skip-hiring`, `team`, `ask`) beyond the at-most-one minimal `ask` edit described in (b).
- (r) Add npm-publish or any out-of-repo distribution mechanism. Worktree-smoke is local-only.

---

## Acceptance Criteria

> **Verbatim mapping.** AC1 and AC2 below map to the two epic ACs in `_bmad-output/planning-artifacts/epics/epic-2-team-formation-hiring-personas-and-team-observability.md` § Story 2.8. AC3–AC6 are story-scoped self-consistency additions that hard-pin (a) the helper-script's exit-codes / side-effects, (b) the worktree-smoke doc's verbatim install sequence so future ship-story runs can cross-link it without paraphrasing, (c) the `_meta.role` verification artefact, and (d) the new vitest harness for whichever enforcement path is chosen. Story 1.8 lesson — user-surface contracts and refuse-boundary contracts are pinned, not advisory.
>
> **User-surface judgement.** AC1 names a developer-typed CLI invocation (`./plugins/crew/scripts/worktree-smoke.sh`), a documented file path (`plugins/crew/docs/worktree-smoke.md`), AND the three Claude Code slash commands the operator types verbatim inside the TUI (`/plugin uninstall crew@crew`, `/plugin install crew@crew`, `/reload-plugins`) — `user-surface` per rubric items (i), (ii), and (iii). AC2 governs an internal MCP-layer mechanism (`_meta.role` propagation); the operator never types nor observes `_meta.role` directly, though the EFFECT (a refusal surfaced as plain text inside a `/crew:ask` reply) is observable. The propagation mechanism itself is internal — NOT `user-surface`. AC3 pins the helper-script's exit codes and stdout shape; the operator types the script invocation (rubric ii), but the exit-code / stdout-line contract is an internal CLI-test surface — TAGGED `user-surface` because the operator reads stdout on screen (rubric iv) and the failure-mode text is part of the surface they must understand. AC4 pins the worktree-smoke doc's verbatim install-command block as the canonical recipe future stories cross-link — `user-surface` per rubric (i) and (iii). AC5 pins the `_meta.role` enforcement artefact (a doc plus optional code); the OPERATOR never reads `ask-mode-enforcement.md` directly during normal use, but a dev-agent picking up a future `(user-surface)` story does — borderline, tagged NOT user-surface (the doc is a contributor artefact, not a user surface). AC6 is the vitest integration harness — NOT `user-surface`. The pre-PR smoke gate (per `plugins/crew/docs/user-surface-acs.md`) will require operator-paste-output or an automated-e2e verification event covering AC1, AC3, and AC4.

**AC1 (user-surface):**
**Given** a developer working on a worktree branch under `.worktrees/<branch>/` (or any non-main checkout of the crew repo) with modified plugin code (e.g. an edit to `plugins/crew/skills/ask/SKILL.md` or `plugins/crew/mcp-server/src/server.ts` plus a rebuilt `mcp-server/dist/`),
**When** they (a) read the recipe at `plugins/crew/docs/worktree-smoke.md`, (b) follow its three documented Claude Code slash-command steps **in order** — `/plugin uninstall crew@crew` → `/plugin install crew@crew` → `/reload-plugins` — OR run the helper script `./plugins/crew/scripts/worktree-smoke.sh` from the worktree root which prints those three slash-command lines to stdout (the helper does NOT execute them — the operator pastes them into the Claude Code TUI; see AC3),
**Then** the worktree's plugin code IS loaded into the running Claude Code session — verified by invoking `/crew:ask <hired-role> "<question>"` (Story 2.7 surface) against a worktree-only edit (e.g. a sentinel string inserted into the skill body's `# What this skill does` section that would not be present in a stale-cache version) and observing the sentinel surface verbatim in the printed response or skill help.

The recipe and helper EXPLICITLY name the cache-reload trap: a verbatim sentence stating that **`/plugin install crew@crew` is a no-op when the plugin is already installed globally; uninstall first**. The recipe MUST appear in the doc BEFORE any other content (above-the-fold) and MUST be reproducible by an operator who has never run it before, working only from the doc. _(addresses Epic 2 § Story 2.8 AC1; closes the trap recorded at `~/.claude/projects/-Users-jackmcintyre-projects-crew/memory/project_smoke_test_install.md`)_

<!-- user-surface: AC1 names (i) three Claude Code slash-command literals (`/plugin uninstall crew@crew`, `/plugin install crew@crew`, `/reload-plugins`) typed verbatim in the TUI per rubric i, (ii) the helper-script invocation `./plugins/crew/scripts/worktree-smoke.sh` typed at the shell per rubric ii, (iii) the documented file path `plugins/crew/docs/worktree-smoke.md` the operator opens by name per rubric iii, and (iv) the `/crew:ask` slash command used to verify the recipe worked per rubric i. The sentinel-surface check is the operator-observable confirmation per rubric iv. -->

**AC2:**
**Given** a `/crew:ask` invocation spawning a `Task` subagent per Story 2.7's skill body Step 5 (which carries `_meta.role: "ask-mode"` on the `Task` call),
**When** the spawned subagent issues an MCP `CallTool` request against any tool registered in `mcp-server/src/tools/register.ts`,
**Then** the request reaches the MCP server's `CallToolRequestSchema` handler (`plugins/crew/mcp-server/src/server.ts` lines 116–150) with `params._meta.role === "ask-mode"` — verified by EITHER:

- **(a) Empirical confirmation:** a runtime probe (an operator-paste-output event from a `/crew:ask` smoke run that successfully refused a mutator call, OR a Claude-Code-docs citation confirming `Task` propagates `_meta` through subagent tool calls) recorded as a verbatim block inside `plugins/crew/docs/ask-mode-enforcement.md` (NEW FILE — see AC5);
- **OR (b) An implemented alternative enforcement path** — when (a) is unreachable or refuted, a code-level fallback that binds the spawned subagent's MCP calls to `_meta.role: "ask-mode"` at session-bootstrap time. Recommended fallback (Task 4 default): the skill body's Step 5 issues a `heartbeat` MCP call with `_meta.role: "ask-mode"` BEFORE spawning the `Task`, AND the MCP server's session-state map remembers the most-recent role per session; subsequent `CallTool` requests within the same session inherit that role if no per-call `_meta.role` is present. (Alternative: pass `allowed_tools` to the `Task` invocation directly — a Claude-Code-native restriction that mirrors the ask-mode allowlist; see Task 4.)

Whichever path is chosen, the existing Story 1.4 permission boundary in `server.ts` lines 132–147 is the SINGLE refuse-point — this AC does not introduce a second enforcement layer. _(addresses Epic 2 § Story 2.8 AC2)_

**AC3 (user-surface):**
**Given** the helper script `plugins/crew/scripts/worktree-smoke.sh`,
**When** an operator runs `./plugins/crew/scripts/worktree-smoke.sh` from any directory inside a crew worktree (i.e. `git rev-parse --show-toplevel` resolves to a path under `.worktrees/` OR a non-main branch checkout of the crew repo),
**Then** the script:

1. Exits `0` and prints to stdout the verbatim three-line block (each on its own line, no surrounding markdown fences):
   ```
   /plugin uninstall crew@crew
   /plugin install crew@crew
   /reload-plugins
   ```
   prefixed by a one-line preamble naming the worktree's branch (e.g. `# Paste these into Claude Code to load worktree branch <branch>:`) and followed by a one-line confirmation footer (e.g. `# After /reload-plugins, /crew:status should report version <version> from <plugin-root>`).
2. Detects the case where the current directory is NOT inside a worktree (i.e. the operator is running it from the main checkout). In that case the script exits `2` and prints to stderr the diagnostic `worktree-smoke: refusing to run outside a worktree — cd into .worktrees/<branch>/ first` and exits without printing the slash-command block (defensive: running the recipe against the main checkout would reload main's code, not worktree code).
3. Does NOT execute any Claude Code slash command itself. It does NOT invoke `claude`, does NOT shell out to any Claude Code binary, does NOT modify `~/.claude/`. Its only side-effect is stdout / stderr text. (This is observable: the test in AC6 spies on `process.exit` and asserts no `claude` / `gh` / network calls.)
4. Does NOT require any new shell or runtime dependency. It is POSIX `sh`-compatible (no bashisms beyond what is portable to `/bin/sh` on macOS and Linux), uses only `git`, `printf`, and standard POSIX shell built-ins, with an optional non-failing invocation of `node` purely for plugin-version display in the confirmation footer (the script must fall back to `unknown` if `node` is absent — `node` is never load-bearing for the recipe). The shebang line is `#!/bin/sh`.

If any preflight check fails (e.g. `git` is not on PATH), the script exits `3` and prints to stderr a diagnostic naming the missing dependency. _(self-consistency; the script's behaviour is the user-facing surface the operator sees per rubric iv; pinning the exit codes and stdout shape prevents drift between the doc and the script)_

<!-- user-surface: AC3 governs the script's stdout/stderr contract and exit codes — the operator reads the script's output on screen (rubric iv) and types `./plugins/crew/scripts/worktree-smoke.sh` at the shell (rubric ii). The exit-code contract is part of the surface contract because future ship-story-orchestrator wiring can branch on `$?` to decide whether to surface the paste-block to the operator. -->

**AC4 (user-surface):**
**Given** the new `plugins/crew/docs/worktree-smoke.md`,
**When** an operator reads the file from a fresh checkout (no prior context),
**Then** the file contains, in this order:

1. A top-level `# Worktree smoke-test recipe for the crew plugin` heading.
2. A "Why this exists" section of at most three short paragraphs naming (a) the cache-reload trap (`/plugin install crew@crew` is a no-op when already installed; uninstall first), (b) the symptom (stale code surfaces instead of worktree edits), and (c) where the trap was first recorded (`~/.claude/projects/-Users-jackmcintyre-projects-crew/memory/project_smoke_test_install.md`).
3. A "Recipe" section containing the verbatim three-line slash-command block (identical byte-for-byte to AC3's stdout block; the AC6 vitest harness asserts equality):
   ```
   /plugin uninstall crew@crew
   /plugin install crew@crew
   /reload-plugins
   ```
4. A "Helper script" section naming `plugins/crew/scripts/worktree-smoke.sh` and citing AC3's contract (exit codes 0 / 2 / 3, stdout shape, no side-effects).
5. A "Verifying the recipe worked" section explaining how to sanity-check via a sentinel-surface check (insert a known string into a skill body; re-run `/crew:ask <role> "<question>"`; observe the sentinel in the response or skill help). This is the same loop AC1 verifies.
6. A "Cross-references" section linking to (a) Story 1.8's user-surface gate (`plugins/crew/docs/user-surface-acs.md`), (b) Story 2.7's `/crew:ask` skill (`plugins/crew/skills/ask/SKILL.md`), and (c) `plugins/crew/docs/ask-mode-enforcement.md` (the AC5 artefact).

The doc MUST be `≤ 200` lines (operator-readability budget per the Story 1.7 README discipline). _(self-consistency; pins the doc shape so future stories can cross-link `plugins/crew/docs/worktree-smoke.md` by stable anchor names without rediscovering them)_

<!-- user-surface: AC4 names the file path `plugins/crew/docs/worktree-smoke.md` the operator opens by name per rubric iii, AND the three slash-command literals the operator types verbatim per rubric i. The headings are stable anchors future stories cross-link. -->

**AC5:**
**Given** the `_meta.role` propagation question (Story 2.7 Dev Notes Task 5.6 step 5 caveat),
**When** a developer (or future story author) needs to know which enforcement path `/crew:ask` actually uses,
**Then** `plugins/crew/docs/ask-mode-enforcement.md` (NEW FILE) records the answer in this exact structure:

1. **Question** (one paragraph): does Claude Code's `Task` tool propagate `_meta.role` from the spawning skill's `Task` call to the spawned subagent's MCP `CallTool` requests?
2. **Investigation method** (one paragraph): which probe(s) were run — operator-paste evidence from a smoke run, Claude-Code-docs citation, source-read of the relevant Claude Code component if accessible, or vitest probe.
3. **Answer** (one paragraph): one of three values, named explicitly:
   - **"confirmed-propagating":** `Task` DOES propagate `_meta.role`; no fallback needed; the existing skill body Step 5 implementation is correct as-shipped.
   - **"confirmed-not-propagating":** `Task` does NOT propagate `_meta.role`; the chosen fallback is named (option (a) `allowed_tools` Task argument, option (b) session-bootstrap heartbeat binding, or option (c) wrapper MCP tool); the file lists which fallback was implemented and why.
   - **"unknown-but-belt-and-braces":** propagation status could not be empirically confirmed within story scope; a fallback was implemented anyway as defence-in-depth; the file names the fallback and the rationale.
4. **Verification artefact** (verbatim block): EITHER pasted operator-smoke output showing a mutator call refused with a `PermissionDeniedError` message naming `ask-mode`, OR a citation of the vitest test (AC6) that proves the chosen path.
5. **Implications for future stories** (one paragraph): under what circumstances a future story would need to revisit this (e.g. Claude Code releases a `Task` API change; a new `(user-surface)` AC requires similar enforcement; the fallback's session-state assumption is broken).

The file is plain Markdown, `≤ 150` lines. It is a contributor artefact, not an end-user doc. _(self-consistency; if Story 2.7 ships its skill with a `_meta.role` propagation assumption that is silently false in production, FR109 is broken and nobody knows; this AC forces the question to a written answer)_

**AC6 (integration):**
**Given** the chosen enforcement path from AC2 / AC5 AND the new test harness at `plugins/crew/mcp-server/tests/ask-mode-enforcement.test.ts`,
**When** `pnpm --dir plugins/crew test` runs,
**Then** vitest asserts:

- **(a) Path-A happy case (`_meta.role` propagates):** instantiate the MCP server via the existing `createServer()` factory used by other tests (Story 2.7 `ask-skill.test.ts` Task 6.4 pattern). Simulate a `CallTool` request whose `params._meta.role === "ask-mode"` against a known mutator (e.g. `instantiatePersona`). Assert the response shape is `{ isError: true, content: [{ type: "text", text: <PermissionDeniedError message> }] }` and the error text contains both `ask-mode` AND `instantiatePersona`. This pins the existing Story 1.4 boundary's behaviour against the ask-mode role — the contract the rest of `/crew:ask`'s enforcement is built on.
- **(b) Path-A "no `_meta`" probe:** the same `CallTool` request with `params._meta` omitted (or `params._meta.role` empty). Assert the request DOES dispatch to the mutator's handler — i.e. the absence of `_meta.role` is NOT itself a refuse. This proves the contrapositive: if `Task` strips `_meta`, the spawned subagent's calls are unconstrained, motivating the fallback in (c) / (d).
- **(c) Fallback enforcement assertion (conditional):** if AC5's answer is "confirmed-not-propagating" OR "unknown-but-belt-and-braces", the test exercises the implemented fallback. For the recommended session-bootstrap heartbeat fallback (Task 4 option (b)): issue a `heartbeat` MCP call with `_meta.role: "ask-mode"`, then issue an `instantiatePersona` call within the same simulated session WITHOUT `_meta.role`. Assert the second call IS refused with the same `PermissionDeniedError` shape (the role binding persists across calls in the session). For the `allowed_tools` Task-argument fallback (option (a)): the test asserts the Task-argument shape the skill body would build (a deterministic helper exported for direct testing, mirroring Story 2.7's `assembleAskModePrompt` pattern).
- **(d) Worktree-smoke script exit-code matrix:** spawn `./plugins/crew/scripts/worktree-smoke.sh` via `execa` from three test fixtures: (i) inside a fake worktree dir (`fs.mkdtemp` + `git init` + a `.git/worktrees/<branch>` marker file — author's discretion on the minimal git-state simulation), assert exit `0` and stdout containing the verbatim three-line block; (ii) inside a fake main-checkout dir, assert exit `2` and stderr containing the verbatim diagnostic from AC3.2; (iii) with `PATH=""` to simulate missing `git`, assert exit `3` and stderr naming the missing dependency.
- **(e) Worktree-smoke / doc parity:** read `plugins/crew/docs/worktree-smoke.md` and the script's stdout block (or a verbatim string constant exported from a shared helper). Assert the three-line slash-command block is byte-identical between doc and script. This pins the AC4 "byte-for-byte" claim.
- **(f) `ask-mode-enforcement.md` shape:** read `plugins/crew/docs/ask-mode-enforcement.md`. Assert the file contains, in order, all five required sections from AC5 (heading match: "Question", "Investigation method", "Answer", "Verification artefact", "Implications for future stories"), AND that the Answer section names exactly one of the three sanctioned values (`confirmed-propagating`, `confirmed-not-propagating`, `unknown-but-belt-and-braces`). The assertion is regex-based on the Answer section's first paragraph.
- **(g) Tool registration unchanged:** mirror Story 2.7 AC4(e) / Story 2.6 Task 7.9: assert the MCP `ListTools` response is byte-identical to Story 2.7's eight-tool list (`getStatus`, `readCatalogue`, `instantiatePersona`, `readPersona`, `lookupRoleByDomain`, `readRepoSignals`, `readCustomRole`, `getTeamSnapshot`). This story registers no new MCP tools.
- **(h) `ask-mode.yaml` unchanged:** read `plugins/crew/permissions/ask-mode.yaml`. Assert byte-equality (or content-equality modulo trailing whitespace) against the file as shipped by Story 2.7. This story does not modify the allowlist.

Any failure surfaces a diagnostic naming the failing AC, the fixture, and the expected vs actual value. The test header MUST cite this story (`Story 2.8 AC1–AC6`) and reference `plugins/crew/docs/user-surface-acs.md` per Story 2.7's discipline. _(self-consistency)_

---

## Tasks / Subtasks

- [x] **Task 1 — Confirm pre-flight state (AC: 1, 2, 4, 5, 6)**
  - [x] 1.1 Read `~/.claude/projects/-Users-jackmcintyre-projects-crew/memory/project_smoke_test_install.md` and confirm the three-line install sequence is `/plugin uninstall crew@crew` → `/plugin install crew@crew` → `/reload-plugins`. If the recipe in automemory has drifted from this story's AC1 block, surface the drift in `# Dev Notes` and adopt the automemory version verbatim (the automemory is the source of truth; this story is the publishing layer).
  - [x] 1.2 Read `plugins/crew/skills/ask/SKILL.md` (Story 2.7 output). Confirm the existing skill body Step 5 already passes `_meta.role: "ask-mode"` via the `Task` invocation. If it does NOT — i.e. Story 2.7's skill body just relies on the asked role's own allowlist — surface the gap in `# Dev Notes` and update Task 5 below accordingly (the AC2 enforcement-path decision then shifts to one of the two fallbacks).
  - [x] 1.3 Read `plugins/crew/mcp-server/src/server.ts` lines 116–150 and confirm the `_meta.role` handler shape matches the assertions in AC6(a) and AC6(b). If the handler has drifted (e.g. now refuses `null` `_meta` explicitly), update AC6(b)'s expected outcome to match observed behaviour AND record the drift in `# Dev Notes`.
  - [x] 1.4 Read `plugins/crew/permissions/ask-mode.yaml` (Story 2.7 output) and confirm `role: ask-mode`, `tools_allow` is the read-only set, `gh_allow: [pr-view]`. The AC6(h) byte-equality test pins the file as-shipped.
  - [x] 1.5 Read `plugins/crew/docs/user-surface-acs.md` (Story 1.8 output) and confirm the user-surface tag regex is `^\*\*AC(\d+)\s*\(user-surface\)\s*:\*\*` — this story's AC numbering follows the canonical convention.
  - [x] 1.6 Read `plugins/crew/.claude-plugin/plugin.json` and confirm the `mcpServers.crew.args` references `${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/index.js`. The worktree-smoke recipe assumes this exact wiring (the rebuilt worktree `dist/` becomes the loaded server after re-install).

- [x] **Task 2 — Author the helper script (AC: 1, 3, 6(d))**
  - [x] 2.1 Create `plugins/crew/scripts/` directory if it does not exist. (As of Story 2.7 it does not; verify with `ls plugins/crew/`.)
  - [x] 2.2 Create `plugins/crew/scripts/worktree-smoke.sh`. NEW FILE. Shebang `#!/bin/sh`. POSIX-compatible. Executable bit set (`chmod +x` after creation, or commit with explicit mode in `git add --chmod=+x`).
  - [x] 2.3 Script structure (recommended; author's discretion on style as long as the AC3 contract is satisfied): implemented verbatim per spec.
  - [x] 2.4 The verbatim three-line slash-command block (`/plugin uninstall crew@crew\n/plugin install crew@crew\n/reload-plugins\n`) MUST be copy-paste-identical to the block in `plugins/crew/docs/worktree-smoke.md` (Task 3). AC6(e) tests byte-equality.
  - [x] 2.5 If `node` is not on PATH (preflight detail), the `version` lookup falls back to `unknown` rather than failing the whole script — the recipe is still valid; the footer just doesn't carry a version number. AC3 does not require version detection.
  - [x] 2.6 Do NOT add any new file under `plugins/crew/scripts/` beyond `worktree-smoke.sh` in this story. If future stories add helpers, they extend this directory; the directory's existence is the story's contract.
  - [x] 2.7 Update `plugins/crew/.gitignore` only if `scripts/` would otherwise be ignored (it should not be — confirm with `git check-ignore -v plugins/crew/scripts/worktree-smoke.sh`). No change expected.

- [x] **Task 3 — Author the worktree-smoke doc (AC: 1, 4, 6(e))**
  - [x] 3.1 Create `plugins/crew/docs/worktree-smoke.md`. NEW FILE. Plain Markdown. `≤ 200` lines.
  - [x] 3.2 Section order per AC4: (1) `# Worktree smoke-test recipe for the crew plugin` title, (2) `## Why this exists`, (3) `## Recipe`, (4) `## Helper script`, (5) `## Verifying the recipe worked`, (6) `## Cross-references`. Headings are stable anchors; do NOT rename them.
  - [x] 3.3 The `## Recipe` section's verbatim three-line block (inside a fenced code block) MUST be byte-identical to the script's stdout block from Task 2.3 (the three lines without the preamble and footer comments). AC6(e) pins this.
  - [x] 3.4 The `## Why this exists` section MUST contain a verbatim sentence stating that `/plugin install crew@crew` is a no-op when the plugin is already installed globally — this is the load-bearing warning per AC1.
  - [x] 3.5 The `## Cross-references` section links to: (a) `plugins/crew/docs/user-surface-acs.md`, (b) `plugins/crew/skills/ask/SKILL.md`, (c) `plugins/crew/docs/ask-mode-enforcement.md` (Task 4 output), (d) the automemory note at `~/.claude/projects/-Users-jackmcintyre-projects-crew/memory/project_smoke_test_install.md` (named as the trap's origin record). The automemory link is a `<path>` mention (it is outside the repo); the others are relative repo links.
  - [x] 3.6 The `## Verifying the recipe worked` section names the sentinel-surface check: insert a known string into `plugins/crew/skills/ask/SKILL.md`'s `# What this skill does` section, save, run the recipe, run `/crew:ask <role> "<question>"`, and observe the sentinel surface in the response or skill help (e.g. via `/help crew:ask` if Claude Code exposes such a surface; otherwise via observation of the spawned subagent's prompt reflecting the edit).
  - [x] 3.7 Do NOT include marketing prose. Do NOT add a "Troubleshooting" section longer than five bullets. Operator-readability budget.

- [x] **Task 4 — Investigate and decide the `_meta.role` enforcement path (AC: 2, 5, 6(a-c))**
  - [x] 4.1 Reproduce the operator-paste-evidence path first (the cheapest and most authoritative). **Result: inconclusive** — dev agent operates in bmad-dev-story subagent context, cannot drive a live Claude Code TUI session. Proceeded to 4.2.
  - [x] 4.2 Check the Claude Code `Task` tool's documented behaviour. **Result: ambiguous** — public docs don't confirm `_meta` propagation through `Task` to spawned subagent MCP calls. Verdict: "unknown-but-belt-and-braces".
  - [x] 4.3 If 4.1 or 4.2 yields "confirmed-propagating": Task 5 is a no-op. N/A — verdict is "unknown-but-belt-and-braces".
  - [x] 4.4 If "confirmed-not-propagating" or "unknown-but-belt-and-braces": choose ONE fallback to implement. **Chosen: option (a) `allowed_tools` Task argument**.
  - [x] 4.5 **Recommended choice: option (a) `allowed_tools` Task argument.** Implemented `assembleAskModeAllowedTools()` helper in `mcp-server/src/lib/ask-mode-allowed-tools.ts`.
  - [x] 4.6 Record the decision (and the investigation evidence) in `plugins/crew/docs/ask-mode-enforcement.md` (NEW FILE — see Task 6) per AC5's five-section structure.

- [x] **Task 5 — Optional skill-body edit if Task 4 picked a fallback (AC: 2, 5)**
  - [x] 5.1 If Task 4 picked "confirmed-propagating": SKIP this task entirely. N/A.
  - [x] 5.2 If Task 4 picked option (a) `allowed_tools`: edited `plugins/crew/skills/ask/SKILL.md` Step 5 to add `allowed_tools` sentence. Cross-references `ask-mode-enforcement.md`.
  - [x] 5.3 If Task 4 picked option (b) session-bootstrap heartbeat: N/A.
  - [x] 5.4 Updated `plugins/crew/skills/ask/SKILL.md`'s `# Failure modes` section with one sentence about the `allowed_tools` enforcement seam.
  - [x] 5.5 Confirmed via re-reading that no OTHER section was changed. Frontmatter, `# What this skill does`, `# Prerequisites`, steps 1–4 / 6 are unchanged.

- [x] **Task 6 — Author the `_meta.role` enforcement record (AC: 2, 5, 6(f))**
  - [x] 6.1 Created `plugins/crew/docs/ask-mode-enforcement.md`. NEW FILE. Plain Markdown. `≤ 150` lines.
  - [x] 6.2 Section order per AC5: (1) `## Question`, (2) `## Investigation method`, (3) `## Answer`, (4) `## Verification artefact`, (5) `## Implications for future stories`. Headings are stable; AC6(f) regex-matches them.
  - [x] 6.3 `## Answer` paragraph names `unknown-but-belt-and-braces`.
  - [x] 6.4 `## Verification artefact` cites the specific test cases in `ask-mode-enforcement.test.ts`.
  - [x] 6.5 `## Implications for future stories` is a one-paragraph forward-compat note.

- [x] **Task 7 — Integration tests `ask-mode-enforcement.test.ts` (AC: 2, 6)**
  - [x] 7.1 Created `plugins/crew/mcp-server/tests/ask-mode-enforcement.test.ts`. NEW FILE.
  - [x] 7.2 Test file header cites this story (`Story 2.8 AC1–AC6`) and references `plugins/crew/docs/user-surface-acs.md`. No `.only`, no `.todo`, no `.skip`.
  - [x] 7.3 **AC6(a)** implemented and passes.
  - [x] 7.4 **AC6(b)** implemented using `readCatalogue` (not `instantiatePersona`, which throws protocol errors); passes.
  - [x] 7.5 **AC6(c)** implemented for option (a): `assembleAskModeAllowedTools()` assertions pass.
  - [x] 7.6 **AC6(d)** worktree-smoke script exit-code matrix: all three sub-tests pass (uses `/bin/sh` directly for exit-3 PATH-empty case).
  - [x] 7.7 **AC6(e)** worktree-smoke / doc parity: passes.
  - [x] 7.8 **AC6(f)** `ask-mode-enforcement.md` shape: passes.
  - [x] 7.9 **AC6(g)** tool registration unchanged: passes.
  - [x] 7.10 **AC6(h)** `ask-mode.yaml` unchanged: passes.
  - [x] 7.11 All 352 tests pass (29 test files). Zero skips. Zero new flakes.

- [x] **Task 8 — Build & dist verification (AC: 6)**
  - [x] 8.1 Task 5 produced `mcp-server/src/lib/ask-mode-allowed-tools.ts`. Ran `pnpm build`; tsc compiled cleanly. `dist/lib/ask-mode-allowed-tools.{js,d.ts}` committed.
  - [x] 8.2 N/A — not "confirmed-propagating".
  - [x] 8.3 Static assets (`worktree-smoke.md`, `ask-mode-enforcement.md`, `worktree-smoke.sh`) shipped as-is.
  - [x] 8.4 `get-status.test.ts`, `readme-install.test.ts` pass — `README-install.md` unchanged.
  - [x] 8.5 `ask-skill.test.ts` (28 tests) passes — skill body updated minimally; all existing assertions still pass.

- [x] **Task 9 — Verify no other story's contract drifted (AC: 1–6)**
  - [x] 9.1 Schemas unchanged. ✓
  - [x] 9.2 Tools unchanged. ✓
  - [x] 9.3 Existing lib files unchanged; only new file is `ask-mode-allowed-tools.ts`. ✓
  - [x] 9.4 `server.ts` unchanged (option (a) chosen). ✓
  - [x] 9.5 `errors.ts` unchanged. ✓
  - [x] 9.6 Catalogue unchanged. ✓
  - [x] 9.7 Permissions YAML unchanged. ✓
  - [x] 9.8 `skills/ask/SKILL.md` touched with minimal edit (Step 5 sentence + Failure modes sentence). Other skill files unchanged. ✓
  - [x] 9.9 `README-install.md` unchanged. ✓
  - [x] 9.10 Root `README.md` unchanged. ✓
  - [x] 9.11 `user-surface-acs.md` unchanged. ✓
  - [x] 9.12 `plugin.json` and `marketplace.json` unchanged. ✓
  - [x] 9.13 Only new test file is `ask-mode-enforcement.test.ts`. No existing tests modified. ✓

---

## Dev Notes

### Critical context: what was shipped before, what this story builds on

- **Story 1.4** shipped the MCP `_meta.role` permission boundary (`mcp-server/src/server.ts` lines 116–150). Every MCP `CallTool` request carries `_meta.role`; the dispatcher looks up `permissions/<role>.yaml` and refuses any tool not in `tools_allow`. This story REUSES that boundary — the AC2 verification is precisely "does the chosen propagation/binding mechanism reliably set `_meta.role: \"ask-mode\"` on the spawned subagent's calls so the dispatcher's refuse logic fires."
- **Story 1.5** shipped `heartbeat` as a registered MCP tool. The session-bootstrap fallback (Task 4 option (b)) reuses this — the skill body issues a `heartbeat` call with `_meta.role: "ask-mode"` to bind the session's role before spawning the `Task`. If `heartbeat` is NOT registered in the current build, Task 4 falls back to option (a) `allowed_tools` instead.
- **Story 1.7** shipped `/crew:status` and the README install path. The install-path failure mode (PR #61 — eight bugs from one root cause) is the historical precedent for THIS story's worktree-smoke recipe: same defect class (cache-reload trap), different surface.
- **Story 1.7a** shipped the hotfix that made `/plugin install crew@crew` work end-to-end on a fresh clone. The worktree-smoke recipe is the contributor-side equivalent — it's the recipe a CONTRIBUTOR uses to smoke-test their own worktree branch, NOT the recipe an end-user uses to install from main.
- **Story 1.8** introduced the `(user-surface)` AC tag and the pre-PR smoke gate. This story has THREE `(user-surface)` ACs (AC1, AC3, AC4). All three will require operator-paste-output or automated-e2e verification events per the gate. AC6 covers AC3 / AC4 via vitest; AC1 requires operator-paste evidence (the live Claude Code session demonstrating worktree code loads after the recipe is applied).
- **Story 1.8 lesson (PR #76).** Pin user-surface contracts in absolute language. The worktree-smoke recipe's three lines MUST be byte-identical across doc, script, and any future cross-link. AC6(e) enforces.
- **Story 1.9** committed `mcp-server/dist/` and added the `ci-drift-check.test.ts` harness. If THIS story's Task 4 picks option (b) (server-side session binding), the new `lib/session-role-binding.ts` source MUST be matched by a fresh `dist/` build in the same commit. If Task 4 picks "confirmed-propagating" or option (a), no `dist/` rebuild is needed.
- **Story 2.4** shipped `/crew:hire` and the `Task`-spawn pattern. The worktree-smoke recipe is the recipe that makes Story 2.4's PR-time operator-smoke evidence reliable.
- **Story 2.6** shipped `/crew:team` (no-LLM team snapshot) — referenced indirectly by `/crew:ask`'s error block in Story 2.7 AC6. Not directly relevant to THIS story except as a cross-link target.
- **Story 2.7** shipped `/crew:ask`, `permissions/ask-mode.yaml`, and the `ask-skill.test.ts` integration harness. The skill body's Step 5 ALREADY passes `_meta.role: "ask-mode"` via the `Task` invocation per Task 5.6 step 5 of Story 2.7. THIS story's AC2 verifies whether that propagation actually reaches the MCP server in production; AC6 pins the existing Story 1.4 boundary's behaviour against `ask-mode`; and Task 4–6 close the open question Story 2.7 explicitly deferred.

### Task 4 decision rubric

The cheapest investigation is the operator-paste-evidence path (Task 4.1). Run it FIRST. Most likely outcome (based on Story 1.4's design for arbitrary per-call `_meta.role`): "confirmed-propagating" — Claude Code's `Task` propagates `_meta` because the underlying MCP transport carries `params._meta` per the MCP spec, and `Task` is a thin wrapper that doesn't strip it. If empirically confirmed, this story is mostly docs + tests; no code change.

If Task 4.1 cannot be reproduced (e.g. ship-story orchestration prevents the dev agent from running a live Claude Code session), fall back to Task 4.2 docs check. If Claude Code docs are ambiguous, default to "unknown-but-belt-and-braces" and implement option (a) `allowed_tools` as defence-in-depth. The cost is minimal (a deterministic helper + a one-sentence skill edit + a vitest assertion); the benefit is FR109 stays enforced even if a future Claude Code release subtly changes `_meta` propagation.

The recommended FINAL choice (if Task 4.1 is inconclusive) is therefore:

> "unknown-but-belt-and-braces" + option (a) `allowed_tools` Task argument.

It's the smallest-blast-radius path that closes AC2's contract. Option (b) is acceptable if option (a) is unreachable; option (c) is explicitly out of scope (this story's non-goal (g)).

### Files this story creates (NEW)

- `plugins/crew/docs/worktree-smoke.md` — the operator-facing contributor recipe.
- `plugins/crew/scripts/worktree-smoke.sh` — the executable helper that prints the recipe.
- `plugins/crew/docs/ask-mode-enforcement.md` — the `_meta.role` propagation answer.
- `plugins/crew/mcp-server/tests/ask-mode-enforcement.test.ts` — the integration harness for AC2 / AC6.
- (Optional, Task 4-dependent) `plugins/crew/mcp-server/src/lib/session-role-binding.ts` — session-role binding helper (only if Task 5 picks option (b)). If created, also `mcp-server/dist/lib/session-role-binding.js`.

### Files this story MAY modify (UPDATE, with care)

- `plugins/crew/skills/ask/SKILL.md` — single sentence in Step 5 + one sentence in `# Failure modes` IF Task 4 picks a fallback. SKIP entirely if Task 4 picks "confirmed-propagating".
- `plugins/crew/mcp-server/src/server.ts` — `≤ 15` lines IF Task 5 picks option (b) session-bootstrap heartbeat. Otherwise unchanged.

### Files this story MUST NOT modify

- `_bmad-output/implementation-artifacts/sprint-status.yaml` (orchestrator owns).
- `plugins/crew/catalogue/*.md`.
- `plugins/crew/permissions/*.yaml` (all 12 — 10 catalogue roles + `ask-mode` + `gh-error-map`).
- `plugins/crew/skills/{status,hire,skip-hiring,team}/SKILL.md`.
- `plugins/crew/mcp-server/src/errors.ts` (`PermissionDeniedError` shape unchanged).
- `plugins/crew/mcp-server/src/schemas/*.ts` (no new schema).
- `plugins/crew/mcp-server/src/tools/*.ts` (no new tool, no handler change).
- `plugins/crew/mcp-server/src/lib/{logger,managed-fs,markdown-frontmatter,persona-file,plugin-root,plugin-version,workspace-resolver,gh,repo-signal-detectors,team-stats}.ts`.
- `plugins/crew/docs/README-install.md`.
- `plugins/crew/docs/user-surface-acs.md` (Story 1.8 contract).
- `plugins/crew/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`.
- Root `README.md`.
- `.claude/skills/ship-story/SKILL.md` (gitignored per Story 1.8 Task 2 convention).
- All existing tests (`smoke.test.ts`, `permissions-enforcement.test.ts`, `ask-skill.test.ts`, etc.) UNLESS Task 9.13 surfaces a necessary change.

### Design rationale (load when in doubt)

- **Why ship a helper SCRIPT and a doc rather than just a doc?** Because every future `(user-surface)` story will face the same trap, and a doc-only artefact requires the operator to remember the recipe lives somewhere. The script + doc combo makes the recipe discoverable two ways: a contributor reading code finds `plugins/crew/scripts/`, a contributor reading docs finds `plugins/crew/docs/`. Either path reaches the recipe. The script's job is NOT to run the recipe (Claude Code TUI commands can't be shelled to); its job is to PRINT the recipe with the correct branch/version interpolated, so the operator can copy-paste with confidence.
- **Why does the script REFUSE to run outside a worktree (AC3.2)?** Defence in depth. The recipe's whole point is "load worktree code." If an operator runs the helper from main and pastes the output, they reload main — which is correct for main but defeats the purpose for a worktree branch. The refusal forces an intentional `cd` into the worktree.
- **Why is the verbatim three-line block byte-identical across script and doc (AC6(e))?** Because future ship-story orchestration prompts (out of scope here, but inevitable) will cross-link the doc by stable anchor; if the script's output drifts from the doc, paste-and-go breaks. AC6(e) is the regression guard.
- **Why does AC5 force a TRINARY answer in `ask-mode-enforcement.md` (confirmed-propagating / confirmed-not-propagating / unknown-but-belt-and-braces)?** Because the worst outcome is "we wrote a doc that says 'it probably works' and shipped." The trinary forces the dev agent to either reproduce the empirical confirmation, refute it, or admit uncertainty and implement defence-in-depth. The vitest assertion in AC6(f) regex-matches one of the three; "it probably works" is not a valid value.
- **Why is "unknown-but-belt-and-braces + option (a) `allowed_tools`" the recommended default?** Because: (i) it's the lowest-blast-radius path — no MCP-server code change, no new session-state semantics; (ii) if `Task` later turns out to propagate `_meta.role`, the `allowed_tools` becomes redundant-but-harmless defence-in-depth (the read-only set is a strict subset of any role's actual tool surface during ask mode); (iii) it's testable in isolation via the deterministic `assembleAskModeAllowedTools()` helper, no live Claude Code session needed; (iv) it matches the principle-of-least-privilege per NFR12.
- **Why doesn't the recipe just say "reload Claude Code entirely"?** Because that's the nuclear option and it loses the operator's session state (open conversations, pending verifications, the partial `/crew:ask` they were drafting). The three-step recipe is the surgical minimum: uninstall the plugin (forces cache flush), reinstall (picks up new source), reload plugins (rebinds MCP servers without killing the session). Tested empirically via the automemory note's lived experience.
- **Why are AC1, AC3, AC4 all `(user-surface)`-tagged but AC2 is not?** AC2 governs an internal mechanism (`_meta.role` propagation through `Task`); the operator never types or observes `_meta.role` directly. The EFFECT of AC2 working — a refusal surfaced as plain text in `/crew:ask`'s reply — IS observable, but that effect is observed via `/crew:ask`, which is Story 2.7's surface, not this story's. AC1 / AC3 / AC4 each name surfaces the operator types or reads verbatim. AC5 is a contributor artefact (a doc a dev agent reads to make decisions), not a user surface — borderline, untagged per rubric.
- **Why does this story not modify `ship-story`'s orchestration SKILL.md?** Because `ship-story` is gitignored at the repo boundary (Story 1.8 Task 2 convention — it's treated as a third-party-dependency-style skill). Cross-linking happens by ship-story's orchestrator prompts citing `plugins/crew/docs/worktree-smoke.md` by path; the path is stable; ship-story can be updated out-of-band when its maintainer chooses. Pinning the doc here is the contract; the cross-link is downstream.
- **Why is the helper script POSIX `/bin/sh` rather than bash?** Because every macOS install ships `/bin/sh`; `bash` 5.x is not guaranteed (Apple ships 3.2). Avoiding bashisms makes the script portable to any contributor's machine. The script's logic is simple enough to fit POSIX comfortably — no associative arrays, no `[[ ... ]]`, no process substitution.

### Architecture references (load these first, dev agent)

- `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` §3 (Catalogue & Persona File Shape) — the `## Prompt` section is the body Story 2.7's skill extracts; this story doesn't touch it.
- `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` §4 (MCP Tool Naming) — reader-vs-mutator naming convention; the ask-mode allowlist's `tools_allow` is the read-set; this story tests refusal against the mutators.
- `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` §8 (Skill File Shape) — pins the skill body's required sections; AC4 in Story 2.7 already asserted this, no re-test needed here.
- `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` §12 (Enforcement) — the canonical write-refuse boundary; this story's AC2 verifies it is reachable through `/crew:ask`.
- `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md` FR76 (translate-a-reviewer-comment affordance), FR109 (the `/crew:ask` requirement). FR109's contract is what AC2 enforces.
- `_bmad-output/planning-artifacts/prd-crew-v1/non-functional-requirements.md` NFR12 (minimum-necessary tool surface) — the principle-of-least-privilege rationale for option (a) `allowed_tools`.
- `plugins/crew/docs/user-surface-acs.md` (Story 1.8) — the `(user-surface)` tag rubric. AC1, AC3, AC4 tagged; AC2, AC5 not; AC6 untagged (integration).
- `plugins/crew/skills/ask/SKILL.md` (Story 2.7) — the skill body whose Step 5 may or may not need a single-sentence edit.
- `plugins/crew/permissions/ask-mode.yaml` (Story 2.7) — the read-only allowlist; reference for `assembleAskModeAllowedTools()`.
- `plugins/crew/mcp-server/src/server.ts` lines 116–150 — the `_meta.role`-driven permission boundary that ask-mode reuses.
- `plugins/crew/mcp-server/src/schemas/role-permissions.ts` — `RolePermissionsSchema` for AC6(h).
- `plugins/crew/mcp-server/tests/ask-skill.test.ts` (Story 2.7) — pattern for `createServer()` + simulated-call tests.
- `plugins/crew/mcp-server/tests/permissions-enforcement.test.ts` (Story 1.4) — pattern for `_meta.role` refusal assertions.
- `~/.claude/projects/-Users-jackmcintyre-projects-crew/memory/project_smoke_test_install.md` — the automemory note where the worktree-smoke trap was first recorded.
- `_bmad-output/implementation-artifacts/1-7-status-skill-and-readme-install-path-through-the-plugin-sees-my-repo.md` — historical precedent for the cache-reload defect class.
- `_bmad-output/implementation-artifacts/1-7a-hotfix-make-the-install-path-actually-work-end-to-end.md` — the end-user-facing fix; this story is the contributor-facing equivalent.
- `_bmad-output/implementation-artifacts/1-8-user-surface-ac-type-and-smoke-gate-in-ship-story.md` — the user-surface gate this story's recipe makes reliable.
- `_bmad-output/implementation-artifacts/2-7-ask-role-side-session-skill.md` — the open question in Task 5.6 step 5 caveat that this story answers.

### Testing standards summary

- `vitest` v1.x, co-located `*.test.ts` files under `plugins/crew/mcp-server/tests/`. No `.only`, no `.todo`, no `.skip`.
- Temp-dir fixtures via `fs.mkdtemp`. Clean up in `afterAll` via `fs.rm(..., { recursive: true, force: true })`.
- `execa` (already a `mcp-server/` dep at `^9.6.1`) for shelling the worktree-smoke script under test.
- For the worktree-fake fixture (AC6(d)(i)), use `git init && git commit --allow-empty -m init && git worktree add <tmp>/wt <branch>` — Story 1.9's tests already use the `git` CLI for similar purposes; pattern is established.
- Verbatim-string assertions via `===` or `toContain` for whole-line confirmation strings (the three-line slash-command block, the AC3.2 worktree refusal diagnostic).
- Test file header cites this story (`Story 2.8 AC1–AC6`) and references `plugins/crew/docs/user-surface-acs.md` per Story 2.7 discipline.

### Project Structure Notes

- New files conform to the existing layout: docs under `plugins/crew/docs/`, scripts under `plugins/crew/scripts/` (NEW directory — Task 2.1), tests under `mcp-server/tests/<name>.test.ts`. The optional new lib file (Task 5 option (b)) lives under `mcp-server/src/lib/`.
- No new top-level directories at the repo root. No new `package.json` dependencies — `execa` is already in `mcp-server/package.json`.
- If the optional `session-role-binding.ts` helper is created, the `mcp-server/dist/` rebuild produces a sibling `dist/lib/session-role-binding.js`. Commit per Story 1.9's `ci-drift-check.test.ts` contract.

### Operator-smoke evidence note

AC1, AC3, AC4 are `(user-surface)`-tagged; the pre-PR smoke gate (Story 1.8) will require either an automated-e2e verification event (AC3 / AC4 are covered by AC6's vitest harness — `automated_e2e_verified` event for those) OR an operator-paste-output event for AC1 (the live Claude Code session demonstrating worktree code loads after the recipe is applied). The operator-smoke event MUST paste the actual `/crew:ask` reply showing a sentinel surface introduced in the worktree branch.

### References

- [Source: `_bmad-output/planning-artifacts/epics/epic-2-team-formation-hiring-personas-and-team-observability.md` § Story 2.8]
- [Source: `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md` FR76, FR109]
- [Source: `_bmad-output/planning-artifacts/prd-crew-v1/non-functional-requirements.md` NFR12]
- [Source: `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` §4, §8, §12]
- [Source: `_bmad-output/implementation-artifacts/1-7-status-skill-and-readme-install-path-through-the-plugin-sees-my-repo.md`]
- [Source: `_bmad-output/implementation-artifacts/1-7a-hotfix-make-the-install-path-actually-work-end-to-end.md`]
- [Source: `_bmad-output/implementation-artifacts/1-8-user-surface-ac-type-and-smoke-gate-in-ship-story.md`]
- [Source: `_bmad-output/implementation-artifacts/1-9-ship-a-pre-built-dist-with-the-plugin.md`]
- [Source: `_bmad-output/implementation-artifacts/2-7-ask-role-side-session-skill.md`]
- [Source: `plugins/crew/docs/user-surface-acs.md`]
- [Source: `plugins/crew/skills/ask/SKILL.md`]
- [Source: `plugins/crew/permissions/ask-mode.yaml`]
- [Source: `plugins/crew/mcp-server/src/server.ts` lines 116–150]
- [Source: `plugins/crew/mcp-server/src/schemas/role-permissions.ts`]
- [Source: `plugins/crew/.claude-plugin/plugin.json`]
- [Source: `~/.claude/projects/-Users-jackmcintyre-projects-crew/memory/project_smoke_test_install.md`]
- [Source: Story 1.8 lesson — PR #76 "Process observation" comment]
- [Source: Story 2.7 Dev Notes — Task 5.6 step 5 caveat (open `_meta.role` propagation question)]

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6 (bmad-dev-story subagent, 2026-05-20)

### Debug Log References

- Task 4.1/4.2: operator-paste-evidence and docs-check paths were both inconclusive from within bmad-dev-story context. Defaulted to "unknown-but-belt-and-braces" + option (a) per spec's Task 4.5 decision rubric.
- Task 7.4 (AC6(b)): initial implementation using `instantiatePersona` without `_meta` caused MCP protocol error (-32603) rather than `isError: true` response, because the handler throws JS exceptions that the SDK wraps as protocol errors. Fixed by using `readCatalogue` (a safe read-only tool that returns normally) to prove the dispatcher does NOT refuse calls without `_meta.role`.
- Task 7.6 (AC6(d)(iii)): initial test used `execa("sh", ...)` with `env: { PATH: "" }`, which failed because `sh` itself requires PATH to be resolved. Fixed by using `/bin/sh` absolute path so execa can find the shell even with empty PATH.

### Completion Notes List

- Task 4 verdict: **"unknown-but-belt-and-braces"** — propagation status of `_meta.role` through Claude Code `Task` could not be empirically confirmed within story scope.
- Task 4 implementation: **option (a) `allowed_tools` Task argument** — implemented `assembleAskModeAllowedTools()` helper in `mcp-server/src/lib/ask-mode-allowed-tools.ts`; reads `permissions/ask-mode.yaml` and appends `"Read"`.
- `plugins/crew/skills/ask/SKILL.md` Step 5: added one sentence about `allowed_tools`; `# Failure modes`: added one sentence about the enforcement seam. All other sections unchanged.
- All 352 tests pass (29 test files). No regressions. `ci-drift-check` passes — `dist/` committed in sync.

### File List

- `plugins/crew/docs/worktree-smoke.md` — NEW. Worktree-smoke recipe doc (AC1, AC4).
- `plugins/crew/scripts/worktree-smoke.sh` — NEW. Executable helper script (AC1, AC3). Executable bit set.
- `plugins/crew/docs/ask-mode-enforcement.md` — NEW. `_meta.role` propagation investigation record (AC2, AC5).
- `plugins/crew/mcp-server/src/lib/ask-mode-allowed-tools.ts` — NEW. `assembleAskModeAllowedTools()` helper and `ASK_MODE_TASK_ALLOWED_TOOLS` constant (AC2, AC6(c)).
- `plugins/crew/mcp-server/dist/lib/ask-mode-allowed-tools.js` — NEW. Compiled output.
- `plugins/crew/mcp-server/dist/lib/ask-mode-allowed-tools.d.ts` — NEW. Type declarations.
- `plugins/crew/mcp-server/tests/ask-mode-enforcement.test.ts` — NEW. Integration test harness (AC6).
- `plugins/crew/skills/ask/SKILL.md` — UPDATED. Step 5 `allowed_tools` sentence + `# Failure modes` enforcement sentence.

### Change Log

- 2026-05-20: Story 2.8 implemented. Worktree-smoke recipe published to repo (doc + script). `_meta.role` propagation verdict: "unknown-but-belt-and-braces". Option (a) `allowed_tools` fallback implemented (`ask-mode-allowed-tools.ts`). `ask-mode-enforcement.test.ts` harness: 20 tests, all green. 352 total tests passing.
