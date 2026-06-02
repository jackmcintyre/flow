# Epic 2: Team Formation — Hiring, Personas, and Team Observability

A user opens a hiring conversation, the hiring manager proposes a starting team with justifications, persona files are written, and the user can view the team or chat with a hired role.

## Story 2.1: Catalogue file format and shipped role templates

As a plugin maintainer,
I want all 10 v1 catalogue role templates shipped at `plugins/<plugin>/catalogue/<role>.md` in a single canonical shape,
So that the hiring manager has a fixed roster to pick from.

**Acceptance Criteria:**

**Given** the catalogue directory, **When** I list it, **Then** I see exactly: `hiring-manager.md`, `planner.md`, `generalist-dev.md`, `generalist-reviewer.md`, `retro-analyst.md`, `orchestrator.md`, `security-specialist.md`, `test-specialist.md`, `docs-specialist.md`, `debugger.md`. _(FR82, FR83)_

**Given** any catalogue file,
**When** it is parsed against the catalogue Zod schema,
**Then** it validates against required frontmatter (`role`, `domain`, `model_tier`, `tools_allow`, `gh_allow`, `locked_phrases.{handoff,yield,verdict}`) and required `##` sections (`Domain`, `Mandate`, `Out of mandate`, `Prompt`). _(FR82, Pattern §3)_

**Given** two catalogue roles' `domain:` fields, **When** compared, **Then** they are distinct strings (no domain collisions across the v1 catalogue). _(FR98, FR99)_

**AC4 (integration):** vitest parses every shipped catalogue file against the schema and asserts domain uniqueness.

## Story 2.2: Per-role permission spec files

As a plugin maintainer,
I want a `permissions/<role>.yaml` file for each catalogue role declaring its `gh_allow` and `gh_allow_args`,
So that the allowlist enforcement scaffolded in Story 1.4 has concrete contracts to enforce.

**Acceptance Criteria:**

**Given** every catalogue role from Story 2.1,
**When** I look at `plugins/<plugin>/permissions/`,
**Then** there's one YAML file per role plus `gh-error-map.yaml`. _(FR79)_

**Given** any permission spec, **When** it is parsed, **Then** it validates against the permissions Zod schema (role id matches catalogue role; `gh_allow` is a list; `gh_allow_args` is an optional restriction map).

**Given** the generalist-reviewer's permission spec, **When** I inspect it, **Then** `pr-close`, `pr-merge`, and any push-capable subcommands are absent (negative-capability encoded as omission). _(FR37, FR38, NFR16)_

**AC4 (integration):** vitest cross-checks: every catalogue role has a permissions file; the reviewer's allowlist excludes merge/close/push subcommands.

## Story 2.3: Persona-file machinery and persona MCP tools

As a plugin maintainer,
I want `read-catalogue`, `instantiate-persona`, `read-persona`, and `lookup-role-by-domain` MCP tools plus a persona Zod schema,
So that the hiring flow has a single boundary for creating and reading hired-team artifacts.

**Acceptance Criteria:**

**Given** a catalogue role and a target repo, **When** `instantiate-persona` is called, **Then** a persona file is written at `<target-repo>/team/<role>/PERSONA.md` containing `domain:`, prompt body copied verbatim from the catalogue, frontmatter `hired_at` (ISO-8601), `catalogue_version` (current plugin semver), and an empty `## Knowledge` section. _(FR89)_

**Given** an existing persona file, **When** `read-persona` is called, **Then** it returns the frontmatter and body without modification.

**Given** a hired team and a domain string, **When** `lookup-role-by-domain` is called, **Then** it returns the exact-match role or null (no fuzzy matching). _(FR99)_

**Given** any persona file, **When** I open it in a text editor and edit the body, **Then** subsequent `read-persona` calls reflect my edits and `git revert` restores prior state. _(FR96, FR97, NFR25, NFR27)_

**AC5 (integration):** vitest instantiates, reads, looks up by domain, and asserts plain-Markdown round-trip.

## Story 2.4: Hiring-manager agent and `/hire` skill

As a plugin operator,
I want to open a hiring conversation that reads my repo and proposes a starting team with justifications,
So that I get a team shaped by my project, not a generic roster.

**Acceptance Criteria:**

**Given** a target repo, **When** I run `/<plugin>:hire`, **Then** the hiring manager reads language, layout, README, recent git activity, and dependency manifest at a high level. _(FR85)_

**Given** the hiring manager's read of the repo, **When** it produces its proposal, **Then** the proposal includes the default roster (planner, generalist-dev, generalist-reviewer, retro-analyst, orchestrator) plus zero or more specialists, each with a one-sentence justification. _(FR86, FR87)_

