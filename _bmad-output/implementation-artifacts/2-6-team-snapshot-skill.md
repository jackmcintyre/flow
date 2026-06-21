# Story 2.6: `/team` snapshot skill

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin operator (Maya / Jack post-hire)**,
I want **a `/crew:team` slash command that prints a one-shot, deterministic snapshot of my hired team — each role's id, `domain:` from the persona frontmatter, the last N (default 3) entries from the persona's `## Knowledge` section, and a `fire count` derived from the `agent.invoke` events in `<target-repo>/.crew/telemetry/*.jsonl` — with NO LLM in the loop (pure file reads + JSONL stats helpers)**,
so that **I can check the team's current shape and observe which roles are firing how often without parsing files by hand and without paying the latency / token cost of a subagent (FR108, NFR28).**

### What this story is, in one sentence

Ship `plugins/crew/skills/team/SKILL.md` (new slash command that calls a single MCP tool and prints its text response verbatim, no `Task`), a new `getTeamSnapshot` MCP tool at `plugins/crew/mcp-server/src/tools/get-team-snapshot.ts` that composes `readPersona` (Story 2.3) over every hired role discovered under `<target-repo>/team/` with a new pure JSONL stats helper `lib/team-stats.ts` that scans `<target-repo>/.crew/telemetry/*.jsonl` for `agent.invoke` events and aggregates per-`agent` counts, a new `TeamSnapshotSchema` Zod shape under `mcp-server/src/schemas/team-snapshot.ts`, a pure renderer `renderTeamSnapshot` that produces the operator-facing text block, a new `permissions/<no-op>` change (none — `/crew:team` is operator-facing and does NOT spawn a subagent; no new role allowlist), and a vitest integration harness at `plugins/crew/mcp-server/tests/get-team-snapshot.test.ts` plus a skill self-consistency check.

### What this story fixes (and why it needs its own story)

Story 2.4 (`/crew:hire`) and Story 2.5 (`/crew:skip-hiring`) put personas on disk. Today there is no operator-facing surface to **read them back**. An operator who wants to see "what team did I hire?" must `ls team/` and `cat` each `PERSONA.md` by hand. That breaks two contracts:

- **FR108** — "The user can view the current team via slash-command (`/<plugin>:team`) — roles, domains, fire counts per role, recent persona-knowledge entries." There is no `/crew:team` skill in the repo.
- **NFR28** — "The current team's roster, each role's domain, recent persona-knowledge entries, and fire counts are readable without an LLM in the loop — pure file reads." Hand-`cat`ing files satisfies "no LLM" but not "readable" in any product sense; and once `appendPersonaKnowledge` ships in a later story, the Knowledge section will become more than three or four lines and hand-eyeballing won't scale.

This story closes both. It is also the v1 dry-run for **the "pure file reads + JSONL aggregation" pattern** that the calibration loop (Epic 6) will reuse for `computeOutcomeStats` and the rolling agreement metric — keeping the snapshot tool's IO and aggregation paths small and testable here means Epic 6 doesn't have to reinvent them.

Sibling Story 2.7 (`/crew:ask <role>`) opens an LLM side-session against a hired role. `/crew:team` is the deterministic counterpart — same fixture data (the persona files + the telemetry JSONL), opposite end of the LLM-in-loop axis. Pinning the read shape HERE (one tool, one renderer, one snapshot schema) keeps 2.7 a thin Task-spawning skill rather than a parallel reader.

### What this story does NOT

