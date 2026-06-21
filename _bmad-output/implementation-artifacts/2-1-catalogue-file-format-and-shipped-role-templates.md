# Story 2.1: Catalogue file format and shipped role templates

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin maintainer**,
I want **all 10 v1 catalogue role templates shipped at `plugins/crew/catalogue/<role>.md` in a single canonical shape**,
so that **the hiring manager (Story 2.4) has a fixed, validated roster to pick from, and downstream tools (persona instantiation in Story 2.3, permissions in Story 2.2, domain-routing in Epic 4) ground in a contract that the codebase actually enforces.**

### What this story is, in one sentence

Ship the 10 v1 catalogue role Markdown files at `plugins/crew/catalogue/<role>.md`, define and pin a `CatalogueRoleSchema` Zod schema for their frontmatter + required `##` sections, and add a vitest harness that parses every shipped catalogue file against the schema and asserts cross-file domain uniqueness — so that any future drift (a missing role, a typo in a section header, a duplicate domain string) fails CI before merge.

### What this story fixes (and why it needs its own story)

The architecture (`_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` §3) and PRD (FR82, FR83, FR98, FR99) both name the catalogue as the hiring-manager's source of truth and the routing-key authority. Until the files exist on disk in a validated shape:

- Story 2.2 (per-role permissions) has nothing to enumerate against.
- Story 2.3 (persona-file machinery) cannot read frontmatter or copy the prompt body verbatim.
- Story 2.4 (`/hire`) cannot list its roster.
- Epic 4's yield protocol (FR98–FR99 exact-match domain routing) has no domains to match against.

This story is the first concrete v1 user of the `CatalogueRoleSchema` and the canonical `domain:` registry. It is **spec + content + validation**, not behaviour — no agent invokes anything yet.

### This story does NOT

- (a) Touch `_bmad-output/implementation-artifacts/sprint-status.yaml` — the orchestrator owns status transitions.
- (b) Create persona files, `team/` directories, or `hired_at` / `catalogue_version` frontmatter (those are persona-only fields per architecture §3 and belong to Story 2.3).
- (c) Wire `read-catalogue`, `instantiate-persona`, `read-persona`, or `lookup-role-by-domain` MCP tools (Story 2.3).
- (d) Author `permissions/<role>.yaml` files or `gh-error-map.yaml` (Story 2.2).
- (e) Implement the hiring conversation, the `/crew:hire` skill, or any UI for proposing/approving roles (Stories 2.4–2.5).
- (f) Add `/crew:team` or `/crew:ask` skill files (Stories 2.6–2.7).
- (g) Author the **content** of each role's `# Prompt` body to be a finished, model-tuned production system prompt. v1 ships a credible first-pass prompt per role; later calibration (Epic 6 retros) tunes prompt content. **Schema and the section skeleton are load-bearing; prose inside `# Prompt` is iteratable.**
- (h) Modify any existing schema (`role-permissions.ts`, `telemetry-events.ts`, etc.) — `catalogue.ts` is a NEW schema file.
- (i) Add or modify any skill (`plugins/crew/skills/*.md`) — this story does not surface a slash command. The catalogue is read by Story 2.3+ tooling, not invoked directly by the operator.
- (j) Change the `tools_allow` / `gh_allow` enforcement layer scaffolded in Story 1.4. This story declares the *values* per role in catalogue frontmatter; Story 2.2 will mirror the `gh_allow` values into `permissions/<role>.yaml` and Story 1.4's dispatcher reads those, not the catalogue.

---

## Acceptance Criteria

> **Verbatim from epic.** ACs 1–3 match `_bmad-output/planning-artifacts/epics/epic-2-team-formation-hiring-personas-and-team-observability.md` § Story 2.1. AC4 is the epic's `**AC4 (integration):**` test contract.
>
> **User-surface judgement.** None of these ACs is `user-surface` per `plugins/crew/docs/user-surface-acs.md`. The catalogue files live under `plugins/crew/catalogue/` and are consumed by future MCP tools (Story 2.3) and the hiring-manager agent (Story 2.4) — the v1 operator (Maya) never types a path that names a catalogue file, never observes a Claude Code UI element produced by this story, and the install README does not instruct her to open or copy any catalogue file by name. The schema, the section headers, and the domain-uniqueness check are internal correctness gates, not surfaces. ACs that *do* surface the catalogue to the operator (e.g. `/crew:hire` listing the roster, `/crew:team` printing domains) live in Stories 2.4 and 2.6 and will carry the `user-surface` tag there.

