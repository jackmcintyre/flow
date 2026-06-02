# Core Architectural Decisions

## Decision Priority Analysis

**Critical (block implementation):**
- State-machine atomicity primitive (`fs.rename`)
- Workspace-root resolution (`<target-repo>/.flow/config.yaml`)
- MCP server stack (TypeScript on Node, single server, `@modelcontextprotocol/sdk`)
- Agent invocation model (per-story clean-context subagent, persona injected at spawn)
- GitHub wrapper (`execa` + per-agent subcommand allowlist)
- Persona-update gate (`<persona>/.proposed.md` sibling + `accept-proposal`)

**Important (shape architecture):**
- Planning-tool adapter model — see §Planning Adapter Model below; supersedes the "plugin owns story authorship" framing baked into the original PRD shape
- Story-ref scheme (`<adapter>:<source-id>` for external adapters; `native:<ULID>` for the no-tool path)
- Telemetry storage layout (`<target-repo>/.flow/telemetry/<YYYY-MM>.jsonl`)
- Verdict-comment idempotency marker (locked footer string)
- Yield-protocol domain matching (exact-match on `domain:`)
- Risk-tier classification spec format (YAML block in `docs/risk-tiering.md` + Markdown body; default fallback tier = `medium`)
- Fault-injection vitest harness shape

**Deferred (post-architecture working passes):**
- The actual content of `docs/risk-tiering.md` rules (format pinned now; rules drafted later)
- Logging-library tuning, ESLint/prettier configs
- Claude-Code-stub harness for full agent behaviour (validated by calibration loop, not mocks)

## State Machine & Persistence

> **Revised by §Planning Adapter Model.** The state machine now moves *plugin-owned manifest files* in `<target-repo>/.flow/state/{to-do,in-progress,blocked,done}/<ref>.yaml`; source story files stay where the planning tool put them. The mechanics (atomic `fs.rename`, no-two-states-at-once invariant, heartbeat-based stale-claim detection) are unchanged.

| Decision | Choice | Rationale |
|---|---|---|
| State-transition primitive | `fs.rename` (Node), same-filesystem only | NFR8 single-syscall atomicity; cross-filesystem moves out of scope |
| Story source ownership | Source files belong to the planning tool (BMad, etc.); plugin owns an *execution manifest* per story in `.flow/state/<state>/<ref>.yaml` | User picks their planning tool; we reference rather than copy (see §Planning Adapter Model) |
| Manifest file format | YAML, validated by Zod | Same conventions as other plugin-owned artifacts |
| Story ref scheme | `<adapter>:<source-id>` (e.g. `bmad:1.2.3`); `native:<ULID>` for users without a planning tool | Refs survive a tool switch; carry adapter identity for routing back to source |
| Frontmatter validation | Zod (TypeScript-first; runtime + compile-time types from one source) | Sprint-orchestrator precedent; superior DX over ajv |
| Rule registry parser | `yaml` package (eemeli) for `discipline-rules.yaml` | Round-trips comments, which matters for human-edited registries |
| Claim mechanism | Atomic move of the manifest from `to-do/` to `in-progress/` + `claimed_by` = session id (no lockfiles) | Avoids race surface of write-then-read on frontmatter |
| Stale-claim detection | Session writes a heartbeat file at `.crew/sessions/<session-id>.json` every N seconds; orchestration treats a story whose `claimed_by` has no heartbeat in the last `2× interval` as stale | Survives session death; no daemon needed; plain-file inspectable |
| Source drift detection | At claim time the manifest stores `source_hash` (sha256 of the source file); on each subagent read the hash is recomputed; mismatch → surface as a blocker, not a silent stale-spec run | Source content is outside our control; drift is a real failure surface that needs an explicit pathway |

## MCP Server Stack

| Decision | Choice | Rationale |
|---|---|---|
| Language/runtime | TypeScript on Node (LTS) | Step 3; sprint-orchestrator precedent |
| MCP SDK | `@modelcontextprotocol/sdk` (current stable; pinned at scaffold time) | First-party SDK |
| Server topology | Single MCP server exposing all canonical-state tools (story moves, retro recording, standards lookup, telemetry, team management, persona ops) | Matches sprint-orchestrator; simpler permissions surface |
| Workspace manager | pnpm workspace at the plugin root | Sprint-orchestrator precedent |
| Test framework | vitest | Sprint-orchestrator precedent |
| Logging library | pino (JSON-by-default; matches NFR21 JSONL contract) | Structured logs *are* the telemetry |
| Error model | Thrown exceptions with typed `Error` subclasses; MCP tool boundary converts to MCP error responses | Idiomatic for TS; keeps tool handlers thin |
| `gh` invocation wrapper | `execa` + per-agent allowlisted subcommand list, enforced before invocation | Better stderr/stdout handling than raw `child_process`; the allowlist is where NFR12 permissions live |

## Workspace Resolution (plugin / target-repo split)

| Decision | Choice | Rationale |
|---|---|---|
| Target-repo discovery | A per-target-repo config at `<target-repo>/.flow/config.yaml` marks the repo as a valid target; plugin reads it on every skill invocation | Explicit, version-controllable; avoids fragile cwd heuristics that bit sprint-orchestrator |
| Plugin location | Read from Claude Code's plugin loader (the plugin knows its own install path) | Native to the plugin contract |
| Same-repo vs split-repo | Treated identically — config file lives in the target repo's tree either way | Removes a code path |

