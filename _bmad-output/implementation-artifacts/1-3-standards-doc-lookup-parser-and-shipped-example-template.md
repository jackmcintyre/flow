# Story 1.3: Standards-doc lookup, parser, and shipped example template

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin operator**,
I want **a clear error pointing me at a copy-target template when `docs/standards.md` is missing or malformed, and a deterministic parser when it is valid**,
so that **I can bootstrap a target repo without guessing the standard's required shape, and every later epic that judges work against the standard reads it through one trusted boundary**.

This story stands up the **standards-doc surface**: (a) a Zod schema for the parsed shape (`version`, `criteria[]` with `name`/`what`/`check`/`anti_criterion`, `updated`), (b) a pure `parseStandardsDoc` validator that consumes the file contents and returns either a typed result or throws a typed error, (c) a `lookupStandards` helper that resolves `<targetRepoRoot>/docs/standards.md`, reads it, and returns the parsed result (throwing typed errors for missing or malformed), (d) the **shipped copy-target** template at `plugins/crew/docs/standards-example.md` which itself parses against the same schema, and (e) the vitest coverage that pins all four AC branches. **This story does not** register an MCP tool, wire into any skill, touch the rule registry, regenerate the standards doc, or read `discipline-rules.yaml` — those land in Stories 1.4 (tool boundary), 1.7 (`/status` consumer), and Epic 6 (regeneration pipeline) respectively. The lookup + parser pair this story delivers is the **read** side of `lookup-standards.ts` (the MCP tool wrapper comes in 1.4).

## Acceptance Criteria

**AC1 — Missing `docs/standards.md` → typed error naming expected path and copy-target (FR45):**
**Given** a `targetRepoRoot` whose `docs/standards.md` does not exist,
**When** `lookupStandards(targetRepoRoot)` is called,
**Then** it throws a typed `StandardsDocMissingError` whose message:
- names the expected absolute path (`<targetRepoRoot>/docs/standards.md`),
- points the user at `plugins/crew/docs/standards-example.md` as the copy-target,
- is a single line, no jargon.

**AC2 — Malformed `docs/standards.md` (missing required fields, or >10 criteria) → typed error citing the offending field or cap (FR46):**
**Given** a `targetRepoRoot` whose `docs/standards.md` exists but fails the parser (missing one of `version` / `criteria` / `updated`; a criterion missing `name`/`what`/`check`/`anti_criterion`; or `criteria.length > 10`),
**When** `lookupStandards(targetRepoRoot)` is called,
**Then** it throws a typed `StandardsDocMalformedError` whose message:
- names the absolute path,
- cites either the offending YAML/Markdown path (e.g. `criteria.3.check`) **or** the criterion-count cap (`criteria.length=11 exceeds hard cap of 10 (FR46)`),
- points the user at `plugins/crew/docs/standards-example.md` as the canonical shape.

**AC3 — Valid `docs/standards.md` → parsed result exposing `version`, `criteria[]`, `updated` (FR44):**
**Given** a `targetRepoRoot` whose `docs/standards.md` is well-formed and within the 10-criteria cap,
**When** `lookupStandards(targetRepoRoot)` is called,
**Then** it resolves with a `StandardsDoc` object exposing:
- `version: string` (semver-shaped, asserted by schema),
- `updated: string` (ISO-8601 date or date-time),
- `criteria: Criterion[]` where each `Criterion` has exactly the fields `name: string`, `what: string`, `check: string`, `anti_criterion: string` (all non-empty strings),
- `sourcePath: string` (absolute path to the file that was read — for downstream version-stamping in Stories 1.5/4.7).

**AC4 — Shipped copy-target exists, parses against the same schema, referenced from README install path (FR47):**
**Given** the plugin tree,
**When** I inspect `plugins/crew/docs/standards-example.md`,
**Then**:
- the file exists,
- `parseStandardsDoc(readFileSync(<path>, 'utf8'))` succeeds and returns a valid `StandardsDoc` (i.e. the example is its own canonical fixture for the happy path),
- the file is referenced by absolute repo-relative path from `plugins/crew/README.md`'s install path (the README section that walks the user through copying the standards template into their target repo).

**AC5 (integration) — vitest covers each of the four cases against fixtures:**
`pnpm test` from `plugins/crew/` runs a new `mcp-server/tests/standards-doc.test.ts` suite that:
- (a) **missing branch:** points at a `targetRepoRoot` fixture with no `docs/standards.md`; asserts `StandardsDocMissingError` is thrown and the message contains the expected path string and `standards-example.md`;
- (b) **malformed branch (missing field):** points at a fixture with a `docs/standards.md` missing the `version` field; asserts `StandardsDocMalformedError` is thrown, the message contains `version`, and the error's `zodMessage` field is populated;
- (c) **malformed branch (>10 criteria):** points at a fixture with 11 well-formed criteria; asserts `StandardsDocMalformedError` is thrown and the message contains `exceeds hard cap of 10` and `(FR46)`;
- (d) **valid branch:** points at a fixture containing a known-good `docs/standards.md` (a copy of `standards-example.md`); asserts the resolved `StandardsDoc.version`, `updated`, `criteria.length`, and the shape of `criteria[0]` (all four required keys present, all non-empty);
- (e) **example self-parses:** reads `plugins/crew/docs/standards-example.md` from the source tree and asserts `parseStandardsDoc` returns a valid `StandardsDoc` (this is the same assertion as AC4 sub-bullet 2, pinned as an executable test).

All five sub-tests pass alongside the smoke suite (1.1), resolver suite (1.2), and validate-active-adapter suite (1.2b). Total expected test count: 14 tests, all green, zero skips.

---

## Tasks / Subtasks

- [x] **Task 1 — Zod schema for `StandardsDoc`** (AC: 2, 3)
  - [x] Create `plugins/crew/mcp-server/src/schemas/standards-doc.ts`.
  - [x] Export:
    - `CriterionSchema` — `z.object({ name: z.string().min(1), what: z.string().min(1), check: z.string().min(1), anti_criterion: z.string().min(1) }).strict()`.
    - `StandardsDocSchema` — `z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/), updated: z.string().min(1), criteria: z.array(CriterionSchema).min(1).max(10) }).strict()`.
    - `type Criterion = z.infer<typeof CriterionSchema>;`
    - `type StandardsDoc = z.infer<typeof StandardsDocSchema> & { sourcePath: string };` — `sourcePath` is appended by `lookupStandards` after parse; it is NOT part of the on-disk shape.
  - [x] **The `.max(10)` is load-bearing** — FR46's hard cap. Do not relax. The Zod error from this rule is the source of the AC2 "exceeds hard cap" branch.
  - [x] `.strict()` rejects unknown keys at every level. The standards doc is a tight contract; surprise keys are bugs.
  - [x] No defaults. Every field is explicit. Defaults would mask malformed input.

