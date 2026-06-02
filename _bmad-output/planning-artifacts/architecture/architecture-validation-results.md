# Architecture Validation Results

## Coherence Validation

**Decision compatibility.** All technology choices stack cleanly: TypeScript MCP server + pnpm workspace + vitest + Zod schemas + pino logging + execa + `yaml` package are mutually compatible and inherit the sprint-orchestrator precedent. No version conflicts pinned at this stage; specific semver pins land at scaffold time.

**Pattern consistency.** Plugin-owned artifacts (catalogue, persona, manifest, rule registry, retro proposals, skill files) all share the same YAML/`snake_case`/Zod-validated conventions defined in Pattern §1. Source story files are explicitly out of scope for those conventions — they belong to the adapter's contract. The Planning Adapter Model section makes this split unambiguous.

**Structure alignment.** The project structure supports every architectural decision: MCP server is the only canonical-state boundary; adapters live behind a single interface; execution layer is filesystem-only; permissions are version-controlled. The two-tree split (plugin tree + target-repo tree) is consistent across all flow diagrams and FR mappings.

**Cross-section coherence checked:**

- Refs (`<adapter>:<source-id>`) are used identically across telemetry events, verdict footer markers, locked handoff phrases, execution manifests, retro proposals, persona-knowledge entries, and skill `source_lesson_refs`.
- The atomic-`mv` state machine survives the adapter redesign — it now moves *manifest files*, but the invariants (single-syscall atomicity, never-two-states-at-once, heartbeat-based liveness) are unchanged.
- The skill calibration loop reuses the existing `accept-proposal` gate, the existing JSONL telemetry substrate, and the existing pattern of deterministic stat helpers; no new boundary added.

## Requirements Coverage Validation

**Functional requirements (110 FRs across 14 groups):**

| Group | Coverage | Notes |
|---|---|---|
| Planning conversation (FR1–FR8) | **Partial — see Gap 1** | Native adapter: full. External adapters: planning happens in the source tool; planning-discipline must shift from authoring-time to scan-time |
| Story files & backlog (FR9–FR14) | **Covered with PRD-literal divergence — see Gap 2** | FR9's `stories/<state>/<id>.md` shape replaced by `.flow/state/<state>/<ref>.yaml` execution manifests; PRD intent (atomic state via filesystem) fully preserved |
| Continuous-flow runtime (FR15–FR23) | ✓ Covered | Manifest-based state machine |
| Dev loop (FR24–FR29) | ✓ Covered | Per-story clean-context subagent, locked handoff |
| Review & verdict (FR30–FR42, FR40a) | ✓ Covered (FR40a content deferred — see Gap 4) | Verdict grammar, idempotency footer, agreement-metric gate all pinned; risk-tier rule content drafted in a later working pass |
| Standards doc (FR43–FR48) | ✓ Covered | Lookup, version-stamp, hard cap, regeneration from registry |
| Orchestration & blockers (FR49–FR54) | ✓ Covered + source-drift extension | Heartbeat-based stale-claim + new source-drift blocker surface |
| Retro & calibration (FR55–FR64a) | ✓ Covered | FR55 lessons live in manifest, not source frontmatter (intentional divergence; PRD intent satisfied) |
| Telemetry & outcome verification (FR65–FR70) | ✓ Covered | JSONL, deterministic helpers, monthly rollover, sprint-history archive |
| Install & onboarding (FR71–FR75) | ✓ Covered | Example is BMad-shaped; install path documented |
| Non-engineer ergonomics (FR76–FR78) | ✓ Covered (FR78 needs external-adapter clarification — see Gap 3) | `/ask` affordance, `mark-withdrawn` for manifest discard |
| Permissions & authority (FR79–FR81) | ✓ Covered | Per-role allowlists, MCP/execa enforcement |
| Team formation & persona (FR82–FR97) | ✓ Covered | Catalogue + persona file model unchanged by adapter redesign |
| Yield protocol (FR98–FR104) | ✓ Covered | Exact-match domain routing, locked handoff phrase |
| Team-change & observability (FR105–FR110) | ✓ Covered | Hire/unhire proposals through unified accept-proposal flow |

