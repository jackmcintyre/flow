# Epic 1: Plugin Foundation & Target-Repo Bootstrap

A user installs the plugin, points it at a target repo, and gets back confirmation the plugin recognises the repo. Standards-doc lookup, permission allowlists, atomic state primitive, JSONL telemetry plumbing all in place.

## Story 1.1: Scaffold the plugin skeleton

As a plugin maintainer,
I want a load-bearing-but-empty plugin skeleton committed at `plugins/flow/`,
So that every later story has a stable place to land its files, schemas, and imports.

**Acceptance Criteria:**

**Given** the repo root,
**When** I run `pnpm install && pnpm build` from `plugins/flow/`,
**Then** the install and build succeed with zero TypeScript errors.

**Given** the scaffolded `plugins/flow/`,
**When** I inspect the tree,
**Then** it contains `.claude-plugin/plugin.json` (with a semver `version` field), `pnpm-workspace.yaml`, `tsconfig.base.json`, `mcp-server/` (with `src/server.ts` exporting an empty MCP server), `catalogue/`, `skills/`, `permissions/`, `docs/`, and `example/` directories.

**Given** the scaffolded MCP server, **When** the user loads the plugin in Claude Code, **Then** the MCP server starts and reports zero tools registered (no errors).

**Given** the scaffolded `mcp-server/src/adapters/`, **When** I inspect `bmad/index.ts`, **Then** it exports a `BmadAdapter` implementing `PlanningAdapter.listSourceStories` as an empty list (hardcoded placeholder).

**Given** the scaffolded server, **When** `getPluginVersion()` exported from `mcp-server/src/lib/plugin-version.ts` is called, **Then** it returns the semver string from `.claude-plugin/plugin.json` (used by Stories 2.3, 4.7, and 4.9 for stamping).

**AC6 (integration):** `pnpm test` runs the vitest smoke suite which (a) instantiates the MCP server, (b) registers zero tools, (c) parses `.claude-plugin/plugin.json` against its Zod schema, (d) calls `BmadAdapter.listSourceStories()` and asserts `[]`; all four pass.

## Story 1.2: Workspace resolver and per-target-repo config

As a plugin operator,
I want the plugin to recognise my target repo via a `.flow/config.yaml` file,
So that the plugin knows where to read sources and write execution state for *my* project.

**Acceptance Criteria:**

**Given** a target repo with `.flow/config.yaml` present and valid (adapter, adapter_config, plugin settings),
**When** any skill is invoked,
**Then** the workspace resolver loads the config and exposes `targetRepoRoot`, `activeAdapterName`, and plugin settings to the MCP tool layer.

**Given** a target repo with no config,
**When** the first skill is invoked,
**Then** the plugin runs `detect()` against each registered adapter in order; on a unique match it writes the config; on ambiguity it surfaces a clear prompt asking the user to pick.

**Given** an invalid `.flow/config.yaml`,
**When** any skill is invoked,
**Then** the plugin halts with a human-readable error pointing at the offending key and the expected Zod schema.

**AC4 (integration):** vitest covers the three branches (valid config / no config + detect / invalid config) against fixture target repos.

## Story 1.2b: Stale-config detection on every skill invocation

As a plugin operator,
I want the active adapter validated against the repo on every skill invocation,
So that a copied-from-example config doesn't silently produce zero results when the repo doesn't match.

**Acceptance Criteria:**

**Given** a target repo with a configured adapter,
**When** any skill is invoked,
**Then** the runtime calls `activeAdapter.detect(targetRepo)` before any other work.

**Given** a `detect()` returning false (the configured adapter does not recognise this repo),
**When** the runtime inspects,
**Then** the skill halts with a clear message naming which adapter is configured, that it returned false, and which (if any) other registered adapters' `detect()` returned true.

**Given** a `detect()` returning false where no other adapter matches either,
**When** the skill halts,
**Then** the message points the user at the workspace-config Zod schema and the canonical examples in the README.

**AC4 (integration):** vitest covers (a) configured adapter matches → skill proceeds, (b) configured adapter mismatches but another matches → halt with redirection message, (c) no adapter matches → halt with config-rewrite guidance.

