# Story 2.3: Persona-file machinery and persona MCP tools

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin maintainer**,
I want **a persona Zod schema plus four MCP tools (`readCatalogue`, `instantiatePersona`, `readPersona`, `lookupRoleByDomain`) that form the only canonical-state boundary for creating, reading, and routing-by-domain over hired-team persona files at `<target-repo>/team/<role>/PERSONA.md`**,
so that **Story 2.4's `/hire` skill (and Story 2.5's `/skip-hiring`) have a typed, allowlist-enforced surface for hiring a role from the catalogue, and FR99 domain routing has a runtime answer.**

### What this story is, in one sentence

Ship `PersonaFileSchema` (a Zod schema that extends catalogue-role frontmatter with `hired_at` / `catalogue_version` and adds a required `## Knowledge` section after `Prompt`), a `parsePersonaFile` helper that reuses `splitFrontmatter` and `assertCatalogueBodySections` from Story 2.1, four new MCP tools registered through `registerAllTools` in `plugins/crew/mcp-server/src/tools/register.ts`, the `RolePermissionsMcpTools` allowlist additions on the relevant per-role permission YAMLs from Story 2.2, and a vitest harness that drives instantiate → read → lookup → edit-then-read round-trip on a fixture target repo.

### What this story fixes (and why it needs its own story)

Stories 2.1 and 2.2 shipped the catalogue (frontmatter shape + body sections + ten role files) and the per-role permission specs (`tools_allow` MCP-tool allowlists + `gh_allow` subcommand allowlists). Story 2.4 (`/hire`) and Story 2.5 (`/skip-hiring`) are the operator-facing flows that *use* the catalogue to *write* persona files into `<target-repo>/team/<role>/PERSONA.md`. Story 2.3 is the load-bearing seam between the two: it owns the **persona-file shape** (frontmatter + sections), the **only canonical-state writer** of persona files (`instantiatePersona` calling `writeManagedFile`), and the **domain-routing read path** (`lookupRoleByDomain`) that FR99 / FR103 (yield protocol, Epic 3) depend on. Without it:

- Story 2.4 cannot complete a hire because there is no tool that materialises a persona file.
- Story 2.7 (`/ask <role>`) cannot assemble a persona prompt because there is no `readPersona` reader.
- FR99 domain routing has no runtime answer — every yield-by-domain attempt would have to re-walk `team/` and re-parse Markdown files at the call site, with no schema enforcement.
- `team/*` paths are in `CANONICAL_PATH_GLOBS` (`plugins/crew/mcp-server/src/lib/managed-fs.ts` line 20) — any direct write outside the MCP tool layer is refused by `writeManagedFile` for lack of `mcpToolContext`. The dispatcher is in place; nothing yet plugs a tool into it for `team/`.

This is **schema + four MCP tools + permissions allowlist additions + integration test**, not operator-facing UX. The slash command surfaces (`/hire`, `/skip-hiring`, `/ask`, `/team`) are Stories 2.4 / 2.5 / 2.6 / 2.7.

### This story does NOT

- (a) Touch `_bmad-output/implementation-artifacts/sprint-status.yaml` — the orchestrator owns status transitions.
- (b) Modify `plugins/crew/catalogue/*.md` — Story 2.1 is the source of truth for catalogue frontmatter and body sections. If a discrepancy is found, fix the persona schema or this story's parser, not the catalogue.
- (c) Author any slash command (`plugins/crew/skills/*.md`). `/hire`, `/skip-hiring`, `/team`, `/ask` are later stories in this epic. This story registers MCP tools only.
- (d) Implement the hiring conversation, repo signal-reading, or proposal/justification flow — that is Story 2.4's mandate. `instantiatePersona` takes a `role` plus `targetRepoRoot` and writes; it does NOT decide which roles to hire.
- (e) Implement `appendPersonaKnowledge`, the `<persona>/.proposed.md` diff-then-confirm flow, or `accept-proposal`. The `## Knowledge` section is written **empty** at hire time (FR89). Story 2.4b / Epic 3 owns knowledge appends behind the calibration-loop gate.
- (f) Implement fuzzy domain matching, ranking, or scoring. `lookupRoleByDomain` is exact-match-or-null (FR99 verbatim). Routing failures are surfaced by the locked phrase `[routing-failure] no hired role matches domain "<x>"` (implementation-patterns-consistency-rules §7); that locked phrase is exercised by Epic 3's yield protocol, not here.
- (g) Implement `team/custom/<role>.md` parsing or proposal. Story 2.5 owns the custom escape hatch. `lookupRoleByDomain` reads only `<target-repo>/team/<role>/PERSONA.md` files in v1, not `team/custom/`.
- (h) Touch `plugins/crew/docs/README-install.md` — the install-path operator (Maya) never opens a persona file during install. They are written by `/hire` or `/skip-hiring`, not copied from the README.
- (i) Modify `plugins/crew/mcp-server/src/schemas/catalogue.ts`, `plugins/crew/mcp-server/src/schemas/role-permissions.ts`, `plugins/crew/mcp-server/src/lib/markdown-frontmatter.ts`, or `plugins/crew/mcp-server/src/lib/managed-fs.ts`. The Story 2.1 catalogue schema is the source of truth for the four-section prefix; Story 1.4 / Story 2.2 own permissions; Story 1.6 owns managed-fs. This story only adds to `schemas/persona.ts` (new), `lib/persona-file.ts` (new) and `tools/*` (new).
- (j) Mutate any existing test. New tests only.

---

## Acceptance Criteria

> **Verbatim mapping.** ACs 1–4 map to the epic ACs in `_bmad-output/planning-artifacts/epics/epic-2-team-formation-hiring-personas-and-team-observability.md` § Story 2.3. AC5 is the epic's `**AC5 (integration):**` test contract.
>
> **User-surface judgement.** None of these ACs is `user-surface` per `plugins/crew/docs/user-surface-acs.md`. The four MCP tool names (`readCatalogue`, `instantiatePersona`, `readPersona`, `lookupRoleByDomain`) are internal — rubric clause (i) covers slash commands, not MCP tool names. The file path `<target-repo>/team/<role>/PERSONA.md` (AC1, AC4) is operator-observable on disk, but the README install path does not instruct Maya to copy or open it by name — the persona is materialised by `/hire`, not by a README step. Rubric (iii) does not apply. Rubric (iv) does not apply: no Claude Code UI element is in scope here; `/hire`'s UI is Story 2.4.

**AC1:**
**Given** a catalogue role (one of the ten Story 2.1 roles) and a target repo,
**When** `instantiatePersona({ role, targetRepoRoot })` is called via the MCP dispatcher,
**Then** a persona file is written at `<target-repo>/team/<role>/PERSONA.md` whose frontmatter mirrors the catalogue's frontmatter (`role`, `domain`, `model_tier`, `tools_allow`, `gh_allow`, `locked_phrases`) plus two persona-only keys (`hired_at` as ISO-8601 UTC, `catalogue_version` as the current plugin semver from `getPluginVersion()`) and whose body is the catalogue's `Prompt` section copied verbatim under a `## Prompt` heading, preceded by `## Domain`, `## Mandate`, `## Out of mandate` (also copied verbatim from the catalogue), followed by an empty `## Knowledge` section. _(FR89, FR98)_
<!-- user-surface: file path is operator-observable on disk but the README/install docs do not instruct Maya to open it by name (rubric clause iii). Materialisation happens through `/hire` (Story 2.4), not a README step. Not user-surface. -->