**Non-functional requirements (29 NFRs, 5 active categories):**

| Category | Status |
|---|---|
| Performance (NFR1–NFR5) | ✓ Covered | Soft/hard timeouts pinned; install-to-first-PR is a UX target dependent on README quality, no architectural blocker |
| Reliability (NFR6–NFR11) | ✓ Covered | Fault-injection harness mandated; idempotency required at every skill; atomic `fs.rename`; no-silent-failure assertion paired in CI |
| Security & permissions (NFR12–NFR16) | ✓ Covered | Tool allowlist enforced at runtime, version-controlled; no remote surface |
| Integration (NFR17–NFR20) | ✓ Covered | `gh` only, filesystem-only inter-session, Claude Code-only runtime; `gh-error-map.yaml` format pinned |
| Observability (NFR21–NFR29) | ✓ Covered + extended | JSONL schema closed; standards + plugin version stamping; deterministic helpers; `skill.invoke` event added |

## Implementation Readiness Validation

**Decision completeness.** Every critical decision named in the Priority Analysis has a chosen value and a rationale. Versions are not pinned to specific semver strings in this document; they are deferred to scaffold time so they're current when the first dev story runs. No decision blocks implementation.

**Structure completeness.** Both trees (plugin + target-repo) are specified file-by-file. The MCP tool list, schema list, and adapter directory are each enumerated. Skills are named and located.

**Pattern completeness.** 12 conflict surfaces identified and addressed. Locked phrases pinned with exact strings. Enforcement is in code (Zod schemas, grammar parsers), not in documentation prose.

## Gap Analysis

**Critical gaps (must close before / during implementation):**

*None blocking scaffold.* The architecture is implementable as-is. The items below are gaps that need a working-pass resolution but do not require revisiting the architecture itself.

**Important gaps:**

1. **External-adapter planning-discipline enforcement.** PRD's FR3/FR5/FR7 (planning-discipline conformance, integration-AC requirement for state-mutating stories, ship-gate refusal) assume the planner agent is authoring. With external adapters, source stories arrive from the planning tool — discipline must shift from authoring-time to **scan-time** (when `scanSources` reconciles the source into a manifest). Architecture recommendation: add a `validateAgainstDiscipline(SourceStory): DisciplineReport` method to the adapter contract, default-implemented by reading the same Zod schemas used internally. Non-conforming source stories surface as blockers (`blocked_by: planning-discipline`) with a one-line summary citing the missing AC or undeclared dependency. Lands in `mcp-server/src/adapters/adapter.ts`.

2. **PRD-literal divergence (FR9).** PRD says story files live in `stories/{to-do,in-progress,blocked,done}/`. The architecture moves source stories outside our tree and replaces our state directories with `.flow/state/<state>/<ref>.yaml` manifests. PRD intent (atomic state via filesystem) is fully preserved; the literal path is not. This needs a one-line flag in the PRD validation artefact, not an architecture change. **Action:** note in `prd-crew-v1-validation-report.md` follow-up that FR9's path is superseded by §Planning Adapter Model.

3. **FR78 discard semantics for external adapters.** For BMad-config repos, "discard a built feature" has two sides: the source tool's record (BMad's own status: Cancelled, or whatever it uses) and our manifest (`withdrawn: true`). Architecture recommendation: `mark-withdrawn` is a one-way operation on the manifest side; the user discards on the BMad side separately. The plugin surfaces a reminder ("you marked this withdrawn — remember to close it in BMad") and the orchestration session detects source-status drift between the two as a soft warning, not a blocker.

4. **FR40a default-rule content.** Spec format pinned (YAML block + Markdown body); default classification rules are a later working pass. Not blocking — planner assigns `risk_tier` manually with user confirmation until the rules are drafted.

5. **Cross-adapter `depends_on` edges.** The architecture allows refs to cross adapter namespaces but doesn't actively use the capability. Architecture recommendation: in v1, the dev loop's dependency check (FR18) refuses to claim a story whose `depends_on` includes any ref *not yet in `done/`*; namespace-crossing works automatically because refs are opaque strings to the dependency checker. No behaviour change needed; flagging for clarity.