## Story 1.3: Standards-doc lookup, parser, and shipped example template

As a plugin operator,
I want a clear error pointing me at a copy-target template when `docs/standards.md` is missing or malformed,
So that I can bootstrap a target repo without guessing the standard's required shape.

**Acceptance Criteria:**

**Given** a target repo with no `docs/standards.md`,
**When** the plugin attempts to look up the standards doc,
**Then** the plugin halts with an error naming the expected path and pointing at `plugins/flow/docs/standards-example.md` as the copy-target. _(FR45)_

**Given** a target repo with a malformed `docs/standards.md` (missing required fields, or >10 criteria),
**When** the plugin attempts to parse it,
**Then** the plugin halts with a human-readable error citing the offending field or the criterion count cap. _(FR46)_

**Given** a target repo with a valid `docs/standards.md`,
**When** the plugin parses it,
**Then** the result exposes `version`, `criteria[]` (each with `name`, `what`, `check`, `anti_criterion`), and `updated`. _(FR44)_

**Given** the plugin tree,
**When** I inspect `plugins/flow/docs/standards-example.md`,
**Then** it exists, parses against the same schema as a valid `docs/standards.md`, and is referenced from the README install path. _(FR47)_

**AC5 (integration):** vitest covers each of the four cases against fixtures.

## Story 1.4: Permission-allowlist scaffolding and tool-layer enforcement

As a plugin maintainer,
I want every agent's tool and `gh`-subcommand authority enforced at the runtime/tool layer rather than via prompt,
So that no later story can accidentally grant an agent capability it shouldn't have.

**Acceptance Criteria:**

**Given** a per-role permission spec at `plugins/<plugin>/permissions/<role>.yaml` declaring `tools_allow` and `gh_allow`,
**When** the agent attempts to invoke a tool or `gh` subcommand,
**Then** the runtime refuses the call when the tool/subcommand is not in the role's allowlist, returning a typed permission-denied error. _(FR79, FR80, NFR12)_

**Given** the execa-based `gh` wrapper at `mcp-server/src/lib/gh.ts`,
**When** any code path invokes `gh`,
**Then** the call goes through the wrapper; direct child-process spawning of `gh` elsewhere is forbidden by a lint rule or unit test. _(NFR17)_

**Given** the MCP server, **When** any agent attempts a canonical-state mutation via raw `fs.write` to a manifest, persona, registry, or telemetry path, **Then** the call fails — only MCP tools can write to those paths. _(FR81, NFR16)_

**AC4 (integration):** vitest covers the four enforcement paths (unlisted tool denied, unlisted `gh` subcommand denied, raw `fs.write` to canonical path denied, and a valid call succeeding).

## Story 1.5: JSONL telemetry plumbing via pino

As a plugin maintainer,
I want a single write path for structured JSONL telemetry events under `<target-repo>/.flow/telemetry/<YYYY-MM>.jsonl`,
So that every later epic can emit events through one boundary that's parseable without an LLM.

**Acceptance Criteria:**

**Given** the logger at `mcp-server/src/lib/logger.ts`,
**When** any agent emits a telemetry event with a `type` discriminator,
**Then** the event is appended as a single JSON line to the current month's file (one event per line, no trailing comma). _(NFR21)_

**Given** an event whose payload fails its Zod schema,
**When** the logger attempts to write,
**Then** the write is rejected with a typed error and the failure is itself recorded as a `tool-quirk` event. _(Pattern enforcement)_

**Given** events emitted in two consecutive months, **When** I list the telemetry directory, **Then** I see two files (`<YYYY-MM>.jsonl` each) and no cross-month interleaving.

**Given** any canonical-state mutation (rule registry, standards doc, persona file, skill file, manifest), **When** the MCP tool finishes the write, **Then** the change is staged and committed via `mcp-server/src/lib/git.ts` with a structured commit message (`<tool-name>: <ref or proposal-id>`); the wrapper is the only path for plugin-side commits.

**AC4 (integration):** vitest emits a sample of each pinned event type (`agent.invoke`, at minimum) and asserts JSONL strict parseability.

## Story 1.6: Atomic `fs.rename` state-machine primitive

