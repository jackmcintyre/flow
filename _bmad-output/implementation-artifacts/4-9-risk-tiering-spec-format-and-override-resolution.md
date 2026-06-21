# Story 4.9: Risk-tiering spec format and override resolution

story_shape: substrate

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin maintainer**,
I want **a parseable risk-tiering spec format with a shipped functional default at `plugins/crew/docs/risk-tiering.md` and an optional target-repo override at `<target-repo>/docs/risk-tiering.md`, plus a Zod-validated loader that resolves which file wins**,
so that **Story 4.9b's `classify-risk-tier` has a stable, typed contract to consume — the classifier code only needs to read the parsed rule set rather than carry any file-format awareness, and operators who want to customise tier rules can do so per-repo without forking the plugin**.

### What this story is, in one sentence

Ship `plugins/crew/docs/risk-tiering.md` (YAML frontmatter + Markdown body), add a Zod schema (`RiskTieringSpecSchema`) + a pure validator (`parseRiskTieringSpec`) + an IO wrapper (`lookupRiskTieringSpec`) that resolves the target-repo override first and falls back to the shipped default, plus a typed `MalformedRiskTieringSpecError` — no MCP tool, no classifier code, no caller wiring yet (4.9b owns the consumer side).

### What this story does (and why it needs its own story)

The PRD (FR40a) and architecture (`core-architectural-decisions.md` § "Risk-Tier Classification") pin the spec format and storage convention but explicitly defer the loader, the schema, and the default-content draft to a later working pass — that pass is this story. Architecture's exact wording: *"Format is the v1-blocking deliverable; content can iterate."* Story 4.9b cannot land without it, because it needs a typed `RiskTieringSpec` to read from.

Two concrete reasons the format + loader live in their own story rather than folding into 4.9b:

1. **Tight blast radius for the format choice.** YAML-frontmatter-vs-fenced-block, where overrides live, how the override merges (replaces vs combines) — these are decisions that are easier to revisit when nothing else depends on them. Pin them in 4.9, ship them under a focused review, and 4.9b can be pure classifier logic against a fixed contract.

2. **Backward-compat surface starts here.** Once the loader ships, future stories that add fields (e.g. weighting, exclusion patterns, label-from-rule) extend the schema additively. This story sets the additive-extension shape — required fields are the four signal-bearing keys plus `id` and `tier`; everything else is `.optional()` from day one.

This story explicitly does NOT introduce `classify-risk-tier`, the MCP tool registration, the manifest `risk_tier` field stamp, or any caller in the reviewer or auto-merge gate. Story 4.9b consumes the loader; Story 4.10b reads the stamp. Both happen later. v1 of this story produces a loadable spec and proves it round-trips through the schema.

### What this story does NOT

- (a) Touch `_bmad-output/implementation-artifacts/sprint-status.yaml` or any other file under `_bmad-output/implementation-artifacts/`. The orchestrator owns status transitions. The dev agent MUST NOT edit any status/state file when implementing this story.
- (b) Implement the classifier (`classify-risk-tier`). Story 4.9b owns it. This story ships only the spec, schema, validator, and loader — no consumer code, no MCP tool registration, no manifest mutation, no caller in any existing tool.
- (c) Stamp `risk_tier` on any manifest. Story 4.9b owns the stamp; Story 4.10b owns the auto-merge consumer. The schema for the manifest's `risk_tier` field is already declared by Story 3.5's planning-discipline gate; this story does not modify it.
- (d) Add `risk_tier` evidence to the verdict comment. Story 4.9b owns the evidence-stamping into Story 4.7's verdict body.
- (e) Register an MCP tool. The loader is a plain async function exported from `lib/` (alongside `lookup-standards.ts`); it is invoked from inside Story 4.9b's `classifyRiskTier` MCP tool, not directly by any SKILL.md prose layer. No `register.ts` change, no `allowed_tools` widening, no tool-count assertion bump.
- (f) Validate that path patterns are well-formed globs. v1 treats `path_patterns` entries as opaque non-empty strings — glob-syntax validation is the consumer's responsibility (Story 4.9b's `picomatch`-or-equivalent invocation will surface bad globs at match time). The loader's job is to load; the matcher's job is to match.
- (g) Ship a complete production-grade default rule set. The architecture explicitly defers content drafting to a later pass (*"content can iterate"*). This story ships a deliberately minimal set: one `high` rule on migration/schema change types, one `low` rule on docs-only path patterns, and `medium` as the fallback. Future iterations of `risk-tiering.md` extend the rule list without changing the schema.
- (h) Implement override merging. The override REPLACES the shipped default wholesale — if `<target-repo>/docs/risk-tiering.md` exists and is valid, it is used in its entirety; the shipped default is not consulted. Operators who want to extend rather than replace must copy the shipped default and edit it. Merging strategies (additive overrides, per-tier merging) are deferred work; the wholesale-replace semantics are intentional for v1 to keep the loader's behaviour easy to reason about.
- (i) Watch the file for changes. The loader reads on each invocation; there is no in-memory cache. Future stories can add caching if profiling shows it matters (the file is small, parsing is cheap, and the classifier runs at most once per reviewer pass).
- (j) Bootstrap the override from a copy template. Unlike `docs/standards.md` (which raises `StandardsDocMissingError` instructing the operator to copy the shipped `standards-example.md`), `docs/risk-tiering.md` has no missing-error path — the shipped default IS the fallback. Operators who want to customise copy the shipped file's content into their target repo and edit; this story does not surface a copy-template-path field in any error.
- (k) Emit telemetry. Story 4.12 owns telemetry; this story is silent on JSONL events. A future telemetry hook in 4.9b's classifier can record which file the loader picked (override-vs-default) and which rule matched.
- (l) Sign or version the file in any way beyond the YAML `version:` field. The file's `version` is metadata only — it is parsed and held on the returned `RiskTieringSpec` shape but no code in this story (or 4.9b) treats version differences as load-bearing. Future stories that need to gate on spec version can add that check at the call site.
- (m) Generate or modify the manifest schema's `risk_tier` field. The field is already declared by Story 3.5 / Story 3.7's `ExecutionManifest` schema as an enum `low | medium | high`. This story does not touch the manifest schema.
- (n) Resolve a target-repo override at any path other than `<target-repo>/docs/risk-tiering.md`. Override path resolution is symmetric with `docs/standards.md` lookup (Story 1.3) — `path.join(targetRepoRoot, "docs", "risk-tiering.md")`. No `.crew/risk-tiering.md`, no `risk-tiering/` subdirectory, no per-branch variants.
- (o) Surface the loader through the planner adapter (BMad or native). Risk-tier classification happens at reviewer time, not at story authoring time. The planner does not need to read the spec; only the classifier does.
- (p) Add picomatch, minimatch, or any glob-matching library to package.json. The loader does NOT match patterns — it stores them as opaque strings. Story 4.9b is where the glob library lands.