- [x] **Task 2 — Typed errors `StandardsDocMissingError` and `StandardsDocMalformedError`** (AC: 1, 2)
  - [x] Extend `plugins/crew/mcp-server/src/errors.ts` with two new subclasses of `DomainError`. Append at the bottom of the file, after `StaleWorkspaceConfigError`. Match the existing JSDoc and constructor-options-bag style.
  - [x] `StandardsDocMissingError` — fields: `expectedPath: string`, `copyTarget: string` (= `"plugins/crew/docs/standards-example.md"`). Constructor composes:
    > `docs/standards.md not found at <expectedPath>. Copy the shipped template from <copyTarget> to <targetRepoRoot>/docs/standards.md and edit for your project. (FR45)`
  - [x] `StandardsDocMalformedError` — fields: `sourcePath: string`, `zodMessage: string`, `copyTarget: string`. Constructor composes:
    > `docs/standards.md at <sourcePath> is malformed: <zodMessage>. See the canonical shape in <copyTarget>. (FR46)`
  - [x] The `zodMessage` field for AC2's cap-violation branch must explicitly carry `criteria.length=<N> exceeds hard cap of 10 (FR46)` — see Task 4 for where to compose that string before constructing the error.
  - [x] Both classes extend `DomainError` (which sets `error.name` automatically via `new.target.name`). Do **not** manually assign `this.name`.
  - [x] Do **not** touch any of the existing classes (`DomainError`, `NotImplementedError`, `InvalidWorkspaceConfigError`, `NoAdapterMatchedError`, `AmbiguousAdapterError`, `StaleWorkspaceConfigError`). Their wording is asserted by 1.1/1.2/1.2b tests.

- [x] **Task 3 — Pure parser `parseStandardsDoc`** (AC: 2, 3, 4)
  - [x] Create `plugins/crew/mcp-server/src/validators/standards-doc.ts`. (This is the first file under `validators/` — create the directory.)
  - [x] Export a single pure function:
    `parseStandardsDoc(raw: string, sourcePath: string): StandardsDoc`
    - `raw` is the file contents as a string.
    - `sourcePath` is the absolute path the contents came from; used only for the `sourcePath` field on the returned value and the `StandardsDocMalformedError.sourcePath` field on failure.
  - [x] Algorithm:
    1. Parse `raw` as YAML using `yamlParse` from `"yaml"` (same import pattern as `workspace-resolver.ts`). On a YAML syntax error, throw `StandardsDocMalformedError({ sourcePath, zodMessage: <error.message>, copyTarget: "plugins/crew/docs/standards-example.md" })`.
    2. Pass the parsed value through `StandardsDocSchema.safeParse(...)`.
    3. On `success: false`: format the Zod error into a one-line string (see **Zod message formatting** in Dev Notes). If the failure is the `criteria.max(10)` rule, replace the Zod message with the explicit `criteria.length=<N> exceeds hard cap of 10 (FR46)` string before constructing the error. Throw `StandardsDocMalformedError({ sourcePath, zodMessage: <formatted>, copyTarget })`.
    4. On `success: true`: return `{ ...result.data, sourcePath }`.
  - [x] **Pure function** — no IO, no caching, no module-level state.
  - [x] **Does not** import `node:fs`, does not touch disk, does not call `lookupStandards`. The split between `parseStandardsDoc` (pure) and `lookupStandards` (IO) is the same boundary the resolver story established (parse vs. resolve).