## Telemetry & Observability

| Decision | Choice | Rationale |
|---|---|---|
| Storage layout | `<target-repo>/.flow/telemetry/<YYYY-MM>.jsonl` (monthly rollover, append-only) | One file per month keeps file size sane without per-day fragmentation |
| Schema | Discriminated-union JSONL events (`type:` field) — `agent.invoke`, `reviewer.verdict`, `yield.handoff`, `retro.proposal`, `state.transition`, `team.change` | Parseable without an LLM (NFR21) |
| Version stamping | Each `reviewer.verdict` event records `standards_version` and `plugin_version`; plugin version comes from the plugin manifest at startup | Matches FR35 / NFR22 |
| Stats helpers | Pure TS functions reading JSONL → deterministic output; exposed as MCP tools *and* CLI commands | Same code path for user and agents |

## Agent Invocation Model

| Decision | Choice | Rationale |
|---|---|---|
| Per-story subagent | Spawn a Claude Code subagent via the Task tool with a clean context per story | Matches FR24 (no mega-agent drift) |
| Persona injection | Dev/reviewer skill assembles subagent's system prompt = catalogue prompt body + persona knowledge section, read from the persona file at spawn time | One read at spawn; subagent doesn't re-read mid-flight |
| Verdict-comment idempotency marker | Locked footer: `<!-- crew:verdict:<plugin-version>:<story-id> -->`; reviewer rerun finds-by-grep and edits in place | Cheaper than parsing the whole comment body; matches NFR11 |
| Yield-protocol domain matching | Exact-match on `domain:` string declared in the catalogue spec; locked handoff phrase names role *and* domain so routing is unambiguous | Avoids hallucinated near-misses; mismatch surfaces as a blocker per FR100 |
| Persona-update gate | Append candidate written to `<persona>/.proposed.md` sibling; `/<plugin>:accept-proposal` is the only path that merges into `PERSONA.md` | Diff-then-confirm via filesystem, not in-memory state — survives session death |

## GitHub Integration

| Decision | Choice | Rationale |
|---|---|---|
| Invocation | `execa("gh", [...args])` with per-agent subcommand allowlist | NFR17, NFR12 |
| Error classification | `gh-error-map.yaml` shipped with the plugin: `(exit_code, stderr_regex) → defer | retry | needs-human` | NFR18 makes this an architecture deliverable; file format pinned here |
| Auth | None — inherits user's `gh` auth | PRD |

## Risk-Tier Classification (FR40a) — Spec Format

| Decision | Choice | Rationale |
|---|---|---|
| Spec location | `plugins/<plugin>/docs/risk-tiering.md` (shipped default) + override at `<target-repo>/docs/risk-tiering.md` | Same shape as standards: ship a default, target repo can override |
| Spec format | YAML block at the top of `risk-tiering.md` declaring `tiers:` with `path_patterns`, `change_types` (revert / migration / schema / dep-bump), `diff_size_thresholds`; Markdown body explains each tier | Parseable for automated classification; readable for the user |
| Default rules | Drafted in a later working pass once architecture is otherwise complete | Format is the v1-blocking deliverable; content can iterate |
| Fallback when no rule matches | `medium` (pauses for the user) | Conservative default |

## Testing

| Decision | Choice | Rationale |
|---|---|---|
| Unit + integration | vitest | Step 3 |
| Fault-injection harness | Custom vitest fixture that runs the MCP server against a temp directory and kills the worker at the three checkpoints named in NFR7 (mid-claim, mid-dev, post-handoff-pre-review) | NFR7 measurement is in-scope for the architecture deliverable |
| End-to-end | A canned scenario in `plugins/<plugin>/example/` driven by a vitest-orchestrated Claude Code session against a fixture target repo | Matches the bundled-example install canary |
| Out of v1 | A Claude-Code-stub harness for full agent behaviour — too costly to maintain | LLM behaviour is validated by the calibration loop, not by mocks |

## Decision Impact Analysis

**Implementation sequence:**

1. Scaffold plugin skeleton + `.claude-plugin/plugin.json` + pnpm workspace.
2. Stand up MCP server with the canonical-state tool surface (story moves, frontmatter validation via Zod).
3. Wire workspace resolution (`.flow/config.yaml`) and heartbeat-based session liveness.
4. Author catalogue templates + persona file machinery + `/<plugin>:hire`.
5. Plug the dev/reviewer subagent spawn + verdict idempotency marker into `/<plugin>:start`.
6. Wire telemetry JSONL + agreement-metric + outcome-stats helpers.
7. Author `docs/risk-tiering.md` spec + classifier.
8. Author retro + `accept-proposal` flow + rule registry → standards regeneration pipeline.
9. Bundle the example target repo + write README install path.
10. Wire fault-injection vitest harness for NFR7.

**Cross-component dependencies:**

- **MCP server + workspace resolution** must be in place before any skill can do useful work.
- **Heartbeat-based liveness** is a precondition for orchestration's stale-claim detection (FR51).
- **JSONL telemetry schema** is a precondition for the agreement metric, outcome stats, and team-fitness signals — so it should land early, not last.
- **Verdict idempotency marker convention** must be pinned before the first reviewer run, otherwise reruns stack and NFR11 fails retroactively.