**AC2:**
**Given** an existing persona file at `<target-repo>/team/<role>/PERSONA.md`,
**When** `readPersona({ role, targetRepoRoot })` is called via the MCP dispatcher,
**Then** it returns a typed object containing the parsed frontmatter (matching `PersonaFileSchema`), the four body sections (`Domain`, `Mandate`, `Out of mandate`, `Prompt`) plus the `Knowledge` section, and the absolute `sourcePath` — without re-writing or mutating the file on disk. _(FR93)_
<!-- user-surface: AC names an internal MCP tool (`readPersona`) and a schema; operator does not invoke `readPersona` directly. Not user-surface. -->

**AC3:**
**Given** a target repo with a hired team (one or more `<target-repo>/team/<role>/PERSONA.md` files) and a domain string,
**When** `lookupRoleByDomain({ targetRepoRoot, domain })` is called via the MCP dispatcher,
**Then** it returns the exact-match role id (`{ role: "<id>" }`) when one and only one hired persona's `domain:` frontmatter equals the input string byte-for-byte, or `{ role: null }` when there is no match. No fuzzy matching, no case-folding, no trimming beyond what `yaml`'s parser already does. _(FR99)_
<!-- user-surface: internal MCP tool, no operator-typed surface. Not user-surface. -->

**AC4:**
**Given** any persona file under `<target-repo>/team/<role>/PERSONA.md` after instantiation,
**When** a user opens the file in a text editor, edits the `## Knowledge` or `## Prompt` body, saves, and a subsequent `readPersona` call is made,
**Then** the returned `sections` reflect the user's edits without schema violation, AND `git revert <path>` restores the prior on-disk state (the file is plain Markdown committed through standard git, with no sidecar state). _(FR96, FR97, NFR25, NFR27)_
<!-- user-surface: AC4 references "open in a text editor" — operator-observable behaviour — but the file path `<target-repo>/team/<role>/PERSONA.md` is not instructed by the README/install docs to be opened by name (rubric clause iii). The operator only ever encounters this path because `/hire` (Story 2.4) wrote it; the README does not name it. Rubric clauses (i), (ii), (iv) do not apply (no slash command literal, no operator-typed CLI command, no Claude Code UI). Not user-surface. The git-revert affordance is a property of plain-file storage, not a UI surface. -->

**AC5 (integration):**
**Given** the four shipped MCP tools and `PersonaFileSchema`,
**When** `pnpm --dir plugins/crew test` runs the new `plugins/crew/mcp-server/tests/persona-machinery.test.ts`,
**Then** vitest asserts, against a temp-dir fixture target repo: (a) `instantiatePersona` for each of the ten catalogue roles writes the expected file under `team/<role>/PERSONA.md`; (b) each written file parses cleanly through `PersonaFileSchema` and exposes the five required sections (`Domain`, `Mandate`, `Out of mandate`, `Prompt`, `Knowledge`); (c) `readPersona` returns the same content `instantiatePersona` wrote (round-trip equality on frontmatter + body sections); (d) `lookupRoleByDomain` returns the correct role for every hired domain and `null` for a known-absent domain; (e) after a programmatic edit appending a line under `## Knowledge`, a subsequent `readPersona` reflects the edit (plain-Markdown round-trip, no sidecar state); (f) `instantiatePersona` refuses an unknown catalogue role with a typed `CatalogueRoleNotFoundError` and refuses a re-instantiation of an already-hired role with a typed `PersonaAlreadyExistsError` (no silent overwrite — FR90's re-entry actions are Story 2.4's mandate, not this tool's). Any failure surfaces a diagnostic naming the offending role, file path, and (where relevant) the Zod issue.

---

## Tasks / Subtasks

- [ ] **Task 1 — Author `PersonaFileSchema` (AC: 1, 2, 5)**
  - [ ] 1.1 Create `plugins/crew/mcp-server/src/schemas/persona.ts`. New file. Pattern after `plugins/crew/mcp-server/src/schemas/catalogue.ts` exactly — same `.strict()` discipline, same kebab-case `role` regex, same `LockedPhrasesSchema` and `ModelTierSchema` re-imports.
  - [ ] 1.2 Define `PersonaFrontmatterSchema` as the catalogue frontmatter shape **plus** two required persona-only keys:
    - `hired_at`: ISO-8601 string. Use `z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/)`. UTC `Z` suffix is mandatory (NFR25 readability — local-tz timestamps are not portable across machines).
    - `catalogue_version`: plugin semver string. Use `z.string().regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/)`. Format matches `getPluginVersion()` output (`plugins/crew/mcp-server/src/lib/plugin-version.ts`).
    Re-export `CatalogueRoleSchema`'s frontmatter fields verbatim via `CatalogueRoleSchema.shape` extension or a hand-merged object — whichever keeps the `.strict()` discipline. **Do not loosen any catalogue field constraint** (the regex on `role`, the enum on `model_tier`, etc.).
  - [ ] 1.3 Define `REQUIRED_PERSONA_SECTIONS` as `["Domain", "Mandate", "Out of mandate", "Prompt", "Knowledge"] as const`. Five sections in canonical order. This extends Story 2.1's `REQUIRED_CATALOGUE_SECTIONS` (four sections) by one — `Knowledge` is appended after `Prompt`.
  - [ ] 1.4 Define `PersonaFile` type as `PersonaFrontmatter & { sections: Record<PersonaSection, string>; sourcePath: string }`. Mirrors Story 2.1's `CatalogueRole` shape exactly so consumers can interchange where the four-section prefix is what matters.
  - [ ] 1.5 Do NOT export an `assertPersonaBodySections` helper. Instead, the parser in Task 2 calls Story 2.1's `assertCatalogueBodySections` first (which checks the four-section prefix in canonical order — Story 2.1's helper tolerates extra sections after `Prompt`), then performs an additional check that `Knowledge` appears after `Prompt`. Reusing `assertCatalogueBodySections` is mandated — do NOT duplicate its line-scanning logic.

