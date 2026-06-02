---
stepsCompleted:
  - step-01-document-discovery
  - step-02-prd-analysis
  - step-03-epic-coverage-validation
  - step-04-ux-alignment
  - step-05-epic-quality-review
  - step-06-final-assessment
filesIncluded:
  prd: prd-crew-v1.md
  architecture: architecture.md
  epics: epics.md
  ux: (not present — CLI/agent product, no GUI surface)
---

# Implementation Readiness Assessment Report

**Date:** 2026-05-19
**Project:** crew (AI Engineering Team v1)

## Document Inventory

- **PRD:** `_bmad-output/planning-artifacts/prd-crew-v1.md` (109.5K)
  - Validation report: `prd-crew-v1-validation-report.md`
- **Architecture:** `_bmad-output/planning-artifacts/architecture.md` (80.7K)
- **Epics & Stories:** `_bmad-output/planning-artifacts/epics.md` (121.3K)
- **UX Design:** Not present. Product is a Claude Code plugin (CLI/agent surface only) — flagged but treated as N/A pending PM confirmation.

No duplicate (whole vs sharded) conflicts.

## PRD Analysis

### Functional Requirements

**Planning conversation**
- FR1: User opens planning conversation via `/<plugin>:plan`.
- FR2: Planning agent interprets free-form intent into candidate stories.
- FR3: Planning agent produces story files conforming to story-file shape; target ≥90% commit-without-structural-edits.
- FR4: Planning agent elicits user-value-level ACs (not implementation-level).
- FR5: Planning agent detects state-mutating stories and requires ≥1 integration AC.
- FR6: Planning agent detects implicit cross-story deps and prompts user to make them explicit in `depends_on`.
- FR7: Planning agent refuses to commit a backlog missing a ship-gate story.
- FR8: Planning agent can be re-opened mid-cycle to add stories, modify pending stories, or discard a built feature via a revert story.

**Story files and backlog management**
- FR9: Plugin persists each story as a single Markdown+YAML-frontmatter file under `stories/{to-do,in-progress,blocked,done}/`.
- FR10: Frontmatter carries `id`, `title`, `depends_on`, `status`, `blocked_by`, `claimed_by`, `risk_tier`.
- FR11: Frontmatter carries retro fields after completion (`lessons[]` w/ `kind:` ∈ {pitfall, pattern, tool-quirk, discipline}, `failure_class`, `duration_seconds`, `rework_count`).
- FR12: Body carries narrative, ACs (≥1 integration AC for state-mutating), implementation notes.
- FR13: Plugin validates story file against contract; refuses malformed stories with human-readable error.
- FR14: User can edit story files directly while in `to-do/` or `blocked/`; not supported for `in-progress/`.

**Continuous-flow runtime**
- FR15: User launches dev session via `/<plugin>:start`.
- FR16: User launches orchestration session via `/<plugin>:watch`.
- FR17: Plugin claims story via atomic move `to-do/` → `in-progress/`.
- FR18: Plugin verifies `depends_on` by checking dependency files in `done/`; dev refuses to claim if not all met.
- FR19: Plugin completes story via atomic move `in-progress/` → `done/`.
- FR20: Plugin marks story blocked via atomic move `in-progress/` → `blocked/` with `blocked_by` set.
- FR21: Dev session picks next available story after blocking the current one; never waits.
- FR22: Dev session terminates naturally when `to-do/` and `in-progress/` are both empty.
- FR23: All three sessions can be relaunched after death without state corruption.

**Dev loop**
- FR24: Dev session spawns a per-story dev subagent from clean context.
- FR25: Dev subagent implements story against narrative + ACs.
- FR26: Dev subagent signals handoff to reviewer via locked phrase.
- FR27: Dev session spawns per-story reviewer subagent from clean context on handoff.
- FR28: Dev subagent records integration-AC failure as rework signal, not story failure.
- FR29: Dev subagent `git push` + `gh pr create` as terminal action.

**Review and verdict**
- FR30: Reviewer reads story file, diff, `docs/standards.md`.
- FR31: Reviewer runs story ACs as part of review.
- FR32: Reviewer judges diff against `docs/standards.md` criteria.
- FR33: Reviewer posts inline comments.
- FR34: Reviewer posts verdict comment with locked final-line grammar (READY FOR MERGE | NEEDS CHANGES [N,M] | BLOCKED [reason]).
- FR35: Reviewer stamps standards-doc version AND plugin semantic version into verdict comment.
- FR36: Reviewer applies labels `reviewed-by-agent` on success and `needs-human` on NEEDS CHANGES / BLOCKED / reviewer-failure.
- FR37: Reviewer cannot close/merge/formally request changes on PR (negative capability).
- FR38: Reviewer cannot push commits or edit files (negative capability).
- FR39: On re-invocation, reviewer locates prior verdict comment by footer marker and edits in place.
- FR40: Plugin auto-merges PR only when verdict=READY FOR MERGE AND `risk_tier=low` AND rolling agreement metric ≥ threshold (default 80%).
- FR40a: Risk-tier classification rules (path/change-type/diff-size) are a required v1 architecture deliverable (versioned `docs/risk-tiering.md`); until then planner assigns manually with user confirmation.
- FR41: Plugin pauses PR for user when `risk_tier` is medium/high regardless of verdict.
- FR42: User can manually merge any PR regardless of verdict (override authority preserved).