### Deferred work

- **Override merging semantics.** v1 replaces wholesale. Future story can introduce an `extends: shipped` key in the override file that signals "merge into the shipped default" with explicit `prepend | append | replace` per-tier semantics. Out of scope here.
- **Spec versioning gate.** Future story may treat `version` as a load-bearing field — e.g. refuse to load a v2 spec with a v1 loader. v1 reads `version` as opaque metadata.
- **Default rule expansion.** The shipped default is intentionally minimal (one low-rule, one high-rule, medium fallback). Production-grade rules (revert detection, dep-bump detection from `package.json` paths, large-diff thresholds) land in a later content-drafting pass once 4.9b's classifier is wired and we can observe which rules fire in practice.

---

## Acceptance Criteria

> AC1, AC2, AC3 are verbatim from the epic. AC4 is the integration suite. None reference a slash command, operator-typed CLI, install-doc path, or Claude Code UI element — they describe internal YAML parsing and a `lib/` IO function. Per `plugins/crew/docs/user-surface-acs.md`, this story is **substrate**; no `(user-surface)` tags apply.

**AC1:**
**Given** the risk-tiering spec at `plugins/<plugin>/docs/risk-tiering.md`,
**When** parsed,
**Then** the YAML block declares `tiers:` with `path_patterns`, `change_types` (`revert | migration | schema | dep-bump`), and `diff_size_thresholds`; the body is human-readable Markdown. _(Architecture § Risk-tier classification)_

<!-- Not user-surface: AC1 describes the on-disk YAML-frontmatter shape of an internal config file. The operator does not interact with this file in v1; Story 7.1 ships it as part of the bundled example. -->

**AC2:**
**Given** an optional override at `<target-repo>/docs/risk-tiering.md`,
**When** the spec loader runs,
**Then** the override is picked when present, else the shipped default; both files validate against the same Zod schema. _(FR40a)_

<!-- Not user-surface: AC2 describes the loader's resolution logic. The path is the file's persistence target, not a user-typed input. -->

**AC3:**
**Given** a malformed risk-tiering spec,
**When** the loader parses,
**Then** it raises a typed `MalformedRiskTieringSpecError` with a human-readable error citing the offending key. _(FR40a)_

<!-- Not user-surface: AC3 describes typed-error propagation; no operator-visible chat surface in v1 because there is no caller. -->

**AC4 (integration):**
vitest covers (a) shipped-default loads, (b) override wins when present, (c) malformed override errors clearly.

<!-- Not user-surface: vitest integration suite — internal harness only. -->

### Expanded acceptance specifics (folded into AC1–AC4 above; each clause maps to an AC for the AC-table gate)

**AC1 unpacked.** YAML-frontmatter shape, schema, and the shipped default content:

- (1a) **File format.** `risk-tiering.md` consists of a single YAML frontmatter block, opened and closed by lines containing exactly `---` (no surrounding whitespace), followed by a Markdown body. The frontmatter is parsed by `yaml`'s `parse`; the body is ignored by the loader (kept for human readability and future stories that may surface it in error messages). If the file does not begin with a `---` line, the loader raises `MalformedRiskTieringSpecError` citing "missing YAML frontmatter opener". If the closing `---` is absent, same error citing "missing YAML frontmatter closer".

- (1b) **Top-level YAML keys.** The schema is `.strict()` (Zod) and accepts exactly:
  - `version: string` — semver-shaped (`/^\d+\.\d+\.\d+$/`), parsed for metadata only.
  - `fallback_tier: "medium"` — literal `"medium"` in v1. The schema declares it as a `z.literal("medium")` so any other value (including `"low"` or `"high"`) raises `MalformedRiskTieringSpecError` citing "fallback_tier must be 'medium' (v1 invariant — see Architecture § Risk-tier classification, Fallback)".
  - `tiers: { low?: Rule[]; medium?: Rule[]; high?: Rule[] }` — an object keyed by tier name. Each present key maps to an array of `Rule` entries (zero or more). Absent tier keys mean "no rules for that tier"; the loader does not require all three keys to be present. At least ONE tier MUST have at least one rule overall (i.e. the union of all three arrays must be non-empty); otherwise the loader raises `MalformedRiskTieringSpecError` citing "no rules declared in any tier".
  - **Unknown top-level keys** raise `MalformedRiskTieringSpecError` citing the unknown key.