As a plugin maintainer,
I want a same-filesystem `fs.rename` helper that guarantees never-two-states-at-once for any file under a managed directory,
So that the dev/orchestration epics can build on a single trusted state-transition primitive.

**Acceptance Criteria:**

**Given** a managed directory tree with state directories,
**When** the primitive moves a file between two state directories,
**Then** the operation is a single `fs.rename` syscall (no copy+delete fallback). _(NFR8)_

**Given** a cross-filesystem move attempt,
**When** the primitive runs,
**Then** it halts with a typed `CrossFilesystemMoveError` (cross-filesystem support is explicitly out of v1 scope). _(NFR8)_

**AC3 (integration):** vitest covers the happy path, the cross-filesystem error, and a chaos test asserting no file is observed in two state directories during 1,000 random moves.

## Story 1.7: `/status` skill and README install path through "the plugin sees my repo"

As a plugin operator,
I want a `/<plugin>:status` skill that prints the current adapter, plugin version, and standards-doc state,
So that I get a concrete first-install confirmation that the plugin is wired up correctly.

**Acceptance Criteria:**

**Given** a freshly cloned repo with the plugin loaded and a valid target-repo config,
**When** I run `/<plugin>:status`,
**Then** the output prints plugin semver, resolved target-repo path, active adapter name, standards-doc state (`ok | missing | malformed`), and current cycle (if any). _(FR74)_

**Given** the README,
**When** a new user follows the install path up to "the plugin sees my repo,"
**Then** each step has a verifiable checkpoint (clone, install plugin, copy standards template, run `/status`, see the expected line). _(FR71, FR73)_

**Given** the plugin tree and a target tree as the *same* repo (Jack dog-fooding),
**When** I run `/status`,
**Then** the behaviour is identical to the split-repo case (one code path). _(FR74)_

**AC4 (integration):** vitest drives `/status` against (a) a fresh target repo with a missing standards.md and (b) a configured target repo with a valid standards.md; both produce the expected status lines.

## Story 1.7a: Hotfix — make the install path actually work end-to-end

As the plugin operator running Story 1.7's install README,
I want every command in the install path to actually work and the `/flow:status` skill to actually appear in tab-complete after a real install,
So that 1.7's "happy path" isn't a literature exercise — it's a runnable sequence with at least one test that exec's it.

**Context:** 1.7's AC suite verified that the README *contains* the expected checkpoint strings (regex-matched), but no AC actually *ran* the install commands or confirmed `/flow:status` surfaced as a real Claude Code slash command. Two real bugs shipped under green ACs as a result: (a) `/plugin install plugins/flow` is the wrong syntax for Claude Code — `/plugin install` takes a marketplace-registered name, not a path, and the repo has no `marketplace.json` to register; (b) `plugins/flow/.claude-plugin/plugin.json` has `"skills": []` so even if installed, the new `skills/status.md` may not be discoverable as `/flow:status`. This story closes both gaps and adds the missing acceptance gate that would have caught them.

**Acceptance Criteria:**

**Given** a freshly cloned repo, **When** I run the install sequence as documented in the corrected README (`/plugin marketplace add .` followed by `/plugin install flow@flow`, then a reload), **Then** every command exits successfully and Claude Code reports the plugin as installed at the version in `plugin.json`. _(FR71, FR73)_

**Given** the installed plugin, **When** I open the Claude Code slash-command tab-complete after reload, **Then** `/flow:status` appears in the `/flow:` namespace and invoking it returns the five-line status block defined by Story 1.7 (no behavioural change to the rendered output).

