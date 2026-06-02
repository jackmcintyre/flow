# Requirements Inventory

## Functional Requirements

**Planning conversation (FR1–FR8):**

- FR1: User can open a planning conversation via `/<plugin>:plan`.
- FR2: Planning agent interprets free-form intent into a candidate set of stories.
- FR3: Planning agent produces story files conforming to story-file shape (≥90% commit-without-structural-edits over rolling 20-cycle window).
- FR4: Planning agent elicits ACs at the user-value level, not implementation level.
- FR5: Planning agent detects state-mutating stories and requires at least one integration AC.
- FR6: Planning agent detects implicit cross-story dependencies and prompts user to make them explicit in `depends_on`.
- FR7: Planning agent refuses to commit a backlog missing a ship-gate story.
- FR8: Planning agent can be re-opened mid-cycle to add, modify pending, or discard via a revert story.

**Story files & backlog management (FR9–FR14):**

- FR9: Each story persisted as Markdown file with YAML frontmatter under `stories/{to-do,in-progress,blocked,done}/`. *(Superseded by execution-manifest layer per architecture §Planning Adapter Model — see Additional Requirements.)*
- FR10: Story frontmatter carries `id`, `title`, `depends_on`, `status`, `blocked_by`, `claimed_by`, `risk_tier`.
- FR11: Story frontmatter carries retro fields after completion: `lessons[]` (each with `kind:` ∈ `pitfall|pattern|tool-quirk|discipline`), `failure_class`, `duration_seconds`, `rework_count`. Retro agent routes lessons by `kind`.
- FR12: Story body carries narrative description, ACs (≥1 integration AC for state-mutating), implementation notes.
- FR13: Plugin validates story files and refuses malformed with human-readable error.
- FR14: User can edit any story directly while in `to-do/` or `blocked/`; not `in-progress/`.

**Continuous-flow runtime (FR15–FR23):**

- FR15: User launches dev session via `/<plugin>:start`.
- FR16: User launches orchestration session via `/<plugin>:watch`.
- FR17: Plugin claims story by atomic move `to-do/` → `in-progress/`.
- FR18: Plugin verifies `depends_on` by checking presence in `done/`; refuses claim if deps unmet.
- FR19: Plugin completes story by atomic move `in-progress/` → `done/`.
- FR20: Plugin blocks story by atomic move `in-progress/` → `blocked/` with `blocked_by` set.
- FR21: Dev session picks next available story after blocking the current; never waits for blocker resolution.
- FR22: Dev session terminates when `to-do/` and `in-progress/` are both empty.
- FR23: All three sessions relaunch from filesystem state without corruption.

**Dev loop (FR24–FR29):**

- FR24: Dev session spawns per-story dev subagent from clean context.
- FR25: Dev subagent implements story against narrative + ACs.
- FR26: Dev subagent signals handoff to reviewer via locked phrase.
- FR27: Dev session spawns per-story reviewer subagent from clean context.
- FR28: Dev subagent records integration-AC failure as a rework signal, not a story failure.
- FR29: Dev subagent's terminal action: `git push` and `gh pr create`.

**Review & verdict (FR30–FR42, FR40a):**

- FR30: Reviewer reads story file, diff, and `docs/standards.md`.
- FR31: Reviewer runs story ACs as part of review.
- FR32: Reviewer judges diff against `docs/standards.md`.
- FR33: Reviewer posts inline review comments.
- FR34: Reviewer posts summary verdict comment with final line matching locked grammar (`READY FOR MERGE` / `NEEDS CHANGES [N issues, M questions]` / `BLOCKED [<reason>]`).
- FR35: Verdict comment stamps both standards-doc version and plugin semver.
- FR36: Reviewer applies labels `reviewed-by-agent` (always) and `needs-human` (on NEEDS CHANGES / BLOCKED / failure).
- FR37: Reviewer cannot close, merge, or request changes (negative capability, allowlist-enforced).
- FR38: Reviewer cannot push commits or edit repo files (negative capability).
- FR39: Reviewer re-invocation finds prior verdict by footer marker and edits in place.
- FR40: Auto-merge on `READY FOR MERGE` only when `risk_tier=low` AND rolling agreement metric ≥ threshold (default 80%).
- FR40a: Risk-tier classification spec (`docs/risk-tiering.md`, YAML+Markdown) is a v1 architecture deliverable; until rules drafted, planner assigns `risk_tier` manually with user confirmation.
- FR41: Plugin pauses medium/high risk PRs for the user regardless of verdict.
- FR42: User can merge any PR manually (override authority preserved).

