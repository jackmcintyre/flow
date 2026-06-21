# Story 2.4: Hiring-manager agent and `/hire` skill

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin operator (Maya / Jack at first install)**,
I want **a `/crew:hire` slash command that opens a project-shaped hiring conversation — the hiring manager reads my repo at a high level, proposes a starting team grounded in what it observed, lets me approve / decline / amend, then writes persona files for the agreed roster via the Story 2.3 MCP tools**,
so that **my first interaction with the plugin gives me a team that reflects my project (not a generic roster) and a concrete on-disk artifact (`<target-repo>/team/<role>/PERSONA.md`) I can read, edit, or `git revert` (FR85–FR92, FR96, FR97).**

### What this story is, in one sentence

Ship `plugins/crew/skills/hire/SKILL.md` (the slash-command surface), one new MCP tool (`readRepoSignals`) at `plugins/crew/mcp-server/src/tools/read-repo-signals.ts` that returns a typed `RepoSignals` payload from a high-level read of the target repo (language detection, top-level layout, README excerpt, recent git log titles, dependency-manifest names), permission allowlist additions for the hiring manager, and a vitest integration harness that drives the `/hire` happy path and re-entry path against two fixture target repos (fresh-empty vs already-hired) — wiring through `instantiatePersona` / `readPersona` / `lookupRoleByDomain` from Story 2.3.

### What this story fixes (and why it needs its own story)

Story 2.1 shipped the catalogue. Story 2.2 shipped the per-role permission specs. Story 2.3 shipped the persona-file MCP tools — the boundary that *creates* persona files at `<target-repo>/team/<role>/PERSONA.md`. None of those stories has an operator-facing surface. Story 2.4 is where the user finally types something into Claude Code and gets a hired team. Without it:

- The persona-machinery from 2.3 has no caller. `instantiatePersona` is allowlisted for `hiring-manager` (Story 2.3 Task 8.1) but no skill drives the hiring manager.
- FR85–FR88 (repo-signal-driven proposal with justifications, approve/decline/amend flow) have no implementation.
- FR90 (re-entry against an already-hired team — hire-one-more / unhire / view-persona) has no operator path.
- Story 2.5 (`/skip-hiring`) has no precedent skill shape to follow; both `/skip-hiring` and `/team` (Story 2.6), `/ask` (Story 2.7) build on the patterns this story pins.

This story is the FIRST operator-facing skill in Epic 2 and the FIRST `(user-surface)` story in the epic. It is the seam between the plumbing (2.1, 2.2, 2.3) and the user's first concrete experience of "the team is mine."

### What this story does NOT

- (a) Touch `_bmad-output/implementation-artifacts/sprint-status.yaml` — the orchestrator owns status transitions.
- (b) Modify any catalogue file OTHER than `plugins/crew/catalogue/hiring-manager.md` § Prompt. Story 2.1 is the source of truth for catalogue file *shape*; this story is explicitly permitted to extend the `Prompt` section of `hiring-manager.md` (and only that section) to add the verbatim operator-facing strings AC2 / AC3 / AC4 assert (proposal-end call-to-action, re-entry call-to-action, terminal `Handoff to planner — team hired, ready to plan` signal). See Task 0. Frontmatter and other `##` sections of `hiring-manager.md`, and all other catalogue files, remain out of scope.
- (c) Modify `plugins/crew/mcp-server/src/schemas/{catalogue,persona,role-permissions}.ts` — shipped schemas are sufficient.
- (d) Modify `plugins/crew/mcp-server/src/tools/{read-catalogue,instantiate-persona,read-persona,lookup-role-by-domain}.ts` — Story 2.3 owns those tools. This story only *calls* them via the MCP dispatcher.
- (e) Implement `/skip-hiring` (Story 2.5), `/team` (Story 2.6), or `/ask` (Story 2.7). Those are sibling stories. The `/hire` skill MAY reference `/skip-hiring` in its failure-mode copy as a forward pointer, but MUST NOT depend on it for any behaviour.
- (f) Implement the `<target-repo>/team/custom/<role>.md` escape hatch parser or proposal flow — Story 2.5 owns it. This story's hiring manager refuses to invent roles and points the user at the path; the path's machinery is Story 2.5.
- (g) Implement `appendPersonaKnowledge` or the `<persona>/.proposed.md` flow — Epic 3 / Story 2.4b owns that. The `## Knowledge` section is written empty by `instantiatePersona` (Story 2.3 contract) and stays empty after `/hire` completes.
- (h) Touch the dev-loop (`/start`, `/watch`), retro, or any post-hiring flow. `/hire` ends when persona files are on disk and the user is told "you're hired up — run `/crew:team` to see the roster" (forward-ref to Story 2.6).
- (i) Implement persona-prompt assembly for hired agents at spawn time (Story 2.7 / Epic 3 — the dev-loop owns assembly). `/hire` only *creates* the files; it does NOT spawn the hired agents.
- (j) Rewrite the *general* persona of the hiring manager. The Story 2.1 `Prompt` section is the persona-shaping copy; this story's edit (Task 0) only ADDS the verbatim operator-facing strings the ACs assert. Do not rewrite the existing prompt body, change tone, or refactor sections — append the minimum copy the tests need.
- (k) Add new domain errors beyond what's already in `plugins/crew/mcp-server/src/errors.ts` after Story 2.3. The new `readRepoSignals` tool returns a typed payload — failures inside the tool downgrade ENOENT (no README) and `git log` non-zero exit to empty defaults; other IO errors propagate. See Task 3.4. No new error classes.

---

## Acceptance Criteria

> **Verbatim mapping.** ACs 1–4 map to the epic ACs in `_bmad-output/planning-artifacts/epics/epic-2-team-formation-hiring-personas-and-team-observability.md` § Story 2.4. AC5 is the epic's `**AC5 (integration):**` test contract.
>
> **User-surface judgement.** Three of the five ACs name the operator-typed slash command `/crew:hire` (rubric clause (i)) and are tagged `(user-surface)`. AC4 also tags `(user-surface)` because the re-entry surface is invoked the same way (`/crew:hire`). AC5 is the integration-test contract — it asserts vitest behaviour against fixtures; the operator never types `pnpm --dir plugins/crew test` as part of using the plugin (developer-only CLI), so it is NOT user-surface. The pre-PR smoke gate (Story 1.8 / `plugins/crew/docs/user-surface-acs.md`) will look for operator-paste-output or an automated-e2e verification event covering AC1–AC4.