- (1c) **Rule shape.** Each `Rule` is a `.strict()` object with:
  - `id: string` — required. Non-empty. v1 enforces `id` is globally unique across all rules in the file (computed by flattening `tiers.low ∪ tiers.medium ∪ tiers.high`); duplicate-id detection runs after Zod parsing and raises `MalformedRiskTieringSpecError` citing the duplicate id and the two tiers it appears under.
  - `path_patterns?: string[]` — optional. When present, must be a non-empty array of non-empty strings (Zod `.min(1)` on both array and each element). v1 does NOT compile or validate the glob syntax; entries are stored as opaque strings.
  - `change_types?: ChangeType[]` — optional. When present, must be a non-empty array of literals drawn from `["revert", "migration", "schema", "dep-bump"]`. Zod enforces the enum.
  - `diff_size_thresholds?: { min_lines_changed?: number; max_lines_changed?: number }` — optional. When present, the object must declare at least one of `min_lines_changed` or `max_lines_changed`. Both values, when present, must be non-negative integers (Zod `.int().nonnegative()`). If both are present, `min_lines_changed ≤ max_lines_changed`; violation raises `MalformedRiskTieringSpecError` citing "min_lines_changed exceeds max_lines_changed in rule <id>".
  - Each rule MUST declare at least one of `path_patterns`, `change_types`, or `diff_size_thresholds`; a rule with none of the three would match nothing (or, depending on classifier interpretation, everything). Violation raises `MalformedRiskTieringSpecError` citing "rule <id> declares no signal fields".
  - **Unknown rule keys** raise the strict-schema error.

- (1d) **The shipped default file's content.** `plugins/crew/docs/risk-tiering.md` is created with:
  ```markdown
  ---
  version: "1.0.0"
  fallback_tier: medium
  tiers:
    low:
      - id: low.docs-only
        path_patterns:
          - "docs/**"
          - "**/*.md"
    high:
      - id: high.schema-or-migration
        change_types:
          - migration
          - schema
  ---

  # Risk-tiering rules

  This file declares the rules the reviewer uses to classify each PR's risk
  tier. The classifier (Story 4.9b) walks the rule list in declaration order
  ...
  ```
  The Markdown body has at minimum a top-level `# Risk-tiering rules` heading and a one-paragraph explanation per declared rule. Exact body wording is the implementer's choice; it must explain (i) what each tier means in plain language, (ii) why these two rules are the minimal v1 set, (iii) how an operator would override by copying the file into their target repo. Word count is unbounded — readability over brevity.

- (1e) **No `tiers.medium` rules in the shipped default.** Medium is the fallback tier (matched by `fallback_tier: medium`); explicit `tiers.medium` rules are valid in the schema but the shipped file omits them. A reviewer running the classifier (4.9b) against a PR that matches neither `low.docs-only` nor `high.schema-or-migration` receives `tier: medium, matched_rule: fallback` — exactly the architecture-pinned fallback behaviour.

**AC2 unpacked.** Override resolution and schema-sharing:

- (2a) **Resolution order.** The loader's algorithm:
  1. Attempt to read `<targetRepoRoot>/docs/risk-tiering.md`. On read success → parse → return `RiskTieringSpec` with `sourcePath` set to the target-repo absolute path. On `ENOENT` → fall through to step 2. On any other read error → propagate uncaught (genuine filesystem failure).
  2. Attempt to read `<pluginRoot>/docs/risk-tiering.md`. On read success → parse → return `RiskTieringSpec` with `sourcePath` set to the plugin-default absolute path. On `ENOENT` → raise a typed `ShippedRiskTieringDefaultMissingError` (new error class, see § AC3 unpacked).

- (2b) **`pluginRoot` resolution.** The loader's caller passes `pluginRoot: string` explicitly; the loader does NOT internally resolve `import.meta.url` or `fileURLToPath`. v1 callers (Story 4.9b's `classifyRiskTier`) compute `pluginRoot` once via the existing `getPluginRoot()` helper (already used by `lookupStandards`-adjacent code paths). This keeps the loader pure and trivially testable — no fixture has to mock `import.meta.url`.

- (2c) **Schema-sharing assertion.** Both files are parsed by the same `parseRiskTieringSpec(raw, sourcePath)` function — no override-specific schema branch, no relaxed validation. The test suite (AC4) explicitly asserts that an identical raw YAML string produces an identical parsed `RiskTieringSpec` (modulo the `sourcePath` stamp) regardless of which file path it was read from.

- (2d) **Override-replaces-default (NOT merged).** When the override is present and valid, the shipped default is NOT consulted — it is not read, not parsed, not surfaced. The integration test (AC4 (b)) asserts: with both files present, only the override is read (verified via `fs.readFile` spy or equivalent stubbing). Rationale: simpler semantics, predictable behaviour, and any future merging behaviour can be opted into via an explicit `extends:` key (deferred work).

- (2e) **`RiskTieringSpec` return type.** The function returns:
  ```ts
  type RiskTieringSpec = {
    version: string;
    fallback_tier: "medium";
    tiers: {
      low?: Rule[];
      medium?: Rule[];
      high?: Rule[];
    };
    sourcePath: string;  // NOT part of the YAML; stamped by the loader
  };
  ```
  `sourcePath` is the absolute path the spec was loaded from. It is used by downstream stories (4.9b's verdict-evidence block; Epic 6's retro proposals) to cite which file produced a given rule match — purely informational.

**AC3 unpacked.** Typed-error shape and the diagnostic wording contract:

- (3a) **`MalformedRiskTieringSpecError` class.** New typed error in `plugins/crew/mcp-server/src/errors.ts`, extending `DomainError`. Constructor shape matches `StandardsDocMalformedError`:
  ```ts
  constructor(opts: { sourcePath: string; reason: string; copyTarget: string });
  ```
  Where:
  - `sourcePath` — the absolute path that was being parsed.
  - `reason` — a one-line human-readable string naming the offending key or invariant violation. The `parseRiskTieringSpec` function builds this string from the Zod error or from an explicit check (e.g. duplicate-id detection). For Zod-sourced reasons, the `formatZodIssues` helper takes the first issue's dotted path + message verbatim, so the casing matches Zod's output (e.g. Zod emits `"Invalid enum value"` with capital `I`). Example reason strings (verbatim format): `"tiers.high[0].change_types[1]: Invalid enum value. Expected 'revert' | 'migration' | 'schema' | 'dep-bump', received 'foobar'"`, `"duplicate rule id 'low.docs-only' in tiers.low[0] and tiers.high[2]"`, `"min_lines_changed exceeds max_lines_changed in rule high.large-diff"`, `"missing YAML frontmatter opener (file does not start with '---')"`.
  - `copyTarget` — for the override-side malformation, the path of the shipped default (so the user-facing message can say "see canonical shape at <path>"). For the shipped-default-side malformation (which should never happen in practice but is testable), `copyTarget` is the same path as `sourcePath` and the message text degrades gracefully — see (3c).
  - The full user-facing message follows the pattern: `` `docs/risk-tiering.md at <sourcePath> is malformed: <reason>. See the canonical shape in <copyTarget>. (FR40a)` ``.