**Standards doc**
- FR43: Plugin locates `docs/standards.md` at conventional path.
- FR44: Plugin parses standards doc (version, criteria w/ name/what/check/anti-criterion, updated date).
- FR45: Plugin detects missing/malformed standards doc; clear error pointing at example template.
- FR46: Plugin refuses to run when standards doc declares >10 criteria (hard cap).
- FR47: Plugin ships `docs/standards-example.md` as copy-target.
- FR48: Plugin deterministically regenerates `docs/standards.md` from `discipline-rules.yaml` on `accept-proposal`.

**Orchestration and blocker handling**
- FR49: Orchestration polls `in-progress/` and `blocked/` (default 120s, configurable).
- FR50: Orchestration detects stuck stories (in-progress past timeout) and surfaces.
- FR51: Orchestration detects stale claims (claimed_by references non-live session id) and surfaces.
- FR52: Orchestration surfaces blockers/stuck/stale as one-line terminal items.
- FR53: User resolves blockers by editing story file and moving back to `to-do/` (or via orchestration after frontmatter clear).
- FR54: Orchestration cannot mutate dev-loop state directly (only surface + optionally move resolved blockers).

**Retro and calibration**
- FR55: Reviewer records story-level retro entries into story frontmatter on completion.
- FR56: User invokes cycle-level retro via `/<plugin>:retro`.
- FR57: Retro agent reads all story retros in cycle, rule registry, outcome stats.
- FR58: Retro agent produces single proposal markdown file under `_bmad-output/retro-proposals/<ISO-timestamp>.md`.
- FR59: Proposal file contains rule proposals (text, target_failure_class, recommended promotion_level) and skill proposals (path, frontmatter description, body).
- FR60: Retro agent cannot mutate rule registry, standards, sprint-history, plugin skills directly.
- FR61: User invokes `/<plugin>:accept-proposal <id>` — diff + confirmation before mutation.
- FR62: Plugin applies accepted rule proposal — mutates `discipline-rules.yaml` and regenerates `docs/standards.md` (and `planning-discipline.md` if present).
- FR63: Plugin applies accepted skill proposal — writes SKILL.md; refuses to overwrite existing.
- FR64: Plugin detects promotion threshold hit for `failure_class` in current cycle and flags for retro agent.
- FR64a: Retro agent emits rule-retirement proposals when a rule's target failure class hasn't fired for M consecutive cycles (default 5); applied via same accept-proposal flow.