**AC1 (user-surface):**
**Given** a target repo with `<target-repo>/.crew/config.yaml` resolved (Story 1.2 contract — `resolveWorkspace` returns without error),
**When** the operator runs `/crew:hire` from inside Claude Code with that target repo loaded as the workspace,
**Then** the skill calls the `readRepoSignals` MCP tool (Task 3) with `targetRepoRoot` set to the resolved workspace root, the tool returns a typed `RepoSignals` payload covering at least the five FR85 dimensions (`languages`, `topLevelLayout`, `readmeExcerpt`, `recentCommitTitles`, `dependencyManifests`), and the skill spawns a hiring-manager subagent (via Claude Code's Task tool) whose system prompt is assembled from `readCatalogue({ role: "hiring-manager" })`'s `Prompt` section verbatim plus the serialised `RepoSignals` payload as initial context. _(FR85)_
<!-- user-surface: AC1 names the slash command literal `/crew:hire` (rubric i). The README install copy must direct the operator to type this command verbatim; the readRepoSignals MCP tool is internal but the entry surface is operator-typed. -->

**AC2 (user-surface):**
**Given** the hiring-manager subagent spawned in AC1 with `RepoSignals` as initial context,
**When** the operator runs `/crew:hire` and reads the subagent's first reply,
**Then** the reply is a single proposal block containing (a) the default roster — `planner`, `generalist-dev`, `generalist-reviewer`, `retro-analyst`, `orchestrator` — in that exact order, one line each, (b) zero or more catalogue specialists (`security-specialist`, `test-specialist`, `docs-specialist`, `debugger`) whose inclusion is justified by an explicit reference to a `RepoSignals` field value, and (c) for every proposed role exactly one one-sentence justification on the same line as the role id, separated by ` — `. The proposal MUST end with the literal prompt line `Approve all, approve a subset (list role ids), decline, or request a specific catalogue role.` (this prompt copy is sourced verbatim from `plugins/crew/catalogue/hiring-manager.md` § Prompt, which this story extends — see Task 0). _(FR86, FR87)_
<!-- user-surface: AC2 references `/crew:hire` (rubric i) and the operator's observation of the proposal in the Claude Code TUI (rubric iv). The prompt-line literal is what the operator reads on screen. -->

**AC3 (user-surface):**
**Given** the proposal from AC2,
**When** the operator responds with one of: (i) the literal string `approve all`, (ii) `approve <space-separated role ids>`, (iii) `decline`, or (iv) `add <catalogue role id>`,
**Then** the hiring manager (a) for approve-all / approve-subset, calls `instantiatePersona({ role, targetRepoRoot })` for each agreed role exactly once, surfacing a confirmation line `Hired: <role> → <abs-path>/team/<role>/PERSONA.md` per successful instantiation; (b) for decline, prints `No roles hired. Run /crew:hire again or /crew:skip-hiring to hire the default roster.` and exits without writing any file; (c) for `add <role>`, validates the role id against the catalogue via `readCatalogue` — if unknown, prints `Unknown catalogue role: <id>. See plugins/crew/catalogue/ for the v1 roster or use the manual escape hatch under <target-repo>/team/custom/.` and re-prompts; if known, appends it to the proposal and re-emits the proposal block (back to AC2). On `PersonaAlreadyExistsError` from Story 2.3, the hiring manager prints `Already hired: <role> (no change).` and continues with the rest of the approved subset — partial idempotency is acceptable mid-conversation. _(FR88, FR89, FR92)_
<!-- user-surface: AC3 names `/crew:hire` and `/crew:skip-hiring` slash command literals (rubric i), the operator-typed response strings (`approve all` etc. — rubric ii applies to operator-typed inputs into Claude Code), AND the on-screen confirmation lines the operator reads (rubric iv). The file path in the confirmation line is operator-observable but is materialised by /hire itself, not the README. The README/install docs DO instruct the operator to type `/crew:hire`, so rubric (i) is decisive. -->

**AC4 (user-surface):**
**Given** a target repo with at least one persona file already written under `<target-repo>/team/<role>/PERSONA.md` (i.e. a prior `/crew:hire` or `/crew:skip-hiring` has completed),
**When** the operator runs `/crew:hire` a second time,
**Then** the skill detects the existing roster by listing `<target-repo>/team/` (excluding `custom/` and `_archived/` — same filter Story 2.3's `lookupRoleByDomain` uses), calls `readPersona` for each present role to gather `role` + `domain` + `hired_at`, and spawns the hiring-manager subagent with an additional `currentRoster: { role, domain, hired_at }[]` field in the initial context. The subagent's first reply is a re-entry block: (a) one line per currently-hired role in `role — domain — hired <hired_at>` format, then (b) the literal prompt line `Hire one more (specify catalogue role id), unhire <role>, view-persona <role>, or done.` (sourced verbatim from `plugins/crew/catalogue/hiring-manager.md` § Prompt, which this story extends — see Task 0). Each response action — `hire one more <role>` calls `instantiatePersona`; `unhire <role>` is **out of scope for v1** and prints `Unhire is handled by /crew:accept-proposal on a retro team-change proposal (FR107). Not available from /crew:hire in v1.`; `view-persona <role>` calls `readPersona` and prints the persona file's `Prompt` section verbatim; `done` exits cleanly. The flow is idempotent — repeated runs against an unchanged roster produce the same re-entry block byte-for-byte (modulo the `hired_at` formatting). _(FR90)_
<!-- user-surface: AC4 names `/crew:hire`, `/crew:accept-proposal` slash commands (rubric i) and the operator-typed responses (`hire one more`, `view-persona`, `done` — rubric ii on inputs, rubric iv on the re-entry block read on screen). -->

**AC5 (integration):**
**Given** the new `plugins/crew/skills/hire/SKILL.md`, the new `readRepoSignals` MCP tool, the updated `permissions/hiring-manager.yaml`, and the integration harness at `plugins/crew/mcp-server/tests/hire-skill.test.ts`,
**When** `pnpm --dir plugins/crew test` runs the new test file,
**Then** vitest asserts, against two temp-dir fixture target repos:
- **(a) Fresh-empty fixture** (`<TMP_A>` with no `team/` directory, an empty `.crew/config.yaml`, and a synthetic `README.md` plus `package.json` so `readRepoSignals` has something to detect): the harness drives the `/hire` happy path by invoking the in-process subagent stub (see Task 6.4) with the `approve all` response. After the run: (i) `<TMP_A>/team/<role>/PERSONA.md` exists for each of the five default-roster roles, (ii) each parses cleanly via `parsePersonaFile` (Story 2.3), (iii) every domain returned by `readRepoSignals` that drove a specialist inclusion is justified by the `data-driven justification` regex `/—\s+[A-Za-z]/` on the proposal line, (iv) no specialist beyond the default roster is hired in the fresh-empty case (the synthetic README/manifest contains no specialist-triggering signals).
- **(b) Already-hired fixture** (`<TMP_B>` pre-seeded with three persona files for `planner`, `generalist-dev`, `generalist-reviewer` written via `instantiatePersona` in `beforeEach`): the harness drives the re-entry path with the `done` response. After the run: (i) no new persona files are written, (ii) the in-process subagent's first reply contains exactly three role lines matching `^<role> — <domain> — hired \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`, (iii) the re-entry prompt line `Hire one more (specify catalogue role id), unhire <role>, view-persona <role>, or done.` appears verbatim, (iv) issuing `view-persona planner` returns the catalogue's `Prompt` section byte-for-byte (cross-checked against `parseCatalogueRole(plugins/crew/catalogue/planner.md).sections.Prompt`).
- **(c) Tool boundary assertions:** `readRepoSignals` returns a payload that parses against `RepoSignalsSchema` for both fixtures; `instantiatePersona` is called exactly N times in fixture (a) where N is the count of `Hired: ...` confirmation lines emitted by the harness; `instantiatePersona` is called zero times in fixture (b) under the `done` response.
- **(d) Permission allowlist:** `loadRolePermissions({ pluginRoot, role: "hiring-manager" }).tools_allow` contains `readRepoSignals` (the new tool name) alongside `readCatalogue`, `instantiatePersona`, `readPersona`, `lookupRoleByDomain` (preserved from Story 2.3 Task 8.1) and `heartbeat`. Six entries total.
- **(e) Re-entry idempotency:** running the harness twice against fixture (b) with the `done` response produces byte-identical re-entry blocks (modulo trailing whitespace), proving the listing is deterministic.

Any failure surfaces a diagnostic naming the failing AC, the fixture, the offending role / file path, and (where relevant) the Zod issue or the subagent-stub transcript.
<!-- user-surface: AC5 is the integration-test contract. The operator never types `pnpm --dir plugins/crew test`. Vitest is a developer-only surface. NOT user-surface. -->

---

## Tasks / Subtasks

- [ ] **Task 0 — Extend `plugins/crew/catalogue/hiring-manager.md` § Prompt with the verbatim operator-facing copy the ACs assert (AC: 2, 3, 4, 5)**
  - [ ] 0.1 Open `plugins/crew/catalogue/hiring-manager.md`. Do NOT touch the YAML frontmatter, `## Domain`, `## Mandate`, or `## Out of mandate` sections. Only the `## Prompt` section is in scope.
  - [ ] 0.2 Append (or weave into the existing prompt body — author's discretion, but keep additions minimal) the three verbatim strings the integration harness and skill assert:
    - The proposal-end call-to-action (AC2 / Task 7.4): `Approve all, approve a subset (list role ids), decline, or request a specific catalogue role.`
    - The re-entry call-to-action (AC4 / Task 7.5): `Hire one more (specify catalogue role id), unhire <role>, view-persona <role>, or done.`
    - The terminal handoff signal (Task 6.4 step 6 / Task 7.4): `Handoff to planner — team hired, ready to plan`
  - [ ] 0.3 Keep the edit minimal. The bar is "the harness can grep for these literals against the catalogue-sourced subagent system prompt and find them." Do NOT rewrite the existing persona prose, do NOT change the prompt's tone, do NOT add new headings or restructure. If the existing prompt already contains call-to-action copy in a different form, the new verbatim lines take precedence (they're what the tests assert) — the dev agent removes the old wording in the same edit if it would conflict.
  - [ ] 0.4 Re-run the Story 2.1 catalogue-shape test (`plugins/crew/mcp-server/tests/catalogue-shape.test.ts`) after the edit. It asserts shape, not content — adding lines to the `## Prompt` body must not break it. If it does, you've inadvertently broken the heading structure or frontmatter; revert and re-apply the minimum copy.
  - [ ] 0.5 The Story 2.3 `read-catalogue` test (`persona-machinery.test.ts`) reads the catalogue body as opaque text — also unaffected. Verify by running `pnpm --dir plugins/crew test` after the edit.

- [ ] **Task 1 — Author `RepoSignalsSchema` (AC: 1, 5)**
  - [ ] 1.1 Create `plugins/crew/mcp-server/src/schemas/repo-signals.ts`. New file. Mirror the `.strict()` discipline and Zod conventions from `plugins/crew/mcp-server/src/schemas/status-report.ts` (Story 1.7) and `schemas/persona.ts` (Story 2.3).
  - [ ] 1.2 Define `RepoSignalsSchema`:
    ```ts
    export const RepoSignalsSchema = z.object({
      targetRepoRoot: z.string().min(1),
      languages: z.array(z.string().min(1)),                  // e.g. ["TypeScript", "Markdown"]
      topLevelLayout: z.array(z.string().min(1)),             // first-level entries of targetRepoRoot, sorted
      readmeExcerpt: z.string(),                              // first ≤500 chars of README.md; "" if absent
      recentCommitTitles: z.array(z.string()),                // up to 5 most-recent commit titles; [] if no git
      dependencyManifests: z.array(z.string().min(1)),        // manifest filenames found (package.json, pyproject.toml, ...)
    }).strict();
    export type RepoSignals = z.infer<typeof RepoSignalsSchema>;
    ```
  - [ ] 1.3 No partial / optional shapes. Failures inside `readRepoSignals` (no git, no README, etc.) project to empty-array / empty-string defaults — see Task 3. The schema enforces the **shape**, not the presence of content.

- [ ] **Task 2 — Author the language / manifest detection helpers (AC: 1, 5)**
  - [ ] 2.1 Create `plugins/crew/mcp-server/src/lib/repo-signal-detectors.ts`. New file. Three pure functions, no IO:
    - `detectLanguagesFromLayout(entries: string[]): string[]` — input is the first-level directory listing; returns a deduped sorted list of language guesses based on filename / extension heuristics. Hard-coded mapping for v1 (no language-server, no `linguist`): `package.json` / `tsconfig.json` / `*.ts` / `*.tsx` → `"TypeScript"`; `*.js` / `*.jsx` → `"JavaScript"`; `pyproject.toml` / `requirements.txt` / `*.py` → `"Python"`; `Cargo.toml` / `*.rs` → `"Rust"`; `go.mod` / `*.go` → `"Go"`; `*.md` → `"Markdown"`. No HTTP, no shell-out.
    - `detectDependencyManifests(entries: string[]): string[]` — filter `entries` to the canonical manifest filenames: `["package.json", "pnpm-lock.yaml", "yarn.lock", "pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod", "Gemfile", "build.gradle", "pom.xml"]`. Return the sorted intersection.
    - `truncateReadmeExcerpt(raw: string, max = 500): string` — trim trailing whitespace, take the first `max` characters, append `"…"` only if truncated. Pure.
  - [ ] 2.2 Add a co-located unit test `plugins/crew/mcp-server/tests/repo-signal-detectors.test.ts` (NEW). Cases: (a) TS-only layout returns `["Markdown", "TypeScript"]` sorted; (b) Python layout with `pyproject.toml` returns `["Python"]`; (c) mixed layout returns the sorted union; (d) empty entries returns `[]`; (e) `truncateReadmeExcerpt("a".repeat(600))` returns 501 chars ending in `"…"`; (f) `truncateReadmeExcerpt("short")` returns `"short"` unchanged.
  - [ ] 2.3 Do NOT use `child_process` here. Git intelligence (commit titles) lives in `readRepoSignals` itself (Task 3.4), not in this helper module — keeps the helpers pure.

- [ ] **Task 3 — Implement `readRepoSignals` tool (AC: 1, 5)**
  - [ ] 3.1 Create `plugins/crew/mcp-server/src/tools/read-repo-signals.ts`. New file. Function signature: `async function readRepoSignals(opts: { targetRepoRoot: string }): Promise<RepoSignals>`. Mirror `getStatus`'s pure-compute pattern (Story 1.7).
  - [ ] 3.2 List the first level of `opts.targetRepoRoot` via `fs.readdir(opts.targetRepoRoot, { withFileTypes: true })`. Filter out dotfiles **except** `.crew` (the operator may legitimately observe its presence — though it is plugin-owned, listing it is informational). Sort case-sensitive. The sorted basenames are `topLevelLayout`.
  - [ ] 3.3 Call `detectLanguagesFromLayout(topLevelLayout)` → `languages`. Call `detectDependencyManifests(topLevelLayout)` → `dependencyManifests`.
  - [ ] 3.4 Read `<targetRepoRoot>/README.md` via `fs.readFile`. On ENOENT (no README) → `readmeExcerpt = ""` (best-effort downgrade — the operator may legitimately have no README). On any other IO error (EACCES, EISDIR, etc.) → propagate the error (these indicate a misconfigured repo, not "no signal"). On success → `readmeExcerpt = truncateReadmeExcerpt(raw)`. **Story-level rule alignment.** This matches the "best-effort downgrades" rule stated in (k) above: missing-signal cases (no README, no git history) downgrade to empty defaults; structural / permission errors propagate. Same shape for `recentCommitTitles` per 3.5 (no git / no commits → `[]`).
  - [ ] 3.5 Recent commit titles. Use `execa("git", ["log", "-5", "--pretty=%s"], { cwd: opts.targetRepoRoot, reject: false })`. On non-zero exit (no git, no commits, not a repo, etc.) → `recentCommitTitles = []`. On success → split stdout on `\n`, filter empties, take the first 5. **`execa` is already a dependency** via `plugins/crew/mcp-server/src/lib/gh.ts` (Story 1.4) — re-import from the existing module; do not add a new dep.
  - [ ] 3.6 Compose the result `{ targetRepoRoot, languages, topLevelLayout, readmeExcerpt, recentCommitTitles, dependencyManifests }`. Validate via `RepoSignalsSchema.parse(...)` before return (defensive — catches drift).
  - [ ] 3.7 No telemetry emit (NFR21 — `readRepoSignals` is a synchronous read-only diagnostic, not a runtime agent event).
  - [ ] 3.8 **Determinism note.** Output is deterministic for a given `targetRepoRoot` snapshot **except** for `recentCommitTitles` (depends on `git log`). Tests pin commit titles by pre-seeding the fixture repo with `git commit` calls in `beforeEach` (Task 6).

- [ ] **Task 4 — Wire `readRepoSignals` into the MCP dispatcher (AC: 1, 5)**
  - [ ] 4.1 Edit `plugins/crew/mcp-server/src/tools/register.ts`. Append one `server.registerTool({...})` call after the existing Story 2.3 registrations. Tool definition:
    - `name`: `"readRepoSignals"` (camelCase verb-noun per implementation-patterns-consistency-rules §4).
    - `description`: `"Return a typed RepoSignals payload (languages, layout, README excerpt, recent commit titles, dependency manifests) for the resolved target repo. Used by /hire (FR85)."`
    - `inputSchema`: `{ type: "object", properties: { targetRepoRoot: { type: "string" } }, required: ["targetRepoRoot"] }`.
    - `handler`: thin wrapper — parse args, call `readRepoSignals(...)`, return `{ content: [{ type: "text", text: JSON.stringify(result) }] }`. Compact JSON (no indent) — the skill consumes via `JSON.parse`.
  - [ ] 4.2 Do NOT reorder existing tool registrations. Append only.

- [ ] **Task 5 — Update `permissions/hiring-manager.yaml` (AC: 1, 5)**
  - [ ] 5.1 Open `plugins/crew/permissions/hiring-manager.yaml`. Current `tools_allow` after Story 2.3 Task 8.1: `[heartbeat, readCatalogue, instantiatePersona, readPersona, lookupRoleByDomain]` (five entries).
  - [ ] 5.2 Add `readRepoSignals`. Final list: `[heartbeat, readCatalogue, instantiatePersona, readPersona, lookupRoleByDomain, readRepoSignals]` (six entries — matches AC5(d)).
  - [ ] 5.3 Leave `gh_allow` and `gh_allow_args` unchanged — `/hire` does not call `gh`. The hiring manager's catalogue file (`plugins/crew/catalogue/hiring-manager.md`) declares `gh_allow: []`; the permission YAML should match. Verify.
  - [ ] 5.4 No changes to any other role's permission YAML. `readRepoSignals` is hiring-manager-only in v1.
  - [ ] 5.5 The Story 2.2 parity test (`permissions-catalogue-parity.test.ts`) asserts `gh_allow` parity, not `tools_allow`. Adding an MCP tool name to `tools_allow` does NOT break the parity test. Verify by running `pnpm --dir plugins/crew test` after the YAML edit.

- [ ] **Task 6 — Author `plugins/crew/skills/hire/SKILL.md` (AC: 1, 2, 3, 4)**
  - [ ] 6.1 Create the directory `plugins/crew/skills/hire/` and file `plugins/crew/skills/hire/SKILL.md`. Match the directory shape used by `plugins/crew/skills/status/SKILL.md` (Story 1.7). The slash command surfaces as `/crew:hire` per the implementation-patterns-consistency-rules §8 skill shape.
  - [ ] 6.2 Frontmatter (verbatim):
    ```yaml
    ---
    name: crew:hire
    description: Open a hiring conversation — the hiring manager reads your repo and proposes a starting team.
    allowed_tools: [Read, Task]
    ---
    ```
    - `allowed_tools` is `[Read, Task]`. `Read` for the skill body's direct catalogue / persona reads (if any inline); `Task` for spawning the hiring-manager subagent (FR24 / core-architectural-decisions.md §"Per-story subagent" — Task is the spawn primitive). No `Bash`, no `Edit` (NFR12: minimum necessary surface).
  - [ ] 6.3 Body sections per implementation-patterns-consistency-rules §8 (`# What this skill does`, `# Prerequisites`, `# Steps`, `# Failure modes`).
  - [ ] 6.4 The `# Steps` section drives the flow:
    1. **Resolve workspace.** Call the existing `getStatus` MCP tool (Story 1.7) with `targetRepoRoot` set to the current Claude Code workspace root. If `getStatus` throws `NoAdapterMatchedError` or `InvalidWorkspaceConfigError`, surface the error verbatim and exit — the user must fix `.crew/config.yaml` before hiring. **Rationale:** every operator skill in v1 starts with `getStatus` to confirm the plugin sees the repo (Story 1.7's contract).
    2. **Detect existing roster.** Call `readPersona` for each entry returned by listing `<targetRepoRoot>/team/` (excluding `custom/` and `_archived/`). Collect `{ role, domain, hired_at }`. If the list is non-empty → re-entry mode (AC4). Else → fresh-hire mode (AC1–AC3).
    3. **Gather repo signals.** Call `readRepoSignals({ targetRepoRoot })`. Cache the result locally; do NOT re-call inside the subagent's turns.
    4. **Spawn the hiring-manager subagent.** Use Claude Code's `Task` tool to launch a subagent. The subagent's system prompt is the catalogue's `Prompt` section (read via `readCatalogue({ role: "hiring-manager" })`) plus a serialised initial context block:
       ```
       <initial-context>
       <repo-signals>...JSON.stringify(repoSignals)...</repo-signals>
       <current-roster>...JSON.stringify(currentRoster) (empty array in fresh-hire mode)...</current-roster>
       </initial-context>
       ```
       The subagent's allowlist is governed by `permissions/hiring-manager.yaml` (Task 5) — it can call `readCatalogue`, `instantiatePersona`, `readPersona`, `lookupRoleByDomain`, `readRepoSignals`, `heartbeat`. No other tools. The MCP dispatcher (Story 1.4) enforces this.
    5. **Pass the conversation through.** The skill is a thin orchestrator — the subagent owns the conversation turns. The skill does NOT parse the operator's responses; the catalogue prompt body (Story 2.1's `hiring-manager.md`) instructs the subagent on the proposal grammar, approve/decline/amend handling, and re-entry-action handling.
    6. **Exit conditions.** The skill exits when the subagent emits the locked-phrase handoff `Handoff to <next role> — <intent>` — specifically, in fresh-hire mode after instantiation completes, the subagent says the verbatim line `Handoff to planner — team hired, ready to plan` (this exact terminal string is added to `plugins/crew/catalogue/hiring-manager.md` § Prompt by Task 0 — the skill matches on it byte-for-byte). The skill MAY also accept a verdict-like terminal line `**Verdict: HIRING COMPLETE**` / `**Verdict: NO CHANGES**` / `**Verdict: DECLINED**` for forward compatibility, but the catalogue copy this story ships uses the `Handoff to ...` phrase. **For v1, treat any subagent reply ending in `done` (re-entry mode) or the exact catalogue handoff string as the terminal signal.** The verdict-grammar parser (Story 1.5) is not invoked here — `/hire` is not a reviewer skill.
  - [ ] 6.5 The `# Failure modes` section names:
    - **Workspace not resolved:** surfaces the underlying error from `getStatus`. User fix: see `docs/README-install.md` checkpoint 5.
    - **Catalogue read fails:** `CatalogueRoleNotFoundError` for `hiring-manager` — points the user at `plugins/crew/catalogue/hiring-manager.md` (the shipped file from Story 2.1). This is a plugin-install corruption case; should not occur in a clean install.
    - **`instantiatePersona` refuses with `PersonaAlreadyExistsError`:** per AC3 — the skill prints `Already hired: <role> (no change).` and continues. Not a hard failure.
    - **User declines all hires:** per AC3 — the skill exits cleanly with the `No roles hired.` message. Not a failure.
    - **Subagent invents a role outside the catalogue:** the catalogue prompt instructs the subagent to refuse. If a `readCatalogue` call returns `CatalogueRoleNotFoundError` for an invented role, the dispatcher returns the error to the subagent; the subagent surfaces the manual escape hatch under `<target-repo>/team/custom/` (FR92). Not a skill-level failure.
  - [ ] 6.6 **Do NOT** put any logic in the skill body beyond "resolve, detect roster, gather signals, spawn subagent, watch for terminal signal." All proposal grammar, justification rendering, and re-entry-action dispatch lives inside the hiring-manager subagent driven by the catalogue prompt. The skill is intentionally thin — same discipline as `/crew:status`.

- [ ] **Task 7 — Integration test `hire-skill.test.ts` (AC: 1, 2, 3, 4, 5)**
  - [ ] 7.1 Create `plugins/crew/mcp-server/tests/hire-skill.test.ts`. New file. Pattern after `plugins/crew/mcp-server/tests/get-status.test.ts` for the temp-dir target-repo idiom and `persona-machinery.test.ts` (Story 2.3) for the persona-file round-trip helpers.
  - [ ] 7.2 The vitest harness CANNOT invoke real Claude Code, real `Task` spawns, or a real LLM. **It tests the SKILL'S TOOL ORCHESTRATION, not LLM behaviour** — the contract here is the same as Story 1.7's `get-status.test.ts`: assert MCP tool registration, input/output shapes, and the persona-file side effects of `instantiatePersona` calls. The subagent's conversational behaviour is validated by the calibration loop (core-architectural-decisions.md §"Out of v1 — Claude-Code-stub harness"), not by this test.
  - [ ] 7.3 **In-process subagent stub** (Task 6.4's spawn). Define a `runHireFlow` test helper in the test file that simulates the skill's orchestration without spawning Claude Code:
    ```ts
    async function runHireFlow(opts: {
      targetRepoRoot: string;
      response: "approve all" | "done" | `approve ${string}` | `add ${string}` | "decline";
    }): Promise<{ confirmations: string[]; instantiateCalls: string[] }>;
    ```
    The helper: (a) calls `readRepoSignals`, `readCatalogue({ role: "hiring-manager" })`, and lists `team/` exactly as the skill would; (b) for `approve all` in fresh-hire mode, calls `instantiatePersona` for the five default-roster roles; (c) for `approve <ids>`, calls it for the listed ids; (d) for `done` in re-entry mode, calls `instantiatePersona` zero times; (e) collects confirmation lines per AC3's grammar. The stub deliberately encodes the **default-roster decision** in the helper, not the hiring-manager's prompt — the test's purpose is to assert the tool-side contract.
  - [ ] 7.4 **AC1 / AC5(a, c):** Fresh-empty fixture. Create `<TMP_A>` via `fs.mkdtemp("crew-hire-A-")`. Pre-seed `.crew/config.yaml` (minimal valid — re-use the pattern from `workspace-resolver.test.ts`). Pre-seed a synthetic `README.md` with the line `# Test target repo`, and a synthetic `package.json` with `{"name":"test","version":"0.0.1"}`. Run `git init && git commit -m "init" --allow-empty` in the fixture (use `execa` from the test). Call `runHireFlow({ targetRepoRoot: TMP_A, response: "approve all" })`. Assert:
    - `readRepoSignals` returns a payload parseable by `RepoSignalsSchema`, with `languages` containing `"TypeScript"` and `"Markdown"`, `dependencyManifests` containing `"package.json"`, `readmeExcerpt` containing `"Test target repo"`, `recentCommitTitles` containing `"init"`, `targetRepoRoot === TMP_A`.
    - Five persona files exist under `<TMP_A>/team/{planner,generalist-dev,generalist-reviewer,retro-analyst,orchestrator}/PERSONA.md`.
    - Each parses cleanly via `parsePersonaFile` (Story 2.3 helper).
    - No persona file exists for any specialist role (`security-specialist`, `test-specialist`, `docs-specialist`, `debugger`) — the fresh-empty fixture has no specialist signals.
    - `instantiateCalls.length === 5`.
  - [ ] 7.5 **AC4 / AC5(b, e):** Already-hired fixture. Create `<TMP_B>`. Pre-seed `.crew/config.yaml`. In `beforeEach`, call `instantiatePersona` directly (not via the harness) for `planner`, `generalist-dev`, `generalist-reviewer` with `clock: () => new Date("2026-06-01T12:00:00.000Z")` and `pluginVersion: "0.1.0"`. Verify the three persona files are on disk. Then call `runHireFlow({ targetRepoRoot: TMP_B, response: "done" })`. Assert:
    - `instantiateCalls.length === 0` (no new hires).
    - The harness's collected re-entry block (returned alongside `confirmations`) contains exactly three role lines, each matching `^<role> — <domain> — hired 2026-06-01T12:00:00\.000Z$` for the right `<role>` and the catalogue's `<domain>` (cross-check by calling `parseCatalogueRole` on each role's catalogue file and comparing the `domain` frontmatter).
    - The literal prompt line `Hire one more (specify catalogue role id), unhire <role>, view-persona <role>, or done.` appears in the re-entry block.
    - Re-running `runHireFlow` a second time against the same fixture with `done` produces a byte-identical re-entry block (modulo final newline) — AC5(e).
  - [ ] 7.6 **AC3 / `add` path:** Against fixture A, call `runHireFlow({ targetRepoRoot: TMP_A, response: "add not-a-real-role" })`. Assert the harness surfaces the literal string `Unknown catalogue role: not-a-real-role.` and does not call `instantiatePersona`. Against the same fixture, call `runHireFlow({ targetRepoRoot: TMP_A, response: "add security-specialist" })`. Assert `instantiatePersona` is called for `security-specialist` exactly once and the persona file lands on disk.
  - [ ] 7.7 **AC3 / decline:** Call `runHireFlow({ targetRepoRoot: TMP_A, response: "decline" })` against a fresh `<TMP_C>`. Assert `instantiateCalls.length === 0`, no `team/` directory exists on disk after the run, and the harness's confirmations array contains the literal `No roles hired. Run /crew:hire again or /crew:skip-hiring to hire the default roster.`.
  - [ ] 7.8 **AC5(c) — tool boundary:** spy on `instantiatePersona` (using `vi.spyOn` on the module export). Assert the call counts match per fixture and that every call's `targetRepoRoot` argument equals the fixture's `TMP_X` (no path-escape).
  - [ ] 7.9 **AC5(d) — permission allowlist:** load `permissions/hiring-manager.yaml` via `loadRolePermissions({ pluginRoot: getPluginRoot(), role: "hiring-manager" })`. Assert `tools_allow.sort()` equals `["heartbeat","instantiatePersona","lookupRoleByDomain","readCatalogue","readPersona","readRepoSignals"].sort()` exactly.
  - [ ] 7.10 **`/hire` skill file self-consistency.** Read `plugins/crew/skills/hire/SKILL.md` from disk. Assert: (i) the YAML frontmatter parses and `name === "crew:hire"`, (ii) `allowed_tools` is exactly `["Read", "Task"]`, (iii) the body contains the section headers `# What this skill does`, `# Prerequisites`, `# Steps`, `# Failure modes` in that order, (iv) the file references the slash command literal `/crew:hire` at least once in the body.
  - [ ] 7.11 **End-to-end via MCP** (mirror Story 1.7's `acceptance` pattern). Create a `createServer()`, call `registerAllTools(server)`, connect in-memory, assert `ListTools` includes `{ name: "readRepoSignals" }` alongside the Story 2.3 tools, call it with `{ targetRepoRoot: TMP_A }`, parse the returned text as JSON, assert against `RepoSignalsSchema`.
  - [ ] 7.12 No skips, no `.only`, no `.todo`. Diagnostics on failure must name the failing AC, the fixture, the offending role / file path. Mirror `persona-machinery.test.ts`'s diagnostic discipline.
  - [ ] 7.13 Test file header MUST cite this story (`Story 2.4 AC1–AC5`) and reference `plugins/crew/docs/user-surface-acs.md`, mirroring `catalogue-shape.test.ts` and `persona-machinery.test.ts`.

- [ ] **Task 8 — Build & dist verification (AC: 5)**
  - [ ] 8.1 Run `pnpm --dir plugins/crew/mcp-server build`. `tsc` must compile cleanly. New source files: `schemas/repo-signals.ts`, `lib/repo-signal-detectors.ts`, `tools/read-repo-signals.ts`. Modified: `tools/register.ts`. All under `src/`. All produce `dist/` siblings.
  - [ ] 8.2 Per `plugins/crew/docs/README-install.md` § Build artefacts and Story 1.9's contract, the built `mcp-server/dist/` tree is committed. **This story adds source under `src/`** — rebuild and commit `dist/` in the same commit as `src/`. `ci-drift-check.test.ts` enforces alignment.
  - [ ] 8.3 The skill file (`plugins/crew/skills/hire/SKILL.md`) and the permission YAML (`plugins/crew/permissions/hiring-manager.yaml`) are static assets shipped as-is via `/plugin install`'s file-copy semantics. No bundling step.
  - [ ] 8.4 Verify the existing Story 1.7 self-consistency test (`get-status.test.ts` AC4f, README-install.md six-checkpoint assertion) still passes — this story does NOT modify `README-install.md`. If a follow-up wants a `/crew:hire` mention in the install walkthrough, that is a separate change (likely in Epic 7 Story 7.2's first-run-in-5-minutes README).

- [ ] **Task 9 — Verify no other story's contract drifted (AC: 1–5)**
  - [ ] 9.1 Confirm `plugins/crew/mcp-server/src/schemas/{catalogue,persona,role-permissions,status-report}.ts` are unchanged.
  - [ ] 9.2 Confirm `plugins/crew/mcp-server/src/tools/{read-catalogue,instantiate-persona,read-persona,lookup-role-by-domain,get-status}.ts` are unchanged. This story consumes them; it does not modify them.
  - [ ] 9.3 Confirm `plugins/crew/mcp-server/src/lib/{managed-fs,markdown-frontmatter,persona-file,plugin-root,plugin-version,workspace-resolver}.ts` are unchanged.
  - [ ] 9.4 Confirm `plugins/crew/catalogue/*.md` is unchanged **except** `plugins/crew/catalogue/hiring-manager.md` § Prompt (which Task 0 extends). Diff `hiring-manager.md` against its prior state: only the `## Prompt` body lines change; frontmatter and other `##` sections are byte-identical. All other catalogue files are byte-identical to their Story 2.1 state.
  - [ ] 9.5 Confirm `plugins/crew/permissions/{orchestrator,planner,generalist-dev,generalist-reviewer,retro-analyst,security-specialist,test-specialist,docs-specialist,debugger,gh-error-map}.yaml` are unchanged. Only `hiring-manager.yaml` changes in this story.
  - [ ] 9.6 Confirm `plugins/crew/skills/status/SKILL.md` is unchanged. Story 1.7's skill is referenced from the failure-mode copy but not edited.
  - [ ] 9.7 Confirm `plugins/crew/docs/README-install.md` is unchanged. The hiring step is not part of v1's six-checkpoint install — it is the operator's first action *after* install. Epic 7 Story 7.2 will integrate `/crew:hire` into a fuller walkthrough.

---

## Dev Notes

### Critical context: what was shipped before, what this story builds on

- **Story 1.1** scaffolded `mcp-server/src/{schemas,state,tools,lib}/`. Convention: kebab-case filenames, `.ts` sources, co-located `*.test.ts`.
- **Story 1.2 / 1.2b** shipped `resolveWorkspace` and `validateActiveAdapter`. `/hire` uses them via `getStatus` (Story 1.7) — the skill's first step is "confirm the plugin sees the repo." No new workspace-resolver logic here.
- **Story 1.4** shipped the MCP dispatcher and `_meta.role` permission enforcement (server.ts lines 116–146). **The hiring-manager subagent's allowlist is enforced by this dispatcher** — `readRepoSignals` MUST appear in `permissions/hiring-manager.yaml` Task 5) or the subagent's tool calls will be refused.
- **Story 1.5** shipped `lib/logger.ts` (pino → JSONL). This story emits NO telemetry — `/hire` is a one-shot operator surface, not a runtime agent event. Future stories may add a `team.change` event (FR105–FR107) when retro-driven hires fire; that is out of scope here.
- **Story 1.6** shipped `lib/managed-fs.ts` + `CANONICAL_PATH_GLOBS` (`team/**` line 20). `instantiatePersona` (Story 2.3) is the only writer this story invokes; managed-fs is already wired.
- **Story 1.7** shipped `getStatus`, `renderStatus`, `tools/register.ts`, and the skill-shape pattern (`skills/status/SKILL.md`). **This story extends `register.ts` by one entry (`readRepoSignals`) and adds a sibling skill directory `skills/hire/SKILL.md`.** Story 1.7's `acceptance.test.ts` AC3 invariant — "bare `createServer()` registers zero tools" — is preserved (we only modify `registerAllTools`, never `createServer`).
- **Story 1.8** introduced the `user-surface` AC tag and pre-PR smoke gate. **This story has FOUR `(user-surface)` ACs (AC1–AC4)**, all naming `/crew:hire`. The pre-PR gate (per `plugins/crew/docs/user-surface-acs.md`) will require an operator-paste-output or automated-e2e verification event covering each. The harness in Task 7 simulates the tool-side behaviour but does not drive real Claude Code — operator paste-output is the expected verification route for this story's PR, with the harness covering the deterministic tool-boundary assertions.
- **Story 1.9** committed `mcp-server/dist/`. **This story modifies `src/` — rebuild and commit `dist/` in the same change.** `ci-drift-check.test.ts` enforces alignment.
- **Story 2.1** shipped the catalogue, including `plugins/crew/catalogue/hiring-manager.md` whose `Prompt` section authors the hiring-manager's conversational behaviour (proposal grammar, approve/decline/amend, re-entry actions). **This story consumes that prompt via `readCatalogue` and ALSO extends the `Prompt` section minimally (Task 0) to add the three verbatim operator-facing strings AC2 / AC3 / AC4 / Task 6.4 assert.** The catalogue is the persona definition — including how the role talks — so the verbatim strings the hiring manager says live in the catalogue alongside the rest of its persona. The skill and the test harness then *reference / assert* those literals; they do not redefine them. Frontmatter and other `##` sections of `hiring-manager.md` remain out of scope.
- **Story 2.2** shipped `permissions/<role>.yaml`. This story modifies one file (`hiring-manager.yaml`) to add `readRepoSignals`. The Story 2.2 parity test asserts `gh_allow` parity, not `tools_allow` — adding an MCP tool name does not break it.
- **Story 2.3** shipped `PersonaFileSchema`, `parsePersonaFile`, `renderPersonaFile`, and the four MCP tools (`readCatalogue`, `instantiatePersona`, `readPersona`, `lookupRoleByDomain`) plus four error classes. **This story is the FIRST CALLER of those four tools.** Every behaviour pinned by Story 2.3's ACs is now exercised end-to-end by `/hire`. Re-entry idempotency (AC4) leans on Story 2.3 Task 4.3's `PersonaAlreadyExistsError`; domain-listing (re-entry's `<role> — <domain> — hired <ts>` block) leans on `readPersona`; the absence of a `currentRoster` in fresh-hire mode means `lookupRoleByDomain` is NOT called from this story (it's called by Epic 3's yield protocol; included in the allowlist for forward compatibility per Story 2.3 Task 8.2).

### Architecture references (load these first, dev agent)

- `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` §4 (MCP Tool Naming) — `readRepoSignals` is camelCase verb-noun, reader name starts with `read`. Compliant.
- `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` §7 (Locked Phrases) — the hiring-manager's terminal handoff `Handoff to <next role> — <intent>` matches the locked-phrase grammar. The skill recognises this as a terminal signal but does NOT run the verdict-grammar parser (which is reviewer-scope).
- `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` §8 (Skill File Shape) — pins frontmatter (`name`, `description`, `allowed_tools`) and the four required body sections.
- `_bmad-output/planning-artifacts/architecture/project-structure-boundaries.md` lines 29–40 — pins `plugins/crew/skills/hire.md` (note: shipped as `skills/hire/SKILL.md` per Story 1.7's directory pattern; both shapes are accepted by Claude Code's plugin loader, directory form matches what's already on disk).
- `_bmad-output/planning-artifacts/architecture/project-structure-boundaries.md` lines 192–195 — pins hiring (FR84–FR92) at `skills/hire.md` + `mcp-server/src/tools/{read-catalogue,instantiate-persona}.ts` + `catalogue/hiring-manager.md`. The new `read-repo-signals.ts` is a natural sibling.
- `_bmad-output/planning-artifacts/architecture/core-architectural-decisions.md` lines 77–78 — Per-story subagent via Task tool with clean context; persona injection assembles system prompt = catalogue prompt body + persona knowledge section. **For `/hire`, persona knowledge is irrelevant (the hiring-manager hasn't been "hired" — it's a catalogue role used to drive hiring); the subagent's system prompt is just the catalogue `Prompt` section plus the initial-context block.**
- `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md` FR85 (high-level repo read), FR86 (proposal with one-sentence justifications), FR87 (default roster), FR88 (approve/decline/amend), FR89 (persona instantiation contract — Story 2.3 owns), FR90 (re-entry actions), FR91 (`/skip-hiring` fast path — Story 2.5 owns), FR92 (no role invention; manual escape hatch).
- `_bmad-output/planning-artifacts/prd-crew-v1/non-functional-requirements.md` NFR12 (minimum-necessary tool surface — informs the skill's `allowed_tools: [Read, Task]`), NFR21 (telemetry is for runtime agent events — `/hire` emits none), NFR25 (plain-Markdown persona readability — already enforced by Story 2.3).
- `plugins/crew/docs/user-surface-acs.md` — `(user-surface)` tag rubric (Story 1.8). AC1–AC4 are tagged; AC5 is not.
- `plugins/crew/catalogue/hiring-manager.md` — the catalogue prompt body the skill spawns the subagent with. Do NOT edit; consume verbatim.

### Files this story creates (NEW)

- `plugins/crew/mcp-server/src/schemas/repo-signals.ts` — `RepoSignalsSchema`, `RepoSignals` type.
- `plugins/crew/mcp-server/src/lib/repo-signal-detectors.ts` — `detectLanguagesFromLayout`, `detectDependencyManifests`, `truncateReadmeExcerpt` (pure helpers).
- `plugins/crew/mcp-server/src/tools/read-repo-signals.ts` — `readRepoSignals` compute function.
- `plugins/crew/mcp-server/tests/repo-signal-detectors.test.ts` — unit tests for the pure helpers.
- `plugins/crew/mcp-server/tests/hire-skill.test.ts` — integration harness for AC1–AC5.
- `plugins/crew/skills/hire/SKILL.md` — the operator-facing slash-command file.
- `plugins/crew/mcp-server/dist/**` — rebuild output. Commit per Story 1.9's contract.

### Files this story MAY modify (UPDATE, with care)

- `plugins/crew/mcp-server/src/tools/register.ts` — append one `server.registerTool({...})` call for `readRepoSignals` after the Story 2.3 entries. Do not refactor existing entries. Do not reorder.
- `plugins/crew/permissions/hiring-manager.yaml` — expand `tools_allow` from the post-Story-2.3 five-entry list to six entries (add `readRepoSignals`). Leave `gh_allow` and `gh_allow_args` unchanged.
- `plugins/crew/catalogue/hiring-manager.md` — `## Prompt` section ONLY. Add the three verbatim operator-facing strings per Task 0. Frontmatter (`role`, `domain`, `model_tier`, `tools_allow`, `gh_allow`, `locked_phrases`) and the other `##` sections (`Domain`, `Mandate`, `Out of mandate`) remain unchanged. No other catalogue file is touched.

### Files this story MUST NOT modify

- `_bmad-output/implementation-artifacts/sprint-status.yaml` (orchestrator owns).
- `plugins/crew/catalogue/*.md` EXCEPT `plugins/crew/catalogue/hiring-manager.md` § Prompt (which Task 0 explicitly extends). The frontmatter and other `##` sections of `hiring-manager.md` are also out of scope — only the `Prompt` section body may be edited, and only minimally to add the three verbatim strings per Task 0. All other catalogue files (planner, generalist-dev, generalist-reviewer, retro-analyst, orchestrator, security-specialist, test-specialist, docs-specialist, debugger) remain unchanged.
- `plugins/crew/mcp-server/src/schemas/{catalogue,persona,role-permissions,status-report,plugin-manifest}.ts`.
- `plugins/crew/mcp-server/src/tools/{read-catalogue,instantiate-persona,read-persona,lookup-role-by-domain,get-status}.ts`.
- `plugins/crew/mcp-server/src/lib/{managed-fs,markdown-frontmatter,persona-file,plugin-root,plugin-version,workspace-resolver,logger,gh}.ts` (consume `execa` from `gh.ts` by re-importing; do not modify the module).
- `plugins/crew/mcp-server/src/errors.ts` — no new error classes; failures inside `readRepoSignals` downgrade to empty defaults, and Story 2.3's four error classes already cover the persona-side error surfaces.
- `plugins/crew/permissions/{orchestrator,planner,generalist-dev,generalist-reviewer,retro-analyst,security-specialist,test-specialist,docs-specialist,debugger,gh-error-map}.yaml`.
- `plugins/crew/skills/status/SKILL.md`.
- `plugins/crew/docs/README-install.md` (Epic 7 Story 7.2 will integrate `/crew:hire` into a fuller walkthrough; v1's six-checkpoint install does not include hiring).
- Root `README.md`.
- `plugins/crew/mcp-server/tests/{catalogue-shape,permissions-catalogue-parity,permissions-enforcement,persona-machinery,get-status,acceptance,ci-drift-check}.test.ts` — existing suites pass as-is.

### Proposal block — canonical example (fresh-hire, TS+Markdown fixture)

This is what the harness asserts the hiring-manager subagent emits as its first reply against fixture A (Task 7.4). Included here so the dev agent can pin the expected output shape — but the **authoritative grammar** lives in the catalogue prompt body (`plugins/crew/catalogue/hiring-manager.md`); the harness asserts via regex / substring matching, not via byte-for-byte equality:

```
Reading your repo: TypeScript codebase, Markdown-heavy, package.json present, no security/test specialist signals.

Proposed starting team:

planner — owns the backlog so generalist-dev never starves
generalist-dev — claims and ships TypeScript stories
generalist-reviewer — reviews diffs against docs/standards.md
retro-analyst — closes the calibration loop cycle-over-cycle
orchestrator — routes yields by domain across the hired team

Approve all, approve a subset (list role ids), decline, or request a specific catalogue role.
```

Notes:
- The first line is a one-sentence signal summary, grounded in `RepoSignals` field values.
- The default roster is five roles in fixed order (FR87).
- No specialists in this example — the synthetic fixture has none of the trigger signals.
- The final prompt line is verbatim from the catalogue.

### Re-entry block — canonical example (already-hired with three roles)

This is what the harness asserts against fixture B (Task 7.5):

```
Currently hired:

planner — story authoring and acceptance criteria — hired 2026-06-01T12:00:00.000Z
generalist-dev — claim-and-ship dev loop for typescript stories — hired 2026-06-01T12:00:00.000Z
generalist-reviewer — diff review against docs/standards.md — hired 2026-06-01T12:00:00.000Z

Hire one more (specify catalogue role id), unhire <role>, view-persona <role>, or done.
```

(Domain strings above are illustrative — the actual values come from `parseCatalogueRole(plugins/crew/catalogue/<role>.md).frontmatter.domain` and are pinned by Story 2.1.)

### `readRepoSignals` JSON shape (for `register.ts`)

```jsonc
// readRepoSignals
{ "inputSchema": { "type": "object", "properties": { "targetRepoRoot": { "type": "string" } }, "required": ["targetRepoRoot"] } }
// Returns: { content: [{ type: "text", text: JSON.stringify(RepoSignals) }] }
//
// Example payload:
// {
//   "targetRepoRoot": "/abs/path/to/repo",
//   "languages": ["Markdown", "TypeScript"],
//   "topLevelLayout": [".crew", "README.md", "package.json", "src", "tests"],
//   "readmeExcerpt": "# My project\n\nA short description...",
//   "recentCommitTitles": ["fix: bug", "feat: new thing", "init"],
//   "dependencyManifests": ["package.json"]
// }
```

### Testing standards

- **Framework:** vitest, already configured (`plugins/crew/mcp-server/vitest.config.ts`).
- **Test placement:** `plugins/crew/mcp-server/tests/{repo-signal-detectors,hire-skill}.test.ts` — flat tests/ layout matching `persona-machinery.test.ts`.
- **Temp-dir target repos:** `os.tmpdir()` + `fs.mkdtemp("crew-hire-")`. Clean up in `afterEach`. Match `persona-machinery.test.ts` and `get-status.test.ts`.
- **`git init` in fixtures.** The `readRepoSignals` `recentCommitTitles` field requires a git repo with at least one commit. Use `execa("git", ["init"], { cwd: TMP })` and `execa("git", ["commit", "-m", "init", "--allow-empty"], { cwd: TMP, env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" } })`. Pin user via env vars to keep tests hermetic — do not rely on the developer's git config.
- **In-process subagent stub.** Per Task 7.3, the harness simulates the skill's orchestration without spawning Claude Code. The test asserts the tool-side contract (which MCP tools are called, with what args, with what side effects on disk). LLM-driven conversational behaviour is validated downstream by the calibration loop (core-architectural-decisions.md §"Out of v1").
- **Pure clock:** `instantiatePersona` accepts a `clock` test seam (Story 2.3 Task 4.1). Tests pin `clock` to `() => new Date("2026-06-01T12:00:00.000Z")` for deterministic `hired_at`.
- **No skips, no `.only`, no `.todo`.**
- **Diagnostics on failure** must name the failing AC, the fixture, the offending role / file path. Mirror Story 2.3's diagnostic discipline.
- **Reuse, don't reinvent:** `parseCatalogueRole`, `parsePersonaFile`, `loadRolePermissions`, `getPluginRoot`, `getPluginVersion`, `instantiatePersona`, `readPersona`. Do NOT add a new YAML parser, persona renderer, or workspace resolver.

### Project Structure Notes

- All paths follow `_bmad-output/planning-artifacts/architecture/project-structure-boundaries.md`. The skill file at `plugins/crew/skills/hire/SKILL.md` matches Story 1.7's directory pattern; project-structure-boundaries.md lists `skills/hire.md` (flat form), but Claude Code's plugin loader accepts both forms — the directory form is what's already on disk for `/crew:status` (Story 1.7) and is the convention this story preserves.
- `team/**` writes go through `instantiatePersona` only. `/hire` does NOT call `writeManagedFile` directly.
- No new architectural boundary is introduced. The MCP server remains the only canonical-state boundary for `team/`.

### References

- [Source: `_bmad-output/planning-artifacts/epics/epic-2-team-formation-hiring-personas-and-team-observability.md#Story 2.4: Hiring-manager agent and /hire skill`] — verbatim epic ACs.
- [Source: `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md#FR85`] — high-level repo read.
- [Source: `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md#FR86`] — proposal with one-sentence justifications.
- [Source: `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md#FR87`] — default roster of five.
- [Source: `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md#FR88`] — approve / decline / amend response handling.
- [Source: `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md#FR89`] — persona instantiation contract (Story 2.3 owns).
- [Source: `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md#FR90`] — re-entry actions on `/hire` against an existing team.
- [Source: `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md#FR92`] — no role invention; manual escape hatch.
- [Source: `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md#FR96`] — text-editor edit affordance (preserved because persona files are plain Markdown).
- [Source: `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md#FR97`] — git-revert affordance.
- [Source: `_bmad-output/planning-artifacts/prd-crew-v1/non-functional-requirements.md#NFR12`] — minimum-necessary tool surface (informs `allowed_tools: [Read, Task]`).
- [Source: `_bmad-output/planning-artifacts/prd-crew-v1/non-functional-requirements.md#NFR21`] — telemetry is for runtime agent events (`/hire` emits none).
- [Source: `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md#3. Catalogue & Persona File Shape`] — canonical persona shape; informs the re-entry block's `<role> — <domain> — hired <ts>` grammar.
- [Source: `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md#4. MCP Tool Naming`] — camelCase verb-noun; `readRepoSignals` complies.
- [Source: `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md#7. Locked Phrases`] — `Handoff to <next role> — <intent>` is the terminal signal.
- [Source: `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md#8. Skill File Shape`] — required frontmatter and body sections.
- [Source: `_bmad-output/planning-artifacts/architecture/project-structure-boundaries.md#Plugin tree`] — `skills/hire.md` / `permissions/hiring-manager.yaml` placements.
- [Source: `_bmad-output/planning-artifacts/architecture/core-architectural-decisions.md#Per-story subagent`] — Task tool spawn pattern.
- [Source: `plugins/crew/docs/user-surface-acs.md`] — `(user-surface)` tagging rubric (Story 1.8 convention).
- [Source: `plugins/crew/catalogue/hiring-manager.md`] — catalogue prompt body the subagent runs against; this story extends the `## Prompt` section per Task 0 to add the three verbatim operator-facing strings AC2 / AC3 / AC4 assert.
- [Source: `plugins/crew/skills/status/SKILL.md`] — Story 1.7's skill-file precedent.
- [Source: `plugins/crew/mcp-server/src/tools/register.ts`] — `registerAllTools` is the one entry point; this story appends one entry.
- [Source: `plugins/crew/mcp-server/src/tools/{read-catalogue,instantiate-persona,read-persona,lookup-role-by-domain}.ts`] — Story 2.3 tools the skill consumes.
- [Source: `plugins/crew/mcp-server/src/lib/gh.ts`] — `execa` re-import source.
- [Source: `plugins/crew/permissions/hiring-manager.yaml`] — modified by Task 5 to add `readRepoSignals`.
- [Source: `plugins/crew/mcp-server/tests/persona-machinery.test.ts`] — Story 2.3 test pattern.
- [Source: `plugins/crew/mcp-server/tests/get-status.test.ts`] — Story 1.7 test pattern.

---

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