- [ ] **Task 2 — Author the persona-file parser (AC: 1, 2, 5)**
  - [ ] 2.1 Create `plugins/crew/mcp-server/src/lib/persona-file.ts`. New file. Pattern after `plugins/crew/mcp-server/src/lib/markdown-frontmatter.ts` exactly.
  - [ ] 2.2 Export `parsePersonaFile(raw: string, sourcePath: string): PersonaFile`. Reuses `splitFrontmatter` from `markdown-frontmatter.ts` for the head/body split. Runs the YAML parse and Zod validation against `PersonaFrontmatterSchema`. Calls `assertCatalogueBodySections(body, sourcePath)` for the canonical four-section prefix. Then performs an additional check: walk `## <Heading>` lines, confirm `Knowledge` appears strictly after `Prompt`. Reuse the section-extraction helper pattern from `markdown-frontmatter.ts` (private function); copy-and-adapt is acceptable here because the upstream module is small and intentionally not exposing its internals.
  - [ ] 2.3 On any failure (frontmatter parse, Zod issue, missing/out-of-order section), throw `PersonaFileMalformedError` (new — see Task 6). Do NOT throw `CatalogueShapeError` — personas and catalogue files are sibling shapes; mixing error types makes downstream classification harder.
  - [ ] 2.4 Export `renderPersonaFile(opts: { catalogue: CatalogueRole; hiredAt: string; catalogueVersion: string }): string`. Pure renderer — no IO, no clock. Returns the full file contents (frontmatter `---` block + five sections in canonical order, with `## Knowledge` body as the empty string). The renderer is the only place persona-file YAML is serialised; `instantiatePersona` calls it. Tests assert byte-equality between catalogue source `Domain`/`Mandate`/`Out of mandate`/`Prompt` and the rendered persona's same four sections.
  - [ ] 2.5 YAML serialisation must use the `yaml` library's `stringify` (already a dep — used by `workspace-resolver.ts` line 3). Preserve key order: `role`, `domain`, `model_tier`, `tools_allow`, `gh_allow`, `locked_phrases`, `hired_at`, `catalogue_version`. Persona-only keys go last. `yaml`'s default options produce block-style sequences and scalar strings without quotes where unambiguous — that matches the catalogue's on-disk style (see `plugins/crew/catalogue/planner.md` lines 1–15). Do NOT hand-roll YAML.

