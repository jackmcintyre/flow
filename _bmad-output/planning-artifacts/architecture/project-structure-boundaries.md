# Project Structure & Boundaries

This project has **two distinct trees**:

- **Plugin tree** — what gets shipped (catalogue, skills, MCP server, adapters, example, docs templates).
- **Target-repo tree** — the per-project working set the plugin reads and writes. The plugin's tree is execution-layer-only (`.crew/`, `team/`, `docs/`); source story files live wherever the planning tool keeps them.

Both can live in the same repo (Jack dog-fooding) or different repos (Maya). The plugin discovers the target via `<target-repo>/.flow/config.yaml`.

The plugin's v1 working name is `crew`.

## Plugin tree

```
plugins/flow/
├── .claude-plugin/
│   └── plugin.json
├── catalogue/                                # FR82, FR83 — role templates
│   ├── hiring-manager.md
│   ├── planner.md                            # used by native adapter; thin pointer for external adapters
│   ├── generalist-dev.md
│   ├── generalist-reviewer.md
│   ├── retro-analyst.md
│   ├── orchestrator.md
│   ├── security-specialist.md
│   ├── test-specialist.md
│   ├── docs-specialist.md
│   └── debugger.md
├── skills/                                   # slash-commands
│   ├── plan.md                               # adapter-aware (native → planner; external → pass-through)
│   ├── start.md
│   ├── watch.md
│   ├── retro.md
│   ├── accept-proposal.md
│   ├── hire.md
│   ├── team.md
│   ├── ask.md
│   ├── status.md
│   ├── skip-hiring.md
│   └── scan.md                               # re-detect adapter sources / pick up new stories
├── permissions/
│   ├── generalist-dev.yaml
│   ├── generalist-reviewer.yaml
│   ├── …                                     # one per catalogue role
│   └── gh-error-map.yaml                     # NFR18 error classification
├── mcp-server/
│   ├── src/
│   │   ├── server.ts
│   │   ├── adapters/                         # planning-tool seam (Planning Adapter Model)
│   │   │   ├── adapter.ts                    # PlanningAdapter interface
│   │   │   ├── registry.ts                   # detect-order + lookup
│   │   │   ├── bmad/
│   │   │   │   ├── index.ts                  # v1 reference implementation
│   │   │   │   ├── parse-bmad-story.ts
│   │   │   │   ├── map-bmad-status.ts
│   │   │   │   ├── fixtures/                 # committed; powers integration tests
│   │   │   │   └── bmad.test.ts
│   │   │   └── native/
│   │   │       ├── index.ts
│   │   │       ├── planner-handoff.ts
│   │   │       └── native.test.ts
│   │   ├── tools/                            # MCP tools (one file per tool)
│   │   │   ├── claim-story.ts                # FR17 — moves manifest to/in-progress
│   │   │   ├── complete-story.ts             # FR19
│   │   │   ├── block-story.ts                # FR20
│   │   │   ├── scan-sources.ts               # adapter listSourceStories + reconcile
│   │   │   ├── read-source-story.ts          # adapter readSourceStory pass-through
│   │   │   ├── record-verdict.ts             # FR34
│   │   │   ├── record-story-retro.ts         # FR55 (writes lessons into manifest)
│   │   │   ├── lookup-standards.ts           # FR43–FR46
│   │   │   ├── regenerate-standards.ts       # FR48
│   │   │   ├── apply-rule-proposal.ts        # FR62
│   │   │   ├── apply-skill-proposal.ts       # FR63
│   │   │   ├── apply-team-change.ts          # FR107
│   │   │   ├── compute-agreement.ts          # FR67
│   │   │   ├── compute-outcome-stats.ts      # FR68, FR110
│   │   │   ├── read-catalogue.ts             # FR82–FR83
│   │   │   ├── instantiate-persona.ts        # FR89
│   │   │   ├── append-persona-knowledge.ts   # FR94, FR95
│   │   │   ├── read-persona.ts               # FR93
│   │   │   ├── lookup-role-by-domain.ts      # FR99
│   │   │   ├── record-yield.ts               # FR103, NFR29
│   │   │   ├── classify-risk-tier.ts         # FR40a
│   │   │   ├── heartbeat.ts                  # stale-claim liveness
│   │   │   ├── archive-cycle.ts              # FR69
│   │   │   └── mark-withdrawn.ts             # FR78 manifest-side discard
│   │   ├── schemas/                          # Zod
│   │   │   ├── source-story.ts               # normalised SourceStory shape
│   │   │   ├── execution-manifest.ts
│   │   │   ├── persona.ts
│   │   │   ├── catalogue.ts
│   │   │   ├── rule-registry.ts
│   │   │   ├── retro-proposal.ts
│   │   │   ├── telemetry-events.ts
│   │   │   └── workspace-config.ts
│   │   ├── state/
│   │   │   ├── manifest-state-machine.ts     # NFR8, NFR9 — atomic mv on manifests
│   │   │   ├── heartbeat-store.ts
│   │   │   ├── source-hash.ts                # drift detection
│   │   │   └── workspace-resolver.ts
│   │   ├── lib/
│   │   │   ├── gh.ts                         # execa + allowlist (NFR17, NFR12)
│   │   │   ├── logger.ts                     # pino → JSONL
│   │   │   ├── markdown-frontmatter.ts
│   │   │   ├── verdict-grammar.ts
│   │   │   ├── ulid.ts
│   │   │   └── ports.ts
│   │   ├── validators/
│   │   │   ├── standards-doc.ts              # FR44, FR46
│   │   │   ├── risk-tiering-spec.ts
│   │   │   └── execution-manifest.ts
│   │   └── errors.ts                         # DomainError, SourceDriftError, etc.
│   ├── tests/
│   │   ├── unit/
│   │   ├── integration/                      # fault-injection harness (NFR7)
│   │   └── fixtures/
│   ├── package.json
│   ├── tsconfig.json
│   └── vitest.config.ts
├── docs/
│   ├── standards-example.md                  # FR47 copy-target
│   ├── risk-tiering.md                       # FR40a default
│   ├── discipline-rules.example.yaml
│   ├── README-install.md                     # FR73
│   └── session-recovery.md                   # FR75
├── example/                                  # FR72 bundled scenario
│   ├── _bmad-output/                         # example BMad-shaped source stories
│   │   └── planning-artifacts/stories/...
│   ├── team/                                 # empty until hiring runs
│   ├── docs/
│   │   ├── standards.md
│   │   └── risk-tiering.md
│   └── .crew/
│       └── config.yaml                       # adapter: bmad
├── README.md
├── package.json
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

## Target-repo tree (BMad-shaped example)

```
<target-repo>/
├── _bmad-output/                             # OWNED BY BMad — we read only
│   └── planning-artifacts/stories/<id>.md
│
├── .crew/                         # OWNED BY THE PLUGIN
│   ├── config.yaml                           # adapter + adapter_config + plugin settings
│   ├── state/                                # execution layer
│   │   ├── to-do/<ref>.yaml
│   │   ├── in-progress/<ref>.yaml
│   │   ├── blocked/<ref>.yaml
│   │   └── done/<ref>.yaml
│   ├── sessions/<session-ulid>.json          # heartbeats
│   ├── telemetry/2026-05.jsonl
│   ├── retro-proposals/<ts>.md               # FR58
│   ├── sprint-history/<cycle>-<ts>.yaml      # FR69
│   └── native-stories/                       # native adapter only (absent for BMad-config repos)
│       └── <ref>.md
│
├── team/                                     # personas — owned by the plugin
│   ├── planner/PERSONA.md
│   ├── generalist-dev/PERSONA.md
│   ├── generalist-reviewer/PERSONA.md
│   ├── retro-analyst/PERSONA.md
│   ├── orchestrator/PERSONA.md
│   ├── <specialist>/PERSONA.md
│   ├── custom/<user-authored-role>.md        # FR92
│   └── _archived/<role>/PERSONA.md           # FR107
└── docs/
    ├── standards.md                          # regenerated from rule registry
    ├── risk-tiering.md                       # optional override
    └── discipline-rules.yaml                 # canonical rule registry