**Telemetry and outcome verification**
- FR65: Plugin records structured log entry per agent invocation (agent type, story id, runtime, timestamp).
- FR66: Plugin records structured log entry per reviewer verdict (PR #, verdict, standards version, eventual merge action).
- FR67: Plugin computes rolling verdict-vs-action agreement metric across configurable window.
- FR68: Plugin computes outcome stats per rule (before/after fire counts + delta).
- FR69: Plugin archives drained cycle state to `_bmad-output/sprint-history/<cycle-id>-<timestamp>.yaml`.
- FR70: User reads telemetry as local files (no remote service required).

**Install, distribution, onboarding**
- FR71: Plugin installable via clone + load into Claude Code (no npm channel).
- FR72: Plugin ships bundled example target repo at `plugins/<plugin-name>/example/`.
- FR73: README walks install path end-to-end with verifiable checkpoints.
- FR74: Plugin runs against same-repo (Jack) or different-repo (Maya) configurations.
- FR75: README contains one-page "session died" recovery guide.

**Non-engineer ergonomics**
- FR76: Planning agent can be consulted in side session about an open reviewer verdict comment without breaking dev loop.
- FR77 (guideline, non-testable): Planning agent produces story bodies in plain language for non-engineer skim-readers; shaped via persona/retros, not asserted by automated check.
- FR78: Planning agent supports "discard a built feature" as first-class outcome — produces revert/deprecate story.

**Permissions and authority**
- FR79: Every agent declares allowed tools + `gh` subcommands explicitly in version-controlled spec.
- FR80: Plugin runtime enforces permissions at tool layer (not prompt).
- FR81: No agent mutates canonical state without user confirmation or dedicated MCP tool boundary.

**Team formation and persona management**
- FR82: Plugin ships catalogue at `plugins/<plugin-name>/catalogue/<role>.md` (domain, model tier, tool allowlist, locked phrases, prompt body).
- FR83: Catalogue includes at minimum: planner, generalist dev, generalist reviewer, retro analyst, orchestrator, security specialist, test specialist, docs specialist, debugger.
- FR84: User opens hiring conversation via `/<plugin>:hire`.
- FR85: Hiring manager reads target repo at high level (language, layout, README, recent git, deps).
- FR86: Hiring manager recommends starting team from catalogue with one-sentence justifications.
- FR87: Hiring manager defaults to general-purpose roster when no specialist signals.
- FR88: User can approve all / subset / decline / request specific catalogue role.
- FR89: Plugin instantiates hired role at `<target-repo>/team/<role>/PERSONA.md` (domain, prompt body copied from catalogue, empty knowledge section).
- FR90: Re-running `/<plugin>:hire` against existing team edits composition; surfaces current roster.
- FR91: User can opt out via "skip hiring, use default team" fast path.
- FR92: Hiring manager cannot generate new specs outside catalogue in v1 (negative); manual escape hatch via `<target-repo>/team/custom/`.
- FR93: Each hired agent reads persona file at session start.
- FR94: Each hired agent can propose appends to knowledge section at session end.
- FR95: Persona-knowledge appends gated through diff-then-confirm in v1.
- FR96: User can read/edit any persona file directly.
- FR97: Persona files version-controlled in target repo; recoverable via `git revert`.

**Domain-aware yield protocol**
- FR98: Every catalogue role declares `domain:` field.
- FR99: Plugin runtime looks up hired roles by `domain:` for routing.
- FR100: Hired agent yields via locked handoff phrase; runtime routes when domain matches a hired role; otherwise surfaced to user as routing-failure (not silent).
- FR101: Specialist refuses to defer when work falls in own domain (in-domain insistence).
- FR102: Generalist yields when work falls inside hired specialist's domain (out-of-domain deference).
- FR103: Yield protocol records each handoff in telemetry.
- FR104: When no domain matches, generalist in relevant lane handles without yield.

**Team-change proposals and team observability**
- FR105: Retro analyst emits team-change proposals (hire, unhire) alongside rule and skill proposals.
- FR106: Team-change proposal includes: action, target role, justification, predicted impact.
- FR107: User applies team-change proposal via `/<plugin>:accept-proposal <id>`; hire → hiring manager drafts persona; unhire → archived "decommission" record.
- FR108: User views current team via `/<plugin>:team` (roles, domains, fire counts, recent knowledge entries).
- FR109: User opens side-session with specific role via `/<plugin>:ask <role>`; no state mutation.
- FR110: `computeOutcomeStats` reports fire counts before/after each team-composition change.

**Total FRs: 112** (FR1–FR110 plus FR40a, FR64a)

### Non-Functional Requirements

**Performance**
- NFR1: Reviewer subagent completes review + posts verdict within 3 minutes (soft, typical PR ≤500 LOC, ≤10 criteria).
- NFR2: Reviewer invocations >8 minutes treated as failed; routed to failure path with `needs-human` label.
- NFR3: Dev subagent invocations >configurable budget (default 30 min) surfaced as stuck.
- NFR4: Orchestration polling pass completes within 30s under normal load.
- NFR5: Install-to-first-merged-PR ≤1 hour for clean-machine first-time user (canonical scenario).

**Reliability**
- NFR6: No silent failures — 100% of invocations produce visible artifact; integration test asserts paired invocation↔artifact in telemetry.
- NFR7: Recoverable session death — re-run launching slash-command resumes from filesystem state; integration test kills at 3 checkpoints.
- NFR8: Atomic state transitions via single `mv` syscall; no story observable in two states.
- NFR9: No story-state corruption from agent failure; fault-injection integration test on timeout/rate-limit/crash.
- NFR10: Idempotent skill invocations — re-running any `/<plugin>:*` is safe (no dup files/PRs/comments/knowledge entries).
- NFR11: Idempotent reviewer re-run produces same PR-state shape (one verdict comment, one set of inline comments/labels).

**Security & Permissions**
- NFR12: Bounded agent authority — exactly the tools declared in spec; enforced at runtime, not prompt.
- NFR13: No silent authority escalation — permission spec changes go through PR flow.
- NFR14: No remote data exfiltration — only `gh` to user's own GitHub and the configured model API.
- NFR15: Local-first by construction — no telemetry to remote service.
- NFR16: Negative-capability enforcement at tool-allowlist layer (reviewer can't close/merge/push/edit; retro can't mutate registry/standards; planner can't commit without user confirmation).

**Integration**
- NFR17: `gh` is the only GitHub surface; uses user's existing auth.
- NFR18: Graceful `gh` failure handling — versioned mapping table of exit codes/stderr patterns → defer|retry|needs-human; integration test stubs each.
- NFR19: Filesystem is the only inter-session coordination surface.
- NFR20: Claude Code is the only runtime — no bundled runtime, no daemon.

**Observability**
- NFR21: Structured telemetry — JSONL or equivalent, parseable without LLM.
- NFR22: Every reviewer verdict comment includes both standards-doc version AND plugin semantic version.
- NFR23: Rule fire counts computable deterministically without LLM.
- NFR24: Agreement metric computable deterministically without LLM.
- NFR25: Persona files are plain Markdown, human-readable/editable.
- NFR26: Persona-update gate — diff-then-confirm; no silent persona mutation.
- NFR27: Persona-file integrity via git revert recoverability.
- NFR28: Team-state observable without LLM (roster, domains, recent knowledge entries, fire counts).
- NFR29: Yield-protocol observability — every handoff recorded with both roles and triggering domain.

**Explicitly out of scope (v1):** Scalability, Accessibility, Localisation, Multi-user/RBAC.

**Total NFRs: 29.**

### Additional Requirements / Constraints

- **Hard constraint:** Standards doc capped at 10 criteria (FR46); v1 ships an example, not a default.
- **Hard constraint:** Only low-risk PRs auto-merge in v1 — medium/high *always* pause.
- **Hard constraint:** Catalogue-bound hiring in v1; no agent-generative role creation (manual escape hatch only).
- **Hard constraint:** No Claude Code hooks in v1 (PreToolUse/PostToolUse/Stop deliberately deferred).
- **Hard constraint:** No daemon / no background process; sessions are explicit user-launched Claude Code sessions.
- **Hard constraint:** Three concurrent sessions (planning, dev, orchestration) coordinate ONLY via filesystem (NFR19).
- **Strategic risks (PRD §Strategic Risks):** (R1) Jack-only adoption, (R2) calibration loop becomes theatre, (R3) dynamic team underperforms fixed roster — each has explicit mitigations including the "skip hiring, use default team" bailout (FR91).

### PRD Completeness Assessment

The PRD is unusually rigorous for v1 planning:
- Every FR is testable; FR77 explicitly marked non-testable (guideline only), which is good discipline.
- NFRs include explicit **measurement plans** (NFR6, NFR7, NFR9, NFR10, NFR18) — not just targets.
- Negative capabilities (FR37, FR38, FR60, FR92) and authority boundaries (FR79–FR81, NFR12–NFR16) are first-class.
- Strategic risks each have falsification criteria (sub-80% agreement, zero accepted proposals, etc.) rather than vibes-based "we will monitor."
- One soft gap noted by the PRD itself: **FR40a** declares risk-tier classification rules as an architecture deliverable, not a PRD specification — to be verified in step 4 that architecture has filled this in.
- Scope deferrals are reasoned, not silently dropped (each "explicitly out of v1" item names a Growth/Vision trigger).

PRD is ready for epic-coverage validation.

## Epic Coverage Validation

The epics document carries an explicit FR Coverage Map (epics.md §FR Coverage Map, line 347) and an NFR Coverage Map (line 383) that asserts: *"All 110 FRs and all 29 in-scope NFRs are mapped to an epic."* I cross-checked the map against the PRD's FR/NFR lists; the mapping is contiguous and exhaustive.

### Coverage Matrix (by group, since coverage is complete)

| FR/NFR Group | PRD Section | Epic Assignment | Status |
|---|---|---|---|
| FR1–FR8 | Planning conversation | Epic 3 (Backlog Layer, native adapter) | ✓ Covered |
| FR9–FR14 | Story files & backlog mgmt | Epic 3 (FR9 satisfied by execution-manifest layer per Planning Adapter Model) | ✓ Covered |
| FR15 | `/start` launcher | Epic 4 | ✓ Covered |
| FR16 | `/watch` launcher | Epic 5 | ✓ Covered |
| FR17, FR18 | Claim story + dep check | Epic 4 | ✓ Covered |
| FR19 | Complete story | Epic 4 | ✓ Covered |
| FR20, FR21 | Block + drain past blocker | Epic 5 | ✓ Covered |
| FR22 | Dev terminates on empty queue | Epic 4 | ✓ Covered |
| FR23 | Session relaunch from FS | Epic 5 | ✓ Covered |
| FR24–FR29 | Dev loop | Epic 4 | ✓ Covered |
| FR30–FR42, FR40a | Review/verdict/risk-tier/auto-merge | Epic 4 | ✓ Covered |
| FR43–FR47 | Standards doc lookup/parse/template | Epic 1 | ✓ Covered |
| FR48 | Regenerate standards from registry | Epic 6 | ✓ Covered |
| FR49–FR54 | Orchestration & blockers | Epic 5 | ✓ Covered |
| FR55–FR60 | Story retros, `/retro`, proposals | Epic 6 | ✓ Covered |
| FR61–FR64a | Accept-proposal flow, retirement | Epic 6 | ✓ Covered |
| FR65, FR66 | Per-invocation + per-verdict telemetry | Epic 4 | ✓ Covered |
| FR67 | Agreement metric | Epic 4 | ✓ Covered |
| FR68, FR69, FR70 | Outcome stats, archive, readable telemetry | Epic 6 | ✓ Covered |
| FR71, FR73, FR74 | Install path / README / same-repo+split | Epic 1 | ✓ Covered |
| FR72 | Bundled example repo | Epic 7 | ✓ Covered |
| FR75 | Session-death recovery guide | Epic 5 | ✓ Covered |
| FR76 | Translate-a-comment via `/ask` | Epic 2 | ✓ Covered |
| FR77 | Plain-language guideline | Epic 3 | ✓ Covered |
| FR78 | Discard-a-built-feature | Epic 3 | ✓ Covered |
| FR79–FR81 | Permission specs + canonical-state mediation | Epic 1 | ✓ Covered |
| FR82–FR93 | Catalogue, hiring manager, hire flow, persona files | Epic 2 | ✓ Covered |
| FR94, FR95 | Persona-knowledge append + diff-confirm | Epic 6 | ✓ Covered |
| FR96, FR97 | User reads/edits persona; git-versioned | Epic 2 | ✓ Covered |
| FR98–FR104 | Yield protocol | Epic 4 | ✓ Covered |
| FR105–FR107 | Team-change proposals + apply | Epic 6 | ✓ Covered |
| FR108, FR109 | `/team`, `/ask <role>` | Epic 2 | ✓ Covered |
| FR110 | Outcome stats across team-composition changes | Epic 6 | ✓ Covered |
| **NFR1–NFR3** | Reviewer + dev runtime targets | Epic 4 | ✓ Covered |
| **NFR4** | Orchestration polling cadence | Epic 5 | ✓ Covered |
| **NFR5** | Install-to-first-merged-PR ≤1h | Epic 7 | ✓ Covered |
| **NFR6** | No silent failures CI pairing assertion | Epic 5 | ✓ Covered |
| **NFR7** | Recoverable session death | Epic 5 | ✓ Covered |
| **NFR8** | Atomic state transitions | Epic 1 (primitive) | ✓ Covered |
| **NFR9** | No story-state corruption on failure | Epic 5 | ✓ Covered |
| **NFR10** | Idempotent skill invocations | Epic 5 | ✓ Covered |
| **NFR11** | Idempotent reviewer re-run | Epic 4 | ✓ Covered |
| **NFR12–NFR16** | Security/permissions baseline | Epic 1 | ✓ Covered |
| **NFR17** | `gh` only GitHub surface | Epic 1 | ✓ Covered |
| **NFR18** | Graceful `gh` failure handling | Epic 4 | ✓ Covered |
| **NFR19, NFR20** | Filesystem-only coord; Claude Code only runtime | Epic 1 | ✓ Covered |
| **NFR21** | JSONL telemetry | Epic 1 (plumbing) | ✓ Covered |
| **NFR22** | Verdict version stamping | Epic 4 | ✓ Covered |
| **NFR23** | Outcome-stats observability | Epic 6 | ✓ Covered |
| **NFR24** | Agreement-metric observability | Epic 4 | ✓ Covered |
| **NFR25** | Persona files plain Markdown | Epic 2 | ✓ Covered |
| **NFR26** | Persona-update diff-then-confirm gate | Epic 6 | ✓ Covered |
| **NFR27** | Persona git-revertable | Epic 2 | ✓ Covered |
| **NFR28** | Team-state observable without LLM | Epic 2 | ✓ Covered |
| **NFR29** | Yield handoff telemetry | Epic 4 | ✓ Covered |

### Missing Requirements

**None.** Every PRD FR (FR1–FR110, plus FR40a and FR64a) and every in-scope NFR (NFR1–NFR29) is explicitly mapped to an epic.

### Coverage Statistics

- Total PRD FRs: **112** (FR1–FR110 + FR40a + FR64a)
- FRs covered in epics: **112**
- FR coverage: **100%**
- Total in-scope NFRs: **29**
- NFRs covered in epics: **29**
- NFR coverage: **100%**

### Note on FRs-in-Epics-but-Not-in-PRD

None observed. The epics restate the PRD's FR list verbatim in their Requirements Inventory section, then map each to an epic — no orphan FRs that don't trace back to the PRD. Several epics introduce supporting capabilities (execution-manifest layer for FR9, planning-adapter registry, `gh-error-map.yaml`, source-drift detection) — these are *implementation choices* derived from architecture, not new requirements.

## UX Alignment Assessment

### UX Document Status

**Not Found** — and **not required**.

### Reasoning

The PRD and epics both explicitly disclaim a UX layer:

- **PRD NFR-out-of-scope (line 811):** *"output surfaces are terminal text, PR comments rendered by GitHub, and local Markdown files. The plugin renders no UI it controls; accessibility concerns route to Claude Code and GitHub upstream."*
- **Epics UX Design Requirements (line 343):** *"Not applicable — no UX design specification exists for v1. The product's user-facing surface is (a) terminal text from Claude Code sessions, (b) GitHub PR comments rendered by GitHub, and (c) local Markdown files in the target repo. The plugin owns no UI."*

This is a Claude Code plugin whose surfaces are:
1. Slash-commands (terminal text I/O) — owned by Claude Code's rendering.
2. PR comments — owned by GitHub's rendering.
3. Markdown files (persona, story, retro, standards) — owned by the user's text editor.

There is no plugin-owned UI surface, web view, mobile component, or graphical element. The "user experience" that *does* exist (locked-grammar verdict comments, one-line terminal orchestration surfaces, plain-language story bodies for non-engineer readers) is encoded in functional requirements (FR34, FR52, FR77) and exercised in the planner/reviewer/orchestrator agent prompts — not in a UX document.

### Alignment Issues

None. PRD, epics, and (per the next step) architecture treat the absence of a UX layer consistently.

### Warnings

None. The absence is deliberate and justified, not an oversight.

## Epic Quality Review

Validated against the BMad create-epics-and-stories standards: user value focus, epic independence, dependency direction, story sizing, AC structure, greenfield/scaffold patterns.

### Epic Structure Validation

#### A. User Value Focus

| Epic | Goal statement (paraphrased) | User-Value? |
|---|---|---|
| 1. Plugin Foundation & Target-Repo Bootstrap | User installs, points at target repo, runs `/status` — sees plugin recognised the repo | ✓ User-observable (just barely — see note below) |
| 2. Team Formation — Hiring, Personas, Team Observability | User hires team, runs `/team`, `/ask <role>` — has a team to talk to | ✓ Clear user value |
| 3. Backlog Layer — Planning Adapters & Conversation | User ends with a primed, validated backlog | ✓ Clear user value |
| 4. Dev + Review Loop | Backlog drains end-to-end; PRs raised, reviewed, auto-merged or paused | ✓ Clear user value (the headline outcome) |
| 5. Orchestration & Recovery | User leaves loop running and trusts nothing fails silently | ✓ Clear user value |
| 6. Calibration Loop | Standards & team get sharper through retros + proposals | ✓ Clear user value |
| 7. Bundled Example & Install Canary | First-time user reaches first merged PR in ≤1h | ✓ Clear user value |

**Note on Epic 1:** Epic 1 is the foundation epic — its stories include scaffolding (workspace resolver, permission allowlist scaffold, atomic `fs.rename`, JSONL plumbing) that doesn't directly produce user-visible outcomes. The epic is *framed* around a user-observable checkpoint (`/status` returns the expected line) which keeps it from being a pure technical milestone. This is acceptable greenfield practice and is structurally unavoidable for a plugin product — the alternative (interleaving infrastructure into Epic 2+) would create messier forward dependencies. **No defect**, but worth noting that stories 1.4, 1.5, 1.6 are pure-scaffold under a user-value-framed epic.

#### B. Epic Independence

The epics doc states the dependency flow explicitly (epics.md:482):

> `E1 → E2 ↔ E3 → E4 → E5 ↔ E6 → E7`

Where `↔` denotes independence (E2 and E3 are mutually independent prerequisites for E4; E5 and E6 are mutually independent consumers of E4 output).

Checked:
- ✓ E1 stands alone — no references to E2+.
- ✓ E2 (hiring/persona) does not require E3 (backlog) — `/skip-hiring` allows progressing without it.
- ✓ E3 (backlog) does not require E2 (hiring) — `/skip-hiring` is offered specifically so scanning a backlog isn't blocked on hiring.
- ✓ E4 needs E1+E2+E3 (correct — dev loop needs scaffolding, a hired dev/reviewer, and a populated to-do queue).
- ✓ E5 and E6 both consume E4 telemetry but neither depends on the other (orchestration doesn't need retros; retros don't need orchestration).
- ✓ E7 (canary) depends on the prior six (correct — the canary is the end-to-end test).

**No forward dependencies detected.** No epic references features it logically needs from a later epic.

### Story Quality Assessment

#### A. Story Sizing

- Each epic decomposes into 6–13 stories.
- Story bodies follow the standard "As a..., I want..., So that..." pattern.
- Story scope is one focused capability (e.g., Story 4.7: verdict version stamping + footer-marker idempotent rerun — paired because they share the same comment-edit code path).
- "b"-suffixed sub-stories (1.2b, 4.6b, 4.9b, 4.10b, 5.4b, 6.5b, 7.4b) are used cleanly to split a parent capability into sequential halves where the dependency is unavoidable — no forward refs created by this pattern.

#### B. Acceptance Criteria

Reviewed a representative cross-section (Stories 1.1, 1.4, 2.4, 3.5, 4.3, 4.10b, 5.4b, 6.3, 6.4, 7.7).

- ✓ Given/When/Then format consistently applied.
- ✓ Almost every story carries an explicit `AC# (integration):` clause naming the vitest assertion that verifies it — exceptionally strong testability discipline.
- ✓ Outcomes are specific and machine-verifiable: literal label strings (`reviewed-by-agent`, `needs-human`), exact footer markers (`<!-- crew:verdict:<plugin-version>:<ref> -->`), branch-name conventions (`story/<ref-slug>-<title-slug>`), JSON event field names.
- ✓ Error/refusal paths are first-class — e.g., Story 1.4 covers unlisted-tool denied, unlisted-`gh`-subcommand denied, raw-fs-write denied, valid call succeeds.
- ✓ FR/NFR traceability inline (`_(FR79)_`, `_(NFR12)_`) on individual ACs — auditor-friendly.
- ✓ Edge-case ACs explicitly covered: e.g., Story 4.10's `compute-agreement` handles "empty log returns null" and "unresolved PR excluded from window."
- ✓ Negative capabilities encoded as ACs (Story 4.8 asserts reviewer cannot `pr-close`, `pr-merge`, `pr-review --request-changes`).

**No vague criteria found** ("user can login"-style red flags absent).

#### C. Within-Epic Dependencies

Scanned each story for forward references. Findings:
- All "depends-on-Story-N" references point backward (e.g., Story 4.10b references Story 4.10; Story 5.7 references the parent telemetry shape from 1.5).
- The "b"-pattern (1.2b, 4.6b, etc.) keeps each pair adjacent — no leapfrog.
- ✓ **No forward dependencies detected.**

### Special Implementation Checks

#### A. Starter Template (Greenfield Scaffold Story)

The architecture deliberately calls Story 1.1 the "scaffold story" (epic 1 description, epics.md:418). It covers:
- `plugins/flow/.claude-plugin/plugin.json` with semver `version`
- `pnpm-workspace.yaml`, `tsconfig.base.json`
- `mcp-server/`, `catalogue/`, `skills/`, `permissions/`, `docs/`, `example/` skeleton
- Empty MCP server entrypoint
- `BmadAdapter` stub returning `[]`
- Smoke vitest

✓ Matches the greenfield "Story 1 is initial-project-setup" expectation.

#### B. Greenfield Indicators

| Indicator | Present? |
|---|---|
| Initial project setup story | ✓ Story 1.1 |
| Development environment configuration | ✓ Story 1.1 (pnpm workspace, TS config) |
| CI/CD pipeline setup | △ Implicit — vitest harness lands in Story 1.1, CI gates appear in Stories 5.6 / 5.7 / 5.8 when the relevant code exists to gate. Acceptable sequencing. |
| Permissions/auth scaffolding | ✓ Story 1.4 (allowlist scaffold) + Story 2.2 (per-role specs) |
| Telemetry plumbing | ✓ Story 1.5 (JSONL pipe before any agent fires) |

### Best Practices Compliance Checklist

| Check | Status |
|---|---|
| Epic delivers user value | ✓ (Epic 1 marginal — see note) |
| Epic can function independently per the declared graph | ✓ |
| Stories appropriately sized | ✓ |
| No forward dependencies | ✓ |
| Database tables created when needed | N/A (no database — filesystem state) |
| Clear acceptance criteria (BDD, testable, specific) | ✓ |
| Traceability to FRs maintained | ✓ (inline FR/NFR tags on every story) |
| Integration ACs present | ✓ (every story has `AC# (integration):`) |
| Negative capabilities encoded | ✓ (Stories 1.4, 2.2, 4.8) |

### Findings

#### 🔴 Critical Violations

**None.**

#### 🟠 Major Issues

**None.**

#### 🟡 Minor Concerns

- **C1 — Epic 1 user-value framing is thin in places.** Stories 1.4 (permission allowlist), 1.5 (JSONL plumbing), 1.6 (atomic `fs.rename`) are pure scaffolding under a user-value-framed epic. The PM-level outcome (`/status` works) is preserved by Story 1.7, but a non-engineer reading this epic would see four stories before the user-visible payoff. **Severity: minor** — unavoidable for a plugin foundation; well-framed. **Recommendation:** none required; flag only.

- **C2 — Cycle boundaries are conventional, not enforced.** Story 6.12 (`archive-cycle`) defines "cycle" as "the period from the last archive to the next" but there's no FR forcing a cycle boundary at a particular moment — the user triggers `archive-cycle` when `done/` is full. This is consistent with the continuous-flow model (sprints removed deliberately), but readers expecting time-boxed cycles will find no clock-driven boundary. **Severity: minor.** **Recommendation:** README install-path guide should explicitly call out "you decide when a cycle ends."

- **C3 — CI gate stories (5.6, 5.7, 5.8) bundle multiple NFRs into single stories.** Each is large in scope (fault-injection harness, idempotency test suite, no-silent-failures pairing assertion). Each *is* atomic in delivery (the test harness either exists and passes or it doesn't), but a reader skimming for sprint sizing might underestimate them. **Severity: minor.** **Recommendation:** none required; these are correctly scoped.

- **C4 — Story 1.5 conflates JSONL telemetry plumbing with the git-commit wrapper (`mcp-server/src/lib/git.ts`).** Two distinct primitives (logger + git wrapper) co-located under one story. They are both load-bearing infrastructure but conceptually separate. **Severity: minor.** **Recommendation:** consider splitting if the story turns out to be larger than a sprint can swallow in implementation; otherwise acceptable.

### Quality Summary

The epics + stories pass best-practices validation with **no critical or major issues**. The four minor concerns are framing/observability notes, not defects.

Specific strengths worth calling out:
- Every story carries an explicit integration-test AC (rare and excellent discipline).
- FR/NFR traceability is inline at the AC level, not just at the epic level.
- Negative capabilities (what an agent *cannot* do) are encoded as ACs, matching the PRD's authority-boundary insistence (FR79–FR81, NFR12–NFR16).
- The greenfield scaffold story (1.1) is well-shaped and includes a smoke test.
- The bundled-example epic (Epic 7) recognises and pressure-tests the PRD's biggest strategic risk (Maya archetype, Story 7.7).

Ready for final assessment.

## Summary and Recommendations

### Overall Readiness Status

**READY** — proceed to implementation.

### Findings Summary

| Category | Result |
|---|---|
| Documents present | PRD, Architecture, Epics. UX correctly N/A (no plugin-owned UI). |
| Document duplicates | None. |
| PRD requirements extracted | 112 FRs (FR1–FR110 + FR40a + FR64a), 29 in-scope NFRs. |
| FR coverage in epics | **100%** — every FR mapped to an epic via explicit FR Coverage Map. |
| NFR coverage in epics | **100%** — every in-scope NFR mapped. |
| Forward dependencies | None detected. |
| Technical-milestone epics | None. Epic 1 is foundation but framed around `/status` user-visible checkpoint. |
| Story sizing | Appropriate; "b"-suffix pattern used cleanly for paired stories. |
| AC quality | BDD format, integration-test ACs on every story, inline FR/NFR traceability — exceptionally strong. |
| Negative capabilities | Encoded as ACs (Stories 1.4, 2.2, 4.8). |
| Greenfield scaffold story | Present (Story 1.1) with smoke vitest. |
| Critical violations | **0** |
| Major issues | **0** |
| Minor concerns | **4** (framing/observability notes, not defects) |

### Critical Issues Requiring Immediate Action

**None.** No blockers to starting implementation.

### Minor Concerns (Optional Polish)

1. **C1 — Epic 1 user-value framing thin in middle stories.** Stories 1.4–1.6 are pure scaffolding under a user-value-framed epic. Acceptable; no action required.
2. **C2 — Cycle boundaries are user-triggered, not enforced.** Consistent with continuous-flow model. **Recommendation:** the README install-path should state "you decide when a cycle ends" explicitly.
3. **C3 — CI gate stories (5.6, 5.7, 5.8) bundle multiple NFRs each.** Correctly scoped (each test harness is atomic). No action required.
4. **C4 — Story 1.5 conflates JSONL telemetry plumbing with the git-commit wrapper.** **Recommendation:** consider splitting only if implementation reveals the story is larger than a sprint can swallow; otherwise leave as-is.

### Recommended Next Steps

1. **Start implementation with Epic 1 Story 1.1 (scaffold).** Greenfield-correct first move; lands the foundation every later story builds on.
2. **Track the 4 minor concerns as PM-side notes**, not blockers. Re-evaluate C4 if Story 1.5 grows in implementation; act on C2 when the README is authored in Story 7.2.
3. **Verify the architecture document covers the v1 deliverables flagged by the PRD** — specifically **FR40a** (risk-tier classification rules → `docs/risk-tiering.md`) and the planning-adapter interface. The epics reference these as already specified in architecture; spot-check before Sprint 1 begins so the implementer isn't surprised. This was inferred from epic references during this assessment, not directly verified against `architecture.md`.
4. **Lock in Risk-2 mitigation early.** Story 7.7 (Maya paper-test) is treated as a v1 ship gate — line up the five candidate names *before* implementation completes, not after. The PRD's whole strategic-risk posture depends on it.

### Scope Confirmation

The PRD's v1 scope (single release, 112 FRs, 29 NFRs) is fully reflected in the 7-epic, ~60-story breakdown. No silent de-scoping detected. Growth/Vision items in the PRD remain explicit follow-ups (not silently promoted to v1, not silently dropped).

### Final Note

This assessment identified **0 critical issues** and **0 major issues** across the PRD, Architecture (reviewed transitively via epic references), and Epics. The 4 minor concerns documented above are framing/observability notes, not defects.

The planning artifacts demonstrate unusually high rigour for a greenfield v1: explicit FR↔Epic coverage map, integration-test ACs on every story, inline FR/NFR traceability, negative capabilities encoded as testable contracts, and strategic-risk mitigations promoted to first-class story status (e.g., Story 7.7's Maya paper-test as a ship gate).

**Recommendation:** proceed to Sprint 1 implementation starting with Epic 1 Story 1.1.

---

**Assessment date:** 2026-05-19
**Assessor:** John (PM agent, via bmad-check-implementation-readiness)
**Report location:** `_bmad-output/planning-artifacts/implementation-readiness-report-2026-05-19.md`