- [ ] **Task 3 — Implement `readCatalogue` tool (AC: 5)**
  - [ ] 3.1 Create `plugins/crew/mcp-server/src/tools/read-catalogue.ts`. New file. Pattern after `plugins/crew/mcp-server/src/tools/get-status.ts`: a pure compute function `readCatalogue(opts: { pluginRoot: string; role: string }): Promise<CatalogueRole>` plus a thin MCP wrapper. `pluginRoot` flows in as a parameter (matches `loadRolePermissions`'s contract — no `process.cwd()` reads).
  - [ ] 3.2 Resolve `<pluginRoot>/catalogue/<role>.md`. Read with `fs.readFile` (read-only — managed-fs is not required for reads). Throw `CatalogueRoleNotFoundError` (new — Task 6) on ENOENT. Other IO errors propagate.
  - [ ] 3.3 Parse with `parseCatalogueRole` (Story 2.1's existing helper at `plugins/crew/mcp-server/src/lib/markdown-frontmatter.ts`). Return the parsed `CatalogueRole`. Do NOT re-implement the parser.
  - [ ] 3.4 No telemetry emit (NFR21 — telemetry is for runtime agent events, not synchronous reads from the catalogue boundary). Story 1.5's logger is not invoked here.

- [ ] **Task 4 — Implement `instantiatePersona` tool (AC: 1, 5)**
  - [ ] 4.1 Create `plugins/crew/mcp-server/src/tools/instantiate-persona.ts`. New file. The function signature is `instantiatePersona(opts: { pluginRoot: string; targetRepoRoot: string; role: string; clock?: () => Date; pluginVersion?: string }): Promise<{ path: string }>`. `clock` and `pluginVersion` are test seams (default to `() => new Date()` and `getPluginVersion()`).
  - [ ] 4.2 Resolve the catalogue role via `readCatalogue({ pluginRoot, role })`. Propagate `CatalogueRoleNotFoundError`.
  - [ ] 4.3 Compute `personaPath = path.join(targetRepoRoot, "team", role, "PERSONA.md")`. Check existence with `fs.stat`. If the file exists, throw `PersonaAlreadyExistsError` (new — Task 6) carrying `role`, `personaPath`. **Do NOT silently overwrite** — re-hire-on-existing-team is Story 2.4 / FR90's contract (`/hire` re-run shows hire-one-more / unhire / view-persona actions), not this tool's. The tool exposes a pure create-or-fail contract; the hire skill wraps it.
  - [ ] 4.4 Compute `hiredAt = clock().toISOString()` (`Date.prototype.toISOString` returns `YYYY-MM-DDTHH:mm:ss.sssZ` — matches the regex in Task 1.2). Compute `catalogueVersion = pluginVersion ?? getPluginVersion()`.
  - [ ] 4.5 Call `renderPersonaFile({ catalogue, hiredAt, catalogueVersion })` to produce the file contents.
  - [ ] 4.6 Write via `writeManagedFile` (from `plugins/crew/mcp-server/src/lib/managed-fs.ts`):
    ```ts
    await writeManagedFile({
      absPath: personaPath,
      contents,
      targetRepoRoot,
      mcpToolContext: { toolName: "instantiatePersona", role },
    });
    ```
    The `team/**` glob is in `CANONICAL_PATH_GLOBS` (line 20 of managed-fs.ts) — without `mcpToolContext`, `writeManagedFile` throws `CanonicalFsWriteError`. Pass it.
  - [ ] 4.7 Return `{ path: personaPath }`. No telemetry emit in v1 (Story 1.5's logger is wired for state-machine + verdict events; `persona.append` is a planned event type for `appendPersonaKnowledge` in Epic 3, not `persona.create`). If a future story wants a `persona.create` event, that is a follow-up.
  - [ ] 4.8 **Idempotency note:** the create-or-fail contract above means `/skip-hiring` (Story 2.5) and `/hire` (Story 2.4) must check `readPersona` or filesystem presence before calling `instantiatePersona`. That is acceptable — the dispatching skills own re-entry semantics; this tool stays simple.

- [ ] **Task 5 — Implement `readPersona` and `lookupRoleByDomain` tools (AC: 2, 3, 5)**
  - [ ] 5.1 Create `plugins/crew/mcp-server/src/tools/read-persona.ts`. New file. Signature `readPersona(opts: { targetRepoRoot: string; role: string }): Promise<PersonaFile>`. Resolves `<targetRepoRoot>/team/<role>/PERSONA.md`. `fs.readFile`. On ENOENT throw `PersonaFileNotFoundError` (new — Task 6). Parse with `parsePersonaFile`. Return.
  - [ ] 5.2 Create `plugins/crew/mcp-server/src/tools/lookup-role-by-domain.ts`. New file. Signature `lookupRoleByDomain(opts: { targetRepoRoot: string; domain: string }): Promise<{ role: string | null }>`. Algorithm:
    1. `teamDir = path.join(targetRepoRoot, "team")`. If the directory does not exist (`fs.stat` ENOENT), return `{ role: null }`. No team hired yet is a valid state.
    2. `readdir(teamDir)` to list role subdirs. Filter out `custom` (Story 2.5's escape hatch — not in v1's lookup), `_archived` (FR107 — archived personas are not routing candidates), and any entry that is not a directory (`fs.stat` filter).
    3. For each remaining `<role>` directory, attempt `readPersona({ targetRepoRoot, role })`. On `PersonaFileNotFoundError` (a stray empty `team/<role>/` dir with no PERSONA.md), skip silently. On `PersonaFileMalformedError`, propagate — a corrupt persona must not be invisibly excluded from routing.
    4. Collect `(role, domain)` pairs. Find exact-match for `opts.domain` (`===` string comparison after `yaml`'s default parse trimming — no additional trimming, no case-folding). Return the matching `role` or `null`.
    5. If two persona files share a `domain:` (a corruption state — Story 2.1's catalogue-side AC3 forbids domain collisions across the catalogue, but a hand-edited persona could introduce one), return the **first encountered** role and emit no telemetry. Document this with a `// NOTE:` comment naming Story 2.1 AC3 as the upstream contract; in v1 this is acceptable, Epic 3 may surface a routing-ambiguity diagnostic.
  - [ ] 5.3 Neither tool is a writer; neither calls `writeManagedFile`. `readPersona` is `fs.readFile` only; `lookupRoleByDomain` is `fs.readdir` + repeated `readPersona`. No caching — every call re-walks (NFR28: pure file reads; no LLM in the loop). Performance is acceptable at v1's team size (5–10 roles).

- [ ] **Task 6 — Author the four new error classes (AC: 1, 2, 5)**
  - [ ] 6.1 Append to `plugins/crew/mcp-server/src/errors.ts`. Mirror the existing pattern (one class per named failure mode, `code` string, structured constructor opts):
    ```ts
    export class CatalogueRoleNotFoundError extends DomainError {
      readonly role: string;
      readonly cataloguePath: string;
      constructor(opts: { role: string; cataloguePath: string }) {
        super(`Unknown catalogue role '${opts.role}': no file at ${opts.cataloguePath}. ` +
              `See plugins/crew/catalogue/ for the v1 roster.`);
        this.role = opts.role;
        this.cataloguePath = opts.cataloguePath;
      }
    }

    export class PersonaAlreadyExistsError extends DomainError {
      readonly role: string;
      readonly personaPath: string;
      constructor(opts: { role: string; personaPath: string }) {
        super(`Role '${opts.role}' is already hired at ${opts.personaPath}. ` +
              `Use /hire to view, unhire, or hire-one-more — re-instantiating is not idempotent.`);
        this.role = opts.role;
        this.personaPath = opts.personaPath;
      }
    }

    export class PersonaFileNotFoundError extends DomainError {
      readonly role: string;
      readonly personaPath: string;
      constructor(opts: { role: string; personaPath: string }) {
        super(`No persona file for role '${opts.role}' at ${opts.personaPath}. ` +
              `Run /hire to create one.`);
        this.role = opts.role;
        this.personaPath = opts.personaPath;
      }
    }

    export class PersonaFileMalformedError extends DomainError {
      readonly personaPath: string;
      readonly zodMessage: string;
      constructor(opts: { personaPath: string; zodMessage: string }) {
        super(`Persona file at ${opts.personaPath} is malformed: ${opts.zodMessage}. ` +
              `Persona files are plain Markdown — fix by hand or git-revert.`);
        this.personaPath = opts.personaPath;
        this.zodMessage = opts.zodMessage;
      }
    }
    ```
    Add `code` getters if the existing class pattern uses them (check `CatalogueShapeError` — Story 2.1's test asserts `code === "CATALOGUE_SHAPE_ERROR"`). Follow the same pattern: `code = "PERSONA_ALREADY_EXISTS"`, etc.
  - [ ] 6.2 Do NOT add a generic `PersonaError` base — the existing hierarchy is flat under `DomainError` (see `RolePermissionsMissingError` / `RolePermissionsMalformedError` as sibling pattern). Match it.

- [ ] **Task 7 — Wire the four tools into the dispatcher (AC: 1, 2, 3, 5)**
  - [ ] 7.1 Edit `plugins/crew/mcp-server/src/tools/register.ts`. Add four `server.registerTool({...})` calls after the existing `getStatus` registration. Each tool:
    - `name`: camelCase verb-noun, matching the architecture's MCP-tool naming convention (§4 of implementation-patterns-consistency-rules.md). Names are `readCatalogue`, `instantiatePersona`, `readPersona`, `lookupRoleByDomain`.
    - `description`: one sentence, names the FR reference (FR82–83 for `readCatalogue`, FR89 for `instantiatePersona`, FR93 for `readPersona`, FR99 for `lookupRoleByDomain`).
    - `inputSchema`: JSON Schema `{ type: "object", properties: { ... }, required: [...] }`. Match the per-tool function signature.
    - `handler`: thin wrapper — parse `args` with `z.object({...}).parse(args)`, call the compute function, return `{ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }`. Mirror `getStatus`'s pattern.
  - [ ] 7.2 The `pluginRoot` parameter for `readCatalogue` and `instantiatePersona` needs to flow in from somewhere. The MCP dispatcher does NOT inject `pluginRoot`. Options:
    - **(Preferred)** The handler computes `pluginRoot` from `import.meta.url` walking up to the plugin root, mirroring how `loadRolePermissions` callers obtain it. Add a one-line helper in `plugins/crew/mcp-server/src/lib/plugin-root.ts` (new — see also Task 7.3).
    - The skill (Story 2.4) passes `pluginRoot` as a tool argument. Reject this option — it leaks an internal path through the operator-facing surface.
    Recommendation: implement option 1. The helper is `export function getPluginRoot(): string { return path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", ".."); }` (resolves `src/lib/plugin-root.ts` → `plugins/crew/`). One module, one export, one-line body. Test covers it via the integration harness asserting `readCatalogue` finds shipped files.
  - [ ] 7.3 Create `plugins/crew/mcp-server/src/lib/plugin-root.ts` per Task 7.2. Add a unit assertion in the new integration test (Task 9) that `getPluginRoot()` returns the expected absolute path ending in `plugins/crew`.
  - [ ] 7.4 The `_meta.role` permissions gate (server.ts lines 116–146) already enforces `tools_allow` — the four new tool names must be added to every role's `permissions/<role>.yaml` that needs to call them (Task 8). Without that, any role calling `instantiatePersona` will see a `PermissionDeniedError`.

- [ ] **Task 8 — Update per-role permission YAMLs (AC: 1, 5)**
  - [ ] 8.1 Open `plugins/crew/permissions/hiring-manager.yaml`. The hiring manager is the **only** role in v1 that should be able to call `readCatalogue`, `instantiatePersona`, `readPersona`, and `lookupRoleByDomain` — it owns the hiring conversation. Replace its `tools_allow` from `[heartbeat]` (Story 2.2 default) to `[heartbeat, readCatalogue, instantiatePersona, readPersona, lookupRoleByDomain]`. Five entries.
  - [ ] 8.2 Open `plugins/crew/permissions/orchestrator.yaml`. The orchestrator routes yields via FR99 (`lookupRoleByDomain`) and may need to read personas to assemble the locked-phrase routing-failure surface. Add `readPersona` and `lookupRoleByDomain` to its `tools_allow`. Final list: `[getStatus, recordYield, heartbeat, readPersona, lookupRoleByDomain]`.
  - [ ] 8.3 Do NOT add the new tools to any other role's `tools_allow`. `planner`, `generalist-dev`, `generalist-reviewer`, `retro-analyst`, and the four specialists do not need persona-write or domain-lookup access in v1. If Epic 3 (yield protocol) determines `generalist-dev` needs `lookupRoleByDomain` to surface yield destinations, that is an Epic 3 change to `permissions/generalist-dev.yaml`, not a Story 2.3 change.
  - [ ] 8.4 The catalogue-side `tools_allow` (e.g. `Read, Edit, Bash` in `catalogue/hiring-manager.md`) is a **different allowlist at a different boundary** (Claude Code agent primitives, not MCP tools — see Story 2.2 § "This story does NOT" clause (i)). Do NOT modify `plugins/crew/catalogue/*.md`. The catalogue is the source of truth for that allowlist.
  - [ ] 8.5 The Story 2.2 parity test `permissions-catalogue-parity.test.ts` asserts `gh_allow` parity between catalogue and permissions, not `tools_allow` parity. Adding MCP tool names to `permissions/<role>.yaml` does NOT trigger the parity assertion. Verify by running `pnpm --dir plugins/crew test` after the YAML edits — `permissions-catalogue-parity.test.ts` must still pass.

- [ ] **Task 9 — Author the integration test (AC: 1, 2, 3, 4, 5)**
  - [ ] 9.1 Create `plugins/crew/mcp-server/tests/persona-machinery.test.ts`. New file. Pattern after `plugins/crew/mcp-server/tests/get-status.test.ts` for the temp-dir target-repo idiom and after `plugins/crew/mcp-server/tests/catalogue-shape.test.ts` for the for-each-role loop.
  - [ ] 9.2 Create temp-dir fixtures with `os.tmpdir()` + `fs.mkdtemp` per test (matches `get-status.test.ts`'s pattern). Clean up in `afterEach`. The fixture is empty except for the `team/` directory tree the tests create.
  - [ ] 9.3 **AC1 / AC5(a, b):** For each of the ten catalogue roles, call `instantiatePersona({ pluginRoot: getPluginRoot(), targetRepoRoot: TMP, role, clock: () => new Date("2026-06-01T12:00:00.000Z"), pluginVersion: "0.1.0" })`. Assert:
    - The file exists at `<TMP>/team/<role>/PERSONA.md`.
    - `parsePersonaFile` parses it cleanly.
    - Frontmatter has `role === <role>`, `hired_at === "2026-06-01T12:00:00.000Z"`, `catalogue_version === "0.1.0"`.
    - Frontmatter `domain`, `model_tier`, `tools_allow`, `gh_allow`, `locked_phrases` match the corresponding catalogue file byte-for-byte (parse the catalogue with `parseCatalogueRole` and compare).
    - Sections `Domain`, `Mandate`, `Out of mandate`, `Prompt` match the catalogue sections byte-for-byte.
    - Section `Knowledge` is the empty string (`""`).
  - [ ] 9.4 **AC2 / AC5(c):** For one representative role (`planner`), call `readPersona` after instantiation. Assert deep-equality between the returned object and the parse of the on-disk file. Assert `sourcePath` is the absolute persona path.
  - [ ] 9.5 **AC3 / AC5(d):** Hire three roles (`planner`, `generalist-dev`, `generalist-reviewer`). Read their `domain:` strings from the catalogue (call `parseCatalogueRole` on each). For each domain, call `lookupRoleByDomain({ targetRepoRoot: TMP, domain })` and assert it returns the matching role id. Call once with `"never-a-real-domain"` and assert `{ role: null }`.
  - [ ] 9.6 **AC4 / AC5(e):** After hiring `planner`, append a line `"Always read the discipline rules first."` under the persona file's `## Knowledge` section using `fs.appendFile` (NOT `writeManagedFile` — the test is simulating an operator editing the file outside the MCP boundary, which is permitted because the file is plain Markdown owned by the user; `writeManagedFile`'s guard is for in-process agents, not human edits). Call `readPersona` again. Assert the returned `sections.Knowledge` contains the appended line.
  - [ ] 9.7 **AC5(f):** Call `instantiatePersona` with an unknown role (`"not-a-real-role"`). Assert `CatalogueRoleNotFoundError` is thrown with `role === "not-a-real-role"`. Call `instantiatePersona` twice with the same role (`planner`); assert the second call throws `PersonaAlreadyExistsError` with `role === "planner"` and `personaPath` equal to the existing path.
  - [ ] 9.8 **Lookup edge cases:** Hire `planner`, then create an empty stray directory `<TMP>/team/empty-role/` (no PERSONA.md inside). Assert `lookupRoleByDomain` returns `{ role: null }` for an absent domain and does not throw — the stray directory is silently skipped (Task 5.2 step 3). Create a malformed `team/broken-role/PERSONA.md` (truncated frontmatter); assert `lookupRoleByDomain` throws `PersonaFileMalformedError` (Task 5.2 step 3 — corrupt personas surface, not silently skipped).
  - [ ] 9.9 Test file header MUST cite this story (`Story 2.3 AC1–AC5`) and reference `plugins/crew/docs/user-surface-acs.md`, mirroring the comment-header convention used in `catalogue-shape.test.ts` and `permissions-catalogue-parity.test.ts`.
  - [ ] 9.10 Run `pnpm --dir plugins/crew test`. Expected: existing suites still pass; one new file passes. Suite count grows by one.

- [ ] **Task 10 — Build & dist verification (AC: 5)**
  - [ ] 10.1 Run `pnpm --dir plugins/crew/mcp-server build`. `tsc` must compile cleanly. New source files: `schemas/persona.ts`, `lib/persona-file.ts`, `lib/plugin-root.ts`, `tools/read-catalogue.ts`, `tools/instantiate-persona.ts`, `tools/read-persona.ts`, `tools/lookup-role-by-domain.ts`; modified: `tools/register.ts`, `errors.ts`. All under `src/`. All produce `dist/` siblings.
  - [ ] 10.2 Per `plugins/crew/docs/README-install.md` § Build artefacts and Story 1.9's contract, the built `mcp-server/dist/` tree is committed. **This story DOES add source files under `src/`** — so `dist/` will diff. Commit `dist/` in the same commit as `src/`. `ci-drift-check.test.ts` enforces src-vs-dist alignment — it must pass after `pnpm build`.
  - [ ] 10.3 The seven YAML files modified under `permissions/` (only `hiring-manager.yaml` and `orchestrator.yaml` change in this story — Task 8.1, 8.2) are static assets shipped as-is via `/plugin install`'s file-copy semantics. No bundling step.

- [ ] **Task 11 — Verify no other story's contract drifted (AC: 1–5)**
  - [ ] 11.1 Confirm `plugins/crew/mcp-server/src/schemas/catalogue.ts` is unchanged. The shipped schema is the source of truth for catalogue-side fields.
  - [ ] 11.2 Confirm `plugins/crew/mcp-server/src/schemas/role-permissions.ts` is unchanged. The shipped schema accepts arbitrary MCP tool names in `tools_allow` (`z.array(z.string().min(1)).min(1)`); no schema change is needed to admit the four new names.
  - [ ] 11.3 Confirm `plugins/crew/mcp-server/src/lib/markdown-frontmatter.ts` is unchanged. `splitFrontmatter` and `parseCatalogueRole` are reused, not modified.
  - [ ] 11.4 Confirm `plugins/crew/mcp-server/src/lib/managed-fs.ts` is unchanged. `CANONICAL_PATH_GLOBS` already covers `team/**` (line 20); `writeManagedFile` already supports `mcpToolContext`; nothing in this story requires a managed-fs change.
  - [ ] 11.5 Confirm `plugins/crew/catalogue/*.md` is unchanged. The catalogue is the source of truth; the persona renderer copies from it verbatim.
  - [ ] 11.6 Confirm `plugins/crew/permissions/{hiring-manager,orchestrator}.yaml` are the **only** permission YAMLs modified. No other role gets the four new tool names in v1 (Task 8.3).
  - [ ] 11.7 Confirm no slash command file (`plugins/crew/skills/*.md`) is added or modified. This story has zero operator-facing surface.

---

## Dev Notes

### Critical context: what was shipped before, what this story builds on

- **Story 1.1** scaffolded the plugin tree including `mcp-server/src/{schemas,state,tools,lib}/`.
- **Story 1.4** shipped the MCP dispatcher (`server.ts`), `RolePermissionsSchema`, `loadRolePermissions`, and the `tools_allow` enforcement at the dispatcher boundary. **This story registers four new tools through `registerAllTools` (`tools/register.ts`) so the dispatcher knows about them; without that registration, calls land on the "Unknown tool" error path.**
- **Story 1.5** shipped `lib/logger.ts` (pino → JSONL). This story emits no telemetry — persona creation is not a runtime agent event in v1. The architecture's persona-event types (`persona.append`) are for Epic 3's `appendPersonaKnowledge`.
- **Story 1.6** shipped `lib/managed-fs.ts` with `writeManagedFile` and the `CANONICAL_PATH_GLOBS` list. **`team/**` is already in that list (line 20) — `instantiatePersona` must pass `mcpToolContext` or `writeManagedFile` will throw `CanonicalFsWriteError`.**
- **Story 1.7** shipped `getStatus` and the `tools/register.ts` registration pattern. **This story extends `register.ts` by four entries.** The smoke test (`acceptance.test.ts` AC3) asserts that a bare `createServer()` registers zero tools — `registerAllTools` is the one entry point. Do NOT register tools elsewhere.
- **Story 1.8** added the user-surface AC tag and pre-PR smoke gate. **Story 2.3 has zero `user-surface` ACs** (judgement: see AC table header above and the `<!-- user-surface: ... -->` comments on every AC). The gate parses the spec, finds no `(user-surface)`-tagged ACs, and exits 0 with `{"status":"skipped"}` per `plugins/crew/docs/user-surface-acs.md` § "How the gate uses this" step 2. No operator-paste-output step is required for this story's PR.
- **Story 1.9** committed `mcp-server/dist/`. **This story DOES modify `src/` — `dist/` must be rebuilt and committed in the same change.** `ci-drift-check.test.ts` enforces alignment.
- **Story 2.1** shipped the ten catalogue files plus `CatalogueRoleSchema`, `REQUIRED_CATALOGUE_SECTIONS`, `assertCatalogueBodySections`, `splitFrontmatter`, and `parseCatalogueRole`. **This story reuses every one of these — `PersonaFileSchema` extends the catalogue frontmatter, `parsePersonaFile` reuses `splitFrontmatter` and `assertCatalogueBodySections`, `instantiatePersona` reads via `parseCatalogueRole`, and the persona renderer copies the catalogue's four sections verbatim.**
- **Story 2.2** shipped ten `permissions/<role>.yaml` files plus `gh-error-map.yaml`. **This story modifies two of them (`hiring-manager.yaml`, `orchestrator.yaml`) to add the four new tool names to their `tools_allow`. The Story 2.2 parity test asserts `gh_allow` parity, not `tools_allow` parity, so adding MCP tool names does not break it.**

### Architecture references (load these first, dev agent)

- `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` §3 (Catalogue & Persona File Shape) — defines the persona file as catalogue shape + `hired_at` + `catalogue_version` + `## Knowledge`. The five-section persona body skeleton is pinned here.
- `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` §4 (MCP Tool Naming) — camelCase verb-noun, flat namespace, mutators start with a mutation verb, readers start with `get`/`list`/`lookup`/`compute`. `readCatalogue`, `instantiatePersona`, `readPersona`, `lookupRoleByDomain` all comply.
- `_bmad-output/planning-artifacts/architecture/project-structure-boundaries.md` lines 78–81 — pins the four tool filenames (`read-catalogue.ts`, `instantiate-persona.ts`, `read-persona.ts`, `lookup-role-by-domain.ts`) and their FR references (FR82–FR83, FR89, FR93, FR99).
- `_bmad-output/planning-artifacts/architecture/project-structure-boundaries.md` lines 162–170 — pins the target-repo `team/` tree: one subdir per role with `PERSONA.md`, plus `_archived/` and `custom/` siblings that this story's `lookupRoleByDomain` filters out.
- `_bmad-output/planning-artifacts/architecture/core-architectural-decisions.md` lines 78–81 — Persona injection (dev/reviewer assembles subagent system prompt from catalogue Prompt + persona Knowledge) and the persona-update gate (Knowledge appends go through `<persona>/.proposed.md` and `accept-proposal` — **out of scope for this story**, but informs why `Knowledge` starts empty).
- `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md` FR89 (persona instantiation contract), FR90 (re-entry actions — Story 2.4's mandate, but this story's `PersonaAlreadyExistsError` is the seam the re-entry skill checks against), FR93 (read-persona), FR96 / FR97 (text-editor edit + git-revert affordances), FR98 / FR99 (domain field + domain lookup).
- `_bmad-output/planning-artifacts/prd-crew-v1/non-functional-requirements.md` NFR25 (plain-Markdown readability), NFR27 (git-revert integrity), NFR28 (no-LLM-in-the-loop for team observability — `lookupRoleByDomain` and `readPersona` are pure file reads).
- `plugins/crew/docs/user-surface-acs.md` — for confirming the `user-surface` judgement above.

### Files this story creates (NEW)

- `plugins/crew/mcp-server/src/schemas/persona.ts` — `PersonaFrontmatterSchema`, `REQUIRED_PERSONA_SECTIONS`, `PersonaFile` type.
- `plugins/crew/mcp-server/src/lib/persona-file.ts` — `parsePersonaFile`, `renderPersonaFile`.
- `plugins/crew/mcp-server/src/lib/plugin-root.ts` — `getPluginRoot()` helper for tool handlers (see Task 7.2).
- `plugins/crew/mcp-server/src/tools/read-catalogue.ts` — `readCatalogue` compute function.
- `plugins/crew/mcp-server/src/tools/instantiate-persona.ts` — `instantiatePersona` compute function.
- `plugins/crew/mcp-server/src/tools/read-persona.ts` — `readPersona` compute function.
- `plugins/crew/mcp-server/src/tools/lookup-role-by-domain.ts` — `lookupRoleByDomain` compute function.
- `plugins/crew/mcp-server/tests/persona-machinery.test.ts` — integration harness for AC5.
- `plugins/crew/mcp-server/dist/**` — rebuild output. Commit per Story 1.9's contract.

### Files this story MAY modify (UPDATE, with care)

- `plugins/crew/mcp-server/src/tools/register.ts` — append four `server.registerTool({...})` calls after the existing `getStatus` entry. Do not refactor the existing entry. Do not add an extraction helper unless the file exceeds 200 lines (it will not).
- `plugins/crew/mcp-server/src/errors.ts` — append four new error classes (`CatalogueRoleNotFoundError`, `PersonaAlreadyExistsError`, `PersonaFileNotFoundError`, `PersonaFileMalformedError`). Do not modify any existing class. Do not reorder.
- `plugins/crew/permissions/hiring-manager.yaml` — expand `tools_allow` from `[heartbeat]` to `[heartbeat, readCatalogue, instantiatePersona, readPersona, lookupRoleByDomain]`. Leave `gh_allow` and `gh_allow_args` unchanged.
- `plugins/crew/permissions/orchestrator.yaml` — expand `tools_allow` from `[getStatus, recordYield, heartbeat]` to `[getStatus, recordYield, heartbeat, readPersona, lookupRoleByDomain]`. Leave `gh_allow` and `gh_allow_args` unchanged.

### Files this story MUST NOT modify

- `_bmad-output/implementation-artifacts/sprint-status.yaml` (orchestrator owns).
- `plugins/crew/catalogue/*.md` — Story 2.1 is the source of truth. Persona renderer copies, never edits.
- `plugins/crew/mcp-server/src/schemas/catalogue.ts` — shipped schema is sufficient.
- `plugins/crew/mcp-server/src/schemas/role-permissions.ts` — shipped schema admits the new tool names as-is.
- `plugins/crew/mcp-server/src/lib/markdown-frontmatter.ts` — reused, not modified.
- `plugins/crew/mcp-server/src/lib/managed-fs.ts` — `CANONICAL_PATH_GLOBS` already covers `team/**`; `writeManagedFile` already supports `mcpToolContext`.
- `plugins/crew/mcp-server/src/state/load-role-permissions.ts` — unchanged; reads any YAML the schema admits.
- `plugins/crew/mcp-server/src/server.ts` — dispatcher behaviour is correct; the four new tools register through `registerAllTools` without any dispatcher change.
- `plugins/crew/mcp-server/tests/permissions-enforcement.test.ts` and `plugins/crew/mcp-server/tests/permissions-catalogue-parity.test.ts` — Story 2.2 tests pass as-is. The `tools_allow` expansions in Task 8 do not change `gh_allow` (the only thing the parity test asserts).
- `plugins/crew/permissions/{generalist-dev,generalist-reviewer,planner,retro-analyst,security-specialist,test-specialist,docs-specialist,debugger,gh-error-map}.yaml` — out of scope. v1 routes persona-tool access through `hiring-manager` (creator) and `orchestrator` (router) only.
- `plugins/crew/skills/*` — no slash command surface here.
- `plugins/crew/docs/README-install.md` — operator does not see persona files during install.
- Root `README.md`.

### Persona file rendered shape (canonical example for `planner`)

The renderer (`renderPersonaFile`, Task 2.4) produces this on-disk shape — included here so the dev agent can byte-compare against the test's expected output. Frontmatter values for `domain`, `model_tier`, `tools_allow`, `gh_allow`, `locked_phrases` and the four body sections are copied verbatim from `plugins/crew/catalogue/planner.md`:

```markdown
---
role: planner
domain: "story authoring and acceptance criteria"
model_tier: sonnet
tools_allow:
  - Read
  - Edit
  - Task
gh_allow:
  - pr-view
locked_phrases:
  handoff: "Handoff to generalist-dev — story <story-id> ready to claim"
  yield: "This sits in <role>'s domain — handing off"
  verdict: "**Verdict: <SENTINEL>**"
hired_at: 2026-06-01T12:00:00.000Z
catalogue_version: 0.1.0
---

# Planner

## Domain

Owns the backlog: drives the planning conversation, shapes source stories against the planning-discipline rules, and keeps the ready queue primed so generalist-dev never starves.

## Mandate

- Run the planning conversation: extract requirements, surface ambiguity, sequence the next batch of stories.
- Shape source stories that satisfy the five planning-discipline rules (clear AC, no compound stories, no premature optimisation, dependencies declared, risk tier tagged).
- Re-shape stories that came back with a NEEDS CHANGES verdict citing a planning issue.
- Keep the ready queue stocked relative to the dev loop's drain rate.

## Out of mandate

- Implementing the story — hand off to generalist-dev.
- Reviewing the resulting PR — hand off to generalist-reviewer.
- Mutating the catalogue or persona-knowledge sections.

## Prompt

You are the planner. You own the backlog. Your loop: read the project's standards and the user's intent, shape stories that satisfy the five planning-discipline rules, sequence them, and keep the ready queue primed. When generalist-dev draws a story, you are done with it unless a verdict cites a planning failure — in which case you re-shape and re-queue.

Surface ambiguity early. Refuse to ship compound stories. Tag risk tier. Declare dependencies. If a story belongs to another role's domain (security, docs, debugger, test), yield with the locked phrase and let the hiring conversation surface that gap if the specialist isn't hired yet.

## Knowledge
```

Notes on the example:
- `# Planner` (the H1 display name) is copied from the catalogue. The catalogue's H1 is the role's display name; the renderer preserves it.
- `## Knowledge` is the literal final heading; its body is empty (zero lines after the heading). The Story 2.4 / Epic 3 `appendPersonaKnowledge` flow appends lines under this heading; for hire time it stays empty.
- Newline at EOF: yes — match the catalogue file convention (Story 2.1's files end with a single `\n`).

### Domain-routing contract (`lookupRoleByDomain`)

- **Exact match only.** No fuzzy matching, no case-folding, no Levenshtein, no embeddings. `"story authoring and acceptance criteria" === "Story authoring..."` returns null because the leading `S` differs.
- **Domain collision handling.** Story 2.1 AC3 forbids domain collisions across catalogue files. A persona file with a hand-edited domain that collides with another hired persona is a corruption state. `lookupRoleByDomain` returns the **first encountered** role (filesystem traversal order — i.e., whatever `fs.readdir` yields, which is OS-dependent). v1 ships this behaviour; Epic 3 may add a routing-ambiguity diagnostic. Document the `// NOTE:` per Task 5.2 step 5.
- **`team/custom/` exclusion.** Story 2.5's escape hatch lives at `<target-repo>/team/custom/<role>.md` (note: file at the directory level, not `<role>/PERSONA.md`). v1's `lookupRoleByDomain` does NOT walk it. Custom-role routing is Story 2.5's mandate.
- **`team/_archived/` exclusion.** FR107's team-change flow archives unhired personas to `<target-repo>/team/_archived/<role>/PERSONA.md`. v1's `lookupRoleByDomain` does NOT walk it.

### MCP tool input/output JSON shapes (for `register.ts`)

```jsonc
// readCatalogue
{ "inputSchema": { "type": "object", "properties": { "role": { "type": "string" } }, "required": ["role"] } }
// Returns: { content: [{ type: "text", text: JSON.stringify(CatalogueRole) }] }

// instantiatePersona
{ "inputSchema": { "type": "object", "properties": {
    "targetRepoRoot": { "type": "string" },
    "role": { "type": "string" }
  }, "required": ["targetRepoRoot", "role"] } }
// Returns: { content: [{ type: "text", text: JSON.stringify({ path: "<abs-persona-path>" }) }] }

// readPersona
{ "inputSchema": { "type": "object", "properties": {
    "targetRepoRoot": { "type": "string" },
    "role": { "type": "string" }
  }, "required": ["targetRepoRoot", "role"] } }
// Returns: { content: [{ type: "text", text: JSON.stringify(PersonaFile) }] }

// lookupRoleByDomain
{ "inputSchema": { "type": "object", "properties": {
    "targetRepoRoot": { "type": "string" },
    "domain": { "type": "string" }
  }, "required": ["targetRepoRoot", "domain"] } }
// Returns: { content: [{ type: "text", text: JSON.stringify({ role: "<id>" | null }) }] }
```

The `JSON.stringify(..., null, 2)` indentation matches `getStatus`'s tool output style (no indent vs indent is a style choice — pick indent, it matches what `get-status.ts` does at line 32 if changed, but the existing `get-status.ts` uses a plain string formatter, not JSON). Recommendation: use `JSON.stringify(result)` (compact) — Story 2.4's skill consumes via `JSON.parse`, indentation is irrelevant.

### Testing standards

- **Framework:** vitest, already configured (`plugins/crew/mcp-server/vitest.config.ts`).
- **Test placement:** `plugins/crew/mcp-server/tests/persona-machinery.test.ts` — matches the flat tests/ layout.
- **Temp-dir target repos:** `os.tmpdir()` + `fs.mkdtemp("crew-persona-")`; clean up in `afterEach`. Match `get-status.test.ts`'s pattern (it creates `.crew/config.yaml` in a temp dir).
- **Pure clock:** `instantiatePersona` accepts a `clock` test seam (Task 4.1). Tests inject `() => new Date("2026-06-01T12:00:00.000Z")` for deterministic `hired_at`. Do NOT use `vi.useFakeTimers()` — the seam is simpler and matches the existing dependency-injection style.
- **No skips, no `.only`, no `.todo`.**
- **Diagnostics on failure** must name the role, the persona path, and (where relevant) the Zod issue. Story 2.2's parity test is a model — copy its diagnostic discipline.
- **Reuse, don't reinvent:** `parseCatalogueRole`, `splitFrontmatter`, `assertCatalogueBodySections`, `writeManagedFile`, `getPluginVersion`, `loadRolePermissions` (for the permission allowlist test, if added). Do NOT add a new YAML parser. Do NOT duplicate frontmatter-splitting logic.

### Project Structure Notes

- All paths follow `_bmad-output/planning-artifacts/architecture/project-structure-boundaries.md` exactly. Persona files at `<target-repo>/team/<role>/PERSONA.md` (lines 162–170). MCP tools at `mcp-server/src/tools/*.ts` (lines 78–81). Schemas at `mcp-server/src/schemas/persona.ts` (line 90).
- `team/**` is in `CANONICAL_PATH_GLOBS` (`mcp-server/src/lib/managed-fs.ts` line 20). `instantiatePersona` is the only writer in v1.
- No new architectural boundary is introduced. The MCP server remains the only canonical-state boundary for `team/`.

### References

- [Source: `_bmad-output/planning-artifacts/epics/epic-2-team-formation-hiring-personas-and-team-observability.md#Story 2.3: Persona-file machinery and persona MCP tools`] — verbatim epic ACs.
- [Source: `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md#FR89`] — persona instantiation contract.
- [Source: `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md#FR90`] — re-entry actions (Story 2.4 — informs `PersonaAlreadyExistsError`).
- [Source: `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md#FR93`] — read-persona contract.
- [Source: `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md#FR96`] — text-editor edit affordance.
- [Source: `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md#FR97`] — git-revert integrity.
- [Source: `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md#FR98`] — domain field declared on each role.
- [Source: `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md#FR99`] — exact-match domain routing.
- [Source: `_bmad-output/planning-artifacts/prd-crew-v1/non-functional-requirements.md#NFR25`] — plain-Markdown persona readability.
- [Source: `_bmad-output/planning-artifacts/prd-crew-v1/non-functional-requirements.md#NFR27`] — git-revert persona integrity.
- [Source: `_bmad-output/planning-artifacts/prd-crew-v1/non-functional-requirements.md#NFR28`] — no LLM in the loop for team observability.
- [Source: `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md#3. Catalogue & Persona File Shape`] — canonical persona shape (catalogue + `hired_at` + `catalogue_version` + `## Knowledge`).
- [Source: `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md#4. MCP Tool Naming`] — camelCase verb-noun, flat namespace.
- [Source: `_bmad-output/planning-artifacts/architecture/project-structure-boundaries.md#Plugin tree`] — tool filenames and FR mappings.
- [Source: `_bmad-output/planning-artifacts/architecture/project-structure-boundaries.md#Target-repo tree (BMad-shaped example)`] — `team/<role>/PERSONA.md` placement, `_archived/` and `custom/` siblings.
- [Source: `_bmad-output/planning-artifacts/architecture/core-architectural-decisions.md#Persona injection`] — system-prompt assembly (informs Story 2.4 / 2.7; out of scope here but contextual).
- [Source: `plugins/crew/docs/user-surface-acs.md`] — `user-surface` tagging rubric (Story 1.8 convention).
- [Source: `plugins/crew/mcp-server/src/schemas/catalogue.ts`] — `CatalogueRoleSchema`, `REQUIRED_CATALOGUE_SECTIONS`, `assertCatalogueBodySections` — reused by this story's persona schema and parser.
- [Source: `plugins/crew/mcp-server/src/lib/markdown-frontmatter.ts`] — `splitFrontmatter` and `parseCatalogueRole` — reused.
- [Source: `plugins/crew/mcp-server/src/lib/managed-fs.ts`] — `writeManagedFile` + `CANONICAL_PATH_GLOBS` (`team/**` line 20) — the only canonical-state writer this story invokes.
- [Source: `plugins/crew/mcp-server/src/lib/plugin-version.ts`] — `getPluginVersion()` for `catalogue_version` frontmatter.
- [Source: `plugins/crew/mcp-server/src/tools/register.ts`] — `registerAllTools` is the one entry point; this story extends it.
- [Source: `plugins/crew/mcp-server/src/server.ts`] — dispatcher `_meta.role` permissions gate at lines 116–146; informs Task 8.
- [Source: `plugins/crew/permissions/hiring-manager.yaml`] — modified by Task 8.1 (add four MCP tool names to `tools_allow`).
- [Source: `plugins/crew/permissions/orchestrator.yaml`] — modified by Task 8.2 (add two MCP tool names to `tools_allow`).
- [Source: `plugins/crew/catalogue/*.md`] — ten files; the renderer copies their four sections and frontmatter verbatim into persona files.
- [Source: `plugins/crew/mcp-server/tests/catalogue-shape.test.ts`] — Story 2.1 sibling test pattern.
- [Source: `plugins/crew/mcp-server/tests/get-status.test.ts`] — temp-dir target-repo idiom this story's integration test follows.

---

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