**Standards doc (FR43–FR48):**

- FR43: Plugin locates `docs/standards.md` at conventional path.
- FR44: Plugin parses standards.md: version, criteria (name, what, check, anti-criterion), updated date.
- FR45: Missing/malformed standards.md → clear error pointing at example template.
- FR46: Refuses to run if standards.md declares >10 criteria (hard cap).
- FR47: Plugin ships `docs/standards-example.md` as copy-target.
- FR48: Plugin deterministically regenerates `docs/standards.md` from `discipline-rules.yaml` on accept-proposal.

**Orchestration & blockers (FR49–FR54):**

- FR49: Orchestration session polls `in-progress/` and `blocked/` on loop (default 120s, configurable).
- FR50: Detects stuck stories (in-progress beyond timeout) and surfaces them.
- FR51: Detects stale claims (`claimed_by` references non-live session) and surfaces them.
- FR52: Surfaces blockers/stuck/stale as a one-line terminal surface per item.
- FR53: User resolves blocker by editing story and moving to `to-do/` (or letting orchestration move on clear `blocked_by`).
- FR54: Orchestration cannot mutate dev-loop state directly; can only surface or (optionally) move resolved blockers back.

**Retro & calibration (FR55–FR64a):**

- FR55: Reviewer records story-level retro entries (`lessons[]`, `failure_class`, duration, rework count) on completion.
- FR56: User invokes cycle-level retro via `/<plugin>:retro`.
- FR57: Retro agent reads all story retros in cycle, rule registry, outcome stats.
- FR58: Retro agent produces a single proposal markdown at `_bmad-output/retro-proposals/<ISO-timestamp>.md`.
- FR59: Proposal file contains failure-driven rule proposals and success-driven skill proposals (and team-change + retirement, per FR105 / FR64a).
- FR60: Retro agent cannot mutate rule registry, standards doc, sprint-history, or plugin skills directly (negative capability).
- FR61: User applies proposals via `/<plugin>:accept-proposal <id>` with diff-then-confirm.
- FR62: Plugin applies rule proposals by mutating `discipline-rules.yaml` and regenerating standards.
- FR63: Plugin applies skill proposals by writing `SKILL.md`; refuses to overwrite existing path.
- FR64: Plugin detects promotion threshold hits for any `failure_class` and flags for retro agent.
- FR64a: Retro agent detects stale rules (no fire for M=5 cycles, configurable) and emits retirement proposal (retire or relax to advisory); user-gated apply.

**Telemetry & outcome verification (FR65–FR70):**

- FR65: Structured local log entry per agent invocation: agent type, story id, wall-clock runtime, timestamp.
- FR66: Structured log entry per reviewer verdict: PR number, verdict, standards version, eventual merge action.
- FR67: Plugin computes rolling verdict-vs-action agreement metric across configurable window.
- FR68: Plugin computes outcome stats per rule: target-failure-class fire counts before/after `introduced_at` + delta.
- FR69: Plugin archives drained cycle state to `_bmad-output/sprint-history/<cycle-id>-<timestamp>.yaml`.
- FR70: User can read all telemetry artifacts as local files; no remote service.

**Install, distribution & onboarding (FR71–FR75):**

- FR71: Plugin installable by clone+load; no npm, no remote channel.
- FR72: Plugin ships bundled example target repo at `plugins/<plugin>/example/`.
- FR73: README walks install path end-to-end with verifiable checkpoints.
- FR74: Plugin runs in same-repo (Jack) and split-repo (Maya) configurations.
- FR75: One-page session-death recovery guide in README.

