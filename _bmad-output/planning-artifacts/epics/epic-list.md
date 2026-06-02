# Epic List

## Epic 1: Plugin Foundation & Target-Repo Bootstrap

**Goal:** A user installs the plugin, points it at a target repo, and confirms the plugin recognises the repo. `/<plugin>:status` reports the current adapter, plugin version, and whether `docs/standards.md` exists; missing/malformed standards produce a clear error pointing at the shipped example template. The MCP server, workspace resolver, permission-allowlist enforcement, atomic state-transition primitive, and JSONL telemetry plumbing are all in place — zero-behaviour-but-load-bearing infrastructure that every later epic builds on.

**FRs covered:** FR43, FR44, FR45, FR46, FR47, FR71, FR73, FR74, FR79, FR80, FR81. **NFRs:** NFR8, NFR12, NFR13, NFR14, NFR15, NFR16, NFR17, NFR19, NFR20, NFR21.

**Includes the scaffold story** (architecture's "first implementation story"): `plugins/flow/` skeleton with `.claude-plugin/plugin.json`, pnpm workspace, empty MCP server entrypoint, empty `bmad` adapter stub. Plus: `/status`, `/scan` skill shells, standards-doc lookup tool, standards-example template shipped, workspace-config Zod schema, atomic `fs.rename` state primitive (no manifests yet), pino → JSONL logger, execa wrapper with allowlist scaffold, README install path up to "the plugin sees my repo."

---

## Epic 2: Team Formation — Hiring, Personas, and Team Observability

**Goal:** A user opens a hiring conversation, the hiring manager reads the repo and proposes a starting team with justifications, the user approves, and persona files are written to `<target-repo>/team/<role>/PERSONA.md`. The user can view the team (`/team`), open a side-session with a hired role (`/ask <role>`) — including to translate a reviewer comment later — or skip the conversation entirely (`/skip-hiring`). A user with no dev loop yet still gets concrete value: a team they can talk to.

**FRs covered:** FR76, FR82, FR83, FR84, FR85, FR86, FR87, FR88, FR89, FR90, FR91, FR92, FR93, FR96, FR97, FR108, FR109. **NFRs:** NFR25, NFR27, NFR28.

Catalogue ships the 10 role templates (hiring-manager, planner, generalist-dev, generalist-reviewer, retro-analyst, orchestrator, security-specialist, test-specialist, docs-specialist, debugger). `read-catalogue`, `instantiate-persona`, `read-persona`, `lookup-role-by-domain` MCP tools land here. Per-role permission specs at `plugins/<plugin>/permissions/<role>.yaml`.

---

## Epic 3: Backlog Layer — Planning Adapters, Story Manifests, and the Planning Conversation

**Goal:** A user has a primed, validated backlog of execution manifests ready for the dev loop to drain. BMad-shaped repos plug in via the BMad adapter; users without a planning tool open `/plan` and produce stories via the native adapter and planner agent. Source-drift detection captures hashes at scan time; planning-discipline (integration ACs, explicit `depends_on`, ship-gate refusal) validates at scan time for external adapters and at authoring time for native. The user can also discard a built feature via a first-class planning outcome (FR78).

**FRs covered:** FR1, FR2, FR3, FR4, FR5, FR6, FR7, FR8, FR9, FR10, FR12, FR13, FR14, FR77, FR78.

Lands: `PlanningAdapter` interface + `registry.ts`; BMad adapter (after BMad-format spike) + native adapter; `scan-sources`, `read-source-story`, `validate-against-discipline`, `mark-withdrawn` MCP tools; execution-manifest Zod schema; `source-hash` capture; `/plan` skill (adapter-aware: native → planner subagent; external → pointer + scan); planner catalogue prompt body.

---

## Epic 4: Dev + Review Loop — The Engineering Heart

**Goal:** A primed backlog drains end-to-end. `/start` launches the dev session; per-story dev subagent spawns from clean context, implements against ACs, hands off via locked phrase; per-story reviewer subagent spawns, reads diff + story + `docs/standards.md`, posts inline comments and the locked-grammar verdict comment (with footer marker, standards version, plugin version), applies labels. Low-risk + agreement-metric-clearing PRs auto-merge; medium/high pause. The yield protocol routes domain-touching work from generalists to hired specialists. Negative capabilities (reviewer cannot merge/push/edit) enforced at the allowlist layer.

**FRs covered:** FR15, FR17, FR18, FR19, FR22, FR24, FR25, FR26, FR27, FR28, FR29, FR30, FR31, FR32, FR33, FR34, FR35, FR36, FR37, FR38, FR39, FR40, FR40a, FR41, FR42, FR65, FR66, FR67, FR98, FR99, FR100, FR101, FR102, FR103, FR104. **NFRs:** NFR1, NFR2, NFR3, NFR11, NFR18, NFR22, NFR24, NFR29.

Lands: `claim-story`, `complete-story`, `record-verdict`, `classify-risk-tier`, `compute-agreement`, `record-yield`, `heartbeat` MCP tools; `verdict-grammar` lib; `gh-error-map.yaml` + classification; risk-tiering spec format + a small default rule set (content iterates post-v1, fallback = `medium`); `/start` skill; generalist-dev + generalist-reviewer + specialist catalogue prompts; locked-phrase parser; verdict footer-marker idempotency.

---

## Epic 5: Orchestration & Recovery — Visibility and Resilience

**Goal:** A user can leave the dev loop running and trust that nothing fails silently. `/watch` launches an orchestration session that polls in-progress and blocked manifests on a configurable interval, surfaces stuck stories / stale claims / source-drift / routing-failures as one-line terminal lines, and never blocks the dev loop. Sessions can die at any of three checkpoints (mid-claim, mid-dev, post-handoff-pre-review) and re-running the skill resumes cleanly. CI asserts that every JSONL invocation entry pairs with an artifact at its declared sink — no silent failures.

**FRs covered:** FR16, FR20, FR21, FR23, FR49, FR50, FR51, FR52, FR53, FR54, FR70, FR75. **NFRs:** NFR4, NFR6, NFR7, NFR9, NFR10.

Lands: `block-story` MCP tool + `blocked_by` taxonomy (source-drift, planning-discipline, routing-failure, gh-error, …); orchestrator catalogue prompt; `/watch` skill; heartbeat-based stale-claim detection; fault-injection vitest harness; back-to-back idempotency integration test; no-silent-failures CI pairing assertion; session-recovery one-page guide.

---

## Epic 6: Calibration Loop — Retros, Proposals, Standards Evolution, Team Tuning

**Goal:** The product gets sharper because the standard does and the team does. Story-level retro entries land in execution manifests with `kind`-tagged lessons; `/retro` produces a single proposal markdown carrying rule, rule-retirement, skill-create, skill-revise, skill-supersede, skill-retire, and team-change proposals. `/accept-proposal <id>` diff-then-confirms each kind: rule proposals mutate `discipline-rules.yaml` and regenerate `docs/standards.md`; skill proposals write/replace/archive skill files; team-change proposals hand off to the hiring manager. Persona-knowledge appends flow through the same gate. Deterministic helpers report outcome stats per rule, per team-composition change, and a constructive-to-defensive ratio.

**FRs covered:** FR11, FR48, FR55, FR56, FR57, FR58, FR59, FR60, FR61, FR62, FR63, FR64, FR64a, FR68, FR69, FR94, FR95, FR105, FR106, FR107, FR110. **NFRs:** NFR23, NFR26.

Lands: `record-story-retro`, `apply-rule-proposal`, `apply-skill-proposal`, `apply-skill-revision`, `apply-skill-retirement`, `apply-team-change`, `append-persona-knowledge`, `regenerate-standards`, `compute-outcome-stats`, `compute-skill-effectiveness`, `archive-cycle`, `record-skill-invoke` MCP tools; retro-analyst catalogue prompt; `/retro`, `/accept-proposal` skills; rule-registry parser; `discipline-rules.example.yaml`; `.proposed.md` sibling pattern for persona appends.

**Phasing (2026-05-27 reframe):** Epic 6 ships in two tranches. **6a (proximate, in scope for v1):** Stories 6.1–6.3 — retro reads cycle, captures lessons, emits typed proposal markdown. **6b (deferred-but-not-dropped):** Stories 6.4–6.13 — proposals mutate `docs/standards.md`, skills, personas, and team composition via the diff-then-confirm gate. 6b is not optional — 6a's emitted proposals are inert without it; phased to defer standards-evolution complexity until self-bootstrap is demonstrably stable. See `_bmad-output/planning-artifacts/sprint-change-proposal-2026-05-27-reframe.md` and epic-6's own Phasing subsection.

---

## Epic 7: Bundled Example & Install Canary — Writeup-Ready

**Goal:** A first-time user on a clean machine clones the repo, follows the README, runs the canonical scenario against the bundled example target, and reaches a first merged PR in under an hour — without Jack on chat. The e2e canary asserts this stays true: a vitest-orchestrated drive of the example scenario against a temp clone runs in CI. This epic is the one that exposes the rough edges the prior six don't see.

**FRs covered:** FR72. **NFRs:** NFR5.

Lands: `plugins/<plugin>/example/` (BMad-shaped: primed `to-do/` queue, `docs/standards.md`, `docs/risk-tiering.md`, `.flow/config.yaml`); README install-path checkpoints (install → hire → plan → start → first merged PR); e2e canary vitest; first-run polish on `/skip-hiring`, `/scan`, error messages.

**Status (2026-05-27 reframe):** Epic 7 is **deferred past the self-bootstrap ship gate.** Its canonical scenario ("external stranger installs cold and reaches first merged PR in <1hr") is the **writeup-supporting / stretch gate**, not the v1 ship gate. The bundled example + canary suite still ships, but the timing follows Epic 6b (after self-bootstrap is demonstrably stable), not 6a. See memory `project_ship_gate_self_bootstrap` and epic-7's own Status subsection.

---

## Epic 8: Stateless Workflow Substrate — Stage-1 Dogfood

**Goal:** crew autonomously builds crew. The pivot's Stage-1 proof-point: one fully-autonomous stateless `drain` workflow run on crew's own repo takes a real low-risk story claim→dev→reviewer→green PR with zero human up to the green PR (a human merges). Delivers the stateless orchestration substrate (one-shot CLI seam-agents, no daemon) plus the three unblock-everything fixes.

**Source of truth:** `_bmad-output/planning-artifacts/sprint-change-proposal-2026-05-29-workflow-pivot.md`. Supersedes the Epic 5 daemon/`/watch` orchestration line. Stories 8.1–8.6 (proposal M0–M5): commit-scope fix, reviewer AC-regex fix, agent-discipline, CLI shim, drain workflow, bootstrap + dogfood run.

**Status (2026-05-29 pivot):** active — the soonest proof-point. The full A–G epic re-sequence and the archive of superseded Epic-5 planning files follow once Stage 1 lands. Per the never-hand-write rule, the story blocks in `epic-8-*.md` are thin stubs; `/ship-story`→`bmad-create-story` authors each full spec.

---

## Epic 9: Intake & Judging — The Planning Cockpit

**Goal:** A non-engineer drives gate 1 of the pipeline — propose, specify, and sequence features in plain language; the team drafts each into a story; a diverse judge panel + a dedicated Quality Lead grade it against the rubric; only blessed stories become `ready`; the drain claims only `ready`. The same project-shaped team produces and judges at both gates (plan and build). The grouping tables become a generated view of intake state, not a hand-kept file.

**Source of truth:** `_bmad-output/planning-artifacts/design-note-2026-05-31-native-planning-and-judging.md`.

Lands: an operator-controlled `ready` state + a drain claim-path that selects only `ready` (9.1); an author seam that drafts a plain-language feature into a story spec (9.2); a generate-and-judge panel emitting a machine-checkable per-criterion verdict against the two-tier rubric (9.3); the **Quality Lead** role — owns the rubric, adjudicates the panel, decides ready-or-escalate (9.4); a generated backlog dashboard rendered from intake state (9.5). Reuses E2 (team/personas), E3 (adapters/manifests/scan), E6 (standards/rubric).

**Status (2026-05-31):** active scaffold — direction agreed; MVP on the current BMad substrate; the owned native story format is a later re-foundation. Stories are thin stubs; `bmad-create-story` authors each full spec. Sequencing: 9.1 (spine, no rubric) → 9.2 → [extend rubric] → 9.3 → 9.4 → 9.5.

---

## Epic 10: Native Re-foundation — Promote the Native Format to Primary

**Goal:** Make the native story format the primary substrate and close the gap that the schema is thinner than the rubric grades — four of six Tier-0 checks can't be machine-enforced because the data isn't structured. Enrich the native schema so every rubric-graded property is a structured field (per-AC `verification`, `tasks[]→ac_refs`, `cited_sources[]`, `risk_tier`, structured `narrative`), finish Tier-0 in code (fail-closed at write + scan), build a one-off BMad→native ingest, cut over to native-primary (BMad ingest-only), and prove the pipeline end-to-end on a real feature. The keystone: the strict schema *is* the grading sheet — "a string appears in a file" passing as verification becomes structurally unrepresentable. Not a rewrite — the native format, parser/writer, and the two-gate cockpit already run on the native adapter (Epic 9); this promotes it and closes the specific gaps.

**Source of truth:** `_bmad-output/planning-artifacts/native-refoundation-plan-2026-05-31.md` (code-grounded gap analysis + re-foundation plan). Extends the Epic 9 design note and `rubric-story-quality-2026-05-31.md`. Reuses E2 (team/personas), E3 (adapters/manifests/scan), E6 (standards/rubric).

Lands: a per-AC structured `verification` block — the spine (10.1); `tasks[]→ac_refs`, `cited_sources[]`, and a structured `narrative` (10.2); the four missing Tier-0 checks in the discipline validator, fail-closed at write + scan (10.3); `risk_tier` plumbed into the draft so the Considered lens grades at author time (10.4); a one-off, one-way BMad→native ingest seam (10.5); cutover to native-primary / BMad ingest-only (10.6); an end-to-end proof on a real feature (10.7).

**Status (2026-05-31):** active scaffold — all 5 §8 design decisions ratified by Jack 2026-05-31. Stories are thin stubs; `bmad-create-story` authors each full spec. Build-order: 10.3 shares the discipline-validator surface with the live Epic 6 calibration drain (6.5–6.8) — author now, build after that drain lands. Sequencing: 10.1 → 10.2 → 10.3 → 10.4 → 10.5 → 10.6 → 10.7.

---

**Dependency flow:**
E1 (foundation) → E2 (hire) ↔ E3 (backlog) → E4 (dev loop) → E5 (orchestration) ↔ E6 (calibration) → E7 (canary). **E8 (stateless substrate + Stage-1 dogfood)** supersedes the E5 daemon/`/watch` line and is the active proof-point workstream; it reuses the E2–E6 tool layer. **E9 (intake & judging — the planning cockpit)** is the new front half: gate 1 that feeds the E8 drain (gate 2), reusing the E2/E3/E6 tool layer and superseding E3's one-shot `/plan` as the ongoing planning surface. **E10 (native re-foundation)** promotes the E9-built native adapter to primary — enriching the native schema to carry everything the rubric grades, finishing Tier-0 in code, ingesting the BMad backlog one-way, and cutting over to native-primary (BMad ingest-only).

E2 and E3 are independent of each other (you can hire without a backlog; you can scan a backlog without hiring) but both are prerequisites for E4. E5 and E6 are independent of each other but both consume manifests + telemetry produced by E4.