**AC1:**
**Given** the catalogue directory `plugins/crew/catalogue/`,
**When** I list it,
**Then** I see exactly: `hiring-manager.md`, `planner.md`, `generalist-dev.md`, `generalist-reviewer.md`, `retro-analyst.md`, `orchestrator.md`, `security-specialist.md`, `test-specialist.md`, `docs-specialist.md`, `debugger.md` — ten files, no more, no fewer, no other extensions. _(FR82, FR83)_
<!-- user-surface: AC names a directory under plugins/crew/ but the operator never lists it; the README does not instruct anyone to copy or open these files by name. Rubric (iii) does not apply. Not user-surface. -->

**AC2:**
**Given** any catalogue file in `plugins/crew/catalogue/`,
**When** it is parsed against `CatalogueRoleSchema` (new file: `plugins/crew/mcp-server/src/schemas/catalogue.ts`),
**Then** it validates against required frontmatter (`role`, `domain`, `model_tier`, `tools_allow`, `gh_allow`, `locked_phrases.{handoff,yield,verdict}`) and required `##` sections (`Domain`, `Mandate`, `Out of mandate`, `Prompt`). _(FR82, architecture/implementation-patterns-consistency-rules.md §3)_
<!-- user-surface: AC names internal schema file paths and section header strings the operator never observes. Not user-surface. -->

**AC3:**
**Given** the `domain:` field of every catalogue file in `plugins/crew/catalogue/`,
**When** the set is compared pairwise,
**Then** every `domain:` string is distinct (no domain collisions across the v1 catalogue). _(FR98, FR99)_
<!-- user-surface: domain strings are an internal routing key consumed by lookup-role-by-domain (Story 2.3); the operator never types or sees them at the surface in this story. Not user-surface. -->

**AC4 (integration):**
**Given** the shipped catalogue + the new schema,
**When** `pnpm --dir plugins/crew test` runs the new test file `plugins/crew/mcp-server/tests/catalogue-shape.test.ts`,
**Then** vitest (a) discovers every `.md` file in `plugins/crew/catalogue/`, (b) parses each through `CatalogueRoleSchema`, (c) asserts the file-set equality from AC1 against an explicit allowlist of 10 filenames, (d) asserts pairwise distinct `domain:` values, and (e) asserts the four required `##` section headers (`Domain`, `Mandate`, `Out of mandate`, `Prompt`) appear in that order in each file. Any drift fails with a diagnostic naming the offending file, frontmatter key, or domain string.
<!-- user-surface: AC4 names the CLI command `pnpm --dir plugins/crew test` literally, but that command is run by the dev (and CI), not by Maya the install-path operator — and this story does not add an "Expected confirmation" block to README-install.md. The README does not instruct the install-path operator to run pnpm test. Rubric (ii) is about commands the *operator* types verbatim from docs; the dev/CI test invocation is internal tooling. Not user-surface. -->

---

## Tasks / Subtasks