**Given** the repo, **When** any future story adds a new file under `plugins/flow/skills/`, **Then** a check fails if that file isn't either registered in `plugin.json`'s `skills` array OR explicitly opted-out via a documented mechanism (so we can't ship another orphaned skill).

**AC4 (integration):** vitest asserts: (a) `.claude-plugin/marketplace.json` exists at repo root and is valid JSON listing the `crew` plugin at the expected path; (b) `plugin.json`'s `skills` array lists every `*.md` file under `plugins/flow/skills/` (or a documented opt-out file is present); (c) the corrected README's step 3 contains the literal `/plugin marketplace add .` and step 3b the literal `/plugin install flow@flow`; (d) Story 1.7's existing `/status` integration test still passes unchanged (no regression to the rendered five-line block).

**Post-story note (2026-05-20):** 1.7a's static-contract verification still wasn't enough — five further wrong-shape bugs surfaced when Jack tried the install live (plugin.json's `skills` field is invalid not empty, flat skill files don't auto-discover, relative `mcpServers.args` paths fail under Claude Code's spawn CWD, our own schema required fields that Claude Code rejects, and the install-contract test locked in the wrong contract). Resolved out-of-cycle in a pair-debug session and shipped as PR #61. Stories 1.8 / 1.9 / 1.10 below encode the lessons so this class of bug cannot recur.

## Story 1.8: User-surface AC type and smoke gate in ship-story

As the orchestrator running ship-story for any user-facing slash command or installable artifact,
I want a mandatory "did anyone actually run this?" gate that requires end-to-end evidence of the user surface working in real Claude Code before a PR opens,
So that document-driven verification (spec author → validator → dev → reviewer → QA) can never again ship a manifest, command, or install path that fails the moment a real user tries it.

**Context:** Stories 1.7 and 1.7a each shipped under 4/4 green ACs and approved code review. Both contained user-facing surfaces (a slash command, an install path) that no agent ever actually ran against real Claude Code. Eight bugs from one root cause surfaced when Jack tried the install live. The defect is structural: every gate in ship-story reasons from documents, none of them is the end-user.

**Acceptance Criteria:**

**Given** the story-spec template and the `bmad-create-story` skill, **When** I author a new story spec, **Then** every AC that names a user-invocable surface (slash command, CLI invocation, installed-plugin artifact, file the user is asked to copy by name) must be tagged `user-surface`, and the skill prompts the author to make this judgement explicitly for each AC.

**Given** a story whose spec contains at least one `user-surface` AC, **When** ship-story reaches the gate between AC-verification and PR-open, **Then** the gate requires either (a) an automated end-to-end test that drives the user-invocable surface (not the implementation layer beneath it), OR (b) an explicit `user_surface_verified` event in the run log carrying pasted output from a real Claude Code session run by Jack (or an operator), naming each `user-surface` AC and its observed result.

**Given** neither (a) nor (b) is present, **When** ship-story attempts to open the PR, **Then** `ship.py` halts with exit code `USER_SURFACE_UNVERIFIED`, surfaces which `user-surface` ACs are missing evidence, and refuses to push or open the PR.

**AC4 (integration):** vitest harness asserts: (i) a synthetic story spec with a `user-surface` AC and no smoke evidence in the run log causes `ship.py pre-pr-gate` to exit `USER_SURFACE_UNVERIFIED`; (ii) the same story with a `user_surface_verified` event passes the gate; (iii) a synthetic story with no `user-surface` ACs is unaffected by the gate; (iv) the gate's event-schema rejects malformed evidence (missing AC ref, missing pasted output) with a typed error.

## Story 1.9: Ship a pre-built `dist/` with the plugin

As an end-user installing the flow plugin via `/plugin install flow@flow`,
I want the MCP server to start without me having to run any build step first,
So that the install path documented in the README actually works on a fresh clone, not just on a machine where `plugins/flow/mcp-server/dist/` happens to be built locally.

**Context:** `/plugin install` copies the plugin's working tree into `~/.claude/plugins/cache/`. `mcp-server/dist/` is gitignored, so a fresh clone has no build artefacts — the install copies nothing, and the MCP server fails to start with module-not-found. PR #61 only worked because Jack's local working tree happened to have a fresh `dist/` from a manual rebuild. v1 ships locally-installed; we don't have an npm-publish step that could build artefacts at publish time. Trade-off picked: commit `dist/` to git. Cleaner-but-slower alternative (postinstall build via `prepare` script) deferred to a later revisit if the committed-artefacts pain shows up.

**Acceptance Criteria:**

**Given** a freshly cloned repo with no prior `pnpm install` or `pnpm build` run, **When** Jack (or any operator) runs `/plugin marketplace add ./` → `/plugin install flow@flow` → restarts Claude Code, **Then** `/flow:status` dispatches to the MCP server and returns the expected typed pre-3.3 error (or, post-3.3, the rendered five-line block). Verified per Story 1.8's smoke gate.

**Given** the gitignore configuration, **When** I `git status` after a clean checkout, **Then** `plugins/flow/mcp-server/dist/` is tracked and present (un-gitignored), the working tree is clean, and a `pnpm build` produces a byte-identical (or content-equivalent) `dist/` to what's committed.

**Given** a CI run on any branch, **When** CI builds the plugin, **Then** CI verifies that the committed `dist/` matches a fresh `pnpm build` output — drift between source and committed artefact fails CI. _(prevents the "shipped a stale dist" failure mode that bit us during 1.7)_

**AC4 (integration):** vitest harness covers: (a) the dist-vs-source-rebuild equivalence check that CI runs locally; (b) a sentinel test that imports `dist/index.js` and `dist/tools/register.js` and asserts the exports exist (catches partial-build / missing-tools-directory regressions like the one PR #61 fixed).

## Story 1.10: README rewrite — match observed Claude Code UI reality

As Maya the relatively-technical non-engineer following the install README on a clean machine,
I want every command and confirmation in the README to behave exactly as the README claims,
So that I don't hit "the docs said I'd see X, but Claude Code showed me a UI panel" mid-install and lose trust in whether the rest of the plugin works.

**Context:** The current `plugins/flow/docs/README-install.md` describes `/plugin marketplace add` as printing a stdout confirmation line. In Claude Code 2.1.144 it actually opens an interactive Marketplaces TUI panel. Same shape for `/plugin install`. The README's "Expected confirmation" copy is fiction — written by an agent that never ran the commands. Story 1.10 rewrites the README based on what Jack actually observed during the PR #61 pair-debug, and routes itself through Story 1.8's new smoke gate as the first concrete proof-of-concept.

**Acceptance Criteria:**

**Given** the rewritten README, **When** Maya follows it step-by-step on a clean machine with a fresh checkout, **Then** every "Expected confirmation" block describes the actual observed UI state (TUI screenshot, literal toast text, or the named tab the user lands on) — no fictional stdout lines, no commands that don't exist as written.

**Given** the rewritten README, **When** I diff it against what Jack observed in the PR #61 debug session, **Then** the README's step 3 covers the TUI flow (open marketplaces list, see entries, add `./`, confirm), step 3b covers `/plugin install flow@flow` and the `temp_local_*` cache caveat surfaced on validation failure, and step 4 explains MCP servers only start on Claude Code launch so the restart is non-optional.

**Given** the rewritten README contains command literals (e.g. `/plugin marketplace add ./`, `/plugin install flow@flow`), **When** a vitest test runs the README through a regex check, **Then** every literal in a fenced code block tagged `bash` or `text` is one that's been verified against real Claude Code at least once (referenced by `user_surface_verified` event ID in the story's run log).

**AC4 (smoke + integration):** the story flows through Story 1.8's new smoke gate. The gate's `user_surface_verified` event records Jack (or an operator) running each README command verbatim in a real Claude Code session, pasting the observed UI/toast/output for each step, and confirming match-vs-mismatch with the rewritten copy. Any mismatch fails the gate; the README must be edited until reality and copy agree. vitest additionally asserts `docs/README-install.md` parses as valid Markdown and every internal link resolves.

## Story 1.11: Dev-install loop — make plugin changes visible without a daemon restart

As an engineer iterating on the flow plugin,
I want a one-command dev-install path that makes my local changes (worktree or main) visible to a fresh Claude Code session without manual `/plugin uninstall` + reinstall dances or file-overlay hacks into `~/.claude/plugins/cache/...`,
So that every future `story_shape: user-surface` story can actually pass its smoke gate end-to-end instead of being shipped via the automated-route escape hatch.

**Context:** Discovered the hard way during Story 3.2 (PR #90). The current install path resolves `flow@flow` to a copy of `/Users/<user>/projects/crew/` (main branch) under `~/.claude/plugins/cache/crew/crew/0.1.0/`. Changes on a feature branch in a worktree are invisible until a manual reinstall — and reinstall wipes any file overlays. Worse, Claude Code's plugin daemon caches the skill index across sessions, so even after a correct file is in the cache, `/reload-plugins` doesn't re-scan; only killing the daemon (or a full Claude Code restart) does. The result: the pre-PR user-surface gate could not be satisfied for `/flow:scan` on 3.2, and the story shipped via the automated-route fallback with a known evidence gap. Every subsequent user-surface story (3.5, 3.6, 4.x slash commands, …) will hit the same wall until this is fixed.

**Acceptance Criteria:**

**Given** a working tree on any branch (main or worktree) with local plugin changes (modified `skills/`, `mcp-server/src/`, or `mcp-server/dist/`), **When** I run a single documented dev-install command from the repo root (e.g. `pnpm dev:install` — exact name TBD by spec), **Then** the installed plugin cache at `~/.claude/plugins/cache/crew/crew/<version>/` reflects the current working-tree state (skills, dist, catalogue) — verifiable by `diff -r` between source and cache, or a sentinel substring assertion.

**Given** the dev-install has run, **When** a fresh Claude Code session is launched in this repo, **Then** the slash-command picker lists every skill present under `plugins/flow/skills/` (including any new ones added since the last "real" `/plugin install`) — i.e. the daemon's skill-index cache no longer masks the new state. _(The mechanism — daemon kill, cache-invalidation file, symlink trick, or whatever the spec chooses — is an implementation detail.)_

**Given** the dev-install is re-run twice in a row with no source changes, **When** I observe the cache state and any side effects (daemon restarts, file mtimes), **Then** the second run is a no-op (idempotent) — no destructive re-copy, no daemon thrash unless the source actually changed.

**Given** the dev-install fails partway (e.g. uncommitted changes in a state the script doesn't trust, or the daemon refuses to restart), **When** the script exits, **Then** it exits non-zero with a clear human-readable error and the cache is left in a recoverable state — never silently broken.

**Given** the repo's `docs/README-install.md` (operator-facing) and a new engineer-facing dev-loop doc, **When** an engineer reads either doc, **Then** the production install path (`/plugin install flow@flow`) and the new dev-install path are clearly distinguished, with one short paragraph explaining when to use which.

**AC6 (deterministic content-structure anchor):** vitest assertion that the dev-install script file exists at the documented path, is executable, and contains the substring identifying its core mechanism (e.g. `~/.claude/plugins/cache/crew/crew` — proving the script targets the right cache location). Plus: the engineer-facing dev-loop doc contains the substring naming the script command (e.g. `pnpm dev:install`) so docs and reality stay in sync.

**AC7 (integration):** vitest scenario that, given a temp source dir simulating a worktree and a temp cache dir simulating `~/.claude/plugins/cache/`, the dev-install script (a) populates the cache from the source, (b) running it again with no changes is a no-op (mtime preserved on key files), (c) running it after editing a `skills/<x>/SKILL.md` propagates only that file. The actual Claude Code daemon interaction is out of scope for vitest — that part is verified by the story's user-surface smoke gate.

---

## Story 1.12: `ship-story` base-branch override and worktree-spec auto-discovery

As an operator running `/ship-story` against a non-`main` trunk (today: `dev`, post 2026-05-25 rollback),
I want `ship.py` to fork worktrees off the configured trunk, `gh pr create` to target it without a manual `--base` flag, and `pre-pr-gate` to find worktree-only specs without `--spec-path`,
So that every Epic-5+ ship runs end-to-end without the three friction patches that bit every Phase B ship (TEMP `ship.py` hand-edit `d3e1c81`, manual `--base dev`, manual `--spec-path`).

**Context:** Captured across Phase B sessions 2/3/4 handoffs and Epic 4 retro § Carry-forward. The TEMP `d3e1c81` commit on `dev` routes worktree fork from `origin/main` → `origin/dev`; it survives because no story owns the proper fix yet. The `gh pr create` template in `plugins/flow/.claude/skills/ship-story/SKILL.md` Step 9 omits `--base`, defaulting to `main` and forcing post-hoc `gh pr edit --base dev` recovery (PR #151 opened with 11 commits before this was caught). The `pre-pr-gate` resolves spec path via `resolve_json_path` fallback but the worktree-only case still trips it. All three are plumbing, not product. Single shipment.

**Acceptance Criteria:**

**Given** a `default_base` knob exposed on `ship.py` (configuration mechanism is implementer's call — env var, `.crew/ship.yaml`, or per-repo TOML — pick one and document), **When** `ship.py worktree <story_key>` runs with `default_base: dev` configured, **Then** the new worktree forks from `origin/dev` (verifiable via `git -C <worktree> rev-list --left-right --count HEAD...origin/dev` returning `0\t0`) and the TEMP hand-edit at commit `d3e1c81` on `dev` is reverted in the same story. _(Replaces the TEMP patch.)_

**Given** `ship.py` exposes the resolved trunk via a `default-base` subcommand (or equivalent — implementer's call), **When** `ship-story` Step 9 invokes `gh pr create`, **Then** the SKILL.md template passes `--base <resolved trunk>` so the PR opens against the configured trunk without operator intervention. _(Closes the manual-`--base` friction.)_

**Given** `ship.py pre-pr-gate <story_key>` runs without `--spec-path` AND the resolve-payload JSON at `/tmp/ship-<story_key>.resolve.json` references a spec inside a worktree the gate isn't cd'd into, **When** the gate resolves the spec path, **Then** it finds the spec via the worktree-absolute path computed from the worktree event in the run log (`<worktree>/<spec_path>`) — never falling back to the missing main-repo copy. _(Closes the `--spec-path` friction.)_

**Given** a green-field repo with no `default_base` configured, **When** `ship.py worktree` runs, **Then** it falls back to `origin/main` (current behaviour) so existing users see no surprise. _(Back-compat.)_

**AC5 (integration, vitest:):** vitest covers (a) worktree creation against `origin/dev` when `default_base=dev`, (b) PR-body / `gh` invocation honours the configured base via `--base <trunk>` (assert against the SKILL.md template or `ship.py` helper output), (c) `pre-pr-gate` finds a worktree-only spec without `--spec-path`, (d) green-field default-to-`main` back-compat path. Tests use the existing `ship.py` test patterns from prior plumbing stories.

---

## Story 1.13: `/flow:smoke` harness wrapper skill

As an operator running per-story operator-smokes against the plugin,
I want a single `/flow:smoke <label>` skill that stands up a clean scratch repo and chains `skip-hiring → plan → scan` with a tool-layer checkpoint between every step,
so that smoke runs start from a known-good state instead of burning 1–3 trials on setup drift (missing persona frontmatter, missing standards.md, planner failing on a no-commit repo) before the actual subject-under-test is ever exercised.

**Context:** Epic 4 burned this tax repeatedly — Story 4.6 alone needed seven trials before clean signal. The pattern is recurrent enough to be captured in memory (`project_smoke_harness_wrapper`, `project_operator_smokes_via_plan`). Story 4.14 (PR #146) implemented this exact wrapper but was closed unmerged in the 2026-05-25 rollback. This story re-ships the wrapper against post-rollback `dev` HEAD: the skill is renamed `/flow:smoke` (per the `/flow:<verb>` catalogue convention; the original `/flow:smoke-setup` predated the convention), the tool-count assertions are rebased onto current register.ts (31 tools → 32), and the SKILL.md log prefix becomes `[smoke]` to match. Substrate story — the operator invokes `/flow:smoke` interactively; AC verification is automated via vitest + structural-anchor test. The skill stops before `/flow:start` because `/flow:start` is the thing under observation.

**Acceptance Criteria:**

**AC1 (createSmokeScratchRepo MCP tool, vitest:):** A new MCP tool `createSmokeScratchRepo({ label, parentDir? })` lives at `plugins/flow/mcp-server/src/tools/create-smoke-scratch-repo.ts` and is registered in `register.ts` (bringing tool count from 31 → 32). It mkdtemps a directory under `<parentDir>` whose name starts with `crew-smoke-<label>-` followed by the random suffix Node's `fs.mkdtemp` appends (default `parentDir = os.tmpdir()`), runs git-init + an initial empty commit via `gitInitWithEmptyCommit` from `lib/git.ts` (so the AC6f canonical-fs-guard static check stays satisfied — no `git` spawns outside `lib/git.ts`), writes a minimal native-adapter `.flow/config.yaml`, copies `plugins/flow/docs/standards-example.md` to `.crew/standards.md`, and returns `{ scratchRoot, cleanup }` where `cleanup` is an idempotent rmtree closure. Verifiable via `tests/create-smoke-scratch-repo.integration.test.ts` exercising real `os.tmpdir()` (no stubs) — covers happy path, idempotent cleanup, label validation, `parentDir` override, git-init success, and standards.md byte-match (see spec Task 7.1 for the exact six scenarios). _(Helper covers AC2's checkpoint surface.)_

**AC2 (/flow:smoke SKILL.md, artifact:):** A new skill at `plugins/flow/skills/smoke/SKILL.md` named `flow:smoke` whose `allowed_tools` is exactly `[createSmokeScratchRepo, getTeamSnapshot, readBacklogInventory, listClaimableTodos]`. The body contains five numbered steps in order — `scratch-repo`, `skip-hiring`, `plan`, `scan`, `start` — each with an MCP-tool checkpoint call before advancing and an `[smoke] step N (<name>): ok` log-line shape (failure shape: `[smoke] step N (<name>): FAILED — <reason>`, halt). The checkpoint tool for each step is fixed: step 1 → `createSmokeScratchRepo`, step 2 → `getTeamSnapshot` (assert ≥1 role with both `hired_at` and `catalogue_version` populated — the Story 4.6 regression signal), step 3 → `readBacklogInventory` (assert ≥1 source story), step 4 → `listClaimableTodos` (assert ≥1 manifest in `.flow/state/to-do/`), step 5 → no tool. Step 5 prints `Ready. Run /flow:start in this scratch repo.` and returns control to the operator — the skill MUST NOT auto-invoke `/flow:start`.

**AC3 (structural-anchor test, vitest:):** A new test at `plugins/flow/mcp-server/src/skills/__tests__/smoke-skill-content.test.ts` mirrors `start-skill-content.test.ts`: reads the on-disk `plugins/flow/skills/smoke/SKILL.md`, splits its YAML frontmatter, and asserts (i) the frontmatter `name` equals `flow:smoke`, (ii) `allowed_tools` is the exact four-tool set above, (iii) all five step labels appear with their checkpoint tools, (iv) the `[smoke] step N (<name>): ok` and `[smoke] step N (<name>): FAILED — <reason>` log-line shapes are both present, (v) the final `Ready. Run /flow:start in this scratch repo.` handoff string appears, (vi) the skill body does NOT contain a literal call to `/flow:start` (so the skill cannot auto-invoke it).

**AC4 (tool-count rebase, vitest:):** All six tool-count assertions on current `dev` HEAD are bumped from 31 → 32 — the four primary sites in `tests/ask-mode-enforcement.test.ts`, `tests/ask-skill.test.ts`, `tests/get-team-snapshot.test.ts`, and `src/tools/__tests__/inner-cycle.integration.test.ts`, plus two pre-existing 31-asserting tests in `compute-agreement.test.ts` and `run-auto-merge-gate.test.ts`. The inline `// Story 4.x added …` comment trail in `inner-cycle.integration.test.ts` is extended with `Story 1.13 added createSmokeScratchRepo (32)`. Any missed assertion will fail CI.

**AC5 (log-prefix non-collision, artifact:):** The `[smoke] step N (<name>): ok` and `[smoke] step N (<name>): FAILED — <reason>` prefixes do not collide with the dev/reviewer parser sentinels (`Handoff to reviewer — `, `**Verdict: `, `READY FOR MERGE`, `BLOCKED`, `done-blocked-*`). Verifiable by grep over `plugins/flow/mcp-server/src/tools/process-dev-transcript.ts` and `process-reviewer-transcript.ts` showing no overlap with any literal in this story's SKILL.md.

**AC6 (no /flow:start auto-invocation, artifact:):** Manual verification — running `/flow:smoke <label>` in a session leaves the operator at a prompt; it does not spawn or chain into `/flow:start`. Covered structurally by AC3(vi) but called out explicitly because this is the load-bearing design choice (the whole purpose of the smoke is for the operator to observe `/flow:start` themselves).

---