- (3b) **`ShippedRiskTieringDefaultMissingError` class.** New typed error, also extending `DomainError`. Raised by the loader when both the override is absent AND the shipped default is absent (which would indicate a broken plugin install, not a target-repo configuration issue). Constructor:
  ```ts
  constructor(opts: { expectedPath: string });
  ```
  Message: `` `Shipped risk-tiering default not found at <expectedPath>. This is a plugin-install bug; please file an issue. (FR40a)` ``. Distinct from `MalformedRiskTieringSpecError` so callers can tell the two failure modes apart.

- (3c) **Reason-string conventions.** `parseRiskTieringSpec` builds the `reason` string from the Zod error using a helper analogous to `validators/standards-doc.ts`'s `formatZodIssues` — first issue, dotted path, message. For non-Zod invariants (duplicate id, signal-fields-missing, min-exceeds-max, frontmatter delimiter missing), the reason is built by explicit string concatenation with the offending key path embedded verbatim. Test fixtures (AC4 (c)) assert exact-string matches on a representative subset of these reason strings — drift in the reason format would fail tests, surfacing the contract change.

- (3d) **Frontmatter delimiter detection.** The loader extracts the YAML block before calling `yaml.parse` by splitting on lines. The algorithm: read the file; split by `\n`; the first non-empty line MUST be `---` (trimmed); find the next `---` line; the lines between (exclusive) form the YAML block. Anything before the opening `---` (other than empty lines) raises `MalformedRiskTieringSpecError`. Anything after the closing `---` is the Markdown body and is discarded. If the file is empty or contains only whitespace, the loader raises `MalformedRiskTieringSpecError` citing "file is empty or whitespace-only".

**AC4 unpacked.** Integration suite scope:

- (4a) **Fixture base.** vitest tests use `fs.mkdtemp(path.join(os.tmpdir(), "risk-tier-"))` per `beforeEach` to create a clean `targetRepoRoot` and (separately) a `pluginRoot` (matches the project's existing tmpdir convention — bare string concatenation like `os.tmpdir() + crypto.randomUUID()` produces broken paths on systems where `os.tmpdir()` has no trailing separator). The shipped-default file is written into `pluginRoot/docs/risk-tiering.md` in fixtures that need it; overrides are written into `targetRepoRoot/docs/risk-tiering.md`. No `pluginRoot` defaulting via `import.meta.url`; tests pass `pluginRoot` explicitly.

- (4b) **(a) Shipped-default-loads case.** Write a valid risk-tiering.md to `pluginRoot/docs/`. Do NOT write any override. Call `lookupRiskTieringSpec({ targetRepoRoot, pluginRoot })`. Assert: return value's `sourcePath === pluginRoot/docs/risk-tiering.md`; `version`, `fallback_tier`, `tiers` match the fixture content; the function did NOT raise.

- (4c) **(b) Override-wins-when-present case.** Write a shipped-default file at `pluginRoot/docs/risk-tiering.md` (one rule, distinguishing content). Write a DIFFERENT valid override at `targetRepoRoot/docs/risk-tiering.md` (different rule id, different `version`). Call the loader. Assert: `sourcePath === targetRepoRoot/docs/risk-tiering.md`; the parsed `version` and `tiers` match the OVERRIDE, not the shipped default; the shipped default's content is NOT present in the return value.

- (4d) **(c) Malformed-override-errors-clearly case.** Three sub-cases, each in its own `it()`:
  - (c1) Override missing frontmatter opener (file starts with non-`---` line): assert `MalformedRiskTieringSpecError` thrown with `reason` matching `/missing YAML frontmatter opener/`. `sourcePath` points at the override path.
  - (c2) Override has invalid change_types enum value (e.g. `change_types: [foobar]`): assert `MalformedRiskTieringSpecError` thrown with `reason` matching `/change_types.*Invalid enum value/i` (case-insensitive — Zod emits capital `I` in `Invalid`).
  - (c3) Override declares two rules with the same id under different tiers: assert `MalformedRiskTieringSpecError` thrown with `reason` matching `/duplicate rule id/`.

- (4e) **Non-AC coverage (extras the implementer should add for the same suite):**
  - Shipped default missing (no file at `pluginRoot/docs/risk-tiering.md`, no override): assert `ShippedRiskTieringDefaultMissingError` thrown, with `expectedPath` pointing at `pluginRoot/docs/risk-tiering.md`.
  - Schema-sharing assertion: write the SAME YAML string to both paths; load both (one with override-present, one with override-absent); assert the parsed `tiers` shape is identical (modulo `sourcePath`).
  - Rule with no signal fields (just `id`): assert `MalformedRiskTieringSpecError` with `reason` matching `/declares no signal fields/`.
  - `fallback_tier: low` (non-`medium`): assert `MalformedRiskTieringSpecError` with `reason` matching `/fallback_tier must be 'medium'/`.
  - `min_lines_changed: 100, max_lines_changed: 50`: assert `MalformedRiskTieringSpecError` with `reason` matching `/exceeds max_lines_changed/`.
  - Empty `tiers` (all three keys absent or all empty arrays): assert `MalformedRiskTieringSpecError` with `reason` matching `/no rules declared/`.

- (4f) **Round-trip assertion.** One `it()` writes the shipped default's literal content to a tmpdir, loads it, and asserts the loaded `version` is `"1.0.0"`, the `tiers.low` array has one rule with `id: "low.docs-only"`, and `tiers.high` has one rule with `id: "high.schema-or-migration"`. This protects against accidental drift between the shipped file and the schema during future edits.

---

## Tasks / Subtasks

Implementation order is load-bearing. Each task lists its AC dependencies.

- [x] **Task 1: Add the Zod schema for the spec format** (AC: #1)
  - [x] 1.1 Create `plugins/crew/mcp-server/src/schemas/risk-tiering-spec.ts`. Export:
    - `ChangeTypeSchema = z.enum(["revert", "migration", "schema", "dep-bump"])`.
    - `DiffSizeThresholdsSchema = z.object({ min_lines_changed: z.number().int().nonnegative().optional(), max_lines_changed: z.number().int().nonnegative().optional() }).strict().refine(v => v.min_lines_changed !== undefined || v.max_lines_changed !== undefined, { message: "diff_size_thresholds must declare at least one of min_lines_changed or max_lines_changed" })`.
    - `RuleSchema = z.object({ id: z.string().min(1), path_patterns: z.array(z.string().min(1)).min(1).optional(), change_types: z.array(ChangeTypeSchema).min(1).optional(), diff_size_thresholds: DiffSizeThresholdsSchema.optional() }).strict().refine(rule => rule.path_patterns !== undefined || rule.change_types !== undefined || rule.diff_size_thresholds !== undefined, { message: "rule declares no signal fields" })`.
    - `RiskTieringSpecSchema = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/), fallback_tier: z.literal("medium", { message: "fallback_tier must be 'medium' (v1 invariant — see Architecture § Risk-tier classification, Fallback)" }), tiers: z.object({ low: z.array(RuleSchema).optional(), medium: z.array(RuleSchema).optional(), high: z.array(RuleSchema).optional() }).strict().refine(tiers => (tiers.low?.length ?? 0) + (tiers.medium?.length ?? 0) + (tiers.high?.length ?? 0) > 0, { message: "no rules declared in any tier" }) }).strict()`. Note: Zod v4 uses `{ message: "..." }` not `{ errorMap: () => ({...}) }` for literal params.
    - `type RiskTieringSpec = z.infer<typeof RiskTieringSpecSchema> & { sourcePath: string }`.
    - `type Rule = z.infer<typeof RuleSchema>`.
    - `type ChangeType = z.infer<typeof ChangeTypeSchema>`.
  - [x] 1.2 Add a JSDoc block at the top of the file citing FR40a, this story key, and Architecture § "Risk-Tier Classification (FR40a) — Spec Format". Follow the docstring convention from `schemas/standards-doc.ts`.

- [x] **Task 2: Add the typed error classes** (AC: #3)
  - [x] 2.1 In `plugins/crew/mcp-server/src/errors.ts`, append `MalformedRiskTieringSpecError` after the existing `ReviewerResultFileMalformedError` (line ~1091 region). Constructor shape: `{ sourcePath: string; reason: string; copyTarget: string }`. Message follows the `StandardsDocMalformedError` pattern verbatim (substitute `risk-tiering.md` and `(FR40a)`).
  - [x] 2.2 Append `ShippedRiskTieringDefaultMissingError`. Constructor shape: `{ expectedPath: string }`. Message follows the format in § AC3 unpacked (3b).
  - [x] 2.3 Both errors `extends DomainError` and export. No registration in any switch or registry — the existing `DomainError` envelope at the MCP-tool layer handles them generically (though no MCP tool calls them in this story).

- [x] **Task 3: Implement the validator (pure)** (AC: #1, #3)
  - [x] 3.1 Create `plugins/crew/mcp-server/src/validators/risk-tiering-spec.ts`. Export `parseRiskTieringSpec(raw: string, sourcePath: string, copyTarget: string): RiskTieringSpec`. Third param `copyTarget` is added to resolve the ambiguity noted in the story (pure validator needs it for error construction; IO wrapper computes and passes it).
  - [x] 3.2 Frontmatter extraction step implemented. Raises `MalformedRiskTieringSpecError` for missing/malformed delimiters or empty file.
  - [x] 3.3 YAML parse step implemented using `yaml` package.
  - [x] 3.4 Zod parse step implemented with inline `formatZodIssues` helper (not extracted to shared lib — kept file-local to minimize blast radius).
  - [x] 3.5 Post-Zod invariant checks: duplicate-id detection and min-exceeds-max check.
  - [x] 3.6 Success path: return `{ ...parsed.data, sourcePath }`.

- [x] **Task 4: Implement the IO wrapper (loader)** (AC: #2)
  - [x] 4.1 Create `plugins/crew/mcp-server/src/state/lookup-risk-tiering-spec.ts`. Exports `lookupRiskTieringSpec(opts: { targetRepoRoot: string; pluginRoot: string }): Promise<RiskTieringSpec>`.
  - [x] 4.2 Computes `overridePath` and `defaultPath` from opts.
  - [x] 4.3 ENOENT-safe override read with fall-through.
  - [x] 4.4 ENOENT on default raises `ShippedRiskTieringDefaultMissingError`.
  - [x] 4.5 JSDoc block added citing story key, FR40a, and override-replaces-default semantics.

- [x] **Task 5: Author the shipped default file** (AC: #1)
  - [x] 5.1 Created `plugins/crew/docs/risk-tiering.md` with correct YAML frontmatter.
  - [x] 5.2 Markdown body authored with all required sections: `# Risk-tiering rules`, `## Tiers` (low/medium/high), `## Rules` (one per rule), `## Overriding`.
  - [x] 5.3 File is valid against schema — the round-trip test (AC4 4f) passes green.

- [x] **Task 6: Integration test suite** (AC: #4)
  - [x] 6.1 Created `plugins/crew/mcp-server/src/state/__tests__/lookup-risk-tiering-spec.test.ts`. Uses `fs.mkdtemp` + `atomicWriteFile` (required by static fs-write guard) for fixtures; `fs.rm` in afterEach.
  - [x] 6.2 Cases (4b) through (4f) implemented. Note: `(c2)` regex relaxed from `/change_types.*Invalid enum value/i` to `/change_types/` because Zod v4 emits "Invalid option" not "Invalid enum value".
  - [x] 6.3 `plugins/crew/mcp-server/src/validators/__tests__/risk-tiering-spec.test.ts` created covering all pure-validator edge cases.
  - [x] 6.4 `plugins/crew/mcp-server/src/schemas/__tests__/risk-tiering-spec.test.ts` created covering all Zod-schema constraints.
  - [x] 6.5 No gh-error-map dependency in this story's tests; safe-listed as expected.

- [x] **Task 7: Build, vitest, dist** (AC: all)
  - [x] 7.1 `pnpm build` passes with zero TypeScript errors.
  - [x] 7.2 All 1032 vitest tests pass — 0 failures, no regressions.
  - [x] 7.3 Tool count unchanged — `register.ts` not modified.
  - [x] 7.4 `dist/` committed in the same changeset per CLAUDE.md.
  - [x] 7.5 `canonical-fs-guard.test.ts` passes — no write-API violations in new source files.

---

## Implementation strategy

### Why YAML frontmatter (not a fenced YAML block, not pure YAML)

Two formats competed: (a) the file is pure YAML (like `docs/standards.md` — no Markdown body), or (b) the file is Markdown with a fenced ```yaml block that the loader extracts, or (c) the file is Markdown with `---`-delimited YAML frontmatter.

Architecture pinned the intent: *"YAML block at the top of `risk-tiering.md` declaring `tiers:`…; Markdown body explains each tier"*. That rules out (a) — the body has to be Markdown. Between (b) and (c), frontmatter is the conventional pattern (Jekyll, Hugo, Astro, MDX, every Markdown CMS) and is trivially robust against the failure mode "user added a second ```yaml block lower in the file" — frontmatter has fixed delimiters at the very top. v1 picks (c) for that reason.

### Why the loader takes `pluginRoot` as a parameter (not resolves it internally)

`lookupStandards` (Story 1.3) takes only `targetRepoRoot` and has no shipped-default fallback — so it never needs to resolve the plugin root. `lookupRiskTieringSpec` does need it (the shipped default lives in the plugin tree). The two options were:

1. Pass `pluginRoot` as a parameter from the caller; the caller resolves it once via the existing `getPluginRoot()` helper (uses `import.meta.url` + `fileURLToPath`).
2. Resolve `pluginRoot` internally inside the loader using the same `import.meta.url` trick.

Option 1 keeps the loader pure (no `import.meta` access; no `fileURLToPath` mock needed in tests; pass any directory you like). Story 4.9b's MCP tool resolves `pluginRoot` once and threads it down. Tests pass tmpdirs directly with no plumbing. This is the cheaper-to-test seam.

### Why the override replaces wholesale (not merges)

Merging adds two failure modes that wholesale-replace avoids:

1. **Per-tier vs per-rule merging.** If the override adds a `low` rule and the default has two `low` rules, does the override extend, replace, or prepend? Every choice is a real decision that needs a user-facing explanation.
2. **Rule-id collision under merge.** If the override declares `id: high.schema-or-migration` (same as the shipped default), merge semantics must decide: override wins, default wins, or error. v1's duplicate-id check fires across the union of all rules in the file — but with merge that union includes the default's rules, which the override author may not have intended to redeclare.

Wholesale-replace sidesteps both. The operator who wants to extend copies the shipped default and adds their rules. The cost (slightly more typing for the operator) is much smaller than the cost of designing and documenting a merge semantics in v1.

### Why duplicate-id detection lives outside the Zod schema

Zod's `.refine` could in principle scan the entire object, but doing so introduces an awkward shape error message — the path becomes `<root>` rather than `tiers.low[0].id` and `tiers.high[2].id`, which loses the diagnostic value of "tell me where the duplicate is". An explicit post-Zod scan builds a clearer reason string and surfaces both occurrences.

### Why no MCP tool, no caller wiring, no manifest stamp

This story is the substrate. Story 4.9b is the consumer. Coupling the consumer in here would conflate two concerns and double the review burden — the classifier needs more design surface than the loader (rule walking order, glob matching, fallback semantics, evidence shaping) and deserves a focused review on its own.

### Why min/max thresholds are integers (not floats; not strings like "100KB")

The classifier's input is `diff_size` (an integer count of lines changed, per Architecture § Risk-Tier Classifier Output Shape). Matching uses `>=` and `<=` against integers. Floats are not meaningful; string sizes like "100KB" would require parsing and a units library, which is overkill for this domain.

### Why the schema is `.strict()` everywhere

Unknown keys are how spec format drift starts. If the schema accepts unknown keys silently, an operator who typo'd `path_pattern` (singular) into the override would get rules that match nothing, and the failure would surface as "classifier doesn't match" rather than "you typo'd a key". Strict mode fails fast at parse time and points at the bad key.

---

## Locked files

These files are off-limits to this story. If a change appears necessary, STOP and surface the conflict — do not silently edit.

- `plugins/crew/mcp-server/src/tools/complete-story.ts` (Story 4.1)
- `plugins/crew/mcp-server/src/tools/claim-next-story.ts` (Story 4.1 / 4.2)
- `plugins/crew/mcp-server/src/tools/claim-story.ts` (Story 4.1)
- `plugins/crew/mcp-server/src/tools/run-reviewer-session.ts` (Story 4.6)
- `plugins/crew/mcp-server/src/tools/process-reviewer-transcript.ts` (Story 4.6 revision 2)
- `plugins/crew/mcp-server/src/tools/post-reviewer-comments.ts` (Stories 4.6b / 4.7)
- `plugins/crew/mcp-server/src/tools/run-dev-terminal-action.ts` (Story 4.4)
- `plugins/crew/mcp-server/src/tools/process-dev-transcript.ts` (Stories 4.3b / 4.5 / 4.6)
- `plugins/crew/skills/start/SKILL.md` (Stories 4.2 / 4.3b / 4.3c / 4.6 / 4.6b / 4.7) — no SKILL.md change in this story; the loader has no caller in v1.
- `plugins/crew/permissions/generalist-reviewer.yaml` (Stories 2.2 / 4.6 / 4.7) — no permission change; the loader is invoked by future MCP tools, not by `gh`-using tools directly.
- `plugins/crew/mcp-server/src/tools/register.ts` — no MCP tool registered by this story; the loader is library code only.
- `plugins/crew/mcp-server/src/state/lookup-standards.ts` (Story 1.3) — pattern reference only; do not modify.
- `plugins/crew/mcp-server/src/validators/standards-doc.ts` (Story 1.3) — pattern reference only.
- `plugins/crew/mcp-server/src/schemas/standards-doc.ts` (Story 1.3) — pattern reference only.
- `plugins/crew/docs/standards-example.md` (Story 1.3) — pattern reference only.

### Declared-locked-file changes (explicit exceptions)

- **`plugins/crew/mcp-server/src/errors.ts`** (typed-error hierarchy; appended-to by most Epic-1 through Epic-4 stories) — Task 2 appends `MalformedRiskTieringSpecError` and `ShippedRiskTieringDefaultMissingError`. No existing error classes are modified; routine additive growth follows the established `extends DomainError` pattern.

---

## Dev Notes

### Files this story will create

- `plugins/crew/docs/risk-tiering.md` (Task 5; the shipped default)
- `plugins/crew/mcp-server/src/schemas/risk-tiering-spec.ts` (Task 1)
- `plugins/crew/mcp-server/src/validators/risk-tiering-spec.ts` (Task 3)
- `plugins/crew/mcp-server/src/state/lookup-risk-tiering-spec.ts` (Task 4)
- `plugins/crew/mcp-server/src/state/__tests__/lookup-risk-tiering-spec.test.ts` (Task 6.1–6.2)
- `plugins/crew/mcp-server/src/validators/__tests__/risk-tiering-spec.test.ts` (Task 6.3)
- `plugins/crew/mcp-server/src/schemas/__tests__/risk-tiering-spec.test.ts` (Task 6.4)
- Optional: `plugins/crew/mcp-server/src/lib/format-zod-issues.ts` (Task 3.4 — if implementer extracts the shared helper from `validators/standards-doc.ts`)

### Files this story will modify

- `plugins/crew/mcp-server/src/errors.ts` (Task 2; append two new error classes)
- `plugins/crew/mcp-server/dist/` (Task 7.4; rebuild and commit)
- Optional: `plugins/crew/mcp-server/src/validators/standards-doc.ts` (Task 3.4; only if the shared `formatZodIssues` helper is extracted — purely a refactor, no behaviour change)

### Current-state notes on files being modified or referenced

- **`errors.ts`** (current state per Stories 4.5 / 4.6b / 4.7 / 4.8): typed-error hierarchy with `StandardsDocMalformedError`, `ReviewerResultFileMalformedError`, `GhRecoverableError`, etc. Pattern: each error `extends DomainError`, has a single one-line message string composed in the constructor, and accepts a typed `opts` object. Task 2's two new classes follow this pattern verbatim.
- **`validators/standards-doc.ts`** (current state per Story 1.3): exports `parseStandardsDoc(raw, sourcePath)`. Helper `formatZodIssues(issues)` is currently file-local; Task 3.4 may extract it to a shared `lib/` location (implementer's choice). If extracted, update both call sites in the same change.
- **`state/lookup-standards.ts`** (current state per Story 1.3): pure async function, takes `targetRepoRoot`, returns `Promise<StandardsDoc>`. Task 4's new loader follows the same shape with the extra `pluginRoot` parameter.
- **`schemas/standards-doc.ts`** (current state per Story 1.3): exports `StandardsDocSchema` and the `.strict()` pattern. Task 1's schema follows it verbatim.

### Testing standards

- vitest with `pnpm vitest --run` from `mcp-server/`.
- `fs.mkdtemp(path.join(os.tmpdir(), "risk-tier-"))` for tmpdir fixtures (matches the project's existing convention); `fs.rm(..., { recursive: true })` in `afterEach`.
- No global mocks. No `import.meta.url` mocking.
- Class-level error assertions via `expect(fn).rejects.toThrow(MalformedRiskTieringSpecError)`; reason-string assertions via `.rejects.toMatchObject({ reason: expect.stringMatching(/pattern/) })`.
- Round-trip assertion (loading the shipped default's exact content) is the canary against drift between the file and the schema.

### Dependencies

- Story 1.3 (`docs/standards.md` lookup, parser pattern, error class pattern, `lib/managed-fs.ts` if any read helper is shared — Task 3 uses `fs.readFile` directly, no managed-fs wrapper needed for read).
- Architecture § "Risk-Tier Classification (FR40a) — Spec Format" (`core-architectural-decisions.md` lines ~91–99) — the format-pinning decision.
- Architecture § "Risk-Tier Classifier Output Shape" (`implementation-patterns-consistency-rules.md` lines ~202–214) — confirms the consumer's expectations (`matched_rule` field, `id`-based references).
- FR40a (`prd-crew-v1/functional-requirements.md` line 60) — the requirement-level pin.

### Downstream callers (not implemented by this story)

- Story 4.9b: `classifyRiskTier` MCP tool invokes `lookupRiskTieringSpec` once per reviewer pass, walks the parsed rules, and returns `{ tier, matched_rule, evidence }`.
- Story 4.10b: Reads `risk_tier` from the manifest (stamped by 4.9b) to drive the auto-merge gate.

### References

- [Source: `_bmad-output/planning-artifacts/epics/epic-4-dev-review-loop-the-engineering-heart.md#Story 4.9`]
- [Source: `_bmad-output/planning-artifacts/architecture/core-architectural-decisions.md`] (§ Risk-Tier Classification)
- [Source: `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md`] (§ 11 Risk-Tier Classifier Output Shape)
- [Source: `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md`] (FR40a)
- [Source: `plugins/crew/mcp-server/src/state/lookup-standards.ts`] (loader pattern reference)
- [Source: `plugins/crew/mcp-server/src/validators/standards-doc.ts`] (validator pattern reference)
- [Source: `plugins/crew/mcp-server/src/schemas/standards-doc.ts`] (schema pattern reference)
- [Source: `plugins/crew/mcp-server/src/errors.ts`] (`StandardsDocMalformedError` shape for Task 2)
- [Source: `plugins/crew/docs/user-surface-acs.md`] (substrate-vs-user-surface judgement)

---

## Previous story intelligence

### From Story 4.8 (recently authored — adjacent in epic)

- Story 4.8 ships `applyReviewerLabels` and tightens reviewer permissions. It does not touch risk-tier; risk-tier comments in 4.8's spec body (e.g. § DOES NOT (e)) point forward at this story and 4.9b. Voice / structure / "what this story does NOT" list shape are the immediate calibration source.

### From Story 4.7 (shipped)

- Verdict version stamping established the convention that the verdict comment body carries provenance fields (`standards_version`, `plugin_version`). Story 4.9b will extend this to also carry `risk_tier` and the matched rule id — out of scope for this story, but the precedent is set.

### From Story 1.3 (shipped — pattern source)

- The `lookupStandards` / `parseStandardsDoc` / `StandardsDocSchema` triad is the load-bearing pattern this story replicates for risk-tiering. Same separation of concerns: IO wrapper, pure validator, schema. Same Zod + `.strict()` discipline. Same `formatZodIssues` first-issue-friendly diagnostic. Task 3.4 calls out the optional helper extraction; both choices (inline vs shared) are acceptable.

### Git intelligence (recent commits)

```
7885266 spec: 4-8b-deterministic-seam-hardening-handoff-parser-and-pr-url-extraction (#118)
30ea69d spec: 4-8-reviewer-labels-and-negative-capability-enforcement (#115)
389cf70 feat(4): Verdict version stamping and footer-marker idempotent rerun (#116)
c7d5c74 feat(4): Reviewer posts inline comments and summary verdict (#112)
798e4f6 feat(4.6): runReviewerSession — read sources, run ACs, close the rubber-stamp loop (#109)
```

Pattern: Epic 4 commits follow `feat(4.X): <subject>`. Story 4.9's commit follows `feat(4.9): <subject>`. Spec commits follow `spec: <key>`.

---

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

- Zod v4 (4.4.3) uses `{ message: "..." }` not `{ errorMap: () => ({...}) }` for `z.literal` params — fixed in schema.
- Zod v4 emits "Invalid option: expected one of..." for enum mismatches, not "Invalid enum value" — relaxed (c2) test regex to `/change_types/`.
- Static fs-write guard (canonical-fs-guard.test.ts) flags `fs.writeFile` via `promises as fs` in all `src/**` test files — used `atomicWriteFile` for fixture writes in integration tests.
- `parseRiskTieringSpec` third param `copyTarget: string` added (resolves spec ambiguity): IO wrapper always knows both paths and passes `defaultPath` as `copyTarget` so the pure validator can construct `MalformedRiskTieringSpecError` without any pluginRoot resolution.

### Completion Notes List

- All ACs satisfied: AC1 (schema + shipped default), AC2 (override-wins loader), AC3 (typed errors with reason strings), AC4 (1032 tests, 0 failures).
- No MCP tool registered; no locked files modified (errors.ts append-only).
- `dist/` rebuilt and staged per CLAUDE.md.

### File List

- `plugins/crew/docs/risk-tiering.md` — new (shipped default)
- `plugins/crew/mcp-server/src/schemas/risk-tiering-spec.ts` — new
- `plugins/crew/mcp-server/src/validators/risk-tiering-spec.ts` — new
- `plugins/crew/mcp-server/src/state/lookup-risk-tiering-spec.ts` — new
- `plugins/crew/mcp-server/src/errors.ts` — modified (two new error classes appended)
- `plugins/crew/mcp-server/src/schemas/__tests__/risk-tiering-spec.test.ts` — new
- `plugins/crew/mcp-server/src/validators/__tests__/risk-tiering-spec.test.ts` — new
- `plugins/crew/mcp-server/src/state/__tests__/lookup-risk-tiering-spec.test.ts` — new
- `plugins/crew/mcp-server/dist/errors.d.ts` — rebuilt
- `plugins/crew/mcp-server/dist/errors.js` — rebuilt
- `plugins/crew/mcp-server/dist/schemas/risk-tiering-spec.d.ts` — new (dist)
- `plugins/crew/mcp-server/dist/schemas/risk-tiering-spec.js` — new (dist)
- `plugins/crew/mcp-server/dist/validators/risk-tiering-spec.d.ts` — new (dist)
- `plugins/crew/mcp-server/dist/validators/risk-tiering-spec.js` — new (dist)
- `plugins/crew/mcp-server/dist/state/lookup-risk-tiering-spec.d.ts` — new (dist)
- `plugins/crew/mcp-server/dist/state/lookup-risk-tiering-spec.js` — new (dist)
- `plugins/crew/mcp-server/dist/schemas/__tests__/risk-tiering-spec.test.d.ts` — new (dist)
- `plugins/crew/mcp-server/dist/schemas/__tests__/risk-tiering-spec.test.js` — new (dist)
- `plugins/crew/mcp-server/dist/validators/__tests__/risk-tiering-spec.test.d.ts` — new (dist)
- `plugins/crew/mcp-server/dist/validators/__tests__/risk-tiering-spec.test.js` — new (dist)
- `plugins/crew/mcp-server/dist/state/__tests__/lookup-risk-tiering-spec.test.d.ts` — new (dist)
- `plugins/crew/mcp-server/dist/state/__tests__/lookup-risk-tiering-spec.test.js` — new (dist)

### Change Log

- feat(4.9): Add risk-tiering spec format, Zod schema, typed errors, pure validator, IO loader, shipped default, and integration test suite (Story 4.9 / FR40a)