- [x] **Task 4 — `lookupStandards` helper (IO boundary)** (AC: 1, 3)
  - [x] Create `plugins/crew/mcp-server/src/state/lookup-standards.ts`. (Sits alongside `workspace-resolver.ts` and `validate-active-adapter.ts` in `state/` — same convention as 1.2/1.2b: the "where we read target-repo files" boundary lives in `state/`.)
  - [x] Export a single async function:
    `lookupStandards(targetRepoRoot: string): Promise<StandardsDoc>`
  - [x] Algorithm:
    1. Compute `sourcePath = path.join(targetRepoRoot, "docs", "standards.md")`.
    2. Read the file with `fs.readFile(sourcePath, "utf8")`. On `ENOENT`, throw `StandardsDocMissingError({ expectedPath: sourcePath, copyTarget: "plugins/crew/docs/standards-example.md" })`. Any other read error propagates as-is (filesystem permissions, etc. — not this story's concern).
    3. Return `parseStandardsDoc(contents, sourcePath)` — any `StandardsDocMalformedError` thrown by the parser propagates unchanged.
  - [x] **Single-purpose IO wrapper.** No caching, no telemetry write, no git wrapper, no MCP-tool registration. Those land in Stories 1.4 / 1.5 / future.
  - [x] Use the same import style as `workspace-resolver.ts`: `import { promises as fs } from "node:fs"` and `import * as path from "node:path"`. `.js` extensions on relative imports (NodeNext).

- [x] **Task 5 — Author the shipped copy-target `plugins/crew/docs/standards-example.md`** (AC: 4)
  - [x] Create `plugins/crew/docs/standards-example.md` (the directory exists with only `.gitkeep` today — keep the gitkeep file alone, just add this one new file).
  - [x] File format: a leading `---`-delimited YAML frontmatter block containing the full `StandardsDoc` shape, followed by an empty body or a short prose preamble that the parser ignores. Decision: **the entire file is YAML, no markdown body.** This keeps `parseStandardsDoc` trivially `yamlParse(raw)` — no frontmatter splitting, no Markdown ambiguity. The `.md` extension is preserved for editor affordances (folding, syntax) and to match FR43–FR47's `docs/standards.md` convention. Re-confirm with the project's frontmatter convention (Implementation Patterns §1: YAML-only in `---`-delimited blocks) — for this artifact we ship it as a pure YAML document for parser simplicity.
  - [x] **Concrete content** (use this verbatim as a starting point — Jack/PM can edit later, but every value must satisfy the schema today):
    ```yaml
    version: "0.1.0"
    updated: "2026-05-19"
    criteria:
      - name: "story-aligned"
        what: "The PR's diff implements only what the story's acceptance criteria require."
        check: "Map each diff hunk to one or more ACs; flag any hunk that maps to none."
        anti_criterion: "Scope creep: refactors or rewrites that the story did not request."
      - name: "tests-cover-acs"
        what: "Every AC has at least one assertion in the test suite that fails when the AC behaviour is removed."
        check: "Inspect the new/changed test files; trace each AC to a named test."
        anti_criterion: "Tests that only exercise happy paths without asserting the AC's specific behaviour."
      - name: "no-canonical-fs-writes-outside-mcp"
        what: "No code path writes to canonical-state paths (manifests, personas, registry, telemetry) except through MCP tools."
        check: "Grep the diff for raw fs.writeFile/fs.writeFileSync; any hit under a canonical path is a fail."
        anti_criterion: "Direct fs.write to .crew/state, telemetry, or docs/standards.md."
      - name: "errors-are-typed"
        what: "Every named failure mode in the diff throws a DomainError subclass; uncaught throws are bugs."
        check: "Inspect new throw sites; assert they throw a class extending DomainError with a one-line user-facing message."
        anti_criterion: "throw new Error('...') or returning {error: '...'} envelopes for known failures."
    ```
  - [x] This is **4 criteria** — well under the cap. The example must demonstrate the shape, not exhaust it.
  - [x] **The example is its own AC4 fixture** — the test suite reads this exact file and asserts it parses. If the example breaks the schema, the test fails. This is intentional.

- [x] **Task 6 — Reference the copy-target from the README install path** (AC: 4)
  - [x] Update `plugins/crew/README.md` to include a short install-path section (if one does not already exist) that references `plugins/crew/docs/standards-example.md` as the copy-target. Repo-relative path, not absolute.
  - [x] If the README is empty or near-empty today, add a minimal section titled `## Standards doc` with two sentences and the copy command (`cp plugins/crew/docs/standards-example.md <target-repo>/docs/standards.md`). **Do not** rewrite or restructure the rest of the README — Story 1.7 owns the full install-path walkthrough.
  - [x] If the README already references `standards-example.md`, this task is a no-op; verify the reference path is correct.
  - [x] **Do not** edit the project root `README.md` — that's outside the plugin scope and outside this story's surface.

- [x] **Task 7 — Author the vitest suite and fixtures** (AC: 5)
  - [x] Create `plugins/crew/mcp-server/tests/standards-doc.test.ts`.
  - [x] Create fixtures under `plugins/crew/mcp-server/tests/fixtures/standards/`:
    - `missing/` — directory with only a `.gitkeep`. The `docs/` subdir does NOT exist.
    - `malformed-missing-field/docs/standards.md` — well-formed YAML missing the `version` field.
    - `malformed-cap-exceeded/docs/standards.md` — 11 well-formed criteria.
    - `valid/docs/standards.md` — a copy of `plugins/crew/docs/standards-example.md`. (Test setup may `fs.copyFile` at suite-init time instead of duplicating the content — pick whichever keeps the fixtures cleaner.)
  - [x] One `describe` block (`lookupStandards`) with four `it` cases mapping 1:1 to AC5(a–d). One additional `describe` (`standards-example.md (shipped copy-target)`) with one `it` for AC5(e), which reads the example file directly from `plugins/crew/docs/standards-example.md`.
  - [x] Assertions per branch:
    - AC5a — `expect(() => lookupStandards(fixturePath)).rejects.toThrow(StandardsDocMissingError)`; inspect `expectedPath` and message substring `standards-example.md`.
    - AC5b — `expect(...).rejects.toThrow(StandardsDocMalformedError)`; message contains `version`; thrown error's `zodMessage` is non-empty.
    - AC5c — `expect(...).rejects.toThrow(StandardsDocMalformedError)`; message contains `exceeds hard cap of 10` and `(FR46)`.
    - AC5d — resolves to a `StandardsDoc`; assert `result.version` matches `/^\d+\.\d+\.\d+$/`; `result.criteria.length` between 1 and 10; `result.criteria[0]` has the four required keys, all non-empty.
    - AC5e — `parseStandardsDoc(readFileSync(<example path>, 'utf8'), <example path>)` returns a valid `StandardsDoc` (no throw). This is the regression guard that prevents shipping a malformed copy-target.
  - [x] Use `path.join(__dirname, "fixtures", "standards", "<branch>")` (or the ESM-equivalent `new URL(...).pathname` pattern already in `workspace-resolver.test.ts`) for fixture paths.
  - [x] Imports use `.js` extensions (NodeNext): `import { lookupStandards } from "../src/state/lookup-standards.js"`, `import { parseStandardsDoc } from "../src/validators/standards-doc.js"`, `import { StandardsDocMissingError, StandardsDocMalformedError } from "../src/errors.js"`.

- [x] **Task 8 — Verify install + build + test pipeline** (AC: 1, 2, 3, 4, 5)
  - [x] `pnpm install` succeeds from `plugins/crew/` (no new runtime deps; `yaml` and `zod` already declared in 1.1/1.2).
  - [x] `pnpm build` from `plugins/crew/` produces zero TS errors.
  - [x] `pnpm test` from `plugins/crew/` runs the full suite: Story 1.1 smoke (3 tests) + Story 1.1 acceptance (1 test) + Story 1.2 resolver (5 tests) + Story 1.2b validate-active-adapter (3 tests) + this story's new suite (5 tests). All green, zero skips. Total: 17 tests (or whatever the current `pnpm test` baseline shows + 5).
  - [x] `pnpm-lock.yaml` is unchanged (no new deps).

---

## Dev Notes

### Why this story matters

The standards doc is the **reviewer's rubric**, externalised. Every reviewer verdict in Epic 4 reads it; every retro in Epic 6 stamps its version; the README install path (Story 1.7) walks the user through copying the example. This story lands the **read** boundary — the lookup + parser pair — so that every downstream consumer goes through one trusted function. It also ships the copy-target template, which is the user's first-touch artifact when bootstrapping a target repo.

**Three failure modes the user can hit on first install:**
1. **Missing file** — they forgot to copy the template. AC1's error tells them exactly where to copy from and to.
2. **Malformed file** — they edited the template and broke the shape. AC2's error tells them which field is wrong (or that they exceeded the hard cap).
3. **Valid file** — they edited the template correctly. AC3 returns a typed `StandardsDoc` the rest of the plugin can use.

Each failure mode produces a one-line, user-facing message. **No stack traces, no Zod-internal jargon in the user-facing text** — the parser is responsible for translating Zod's verbose errors into something a non-engineer can act on (see **Zod message formatting** below).

**Boundary discipline:** this story ships the read side only. The MCP-tool wrapper (`lookupStandards` tool in `mcp-server/src/tools/lookup-standards.ts`) lands in Story 1.4 along with permission-allowlist scaffolding. The regeneration pipeline (`regenerate-standards.ts`, `discipline-rules.yaml`, `applyRuleProposal`) lands in Epic 6. **Do not** anticipate either in this story.

### Files this story touches

**NEW:**
- `plugins/crew/mcp-server/src/schemas/standards-doc.ts` — Zod schema and types.
- `plugins/crew/mcp-server/src/validators/standards-doc.ts` — pure `parseStandardsDoc` function. (Creates the `validators/` directory — architecture pins this location, see project-structure-boundaries.md line 108–112.)
- `plugins/crew/mcp-server/src/state/lookup-standards.ts` — IO-bearing `lookupStandards` helper.
- `plugins/crew/docs/standards-example.md` — the shipped copy-target template (FR47).
- `plugins/crew/mcp-server/tests/standards-doc.test.ts` — the vitest suite.
- `plugins/crew/mcp-server/tests/fixtures/standards/missing/.gitkeep`
- `plugins/crew/mcp-server/tests/fixtures/standards/malformed-missing-field/docs/standards.md`
- `plugins/crew/mcp-server/tests/fixtures/standards/malformed-cap-exceeded/docs/standards.md`
- `plugins/crew/mcp-server/tests/fixtures/standards/valid/docs/standards.md` — copy of `standards-example.md`.

**UPDATE (minimal — preserve existing surface):**
- `plugins/crew/mcp-server/src/errors.ts` — append `StandardsDocMissingError` and `StandardsDocMalformedError` only. Do not touch the six existing classes.
- `plugins/crew/README.md` — append a short `## Standards doc` section referencing the copy-target (only if not already present; do not restructure existing content).

**MUST NOT touch:**
- `plugins/crew/mcp-server/src/state/workspace-resolver.ts`, `validate-active-adapter.ts` — their contracts are fixed by 1.2 / 1.2b.
- `plugins/crew/mcp-server/src/schemas/workspace-config.ts`, `plugin-manifest.ts` — settled.
- `plugins/crew/mcp-server/src/adapters/*` — no adapter-contract change in this story.
- `plugins/crew/mcp-server/src/server.ts`, `index.ts` — no tool registration in this story.
- `plugins/crew/mcp-server/tests/smoke.test.ts`, `acceptance.test.ts`, `workspace-resolver.test.ts`, `validate-active-adapter.test.ts` — must still pass unchanged.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` or any other status/state file — the orchestrator owns status transitions.
- Anything under `plugins/sprint-orchestrator/` — retired (does not exist in tree, mentioned only for symmetry with prior stories).
- The project-root `README.md`, `CLAUDE.md`, `_bmad/`, `_bmad-output/_archive/` — out of scope.

### Architecture compliance — what is pinned

| Concern | Pin | Source |
|---|---|---|
| Standards doc lives at `<target-repo>/docs/standards.md` | The ONLY supported source in v1 | PRD claude-code-plugin-project-type-requirements.md line 72 |
| Hard cap of 10 criteria | Schema enforces `.max(10)`; violation is a typed error citing `(FR46)` | FR46; PRD domain-specific-requirements.md line 42; project-context-analysis.md line 43 |
| Required parsed fields | `version`, `criteria[]` (with `name`/`what`/`check`/`anti_criterion`), `updated` | FR44; epic-1 AC3 for Story 1.3 |
| Shipped copy-target location | `plugins/crew/docs/standards-example.md` | FR47; project-structure-boundaries.md line 121 |
| Helper location (read IO) | `plugins/crew/mcp-server/src/state/lookup-standards.ts` — `state/` is the workspace-IO boundary established by 1.2/1.2b (NB: this story sits in `state/`, the MCP tool wrapper in Story 1.4 will live in `tools/lookup-standards.ts`) | project-structure-boundaries.md line 70, 96–100 |
| Pure parser location | `plugins/crew/mcp-server/src/validators/standards-doc.ts` — architecture pins `validators/` for this exact purpose | project-structure-boundaries.md line 108–112 |
| Schema location | `plugins/crew/mcp-server/src/schemas/standards-doc.ts` | project-structure-boundaries.md line 87, 95 |
| Error types | New `StandardsDocMissingError` and `StandardsDocMalformedError` extending `DomainError` — distinct subclasses, not a discriminator on a single class | Implementation-patterns-consistency-rules.md §6 (Errors); 1.2b anti-pattern #8 |
| File-naming convention | `kebab-case.ts`; test files `*.test.ts` co-located with source under `tests/` | Implementation-patterns-consistency-rules.md §6 |
| No defaults in schema | Every standards-doc field is explicit; defaults would mask malformed input | This story (parser correctness) |
| `.strict()` on every schema level | Reject unknown keys; standards doc is a tight contract | Implementation-patterns-consistency-rules.md §1 (frontmatter validation) |
| Standards example self-parses | Test asserts the shipped copy-target parses against the same schema | Epic-1 AC4 sub-bullet; FR47 |

### `StandardsDocMissingError` and `StandardsDocMalformedError` — exact shape

```typescript
// additions to mcp-server/src/errors.ts (after StaleWorkspaceConfigError)

/**
 * `docs/standards.md` was not found at the expected path under the target
 * repo. User must copy the shipped example to bootstrap. Distinct from
 * StandardsDocMalformedError (file exists but fails the schema).
 */
export class StandardsDocMissingError extends DomainError {
  readonly expectedPath: string;
  readonly copyTarget: string;

  constructor(opts: { expectedPath: string; copyTarget: string }) {
    super(
      `docs/standards.md not found at ${opts.expectedPath}. ` +
        `Copy the shipped template from ${opts.copyTarget} to ` +
        `<target-repo>/docs/standards.md and edit for your project. (FR45)`,
    );
    this.expectedPath = opts.expectedPath;
    this.copyTarget = opts.copyTarget;
  }
}

/**
 * `docs/standards.md` was found but failed the parser: either YAML syntax
 * is invalid, a required field is missing or wrongly typed, or the
 * 10-criterion hard cap (FR46) is exceeded. The `zodMessage` field carries
 * the formatted Zod error (or the explicit cap-violation message). The
 * user-facing `message` cites the offending field or the cap.
 */
export class StandardsDocMalformedError extends DomainError {
  readonly sourcePath: string;
  readonly zodMessage: string;
  readonly copyTarget: string;

  constructor(opts: { sourcePath: string; zodMessage: string; copyTarget: string }) {
    super(
      `docs/standards.md at ${opts.sourcePath} is malformed: ${opts.zodMessage}. ` +
        `See the canonical shape in ${opts.copyTarget}. (FR46)`,
    );
    this.sourcePath = opts.sourcePath;
    this.zodMessage = opts.zodMessage;
    this.copyTarget = opts.copyTarget;
  }
}
```

The exact wording is load-bearing — Story 1.7 (`/status`) and the README install path will surface these phrasings. Commit to them.

### `parseStandardsDoc` — signature and shape

```typescript
// mcp-server/src/validators/standards-doc.ts
import { parse as yamlParse } from "yaml";
import { StandardsDocMalformedError } from "../errors.js";
import { StandardsDocSchema, type StandardsDoc } from "../schemas/standards-doc.js";

const COPY_TARGET = "plugins/crew/docs/standards-example.md";

/**
 * Parse the contents of a `docs/standards.md` file (a YAML document) into
 * a typed StandardsDoc. Pure — no IO. The caller (`lookupStandards`)
 * supplies `sourcePath` for error reporting and to stamp onto the
 * returned value.
 *
 * Throws StandardsDocMalformedError on YAML-syntax errors, Zod-schema
 * failures, or criterion-count cap violations. The cap violation gets a
 * specially-formatted zodMessage (`criteria.length=<N> exceeds hard cap
 * of 10 (FR46)`) so the user-facing message is unambiguous.
 */
export function parseStandardsDoc(raw: string, sourcePath: string): StandardsDoc {
  // ... implementation per Task 3 algorithm
}
```

### `lookupStandards` — signature and shape

```typescript
// mcp-server/src/state/lookup-standards.ts
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { StandardsDocMissingError } from "../errors.js";
import { parseStandardsDoc } from "../validators/standards-doc.js";
import type { StandardsDoc } from "../schemas/standards-doc.js";

const COPY_TARGET = "plugins/crew/docs/standards-example.md";

/**
 * Resolve `<targetRepoRoot>/docs/standards.md`, read it, and return the
 * parsed StandardsDoc. Throws StandardsDocMissingError on ENOENT,
 * StandardsDocMalformedError on schema failure (delegated to parser).
 *
 * Single-purpose IO wrapper — no caching, no telemetry, no git, no
 * MCP-tool wrapper. Those layer on in Stories 1.4 (tool), 1.5
 * (telemetry stamping), and Epic 4 (reviewer consumption).
 */
export async function lookupStandards(targetRepoRoot: string): Promise<StandardsDoc> {
  // ... implementation per Task 4 algorithm
}
```

### Zod message formatting — keep user-facing errors human

Zod's default `error.message` is JSON-shaped and verbose (`"Required" at path "criteria.0.name"`). The parser's job is to translate that to a one-line, human-readable string before constructing `StandardsDocMalformedError`. Pattern:

```typescript
function formatZodIssues(issues: z.ZodIssue[]): string {
  // Pick the first issue (parsers usually surface the most-specific first).
  // Format as: `<dotted-path>: <human message>`.
  const first = issues[0];
  const dottedPath = first.path.length > 0 ? first.path.join(".") : "<root>";
  return `${dottedPath}: ${first.message}`;
}
```

**Special case — cap violation:** Zod reports `.max(10)` as `"Array must contain at most 10 element(s)"` at path `criteria`. Detect this specific case (`first.path[0] === "criteria" && first.code === "too_big" && (first as any).maximum === 10`) and replace the message with `criteria.length=<actual> exceeds hard cap of 10 (FR46)`. This is the wording AC2/AC5c assert on.

If Zod surfaces multiple unrelated issues simultaneously, surfacing the first one is sufficient for v1 — the user fixes that one, re-runs, and sees the next. Do **not** concatenate all issues into one mega-message; that's the failure mode FR45/FR46 are trying to avoid.

### Error message shape — make these helpful

The user sees these errors verbatim through `/status` (Story 1.7), reviewer-side standards-load failures (Epic 4), and any direct skill invocation that consumes standards. Aim for one line, no jargon. Examples (matching Task 2's pinned wording):

- **Missing case (AC1):**
  `docs/standards.md not found at /Users/jack/projects/foo/docs/standards.md. Copy the shipped template from plugins/crew/docs/standards-example.md to <target-repo>/docs/standards.md and edit for your project. (FR45)`
- **Malformed missing-field case (AC2 / AC5b):**
  `docs/standards.md at /Users/jack/projects/foo/docs/standards.md is malformed: version: Required. See the canonical shape in plugins/crew/docs/standards-example.md. (FR46)`
- **Cap-exceeded case (AC2 / AC5c):**
  `docs/standards.md at /Users/jack/projects/foo/docs/standards.md is malformed: criteria.length=11 exceeds hard cap of 10 (FR46). See the canonical shape in plugins/crew/docs/standards-example.md. (FR46)`

### Library / framework requirements

| Lib | Version | Use in this story |
|---|---|---|
| `zod` | `^3.23` (pinned in 1.2) | schema definition + parse |
| `yaml` (eemeli) | `^2.5` (pinned in 1.2) | parse the standards doc body |
| `vitest` | `^2.1` (pinned in 1.1) | test runner |
| `node:fs/promises`, `node:path` | stdlib | `lookupStandards` IO + path resolution |

**No new runtime deps.** `pnpm-lock.yaml` must remain unchanged.

**Use Context7** only if the dev needs to confirm `zod` `safeParse` issue shape (e.g. `first.code === "too_big"` and the `maximum` field on the issue) or `yaml` parser error shape. Everything else is settled by 1.1/1.2.

### File structure requirements

```
plugins/crew/
├── docs/
│   ├── .gitkeep                                  # UNCHANGED
│   └── standards-example.md                      # NEW (FR47 copy-target)
├── mcp-server/
│   ├── src/
│   │   ├── errors.ts                             # UPDATED — adds 2 classes
│   │   ├── schemas/
│   │   │   └── standards-doc.ts                  # NEW
│   │   ├── state/
│   │   │   ├── workspace-resolver.ts             # UNCHANGED (Story 1.2)
│   │   │   ├── validate-active-adapter.ts        # UNCHANGED (Story 1.2b)
│   │   │   └── lookup-standards.ts               # NEW
│   │   └── validators/
│   │       └── standards-doc.ts                  # NEW (creates validators/ dir)
│   └── tests/
│       ├── smoke.test.ts                         # UNCHANGED
│       ├── acceptance.test.ts                    # UNCHANGED
│       ├── workspace-resolver.test.ts            # UNCHANGED
│       ├── validate-active-adapter.test.ts       # UNCHANGED
│       ├── standards-doc.test.ts                 # NEW
│       └── fixtures/
│           └── standards/                        # NEW
│               ├── missing/.gitkeep
│               ├── malformed-missing-field/docs/standards.md
│               ├── malformed-cap-exceeded/docs/standards.md
│               └── valid/docs/standards.md
└── README.md                                     # UPDATED — appends standards-doc section if absent
```

Stay within this list. Anything else is scope creep.

### Testing requirements

- All five sub-tests are unit-level vitest, in-process, no subprocess transport. Fixtures live on disk under `tests/fixtures/standards/` because `lookupStandards` is the IO boundary — exercising it means real file reads. The parser-only AC5e test reads `plugins/crew/docs/standards-example.md` directly from the source tree (resolve the path relative to the test file).
- `pnpm test` from `plugins/crew/` must continue to run the existing 1.1/1.2/1.2b suites unchanged, plus the new 5-test suite. All green, zero skips.
- Test file imports use `.js` extensions (NodeNext): `import { lookupStandards } from "../src/state/lookup-standards.js"`, etc.
- The "valid" fixture can be a literal copy of `standards-example.md` (preferred — keeps a single source of truth) or independently authored. Pick the copy approach unless there's a reason not to; the divergence cost outweighs the marginal coverage of a second canonical example.
- No need for mocking — every dependency in this story is either pure (parser) or stdlib (`fs`). Don't introduce `vi.mock` for `fs`; use real fixtures.

### Anti-patterns to avoid (high-cost LLM mistakes)

1. **Do not register an MCP tool in this story.** No edits to `server.ts`, no `tools/lookup-standards.ts`. Story 1.4 owns the tool boundary. Read-side helpers only here.
2. **Do not read `discipline-rules.yaml`.** The rule registry is Epic 6's surface. This story consumes the standards doc as-authored; it does not regenerate it.
3. **Do not import `parseStandardsDoc` from inside `workspace-resolver.ts` or `validate-active-adapter.ts`.** Those files are settled. Standards lookup is downstream of workspace resolution but is not a workspace concern.
4. **Do not return a generic `{ ok, value, error }` envelope.** Throw typed errors, return the parsed value. Matches the resolver/validator precedent (1.2/1.2b).
5. **Do not relax `.max(10)` or `.strict()` "to be helpful."** The cap is FR46, load-bearing. The strict-unknown-keys rule prevents silent shape drift across plugin versions.
6. **Do not parse the example file as a Markdown document with frontmatter.** Decision in Task 5: the example is a pure YAML file with `.md` extension. The parser is `yamlParse(raw)`, not a frontmatter splitter. If a future story (Epic 6 regeneration) wants to embed a Markdown body in `docs/standards.md`, that's its problem — for v1, body is parser-ignored / file-is-YAML.
7. **Do not invent a `StandardsDocError` umbrella class with a discriminator.** Two distinct subclasses (`StandardsDocMissingError`, `StandardsDocMalformedError`) match the precedent set by 1.2 (`Invalid…`, `NoAdapterMatched…`, `Ambiguous…`) and 1.2b (`StaleWorkspace…`).
8. **Do not cache the parsed standards doc at module level.** Every `lookupStandards` call re-reads the file. Caching introduces stale-read failures across long-running orchestration sessions (Epic 5's problem if it surfaces — not this story's).
9. **Do not derive `targetRepoRoot` from `process.cwd()`.** The caller (Story 1.4 tool wrapper, Story 1.7 `/status` skill) passes it in as an absolute path. (See project memory `feedback_pre_tool_use_hook_cwd_drift` — same lesson as 1.2 and 1.2b.)
10. **Do not write a "lenient" mode that auto-truncates `criteria` to 10 if the user supplied 11.** The cap is a hard error. Truncating silently is exactly the behaviour FR46 forbids.
11. **Do not assert `result.criteria[0].name === "story-aligned"`** in the AC5d test — that would couple the test to the example's content, and any edit to `standards-example.md` would break the test. Assert the shape (four keys, all non-empty) instead.
12. **Do not modify `_bmad-output/implementation-artifacts/sprint-status.yaml` or any state/status file** as part of this implementation. The orchestrator owns status transitions; the dev's job is the code + tests + example file + README pointer.
13. **Do not wire `lookupStandards` into Story 1.7's `/status`** as part of this story. That's 1.7's job. This story ships the helper and its unit tests only.
14. **Do not author 10 criteria in the example.** Demonstrate the shape with a comfortable 3–5; leaving headroom under the cap is itself a teaching signal ("the cap exists, you do not need to fill it").
15. **Do not surface Zod's raw issue objects to the user.** Always run them through the `formatZodIssues` helper. The user-facing message is one line; the structured detail lives on the error's `zodMessage` field for programmatic consumers (Story 1.7's `/status` may inspect it later).
16. **Do not consume `fs.existsSync` for the missing-file branch.** Use the `ENOENT` error from `fs.readFile` — it's atomic with the read attempt and avoids a TOCTOU race. The 1.2 resolver established this pattern (`fileExists` there exists only because it makes a separate detect() decision; this story doesn't need it).

### Previous-story intelligence (Stories 1.1, 1.2, 1.2b)

- **From 1.1:** `DomainError` is in `mcp-server/src/errors.ts` and uses `new.target.name` to set `error.name` automatically. Subclassing it gives you the class name on `error.name` for free — no manual assignment.
- **From 1.1:** TypeScript module resolution is `NodeNext`. Relative imports inside `src/` and `tests/` must end in `.js`, even when the source is `.ts`.
- **From 1.1:** vitest config + test-runner setup is already in place. No config changes needed for this story.
- **From 1.2:** `parse as yamlParse` from `"yaml"` is the established import for YAML parsing. Use the same import for `parseStandardsDoc`.
- **From 1.2:** Pattern of `state/` helpers that take a `targetRepoRoot: string` and return a typed result (or throw). `lookupStandards` follows the same shape; signature is `(targetRepoRoot: string) => Promise<StandardsDoc>` rather than `(opts: { ... }) => ...` because there's only one input.
- **From 1.2:** Schemas live in `schemas/`; pure validators (formerly absent because the resolver did its own schema work) now have a home in `validators/` per the architecture map.
- **From 1.2:** The `Workspace` type and `resolveWorkspace` function are NOT consumed by this story. The standards-doc surface is orthogonal to the adapter/workspace surface; do not entangle them.
- **From 1.2b:** Identity-preserving inputs (`validateActiveAdapter` returns the same `Workspace` reference) — `lookupStandards` does NOT need this property because it returns a freshly-parsed value, not an input pass-through.
- **From 1.2b:** Error-class wording is asserted by tests verbatim. Pin the wording in Task 2 and commit to it.
- **From 1.2b:** The `mcp-server/tests/` directory already contains `fixtures/` (for workspace-resolver tests). Add a new `fixtures/standards/` subdirectory — do not reorganise the existing fixtures.

### Files being modified — current state and what changes

- **`mcp-server/src/errors.ts` (UPDATE):**
  - Current state (post-1.2b): exports `DomainError`, `NotImplementedError`, `InvalidWorkspaceConfigError`, `NoAdapterMatchedError`, `AmbiguousAdapterError`, `StaleWorkspaceConfigError`. Each constructor composes a user-facing one-line message in `super(...)`.
  - This story adds: `StandardsDocMissingError` and `StandardsDocMalformedError` at the bottom of the file. Match the existing JSDoc style and options-bag constructor pattern.
  - Must preserve: every existing class, exact `super(...)` wording (1.1/1.2/1.2b tests assert on those strings).
- **`plugins/crew/README.md` (UPDATE — possibly trivial):**
  - Current state: unknown (read the file before editing — if it already references `standards-example.md`, this is a no-op verification; if not, append the short section per Task 6).
  - Must preserve: every existing section. Append only.
  - **Read the file first** before deciding what to write — do not assume.
- **`mcp-server/src/state/workspace-resolver.ts`, `validate-active-adapter.ts` (READ-ONLY for this story):**
  - Current state: settled by 1.2/1.2b. Use only to mirror conventions (file structure, imports, error patterns).
  - This story changes: nothing.
- **`mcp-server/src/adapters/*` (READ-ONLY):**
  - This story does not touch adapters. No `PlanningAdapter` extension, no new adapter, no registry change.

### Git intelligence

- Recent commits (`1945c42`, `9318f29`, `1ab00d1`, `06488c2`, `e3791eb`, `fe2c20f`) show: ship-story is the conventional flow; commits are scope-prefixed (`feat(1-2): …`, `feat(1-2b): …`); the plugin slug is `crew` (renamed from `ai-engineering-team` on 2026-05-19 — use `plugins/crew/` everywhere).
- Conventional commit for this story: `feat(1-3): standards-doc lookup + parser + shipped example` (subject ≤72 chars).
- The plugin tree under `plugins/crew/` is the only mutation surface. `pnpm-lock.yaml` should be untouched (no new deps).
- The previous story (1.2b) shipped under `feat(1): Stale-config detection on every skill invocation (#54)` — reference its file layout patterns when in doubt.
- Worktrees live inside the repo at `.worktrees/<key>/` (project memory `feedback_worktrees_inside_project`). The dev should use absolute paths or `git -C` when running commands during ship-story (memory `feedback_ship_story_cwd_drift`) — but this is a ship-story concern, not a code concern.

### Latest tech information

- **`zod`:** Use Context7 only if needed to confirm the `safeParse` issue shape — specifically `(issue as ZodTooBigIssue).maximum` on the cap-violation branch. The general `issue.code === "too_big"` discriminator is stable across 3.22+.
- **`yaml` (eemeli):** `parse(raw)` is the standard call. On invalid YAML it throws a `YAMLParseError` whose `.message` is one line — pass that string through as the `zodMessage` for `StandardsDocMalformedError` on the YAML-syntax branch.
- **`vitest`:** `expect(promise).rejects.toThrow(ErrorClass)` is the standard async-rejection assertion. `expect(actualString).toMatch(/substring/)` for message-substring checks (the AC tests assert on `expectedPath`, `(FR46)`, `exceeds hard cap of 10`, etc.).
- **Node version:** Node 22 LTS, `module: NodeNext`. Relative imports end in `.js`.

### Project context reference

- **PM:** Jack. Frame trade-offs in PM language (`CLAUDE.md`). This story's PM-visible signal: "the plugin now reads the user's standards doc, refuses to silently accept malformed ones, and ships a starter template they can copy." It is a precondition for the install-path checkpoint in Story 1.7 ("`/status` shows standards-doc state: `ok | missing | malformed`") and for every reviewer verdict in Epic 4.
- **PRD (authoritative):** `_bmad-output/planning-artifacts/prd-crew-v1.md` (sharded under `prd-crew-v1/`). Standards-doc section: `functional-requirements.md#standards-doc` (FR43–FR48); install-path discussion: `claude-code-plugin-project-type-requirements.md#standards-doc-resolution` (line 70–75); domain rationale: `domain-specific-requirements.md#standards-doc` (lines 26–27, 42); innovation framing: `innovation-novel-patterns.md` (standards-as-product-surface, line 9; bloat anti-pattern, line 40).
- **Architecture (load-bearing):**
  - `_bmad-output/planning-artifacts/architecture/project-context-analysis.md` line 12 (FR43–FR48 summary), line 43 (hard-cap + missing/malformed-→hard-error narrative), line 55 (calibration-loop integrity).
  - `_bmad-output/planning-artifacts/architecture/project-structure-boundaries.md` lines 70–71 (`tools/lookup-standards.ts`, `tools/regenerate-standards.ts` — pinned MCP-tool layout; this story stops short of those tools), line 109 (`validators/standards-doc.ts` — pinned validator location for THIS story), line 121 (`docs/standards-example.md` copy-target).
  - `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` §1 (frontmatter validation via Zod, line 30), §6 (typed errors extending `DomainError`, line 131; no `any`, line 132).
  - `_bmad-output/planning-artifacts/architecture/core-architectural-decisions.md` line 70 (verdict version-stamps `standards_version` — this story's `StandardsDoc.version` is what gets stamped downstream).
- **Story 1.2 (precondition):** delivered the workspace boundary (`state/workspace-resolver.ts`), the typed-error precedent, and the Zod-schema-in-`schemas/` pattern.
- **Story 1.2b (precondition):** confirmed the `state/` directory as the IO-helper home and the "distinct error subclasses, not discriminators" pattern.
- **Story 1.4 (downstream — same epic, next-up):** wraps `lookupStandards` in the MCP tool boundary at `tools/lookup-standards.ts` and enforces the permission allowlist. **Do not** anticipate it here.
- **Story 1.7 (downstream):** `/status` skill prints `standards-doc state: ok | missing | malformed` — built on top of catching `StandardsDocMissingError` / `StandardsDocMalformedError` from `lookupStandards`. Ensure the error fields (`expectedPath`, `sourcePath`, `zodMessage`) are rich enough for that skill to render the state cleanly.
- **Epic 6 (much later — calibration loop):** owns `regenerate-standards.ts` (regenerating `docs/standards.md` from `discipline-rules.yaml`) and `apply-rule-proposal.ts`. **Out of this story.**
- **Sprint-orchestrator lesson (project memory `feedback_pre_tool_use_hook_cwd_drift`):** never derive paths from shell `cwd`. `lookupStandards` takes `targetRepoRoot` as a parameter; caller is responsible for resolving it.

### References

- [Source: _bmad-output/planning-artifacts/epics/epic-1-plugin-foundation-target-repo-bootstrap.md#Story 1.3: Standards-doc lookup, parser, and shipped example template]
- [Source: _bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md#Standards doc (FR43–FR48)]
- [Source: _bmad-output/planning-artifacts/prd-crew-v1/claude-code-plugin-project-type-requirements.md#Standards doc resolution (lines 70–75)]
- [Source: _bmad-output/planning-artifacts/prd-crew-v1/domain-specific-requirements.md#Standards doc (lines 26–27, 42)]
- [Source: _bmad-output/planning-artifacts/prd-crew-v1/innovation-novel-patterns.md#Standards as product surface (line 9); bloat anti-pattern (line 40)]
- [Source: _bmad-output/planning-artifacts/architecture/project-context-analysis.md#Standards doc (line 12, 43)]
- [Source: _bmad-output/planning-artifacts/architecture/project-structure-boundaries.md#mcp-server tree (lines 70–71, 87, 96–112, 121)]
- [Source: _bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md#Frontmatter conventions (§1); TypeScript conventions (§6)]
- [Source: _bmad-output/planning-artifacts/architecture/core-architectural-decisions.md#Version stamping (line 70)]
- [Source: _bmad-output/implementation-artifacts/1-1-scaffold-the-plugin-skeleton.md] (precedent: file layout, error types, NodeNext module resolution)
- [Source: _bmad-output/implementation-artifacts/1-2-workspace-resolver-and-per-target-repo-config.md] (precedent: `state/` IO boundary, Zod-schema location, typed-error pattern, fixture conventions)
- [Source: _bmad-output/implementation-artifacts/1-2b-stale-config-detection-on-every-skill-invocation.md] (precedent: distinct error subclasses, identity-preserving inputs, no-tool-wiring scope discipline)
- [Source: CLAUDE.md — Jack is PM; talk in PM language; planning-discipline rules apply; plugin slug is `crew`]

## Dev Agent Record

### Agent Model Used

claude-opus-4-7

### Debug Log References

- `pnpm install && pnpm build && pnpm test` from `plugins/crew/` — all green, 36 tests pass (5 new + 31 baseline).

### Completion Notes List

- Added `StandardsDocSchema` / `CriterionSchema` (strict, .max(10) cap) and types in `mcp-server/src/schemas/standards-doc.ts`.
- Appended `StandardsDocMissingError` and `StandardsDocMalformedError` to `mcp-server/src/errors.ts` (no existing classes touched).
- Authored pure parser `parseStandardsDoc` in `mcp-server/src/validators/standards-doc.ts` (new directory) — detects cap-violation Zod issue and replaces message with FR46 wording.
- Authored IO helper `lookupStandards` in `mcp-server/src/state/lookup-standards.ts` (ENOENT → typed missing-error, delegates to parser).
- Shipped copy-target `plugins/crew/docs/standards-example.md` (4 criteria, self-parses).
- Appended `## Standards doc` section to `plugins/crew/README.md` referencing the copy-target.
- Authored `mcp-server/tests/standards-doc.test.ts` + fixtures (missing, malformed-missing-field, malformed-cap-exceeded). Valid case copies the shipped example into a tmp dir at runtime.
- No new runtime deps; `pnpm-lock.yaml` unchanged.

### File List

- `plugins/crew/mcp-server/src/schemas/standards-doc.ts` (NEW)
- `plugins/crew/mcp-server/src/validators/standards-doc.ts` (NEW)
- `plugins/crew/mcp-server/src/state/lookup-standards.ts` (NEW)
- `plugins/crew/mcp-server/src/errors.ts` (UPDATED — append-only)
- `plugins/crew/docs/standards-example.md` (NEW)
- `plugins/crew/README.md` (UPDATED — appended Standards doc section)
- `plugins/crew/mcp-server/tests/standards-doc.test.ts` (NEW)
- `plugins/crew/mcp-server/tests/fixtures/standards/missing/.gitkeep` (NEW)
- `plugins/crew/mcp-server/tests/fixtures/standards/malformed-missing-field/docs/standards.md` (NEW)
- `plugins/crew/mcp-server/tests/fixtures/standards/malformed-cap-exceeded/docs/standards.md` (NEW)