- (a) Touch `_bmad-output/implementation-artifacts/sprint-status.yaml` — the orchestrator owns status transitions.
- (b) Implement `appendPersonaKnowledge` or any persona-knowledge mutation. v1's Knowledge section is operator-hand-editable Markdown; the snapshot READS it. Knowledge appends via diff-then-confirm land in Epic 3+ (NFR26).
- (c) Implement `computeOutcomeStats` (FR68, FR110), `computeAgreement` (FR67, NFR24), or any retro / rule-fire aggregation. The `lib/team-stats.ts` helper is scoped to per-`agent` invocation counts ONLY — the FR65 `agent.invoke` event's `agent` field. Rule-fire counts and verdict-vs-action agreement are different aggregations (different event types, different windows) and live in Epic 6 stories.
- (d) Add a new telemetry event type. The closed v1 telemetry set (`agent.invoke`, `telemetry.invalid`) is unchanged. The snapshot tool READS existing `agent.invoke` events; it emits none. `/crew:team` invocations are operator-facing reads, not agent invocations (NFR21).
- (e) Modify `plugins/crew/mcp-server/src/schemas/{catalogue,persona,role-permissions,status-report,repo-signals,plugin-manifest,telemetry-events,workspace-config,standards-doc}.ts`. A new `team-snapshot.ts` is added alongside.
- (f) Modify `plugins/crew/mcp-server/src/tools/{get-status,read-catalogue,instantiate-persona,read-persona,lookup-role-by-domain,read-repo-signals,read-custom-role}.ts`. This story consumes `readPersona`; it does not modify it.
- (g) Modify `plugins/crew/mcp-server/src/lib/{logger,managed-fs,markdown-frontmatter,persona-file,plugin-root,plugin-version,workspace-resolver,gh,repo-signal-detectors}.ts`. A new `lib/team-stats.ts` is added alongside.
- (h) Modify any catalogue file. The catalogue is not consulted by `/crew:team` — the persona files are the source of truth post-hire (their frontmatter was copied from the catalogue at hire time per Story 2.3).
- (i) Modify any `permissions/<role>.yaml`. `/crew:team` does not spawn a subagent; there is no subagent allowlist to update. The new `getTeamSnapshot` MCP tool is invoked by the skill body directly via Claude Code's MCP transport.
- (j) Modify `plugins/crew/skills/{status,hire,skip-hiring}/SKILL.md`. The new skill is a sibling directory `skills/team/SKILL.md`.
- (k) Modify `plugins/crew/docs/README-install.md`. `/crew:team` is post-hire; it is not part of v1's six-checkpoint install. Epic 7 Story 7.2 may integrate it into the first-run-in-5-minutes walkthrough; that change is not in this story's scope.
- (l) Resolve the workspace adapter (`resolveWorkspace` / `validateActiveAdapter`). Unlike `/crew:status`, `/crew:team` does NOT depend on a planning adapter — it depends on `team/` (Story 2.3 contract) and `.crew/telemetry/` (Story 1.5 contract), both of which exist independently of any adapter. The skill takes `targetRepoRoot` directly.
- (m) Handle the un-hired-team case by spawning the hiring manager or auto-running `/crew:skip-hiring`. The snapshot prints a deterministic empty-state line and a cross-reference to `/crew:hire` and `/crew:skip-hiring`. Operator action follows; the skill does not redirect.
- (n) Sort, filter, or paginate beyond the contract pinned in AC1. v1 is a single-pass snapshot. Sorting toggles (by fire-count, by hired-at, alphabetical) are deferred.
- (o) Add archived-role surfacing. Personas under `<target-repo>/team/_archived/` (FR107, written by Epic 6's unhire flow) are EXCLUDED from the snapshot — the snapshot is "current team," not "team history."
- (p) Surface telemetry malformation as a hard error. If `<target-repo>/.crew/telemetry/*.jsonl` contains a malformed line, the helper logs it (via `lib/logger.ts`'s existing `telemetry.invalid` write path is NOT invoked from a reader — see Task 2.5), skips the line, and proceeds. Fire counts surface a `(N invalid lines skipped)` annotation under the affected month so the operator can act. The snapshot does NOT throw.
- (q) Surface persona-file malformation as a hard error for OTHER roles. A `PersonaFileMalformedError` on one role's persona produces a per-role error line in the snapshot output (e.g. `error: <zod-message>`) and the snapshot continues for the remaining roles. This is the symmetric pattern to Story 1.7's `getStatus` downgrade reporting — local malformation is not a global failure.
- (r) Modify the dispatcher pattern. Tool registration in `tools/register.ts` is one new `server.registerTool({...})` call appended after the Story 2.5 `readCustomRole` entry. No reordering, no abstraction.
- (s) Touch the dev-loop, retro, orchestrator, or any non-team-observability flow.

---

## Acceptance Criteria

> **Verbatim mapping.** ACs 1–3 map to the epic ACs in `_bmad-output/planning-artifacts/epics/epic-2-team-formation-hiring-personas-and-team-observability.md` § Story 2.6. AC4 is a story-scoped self-consistency addition that hard-pins the skill file shape (Story 1.8 lesson — user-surface contracts are pinned, not advisory).
>
> **User-surface judgement.** AC1 names the operator-typed slash command `/crew:team` AND the verbatim text the operator reads on screen — `user-surface` per rubric (i) and (iv). AC2 pins the "no LLM in the loop" implementation contract — it names only internal modules (`lib/team-stats.ts`, the MCP tool, the renderer) and tool-layer behaviour; the operator never types or observes any of those names. NOT `user-surface`. AC3 is the vitest integration contract; the operator never types `pnpm --dir plugins/crew test`. NOT `user-surface`. AC4 names `plugins/crew/skills/team/SKILL.md` only as a self-consistency assertion target (the test reads the file by absolute path; the operator never opens it). NOT `user-surface`. The pre-PR smoke gate (Story 1.8 / `plugins/crew/docs/user-surface-acs.md`) will require operator-paste-output or an automated-e2e verification event covering AC1.

**AC1 (user-surface):**
**Given** a target repo with `<target-repo>/team/` containing at least one hired role (per Story 2.3 / 2.4 / 2.5 — a subdirectory `<role>/` containing a `PERSONA.md` that parses via `parsePersonaFile`) and optionally `<target-repo>/.crew/telemetry/*.jsonl` containing zero or more `agent.invoke` events,
**When** the operator runs `/crew:team` from inside Claude Code with that target repo loaded as the workspace,
**Then** the skill calls `getTeamSnapshot({ targetRepoRoot })` exactly once, prints the tool's text response verbatim, and exits cleanly without spawning any subagent and without prompting the operator for input. The printed text block has the following deterministic shape, one role-stanza per hired role in **lexicographic order by role id** (so the output is stable across runs and across machines):

```
crew team — <N> role(s)

<role-id-1>
  domain:      <domain string from persona frontmatter>
  fire count:  <integer>
  knowledge (last <K>):
    - <most-recent entry text, one line>
    - <next-most-recent entry text, one line>
    - <…up to K entries…>

<role-id-2>
  domain:      …
  fire count:  …
  knowledge (last <K>):
    (no entries)

…
```

Where:
- `<N>` is the count of hired roles (subdirectories under `team/` excluding `custom/` and `_archived/` that contain a `PERSONA.md`).
- `<K>` is the requested entry count — default `3`, settable per-invocation via an optional `knowledgeLimit` argument the skill body passes to `getTeamSnapshot`; in v1 the skill always passes `3`.
- The `fire count:` integer is the count of `agent.invoke` events under `<target-repo>/.crew/telemetry/*.jsonl` whose `agent` field equals the role id, across **all** month-bucket files present (no time window in v1).
- The `knowledge (last <K>):` block lists the last `K` top-level Markdown list items (`^- ` lines, with the leading `- ` stripped) from the persona's `## Knowledge` section, in **reverse file order** (bottom-most bullet first — i.e. most-recently-appended, since the operator-facing knowledge convention is "append at the bottom"). If the section is empty or contains no top-level `^- ` bullets, the literal line `    (no entries)` is printed.
- If the role's persona fails to parse (`PersonaFileMalformedError`), the stanza prints only `  error: <zod-message>` after the `<role-id>` line and the snapshot continues with the remaining roles.
- If `team/` is absent or empty, the printed text block is the literal:
  ```
  crew team — 0 role(s)

  No hired roles found. Run /crew:hire to hire a project-shaped team, or /crew:skip-hiring to hire the default roster.
  ```
- If telemetry files exist but contain malformed lines, the snapshot is rendered as above AND a final line `(<M> malformed telemetry line(s) skipped across <F> file(s))` is appended after the last role stanza. If no malformed lines exist, the annotation is omitted entirely. _(FR108, NFR28)_

<!-- user-surface: AC1 names the slash command literal `/crew:team` (rubric i), the cross-referenced `/crew:hire` and `/crew:skip-hiring` in the empty-state line (rubric i), and the entire text block the operator reads on screen including the per-role stanzas, the `(no entries)` literal, and the malformed-line annotation (rubric iv). -->

**AC2:**
**Given** the implementation of `getTeamSnapshot` and `renderTeamSnapshot`,
**When** the dev agent reviews the code path,
**Then** the snapshot is computed via pure file reads (`fs.readFile` / `fs.readdir` via the existing `readPersona` reader for personas; direct `fs.readFile` + line-split for `.crew/telemetry/*.jsonl` in the new `lib/team-stats.ts`) and pure JSONL aggregation (a `for`-loop over JSON-parsed lines, with per-line Zod validation via `TelemetryEventSchema.safeParse` — see Tasks 2.3–2.4), with **no `Task` spawn**, no MCP-side LLM call, no network IO, no `execa` call, and no telemetry emit. The `getTeamSnapshot` tool's call graph terminates entirely in the MCP server process: `readPersona` (per role) + `lib/team-stats.ts` (per `.crew/telemetry/*.jsonl` file) + `renderTeamSnapshot` (pure formatter). The skill body's `allowed_tools` frontmatter is exactly `[Read]` — no `Task`, no `Bash`, no `Edit`. _(NFR28)_

**AC3 (integration):**
**Given** the new `plugins/crew/skills/team/SKILL.md`, the new `getTeamSnapshot` MCP tool, the new `lib/team-stats.ts` helper, the new `schemas/team-snapshot.ts`, an updated `tools/register.ts` (one appended entry), and the integration harness at `plugins/crew/mcp-server/tests/get-team-snapshot.test.ts`,
**When** `pnpm --dir plugins/crew test` runs,
**Then** vitest asserts, against four temp-dir fixture target repos:
- **(a) Hired team + seeded telemetry** (`<TMP_A>`): pre-seeded with five default-roster personas via `instantiatePersona` (Story 2.3); the `planner` persona has its `## Knowledge` section hand-rewritten to contain a four-bullet block (`- alpha\n- beta\n- gamma\n- delta`); `<TMP_A>/.crew/telemetry/2026-05.jsonl` is hand-written with seven valid `agent.invoke` events (`generalist-dev`: 3, `generalist-reviewer`: 2, `planner`: 1, `orchestrator`: 1; no events for `retro-analyst`). Call `getTeamSnapshot({ targetRepoRoot: TMP_A, knowledgeLimit: 3 })`. Assert the returned `TeamSnapshot` object: (i) `roles.length === 5`, (ii) `roles` is sorted lexicographically by `role` (so `generalist-dev, generalist-reviewer, orchestrator, planner, retro-analyst`), (iii) each role's `domain` equals the catalogue's domain for that role, (iv) `fireCount` for each role matches the seeded counts (`retro-analyst: 0`), (v) the `planner` stanza's `knowledge` is `["delta", "gamma", "beta"]` (last 3, reverse file order), (vi) the other four roles' `knowledge` is `[]`, (vii) `malformedTelemetryLines === 0`, (viii) `malformedTelemetryFiles === 0`. Then call `renderTeamSnapshot(snapshot)` and assert the output is byte-identical to a checked-in fixture string (or built via a helper assertion that constructs the expected string from the snapshot — author's discretion; the contract is that the renderer is pure and deterministic).
- **(b) Empty-team fixture** (`<TMP_B>`): no `team/` directory. Call `getTeamSnapshot({ targetRepoRoot: TMP_B })`. Assert `roles.length === 0`, `malformedTelemetryLines === 0`. Call `renderTeamSnapshot` and assert the output is exactly the empty-state block from AC1 (with `crew team — 0 role(s)` and the cross-reference line).
- **(c) Custom-role hired** (`<TMP_C>`): pre-seeded with the default roster AND a hand-authored `<TMP_C>/team/custom/data-scientist.md` followed by `instantiatePersona({ targetRepoRoot: TMP_C, role: "data-scientist" })` (per Story 2.5 — the custom-role persona lives at `team/data-scientist/PERSONA.md`, NOT under `team/custom/`). Assert the snapshot includes `data-scientist` as a normal role stanza in lexicographic order; the snapshot does NOT distinguish catalogue-rooted from custom-rooted personas at render time (the operator already knows from the proposal-time `(custom)` suffix; post-hire, custom roles are peers per Story 2.5 § Design rationale).
- **(d) Malformed telemetry + malformed persona** (`<TMP_D>`): pre-seeded with two default-roster personas (`planner`, `generalist-dev`); `<TMP_D>/team/generalist-dev/PERSONA.md` is then corrupted (e.g. delete the `## Knowledge` heading) so it fails `parsePersonaFile`; `<TMP_D>/.crew/telemetry/2026-05.jsonl` is hand-written with five lines, two of which are not valid JSON (`{ bad`) and one of which is valid JSON but fails `TelemetryEventSchema` (missing `data` field). Call `getTeamSnapshot({ targetRepoRoot: TMP_D })`. Assert: (i) `roles.length === 2`, (ii) the `planner` stanza is fully populated, (iii) the `generalist-dev` stanza has `error` set to a non-empty string containing the persona file path AND the Zod issue (the `state: "error"` discriminated-union variant has only `role` and `error` fields — `domain`, `fireCount`, and `knowledge` are structurally absent from this variant, not `null`), (iv) `malformedTelemetryLines === 3` (two JSON-parse failures plus one Zod failure), (v) `malformedTelemetryFiles === 1`. Call `renderTeamSnapshot` and assert the output contains the malformed-line annotation `(3 malformed telemetry line(s) skipped across 1 file(s))` and a `  error: ...` line under `generalist-dev`.
- **(e) Tool registration:** the MCP `ListTools` response includes `{ name: "getTeamSnapshot" }` alongside the prior seven tools (`getStatus`, `readCatalogue`, `instantiatePersona`, `readPersona`, `lookupRoleByDomain`, `readRepoSignals`, `readCustomRole`) — eight total. The order of prior entries is preserved.
- **(f) No telemetry emit by the tool itself:** seed `<TMP_E>` with no telemetry directory, call `getTeamSnapshot({ targetRepoRoot: TMP_E })`, assert `<TMP_E>/.crew/telemetry/` does NOT exist after the call. (`/crew:team` is a read; it MUST NOT create the telemetry directory as a side-effect.)
- **(g) Reverse file order for knowledge:** the AC3(a) `planner` knowledge assertion (`["delta", "gamma", "beta"]`) verifies that the `lib/team-stats.ts` / persona-parse path uses **file-order reversed** (bottom-most bullet first), NOT alphabetical, NOT first-N. Add an explicit assertion comparing against the alphabetical `["alpha", "beta", "delta"]` and the first-N `["alpha", "beta", "gamma"]` to make the regression visible if the order rule is wrongly implemented.
- **(h) Lexicographic role order:** seed `<TMP_F>` with personas instantiated in the reverse default-roster order (`orchestrator, retro-analyst, generalist-reviewer, generalist-dev, planner`). Assert the snapshot's `roles` array is still sorted lexicographically — output order is independent of `fs.readdir` order (which is OS-dependent).
- **(i) Archived personas excluded:** seed `<TMP_G>` with the default roster AND a `team/_archived/old-role/PERSONA.md` (any catalogue-shaped persona). Assert the snapshot's `roles` array does NOT include `old-role`.
- **(j) Knowledge entry stripping:** seed a `team/planner/PERSONA.md` with `## Knowledge` containing bullets that have leading/trailing whitespace, multi-line wrapped bullets (continuation lines indented two spaces), and code-fenced sub-bullets. Assert: (1) only top-level `^- ` lines count (continuation lines don't double-count), (2) the leading `- ` is stripped, (3) trailing whitespace is trimmed, (4) the entry text is the first line of the bullet only (continuation lines are truncated — the snapshot is a one-liner per entry, NOT a Markdown re-renderer).

Any failure surfaces a diagnostic naming the failing AC, the fixture, the role / file path, the expected vs actual fire count or knowledge array, and the Zod issue (for persona / telemetry malformation cases).

**AC4:**
**Given** the new `plugins/crew/skills/team/SKILL.md`,
**When** the file is read after Task 5,
**Then** (i) the YAML frontmatter parses and `name === "crew:team"`, (ii) `allowed_tools` is exactly `["Read"]` (NO `Task`, NO `Bash`, NO `Edit` — the snapshot is a print-only read), (iii) the body contains the section headers `# What this skill does`, `# Prerequisites`, `# Steps`, `# Failure modes` in that exact order per `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` §8, (iv) the `# Steps` section names the MCP tool `getTeamSnapshot` and instructs the body to print the tool's text response verbatim (no post-processing), (v) the body references `/crew:team` at least once and cross-links to `/crew:hire` and `/crew:skip-hiring` (so the operator who runs `/crew:team` on a fresh repo knows where to go). _(self-consistency; Story 1.8 lesson — skill-shape contracts are tested, not advisory)_

---

## Tasks / Subtasks

- [x] **Task 1 — Author `TeamSnapshotSchema` (AC: 1, 3)**
  - [x] 1.1 Create `plugins/crew/mcp-server/src/schemas/team-snapshot.ts`. New file. Pattern after `status-report.ts` (Story 1.7) for the discriminated-state shape on a per-role basis.
  - [x] 1.2 Define `TeamSnapshotRoleSchema` as a `z.discriminatedUnion("state", [...])` over two variants:
    - `state: "ok"` — fields: `role: string (kebab regex)`, `domain: string`, `fireCount: z.number().int().nonnegative()`, `knowledge: z.array(z.string())` (the N most recent entries, reverse-file-order, leading `- ` stripped, trimmed, single-line).
    - `state: "error"` — fields: `role: string (kebab regex)`, `error: string` (the `PersonaFileMalformedError`'s message, including the persona path).
  - [x] 1.3 Define `TeamSnapshotSchema` as `z.object({ roles: z.array(TeamSnapshotRoleSchema), knowledgeLimit: z.number().int().positive(), malformedTelemetryLines: z.number().int().nonnegative(), malformedTelemetryFiles: z.number().int().nonnegative() }).strict()`.
  - [x] 1.4 Export `TeamSnapshot = z.infer<typeof TeamSnapshotSchema>` and `TeamSnapshotRole = z.infer<typeof TeamSnapshotRoleSchema>`.
  - [x] 1.5 Do NOT add this schema to the telemetry event union (`telemetry-events.ts`). `TeamSnapshot` is a per-invocation read return shape, not a logged event.
  - [x] 1.6 No new error class. Persona errors surface as the `error` variant string; telemetry malformation surfaces as the count annotations on the parent `TeamSnapshot`. The tool itself throws no domain error.

- [x] **Task 2 — Author `lib/team-stats.ts` (AC: 1, 2, 3)**
  - [x] 2.1 Create `plugins/crew/mcp-server/src/lib/team-stats.ts`. New file. Pattern after `lib/plugin-version.ts` (small, pure, single-purpose) for the file-reading idiom. Co-located test file `tests/team-stats.test.ts`.
  - [x] 2.2 Export `async function readTeamTelemetryStats(opts: { targetRepoRoot: string }): Promise<{ fireCountsByAgent: Record<string, number>; malformedLines: number; malformedFiles: number }>`.
  - [x] 2.3 Behaviour: (a) compute `telemetryDir = path.join(opts.targetRepoRoot, ".crew", "telemetry")`. If absent (`ENOENT` on `fs.readdir`), return `{ fireCountsByAgent: {}, malformedLines: 0, malformedFiles: 0 }`. (b) For each entry under `telemetryDir` whose name matches `^\d{4}-\d{2}\.jsonl$` (the Story 1.5 / `lib/logger.ts` month-bucket pattern), `fs.readFile` UTF-8 and split on `\n`. (c) For each non-empty line: try `JSON.parse(line)`. On parse failure → increment `malformedLines` (and mark the file dirty). On parse success → run `TelemetryEventSchema.safeParse(parsed)`. On Zod failure → increment `malformedLines` (and mark file dirty). On Zod success → if `parsed.type === "agent.invoke"`, increment `fireCountsByAgent[parsed.agent]` (default 0); other `type` values are valid-but-not-counted and do NOT mark the file dirty. (d) `malformedFiles` is the count of files in which at least one malformed line was seen.
  - [x] 2.4 Use `TelemetryEventSchema` from `schemas/telemetry-events.ts` for the per-line validation. Do NOT re-implement the discriminated union locally. Reusing the schema means future event types (Epic 4+) are silently tolerated without rewriting this helper.
  - [x] 2.5 Do NOT call `logTelemetryEvent` on malformed lines. The logger is a **writer**; this helper is a **reader**. Re-writing the malformed line as a `telemetry.invalid` event would mutate the operator's telemetry file under a read-only contract (NFR21 / NFR28). The malformed-line counts surface via the return value and the renderer's annotation; that is the only feedback channel in v1.
  - [x] 2.6 No telemetry emit. No network IO. No `execa`. No clock dependency. Pure file IO + JSON.parse + Zod.
  - [x] 2.7 Trailing-empty-line tolerance: when splitting on `\n`, the last element of the array is `""` if the file ends with `\n` (per Story 1.5 logger contract). Skip empty lines; do NOT count them as malformed.
  - [x] 2.8 The helper does NOT depend on `targetRepoRoot` having a `.crew/config.yaml`. `/crew:team` works on a hired-but-otherwise-fresh repo where the adapter has not been resolved.

- [x] **Task 3 — Co-locate unit tests for `lib/team-stats.ts` (AC: 2, 3)**
  - [x] 3.1 Create `plugins/crew/mcp-server/tests/team-stats.test.ts`. New file. Pattern after `telemetry-logger.test.ts`'s temp-dir idiom.
  - [x] 3.2 Cases: (a) no telemetry dir → `{ fireCountsByAgent: {}, malformedLines: 0, malformedFiles: 0 }`; (b) one month file, three valid `agent.invoke` events for two distinct agents → correct per-agent counts; (c) one month file with mixed valid + JSON-malformed + Zod-malformed lines → correct counts + correct `malformedLines` + `malformedFiles === 1`; (d) two month files (`2026-04.jsonl`, `2026-05.jsonl`) → counts aggregate across both; (e) a file named `2026-13.jsonl` (invalid month) is IGNORED — the regex `^\d{4}-\d{2}\.jsonl$` allows it lexicographically but the helper's contract is "any matching filename is read"; for v1 we accept the lexical match (no calendar validation) — assert behaviour matches contract (read it, count whatever's inside); (f) a `telemetry.invalid` event in a file does NOT count toward `fireCountsByAgent` AND does NOT increment `malformedLines` (it parsed fine; it's just not an `agent.invoke`); (g) trailing newline → no spurious empty-line malformation.

- [x] **Task 4 — Author `getTeamSnapshot` MCP tool + `renderTeamSnapshot` (AC: 1, 2, 3)**
  - [x] 4.1 Create `plugins/crew/mcp-server/src/tools/get-team-snapshot.ts`. New file. Pattern after `tools/get-status.ts` (Story 1.7) for the "compose readers → typed report → render" shape.
  - [x] 4.2 Export `interface GetTeamSnapshotOptions { targetRepoRoot: string; knowledgeLimit?: number }`. Default `knowledgeLimit = 3`.
  - [x] 4.3 Export `async function getTeamSnapshot(opts: GetTeamSnapshotOptions): Promise<TeamSnapshot>`. Algorithm:
    1. `const teamDir = path.join(opts.targetRepoRoot, "team")`.
    2. `fs.readdir(teamDir)`; on ENOENT, call `readTeamTelemetryStats({ targetRepoRoot })` and return `{ roles: [], knowledgeLimit, malformedTelemetryLines: stats.malformedLines, malformedTelemetryFiles: stats.malformedFiles }` (telemetry may still exist on a fresh-but-pre-hired repo — surface its malformed-line counts even when no roles are hired; this is symmetric to the AC1 annotation contract).
    3. Filter `readdir` entries: skip `custom`, `_archived`, hidden entries (`.git`, `.DS_Store`, anything starting with `.`); for each remaining entry, `fs.stat` and check `isDirectory()`; for each directory, check `<entry>/PERSONA.md` exists via `fs.access` (cheap negative-test before invoking `readPersona`). Collect the surviving role-id list.
    4. Sort the surviving role-id list **lexicographically** (`Array.prototype.sort()` with default string comparator — output stability).
    5. Call `readTeamTelemetryStats({ targetRepoRoot })` once. Cache the result.
    6. For each role id in lexicographic order, `try { const p = await readPersona({ targetRepoRoot, role }); }` → emit `{ state: "ok", role, domain: p.domain, fireCount: stats.fireCountsByAgent[role] ?? 0, knowledge: extractKnowledgeEntries(p.sections.Knowledge, knowledgeLimit) }`. `catch (err)` where `err instanceof PersonaFileMalformedError` → emit `{ state: "error", role, error: err.message }`. Any other thrown error propagates (programming bug).
    7. Validate the assembled `TeamSnapshot` against `TeamSnapshotSchema.parse(...)` before returning.
  - [x] 4.4 Export `function extractKnowledgeEntries(knowledgeBody: string, limit: number): string[]`. Behaviour:
    - Split `knowledgeBody` on `\n`. Iterate. For each line, test against `/^-\s+(.+?)\s*$/` (top-level Markdown bullet). NOTE — explicitly NOT `/^\s*-\s+/`: indented bullets are continuation/sub-bullets and do NOT count as top-level entries. Capture the bullet's first-line text (group 1).
    - Continuation lines (the next lines after a `^- ` bullet that start with whitespace OR are not blank-and-not-a-new-bullet) are SKIPPED — the snapshot is one-liner-per-entry. Do NOT collect them into the entry text.
    - Collect into an array `entries: string[]` in file order.
    - Return `entries.slice(-limit).reverse()` — last `limit` entries, in reverse file order (most-recent first).
    - If `entries.length === 0`, return `[]`.
  - [x] 4.5 Export `function renderTeamSnapshot(snapshot: TeamSnapshot): string`. Pure formatter — no IO, no clock. Build the text block per AC1's specification:
    - Header line: `crew team — <N> role(s)` where `N = snapshot.roles.length`.
    - Blank line.
    - For each role (in `snapshot.roles` order — which is already lexicographic from Task 4.3 step 4):
      - `<role-id>` (no indent).
      - If `state === "error"`: `  error: <error>` and continue to next role.
      - If `state === "ok"`:
        - `  domain:      <domain>`
        - `  fire count:  <fireCount>`
        - `  knowledge (last <knowledgeLimit>):`
        - For each entry in `knowledge` (already reverse-file-order): `    - <entry>`.
        - If `knowledge.length === 0`: `    (no entries)`.
      - Blank line (except after the last role).
    - If `snapshot.roles.length === 0`: header line, blank line, then the literal `No hired roles found. Run /crew:hire to hire a project-shaped team, or /crew:skip-hiring to hire the default roster.`. (No per-role stanzas.)
    - If `snapshot.malformedTelemetryLines > 0`: append a final blank line, then `(<M> malformed telemetry line(s) skipped across <F> file(s))` where `M = malformedTelemetryLines`, `F = malformedTelemetryFiles`. If `M === 0`, the annotation is omitted entirely (do NOT print `(0 malformed telemetry line(s) skipped across 0 file(s))`).
    - The return value has NO trailing newline (matches `renderStatus` from Story 1.7). The MCP tool handler wraps it in `{ type: "text", text }`.
  - [x] 4.6 No telemetry emit. No `Task` spawn. No `execa`. No network IO. The function graph is `getTeamSnapshot → readPersona (per role) + readTeamTelemetryStats (once) → renderTeamSnapshot`. Asserted by AC2 and Task 7.4.

- [x] **Task 5 — Author `plugins/crew/skills/team/SKILL.md` (AC: 1, 4)**
  - [x] 5.1 Create the directory `plugins/crew/skills/team/` and file `plugins/crew/skills/team/SKILL.md`. Match the directory shape used by `plugins/crew/skills/{status,hire,skip-hiring}/SKILL.md`. The slash command surfaces as `/crew:team` per implementation-patterns-consistency-rules §8.
  - [x] 5.2 Frontmatter (verbatim):
    ```yaml
    ---
    name: crew:team
    description: Print a one-shot snapshot of your hired team — roles, domains, recent knowledge entries, fire counts.
    allowed_tools: [Read]
    ---
    ```
    `allowed_tools` is `[Read]` — NO `Task` (no subagent), NO `Bash`, NO `Edit`. The skill body's only side-effect is print-to-screen via the MCP tool's text response.
  - [x] 5.3 Body sections per implementation-patterns-consistency-rules §8: `# What this skill does`, `# Prerequisites`, `# Steps`, `# Failure modes`.
  - [x] 5.4 `# What this skill does` (verbatim or close): one paragraph describing the snapshot — roles, domains, fire counts, recent knowledge entries — with the explicit "no LLM in the loop" note so the operator understands why the response is instant. Cross-link `/crew:hire` (for project-shaped hiring) and `/crew:skip-hiring` (for the default roster) so an operator who runs `/crew:team` against a fresh repo knows what to do next.
  - [x] 5.5 `# Prerequisites`: a target repo with at least one hired role under `<target-repo>/team/<role>/PERSONA.md`. `.crew/config.yaml` is NOT required (the skill takes `targetRepoRoot` directly; the adapter is not consulted).
  - [x] 5.6 `# Steps`:
    1. Identify the target repo root (current Claude Code workspace root as `targetRepoRoot`). Do NOT call `getStatus` — the adapter resolution is not needed.
    2. Call the `getTeamSnapshot` MCP tool with `{ targetRepoRoot, knowledgeLimit: 3 }`.
    3. Print the tool's text response verbatim (it is already the rendered snapshot per `renderTeamSnapshot`). No post-processing.
  - [x] 5.7 `# Failure modes`:
    - **No `team/` directory:** the snapshot renders the empty-state block per AC1; not a failure.
    - **A single persona file is malformed:** the per-role stanza prints `  error: <message>`; the snapshot continues for the remaining roles. Operator opens the file and fixes the malformation (the persona is plain Markdown per NFR25); `git revert <persona-path>` is the bail-out.
    - **Telemetry contains malformed lines:** the snapshot renders normally; a final annotation line surfaces the malformed-line count. Operator can inspect `<target-repo>/.crew/telemetry/<YYYY-MM>.jsonl` directly — the lines that failed are typically the most recent (a writer crash mid-line); `tail -n 50` usually locates them.
    - **`getTeamSnapshot` throws on a non-malformation error:** propagated by the MCP transport as a tool error. This is a programming bug; surface the error verbatim.
  - [x] 5.8 Do NOT spawn a subagent. Do NOT call any other MCP tool from this skill body. Do NOT call `getStatus`, `readCatalogue`, `readPersona`, `lookupRoleByDomain`, or `readRepoSignals` from the skill body (composition lives inside `getTeamSnapshot`, not the skill body).

- [x] **Task 6 — Wire `getTeamSnapshot` into the MCP dispatcher (AC: 1, 3)**
  - [x] 6.1 Edit `plugins/crew/mcp-server/src/tools/register.ts`. Append one `server.registerTool({...})` call after the Story 2.5 `readCustomRole` registration. Tool definition:
    - `name`: `"getTeamSnapshot"` (camelCase verb-noun per implementation-patterns-consistency-rules §4; `get` prefix marks it as a reader, matching `getStatus`).
    - `description`: `"Return a typed snapshot of the hired team — roles, domains, fire counts from telemetry, recent persona-knowledge entries. Used by /crew:team (FR108, NFR28). Pure file reads; no LLM in the loop."`
    - `inputSchema`: `{ type: "object", properties: { targetRepoRoot: { type: "string" }, knowledgeLimit: { type: "number" } }, required: ["targetRepoRoot"] }` — `knowledgeLimit` is optional; the tool defaults to 3.
    - `handler`: thin wrapper — parse args with `z.object({ targetRepoRoot: z.string().min(1), knowledgeLimit: z.number().int().positive().optional() })`, call `getTeamSnapshot(parsed)`, return `{ content: [{ type: "text" as const, text: renderTeamSnapshot(snapshot) }] }`. (Return the rendered text, NOT `JSON.stringify(snapshot)` — the skill body is contractually expected to print verbatim per Task 5.6 step 3.)
  - [x] 6.2 Do NOT reorder existing tool registrations. Append only. Story 1.7's `acceptance.test.ts` AC3 invariant ("bare `createServer()` registers zero tools") is preserved — `registerAllTools` is the only mutator and we only add to it.
  - [x] 6.3 No new MCP-tool-level permission spec. `/crew:team` does not spawn a subagent; `permissions/<role>.yaml` files are subagent allowlists, not skill-body allowlists. The skill body's `allowed_tools: [Read]` frontmatter scopes Claude Code's tool surface for the skill itself.

- [x] **Task 7 — Integration test `get-team-snapshot.test.ts` (AC: 1, 3)**
  - [x] 7.1 Create `plugins/crew/mcp-server/tests/get-team-snapshot.test.ts`. New file. Pattern after `plugins/crew/mcp-server/tests/get-status.test.ts` (Story 1.7) for the temp-dir idiom and the renderer-vs-snapshot split.
  - [x] 7.2 Use Story 2.3's `instantiatePersona` helper (call `instantiatePersona({ pluginRoot: getPluginRoot(), targetRepoRoot, role })` in `beforeEach`-style setup) to materialise persona files; do NOT hand-craft persona Markdown for the default-roster fixtures. The hand-corruption in fixture (d) is `fs.writeFile` after `instantiatePersona`.
  - [x] 7.3 **AC3(a) — hired team + seeded telemetry.** Create `<TMP_A>`. `instantiatePersona` for the five default-roster roles. Read `<TMP_A>/team/planner/PERSONA.md`, replace the empty `## Knowledge` body with `- alpha\n- beta\n- gamma\n- delta\n` (via `fs.writeFile`; preserve the rest of the file byte-for-byte via a careful split-rewrite-join). Hand-write `<TMP_A>/.crew/telemetry/2026-05.jsonl` with seven valid `agent.invoke` events using `logTelemetryEvent` (NOT `fs.writeFile` directly — use the production writer so the line format matches). Call `getTeamSnapshot({ targetRepoRoot: TMP_A, knowledgeLimit: 3 })`. Assert per AC3(a) (i)–(viii).
  - [x] 7.4 **AC2 + AC3(a) — no Task spawn, no telemetry emit, no execa, no network.** Spy on `lib/logger.ts`'s `logTelemetryEvent` export via `vi.spyOn(loggerModule, "logTelemetryEvent")`. Run `getTeamSnapshot`. Assert the spy was never called by the snapshot path itself (the test's own pre-seeding of telemetry calls it; reset the spy AFTER pre-seeding and BEFORE invoking `getTeamSnapshot`). The "no `Task` spawn" assertion is implicit (the MCP server has no `Task` surface — `Task` is a Claude Code primitive); document this in a comment.
  - [x] 7.5 **AC3(a) — renderer.** Call `renderTeamSnapshot(snapshot)` from 7.3 and assert the output equals the expected text block byte-for-byte. Either (a) inline the expected string in the test, or (b) construct it via a small `buildExpectedRender(snapshot)` helper that mirrors the spec — author's discretion. The contract is that the renderer is deterministic.
  - [x] 7.6 **AC3(b) — empty-team.** Create `<TMP_B>` with no `team/`. Call `getTeamSnapshot({ targetRepoRoot: TMP_B })`. Assert `roles.length === 0`, `malformedTelemetryLines === 0`. Call `renderTeamSnapshot` and assert the output equals the literal AC1 empty-state block byte-for-byte.
  - [x] 7.7 **AC3(c) — custom-role hired.** Create `<TMP_C>`. `instantiatePersona` for the five default-roster roles. Hand-author `<TMP_C>/team/custom/data-scientist.md` (reuse Story 2.5's Task 7.8 fixture contents). Call `readCustomRole({ targetRepoRoot: TMP_C, role: "data-scientist" })` then `instantiatePersona({ pluginRoot: getPluginRoot(), targetRepoRoot: TMP_C, role: "data-scientist" })` — note `instantiatePersona`'s contract is "read the catalogue role from the plugin root" so the call signature here may need the dev agent to confirm: a custom-role persona's body comes from `<TMP_C>/team/custom/data-scientist.md`, not `plugins/crew/catalogue/data-scientist.md`. If `instantiatePersona`'s current signature does not accept a pre-parsed `CatalogueRole`, the dev agent should pre-seed `<TMP_C>/team/data-scientist/PERSONA.md` by hand via the `renderPersonaFile(parseCatalogueRole(...))` composition (Story 2.3 building blocks) — the goal of this fixture is to assert `getTeamSnapshot` includes custom-rooted personas in its output, not to re-test Story 2.5's hire path. Assert `roles` contains an entry with `role === "data-scientist"`, lexicographically placed first (index 0, immediately before `generalist-dev`, because `"d" < "g"`).
  - [x] 7.8 **AC3(d) — malformed telemetry + malformed persona.** Create `<TMP_D>`. `instantiatePersona` for `planner` and `generalist-dev`. Corrupt `<TMP_D>/team/generalist-dev/PERSONA.md` by deleting the `## Knowledge` heading (this makes `parsePersonaFile` throw `PersonaFileMalformedError` per Story 2.3's Task 1.5 assertion). Hand-write `<TMP_D>/.crew/telemetry/2026-05.jsonl` with five lines: two valid `agent.invoke` lines (use `logTelemetryEvent`), then append two literal `{ bad` lines, then append one valid-JSON-but-Zod-failing line (e.g. `{"ts":"2026-05-20T00:00:00.000Z","type":"agent.invoke","session_id":"x","agent":"planner"}` — missing `data`). Call `getTeamSnapshot({ targetRepoRoot: TMP_D })`. Assert per AC3(d).
  - [x] 7.9 **AC3(e) — tool registration.** Mirror Story 2.5's Task 7.13: create a `createServer()`, call `registerAllTools(server)`, connect in-memory, list tools, assert `getTeamSnapshot` is present, assert the prior seven tools are all still present (no reordering required by this story, but the test asserts EIGHT total tools).
  - [x] 7.10 **AC3(f) — no telemetry dir created.** Create `<TMP_E>` with `instantiatePersona` for one role (so `team/` exists). Call `getTeamSnapshot({ targetRepoRoot: TMP_E })`. Assert `fs.access(<TMP_E>/.crew/telemetry, fs.constants.F_OK)` throws ENOENT after the call. The snapshot MUST NOT create the telemetry directory as a side-effect.
  - [x] 7.11 **AC3(g) — reverse-order regression.** In the AC3(a) fixture, explicitly assert `snapshot.roles.find(r => r.role === "planner" && r.state === "ok").knowledge` is `["delta", "gamma", "beta"]` AND NOT `["alpha", "beta", "delta"]` (alphabetical) AND NOT `["alpha", "beta", "gamma"]` (first-N file order). Three distinct assertions so the regression diagnostic names which rule was wrongly implemented.
  - [x] 7.12 **AC3(h) — lexicographic role order independent of `fs.readdir`.** Create `<TMP_F>`. `instantiatePersona` for the default roster in REVERSE order (`orchestrator, retro-analyst, generalist-reviewer, generalist-dev, planner`). Call `getTeamSnapshot({ targetRepoRoot: TMP_F })`. Assert `snapshot.roles.map(r => r.role)` equals `["generalist-dev", "generalist-reviewer", "orchestrator", "planner", "retro-analyst"]` (lexicographic).
  - [x] 7.13 **AC3(i) — archived excluded.** Create `<TMP_G>`. `instantiatePersona` for the default roster. `fs.mkdir(<TMP_G>/team/_archived/old-role, { recursive: true })` and write a catalogue-shaped persona file there (copy any default-roster persona via `fs.copyFile`). Call `getTeamSnapshot`. Assert `snapshot.roles.map(r => r.role)` does NOT include `old-role`.
  - [x] 7.14 **AC3(j) — knowledge entry stripping.** Create `<TMP_H>`. `instantiatePersona` for `planner`. Replace the `## Knowledge` body with:
    ```
    -   entry-with-leading-spaces   
    - entry with continuation
      this is a continuation line that should NOT count
    - entry with sub-bullet
      - this is a sub-bullet, also indented — should NOT count as top-level
    -    trailing-whitespace-entry    
    ```
    Call `getTeamSnapshot({ targetRepoRoot: TMP_H, knowledgeLimit: 10 })`. Assert the `planner` stanza's `knowledge` is `["trailing-whitespace-entry", "entry with sub-bullet", "entry with continuation", "entry-with-leading-spaces"]` (four entries, leading `- ` and surrounding whitespace stripped, continuation/sub-bullet lines not counted, reverse file order).
  - [x] 7.15 **AC4 — skill self-consistency.** Read `plugins/crew/skills/team/SKILL.md` from disk. Assert (i) frontmatter parses and `name === "crew:team"`, (ii) `allowed_tools` deep-equals `["Read"]`, (iii) body contains `# What this skill does`, `# Prerequisites`, `# Steps`, `# Failure modes` in that order, (iv) `# Steps` body contains the substring `getTeamSnapshot`, (v) body contains `/crew:team` at least once, `/crew:hire` at least once, `/crew:skip-hiring` at least once.
  - [x] 7.16 No `.only`, no `.todo`, no `.skip`. Test file header MUST cite this story (`Story 2.6 AC1–AC4`) and reference `plugins/crew/docs/user-surface-acs.md`, mirroring `catalogue-shape.test.ts`, `persona-machinery.test.ts`, `hire-skill.test.ts`, `skip-hiring-and-custom-role.test.ts`.

- [x] **Task 8 — Build & dist verification (AC: 3)**
  - [x] 8.1 Run `pnpm --dir plugins/crew/mcp-server build`. `tsc` must compile cleanly. New source files: `tools/get-team-snapshot.ts`, `lib/team-stats.ts`, `schemas/team-snapshot.ts`. Modified: `tools/register.ts`. All under `src/`. Each produces a `dist/` sibling.
  - [x] 8.2 Per `plugins/crew/docs/README-install.md` § Build artefacts and Story 1.9's contract, the built `mcp-server/dist/` tree is committed. **This story adds source under `src/`** — rebuild and commit `dist/` in the same commit as `src/`. `ci-drift-check.test.ts` enforces alignment.
  - [x] 8.3 The skill file (`plugins/crew/skills/team/SKILL.md`) is a static asset shipped as-is via `/plugin install`'s file-copy semantics. No bundling step.
  - [x] 8.4 Verify the existing Story 1.7 self-consistency test (`get-status.test.ts` AC4f, README-install.md six-checkpoint assertion) still passes — this story does NOT modify `README-install.md`.

- [x] **Task 9 — Verify no other story's contract drifted (AC: 1–4)**
  - [x] 9.1 Confirm `plugins/crew/mcp-server/src/schemas/{catalogue,persona,role-permissions,status-report,repo-signals,plugin-manifest,telemetry-events,workspace-config,standards-doc}.ts` are unchanged.
  - [x] 9.2 Confirm `plugins/crew/mcp-server/src/tools/{get-status,read-catalogue,instantiate-persona,read-persona,lookup-role-by-domain,read-repo-signals,read-custom-role}.ts` are unchanged. This story consumes them; it does not modify them.
  - [x] 9.3 Confirm `plugins/crew/mcp-server/src/lib/{logger,managed-fs,markdown-frontmatter,persona-file,plugin-root,plugin-version,workspace-resolver,gh,repo-signal-detectors}.ts` are unchanged.
  - [x] 9.4 Confirm `plugins/crew/catalogue/*.md` is unchanged. The catalogue is not consulted by `/crew:team`; persona files are the source of truth post-hire.
  - [x] 9.5 Confirm `plugins/crew/permissions/*.yaml` is unchanged. `/crew:team` does not spawn a subagent; no role's allowlist changes.
  - [x] 9.6 Confirm `plugins/crew/skills/{status,hire,skip-hiring}/SKILL.md` are unchanged.
  - [x] 9.7 Confirm `plugins/crew/docs/README-install.md` is unchanged. Epic 7 Story 7.2 will integrate `/crew:team` into the first-run-in-5-minutes walkthrough.
  - [x] 9.8 Confirm root `README.md` is unchanged.
  - [x] 9.9 Confirm `plugins/crew/mcp-server/tests/{catalogue-shape,permissions-catalogue-parity,permissions-enforcement,persona-machinery,get-status,acceptance,ci-drift-check,repo-signal-detectors,user-surface-convention,pre-pr-gate,dist-shipping,smoke,readme-install,standards-doc,telemetry-logger,validate-active-adapter,workspace-resolver,bmad-adapter,bmad-adapter-acceptance,canonical-fs-guard,manifest-state-machine,git-commit,hire-skill,skip-hiring-and-custom-role,read-custom-role}.test.ts` are unchanged. Only `get-team-snapshot.test.ts` and `team-stats.test.ts` are new.

---

## Dev Notes

### Critical context: what was shipped before, what this story builds on

- **Story 1.1** scaffolded `mcp-server/src/{schemas,state,tools,lib}/`. New files in this story follow that convention: tool under `tools/`, helper under `lib/`, schema under `schemas/`, all kebab-case.
- **Story 1.4** shipped the MCP dispatcher and `_meta.role` permission enforcement. `getTeamSnapshot` is registered in `register.ts` like every other tool. It is callable by the operator's session directly (`/crew:team`'s skill body invokes it). No subagent allowlist enforcement applies — this is an operator-facing tool, not a subagent tool.
- **Story 1.5** shipped `lib/logger.ts` + `TelemetryEventSchema` + the JSONL file convention `<target-repo>/.crew/telemetry/<YYYY-MM>.jsonl`. **This story's `lib/team-stats.ts` is the FIRST reader of those files**; the writer / reader pattern split (writer in `logger.ts`, reader in `team-stats.ts`) is the v1 template for Epic 6's `computeOutcomeStats` and `computeAgreement` helpers. Keep `team-stats.ts` small and single-purpose so Epic 6 can clone it.
- **Story 1.6** shipped `lib/managed-fs.ts` + `CANONICAL_PATH_GLOBS`. This story is read-only — it does NOT call `managed-fs`. `lib/team-stats.ts` reads `.crew/telemetry/` via direct `fs.readFile`, which is permitted (managed-fs gates **writes** to canonical paths, not reads).
- **Story 1.7** shipped the skill-shape pattern (`skills/status/SKILL.md`), `getStatus`, `renderStatus`, and `tools/register.ts`. **`/crew:team` mirrors `/crew:status` structurally**: skill body calls one MCP tool, prints the text response verbatim. Use `tools/get-status.ts` and `skills/status/SKILL.md` as the reference implementations to mirror.
- **Story 1.8** introduced the `user-surface` AC tag and pre-PR smoke gate. **This story has ONE `(user-surface)` AC (AC1)**, naming the `/crew:team` slash command and the entire on-screen text block. The pre-PR gate will require operator-paste-output or an automated-e2e verification event covering AC1. The harness in Task 7 covers the deterministic tool-boundary assertions; operator paste-output is the expected verification route for the live `/crew:team` rendering against a real hired team.
- **Story 1.8 lesson (PR #76 "Process observation").** Pin user-surface contracts in absolute language. The skill body MUST print the tool's text response **verbatim** (Task 5.6 step 3) — no Markdown beautification, no header insertion, no "let me explain" prefix. The renderer is the only formatter; the skill body is a pipe.
- **Story 1.9** committed `mcp-server/dist/`. **This story modifies `src/` — rebuild and commit `dist/` in the same change.** `ci-drift-check.test.ts` enforces alignment.
- **Story 2.1** shipped the catalogue and `CatalogueRoleSchema`. The catalogue is NOT consulted by `/crew:team`. Persona files are the source of truth post-hire; their frontmatter was copied from the catalogue at hire time per Story 2.3's `renderPersonaFile`.
- **Story 2.2** shipped `permissions/<role>.yaml`. This story changes none. `/crew:team` does not spawn a subagent.
- **Story 2.3** shipped `PersonaFileSchema`, `parsePersonaFile`, `renderPersonaFile`, and four MCP tools (`readCatalogue`, `instantiatePersona`, `readPersona`, `lookupRoleByDomain`) plus error classes (`CatalogueRoleNotFoundError`, `CatalogueShapeError`, `PersonaShapeError`, `PersonaAlreadyExistsError`, `PersonaFileMalformedError`, `PersonaFileNotFoundError`). **`getTeamSnapshot` consumes `readPersona` verbatim** and catches `PersonaFileMalformedError` to produce the per-role error stanza. `PersonaFileNotFoundError` should never surface from `getTeamSnapshot`'s caller because the existence check in Task 4.3 step 3 (`fs.access` on `<role>/PERSONA.md`) filters out missing personas before `readPersona` is called.
- **Story 2.4** shipped `/crew:hire`, `readRepoSignals`, the hiring-manager subagent flow. **`/crew:team` is the read complement to `/crew:hire`'s write** — what was hired can now be inspected. The cross-link in the skill body's `# What this skill does` and in the empty-state output explicitly directs operators to `/crew:hire`.
- **Story 2.5** shipped `/crew:skip-hiring`, the custom-role escape hatch, `readCustomRole`, and the role-invention refusal. **Per Story 2.5 § Design rationale ("Why persona lands at `<target-repo>/team/<role-id>/PERSONA.md`")**, custom-role personas live at `team/<role-id>/PERSONA.md`, NOT under `team/custom/<role-id>/PERSONA.md`. This means `getTeamSnapshot`'s `fs.readdir(team)` listing naturally includes them; no special custom-root handling is needed. AC3(c) explicitly tests this.

### Architecture references (load these first, dev agent)

- `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` §4 (MCP Tool Naming) — `getTeamSnapshot` is camelCase verb-noun, reader name starts with `get`. Compliant with the convention `getStatus` set.
- `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` §5 (JSONL Event Schema) — confirms `agent` field is the kebab role id; this is the join key for fire counts.
- `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` §8 (Skill File Shape) — pins frontmatter (`name`, `description`, `allowed_tools`) and the four required body sections. `skills/team/SKILL.md` complies.
- `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` §12 (Enforcement) — confirms reader helpers do not emit telemetry, do not mutate state, and do not bypass schema validation.
- `_bmad-output/planning-artifacts/architecture/project-structure-boundaries.md` — pins `skills/team.md` location (FR108) and `mcp-server/src/lib/` for the new helper. Shipped as `skills/team/SKILL.md` per Story 1.7's directory pattern (the `.md` vs `<dir>/SKILL.md` distinction was resolved in Story 1.7's favour).
- `_bmad-output/planning-artifacts/architecture/project-structure-boundaries.md` line 156, 202, 216 — confirms `.crew/telemetry/<YYYY-MM>.jsonl` is the readable file convention.
- `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md` FR65 (`agent.invoke` event shape), FR108 (the slash-command requirement).
- `_bmad-output/planning-artifacts/prd-crew-v1/non-functional-requirements.md` NFR12 (minimum-necessary tool surface — informs `/crew:team`'s `allowed_tools: [Read]`), NFR21 (telemetry is for runtime agent events — `/crew:team` and `getTeamSnapshot` emit none), NFR25 (plain-Markdown persona readability — knowledge entries are read as plain bullets), NFR28 (the load-bearing "no LLM in the loop" contract).
- `plugins/crew/docs/user-surface-acs.md` — `(user-surface)` tag rubric (Story 1.8). AC1 is tagged; AC2, AC3, AC4 are not.
- `plugins/crew/skills/status/SKILL.md` — reference skill body shape (one MCP-tool call, verbatim print).
- `plugins/crew/mcp-server/src/tools/get-status.ts` — reference for the "compose readers → typed report → render" tool shape.
- `plugins/crew/mcp-server/src/lib/logger.ts` — reference for the JSONL file convention being read (`appendJsonlLine` writes one JSON-encoded line per call, terminated by `\n`, into `.crew/telemetry/<YYYY-MM>.jsonl`).
- `plugins/crew/mcp-server/src/schemas/telemetry-events.ts` — `TelemetryEventSchema` is the per-line validator the new helper reuses.
- `plugins/crew/mcp-server/src/tools/read-persona.ts` — the per-role reader composed in `getTeamSnapshot`.
- `plugins/crew/mcp-server/src/lib/persona-file.ts` — `parsePersonaFile` extracts `sections.Knowledge`; `extractKnowledgeEntries` post-processes that body into top-level bullets.
- `_bmad-output/implementation-artifacts/2-5-skip-hiring-fast-path-and-custom-escape-hatch.md` — the previous story spec. Tasks 7 lean on its temp-dir / spy idioms.
- `_bmad-output/implementation-artifacts/2-3-persona-file-machinery-and-persona-mcp-tools.md` — pins the `## Knowledge` section's empty-on-hire contract.
- `_bmad-output/implementation-artifacts/1-7-status-skill-and-readme-install-path-through-the-plugin-sees-my-repo.md` — `getStatus` / `renderStatus` pattern this story mirrors.
- `_bmad-output/implementation-artifacts/1-5-jsonl-telemetry-plumbing-via-pino.md` — pins the JSONL writer contract (one event per line, `\n`-terminated, month-bucketed).

### Files this story creates (NEW)

- `plugins/crew/mcp-server/src/tools/get-team-snapshot.ts` — the snapshot composer + renderer.
- `plugins/crew/mcp-server/src/lib/team-stats.ts` — pure JSONL aggregator over `.crew/telemetry/*.jsonl`.
- `plugins/crew/mcp-server/src/schemas/team-snapshot.ts` — `TeamSnapshotSchema` + `TeamSnapshotRoleSchema`.
- `plugins/crew/mcp-server/tests/get-team-snapshot.test.ts` — integration harness for AC1–AC4.
- `plugins/crew/mcp-server/tests/team-stats.test.ts` — unit tests for the new helper.
- `plugins/crew/skills/team/SKILL.md` — the operator-facing slash-command file.
- `plugins/crew/mcp-server/dist/**` — rebuild output. Commit per Story 1.9's contract.

### Files this story MAY modify (UPDATE, with care)

- `plugins/crew/mcp-server/src/tools/register.ts` — append one `server.registerTool({...})` call for `getTeamSnapshot` after the Story 2.5 `readCustomRole` entry. Do not refactor existing entries.

### Files this story MUST NOT modify

- `_bmad-output/implementation-artifacts/sprint-status.yaml` (orchestrator owns).
- `plugins/crew/catalogue/*.md`.
- `plugins/crew/permissions/*.yaml`.
- `plugins/crew/skills/{status,hire,skip-hiring}/SKILL.md`.
- `plugins/crew/mcp-server/src/schemas/{catalogue,persona,role-permissions,status-report,repo-signals,plugin-manifest,telemetry-events,workspace-config,standards-doc}.ts`.
- `plugins/crew/mcp-server/src/tools/{get-status,read-catalogue,instantiate-persona,read-persona,lookup-role-by-domain,read-repo-signals,read-custom-role}.ts`.
- `plugins/crew/mcp-server/src/lib/{logger,managed-fs,markdown-frontmatter,persona-file,plugin-root,plugin-version,workspace-resolver,gh,repo-signal-detectors}.ts`.
- `plugins/crew/mcp-server/src/errors.ts` — no new error classes.
- `plugins/crew/docs/README-install.md` (Epic 7 Story 7.2 will integrate `/crew:team` into the install walkthrough; v1's six-checkpoint install does not include it).
- Root `README.md`.
- `plugins/crew/mcp-server/tests/{catalogue-shape,permissions-catalogue-parity,permissions-enforcement,persona-machinery,get-status,acceptance,ci-drift-check,repo-signal-detectors,user-surface-convention,pre-pr-gate,dist-shipping,smoke,readme-install,standards-doc,telemetry-logger,validate-active-adapter,workspace-resolver,bmad-adapter,bmad-adapter-acceptance,canonical-fs-guard,manifest-state-machine,git-commit,hire-skill,skip-hiring-and-custom-role,read-custom-role}.test.ts` — existing suites pass as-is.

### Design rationale (load when in doubt)

- **Why a new MCP tool (`getTeamSnapshot`) instead of letting the skill body compose `readPersona` + a new helper itself?** Three reasons. First, the MCP server is the only canonical-state boundary (architecture §Architectural boundaries, line 179) — even **reads** that cross multiple roles benefit from a single typed return shape (the `TeamSnapshot`), validated by Zod, so future consumers (Epic 6 retros, Epic 7 walkthrough docs) can depend on the shape. Second, skill-body composition would force the skill to make N MCP calls (one per role) plus a new helper call — six round-trips for the default roster versus one. Latency is not the bottleneck in v1, but the call-graph clarity is. Third, the renderer (`renderTeamSnapshot`) lives next to the snapshot type and is testable as a pure function; if the skill body composed the output, the formatter would be embedded in skill prose and untestable.
- **Why is the renderer's output returned as the MCP tool's `text` content (Task 6.1) instead of `JSON.stringify(snapshot)`?** Because the skill body's contract is "print verbatim" (Task 5.6 step 3, mirroring `/crew:status`). If the tool returned JSON, the skill body would have to format it — pushing rendering into Markdown prose where it's untestable. By returning the rendered string, the tool's `text` content IS the operator-facing output, and the renderer is a pure unit-testable function. The structured `TeamSnapshot` is still available to in-process callers (`getTeamSnapshot(...)` returns the object; only the MCP handler wraps it through the renderer).
- **Why "reverse file order" for knowledge entries (Task 4.4)?** Operators append at the bottom (the natural Markdown editing flex). The snapshot shows "most recent first." Reversing the file-order array post-slice gives that ordering deterministically. Alphabetical would be wrong (operators don't author entries alphabetically). First-N (file-order) would surface stale entries and miss the recently-appended ones — exactly the wrong affordance for a "team's recent learnings" view.
- **Why "lexicographic role order" instead of "hired-at" or "fire count desc"?** Lexicographic is the only ordering whose stability is independent of (a) `fs.readdir` order (OS-dependent), (b) clock skew across hires, (c) telemetry seeding in tests. Once `appendPersonaKnowledge` and Epic 6 land, sortable variants ("most-fired first") become useful — but they're a UX choice that should be made when the data exists, not pre-emptively. v1 ships the most-deterministic ordering and defers the rest.
- **Why does `lib/team-stats.ts` re-validate every line with `TelemetryEventSchema` instead of trusting the logger's write-time validation (Task 2.3)?** Because operators can hand-edit `.crew/telemetry/*.jsonl` (they're plain JSONL in the operator's git tree per architecture line 185 "telemetry is append-only" + line 216). They shouldn't, but they can. Re-validating at read time defends against (a) a crashed writer mid-line (JSON-parse failure), (b) a hand-edit that breaks schema (Zod failure), (c) future logger bugs. The malformed-line annotation in the rendered output is the visible feedback channel.
- **Why does the reader NOT write a `telemetry.invalid` event on malformation (Task 2.5)?** Because `logger.ts`'s `logTelemetryEvent` is the writer; this helper is a reader. The "writer logs `telemetry.invalid` on Zod failure" contract (Story 1.5) is specifically about **caller-supplied** events that fail at write time. Read-time malformation is a different failure mode (operator hand-edit, mid-line crash, future logger bug) and writing a `telemetry.invalid` event from a reader would (a) mutate `.crew/telemetry/` from a read-only operation, breaking NFR28's "pure file reads" contract, (b) double-count if the read is invoked twice, (c) confuse the source-of-truth for `telemetry.invalid` events. The malformed-line counts on the returned snapshot are the only feedback channel.
- **Why does `extractKnowledgeEntries` use `/^-\s+(.+?)\s*$/` instead of a Markdown-AST parser?** v1's Knowledge section is operator-hand-edited plain Markdown (NFR25). The convention is "one top-level bullet per knowledge entry" (the empty-on-hire contract from Story 2.3 + the future `appendPersonaKnowledge` contract from Epic 3+). A regex over top-level `^- ` lines is sufficient and has zero dependencies. A Markdown parser would (a) introduce a transitive dep for a snapshot use case, (b) re-encode the operator's prose through a parse/render cycle that might mutate whitespace, (c) make the entry-extraction contract harder to test. The regex is testable, the contract is one-liner-per-entry, and continuation/sub-bullet lines are explicitly out of scope.
- **Why does `getTeamSnapshot`'s call signature allow `knowledgeLimit` to be passed but the v1 skill always passes `3`?** Because the schema (Task 1.3) carries `knowledgeLimit` as a positive integer and the renderer uses it (`knowledge (last <K>):`). Allowing the caller to vary it makes Epic 3+'s `/crew:ask <role>` (Story 2.7) and Epic 6's retro flows able to ask for more context without a new tool. The v1 skill pins `3` per FR108 ("recent persona-knowledge entries" — small N is the operator-glance affordance).
- **Why does `/crew:team` NOT call `getStatus` first (Task 5.6)?** Because `getStatus` requires adapter resolution (`resolveWorkspace`), which requires `.crew/config.yaml`. A user who runs `/crew:hire` immediately followed by `/crew:team` would hit `NoAdapterMatchedError` on the second call even though the team is hired — a regression. Both `/crew:hire` and `/crew:skip-hiring` skip adapter resolution (per Story 2.4 / 2.5); `/crew:team` follows suit. The skill takes `targetRepoRoot` directly.
- **Why does the empty-state output (no `team/` directory) cross-link both `/crew:hire` and `/crew:skip-hiring` instead of one of them?** Because `/crew:team` has no signal about which path the operator prefers (interactive vs fast-path). Both cross-links make the next step obvious; `/crew:skip-hiring`'s "try-it-now" framing is preserved.
- **Why is the malformed-line annotation `(0 malformed telemetry line(s) ...)` OMITTED rather than rendered (Task 4.5)?** Because a snapshot with no malformation should look pristine — no parenthetical, no zero-counter. Operators learn to scan for the parenthetical's presence as the trouble-signal. Always-rendering would dilute the signal. (Story 1.7's `getStatus` follows the same pattern — downgrades render an annotation; clean state renders without one.)

### Testing standards summary

- `vitest` v1.x, co-located `*.test.ts` files under `plugins/crew/mcp-server/tests/`. No `.only`, no `.todo`, no `.skip` (CI fails on these per existing convention).
- Temp-dir fixtures via `fs.mkdtemp` (Story 1.7 / 2.3 / 2.4 / 2.5 pattern). Clean up in `afterAll` via `fs.rm(..., { recursive: true, force: true })`.
- Module spies via `vi.spyOn(module, "exportName")`. Spy on `logTelemetryEvent` (Task 7.4) to assert the snapshot path emits zero telemetry events. Restore in `afterEach`.
- Pre-seed personas via Story 2.3's `instantiatePersona` (NOT hand-crafted Markdown) so the test fixtures track the same shape the production hire flow produces. Hand-corruption (Task 7.8) is a follow-up `fs.writeFile` after `instantiatePersona`.
- Pre-seed telemetry via Story 1.5's `logTelemetryEvent` (NOT hand-written JSONL) so the test fixtures track the same line format the production writer produces. Hand-malformed lines (Task 7.8) are `fs.appendFile` after `logTelemetryEvent`.
- Verbatim-string assertions via `===` for whole-line confirmation strings, `string.includes(...)` for substrings in larger blocks.
- Test file headers cite the story and reference `plugins/crew/docs/user-surface-acs.md` per Story 2.4's / 2.5's discipline.

### Project Structure Notes

- New files conform to the existing layout: tool under `mcp-server/src/tools/`, helper under `mcp-server/src/lib/`, schema under `mcp-server/src/schemas/`, tests co-located under `mcp-server/tests/`, skill under `skills/<name>/SKILL.md` (directory form, matching `status/`, `hire/`, `skip-hiring/`).
- No new top-level directories. No new `package.json` dependencies (the helper uses `node:fs`, `node:path`, and the existing `zod` for schema reuse).
- The `plugins/crew/mcp-server/dist/` rebuild produces sibling files for `tools/get-team-snapshot.ts`, `lib/team-stats.ts`, `schemas/team-snapshot.ts`, and an updated `tools/register.js`. The dev agent MUST commit the dist diff in the same commit as the src diff (Story 1.9 contract; `ci-drift-check.test.ts` enforces).

### References

- [Source: `_bmad-output/planning-artifacts/epics/epic-2-team-formation-hiring-personas-and-team-observability.md` § Story 2.6]
- [Source: `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md` FR65, FR108]
- [Source: `_bmad-output/planning-artifacts/prd-crew-v1/non-functional-requirements.md` NFR12, NFR21, NFR25, NFR28]
- [Source: `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` §4, §5, §8, §12]
- [Source: `_bmad-output/planning-artifacts/architecture/project-structure-boundaries.md` lines 156, 162–171, 202, 216]
- [Source: `_bmad-output/implementation-artifacts/1-5-jsonl-telemetry-plumbing-via-pino.md`]
- [Source: `_bmad-output/implementation-artifacts/1-7-status-skill-and-readme-install-path-through-the-plugin-sees-my-repo.md`]
- [Source: `_bmad-output/implementation-artifacts/2-3-persona-file-machinery-and-persona-mcp-tools.md`]
- [Source: `_bmad-output/implementation-artifacts/2-5-skip-hiring-fast-path-and-custom-escape-hatch.md`]
- [Source: `plugins/crew/docs/user-surface-acs.md`]
- [Source: `plugins/crew/skills/status/SKILL.md`]
- [Source: `plugins/crew/mcp-server/src/tools/get-status.ts`]
- [Source: `plugins/crew/mcp-server/src/tools/read-persona.ts`]
- [Source: `plugins/crew/mcp-server/src/lib/logger.ts`]
- [Source: `plugins/crew/mcp-server/src/lib/persona-file.ts`]
- [Source: `plugins/crew/mcp-server/src/schemas/telemetry-events.ts`]
- [Source: `plugins/crew/mcp-server/src/schemas/persona.ts`]
- [Source: `plugins/crew/mcp-server/src/tools/register.ts`]
- [Source: Story 1.8 lesson — PR #76 "Process observation" comment]

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

None — clean implementation, no regressions, no diagnostic loops required.

### Completion Notes List

- Implemented `TeamSnapshotSchema` + `TeamSnapshotRoleSchema` as a discriminated union (state: "ok" | "error") with `.strict()` validation.
- Implemented `lib/team-stats.ts` as a pure JSONL reader: aggregates `agent.invoke` fire counts, counts malformed lines/files, no writes, no telemetry emit.
- Implemented `getTeamSnapshot` (composer: readdir filtering + lexicographic sort + readPersona per role + readTeamTelemetryStats once + TeamSnapshotSchema.parse), `extractKnowledgeEntries` (top-level `^- ` bullets only, slice(-limit).reverse()), `renderTeamSnapshot` (pure formatter, no trailing newline).
- Wired `getTeamSnapshot` into `register.ts` as the 8th tool, appended after `readCustomRole`.
- Authored `skills/team/SKILL.md` with `allowed_tools: [Read]`, four required body sections, verbatim-print contract.
- Unit tests (`team-stats.test.ts`): 7 cases covering all Task 3.2(a–g) scenarios.
- Integration tests (`get-team-snapshot.test.ts`): 24 tests covering AC3(a–j) + AC4 + AC2 (no-emit spy). All 304 tests pass (27 test files, 0 regressions).
- Build: `tsc` compiles cleanly; `dist/` rebuilt and included in commit per Story 1.9 contract.

### File List

- `plugins/crew/mcp-server/src/schemas/team-snapshot.ts` (NEW)
- `plugins/crew/mcp-server/src/lib/team-stats.ts` (NEW)
- `plugins/crew/mcp-server/src/tools/get-team-snapshot.ts` (NEW)
- `plugins/crew/mcp-server/src/tools/register.ts` (MODIFIED — appended getTeamSnapshot)
- `plugins/crew/skills/team/SKILL.md` (NEW)
- `plugins/crew/mcp-server/tests/team-stats.test.ts` (NEW)
- `plugins/crew/mcp-server/tests/get-team-snapshot.test.ts` (NEW)
- `plugins/crew/mcp-server/dist/**` (REBUILT — tsc output, committed per Story 1.9)
- `_bmad-output/implementation-artifacts/2-6-team-snapshot-skill.md` (UPDATED — status, tasks, dev record)