- [ ] **Task 1 — Author the `CatalogueRoleSchema` Zod schema (AC: 2, 4)**
  - [ ] 1.1 Create `plugins/crew/mcp-server/src/schemas/catalogue.ts`. Mirror the conventions in the existing `role-permissions.ts`: named export only, `.strict()` at every object level, kebab-case `role` regex, JSDoc header naming the FR refs (FR82, FR83, FR98, FR99) and citing architecture §3.
  - [ ] 1.2 Schema shape — frontmatter (YAML):
    - `role: string` — kebab-case `^[a-z0-9-]+$`, `.min(1)`.
    - `domain: string` — `.min(1)`, short noun phrase (no regex; trim-and-non-empty is the contract).
    - `model_tier: z.enum(["opus","sonnet","haiku"])`.
    - `tools_allow: z.array(z.string().min(1)).min(1)`.
    - `gh_allow: z.array(z.string().min(1)).default([])`.
    - `locked_phrases: z.object({ handoff: string.min(1), yield: string.min(1), verdict: string.min(1) }).strict()`.
    - **Reject** `hired_at` and `catalogue_version` (those are persona-only per architecture §3). Use `.strict()`; do NOT define a "shared" base schema with persona — `CatalogueRoleSchema` is a sibling, not a parent, of the future `PersonaSchema` (Story 2.3 owns that).
  - [ ] 1.3 Schema also exposes a **body validator** — a separate exported function `assertCatalogueBodySections(body: string): void` that asserts the four required `##` section headers `## Domain`, `## Mandate`, `## Out of mandate`, `## Prompt` appear in that order in the Markdown body (after the closing `---` of the frontmatter block). Use simple line-scanning, NOT a full Markdown parser — the contract is line-level header presence and order. Throw a `DomainError` subclass (`CatalogueShapeError extends DomainError`) on failure with a message naming the missing/out-of-order header.
  - [ ] 1.4 Add `CatalogueShapeError` to `plugins/crew/mcp-server/src/errors.ts` following the existing `extends DomainError` pattern in that file (mirror `StoryNotFoundError` or equivalent — check `errors.ts` first; do NOT reinvent). The `code` string is `CATALOGUE_SHAPE_ERROR`.
  - [ ] 1.5 No new top-level dependencies. Use `yaml` (eemeli) which is already in `plugins/crew/mcp-server/package.json` for frontmatter parsing (split on `^---$`, parse the YAML head, treat the rest as body). Match the parsing approach already used elsewhere — check `markdown-frontmatter.ts` in `lib/` (per architecture §6) and reuse it if present; if not present, the helper goes into `lib/markdown-frontmatter.ts` as a new file with named exports.

- [ ] **Task 2 — Author the 10 catalogue role files (AC: 1, 2, 3)**
  - [ ] 2.1 Create each file at `plugins/crew/catalogue/<role>.md` using the canonical skeleton from architecture/implementation-patterns-consistency-rules.md §3 — frontmatter block, then `## Domain`, `## Mandate`, `## Out of mandate`, `## Prompt`. **Do not add `# Knowledge`** — that is persona-only.
  - [ ] 2.2 Per-role frontmatter values — pinned below. **`domain:` strings are load-bearing (FR99 exact-match routing); do not paraphrase.** `tools_allow` and `gh_allow` lists encode the v1 capability contract; Story 2.2 will mirror `gh_allow` into permission YAML.

    | role | domain | model_tier | tools_allow | gh_allow |
    |---|---|---|---|---|
    | `hiring-manager` | `team formation and roster proposal` | `sonnet` | `[Read, Edit, Bash]` | `[]` |
    | `planner` | `story authoring and acceptance criteria` | `sonnet` | `[Read, Edit, Task]` | `[pr-view]` |
    | `generalist-dev` | `feature implementation in a story scope` | `sonnet` | `[Read, Edit, Bash, Task]` | `[pr-create, pr-view, pr-comment]` |
    | `generalist-reviewer` | `code review and verdict authoring` | `sonnet` | `[Read, Bash, Task]` | `[pr-view, pr-comment, pr-review]` |
    | `retro-analyst` | `cycle-end lessons and rule proposals` | `sonnet` | `[Read, Edit, Task]` | `[pr-view]` |
    | `orchestrator` | `session liveness and story state transitions` | `sonnet` | `[Read, Bash, Task]` | `[pr-view]` |
    | `security-specialist` | `authentication authorization and secret handling` | `sonnet` | `[Read, Bash, Task]` | `[pr-view, pr-comment]` |
    | `test-specialist` | `test design and coverage gaps` | `sonnet` | `[Read, Edit, Bash, Task]` | `[pr-view, pr-comment]` |
    | `docs-specialist` | `developer-facing documentation and READMEs` | `sonnet` | `[Read, Edit, Task]` | `[pr-view, pr-comment]` |
    | `debugger` | `failure-mode diagnosis and root-cause isolation` | `sonnet` | `[Read, Bash, Task]` | `[pr-view, pr-comment]` |

    Notes on the table:
    - All ten domains are distinct strings — verify against AC3 before writing.
    - `model_tier` defaults to `sonnet` across the roster for v1; future calibration (Epic 6) may upgrade specific roles to `opus`. Do not pre-optimise here.
    - `tools_allow` includes `Task` for every role that may spawn a subagent (planner, dev, reviewer, retro, orchestrator, specialists). `hiring-manager` does not currently need `Task` (it reads the repo and proposes; it does not spawn).
    - `gh_allow` for `hiring-manager` is empty — hiring does not touch GitHub. Story 2.2 will mirror these into permission YAMLs.
    - `generalist-reviewer`'s `gh_allow` deliberately **excludes** `pr-merge`, `pr-close`, and any push-capable subcommand — this encodes the negative-capability contract from FR37/FR38/NFR16, which Story 2.2's AC3 will then assert via the permission spec.
  - [ ] 2.3 Per-role `locked_phrases` — use the architecture §7 locked-phrase strings verbatim. For roles that do not directly produce verdicts (i.e. everyone except `generalist-reviewer`), the `verdict` phrase is still required as a frontmatter field but the role's `# Prompt` body explains the role does not author verdicts. **Do not invent new phrases.** Concretely:
    - `handoff`: `"Handoff to <next role> — story <story-id> ready for review."` (for dev). For roles that hand off differently, use the architecture §7 pattern `"Handoff to <next role> — <intent>"` from implementation-patterns-consistency-rules.md §1's catalogue template.
    - `yield`: `"This sits in <role>'s domain — handing off."` — same string across all roles (the role decides who to name at runtime).
    - `verdict`: `"**Verdict: <SENTINEL>**"` — same canonical shape across all roles; sentinels are `READY FOR MERGE` | `NEEDS CHANGES` | `BLOCKED`.

    These are template strings (with `<placeholder>` literals) — the dev/reviewer agent fills the placeholders at runtime. The schema's `.min(1)` is sufficient; do NOT add a regex against the angle-bracket placeholders.
  - [ ] 2.4 Per-role `## Domain`, `## Mandate`, `## Out of mandate`, `## Prompt` bodies — one paragraph each for Domain/Mandate/Out-of-mandate; the `## Prompt` body is the role's system-prompt content. Author a credible v1 prompt per role grounded in the PRD's role descriptions and the architecture's role-location mapping. **Goal: each prompt is shippable for the canary install and the calibration loop has something concrete to refine — not a finished masterpiece.** Keep prompts under ~600 words each. Cross-reference: `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md` for role-specific FR responsibilities (e.g. reviewer owns FR30–FR42, dev owns FR24–FR29, retro owns FR55–FR64a).
  - [ ] 2.5 File-naming sanity — every file is exactly `<role>.md`, lower-case, no underscores. The 10 filenames are pinned in AC1 and the test harness allowlist (Task 3.3); they must match exactly.
  - [ ] 2.6 Existing `plugins/crew/catalogue/.gitkeep` — leave in place OR remove if the directory now has ten tracked files. Either is acceptable; do not block on it.

