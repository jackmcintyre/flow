# Story 2.5: `/skip-hiring` fast path and custom escape hatch

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin operator (Maya / Jack at first install)**,
I want **(a) a `/crew:skip-hiring` slash command that hires the five default-roster roles directly without an interactive proposal flow, AND (b) a documented manual escape hatch under `<target-repo>/team/custom/<role>.md` for cases where I genuinely need a role outside the v1 catalogue — paired with a hard refusal from the hiring manager to invent roles inline**,
so that **I can try the plugin in seconds without sitting through a hiring conversation, AND I have one well-lit on-disk path for the rare "I really do need a custom role" case rather than an unbounded LLM-improvised proposal grammar (FR91, FR92).**

### What this story is, in one sentence

Ship `plugins/crew/skills/skip-hiring/SKILL.md` (new fast-path slash command that calls `instantiatePersona` for the five default-roster roles directly, no subagent in the loop), a new `readCustomRole` MCP tool at `plugins/crew/mcp-server/src/tools/read-custom-role.ts` that parses an operator-authored `<targetRepoRoot>/team/custom/<role>.md` file against the existing `CatalogueRoleSchema`, a minimal extension of `plugins/crew/catalogue/hiring-manager.md` § Prompt to (i) hard-pin the role-invention refusal in absolute language with the verbatim refusal string the integration test asserts, and (ii) teach the hiring-manager to discover and surface custom roles from `<target-repo>/team/custom/` on every run, an extension of `/crew:hire` (Story 2.4) so that when an operator approves or `add`s a custom role id, the skill resolves it via `readCustomRole` and calls `instantiatePersona` against it, and a vitest integration harness that drives (a) the skip-hiring fast path against a fresh fixture and (b) the role-invention refusal plus the custom-role acceptance against an already-hired fixture with a hand-authored custom-role file.

### What this story fixes (and why it needs its own story)

Story 2.4 shipped the interactive `/crew:hire` conversation — a multi-turn proposal / approve / decline / amend flow that is great for considered first-use but is overkill for the "I just want to try it" path and is *under*-kill for "I genuinely need a role you don't ship in v1." Without Story 2.5:

- FR91 — the one-command default-roster path — has no implementation; the only way to hire is to walk through the full `/crew:hire` conversation.
- FR92 — refuse role invention; surface manual escape hatch — is partially shipped (`plugins/crew/catalogue/hiring-manager.md` § Mandate mentions the path, and Story 2.4's `# Failure modes` documents the refusal posture). But **the refusal is advisory in catalogue prose**, not hard-pinned in absolute language. Per the Story 1.8 lesson (PR #76 "Process observation"), LLM-driven user surfaces treat advisory copy as suggestion; behavioural contracts must be stated in absolute terms (MUST / MUST NOT / NEVER) or the model will improvise. The current `## Mandate` line "Refuse invented roles; point the user at `<target-repo>/team/custom/`" reads like guidance, not a contract. This story hard-pins it.
- The `<target-repo>/team/custom/<role>.md` file path itself is a README-promised affordance with no parser, no schema validation, no test coverage, and no proposal-surface integration. An operator who hand-authors one today gets nothing — the hiring manager can't propose it because the skill's tool surface (`readCatalogue`) only reads from the plugin's shipped catalogue directory.
- Sibling Story 2.6 (`/crew:team`) needs to list custom-role personas the same way it lists catalogue-role personas; pinning the custom-role file-shape contract HERE (it's `CatalogueRoleSchema` — same shape, different directory) keeps 2.6 trivial.

This story is the SECOND operator-facing skill in Epic 2 (after `/crew:hire`) and the FIRST story to wire the custom-role escape hatch end-to-end. It is also where the role-invention refusal goes from "documented in mandate prose" to "load-bearing contract the test asserts byte-for-byte."

### What this story does NOT

- (a) Touch `_bmad-output/implementation-artifacts/sprint-status.yaml` — the orchestrator owns status transitions.
- (b) Re-architect Story 2.4's `/crew:hire` skill. The extension to `/crew:hire` is strictly additive: when the operator's response (in either fresh-hire approve / approve-subset / add or in re-entry `hire one more`) names a role id that fails `readCatalogue` lookup, the skill MUST try `readCustomRole` next before declaring the id unknown. No other change to the `/crew:hire` happy path, proposal grammar, or re-entry block. Story 2.4's AC1–AC5 invariants are preserved.
- (c) Modify `plugins/crew/mcp-server/src/schemas/catalogue.ts`. The custom-role file uses the exact same `CatalogueRoleSchema` as a shipped catalogue file — that's the contract surface for the escape hatch. No new schema, no schema variant, no superset.
- (d) Modify `plugins/crew/mcp-server/src/tools/{read-catalogue,instantiate-persona,read-persona,lookup-role-by-domain,read-repo-signals,get-status}.ts`. This story consumes them; it does not modify them.
- (e) Modify any catalogue file OTHER than `plugins/crew/catalogue/hiring-manager.md` § Prompt. As in Story 2.4, only the `## Prompt` section is in scope on `hiring-manager.md`; frontmatter and other `##` sections are byte-identical to their post-Story-2.4 state. All other catalogue files (`planner.md`, `generalist-dev.md`, `generalist-reviewer.md`, `retro-analyst.md`, `orchestrator.md`, `security-specialist.md`, `test-specialist.md`, `docs-specialist.md`, `debugger.md`) are byte-identical to their Story 2.1 state.
- (f) Modify the YAML frontmatter of `plugins/crew/permissions/hiring-manager.yaml` other than to add `readCustomRole` to `tools_allow`. The post-Story-2.4 six-entry list becomes a seven-entry list. `gh_allow` and `gh_allow_args` unchanged.
- (g) Implement `/crew:team` (Story 2.6) or `/crew:ask` (Story 2.7). The custom-role file shape this story pins is intentionally chosen so that 2.6's persona-listing logic is uniform across catalogue-rooted and custom-rooted personas, but 2.6 itself is out of scope.
- (h) Bundle a sample `team/custom/<role>.md` with the plugin. The escape hatch is operator-authored; shipping an example would muddy the "the catalogue is the v1 roster" contract. The README/install docs may, in a separate change (likely Epic 7 Story 7.2), document the file-shape with a worked example — that change is not in this story's scope.
- (i) Add a CLI scaffold (`/crew:new-custom-role` or similar) to generate the custom-role file skeleton for the operator. Manual `cp`-from-catalogue is the v1 affordance; a scaffolding skill is deferred (likely Epic 7).
- (j) Touch the dev-loop, retro, orchestrator, or any post-hiring flow. `/crew:skip-hiring` ends when persona files are on disk; `/crew:hire` (extended) ends per Story 2.4's exit conditions.
- (k) Implement `appendPersonaKnowledge` or any persona-knowledge mutation. Both this story's skill and the custom-role acceptance path materialise the persona with `## Knowledge` empty, per Story 2.3's `instantiatePersona` contract.
- (l) Add new domain error classes beyond the existing `CatalogueRoleNotFoundError` and `CatalogueShapeError`. `readCustomRole` reuses both — `CatalogueRoleNotFoundError` when the operator-authored file doesn't exist, `CatalogueShapeError` when it exists but fails the shared Zod parser. No new error class is needed; the test harness greps the existing error messages.
- (m) Modify `plugins/crew/docs/README-install.md`. The skip-hiring fast path and the custom escape hatch are not part of v1's six-checkpoint install — they are operator actions *after* install. Epic 7 Story 7.2's first-run-in-5-minutes README will integrate them.

---

## Acceptance Criteria

> **Verbatim mapping.** ACs 1–3 map to the epic ACs in `_bmad-output/planning-artifacts/epics/epic-2-team-formation-hiring-personas-and-team-observability.md` § Story 2.5. AC4 is the epic's `**AC4 (integration):**` test contract. AC5 is a story-scoped addition that hard-pins the refusal copy in absolute language (Story 1.8 lesson; see § "Why this exists" above).
>
> **User-surface judgement.** ACs 1, 2, and 3 name operator-typed slash commands (`/crew:skip-hiring`, `/crew:hire`) and/or operator-authored file paths the README documents by name (`<target-repo>/team/custom/<role>.md`). All three are tagged `(user-surface)`. AC4 is the integration-test contract — the operator never types `pnpm --dir plugins/crew test`; it is NOT user-surface. AC5 names the catalogue file `plugins/crew/catalogue/hiring-manager.md` (a plugin-shipped file, not an operator-authored or operator-typed surface — the operator never opens it) AND asserts the verbatim refusal string the hiring-manager subagent emits to the operator's screen via `/crew:hire`. Per the rubric, (iv) "any Claude Code UI element the user is expected to observe" applies because the refusal string IS what the operator sees — so AC5 IS user-surface. The pre-PR smoke gate (Story 1.8 / `plugins/crew/docs/user-surface-acs.md`) will require operator-paste-output or an automated-e2e verification event covering AC1, AC2, AC3, and AC5.

**AC1 (user-surface):**
**Given** a target repo with `<target-repo>/.crew/config.yaml` resolved (Story 1.2 contract — `resolveWorkspace` returns without error) AND no existing `team/` directory or no role subdirectories containing `PERSONA.md` under it,
**When** the operator runs `/crew:skip-hiring` from inside Claude Code with that target repo loaded as the workspace,
**Then** the skill calls `instantiatePersona({ targetRepoRoot, role })` exactly once for each of the five default-roster roles in this exact order — `planner`, `generalist-dev`, `generalist-reviewer`, `retro-analyst`, `orchestrator` — writes five persona files at `<target-repo>/team/<role>/PERSONA.md`, prints one confirmation line per role in the format `Hired: <role> → <abs-path>/team/<role>/PERSONA.md`, prints a terminal line `Default roster hired (5 roles). Run /crew:team to view, or /crew:hire to add more.`, and exits cleanly without spawning any subagent and without prompting the operator for any input. _(FR91)_
<!-- user-surface: AC1 names the slash command literal `/crew:skip-hiring` (rubric i), the cross-referenced `/crew:team` and `/crew:hire` in the terminal line (rubric i), and the on-screen confirmation lines the operator reads (rubric iv). The README/install docs MUST direct the operator to type `/crew:skip-hiring`. -->

**AC2 (user-surface):**
**Given** the hiring-manager subagent spawned by `/crew:hire` (Story 2.4) with an operator turn in the conversation,
**When** the operator's response asks the subagent to invent a role outside the v1 catalogue — by any natural-language framing such as `add data-scientist`, `make me a kubernetes-expert`, `I need a frontend-architect`, or `propose a database-administrator` (i.e. the requested role id is neither in the shipped catalogue at `plugins/crew/catalogue/<role>.md` nor in `<target-repo>/team/custom/<role>.md`),
**Then** the subagent's reply (a) MUST NOT call `instantiatePersona` for the invented role, (b) MUST contain the verbatim refusal string `I cannot invent roles outside the v1 catalogue. The catalogue is fixed; the manual escape hatch is to author <target-repo>/team/custom/<role>.md matching the catalogue file shape (see plugins/crew/catalogue/planner.md for the canonical example), then re-run /crew:hire.` exactly once, and (c) MUST then re-emit the appropriate prompt line (the fresh-hire `Approve all, ...` line or the re-entry `Hire one more (...), ...` line per Story 2.4). _(FR92)_
<!-- user-surface: AC2 names `/crew:hire` (rubric i), the file path `<target-repo>/team/custom/<role>.md` the README documents by name AND the user is told to author (rubric iii), the file path `plugins/crew/catalogue/planner.md` the user is told to open for reference (rubric iii), and the verbatim refusal string the operator reads on screen (rubric iv). -->

**AC3 (user-surface):**
**Given** a target repo with a user-authored file at `<target-repo>/team/custom/<role-id>.md` whose frontmatter and `##` section structure validate against `CatalogueRoleSchema` and `REQUIRED_CATALOGUE_SECTIONS` (the same Zod schema and four-section contract used by shipped catalogue files — `Domain`, `Mandate`, `Out of mandate`, `Prompt` headings in canonical order, with the standard frontmatter keys `role`, `domain`, `model_tier`, `tools_allow`, `gh_allow`, `locked_phrases.{handoff,yield,verdict}`),
**When** the operator runs `/crew:hire` and either (i) the fresh-hire proposal block surfaces the custom role as if it were a catalogue role (with a `(custom)` suffix on its proposal line to disambiguate, e.g. `data-scientist (custom) — owns the ML pipeline so generalist-dev does not have to learn pandas`), OR (ii) the operator responds with `add <role-id>` naming the custom role's id,
**Then** the skill resolves the role via `readCustomRole({ targetRepoRoot, role: "<role-id>" })`, on a successful parse calls `instantiatePersona({ targetRepoRoot, role: "<role-id>" })` (which writes the persona at `<target-repo>/team/<role-id>/PERSONA.md` — the custom-role persona lives in the same `team/<role-id>/` shape as a catalogue-role persona, NOT under `team/custom/<role-id>/`), emits the confirmation line `Hired: <role-id> (custom) → <abs-path>/team/<role-id>/PERSONA.md`, and the operator can `cat` the persona to see the `Prompt` body copied verbatim from the operator-authored custom file. On a parse failure, the skill emits the literal line `Custom role file at <target-repo>/team/custom/<role-id>.md failed validation: <CatalogueShapeError message>` and re-prompts (no persona is written). _(FR92, extending FR88)_
<!-- user-surface: AC3 names `/crew:hire` (rubric i), the operator-authored file path `<target-repo>/team/custom/<role-id>.md` the README documents by name (rubric iii), the persona path `<target-repo>/team/<role-id>/PERSONA.md` materialised by the skill, the on-screen `(custom)` suffix and confirmation lines (rubric iv), and the parse-failure diagnostic line (rubric iv). -->

**AC4 (integration):**
**Given** the new `plugins/crew/skills/skip-hiring/SKILL.md`, the new `readCustomRole` MCP tool, the updated `permissions/hiring-manager.yaml`, the updated `plugins/crew/catalogue/hiring-manager.md` § Prompt, the integration harness at `plugins/crew/mcp-server/tests/skip-hiring-and-custom-role.test.ts`, AND extensions to `plugins/crew/mcp-server/tests/hire-skill.test.ts` for the custom-role path,
**When** `pnpm --dir plugins/crew test` runs,
**Then** vitest asserts, against three temp-dir fixture target repos:
- **(a) Skip-hiring fast path** (`<TMP_A>` with `.crew/config.yaml` and no `team/` directory): a `runSkipHiringFlow({ targetRepoRoot: TMP_A })` test helper invokes the skill's orchestration in-process (see Task 5.4). After the run: (i) `<TMP_A>/team/<role>/PERSONA.md` exists for each of the five default-roster roles, (ii) each parses cleanly via `parsePersonaFile` (Story 2.3), (iii) no specialist persona exists, (iv) `instantiatePersona` was called exactly five times with `targetRepoRoot === TMP_A`, (v) no subagent was spawned (the helper records zero `Task` invocations), (vi) the harness's collected output contains the five `Hired: <role> → ...` confirmation lines in the exact default-roster order AND the terminal `Default roster hired (5 roles). Run /crew:team to view, or /crew:hire to add more.` line.
- **(b) Role-invention refusal** (`<TMP_B>` pre-seeded with the five default-roster personas via Story 2.4's helpers): a test helper drives a single subagent turn with the operator input `add kubernetes-expert` (a role id absent from both `plugins/crew/catalogue/` and `<TMP_B>/team/custom/`). The harness asserts (i) `instantiatePersona` is NOT called for `kubernetes-expert`, (ii) the subagent's reply contains the verbatim AC2 refusal string byte-for-byte, (iii) the reply then contains the re-entry prompt line `Hire one more (specify catalogue role id), unhire <role>, view-persona <role>, or done.`. Use `readCatalogue({ role: "hiring-manager" })` to source the catalogue prompt body and assert the refusal string is present in the catalogue's `## Prompt` section (so the subagent has it to emit).
- **(c) Custom-role acceptance** (`<TMP_C>` pre-seeded with `.crew/config.yaml` AND a hand-authored `<TMP_C>/team/custom/data-scientist.md` whose contents are a hand-built valid catalogue-shaped file with `role: data-scientist`, `domain: "ml pipeline ownership"`, model_tier `sonnet`, a non-empty `tools_allow`, empty `gh_allow`, the three required `locked_phrases`, and the four `##` sections in canonical order): drive `/crew:hire`'s `add data-scientist` path via the existing `runHireFlow` helper (extended in Task 7.3). Assert (i) `readCustomRole` is invoked exactly once with `{ targetRepoRoot: TMP_C, role: "data-scientist" }` and returns a `CatalogueRole`-shaped value, (ii) `instantiatePersona` is then invoked exactly once with `{ targetRepoRoot: TMP_C, role: "data-scientist" }`, (iii) `<TMP_C>/team/data-scientist/PERSONA.md` exists and parses via `parsePersonaFile`, (iv) the persona's `Prompt` body equals the custom file's `Prompt` body byte-for-byte (cross-checked by re-parsing both and comparing `sections.Prompt`), (v) the harness's confirmation line is `Hired: data-scientist (custom) → <TMP_C>/team/data-scientist/PERSONA.md`. Then drive a second `add data-scientist` call and assert `PersonaAlreadyExistsError` surfaces as `Already hired: data-scientist (no change).` (Story 2.4 AC3 idempotency).
- **(d) Custom-role parse failure** (`<TMP_D>` with a malformed `<TMP_D>/team/custom/broken.md` missing the `## Out of mandate` section): drive `runHireFlow({ response: "add broken" })`. Assert `readCustomRole` is invoked, throws `CatalogueShapeError`, the skill emits the literal `Custom role file at <TMP_D>/team/custom/broken.md failed validation: ...` line, `instantiatePersona` is NOT called, and the harness re-prompts.
- **(e) Permission allowlist:** `loadRolePermissions({ pluginRoot, role: "hiring-manager" }).tools_allow.sort()` equals `["heartbeat", "instantiatePersona", "lookupRoleByDomain", "readCatalogue", "readCustomRole", "readPersona", "readRepoSignals"].sort()` — seven entries. The Story 2.2 parity test (`permissions-catalogue-parity.test.ts`) still passes (parity is on `gh_allow`, not `tools_allow`).
- **(f) Skip-hiring skill self-consistency:** read `plugins/crew/skills/skip-hiring/SKILL.md`. Assert (i) the YAML frontmatter parses and `name === "crew:skip-hiring"`, (ii) `allowed_tools` is exactly `["Read"]` (NO `Task` — the fast path does NOT spawn a subagent), (iii) the body contains the section headers `# What this skill does`, `# Prerequisites`, `# Steps`, `# Failure modes` in that order, (iv) the body references `/crew:skip-hiring` at least once, (v) the body references `/crew:hire` (cross-link to the interactive path) at least once.

Any failure surfaces a diagnostic naming the failing AC, the fixture, the offending role / file path, the verbatim expected string vs the actual string (for AC2 / AC(b)), and the Zod issue (for AC3 / AC(d)).

**AC5 (user-surface):**
**Given** the updated `plugins/crew/catalogue/hiring-manager.md` § Prompt section,
**When** the file is re-read after this story's Task 0 edit,
**Then** the `## Prompt` section contains a new subsection (heading `### Role-invention prohibition — absolute, not advisory`) that states the contract in absolute language using at least the modal verbs `MUST NOT` and `NEVER` — specifically including the literal sentences `You MUST NOT propose, draft, or instantiate a role whose id is not present in the v1 catalogue at <plugins>/catalogue/<role>.md AND not present at <target-repo>/team/custom/<role>.md.` and `When asked to invent a role inline (e.g. "create a data-scientist role for me"), you MUST refuse with the verbatim refusal string below. NEVER paraphrase, soften, or expand it.`, followed by a fenced block containing the verbatim AC2 refusal string. The subsection also instructs the subagent to (i) list every entry under `<target-repo>/team/custom/` whose `.md` filename matches `[a-z0-9-]+\.md` and whose `readCustomRole` call returns a parsed `CatalogueRole` AS PART OF the fresh-hire proposal block AND the re-entry block (with the `(custom)` suffix per AC3), and (ii) when the operator's `add <role>` response names a role id, try `readCatalogue` first and `readCustomRole` second before declaring the id unknown. Story 2.4's verbatim operator-facing strings (the proposal-end CTA, the re-entry CTA, and the terminal handoff signal) are PRESERVED byte-for-byte — this story's edit is strictly additive.
<!-- user-surface: AC5 covers content the LLM-driven hiring-manager subagent will then emit to the operator's screen during `/crew:hire`. The catalogue file itself is plugin-shipped (not operator-typed or operator-opened), but its content materialises as the refusal string the operator reads via rubric (iv) "any Claude Code UI element the user is expected to observe". The Story 1.8 lesson is the rationale: hard-pin behavioural contracts in absolute language or the LLM treats them as advisory. -->

---

## Tasks / Subtasks

- [ ] **Task 0 — Extend `plugins/crew/catalogue/hiring-manager.md` § Prompt with the role-invention prohibition and custom-role discovery instructions (AC: 2, 3, 4, 5)**
  - [ ] 0.1 Open `plugins/crew/catalogue/hiring-manager.md`. Do NOT touch the YAML frontmatter, `## Domain`, `## Mandate`, or `## Out of mandate` sections. Only the `## Prompt` section is in scope. The Story 2.4 additions (proposal CTA, re-entry CTA, terminal handoff signal) are PRESERVED byte-for-byte — this edit is strictly additive.
  - [ ] 0.2 Append a new subsection at the end of `## Prompt` with heading `### Role-invention prohibition — absolute, not advisory`. Body (verbatim):
    ```
    You MUST NOT propose, draft, or instantiate a role whose id is not present in the v1 catalogue at <plugins>/catalogue/<role>.md AND not present at <target-repo>/team/custom/<role>.md.

    When asked to invent a role inline (e.g. "create a data-scientist role for me"), you MUST refuse with the verbatim refusal string below. NEVER paraphrase, soften, or expand it.

    ```
    I cannot invent roles outside the v1 catalogue. The catalogue is fixed; the manual escape hatch is to author <target-repo>/team/custom/<role>.md matching the catalogue file shape (see plugins/crew/catalogue/planner.md for the canonical example), then re-run /crew:hire.
    ```
    ```
    The refusal string MUST appear inside a fenced code block in the catalogue (so it survives Markdown rendering byte-for-byte) AND the surrounding prose MUST use the modal verbs `MUST NOT` and `NEVER` as written. The Story 1.8 lesson (PR #76 "Process observation") is that LLM-driven user surfaces treat advisory copy as suggestion; the absolute modals are load-bearing, not stylistic.
  - [ ] 0.3 Append a second new subsection `### Custom-role discovery — every run, both modes`. Body (verbatim):
    ```
    Before emitting any proposal block (fresh-hire) or re-entry block, list `<target-repo>/team/custom/` (if it exists). For each `.md` file whose basename matches `[a-z0-9-]+\.md`, call `readCustomRole({ targetRepoRoot, role: <basename without .md> })`. On a successful parse, treat the result as if it were a catalogue role for the purposes of:

      - The fresh-hire proposal block: list the custom role with a `(custom)` suffix on its proposal line, e.g. `data-scientist (custom) — owns the ML pipeline so generalist-dev does not have to learn pandas`. The one-sentence justification MUST still be grounded in `RepoSignals` (FR86); do not hire a custom role with no observable signal.
      - The re-entry block's `hire one more <role>` action: accept the custom role id the same way you accept a catalogue role id.
      - The operator's `add <role>` response: try `readCatalogue` first; on `CatalogueRoleNotFoundError`, try `readCustomRole`; only declare the id unknown if BOTH fail.

    On a parse failure from `readCustomRole` (`CatalogueShapeError`), surface the file path and the error message verbatim to the operator and re-prompt — do not silently skip the file.
    ```
  - [ ] 0.4 Re-run the Story 2.1 catalogue-shape test (`plugins/crew/mcp-server/tests/catalogue-shape.test.ts`). It asserts the four required `##` section headers in canonical order and tolerates additional content inside `## Prompt`. The new `###` subsections do not introduce new `##` headers, so the test passes. If it fails, the edit accidentally introduced an `##` header — revert and re-apply at `###` depth.
  - [ ] 0.5 Re-run `plugins/crew/mcp-server/tests/persona-machinery.test.ts` (Story 2.3) — it reads the catalogue body as opaque text, unaffected.
  - [ ] 0.6 Re-run `plugins/crew/mcp-server/tests/hire-skill.test.ts` (Story 2.4) — Task 0 of Story 2.4 added three verbatim strings to the same `## Prompt`; assert all three are still present byte-for-byte after this story's edit (the dev agent should `grep` the file for them post-edit before moving on).

- [ ] **Task 1 — Author `readCustomRole` MCP tool (AC: 3, 4)**
  - [ ] 1.1 Create `plugins/crew/mcp-server/src/tools/read-custom-role.ts`. New file. Function signature: `async function readCustomRole(opts: { targetRepoRoot: string; role: string }): Promise<CatalogueRole>`. Mirror the shape of `read-catalogue.ts` (Story 2.3) — single-file IO, ENOENT → `CatalogueRoleNotFoundError`, otherwise parse via `parseCatalogueRole` and return.
  - [ ] 1.2 File path: `<opts.targetRepoRoot>/team/custom/<opts.role>.md`. Build with `path.join`; do not assume separators. Validate `opts.role` against the same kebab-case regex used by `CatalogueRoleSchema.role` (`/^[a-z0-9-]+$/`) before opening the file — reject path-traversal attempts (`role: "../planner"`) at the function boundary.
  - [ ] 1.3 On ENOENT throw `CatalogueRoleNotFoundError({ role, cataloguePath: customPath })` — REUSE the existing error class (no new error class per § "What this story does NOT" (l)). The caller (the hiring-manager subagent flow) catches it and falls through to the "unknown role id" branch.
  - [ ] 1.4 On any other IO error, propagate (matches `read-catalogue.ts`'s contract; structural / permission errors are programming bugs, not "no signal").
  - [ ] 1.5 On a successful read, parse via `parseCatalogueRole(raw, customPath)`. On `CatalogueShapeError`, let it propagate — the caller surfaces it verbatim per AC3 / AC4(d).
  - [ ] 1.6 No telemetry emit (matches `read-catalogue.ts` — synchronous read, NFR21).
  - [ ] 1.7 Stamp `sourcePath` on the returned `CatalogueRole` (matches `parseCatalogueRole`'s contract — `sourcePath` is added at parse time).
  - [ ] 1.8 The returned `CatalogueRole.role` field MUST equal `opts.role`. Add a final assertion: `if (parsed.role !== opts.role) throw new CatalogueShapeError({ sourcePath: customPath, zodMessage: "frontmatter role '<parsed.role>' does not match filename '<opts.role>'" })`. This catches the case where an operator copies a catalogue file into `team/custom/`, renames the filename, but forgets to update the frontmatter `role:` line.

- [ ] **Task 2 — Co-locate unit tests for `readCustomRole` (AC: 3, 4)**
  - [ ] 2.1 Create `plugins/crew/mcp-server/tests/read-custom-role.test.ts`. New file. Pattern after `persona-machinery.test.ts`'s `instantiatePersona` sub-suite for the temp-dir target-repo idiom.
  - [ ] 2.2 Cases: (a) absent file → `CatalogueRoleNotFoundError`; (b) malformed file (missing `## Out of mandate`) → `CatalogueShapeError` whose message names the source path; (c) valid file → returns a `CatalogueRole` whose `sections.Prompt` equals the input's `## Prompt` body byte-for-byte; (d) `role: "../planner"` → throws (regex rejection at the function boundary); (e) filename `data-scientist.md` whose frontmatter `role:` is `kubernetes-expert` → throws `CatalogueShapeError` with the "filename mismatch" diagnostic from Task 1.8.

- [ ] **Task 3 — Wire `readCustomRole` into the MCP dispatcher (AC: 3, 4)**
  - [ ] 3.1 Edit `plugins/crew/mcp-server/src/tools/register.ts`. Append one `server.registerTool({...})` call after the Story 2.4 `readRepoSignals` registration. Tool definition:
    - `name`: `"readCustomRole"` (camelCase verb-noun per implementation-patterns-consistency-rules §4; `read` prefix marks it as a reader, matching `readCatalogue` / `readPersona`).
    - `description`: `"Read an operator-authored custom role file from <target-repo>/team/custom/<role>.md and return its parsed CatalogueRole. Used by /hire to support the FR92 manual escape hatch."`
    - `inputSchema`: `{ type: "object", properties: { targetRepoRoot: { type: "string" }, role: { type: "string" } }, required: ["targetRepoRoot", "role"] }`.
    - `handler`: thin wrapper — parse args with `z.object({ targetRepoRoot: z.string().min(1), role: z.string().min(1) })`, call `readCustomRole(...)`, return `{ content: [{ type: "text", text: JSON.stringify(result) }] }`.
  - [ ] 3.2 Do NOT reorder existing tool registrations. Append only. Story 1.7's `acceptance.test.ts` AC3 invariant ("bare `createServer()` registers zero tools") is preserved — `registerAllTools` is the only mutator and we only add to it.

- [ ] **Task 4 — Update `permissions/hiring-manager.yaml` (AC: 3, 4)**
  - [ ] 4.1 Open `plugins/crew/permissions/hiring-manager.yaml`. Current `tools_allow` after Story 2.4: `[heartbeat, readCatalogue, instantiatePersona, readPersona, lookupRoleByDomain, readRepoSignals]` (six entries).
  - [ ] 4.2 Add `readCustomRole`. Final list (alphabetical or as-appended — match the existing file's convention): seven entries, with `readCustomRole` present.
  - [ ] 4.3 Leave `gh_allow` and `gh_allow_args` unchanged — neither `/crew:hire` nor `/crew:skip-hiring` calls `gh`.
  - [ ] 4.4 No changes to any other role's permission YAML. `readCustomRole` is hiring-manager-only in v1 (Story 2.6's `/crew:team` will list custom-role personas via `readPersona`, not via `readCustomRole`).
  - [ ] 4.5 The Story 2.2 parity test (`permissions-catalogue-parity.test.ts`) asserts `gh_allow` parity, not `tools_allow`. Adding an MCP tool name does NOT break it. Verify by running `pnpm --dir plugins/crew test` after the YAML edit.

- [ ] **Task 5 — Author `plugins/crew/skills/skip-hiring/SKILL.md` (AC: 1, 4)**
  - [ ] 5.1 Create the directory `plugins/crew/skills/skip-hiring/` and file `plugins/crew/skills/skip-hiring/SKILL.md`. Match the directory shape used by `plugins/crew/skills/hire/SKILL.md` (Story 2.4) and `plugins/crew/skills/status/SKILL.md` (Story 1.7). The slash command surfaces as `/crew:skip-hiring` per implementation-patterns-consistency-rules §8.
  - [ ] 5.2 Frontmatter (verbatim):
    ```yaml
    ---
    name: crew:skip-hiring
    description: Hire the default five-role roster directly — no interactive proposal.
    allowed_tools: [Read]
    ---
    ```
    - `allowed_tools` is `[Read]` — NO `Task`. The fast path does NOT spawn a subagent; it calls `instantiatePersona` for the five default-roster roles directly. The skill body's only reads are the persona-file existence checks via the MCP `readPersona` tool (which the MCP dispatcher enforces, not Claude Code's `allowed_tools`); the operator-facing surface is print-only.
  - [ ] 5.3 Body sections per implementation-patterns-consistency-rules §8: `# What this skill does`, `# Prerequisites`, `# Steps`, `# Failure modes`.
  - [ ] 5.4 The `# Steps` section drives the fast-path flow (no subagent):
    1. **Identify the target repo root.** Use the current Claude Code workspace root as `targetRepoRoot`. Do NOT call `getStatus` from inside this skill (same rationale as `/crew:hire` per Story 2.4 — fresh repos may not have `.crew/config.yaml` yet; the skill is explicitly designed to run on a fresh repo).
    2. **Refuse if a roster already exists.** List `<targetRepoRoot>/team/` (excluding `custom/` and `_archived/`). If ANY subdirectory contains `PERSONA.md`, print the literal `Team already hired. Run /crew:hire to add more roles, or /crew:team to view the current roster.` and exit cleanly (exit code 0 — not a failure). This is the symmetric guard to Story 2.4's re-entry-mode detection; without it, `/crew:skip-hiring` against an already-hired team would fail noisily on the first `PersonaAlreadyExistsError`.
    3. **Hire the default roster.** For each role in `["planner", "generalist-dev", "generalist-reviewer", "retro-analyst", "orchestrator"]` IN THAT EXACT ORDER, call `instantiatePersona({ targetRepoRoot, role })`. On success, print `Hired: <role> → <result.path>`. On `PersonaAlreadyExistsError` (shouldn't happen after step 2's guard, but defend in depth), print `Already hired: <role> (no change).` and continue. On any other error, surface verbatim and exit non-zero.
    4. **Terminal line.** After all five `instantiatePersona` calls complete, print `Default roster hired (5 roles). Run /crew:team to view, or /crew:hire to add more.` and exit cleanly.
  - [ ] 5.5 The `# Failure modes` section names:
    - **Workspace not resolved:** unlike `/crew:hire`, `/crew:skip-hiring` does NOT call `getStatus`, so adapter-resolution errors are not in the failure surface. The MCP tools the skill calls (`readPersona`, `instantiatePersona`) take `targetRepoRoot` directly and do not require `.crew/config.yaml`.
    - **`instantiatePersona` refuses with `PersonaAlreadyExistsError`:** handled per step 3 — print and continue.
    - **`instantiatePersona` refuses with `CatalogueRoleNotFoundError`:** plugin-install corruption (one of the five default roster catalogue files is missing). Surface verbatim and exit non-zero. The dev agent should re-install the plugin.
    - **Team already hired (step 2 guard tripped):** prints the cross-reference line and exits cleanly. Not a failure.
  - [ ] 5.6 **Do NOT** spawn a subagent. **Do NOT** call `readRepoSignals` (the fast path is by-definition signal-blind — it hires the default roster regardless of repo shape). **Do NOT** propose specialists (the fast path is by-definition default-only). All five behaviours that distinguish the fast path from `/crew:hire` are baked into the skill body, not the catalogue. There is no hiring-manager subagent in this skill.
  - [ ] 5.7 Cross-link `/crew:hire` in `# What this skill does` so an operator who actually wants the interactive flow knows where to go: `If you want a project-shaped team with specialist additions justified by your repo, use /crew:hire instead. /crew:skip-hiring is the "I just want to try it" path.`

- [ ] **Task 6 — Extend `plugins/crew/skills/hire/SKILL.md` for the custom-role path (AC: 2, 3, 4)**
  - [ ] 6.1 Open `plugins/crew/skills/hire/SKILL.md`. Story 2.4 shipped this file; this story extends it minimally.
  - [ ] 6.2 In the `# Steps` section step 2 ("Detect existing roster"), append a sentence: `Additionally, list <targetRepoRoot>/team/custom/ if it exists; for each <role-id>.md file, call readCustomRole({ targetRepoRoot, role: <role-id> }) and pass the resulting CatalogueRole list to the subagent in the <initial-context> block under a new <custom-roles> child element. The subagent uses this list per the catalogue's "Custom-role discovery" subsection (Task 0.3) — both to surface custom roles in proposal / re-entry blocks AND to know which add <role> responses to resolve via readCustomRole vs readCatalogue.`
  - [ ] 6.3 In the `# Steps` section step 4 ("Spawn the hiring-manager subagent"), update the `<initial-context>` block illustration to include `<custom-roles>...JSON.stringify(customRoles) (array of CatalogueRole, possibly empty)...</custom-roles>`.
  - [ ] 6.4 In the `# Failure modes` section, append: `Custom-role file fails validation: readCustomRole throws CatalogueShapeError. The skill surfaces the diagnostic per AC3 (verbatim "Custom role file at <path> failed validation: <message>"). The operator fixes the file and re-runs /crew:hire. Not a skill-level failure.`
  - [ ] 6.5 Do NOT change the frontmatter (`name`, `description`, `allowed_tools`). `allowed_tools` stays `[Read, Task]`.
  - [ ] 6.6 Do NOT rewrite the `# What this skill does`, `# Prerequisites`, or the unchanged portions of `# Steps` / `# Failure modes`. This is a surgical extension.
  - [ ] 6.7 Re-run `plugins/crew/mcp-server/tests/hire-skill.test.ts` Task 7.10's self-consistency block (which asserts frontmatter + body section headers). The headers and frontmatter are unchanged; the test passes.

- [ ] **Task 7 — Integration test `skip-hiring-and-custom-role.test.ts` (AC: 1, 2, 3, 4)**
  - [ ] 7.1 Create `plugins/crew/mcp-server/tests/skip-hiring-and-custom-role.test.ts`. New file. Pattern after `plugins/crew/mcp-server/tests/hire-skill.test.ts` (Story 2.4) for the temp-dir target-repo idiom, the in-process subagent stub helper, and the persona-file round-trip helpers.
  - [ ] 7.2 Like Story 2.4's harness, this test CANNOT invoke real Claude Code, real `Task` spawns, or a real LLM. It tests **tool orchestration and catalogue copy**, not LLM behaviour. The role-invention refusal AC (AC2 / fixture (b)) is asserted by reading the catalogue prompt body via `readCatalogue({ role: "hiring-manager" })` and grepping for the verbatim refusal string — the contract is "the string is present in the prompt the subagent is spawned with," not "the live subagent emits the string." The live-LLM verification is the operator-paste-output evidence the pre-PR smoke gate ingests (Story 1.8).
  - [ ] 7.3 **`runSkipHiringFlow` test helper** (Task 5's orchestration). Define a `runSkipHiringFlow(opts: { targetRepoRoot: string }): Promise<{ confirmations: string[]; instantiateCalls: string[]; subagentSpawns: number }>` helper. The helper simulates the skill's body: lists `team/`, refuses-if-hired, then calls `instantiatePersona` for the five default-roster roles. `subagentSpawns` is incremented by zero in this flow (the fast path never spawns) — the assertion is that it ENDS at zero.
  - [ ] 7.4 **`runCustomRoleAddFlow` test helper** (Task 6's extension). Either extend Story 2.4's existing `runHireFlow` helper to also call `readCustomRole` on `add <role>` after `readCatalogue` returns `CatalogueRoleNotFoundError`, OR define a sibling `runCustomRoleAddFlow` that wraps the same logic specifically for the AC3 / AC(c) / AC(d) paths. Author's discretion; the contract is that the test asserts the `readCatalogue` → `readCustomRole` → `instantiatePersona` (or refuse) sequence by spying on the three module exports with `vi.spyOn`.
  - [ ] 7.5 **AC1 / AC4(a) — skip-hiring fast path.** Create `<TMP_A>` via `fs.mkdtemp("crew-skip-A-")`. Pre-seed `.crew/config.yaml` (reuse the `workspace-resolver.test.ts` minimal pattern). Do NOT pre-seed `team/`. Call `runSkipHiringFlow({ targetRepoRoot: TMP_A })`. Assert:
    - Five persona files exist under `<TMP_A>/team/{planner,generalist-dev,generalist-reviewer,retro-analyst,orchestrator}/PERSONA.md`.
    - Each parses cleanly via `parsePersonaFile`.
    - No specialist persona exists.
    - `instantiateCalls.length === 5` and `instantiateCalls` in the exact default-roster order.
    - `subagentSpawns === 0`.
    - `confirmations` contains the five `Hired: <role> → <abs-path>` lines in order, followed by `Default roster hired (5 roles). Run /crew:team to view, or /crew:hire to add more.`.
  - [ ] 7.6 **AC4(a) — already-hired guard.** Re-run `runSkipHiringFlow({ targetRepoRoot: TMP_A })` against the same fixture. Assert `instantiateCalls.length === 0`, no new persona files are written, `subagentSpawns === 0`, and `confirmations` contains the literal `Team already hired. Run /crew:hire to add more roles, or /crew:team to view the current roster.`.
  - [ ] 7.7 **AC2 / AC4(b) — role-invention refusal.** Create `<TMP_B>` and pre-seed it as a five-default-roster hired team using Story 2.4's `instantiatePersona`-in-`beforeEach` pattern. Call `readCatalogue({ role: "hiring-manager" })` (via `readCatalogue` direct, not the MCP wire) and assert the catalogue `sections.Prompt` body contains the verbatim AC2 refusal string `I cannot invent roles outside the v1 catalogue. The catalogue is fixed; the manual escape hatch is to author <target-repo>/team/custom/<role>.md matching the catalogue file shape (see plugins/crew/catalogue/planner.md for the canonical example), then re-run /crew:hire.` — byte-for-byte match using `string.includes(...)`. Also assert the catalogue `sections.Prompt` body contains the literal substrings `MUST NOT` and `NEVER paraphrase` (the Story 1.8 hard-pin). Then drive the in-process harness with `add kubernetes-expert`:
    - Assert `readCatalogue({ role: "kubernetes-expert" })` throws `CatalogueRoleNotFoundError`.
    - Assert `readCustomRole({ targetRepoRoot: TMP_B, role: "kubernetes-expert" })` throws `CatalogueRoleNotFoundError`.
    - Assert `instantiatePersona` is NOT called for `kubernetes-expert` (`vi.spyOn` on the module export, assert `calls.find(c => c[0].role === "kubernetes-expert") === undefined`).
    - Assert the harness's emitted reply (the simulated subagent reply, drawn from the catalogue prompt verbatim — see 7.2) contains the AC2 refusal string AND the re-entry prompt line `Hire one more (specify catalogue role id), unhire <role>, view-persona <role>, or done.`.
  - [ ] 7.8 **AC3 / AC4(c) — custom-role acceptance.** Create `<TMP_C>` with `.crew/config.yaml`. Pre-seed `<TMP_C>/team/custom/data-scientist.md` with a hand-authored valid catalogue-shaped file. Suggested contents (the dev agent may adapt — the contract is "valid against `CatalogueRoleSchema` and `assertCatalogueBodySections`"):
    ```markdown
    ---
    role: data-scientist
    domain: "ml pipeline ownership"
    model_tier: sonnet
    tools_allow:
      - Read
      - Edit
      - Bash
    gh_allow: []
    locked_phrases:
      handoff: "Handoff to <next role> — <intent>"
      yield: "This sits in <role>'s domain — handing off"
      verdict: "**Verdict: <SENTINEL>**"
    ---

    # Data scientist

    ## Domain

    Owns the ML pipeline so generalist-dev does not have to learn pandas.

    ## Mandate

    - Author training scripts, model evaluation, and inference glue.
    - Surface dataset shape changes to the planner before the dev loop wakes.

    ## Out of mandate

    - Production deploys (orchestrator owns).
    - Reviewing non-ML code (generalist-reviewer owns).

    ## Prompt

    You are the data scientist. Read the dataset, propose the model, train it, evaluate, write the inference glue. Stay terse.
    ```
    Drive `runCustomRoleAddFlow({ targetRepoRoot: TMP_C, response: "add data-scientist" })`. Assert:
    - `readCustomRole` is called exactly once with `{ targetRepoRoot: TMP_C, role: "data-scientist" }` and returns a `CatalogueRole`-shaped value whose `role === "data-scientist"`.
    - `instantiatePersona` is called exactly once with `{ targetRepoRoot: TMP_C, role: "data-scientist" }`.
    - `<TMP_C>/team/data-scientist/PERSONA.md` exists (NOT under `team/custom/data-scientist/PERSONA.md` — the persona lives at the catalogue-role path).
    - The persona parses via `parsePersonaFile`.
    - The persona's `sections.Prompt` equals the custom file's `sections.Prompt` byte-for-byte (cross-checked by re-parsing both files with `parseCatalogueRole` / `parsePersonaFile` and comparing).
    - The harness's emitted confirmation line is `Hired: data-scientist (custom) → <TMP_C>/team/data-scientist/PERSONA.md`.
    Then drive a second `runCustomRoleAddFlow({ targetRepoRoot: TMP_C, response: "add data-scientist" })`. Assert `PersonaAlreadyExistsError` surfaces as `Already hired: data-scientist (no change).`.
  - [ ] 7.9 **AC3 / AC4(d) — custom-role parse failure.** Create `<TMP_D>` with `.crew/config.yaml` and a malformed `<TMP_D>/team/custom/broken.md` (suggested malformation: omit the entire `## Out of mandate` section so `assertCatalogueBodySections` throws `CatalogueShapeError`). Drive `runCustomRoleAddFlow({ targetRepoRoot: TMP_D, response: "add broken" })`. Assert:
    - `readCustomRole` is called, throws `CatalogueShapeError` whose message names the file path.
    - The harness emits the literal `Custom role file at <TMP_D>/team/custom/broken.md failed validation: <message>` line (where `<message>` is the Zod / shape diagnostic).
    - `instantiatePersona` is NOT called.
    - No persona file exists under `<TMP_D>/team/broken/`.
  - [ ] 7.10 **AC4(e) — permission allowlist.** Load `permissions/hiring-manager.yaml` via `loadRolePermissions({ pluginRoot: getPluginRoot(), role: "hiring-manager" })`. Assert `tools_allow.sort()` equals `["heartbeat","instantiatePersona","lookupRoleByDomain","readCatalogue","readCustomRole","readPersona","readRepoSignals"].sort()` — seven entries.
  - [ ] 7.11 **AC4(f) — skip-hiring skill self-consistency.** Read `plugins/crew/skills/skip-hiring/SKILL.md` from disk. Assert:
    - YAML frontmatter parses and `name === "crew:skip-hiring"`.
    - `allowed_tools` is exactly `["Read"]` (NO `Task`).
    - Body contains `# What this skill does`, `# Prerequisites`, `# Steps`, `# Failure modes` in that order.
    - Body references `/crew:skip-hiring` at least once.
    - Body references `/crew:hire` at least once (cross-link).
  - [ ] 7.12 **Hiring-manager catalogue post-edit self-consistency.** Read `plugins/crew/catalogue/hiring-manager.md` via `readCatalogue({ role: "hiring-manager" })`. Assert all THREE Story 2.4 verbatim strings are still present byte-for-byte in `sections.Prompt`:
    - `Approve all, approve a subset (list role ids), decline, or request a specific catalogue role.`
    - `Hire one more (specify catalogue role id), unhire <role>, view-persona <role>, or done.`
    - `Handoff to planner — team hired, ready to plan`
    Plus the new Story 2.5 strings:
    - The AC2 refusal string (verbatim).
    - The substrings `MUST NOT` and `NEVER paraphrase`.
    - The subsection heading `### Role-invention prohibition — absolute, not advisory`.
    - The subsection heading `### Custom-role discovery — every run, both modes`.
  - [ ] 7.13 **End-to-end via MCP** (mirror Story 1.7 / Story 2.4's `acceptance` pattern). Create a `createServer()`, call `registerAllTools(server)`, connect in-memory, assert `ListTools` includes `{ name: "readCustomRole" }` alongside all six prior tools (seven total: `getStatus`, `readCatalogue`, `instantiatePersona`, `readPersona`, `lookupRoleByDomain`, `readRepoSignals`, `readCustomRole`). Call `readCustomRole` with `{ targetRepoRoot: TMP_C, role: "data-scientist" }` and assert the returned JSON parses against the catalogue role shape with `role === "data-scientist"`.
  - [ ] 7.14 No skips, no `.only`, no `.todo`. Diagnostics on failure name the failing AC, the fixture, the offending role / file path, the verbatim expected string vs the actual string (for AC2 / AC(b) / AC(c) / AC(d)), and the Zod issue.
  - [ ] 7.15 Test file header MUST cite this story (`Story 2.5 AC1–AC5`) and reference `plugins/crew/docs/user-surface-acs.md`, mirroring `catalogue-shape.test.ts`, `persona-machinery.test.ts`, `hire-skill.test.ts`.

- [ ] **Task 8 — Extend `hire-skill.test.ts` for the custom-role discovery path (AC: 3, 4)**
  - [ ] 8.1 Open `plugins/crew/mcp-server/tests/hire-skill.test.ts` (Story 2.4). Add a new `describe` block: `"custom-role discovery (Story 2.5 extension)"`. Do NOT modify Story 2.4's existing assertions; this is strictly additive.
  - [ ] 8.2 Create a fourth fixture `<TMP_E>` with `.crew/config.yaml`, no `team/<role>/PERSONA.md`, but a valid `<TMP_E>/team/custom/data-scientist.md` (reuse the contents from Task 7.8 — extract to a shared `tests/fixtures/custom-role-data-scientist.md` if convenient).
  - [ ] 8.3 Drive `runHireFlow({ targetRepoRoot: TMP_E, response: "approve all" })`. Assert the harness's collected proposal block contains a line whose text begins with `data-scientist (custom) — ` (the `(custom)` suffix per AC3 / Task 0.3). Assert that `approve all` does NOT silently include the custom role — the operator must explicitly approve it via `approve data-scientist` or `add data-scientist` (rationale: the fresh-hire `approve all` literal is contractually scoped to the proposed roster, but the custom-role inclusion in the proposal is a *suggestion* the operator can accept or ignore; the explicit-approval rule prevents `approve all` from quietly hiring custom roles the operator hasn't reviewed). Assert `instantiatePersona` is called exactly five times (the default roster) and NOT for `data-scientist`.
  - [ ] 8.4 Drive `runHireFlow({ targetRepoRoot: TMP_E, response: "approve planner generalist-dev generalist-reviewer retro-analyst orchestrator data-scientist" })`. Assert `instantiatePersona` is called exactly six times, including once for `data-scientist`, and that the call's `targetRepoRoot === TMP_E`.
  - [ ] 8.5 Verify Story 2.4's existing AC5(a) / AC5(b) / AC5(c) / AC5(d) / AC5(e) assertions still pass byte-for-byte. The custom-role discovery additions must not alter the fresh-empty fixture A or the already-hired fixture B behaviour. Run `pnpm --dir plugins/crew test` and verify the entire suite is green.

- [ ] **Task 9 — Build & dist verification (AC: 4)**
  - [ ] 9.1 Run `pnpm --dir plugins/crew/mcp-server build`. `tsc` must compile cleanly. New source file: `tools/read-custom-role.ts`. Modified: `tools/register.ts`. All under `src/`. Both produce `dist/` siblings.
  - [ ] 9.2 Per `plugins/crew/docs/README-install.md` § Build artefacts and Story 1.9's contract, the built `mcp-server/dist/` tree is committed. **This story adds source under `src/`** — rebuild and commit `dist/` in the same commit as `src/`. `ci-drift-check.test.ts` enforces alignment.
  - [ ] 9.3 The skill files (`plugins/crew/skills/skip-hiring/SKILL.md`, `plugins/crew/skills/hire/SKILL.md`), the catalogue file (`plugins/crew/catalogue/hiring-manager.md`), and the permission YAML (`plugins/crew/permissions/hiring-manager.yaml`) are static assets shipped as-is via `/plugin install`'s file-copy semantics. No bundling step.
  - [ ] 9.4 Verify the existing Story 1.7 self-consistency test (`get-status.test.ts` AC4f, README-install.md six-checkpoint assertion) still passes — this story does NOT modify `README-install.md`.

- [ ] **Task 10 — Verify no other story's contract drifted (AC: 1–5)**
  - [ ] 10.1 Confirm `plugins/crew/mcp-server/src/schemas/{catalogue,persona,role-permissions,status-report,repo-signals}.ts` are unchanged.
  - [ ] 10.2 Confirm `plugins/crew/mcp-server/src/tools/{read-catalogue,instantiate-persona,read-persona,lookup-role-by-domain,read-repo-signals,get-status}.ts` are unchanged. This story consumes them; it does not modify them.
  - [ ] 10.3 Confirm `plugins/crew/mcp-server/src/lib/{managed-fs,markdown-frontmatter,persona-file,plugin-root,plugin-version,workspace-resolver,logger,gh,repo-signal-detectors}.ts` are unchanged.
  - [ ] 10.4 Confirm `plugins/crew/catalogue/*.md` is unchanged **except** `plugins/crew/catalogue/hiring-manager.md` § Prompt (which Task 0 extends). Diff `hiring-manager.md` against its post-Story-2.4 state: only the `## Prompt` body lines change (two new `###` subsections appended); frontmatter and other `##` sections are byte-identical. All other catalogue files (`planner.md`, `generalist-dev.md`, `generalist-reviewer.md`, `retro-analyst.md`, `orchestrator.md`, `security-specialist.md`, `test-specialist.md`, `docs-specialist.md`, `debugger.md`) are byte-identical.
  - [ ] 10.5 Confirm `plugins/crew/permissions/{orchestrator,planner,generalist-dev,generalist-reviewer,retro-analyst,security-specialist,test-specialist,docs-specialist,debugger,gh-error-map}.yaml` are unchanged. Only `hiring-manager.yaml` changes in this story.
  - [ ] 10.6 Confirm `plugins/crew/skills/status/SKILL.md` is unchanged.
  - [ ] 10.7 Confirm `plugins/crew/skills/hire/SKILL.md` changes are limited to the additions in Task 6 (step 2 sentence append, step 4 `<initial-context>` block extension, one new `# Failure modes` bullet). Frontmatter and section headers unchanged.
  - [ ] 10.8 Confirm `plugins/crew/docs/README-install.md` is unchanged. Epic 7 Story 7.2 will integrate `/crew:skip-hiring` and the custom-role escape hatch into the first-run-in-5-minutes walkthrough.
  - [ ] 10.9 Confirm root `README.md` is unchanged.
  - [ ] 10.10 Confirm `plugins/crew/mcp-server/tests/{catalogue-shape,permissions-catalogue-parity,permissions-enforcement,persona-machinery,get-status,acceptance,ci-drift-check,repo-signal-detectors,user-surface-convention,pre-pr-gate,dist-shipping,smoke,readme-install,standards-doc,telemetry-logger,validate-active-adapter,workspace-resolver,bmad-adapter,bmad-adapter-acceptance,canonical-fs-guard,manifest-state-machine,git-commit}.test.ts` are unchanged. Only `hire-skill.test.ts` is extended (Task 8), and `skip-hiring-and-custom-role.test.ts` / `read-custom-role.test.ts` are new.

---

## Dev Notes

### Critical context: what was shipped before, what this story builds on

- **Story 1.1** scaffolded `mcp-server/src/{schemas,state,tools,lib}/`. Convention: kebab-case filenames, `.ts` sources, co-located `*.test.ts`.
- **Story 1.4** shipped the MCP dispatcher and `_meta.role` permission enforcement. **The hiring-manager subagent's allowlist is enforced by this dispatcher** — `readCustomRole` MUST appear in `permissions/hiring-manager.yaml` (Task 4) or the subagent's calls will be refused.
- **Story 1.5** shipped `lib/logger.ts`. This story emits NO telemetry — `/crew:skip-hiring` and `readCustomRole` are one-shot operator surfaces / synchronous reads, not runtime agent events (NFR21).
- **Story 1.6** shipped `lib/managed-fs.ts` + `CANONICAL_PATH_GLOBS` (`team/**` line 20). `instantiatePersona` is the only writer this story invokes; managed-fs is already wired.
- **Story 1.7** shipped the skill-shape pattern (`skills/status/SKILL.md`), `getStatus`, `renderStatus`, and `tools/register.ts`. **This story extends `register.ts` by one entry (`readCustomRole`) and adds a sibling skill directory `skills/skip-hiring/SKILL.md`.** Story 1.7's `acceptance.test.ts` AC3 invariant — "bare `createServer()` registers zero tools" — is preserved (we only modify `registerAllTools`).
- **Story 1.8** introduced the `user-surface` AC tag and pre-PR smoke gate. **This story has FOUR `(user-surface)` ACs (AC1, AC2, AC3, AC5)**, naming `/crew:skip-hiring`, `/crew:hire`, the operator-authored file path `<target-repo>/team/custom/<role>.md`, and the catalogue-sourced refusal string the operator reads on screen. The pre-PR gate will require operator-paste-output or automated-e2e verification events covering each. The harness in Tasks 7 and 8 covers the deterministic tool-boundary assertions; operator paste-output is the expected verification route for the live `/crew:hire` refusal and the live `/crew:skip-hiring` happy path.
- **Story 1.8 lesson (PR #76 "Process observation").** For LLM-driven user surfaces, hard-pin behavioural contracts in absolute language in the catalogue prompt. The LLM will treat advisory copy as suggestion. AC5 and Task 0.2 / 0.3 are the direct embodiment of this lesson: the `### Role-invention prohibition — absolute, not advisory` heading is literal; the body uses `MUST NOT` and `NEVER`; the refusal string lives in a fenced block to survive Markdown rendering byte-for-byte. The integration test (Task 7.7) asserts the literal substrings `MUST NOT` and `NEVER paraphrase` are present — not a paraphrase, not a softening.
- **Story 1.9** committed `mcp-server/dist/`. **This story modifies `src/` — rebuild and commit `dist/` in the same change.** `ci-drift-check.test.ts` enforces alignment.
- **Story 2.1** shipped the catalogue and `CatalogueRoleSchema`. **The custom-role file is the same schema** (`CatalogueRoleSchema` + `REQUIRED_CATALOGUE_SECTIONS` + `assertCatalogueBodySections`). The escape hatch is intentionally "the same file shape, a different directory." No schema variant, no superset, no parallel parser.
- **Story 2.2** shipped `permissions/<role>.yaml`. This story modifies one file (`hiring-manager.yaml`) to add `readCustomRole`. The Story 2.2 parity test asserts `gh_allow` parity, not `tools_allow`.
- **Story 2.3** shipped `PersonaFileSchema`, `parsePersonaFile`, `renderPersonaFile`, and the four MCP tools (`readCatalogue`, `instantiatePersona`, `readPersona`, `lookupRoleByDomain`) plus four error classes (`CatalogueRoleNotFoundError`, `CatalogueShapeError`, `PersonaShapeError`, `PersonaAlreadyExistsError`). **`readCustomRole` reuses `parseCatalogueRole` and `CatalogueRoleNotFoundError` from Story 2.3 verbatim.** No new error class.
- **Story 2.4** shipped `/crew:hire`, `readRepoSignals`, the hiring-manager subagent flow, and the catalogue `## Prompt` extensions (proposal CTA, re-entry CTA, terminal handoff signal). **This story extends `/crew:hire`'s `# Steps` (custom-role discovery on every run) and extends the catalogue `## Prompt` (two new `###` subsections). Story 2.4's three verbatim strings are preserved byte-for-byte.** The Task 7.12 self-consistency assertion guards this.

### Architecture references (load these first, dev agent)

- `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` §4 (MCP Tool Naming) — `readCustomRole` is camelCase verb-noun, reader name starts with `read`. Compliant with the convention `readCatalogue` / `readPersona` set.
- `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` §8 (Skill File Shape) — pins frontmatter (`name`, `description`, `allowed_tools`) and the four required body sections. Both new skill (`skip-hiring/`) and extended skill (`hire/`) comply.
- `_bmad-output/planning-artifacts/architecture/project-structure-boundaries.md` — pins `skills/skip-hiring.md` at FR91 location. Shipped as `skills/skip-hiring/SKILL.md` per Story 1.7's directory pattern.
- `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md` FR91 (one-command default-roster path), FR92 (no role invention; manual escape hatch), FR88 (approve/decline/amend — extended to custom roles by this story).
- `_bmad-output/planning-artifacts/prd-crew-v1/non-functional-requirements.md` NFR12 (minimum-necessary tool surface — informs `/crew:skip-hiring`'s `allowed_tools: [Read]`), NFR21 (telemetry is for runtime agent events — `/crew:skip-hiring` and `readCustomRole` emit none), NFR25 (plain-Markdown persona readability — preserved by reusing Story 2.3's `instantiatePersona`).
- `plugins/crew/docs/user-surface-acs.md` — `(user-surface)` tag rubric (Story 1.8). AC1, AC2, AC3, AC5 are tagged; AC4 is not.
- `plugins/crew/catalogue/hiring-manager.md` — the catalogue prompt body to extend. Read carefully before Task 0.
- `plugins/crew/skills/hire/SKILL.md` — the Story 2.4 skill to extend in Task 6.
- `_bmad-output/implementation-artifacts/2-4-hiring-manager-agent-and-hire-skill.md` — the previous story spec. Tasks 6, 7, 8 lean on its patterns (helper signatures, fixture idioms, vi.spyOn discipline).

### Files this story creates (NEW)

- `plugins/crew/mcp-server/src/tools/read-custom-role.ts` — `readCustomRole` reader.
- `plugins/crew/mcp-server/tests/read-custom-role.test.ts` — unit tests for the reader.
- `plugins/crew/mcp-server/tests/skip-hiring-and-custom-role.test.ts` — integration harness for AC1–AC5.
- `plugins/crew/skills/skip-hiring/SKILL.md` — the operator-facing fast-path slash-command file.
- `plugins/crew/mcp-server/dist/**` — rebuild output. Commit per Story 1.9's contract.
- (Optional, author's discretion per Task 8.2) `plugins/crew/mcp-server/tests/fixtures/custom-role-data-scientist.md` — shared fixture file for the `data-scientist` custom-role test cases. Not required if the test files inline the contents.

### Files this story MAY modify (UPDATE, with care)

- `plugins/crew/mcp-server/src/tools/register.ts` — append one `server.registerTool({...})` call for `readCustomRole` after the Story 2.4 `readRepoSignals` entry. Do not refactor existing entries.
- `plugins/crew/permissions/hiring-manager.yaml` — expand `tools_allow` from six entries to seven (add `readCustomRole`). Leave `gh_allow` and `gh_allow_args` unchanged.
- `plugins/crew/catalogue/hiring-manager.md` — `## Prompt` section ONLY. Append the two new `###` subsections per Task 0. Frontmatter and other `##` sections unchanged. Story 2.4's three verbatim strings preserved byte-for-byte.
- `plugins/crew/skills/hire/SKILL.md` — surgical extension per Task 6 (step 2 append, step 4 `<initial-context>` extension, one new `# Failure modes` bullet). Frontmatter and section headers unchanged.
- `plugins/crew/mcp-server/tests/hire-skill.test.ts` — additive `describe` block per Task 8. Story 2.4's existing assertions preserved.

### Files this story MUST NOT modify

- `_bmad-output/implementation-artifacts/sprint-status.yaml` (orchestrator owns).
- `plugins/crew/catalogue/*.md` EXCEPT `plugins/crew/catalogue/hiring-manager.md` § Prompt. The frontmatter and other `##` sections of `hiring-manager.md` are also out of scope.
- `plugins/crew/mcp-server/src/schemas/{catalogue,persona,role-permissions,status-report,repo-signals,plugin-manifest}.ts`.
- `plugins/crew/mcp-server/src/tools/{read-catalogue,instantiate-persona,read-persona,lookup-role-by-domain,read-repo-signals,get-status}.ts`.
- `plugins/crew/mcp-server/src/lib/{managed-fs,markdown-frontmatter,persona-file,plugin-root,plugin-version,workspace-resolver,logger,gh,repo-signal-detectors}.ts`.
- `plugins/crew/mcp-server/src/errors.ts` — no new error classes; `readCustomRole` reuses `CatalogueRoleNotFoundError` and `CatalogueShapeError` from Story 2.3.
- `plugins/crew/permissions/{orchestrator,planner,generalist-dev,generalist-reviewer,retro-analyst,security-specialist,test-specialist,docs-specialist,debugger,gh-error-map}.yaml`.
- `plugins/crew/skills/status/SKILL.md`.
- `plugins/crew/docs/README-install.md` (Epic 7 Story 7.2 will integrate the new surfaces into the install walkthrough; v1's six-checkpoint install does not include hiring or skip-hiring).
- Root `README.md`.
- `plugins/crew/mcp-server/tests/{catalogue-shape,permissions-catalogue-parity,permissions-enforcement,persona-machinery,get-status,acceptance,ci-drift-check,repo-signal-detectors,user-surface-convention,pre-pr-gate,dist-shipping,smoke,readme-install,standards-doc,telemetry-logger,validate-active-adapter,workspace-resolver,bmad-adapter,bmad-adapter-acceptance,canonical-fs-guard,manifest-state-machine,git-commit}.test.ts` — existing suites pass as-is.

### Design rationale (load when in doubt)

- **Why a new MCP tool (`readCustomRole`) instead of extending `readCatalogue` with an optional `targetRepoRoot` parameter?** Two reasons. First, surgery surface: extending `readCatalogue`'s signature ripples into the dispatcher registration, the test fixtures, and any future caller; a new tool isolates the change. Second, intent legibility: the catalogue is plugin-shipped; the custom-role file is operator-authored. The two tools name the two semantic surfaces. The schema is shared (intentionally); the read path is not.
- **Why `[a-z0-9-]+` regex on custom-role basenames (Task 0.3, Task 1.2)?** Same kebab-case regex as `CatalogueRoleSchema.role`. Prevents path-traversal (`role: "../planner"`) at the function boundary and matches the visual convention operators have already seen in the shipped catalogue.
- **Why persona lands at `<target-repo>/team/<role-id>/PERSONA.md`, NOT `<target-repo>/team/custom/<role-id>/PERSONA.md`?** Because the persona is the *hired-team artifact* — the operator-authored custom-role file is the *source-of-roster definition*. Once hired, a custom role is a peer of a catalogue role for every downstream consumer (`/crew:team`, `/crew:ask`, the dev-loop). Routing hired custom-role personas through the `team/custom/` subdirectory would force every downstream consumer to learn a two-rooted listing protocol. Keeping them in `team/<role-id>/` keeps Story 2.6's `/crew:team` listing trivial (one `fs.readdir` filter, no `custom/` walk). The `(custom)` suffix in proposal lines and confirmation lines is the only operator-facing differentiation.
- **Why does `approve all` NOT silently approve discovered custom roles (Task 8.3)?** Because `approve all` is the operator's "I read the proposal and I want all of it" response. Custom roles are operator-authored — the operator already knows about them — but approving them in bulk via `approve all` would conflate "the hiring-manager's recommended set" with "everything I left on disk." The explicit-approval rule (operator must type `approve <role-ids>` or `add <role>` for custom roles) keeps the `approve all` semantics narrow and prevents accidental hires of half-finished custom-role drafts. The proposal block still SURFACES the custom role with the `(custom)` suffix — the operator sees it and can act on it; they just can't trip over it.
- **Why does `/crew:skip-hiring` use `allowed_tools: [Read]` and NOT `[Read, Task]`?** Because the fast path explicitly does NOT spawn a subagent (Task 5.6). The skill body iterates over a hard-coded five-role list and calls `instantiatePersona` directly. Granting `Task` would make the skill capable of spawning a subagent (NFR12: minimum-necessary surface); the absence is contractually meaningful. The AC4(f) test (Task 7.11) asserts `allowed_tools === ["Read"]` byte-for-byte.
- **Why is the role-invention refusal string hard-pinned in the catalogue (not in the skill body)?** Because the *speaker* of the refusal is the hiring-manager subagent (an LLM). The skill orchestrator passes the catalogue prompt to the subagent verbatim; the subagent's behaviour is shaped by what's in the catalogue. Putting the refusal in the skill body would put it in the orchestrator (which doesn't speak to the operator). Putting it in the catalogue puts it in the speaker's prompt. This is the same architecture decision as Story 2.4's three verbatim CTAs.
- **Why does Task 1.8 (filename ↔ frontmatter `role:` match) get its own assertion?** Because the most likely failure mode for an operator-authored custom-role file is "copied `planner.md` into `team/custom/data-scientist.md` and forgot to update the frontmatter." Without this assertion, `readCustomRole({ role: "data-scientist" })` would return a `CatalogueRole` with `role === "planner"`, the skill would call `instantiatePersona({ role: "data-scientist" })` (which uses the *function-call* role, not the *frontmatter* role), and the operator would end up with a `team/data-scientist/PERSONA.md` whose body is the planner's prompt. The assertion catches this at the read boundary with a clear diagnostic.

### Testing standards summary

- `vitest` v1.x, co-located `*.test.ts` files under `plugins/crew/mcp-server/tests/`. No `.only`, no `.todo`, no `.skip` (CI fails on these per existing convention).
- Temp-dir fixtures via `fs.mkdtemp` (Story 1.7 / Story 2.3 / Story 2.4 pattern). Clean up in `afterEach` via `fs.rm(..., { recursive: true, force: true })`.
- Module spies via `vi.spyOn(module, "exportName")`. Spy on `instantiatePersona`, `readCatalogue`, `readCustomRole`, `readRepoSignals` in the integration harness to assert call counts and arguments. Restore in `afterEach`.
- Verbatim-string assertions via `string.includes(...)` for substrings in larger blocks (catalogue prompt, harness output), `===` for whole-line confirmation strings.
- Test file headers cite the story and reference `plugins/crew/docs/user-surface-acs.md` per Story 2.4's discipline.

### Project Structure Notes

- New files conform to the existing layout: tools under `mcp-server/src/tools/`, tests co-located under `mcp-server/tests/`, skills under `skills/<name>/SKILL.md` (directory form, matching `hire/` and `status/`).
- No new top-level directories. No new `package.json` dependencies (the helper functions reuse `execa` indirectly via Story 2.4, but this story does not directly invoke it).
- The `plugins/crew/mcp-server/dist/` rebuild produces sibling files for `tools/read-custom-role.ts` and an updated `tools/register.js`. The dev agent MUST commit the dist diff in the same commit as the src diff (Story 1.9 contract; `ci-drift-check.test.ts` enforces).

### References

- [Source: `_bmad-output/planning-artifacts/epics/epic-2-team-formation-hiring-personas-and-team-observability.md` § Story 2.5]
- [Source: `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md` FR88, FR91, FR92]
- [Source: `_bmad-output/planning-artifacts/prd-crew-v1/non-functional-requirements.md` NFR12, NFR21, NFR25]
- [Source: `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` §4, §8]
- [Source: `_bmad-output/implementation-artifacts/2-4-hiring-manager-agent-and-hire-skill.md`]
- [Source: `_bmad-output/implementation-artifacts/2-3-persona-file-machinery-and-persona-mcp-tools.md`]
- [Source: `plugins/crew/docs/user-surface-acs.md`]
- [Source: `plugins/crew/catalogue/hiring-manager.md`]
- [Source: `plugins/crew/skills/hire/SKILL.md`]
- [Source: `plugins/crew/mcp-server/src/schemas/catalogue.ts`]
- [Source: `plugins/crew/mcp-server/src/tools/read-catalogue.ts`]
- [Source: `plugins/crew/mcp-server/src/tools/instantiate-persona.ts`]
- [Source: `plugins/crew/mcp-server/src/tools/register.ts`]
- [Source: `plugins/crew/permissions/hiring-manager.yaml`]
- [Source: Story 1.8 lesson — PR #76 "Process observation" comment]

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List