**Non-engineer ergonomics (FR76–FR78):**

- FR76: Planning agent consultable in separate session about a reviewer verdict without breaking dev loop ("translate this comment" affordance).
- FR77 (guideline, non-testable): Planning agent produces stories in plain language; shaped via persona prompts and retros.
- FR78: Planning agent supports "discard a built feature" as a first-class outcome producing a revert/deprecate story.

**Permissions & authority (FR79–FR81):**

- FR79: Every agent declares allowed tools and `gh` subcommands in version-controlled spec.
- FR80: Plugin runtime enforces permissions at the tool layer, not prompt.
- FR81: No agent mutates canonical state without user confirmation or dedicated MCP tool boundary.

**Team formation & persona management (FR82–FR97):**

- FR82: Plugin ships catalogue at `plugins/<plugin>/catalogue/<role>.md` declaring `domain`, model tier, tool allowlist, locked phrases, prompt body.
- FR83: Catalogue includes at minimum planner, generalist dev, generalist reviewer, retro analyst, orchestrator, security specialist, test specialist, docs specialist, debugger.
- FR84: User opens hiring conversation via `/<plugin>:hire`.
- FR85: Hiring manager reads target repo at high level (language, layout, README, recent git, deps).
- FR86: Hiring manager recommends starting team with one-sentence justification per role.
- FR87: Defaults to general-purpose roster when no specialist signals.
- FR88: User can approve all, subset, decline, or request specific role.
- FR89: Plugin instantiates hired role as persona file at `<target-repo>/team/<role>/PERSONA.md`.
- FR90: `/<plugin>:hire` re-runnable to edit existing team composition.
- FR91: "Skip hiring, use default team" fast path.
- FR92: Hiring manager cannot generate new specs outside catalogue in v1 (negative); manual escape hatch at `<target-repo>/team/custom/`.
- FR93: Each agent reads its persona file at session start.
- FR94: Each agent proposes appends to its persona's knowledge section at session end.
- FR95: Persona-knowledge appends are diff-then-confirm gated in v1.
- FR96: User can read/edit any persona file directly in a text editor.
- FR97: Persona files version-controlled in target repo; `git revert` recoverable.

**Domain-aware yield protocol (FR98–FR104):**

- FR98: Every catalogue role declares a `domain:` field (short string).
- FR99: Plugin runtime looks up hired roles by `domain:` for routing.
- FR100: Hired agent yields via locked phrase ("This sits in <role>'s domain — handing off"); runtime routes automatically; routing-failure surfaces as a blocker, not silently swallowed.
- FR101: Specialist refuses to defer inside its own domain (in-domain insistence).
- FR102: Generalist yields when work falls inside a hired specialist's domain (out-of-domain deference).
- FR103: Each yield handoff recorded in telemetry.
- FR104: When no hired role's domain matches, the lane generalist handles it without yield.

**Team-change proposals & team observability (FR105–FR110):**

- FR105: Retro analyst emits team-change proposals (hire / unhire) alongside rule/skill proposals.
- FR106: Each team-change proposal includes proposed action, target role, justification, predicted impact.
- FR107: User applies team-change via `/<plugin>:accept-proposal <id>`; hire hands off to hiring manager; unhire archives persona.
- FR108: `/<plugin>:team` shows current roster, domains, fire counts, recent knowledge appends.
- FR109: `/<plugin>:ask <role>` opens side-session with a hired role without mutating dev-loop state.
- FR110: `computeOutcomeStats` reports failure-class fire counts before/after each team-composition change.

## NonFunctional Requirements

**Performance:**

- NFR1: Reviewer wall-clock ≤3 min soft on typical PR (≤500 LOC, ≤10 criteria).
- NFR2: Reviewer >8 min hard → treated as failed, routed to failure path; story not marked failed.
- NFR3: Dev subagent >30 min (configurable) → stuck; surfaced by orchestration.
- NFR4: Orchestration polling pass completes in ≤30s under normal load.
- NFR5: Clean-machine install → first merged PR ≤1 hour for first-time user.