```

## Architectural boundaries

- **The MCP server is the only canonical-state boundary.** Skills and agents call MCP tools; nothing else writes to manifests, personas, standards, rule registry, telemetry. Direct `fs.write` to canonical paths by an agent is forbidden by the tool allowlist (NFR12, FR81).
- **Source files are read-only.** Adapters are the only code path that reads source story files; the rest of the plugin operates on normalised `SourceStory` + execution manifests. No tool writes to `_bmad-output/` (or any external adapter's source location).
- **Adapter registry is the planning-tool seam.** Adding a new planning tool means adding an adapter under `mcp-server/src/adapters/<name>/` and registering it. Nothing else in the codebase changes.
- **Catalogue is read-only at runtime.** Hiring instantiates *into* `team/` from a catalogue spec; the catalogue itself is never mutated by an agent. Catalogue changes happen via PR review.
- **Personas are read-mostly.** Knowledge appends go through `<persona>/.proposed.md` and `accept-proposal` (NFR26).
- **`gh` boundary.** All GitHub interaction goes through `mcp-server/src/lib/gh.ts`. No direct child-process spawning of `gh` elsewhere.
- **Telemetry is append-only.** Events written via `logger.ts`; never edited. Stats helpers read but never mutate.

## Requirements → location mapping (updated for adapter model)

| Capability group | Lives in |
|---|---|
| Planning (FR1–FR8) | Native: `skills/plan.md` + `catalogue/planner.md`. External: `skills/plan.md` is a pointer to the source tool; adapter implements `listSourceStories` / `readSourceStory` |
| Story persistence & state machine (FR9–FR23) | `.flow/state/<state>/<ref>.yaml`, `mcp-server/src/state/manifest-state-machine.ts`, `mcp-server/src/tools/{claim,complete,block,scan-sources}.ts` |
| Source-drift detection | `mcp-server/src/state/source-hash.ts`; surfaced via `SourceDriftError` and orchestration |
| Hiring (FR84–FR92) | `skills/hire.md`, `mcp-server/src/tools/{read-catalogue,instantiate-persona}.ts`, `catalogue/hiring-manager.md` |
| Persona management (FR93–FR97) | `team/`, `mcp-server/src/tools/{read-persona,append-persona-knowledge}.ts` |
| Yield protocol (FR98–FR104) | `mcp-server/src/tools/{lookup-role-by-domain,record-yield}.ts`, locked-phrase grammar in catalogue prompts |
| Dev loop (FR24–FR29) | `skills/start.md`, `catalogue/generalist-dev.md` |
| Review & verdict (FR30–FR42, FR40a) | `skills/start.md`, `catalogue/generalist-reviewer.md`, `mcp-server/src/tools/{record-verdict,classify-risk-tier}.ts`, `lib/verdict-grammar.ts` |
| Standards doc (FR43–FR48) | `mcp-server/src/tools/{lookup,regenerate}-standards.ts`, `validators/standards-doc.ts`, target-repo `docs/standards.md` |
| Orchestration (FR49–FR54) | `skills/watch.md`, `catalogue/orchestrator.md`, `mcp-server/src/state/heartbeat-store.ts` |
| Retro & calibration (FR55–FR64a) | `skills/{retro,accept-proposal}.md`, `catalogue/retro-analyst.md`, `mcp-server/src/tools/{apply-rule-proposal,apply-skill-proposal,apply-team-change}.ts`; lessons live in execution manifests (not source frontmatter) |
| Telemetry & outcome verification (FR65–FR70, NFR21–24) | `mcp-server/src/lib/logger.ts`, `mcp-server/src/tools/{compute-agreement,compute-outcome-stats,archive-cycle}.ts`, `.flow/telemetry/` |
| Install & onboarding (FR71–FR75) | `docs/README-install.md`, `example/`, root `README.md` |
| Non-engineer ergonomics (FR76–FR78) | `skills/ask.md`; FR78 discard via `mark-withdrawn.ts` + adapter's source-side discard for external adapters |
| Permissions (FR79–FR81, NFR12–16) | `permissions/<role>.yaml`, enforced by `mcp-server/src/lib/gh.ts` and the MCP tool layer |
| Team-change & team observability (FR105–FR110) | `mcp-server/src/tools/apply-team-change.ts`, `skills/{team,ask}.md` |
| Planning-tool integration (this section) | `mcp-server/src/adapters/<adapter>/`, `.flow/config.yaml`, `mcp-server/src/tools/{scan-sources,read-source-story}.ts` |

## Integration points

**Internal communication (between sessions):**

- Sessions share no in-memory state. All inter-session communication is via the filesystem:
  - Execution-state moves → `.flow/state/<state>/<ref>.yaml`
  - Liveness → `.crew/sessions/<session-id>.json` heartbeats
  - Telemetry → `.flow/telemetry/<YYYY-MM>.jsonl`
  - Proposals → `.flow/retro-proposals/<ts>.md`
- Sessions reach the MCP server via Claude Code's native MCP transport.

**External integrations:**

- **Planning tool** via the active adapter. Read-only — we never mutate the tool's files.
- **GitHub** via `gh` CLI (`mcp-server/src/lib/gh.ts`), inheriting user auth.
- **No other network surface.** No analytics, no remote logging.

**Data flow (per story, happy path, BMad adapter):**

1. User authors a story in BMad (`/bmad-create-story`); story file lands in `_bmad-output/.../stories/1.2.3.md`.
2. `/<plugin>:scan` or any state-changing skill triggers `scanSources` → BMad adapter's `listSourceStories` returns `bmad:1.2.3` as a new ref → `.flow/state/to-do/bmad:1.2.3.yaml` is written with `source_hash` captured.
3. Dev session's `start` skill calls `claimStory("bmad:1.2.3")` → atomic mv of manifest from `to-do/` → `in-progress/`.
4. Skill spawns dev subagent (clean context) with persona prompt assembled from `team/generalist-dev/PERSONA.md`; subagent reads source via `readSourceStory` → BMad adapter resolves path → returns normalised `SourceStory`.
5. Subagent recomputes `source_hash`; mismatch → `SourceDriftError` → skill calls `blockStory` with `blocked_by: source-drift`.
6. Dev subagent implements; emits handoff phrase; skill spawns reviewer subagent.
7. Reviewer reads source + diff + `docs/standards.md` + `discipline-rules.yaml`; calls `classifyRiskTier`, `recordVerdict`. `recordVerdict` writes JSONL event, stamps standards+plugin versions, posts/edits PR comment with footer marker `<!-- crew:verdict:<plugin-version>:bmad:1.2.3 -->`.
8. Low-risk + agreement-metric-clears → auto-merge via `gh pr merge`. Otherwise `needs-human` label.
9. On merge, skill calls `completeStory` → atomic mv `in-progress/` → `done/` + writes lessons into the manifest via `recordStoryRetro`.
10. End-of-cycle, `/retro` invokes retro analyst → reads done-state manifests + telemetry → writes proposal markdown → `accept-proposal` applies user-gated mutations (rule registry, standards regen, persona append, team change).

## Development workflow integration

- **Local development:** `pnpm install && pnpm build && pnpm test` at the plugin root.
- **Adapter integration tests:** each adapter under `mcp-server/src/adapters/<name>/` ships a fixture target repo of the relevant shape; vitest runs `listSourceStories`, `readSourceStory`, drift detection, and reconciliation against the fixture.
- **End-to-end canary:** vitest runs the canonical scenario in `example/` (BMad-shaped) against a temp clone of the bundled target.
- **No deployment artifact.** Distribution is "clone the repo and load the plugin" — no docker image, no npm publish, no service to run.