- [ ] **Task 3 — Author the vitest harness (AC: 1, 2, 3, 4)**
  - [ ] 3.1 Add `plugins/crew/mcp-server/tests/catalogue-shape.test.ts`. New file. Pattern after existing tests like `permissions-enforcement.test.ts` (parses YAML against a Zod schema) and `dist-shipping.test.ts` (file-set assertions against an explicit allowlist).
  - [ ] 3.2 The test reads `plugins/crew/catalogue/` from disk. Resolve the path from `import.meta.url` or repo root — match the helper used in `dist-shipping.test.ts` / `ci-drift-check.test.ts`. Do NOT invent a new file-locating helper.
  - [ ] 3.3 **Filename allowlist check (AC1, AC4).** The allowlist is **explicit** in the test file (not generated from the catalogue directory):
    ```
    const CATALOGUE_FILES = [
      "hiring-manager.md","planner.md","generalist-dev.md","generalist-reviewer.md",
      "retro-analyst.md","orchestrator.md","security-specialist.md","test-specialist.md",
      "docs-specialist.md","debugger.md",
    ] as const;
    ```
    Assert: (a) `readdirSync` returns exactly this set (modulo `.gitkeep` if still present — filter it out before comparing); (b) no extra files; (c) no missing files. Diagnostic on failure names the diff (extra / missing).
  - [ ] 3.4 **Schema parse check (AC2, AC4).** For each file, split frontmatter from body using the parser from Task 1.5, parse the YAML head through `CatalogueRoleSchema`, and assert success. A parse failure produces a diagnostic naming the file and the Zod issue path.
  - [ ] 3.5 **Body-section check (AC2, AC4).** For each file's body, call `assertCatalogueBodySections(body)` from Task 1.3. A failure produces a diagnostic naming the file and the missing/out-of-order header.
  - [ ] 3.6 **Domain uniqueness check (AC3, AC4).** Collect every parsed `domain:` value into a `Set`; assert `set.size === CATALOGUE_FILES.length`. On collision, diagnostic names the offending domain string and the two files that share it.
  - [ ] 3.7 The test file header MUST cite this story (`Story 2.1 AC1–AC4`) and link to `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` §3, mirroring the comment-header convention used in `pre-pr-gate.test.ts` and `user-surface-convention.test.ts`.
  - [ ] 3.8 Run `pnpm --dir plugins/crew test`. Confirm the new test passes, the existing suite still passes (zero new failures, zero new skips, zero new warnings).