**Reliability:**

- NFR6: No silent failures — every invocation produces a visible artifact. CI-asserted by pairing every JSONL invocation with an artifact at its sink.
- NFR7: Session death recoverable by re-running launching skill; integration test kills each session at three checkpoints (mid-claim, mid-dev, post-handoff-pre-review) and asserts invariants.
- NFR8: State transitions atomic (single `mv` / `fs.rename` syscall); no story observed in two states.
- NFR9: Agent failure never mutates story canonical state from done-shaped to failed-shaped or vice versa; fault-injection-tested.
- NFR10: Skill invocations idempotent — re-run resumes or no-ops with clear message; integration-tested via back-to-back invocation.
- NFR11: Reviewer re-run produces same PR-state shape (one verdict, one set of inline, one set of labels) — no stacking.

**Security & permissions:**

- NFR12: Bounded agent authority — only declared tools usable; enforced at runtime, not prompt.
- NFR13: No silent authority escalation — permission spec changes go through PR review.
- NFR14: No remote data exfiltration — only user's GitHub (via `gh`) and configured Claude Code model API.
- NFR15: Local-first by construction — all state on user's filesystem.
- NFR16: Negative capabilities enforced at tool allowlist (reviewer cannot merge/push/edit; retro cannot mutate registry; planner cannot commit without confirmation).

**Integration:**

- NFR17: `gh` CLI is the only GitHub surface — no new tokens, no GitHub Apps, no REST/GraphQL clients.
- NFR18: `gh` errors classified as recoverable via versioned `gh-error-map.yaml` (exit codes + stderr patterns → defer | retry | needs-human); integration-tested.
- NFR19: Filesystem is the only inter-session coordination surface — no daemon, no shared in-memory store, no broker.
- NFR20: Claude Code is the only runtime — no bundled runtime, no separate process manager.

**Observability:**

- NFR21: Structured JSONL telemetry per agent invocation — single-line, well-typed, parseable without LLM.
- NFR22: Every verdict comment stamps standards-doc version AND plugin semver.
- NFR23: Outcome stats computable at any time without LLM in loop — deterministic helper.
- NFR24: Agreement metric computable at any time without LLM in loop.
- NFR25: Persona files plain Markdown, human-readable, editable, git-committable.
- NFR26: Persona-knowledge appends diff-then-confirm gated in v1; no silent self-mutation.
- NFR27: Persona files version-controlled; `git revert` recoverable.
- NFR28: Current team state (roster, domains, fire counts, recent knowledge appends) readable without LLM.
- NFR29: Every yield handoff recorded in telemetry with both roles named and triggering domain.

**Explicitly out of v1 NFRs:** scalability, accessibility (no plugin-owned UI), localisation (English only), RBAC/multi-user, backwards compatibility (greenfield).

## Additional Requirements

(Drawn from the architecture decision document — technical/structural requirements that shape how stories must be built, separate from FR/NFR.)

**Starter template & scaffolding (Epic 1 Story 1 driver):**

- **No external starter.** Scaffold the plugin skeleton directly against the Claude Code plugin contract.
- **First implementation story = scaffold the plugin skeleton** at `plugins/flow/` with `.claude-plugin/plugin.json`, pnpm workspace, empty MCP server entrypoint, and empty `bmad` adapter returning a hardcoded empty list. Zero behaviour; establishes every path/schema/import the rest depends on.

**Technology stack (pinned by architecture, inherits sprint-orchestrator precedent):**

- TypeScript on Node (LTS); pnpm workspace at plugin root.
- `@modelcontextprotocol/sdk` for MCP server (current stable, pinned at scaffold time).
- Zod for frontmatter validation; `yaml` (eemeli) package for `discipline-rules.yaml` (comment-preserving).
- vitest for unit + integration tests.
- pino for JSON-by-default logging (JSONL is the telemetry).
- execa for `gh` invocation wrapper with per-agent subcommand allowlist enforced before invocation.
- No path aliases in v1; relative imports only.
- No `any`; types derived from Zod schemas via `z.infer`. No default exports — named only.