6. **BMad source format specifics.** The BMad adapter's exact normalisation logic depends on BMad's current story file format (frontmatter fields, status vocabulary, dependency syntax). This needs a brief BMad-format spike *before* the BMad adapter implementation story, not before scaffold. Architecture-level interface is sufficient for now.

**Minor gaps:**

7. **Adapter detection ambiguity UX.** A near-empty repo may match no adapter (or both). Mitigation defined (first-invocation prompt; choice persists). Implementation quality matters; architecture sufficient.

8. **Retro-analyst manifest-scan efficiency.** Cycle-level retro reads all done-state manifests + telemetry. At current scale (≤thousands of stories per cycle in v1) the naive directory scan is fine. If a target repo's `done/` grows large enough to matter, a per-cycle index file becomes a Growth-phase item.

## Architecture Completeness Checklist

**Requirements Analysis**

- [x] Project context thoroughly analyzed
- [x] Scale and complexity assessed
- [x] Technical constraints identified
- [x] Cross-cutting concerns mapped

**Architectural Decisions**

- [x] Critical decisions documented with rationale
- [x] Technology stack fully specified (semver pins deferred to scaffold time, by design)
- [x] Integration patterns defined
- [x] Performance considerations addressed

**Implementation Patterns**

- [x] Naming conventions established
- [x] Structure patterns defined
- [x] Communication patterns specified
- [x] Process patterns documented

**Project Structure**

- [x] Complete directory structure defined
- [x] Component boundaries established
- [x] Integration points mapped
- [x] Requirements to structure mapping complete

## Architecture Readiness Assessment

**Overall Status: READY WITH MINOR GAPS.**

All 16 checklist items are confirmed `[x]`. No Critical Gaps remain. Six Important gaps are documented above; all are resolvable in working passes or non-blocking documentation updates, not architecture revisions. The architecture is implementable as-is, starting with the scaffold story.

**Confidence Level: High** for the architecture-of-the-architecture (state machine, MCP boundary, permissions model, calibration loop). **Medium** for the BMad adapter specifics — pending a short BMad-format spike before the BMad adapter story.

**Key strengths:**

- The two-layer model (source / execution) lets users keep their planning tool while preserving every reliability invariant from the original design.
- The calibration loop is symmetric: rules for "what shouldn't happen" + skills for "what should always happen," both flowing through one user-gated accept-proposal path, both measured deterministically.
- Permissions are code-enforced and version-controlled — not prompt-enforced.
- Local-first by construction: no daemon, no remote service, no analytics call-home.
- The shape-of-learning observable (constructive-to-defensive ratio) gives the writeup a single number to point at.

**Areas for future enhancement (post-v1):**

- Generative role creation by the hiring manager (PRD Growth item).
- Auto-applied trusted-domain persona updates (PRD Growth item).
- Per-cycle manifest index for very-large target repos.
- Plugin-shipped retro-promoted skills (cross-user evidence path).
- Hard cost caps + graceful budget enforcement.
- Adapters beyond BMad and native: Linear, GitHub Issues, plain Markdown folder.

## Implementation Handoff

**AI Agent Guidelines:**

- Follow architectural decisions exactly as documented; deviations require updating this document, not silently diverging.
- Use the locked phrases verbatim — they are routing infrastructure, not stylistic suggestions.
- Validate every plugin-owned artifact through its Zod schema before persisting.
- Emit a JSONL telemetry event for every action that mutates canonical state.
- For source story files, use the adapter interface — never read or write outside it.

**First implementation story:** scaffold the plugin skeleton (`plugins/flow/`) with `.claude-plugin/plugin.json`, pnpm workspace, empty MCP server entrypoint, and an empty `bmad` adapter that returns a hardcoded empty list. This story has zero behaviour but establishes every path, schema, and import the rest of the work depends on. From there, the implementation sequence is the one listed in §Core Architectural Decisions — Decision Impact Analysis.