- [ ] **Task 4 — Build & dist verification (AC: 4)**
  - [ ] 4.1 Run `pnpm --dir plugins/crew/mcp-server build`. Schema additions must compile; `tsc` errors fail the task.
  - [ ] 4.2 Per `plugins/crew/docs/README-install.md` § Build artefacts and Story 1.9's contract, the built `mcp-server/dist/` tree is committed. Regenerate `dist/` after Task 4.1 and stage it in the same commit. The `ci-drift-check.test.ts` enforces src-vs-dist alignment — confirm it still passes.
  - [ ] 4.3 The catalogue `.md` files themselves do not need building (they are static assets shipped as-is per `/plugin install`'s file-copy semantics). No bundling step.

- [ ] **Task 5 — Verify no other story's contract drifted (AC: 1–4)**
  - [ ] 5.1 Open the existing `plugins/crew/mcp-server/src/schemas/role-permissions.ts` and confirm the kebab-case `role` regex `^[a-z0-9-]+$` matches every catalogue role authored in Task 2. The two schemas share a `role` identifier convention; if they diverge, Story 2.2 breaks.
  - [ ] 5.2 Skim the existing `plugins/crew/permissions/` directory. It is currently empty (Story 2.2 hasn't shipped). This story does NOT pre-populate it — but if it is already non-empty (someone landed Story 2.2 out of order), confirm every per-role YAML there names a role that exists in this story's catalogue. If a permission file references a role this story does not ship, raise — do NOT silently delete the permission file.
  - [ ] 5.3 No other tree is touched. Specifically: do NOT edit `plugins/crew/skills/*`, `plugins/crew/docs/README-install.md`, `plugins/crew/docs/standards-example.md`, root `README.md`, or any MCP tool file. Catalogue authorship is leaf work.

---

## Dev Notes

### Critical context: what was shipped before, what this story builds on

- **Story 1.1** scaffolded `plugins/crew/` including `catalogue/.gitkeep` and `mcp-server/src/schemas/`. The skeleton exists; this story drops content into it.
- **Story 1.4** added `role-permissions.ts` (FR79–FR81 enforcement). The pattern there (`.strict()`, kebab-case `role` regex, JSDoc citing FRs) is the template Task 1 follows for `catalogue.ts`. Do **not** make `CatalogueRoleSchema` inherit from or share types with `RolePermissionsSchema` — they encode different contracts.
- **Story 1.4** also established `plugins/crew/mcp-server/src/errors.ts` with a `DomainError` base class. Task 1.4's `CatalogueShapeError` extends that base and follows the same code-string convention as existing errors in that file.
- **Story 1.5** wired JSONL telemetry via pino. **This story does not emit telemetry.** Validation-time failures throw `CatalogueShapeError`; no `catalogue.validate` event is added to the discriminated-union event schema. (Future MCP tooling in Story 2.3 may emit `catalogue.read` etc. — out of scope here.)
- **Story 1.6** shipped the atomic-`fs.rename` state-machine primitive. Catalogue files are read-only at runtime (architecture §"Architectural boundaries") — they are never moved by the state machine, never claimed, never have execution manifests. This story doesn't touch the state machine.
- **Story 1.7 / 1.7a** wired `/crew:status`. The status surface does NOT yet read the catalogue; that wiring may be picked up in Story 2.6 (`/crew:team`). Out of scope here.
- **Story 1.8** added the `user-surface` AC tag and pre-PR smoke gate. **Story 2.1 has zero `user-surface` ACs.** The gate parses the spec, finds no `(user-surface)`-tagged ACs, and exits 0 with `{"status":"skipped"}` per `plugins/crew/docs/user-surface-acs.md` § "How the gate uses this" step 2. No operator-paste-output step is required for this story's PR.
- **Story 1.9** committed `mcp-server/dist/`. Task 4.2 re-runs the build and stages the regenerated `dist/` — `ci-drift-check.test.ts` will fail the PR otherwise.
- **Story 1.10** rewrote `docs/README-install.md` to match observed Claude Code UI. This story does **NOT** add a new step to the install path; the operator never sees the catalogue files during install. Do not edit `README-install.md`.

### Architecture references (load these first, dev agent)

- `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` §3 (Catalogue & Persona File Shape) — the canonical skeleton. **Source of truth for frontmatter and section layout.**
- `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` §1 (Frontmatter Conventions) — snake_case keys, ISO-8601 dates (n/a for catalogue), Zod-backed schemas in `mcp-server/src/schemas/`, lists as block sequences.
- `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` §6 (TypeScript Code Conventions) — kebab-case `.ts` filenames, named exports only, no `any`, types via `z.infer`, errors as typed `DomainError` subclasses.
- `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` §7 (Locked Phrases) — `handoff`, `yield`, `verdict` strings are tested and load-bearing.
- `_bmad-output/planning-artifacts/architecture/project-structure-boundaries.md` (plugin tree) — confirms `plugins/crew/catalogue/<role>.md` paths and the "catalogue is read-only at runtime" boundary.
- `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md` FR82, FR83, FR98, FR99 — the requirements this story closes.
- `plugins/crew/docs/user-surface-acs.md` — for confirming the `user-surface` judgement above.

### Files this story creates (NEW)

- `plugins/crew/mcp-server/src/schemas/catalogue.ts` — `CatalogueRoleSchema` + `assertCatalogueBodySections` + `CatalogueRole` type.
- `plugins/crew/mcp-server/src/lib/markdown-frontmatter.ts` — **only if it does not already exist.** Check first; if present, reuse.
- `plugins/crew/mcp-server/tests/catalogue-shape.test.ts` — vitest harness.
- `plugins/crew/catalogue/hiring-manager.md`
- `plugins/crew/catalogue/planner.md`
- `plugins/crew/catalogue/generalist-dev.md`
- `plugins/crew/catalogue/generalist-reviewer.md`
- `plugins/crew/catalogue/retro-analyst.md`
- `plugins/crew/catalogue/orchestrator.md`
- `plugins/crew/catalogue/security-specialist.md`
- `plugins/crew/catalogue/test-specialist.md`
- `plugins/crew/catalogue/docs-specialist.md`
- `plugins/crew/catalogue/debugger.md`

### Files this story MAY modify (UPDATE, with care)

- `plugins/crew/mcp-server/src/errors.ts` — add `CatalogueShapeError extends DomainError` only. Do not touch other error classes; their `code` strings are pinned by Story 1.4.
- `plugins/crew/mcp-server/dist/**` — regenerated by `pnpm build`. Stage in the same commit (Task 4.2). Do not hand-edit.
- `plugins/crew/catalogue/.gitkeep` — may delete once the directory has tracked files. Not required.

### Files this story MUST NOT modify

- `_bmad-output/implementation-artifacts/sprint-status.yaml` (orchestrator owns).
- `plugins/crew/skills/*` — no slash command surface here.
- `plugins/crew/docs/README-install.md` — operator does not see catalogue files during install.
- `plugins/crew/permissions/*` — Story 2.2.
- Any existing schema (`role-permissions.ts`, `telemetry-events.ts`, `workspace-config.ts`, etc.) — schemas are sibling, not shared.
- Root `README.md` if any.

### Locked-phrase template strings (architecture §7) — use verbatim

```yaml
locked_phrases:
  handoff: "Handoff to <next role> — <intent>"
  yield: "This sits in <role>'s domain — handing off"
  verdict: "**Verdict: <SENTINEL>**"
```

- `<next role>`, `<role>`, `<SENTINEL>` are angle-bracket placeholders, filled at runtime by the agent. The schema's `.min(1)` is the only validation; do not regex-check the placeholders.
- The generalist-dev's specific handoff string (`"Handoff to reviewer — story <story-id> ready for review."`) is a *template* the dev role fills in. Store this concrete form in the dev catalogue file; the generic `<next role> — <intent>` form lives in roles that hand off to varying others (planner, retro, specialists).

### Testing standards

- **Framework:** vitest, already configured (`plugins/crew/mcp-server/vitest.config.ts`).
- **Test placement:** `plugins/crew/mcp-server/tests/<name>.test.ts` — matches every other test in the suite (no per-source co-location for these higher-level checks).
- **Run command:** `pnpm --dir plugins/crew test` — runs all suites. Single-file: `pnpm --dir plugins/crew/mcp-server exec vitest run tests/catalogue-shape.test.ts`.
- **No skips, no `.only`, no `.todo`.** New test must run cleanly alongside the existing 17 suites.
- **Diagnostics on failure** must name the offending file path so a future dev does not have to bisect.

### Project Structure Notes

- All paths follow `_bmad-output/planning-artifacts/architecture/project-structure-boundaries.md` exactly. No deviations.
- Catalogue lives under `plugins/crew/catalogue/` (architecture §"Plugin tree" line 18–28). The schema lives under `plugins/crew/mcp-server/src/schemas/catalogue.ts` (§"Plugin tree" lines 87–95).
- The "catalogue is read-only at runtime" boundary (§"Architectural boundaries" line 184) means this story does not need to wire any MCP tool to write to `catalogue/`. Story 2.3 will add a read-only `read-catalogue` tool.

### References

- [Source: `_bmad-output/planning-artifacts/epics/epic-2-team-formation-hiring-personas-and-team-observability.md#Story 2.1: Catalogue file format and shipped role templates`] — verbatim epic ACs.
- [Source: `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md#3. Catalogue & Persona File Shape`] — canonical file skeleton.
- [Source: `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md#1. Frontmatter Conventions (all *plugin-owned* Markdown / YAML artifacts)`] — YAML conventions.
- [Source: `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md#6. TypeScript Code Conventions (MCP server source)`] — file naming, exports, errors.
- [Source: `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md#7. Locked Phrases (exact strings)`] — locked-phrase template strings.
- [Source: `_bmad-output/planning-artifacts/architecture/project-structure-boundaries.md#Plugin tree`] — directory layout.
- [Source: `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md#FR82`] — catalogue file format requirement.
- [Source: `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md#FR83`] — minimum role roster requirement.
- [Source: `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md#FR98`] — `domain:` field declaration.
- [Source: `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md#FR99`] — domain-based role lookup (exact match, drives uniqueness).
- [Source: `plugins/crew/docs/user-surface-acs.md`] — `user-surface` tagging rubric (Story 1.8 convention).
- [Source: `plugins/crew/mcp-server/src/schemas/role-permissions.ts`] — sibling-schema pattern for `.strict()`, JSDoc, kebab-case role regex.

---

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

- 2026-05-20 rework pass (review verdict: request-changes):
  - Reset every catalogue file's `domain:`, `tools_allow:`, and `gh_allow:` to the exact values pinned in Task 2.2's table. Notably: every Task-spawning role now carries `Task` in `tools_allow`; `generalist-reviewer.gh_allow` drops `api` and adds `pr-review` (encoding the FR37 / FR38 / NFR16 negative-capability contract).
  - Added AC4(e) section-order assertion: `assertCatalogueBodySections(body, sourcePath?)` is exported from `src/schemas/catalogue.ts` and reused by Story 2.3 to enforce that the four required `##` headers (`Domain`, `Mandate`, `Out of mandate`, `Prompt`) appear in canonical order. Out-of-order or missing headers throw `CatalogueShapeError`.
  - File renames to match the spec:
    - Schema moved to `src/schemas/catalogue.ts` (was `catalogue-role.ts`); main export is now `CatalogueRoleSchema`.
    - Frontmatter splitter + catalogue parser landed in `src/lib/markdown-frontmatter.ts` (was `src/validators/catalogue-role.ts`).
    - Error renamed to `CatalogueShapeError` with `code = "CATALOGUE_SHAPE_ERROR"`.
    - Test renamed to `tests/catalogue-shape.test.ts`.
  - Regenerated `mcp-server/dist/`; stale `dist/schemas/catalogue-role.*` and `dist/validators/catalogue-role.*` removed so the CI dist-drift gate stays green.
  - Verification: `pnpm --dir plugins/crew install && pnpm --dir plugins/crew build && pnpm --dir plugins/crew test` — all 19 suites, 181 tests passing.

### File List