**Two-tree project layout:**

- **Plugin tree** at `plugins/flow/` containing `.claude-plugin/plugin.json`, `catalogue/<role>.md` (10 role templates), `skills/<command>.md` (11 skills incl. `plan`, `start`, `watch`, `retro`, `accept-proposal`, `hire`, `team`, `ask`, `status`, `skip-hiring`, `scan`), `permissions/<role>.yaml` + `gh-error-map.yaml`, `mcp-server/src/{adapters,tools,schemas,state,lib,validators}/`, `mcp-server/tests/{unit,integration,fixtures}/`, `docs/{standards-example.md, risk-tiering.md, discipline-rules.example.yaml, README-install.md, session-recovery.md}`, `example/` (bundled BMad-shaped target repo).
- **Target-repo tree** owned by the plugin: `<target-repo>/.flow/{config.yaml, state/{to-do,in-progress,blocked,done}/<ref>.yaml, sessions/<ulid>.json, telemetry/<YYYY-MM>.jsonl, retro-proposals/<ts>.md, sprint-history/<cycle>-<ts>.yaml, native-stories/<ref>.md (native adapter only)}`, `<target-repo>/team/<role>/PERSONA.md` (+ `custom/`, `_archived/`), `<target-repo>/docs/{standards.md, risk-tiering.md (optional override), discipline-rules.yaml}`.

**Planning Adapter Model (supersedes FR9 path literal):**