**Given** the proposal, **When** the user responds, **Then** they can approve all, approve a subset, decline, or request a specific catalogue role not initially proposed; the hiring manager updates its plan and confirms before instantiation. _(FR88)_

**Given** a target repo with a hired team already in place, **When** I re-run `/hire`, **Then** the hiring manager surfaces the current roster and offers hire-one-more / unhire / view-persona actions (idempotent). _(FR90)_

**AC5 (integration):** vitest drives `/hire` against (a) a fresh empty repo and (b) a hired-team repo; both produce the expected proposal / edit-roster flows and instantiate persona files via Story 2.3's MCP tool.

## Story 2.5: `/skip-hiring` fast path and custom escape hatch

As a plugin operator,
I want a one-command "use the default team without an interactive flow" path,
So that I'm not blocked on a hiring conversation when I just want to try the plugin.

**Acceptance Criteria:**

**Given** a target repo with no hired team,
**When** I run `/<plugin>:skip-hiring`,
**Then** the default roster is hired directly (persona files written) with no interactive prompts. _(FR91)_

**Given** the hiring manager,
**When** asked to invent a role outside the v1 catalogue,
**Then** it declines with a clear message and points the user at the manual escape hatch under `<target-repo>/team/custom/`. _(FR92)_

**Given** a user-authored `<target-repo>/team/custom/<role>.md` matching the catalogue file schema,
**When** I re-run `/hire`,
**Then** the hiring manager can propose the custom role as if it were a catalogue role.

**AC4 (integration):** vitest asserts the skip-hiring fast path writes five persona files and that the hiring manager refuses to invent a role.

## Story 2.6: `/team` snapshot skill

As a plugin operator,
I want a one-shot view of my current team — roles, domains, recent persona-knowledge entries, fire counts,
So that I can check the team's state and history without parsing files by hand.

**Acceptance Criteria:**

**Given** a hired team,
**When** I run `/<plugin>:team`,
**Then** the output prints each role's id, `domain:`, last N knowledge entries (default 3), and fire count from telemetry. _(FR108, NFR28)_

**Given** the snapshot,
**When** computed,
**Then** it uses pure file reads + JSONL stats helpers — no LLM in the loop. _(NFR28)_

**AC3 (integration):** vitest runs `/team` against a fixture target repo with a hired team and seeded telemetry; asserts the expected lines.

## Story 2.7: `/ask <role>` side-session skill

As a plugin operator,
I want to ask a hired role a one-off question (e.g. "translate this reviewer comment") without breaking the dev loop,
So that I can lean on the team for clarification without mutating canonical state.

**Acceptance Criteria:**

**Given** a hired team and a chosen role,
**When** I run `/<plugin>:ask <role> "<question>"`,
**Then** a side-session opens with the role's persona prompt assembled, the user's question delivered, and the response printed back. _(FR76, FR109)_

**Given** the side-session, **When** any tool attempts a canonical-state mutation (story manifest, registry, telemetry, persona), **Then** the call is refused at the allowlist layer — `/ask` is non-mutating by contract. _(FR109)_

**Given** an `/ask` side-session,
**When** the role needs to read a PR (via `gh pr view`), a story manifest, a persona file, or `docs/standards.md` to answer the user's question,
**Then** the read is permitted — `/ask`'s non-mutating contract forbids canonical-state *writes*, not reads. This explicitly enables the translate-a-reviewer-comment affordance from FR76. _(FR76, FR109)_

**AC4 (integration):** vitest drives `/ask planner "explain this verdict comment"` against a fixture and asserts (a) no canonical-state mutation occurs, AND (b) the planner successfully reads the PR comment body via `gh pr view`.

## Story 2.8: Worktree-smoke workflow and 2.7 Task `_meta.role` verification

As a plugin maintainer,
I want a reliable way to smoke-test branch-specific plugin changes in a real Claude Code session and verified proof that Task propagates `_meta.role: "ask-mode"` for `/flow:ask`,
So that PR smoke tests aren't blocked on cache-reload quirks and the non-mutating contract of `/ask` is confirmed end-to-end.

**Acceptance Criteria:**

**AC1:** A developer can exercise `/flow:ask` from a worktree branch in a real Claude Code session without an unreliable uninstall+reinstall cycle (shell script, skill, or documented procedure that accounts for plugin-cache mechanics).

**AC2:** The `_meta.role: "ask-mode"` propagation through the Claude Code `Task` tool is verified — either confirming Task carries the field as expected (documented) or an alternative enforcement path is implemented and tested in its place.

---