- Source files belong to the planning tool (BMad first; native fallback; Linear/GitHub Issues later via the same interface) and are read-only.
- Plugin owns an execution-manifest layer at `<target-repo>/.flow/state/<state>/<ref>.yaml`. Atomic `fs.rename` between four state directories. (PRD's literal `stories/{state}/` is replaced; FR9 intent — atomic-filesystem state machine — is preserved.)
- Story refs use `<adapter>:<source-id>` (e.g. `bmad:1.2.3`); native adapter uses `native:<ULID>`.
- Adapter contract (`PlanningAdapter` interface) at `mcp-server/src/adapters/<name>/`: `detect`, `listSourceStories`, `readSourceStory`, `resolveSourcePath`, optional `watchForChanges`. Adapters self-register via `mcp-server/src/adapters/registry.ts`.
- Normalised internal `SourceStory` shape is the contract that matters across adapters.
- `validateAgainstDiscipline(SourceStory)` is added to the adapter contract — planning-discipline (FR3/FR5/FR7) shifts from authoring-time to scan-time for external adapters. Non-conforming source stories surface as blockers (`blocked_by: planning-discipline`).
- BMad adapter is v1's reference implementation. BMad-format spike required *before* the BMad-adapter implementation story.
- Native adapter authors stories under `<target-repo>/.flow/native-stories/<ref>.md` for users without a planning tool.
- Active adapter resolved on every skill invocation from `<target-repo>/.flow/config.yaml`; `detect()` runs on first invocation if no config; first-match wins; ambiguity prompts the user.

**Source-drift handling:**

- `source_hash` (sha256 of source file at claim time) stored in manifest.
- Dev/reviewer recompute hash at read; mismatch raises `SourceDriftError`; calling skill blocks story with `blocked_by: source-drift`; orchestration surfaces it as a distinct one-line surface.
- User resolves by editing manifest hash, reverting source edit, or dropping the story.

**Workspace resolution:**

- Per-target-repo config at `<target-repo>/.flow/config.yaml` marks the repo as a valid target; plugin reads on every skill invocation.
- Plugin location read from Claude Code's plugin loader.
- Same-repo and split-repo configurations treated identically.

**Heartbeat-based session liveness:**

- Each session writes a heartbeat at `<target-repo>/.flow/sessions/<session-id>.json` every N seconds (configurable).
- Orchestration treats `claimed_by` with no heartbeat in last `2× interval` as stale; no lockfile recovery rituals.

**Telemetry pipeline:**

- JSONL at `<target-repo>/.flow/telemetry/<YYYY-MM>.jsonl`, monthly rollover, append-only.
- Discriminated-union events on `type` field: `agent.invoke`, `reviewer.verdict`, `yield.handoff`, `retro.proposal`, `state.transition`, `team.change`, `persona.append`, `skill.invoke`. Closed Zod-validated schemas per type. No PII / no diff contents in telemetry.
- Stats helpers (`computeAgreement`, `computeOutcomeStats`, `computeSkillEffectiveness`) are pure TS, exposed as MCP tools and CLI commands; identical code path for user and agents.

**Risk-tier classification (FR40a deliverable):**

- Spec at `plugins/<plugin>/docs/risk-tiering.md` (shipped default) + optional override at `<target-repo>/docs/risk-tiering.md`.
- Format: YAML block declaring `tiers:` with `path_patterns`, `change_types` (revert / migration / schema / dep-bump), `diff_size_thresholds` + Markdown body explaining each tier.
- Fallback when no rule matches: `medium` (pauses for user).
- Default-rule *content* drafted in a later working pass (format pinned; content can iterate). Until then planner assigns manually with user confirmation.
- Classifier output stamped into manifest `risk_tier` and verdict comment.

**Locked phrases (exact strings, code-tested, breaking-change on edit):**

- Dev→Reviewer handoff: `Handoff to reviewer — story <ref> ready for review.`
- Yield to specialist: `This sits in <role>'s domain — handing off.`
- Verdict line: `**Verdict: READY FOR MERGE**` / `**Verdict: NEEDS CHANGES** [<N> issues, <M> questions]` / `**Verdict: BLOCKED** [<reason>]`.
- Verdict footer marker: `<!-- crew:verdict:<plugin-version>:<ref> -->`.
- Routing-failure surface: `[routing-failure] no hired role matches domain "<x>"`.

**Pattern conventions enforced in code:**

- Frontmatter conventions for plugin-owned artifacts only — YAML, `snake_case` keys, ISO-8601 dates, ULID ids, lower-case enums, YAML block sequences (not flow), Zod-validated.
- Native-adapter story body: exact `## Narrative`, `## Acceptance Criteria` (AC1, AC2... with `(integration)` tag), `## Implementation Notes`, `## Dependencies` (auto-generated, not hand-edited) sections.
- Catalogue + persona shape: same `##` skeleton; persona adds Knowledge section; `domain:` is the routing key (exact match required).
- MCP tool naming: camelCase verb-noun, flat namespace, no dot-prefixes; mutators start with verb of mutation; readers start with `get`/`list`/`lookup`/`compute`.
- TS code: `kebab-case.ts` files, `*.test.ts` co-located, typed `DomainError` subclasses for named failure modes, errors converted to MCP error responses at tool boundary.
- Dev subagent: branch `story/<ref-slug>-<title-slug>`, conventional commits, PR title `<type>(<ref>): <title>`, machine-section first in PR body. No `--no-verify`, no `--force-with-lease` without user request.
- gh allowlist: per-role at `plugins/<plugin>/permissions/<role>.yaml`; execa wrapper rejects any subcommand not in role's `gh_allow`; nested `gh_allow_args` for restricting `gh api` paths.

**Skill calibration loop (extends FR59):**

- Proposal types extended from three to seven: `rule`, `rule-retirement` (FR64a), `skill-create` (FR63), `skill-revise`, `skill-supersede`, `skill-retire`, `team-change` (FR105).
- New `skill.invoke` JSONL event with `skill_name`, `skill_path`, `skill_version`, `skill_scope` (`project|persona|plugin`), `invocation_source`.
- New MCP tools: `applySkillRevision`, `applySkillRetirement`, `computeSkillEffectiveness`, `recordSkillInvoke`.
- Skill frontmatter extended with `version`, `introduced_at`, `source_lesson_refs`, `supersedes`, `retired_at`.
- Skill retirement when over M=5 cycles either invoke count below threshold or "useful fire" ratio (READY-FOR-MERGE followed) below configurable floor (default 0.3).
- Derived metric: **constructive-to-defensive ratio** = accepted skill proposals / accepted rule proposals in window; exposed by `computeOutcomeStats`.

**Testing & CI deliverables:**

- vitest fault-injection harness running the MCP server against a temp directory and killing worker at three checkpoints (mid-claim, mid-dev, post-handoff-pre-review) — required to measure NFR7.
- CI-asserted no-silent-failures pairing test (NFR6 measurement): for every JSONL invocation entry, assert paired artifact at declared sink (PR comment, story-frontmatter field, orchestration-surface line, or `failure-log/` entry); CI fails on any unpaired invocation.
- Recoverable-error classification mapping table (`gh-error-map.yaml`) integration-tested by stubbing `gh` to return each mapped error class and asserting story stays in `in-progress/` or moves to `blocked/`, never failed (NFR18 measurement).
- Idempotency integration test invokes each `/<plugin>:*` skill twice back-to-back and asserts no new files / no new PRs / no duplicate comments / no duplicate knowledge entries (NFR10 measurement).
- Each adapter ships its own integration test suite against a committed fixture target repo of the relevant shape; BMad fixture committed under `mcp-server/src/adapters/bmad/fixtures/`.
- End-to-end canary: vitest drives the canonical scenario in `plugins/<plugin>/example/` against a temp clone.
- Out of v1: a Claude-Code-stub harness for full agent behaviour (LLM behaviour validated by calibration loop, not mocks).

**Distribution & configuration:**

- No npm channel, no auto-update; install path is "clone the repo and load the plugin."
- Plugin declares a semantic version in `.claude-plugin/plugin.json` manifest; reviewer verdict comments stamp the plugin version alongside standards version.
- No Claude Code hooks in v1 (skills + agents + MCP server only); hook registration is a deliberate Growth-phase decision.
- No deployment artifact, no docker, no service to run.

**Architectural boundaries enforced:**

- MCP server is the only canonical-state mutation boundary. Agents never raw-`fs.write` to canonical paths (story manifests, personas, standards, rule registry, telemetry); enforced by tool allowlist.
- Source story files are read-only — adapters are the only code path that reads them. No tool writes to `_bmad-output/` (or any external adapter's source location).
- Catalogue is read-only at runtime; hiring instantiates *into* `team/`. Catalogue changes happen via PR review only.
- Personas are read-mostly; appends go through `<persona>/.proposed.md` and `accept-proposal`.
- All `gh` interaction goes through `mcp-server/src/lib/gh.ts`. No direct child-process spawning of `gh` elsewhere.

## UX Design Requirements

Not applicable — no UX design specification exists for v1. The product's user-facing surface is (a) terminal text from Claude Code sessions, (b) GitHub PR comments rendered by GitHub, and (c) local Markdown files in the target repo. The plugin owns no UI. Accessibility and visual design concerns route upstream to Claude Code and GitHub.

## FR Coverage Map

- **FR1–FR8** → Epic 3 (planning conversation, native adapter)
- **FR9–FR14** → Epic 3 (story-file shape; FR9 satisfied by execution-manifest layer per Planning Adapter Model)
- **FR15** → Epic 4 (`/start`)
- **FR16** → Epic 5 (`/watch`)
- **FR17, FR18** → Epic 4 (claim story, dependency check)
- **FR19** → Epic 4 (complete story)
- **FR20, FR21** → Epic 5 (block story, dev keeps draining)
- **FR22** → Epic 4 (dev terminates on empty queue)
- **FR23** → Epic 5 (relaunch from filesystem)
- **FR24–FR29** → Epic 4 (dev loop)
- **FR30–FR42, FR40a** → Epic 4 (review, verdict, risk-tier, auto-merge gate, override)
- **FR43–FR47** → Epic 1 (standards lookup, parse, missing-error, hard cap, shipped template)
- **FR48** → Epic 6 (regenerate `standards.md` from rule registry)
- **FR49–FR54** → Epic 5 (orchestration polling, stuck/stale detection, one-line surface, resolve)
- **FR55–FR60** → Epic 6 (story-level retro, `/retro`, proposal file, retro negative capability)
- **FR61–FR64a** → Epic 6 (`accept-proposal`, apply rule/skill, promotion threshold, retirement)
- **FR65, FR66** → Epic 4 (per-invocation telemetry, per-verdict log entries)
- **FR67** → Epic 4 (rolling agreement metric — gates auto-merge)
- **FR68, FR69, FR70** → Epic 6 (outcome stats, archive cycle, telemetry readable as local files)
- **FR71, FR73, FR74** → Epic 1 (install: clone-load, README walk, same-repo/split)
- **FR72** → Epic 7 (bundled example target repo)
- **FR75** → Epic 5 (session-death recovery guide)
- **FR76** → Epic 2 (translate-a-comment via `/ask`)
- **FR77** → Epic 3 (plain-language guideline in planner)
- **FR78** → Epic 3 (discard a built feature)
- **FR79, FR80, FR81** → Epic 1 (per-role permission specs, tool-layer enforcement, no canonical-state mutation without confirmation)
- **FR82–FR93** → Epic 2 (catalogue, hiring manager, hire flow, persona files, skip-hiring, custom escape hatch, session-start read)
- **FR94, FR95** → Epic 6 (persona-knowledge appends via `.proposed.md` + accept-proposal)
- **FR96, FR97** → Epic 2 (user reads/edits persona; version-controlled in target repo)
- **FR98–FR104** → Epic 4 (yield protocol — exercises in review)
- **FR105–FR107** → Epic 6 (team-change proposals + apply)
- **FR108, FR109** → Epic 2 (`/team`, `/ask <role>`)
- **FR110** → Epic 6 (outcome stats across team-composition changes)

NFR coverage:

- **NFR1, NFR2, NFR3** → Epic 4 (reviewer + dev runtime targets)
- **NFR4** → Epic 5 (orchestration polling cadence)
- **NFR5** → Epic 7 (install-to-first-merged-PR ≤1 hour for first-time user)
- **NFR6** → Epic 5 (no-silent-failures CI assertion)
- **NFR7** → Epic 5 (fault-injection harness; session-death recoverable)
- **NFR8** → Epic 1 (atomic `fs.rename` primitive established) — reinforced in E4/E5
- **NFR9** → Epic 5 (no story-state corruption on agent failure; fault-injection-tested)
- **NFR10** → Epic 5 (idempotent skill invocations, back-to-back integration test)
- **NFR11** → Epic 4 (reviewer rerun idempotency, footer-marker edit-in-place)
- **NFR12, NFR13, NFR14, NFR15, NFR16** → Epic 1 (security/permissions baseline; reinforced wherever capabilities land)
- **NFR17** → Epic 1 (`gh` is the only GitHub surface)
- **NFR18** → Epic 4 (`gh-error-map.yaml` classification, integration-tested)
- **NFR19, NFR20** → Epic 1 (filesystem-only coordination; Claude Code only runtime)
- **NFR21** → Epic 1 (JSONL telemetry plumbing) — populated by E4/E5/E6
- **NFR22** → Epic 4 (verdict stamps standards version + plugin semver)
- **NFR23** → Epic 6 (outcome-stats observability)
- **NFR24** → Epic 4 (agreement-metric observability)
- **NFR25** → Epic 2 (persona files plain Markdown, readable/editable)
- **NFR26** → Epic 6 (persona-update diff-then-confirm gate)
- **NFR27** → Epic 2 (persona files version-controlled in target repo)
- **NFR28** → Epic 2 (team-state observability without LLM)
- **NFR29** → Epic 4 (yield handoff telemetry)

All 110 FRs and all 29 in-scope NFRs are mapped to an epic.
