# Story 4.9b: Risk-tier classifier code, evidence stamping, and fallback

story_shape: substrate

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin maintainer**,
I want **a `classifyRiskTier` MCP tool that consumes the loaded risk-tiering spec from Story 4.9 plus a PR's diff signals and returns the Pattern §11 output shape (`{ tier, matched_rule, evidence }`), wired into `runReviewerSession` so the result lands in `reviewer-result.json`, with `composeSummaryBody` rendering an evidence block in the verdict comment AND `postReviewerComments` stamping `risk_tier` + `risk_tier_evidence` on the in-progress manifest after the verdict POST succeeds**,
so that **Story 4.10b's auto-merge gate (and any future risk-aware consumer — labelling, telemetry retros, calibration loop) has a single source of truth for every PR's tier, computed deterministically from declared rules in `docs/risk-tiering.md` rather than re-inferred from chat or guessed by an LLM**.

### What this story is, in one sentence

Add a glob library (`picomatch`), a `classifyRiskTier` MCP tool composing `lookupRiskTieringSpec` (Story 4.9) + a new `detectChangeTypes` helper + a new `matchRules` helper + the highest-tier-wins walk order, extend the closed `ExecutionManifestSchema` with optional `risk_tier` and `risk_tier_evidence` fields, extend the `reviewer-result.json` parser with a `riskTier` block, wire `classifyRiskTier` into `runReviewerSession` so every reviewer pass writes the classification into the result file, extend `composeSummaryBody` in `postReviewerComments` to render a verbatim `## Risk tier evidence` block, stamp the manifest after POST-success in the same tool, and ship a vitest suite covering the four classification branches (path / change-type / size / fallback) plus the stamp-both-places integration.

### What this story does (and why it needs its own story)

PRD `FR40a` and architecture (Pattern §11) pin the classifier output shape. Story 4.9 shipped the spec format, schema, loader, and shipped default — explicitly deferring the consumer code, the glob matcher, the change-type detection, the manifest field, and the evidence stamping to "Story 4.9b" (this story). Story 4.10b (the auto-merge gate) reads `risk_tier` from the manifest to decide auto-merge vs `needs-human`; Story 4.9b is the producer 4.10b consumes from. Without 4.9b, the auto-merge gate has nothing to gate on.

The classifier has three substrate-level decisions worth pinning in their own story rather than folding into 4.10b:

1. **Highest-tier-wins walk order.** When a PR's diff matches rules in multiple tiers (e.g. a migration that also touches docs), the classifier must pick the highest tier — not the first declared. This is the safe default for risk classification (false negatives on `low` are bad; false positives on `high` are merely paused-for-human). Pinning this in 4.9b means the matcher's contract is `low | medium | high` discriminator semantics, not "first-declared-rule wins" — and 4.10b can trust the result without re-reading the spec.

2. **Change-type detection from filenames and commit messages.** The four `ChangeType` literals (`revert | migration | schema | dep-bump`) declared in the spec schema are inferred at classify-time from a small set of filename and commit-message heuristics (`migrations/` paths, `package.json` / `*.lock` paths, `Revert "...` commit-message prefix). These heuristics are the classifier's contract — additive new types in a future story extend the discriminator and the detector together. This story ships the v1 four; the spec's `change_types: ChangeType[]` field accepts only these four (Story 4.9 schema), so the detector and the spec format stay in lockstep.

3. **The dual stamping seam.** Pattern §11 says the result is "stamped into the story frontmatter (`risk_tier`) AND the verdict comment." In our v1 architecture: "story frontmatter" maps to the in-progress execution manifest's new `risk_tier` field; "the verdict comment" maps to the deterministic body composed by `postReviewerComments`. Both writes happen at the same seam — after the POST/PATCH succeeds inside `postReviewerComments`. Doing the stamp in two places (one for manifest, one for body) at one call site is simpler than splitting across tools and keeps the contract "if there's a verdict comment, there's a `risk_tier` stamp on the manifest" trivially true.

This story explicitly does NOT introduce the auto-merge gate (Story 4.10b owns it), modify the catalogue, change the risk-tiering spec format (Story 4.9 pinned it), introduce a `risk_tier` consumer in any planner adapter, or touch `start/SKILL.md`. The reviewer subagent (`generalist-reviewer`) does not need to call `classifyRiskTier` directly — `runReviewerSession` calls it transparently as part of producing `reviewer-result.json`, so `permissions/generalist-reviewer.yaml` is unchanged.

### What this story does NOT

- (a) Touch `_bmad-output/implementation-artifacts/sprint-status.yaml` or any other file under `_bmad-output/implementation-artifacts/`. The orchestrator owns status transitions. The dev agent MUST NOT edit any status/state file when implementing this story.
- (b) Implement the auto-merge gate (Story 4.10b). 4.10b reads `manifest.risk_tier` + `agreement_metric` (from Story 4.10) and decides auto-merge / `needs-human`. This story is consumer-agnostic — it ships the producer; 4.10b ships the gate. No code in this story reads `risk_tier` once written.
- (c) Implement the agreement metric (Story 4.10). The `reviewer.verdict` + `reviewer.verdict.merge_action` events from Story 4.12 carry the data; 4.10 computes the rolling ratio. This story is orthogonal.
- (d) Modify the risk-tiering spec format. Story 4.9 pinned the schema (`RiskTieringSpecSchema`). This story is a pure consumer of the parsed shape.
- (e) Add additional `ChangeType` literals beyond Story 4.9's `revert | migration | schema | dep-bump`. The detector ships exactly these four. An additive future story (e.g. `lockfile` as a distinct type, or `infrastructure-as-code` for terraform) extends both the spec schema enum and the detector heuristics in one coordinated edit.
- (f) Modify `start/SKILL.md`. The SKILL.md wiring is unchanged — `runReviewerSession` is already called by the reviewer subagent (under `runReviewerSession` permission in `generalist-reviewer.yaml`); the classifier runs inside `runReviewerSession` and is invisible to the SKILL.md prose.
- (g) Modify `permissions/generalist-reviewer.yaml` or `permissions/generalist-dev.yaml`. `classifyRiskTier` is exposed as an MCP tool for future direct callers (e.g. a stats CLI in Epic 6), but in v1 the only production caller is `runReviewerSession` via a plain function import — no subagent ever needs the tool surface directly.
- (h) Add picomatch as a regular dependency in any other package — only `plugins/crew/mcp-server/package.json`.
- (i) Implement caching of the parsed spec across reviewer passes. `lookupRiskTieringSpec` reads from disk on every classifier invocation (the file is small; the read happens at most once per reviewer pass). A future perf story can add caching if profiling shows it matters.
- (j) Stamp `risk_tier` on manifests in any state OTHER than `in-progress`. The stamp happens after the POST/PATCH succeeds in `postReviewerComments`, which only runs when a story is being reviewed (i.e. `in-progress`). Stamping on `done/` or `blocked/` manifests is out of scope.
- (k) Render the evidence block in any reviewer comment OTHER than the summary body composed by `composeSummaryBody`. Inline comments (the line-level "AC FAIL" markers in `postReviewerComments`) do not carry the evidence block.
- (l) Surface a "tier promoted" or "tier demoted" diff between runs. If a reviewer re-runs (PATCH path), the new classification overwrites the prior `risk_tier` on the manifest verbatim — there is no history field, no telemetry of "tier changed from medium to high". A future story can add a `risk_tier_history` field or a dedicated telemetry event.
- (m) Add a `risk_tier_unknown` or `risk_tier_pending` sentinel. The classifier always returns one of `low | medium | high`; the spec's `fallback_tier: "medium"` invariant guarantees a result even when no rule matches.
- (n) Add telemetry for the classifier (e.g. a `classifier.match` event). Story 4.12 owns telemetry; the durable record of every classification is the manifest stamp + verdict body. Adding a classification event is an additive future change.
- (o) Resolve plugin root from `import.meta.url`. The classifier accepts `pluginRoot` as a caller-supplied option (same pattern as `lookupRiskTieringSpec`). The single resolution point is wherever the calling tool decides — for v1, `runReviewerSession` will resolve it via the existing helper used by `lookupStandards` and pass it through.
- (p) Validate that the spec's declared `change_types` are detectable. The classifier accepts the four literals the schema enforces; the detector handles them. If a future story adds a `change_types: ["formatting"]` rule but the detector doesn't know "formatting", the classifier never matches it — surfaced as a no-match → fallback. The spec author's responsibility.
- (q) Compute `diff_size` from anything other than the caller-supplied integer. The tool does NOT parse a unified diff to count added/removed lines; the caller (`runReviewerSession`) hands `diffSize` in as an integer derived from the existing `gh pr diff` output it already runs. Where the count comes from is the caller's responsibility; the classifier treats it as opaque.

### Deferred work

- **Classifier telemetry event** (e.g. `risk.classified`). Useful for retro analytics ("how often does each rule fire?") but not load-bearing for the auto-merge gate. Additive future story.
- **`risk_tier` history on the manifest.** A future calibration story may want "this PR was classified `low` then `high` after the second rework round" as a signal. v1 overwrites in place.
- **Parsed-spec cache.** Read-per-invocation is fine for v1 file sizes. If profiling shows it matters, a module-scoped cache with mtime-invalidation can be added without changing the tool's signature.
- **Extended `ChangeType` taxonomy.** `lockfile`, `infrastructure-as-code`, `test-only`, `comment-only` are all candidates. Each requires a coordinated edit to Story 4.9's enum and this story's detector.
- **`docs/risk-tiering.md` rule expansion.** Story 4.9 shipped a deliberately minimal default (one low-rule on docs, one high-rule on migration/schema). Production-grade rules (revert detection, lockfile-only dep bumps, large-diff thresholds) are content iteration on the existing format; this story does not expand the shipped default beyond what Story 4.9 produced.

---

## Acceptance Criteria

> AC1, AC2, AC3 are verbatim from the epic. AC4 is the integration suite. None reference a slash command, operator-typed CLI, install-doc path, or Claude Code UI element — they describe an internal MCP tool, internal Pattern §11 output shape, a manifest schema field, and a deterministic Markdown block embedded in the verdict comment by `composeSummaryBody`. Per `plugins/crew/docs/user-surface-acs.md`, this story is **substrate**; no `(user-surface)` tags apply.

**AC1:**
**Given** a story's diff and the loaded spec from Story 4.9,
**When** `classify-risk-tier` runs,
**Then** it returns `{ tier: low | medium | high, matched_rule: <rule-id>, evidence: { paths, change_types, diff_size } }`. _(FR40a)_

<!-- Not user-surface: AC1 describes the MCP tool's return shape (Pattern §11). The tool is internal — never invoked directly by a subagent in v1; only by `runReviewerSession` via internal import. -->

**AC2:**
**Given** a diff matching no declared rule,
**When** the classifier runs,
**Then** it returns `tier: medium` with `matched_rule: "fallback"`. _(FR40a fallback)_

<!-- Not user-surface: AC2 describes the fallback branch of the same internal tool. -->

**AC3:**
**Given** a classified story,
**When** the result lands,
**Then** `risk_tier` is stamped in the manifest and the evidence block is recorded in the verdict comment body. _(Pattern §11)_

<!-- Not user-surface: AC3 describes (i) a manifest field write and (ii) a deterministic Markdown block embedded in the PR-review summary body composed by `composeSummaryBody`. The PR-review body eventually surfaces to the operator on GitHub, but that surface is owned by Story 4.6b (PR comment posting); this AC describes the body-composition seam, not the posting. -->

**AC4 (integration):**
vitest covers four classification branches (path match, change-type match, size match, fallback) and asserts evidence is stamped both places.

<!-- Not user-surface: vitest integration suite — internal harness only. -->

### Expanded acceptance specifics (folded into AC1–AC4 above; each clause maps to an AC for the AC-table gate)

**AC1 unpacked.** `classifyRiskTier` MCP tool, matching algorithm, return shape:

- (1a) **New MCP tool: `classifyRiskTier`.** Signature:
  ```ts
  classifyRiskTier(opts: {
    targetRepoRoot: string;
    pluginRoot: string;
    storyId: string;
    changedPaths: string[];   // POSIX-style relative paths, e.g. ["src/foo.ts", "docs/README.md"]
    commitMessages: string[]; // verbatim commit subject lines, e.g. ['Revert "feat: X"', "chore: bump deps"]
    diffSize: number;         // total lines added + removed across the PR
  }): Promise<RiskTierClassifierResult>
  ```
  Returns the Pattern §11 shape (see 1b). Throws no typed errors of its own — propagates `lookupRiskTieringSpec`'s errors (`MalformedRiskTieringSpecError`, `ShippedRiskTieringDefaultMissingError`) verbatim. The caller (`runReviewerSession`) is responsible for surfacing those.

- (1b) **Return shape — Pattern §11 verbatim.**
  ```ts
  type RiskTierClassifierResult = {
    story_id: string;
    tier: "low" | "medium" | "high";
    matched_rule: string;  // rule id from spec, or the literal "fallback"
    evidence: {
      paths: string[];          // subset of changedPaths that contributed to the match (empty on fallback)
      change_types: ChangeType[]; // detected types from this diff (regardless of match)
      diff_size: number;        // verbatim from input
    };
  };
  ```
  `ChangeType` is `"revert" | "migration" | "schema" | "dep-bump"` (Story 4.9 schema). The result object is `.strict()`-shaped — only the keys above appear in the output; consumers can rely on this for byte-stable serialisation.

- (1c) **Walk order: highest tier wins.** The classifier walks rules in tier order `high → medium → low` (NOT declaration order). Within each tier, rules are walked in their declared array order. The first rule that matches stops the walk and returns its tier. Rationale: false negatives on `high` are dangerous (a migration auto-merged); false positives on `high` are merely paused-for-human (`needs-human` label). The safe default is "any matching `high` rule wins over any matching `low` rule." This is opposite to "first-declared wins" — pin the contract here; consumers (4.10b) rely on it.

- (1d) **Rule match — three independent signals, AND-combined within a rule.** A rule matches when EVERY declared signal field on it matches the diff:
  - `path_patterns`: if present, AT LEAST ONE `changedPaths` entry matches AT LEAST ONE pattern (via `picomatch` with default options). If absent, the path signal is "not declared" and does not constrain the match.
  - `change_types`: if present, AT LEAST ONE detected change type (from `detectChangeTypes(changedPaths, commitMessages)`) appears in the rule's array. If absent, not declared.
  - `diff_size_thresholds`: if present, `diffSize` satisfies the bounds (`min_lines_changed ≤ diffSize ≤ max_lines_changed`, with absent bounds treated as `-∞` and `+∞` respectively). If absent, not declared.

  Story 4.9's schema enforces that every rule declares AT LEAST ONE of the three signals; the classifier does NOT need to handle an all-absent rule. AND-combination means a rule declaring both `path_patterns` and `change_types` matches only when BOTH conditions hold.

- (1e) **`paths` evidence — which changed paths contributed.** When a rule with `path_patterns` matches, `evidence.paths` is the subset of `changedPaths` that matched ANY of the rule's patterns. When a rule with only `change_types` (no `path_patterns`) matches, `evidence.paths` is the subset of `changedPaths` whose change-type detection contributed to the match (e.g. for a `migration` match, the `migrations/**` paths that triggered the detector). When only `diff_size_thresholds` matches, `evidence.paths` is `[]` (size is a whole-diff property, not per-path). On fallback, `evidence.paths` is `[]`.

- (1f) **`change_types` evidence — always the full detected set.** Regardless of which rule matched (or fallback), `evidence.change_types` is the COMPLETE detected set from `detectChangeTypes(changedPaths, commitMessages)`. This is per Pattern §11's intent: the evidence block tells the operator what the classifier *saw*, not just what it matched on. Sorted alphabetically for stable output.

- (1g) **`diff_size` evidence — verbatim input.** `evidence.diff_size = opts.diffSize`. The classifier does not recompute.

- (1h) **No mutation of inputs.** The function is pure-ish (the one impure step is `lookupRiskTieringSpec`'s disk read). `changedPaths` and `commitMessages` arrays are not sorted, deduplicated, or mutated in place — the classifier reads them and produces a new result object. Downstream stability (deterministic byte-stable evidence block) comes from sorting AT THE EVIDENCE LEVEL (see 1i), not from mutating inputs.

- (1i) **Deterministic evidence ordering.** Inside the returned `evidence` object: `paths` is sorted lexicographically; `change_types` is sorted lexicographically (so `["dep-bump", "migration"]` always renders the same way regardless of detection order). This means two reviewer runs against the same diff produce byte-identical evidence — critical for the verdict-comment idempotency marker (Story 4.7).

**AC2 unpacked.** Fallback branch:

- (2a) **Trigger condition.** After the `high → medium → low` walk completes with no rule matching, the classifier returns:
  ```ts
  {
    story_id: opts.storyId,
    tier: spec.fallback_tier,  // "medium" — Story 4.9 schema literal
    matched_rule: "fallback",  // literal string, NOT a rule id
    evidence: {
      paths: [],
      change_types: <detected set, sorted>,
      diff_size: opts.diffSize,
    },
  }
  ```

- (2b) **`matched_rule` is the literal `"fallback"`, not `spec.fallback_tier`.** Pattern §11 uses `"fallback"` as a sentinel string distinguishing "no rule matched" from "a rule named `fallback` matched". The spec's schema does not reserve `"fallback"` as a rule id, but a hand-written spec could declare one — the matcher does not special-case the string, so a rule with `id: "fallback"` would simply match by its declared signals and overwrite the sentinel. This is acceptable v1 behaviour; a future schema version can reject `id: "fallback"` at parse time. Add a note in the spec's documentation but no runtime enforcement.

- (2c) **`tier` reads from the parsed spec.** The classifier does NOT hardcode `"medium"`; it reads `spec.fallback_tier`. Story 4.9's schema declares `fallback_tier: z.literal("medium")` so the value is structurally guaranteed, but reading from the parsed object keeps the classifier symmetric with the spec and ready for a future Story 4.9 schema relaxation.

- (2d) **No telemetry, no manifest change-of-flow on fallback.** The fallback path is the common case for unremarkable PRs. It is not a warning, not an error; it produces a standard result the downstream consumer (`postReviewerComments`) renders identically to any other result. The verdict body's evidence block on fallback reads:
  ```
  ## Risk tier evidence

  - **tier:** medium
  - **matched rule:** fallback (no rule matched)
  - **paths:** _none_
  - **change types:** <detected list, comma-separated, or _none_>
  - **diff size:** <N> lines
  ```

**AC3 unpacked.** Manifest stamp + verdict-body evidence block:

- (3a) **Manifest schema extension.** Append two optional fields to `ExecutionManifestSchema`:
  - `risk_tier: z.enum(["low", "medium", "high"]).optional()`
  - `risk_tier_evidence: z.object({ matched_rule: z.string().min(1), paths: z.array(z.string()).default([]), change_types: z.array(ChangeTypeSchema).default([]), diff_size: z.number().int().nonnegative() }).strict().optional()`

  Both fields are optional so existing manifests (and all `to-do/`, `blocked/` manifests scanned before this story shipped) continue to parse unchanged. The fields appear only when written by `postReviewerComments` after a successful POST.

- (3b) **`ChangeTypeSchema` reuse.** Import `ChangeTypeSchema` from `schemas/risk-tiering-spec.ts` (Story 4.9) for the `risk_tier_evidence.change_types` array element type. Single source of truth for the four literals.

- (3c) **Manifest field placement.** New fields appear AT THE END of `ExecutionManifestSchema` (after `rework_count`). YAML round-trip ordering follows declaration order; placing additive fields at the end keeps diffs against existing manifests minimal.

- (3d) **`reviewer-result.json` extension.** Extend `read-reviewer-result-file.ts`'s parsed shape with a `riskTier` block:
  ```ts
  riskTier?: {
    tier: "low" | "medium" | "high";
    matched_rule: string;
    evidence: {
      paths: string[];
      change_types: ChangeType[];
      diff_size: number;
    };
  };
  ```
  The block is optional on read for backward compatibility with any test fixture or session-result file generated before this story. The writer (`runReviewerSession`) always emits it post-this-story. The parser validates the shape via a sibling schema derived from `RiskTierClassifierResultSchema` with `story_id` omitted — export this as `RiskTierBlockSchema = RiskTierClassifierResultSchema.omit({ story_id: true })` from `classify-risk-tier.ts` and reuse. (The classifier output schema keeps `story_id` because Pattern §11 declares it; the on-disk block in `reviewer-result.json` drops it because the file already carries `ref` at its top level — single source of truth.)

- (3e) **`runReviewerSession` wiring.** After `runReviewerSession` completes its existing AC-walk + standards-walk and BEFORE writing `reviewer-result.json` to disk: call `classifyRiskTier({ targetRepoRoot, pluginRoot, storyId: ref, changedPaths, commitMessages, diffSize })`. The inputs are derived from the `gh pr diff` and `gh pr view --json commits` outputs already collected by `runReviewerSession`. The returned `RiskTierClassifierResult` is attached to the result file as `riskTier: { tier, matched_rule, evidence }` (rename keys to match the field on disk — `story_id` is dropped since the file already carries `ref`).

- (3f) **`composeSummaryBody` evidence block.** Inside `composeSummaryBody`, append the verbatim block AFTER the existing verdict line and version block, BEFORE the locked footer marker. The block format (verbatim — tested byte-equal in vitest):
  ```
  ## Risk tier evidence

  - **tier:** <tier>
  - **matched rule:** <matched_rule>
  - **paths:** <comma-separated paths, or _none_>
  - **change types:** <comma-separated detected types, or _none_>
  - **diff size:** <N> lines
  ```
  When `resultFile.riskTier` is undefined (legacy or test fixture without classification), the block is omitted entirely — no header, no placeholder. This preserves backward compatibility with the existing `composeSummaryBody` test suite.

- (3g) **Manifest stamp inside `postReviewerComments`.** After the POST/PATCH succeeds AND the `reviewer.verdict` telemetry emission (Story 4.12 Task 3) — i.e. as the next step inside the same success path — read the in-progress manifest at `<targetRepoRoot>/.crew/state/in-progress/<ref>.yaml`, set:
  - `risk_tier = resultFile.riskTier.tier`
  - `risk_tier_evidence = { matched_rule, paths, change_types, diff_size }` (verbatim from the result file)

  Write back via `writeManifest`. The write is wrapped in try/catch: a manifest-stamp failure MUST NOT roll back the verdict comment that is already on GitHub. On failure, log via the existing typed-error path and continue; the next reviewer run (PATCH path) will re-stamp.

- (3h) **No stamp when classification absent.** If `resultFile.riskTier` is undefined (legacy run, pre-this-story session result), the stamp step is a no-op. Same backward-compatibility principle as the body block (3f).

- (3i) **PATCH path semantics.** On a re-run (PATCH path), the classifier runs again inside `runReviewerSession` (new `reviewer-result.json`), the body re-renders with the new evidence block, and the manifest stamp overwrites. There is no comparison-against-prior, no "tier changed" log line — overwrite-in-place is the v1 contract.

- (3j) **`risk_tier` is NOT cleared on rework.** When a story re-enters `in-progress` from a `NEEDS CHANGES` verdict, the manifest still carries the prior `risk_tier`. The next successful classifier run overwrites it; until then, the stale value is visible. Stale tier on a rework-pending manifest is acceptable v1 behaviour — the auto-merge gate (4.10b) only consults `risk_tier` on a `READY FOR MERGE` verdict, which by definition requires a fresh successful reviewer pass that re-stamps.

- (3k) **Concurrency.** No concurrency guard beyond the existing `readManifest` → `writeManifest` round-trip pattern. Matches the existing `processDevTranscript` / `processReviewerTranscript` precedent. A parallel writer to the same manifest between the read and write could drop the stamp; that race is acknowledged across the codebase and is the existing baseline.

**AC4 unpacked.** Integration suite scope:

- (4a) **Fixture base.** vitest tests use `await fs.mkdtemp(path.join(os.tmpdir(), "classify-risk-tier-"))` per `beforeEach` to create a clean `targetRepoRoot`. `afterEach` cleans via `fs.rm(..., { recursive: true, force: true })`. The fixture seeds:
  - `<targetRepoRoot>/.crew/state/in-progress/<ref>.yaml` — a minimal valid in-progress manifest.
  - `<tmpPluginRoot>/docs/risk-tiering.md` — the spec under test (per test, varies).

  No mocking of `lookupRiskTieringSpec`, `picomatch`, or `logTelemetryEvent`. The classifier runs against the real spec parser and the real glob matcher.

- (4b) **(a) Path match.** Seed a spec with one `high` rule declaring `path_patterns: ["**/migrations/**"]` and a `low` rule declaring `path_patterns: ["docs/**"]`. Call `classifyRiskTier` with `changedPaths: ["db/migrations/0042_users.sql", "docs/README.md"]`, `commitMessages: ["chore: add users migration"]`, `diffSize: 50`. Assert: `tier: "high"`, `matched_rule: <high rule id>`, `evidence.paths: ["db/migrations/0042_users.sql"]`, `evidence.change_types` is the detected set (here `["migration"]` — but the `path_patterns`-only rule's match does NOT depend on change-type detection; this just confirms the evidence captures both signals). Verify the `low` rule was NOT chosen despite matching: highest-tier-wins.

- (4c) **(b) Change-type match.** Seed a spec with one `high` rule declaring `change_types: ["migration", "schema"]` only (no `path_patterns`, no `diff_size_thresholds`). Call with `changedPaths: ["db/schema.sql"]`, `commitMessages: ["chore: rotate schema"]`, `diffSize: 10`. The `schema` change-type is detected from the path `db/schema.sql`. Assert: `tier: "high"`, `matched_rule: <rule id>`, `evidence.paths: ["db/schema.sql"]`, `evidence.change_types: ["schema"]`.

- (4d) **(c) Size match.** Seed a spec with one `high` rule declaring `diff_size_thresholds: { min_lines_changed: 1000 }` only. Call with `changedPaths: ["src/foo.ts"]`, `commitMessages: ["refactor: extract"]`, `diffSize: 1500`. Assert: `tier: "high"`, `matched_rule: <rule id>`, `evidence.paths: []` (size-only rules contribute no paths), `evidence.change_types: []` (no detected types — `src/foo.ts` is none of migration/schema/dep-bump/revert), `evidence.diff_size: 1500`.

- (4e) **(d) Fallback.** Seed a spec with one `low` rule declaring `path_patterns: ["docs/**"]` only. Call with `changedPaths: ["src/foo.ts"]`, `commitMessages: ["feat: bar"]`, `diffSize: 30`. The path does not match. Assert: `tier: "medium"`, `matched_rule: "fallback"`, `evidence.paths: []`, `evidence.change_types: []`, `evidence.diff_size: 30`.

- (4f) **(e) Highest-tier-wins ordering.** Seed a spec with `low` rule on `path_patterns: ["**"]` (matches everything) AND `high` rule on `path_patterns: ["**/migrations/**"]`. Call with `changedPaths: ["db/migrations/0001.sql"]`. Assert: `tier: "high"` — confirms the `low` rule was correctly skipped even though it matched.

- (4g) **(f) Stamp-both-places integration.** Seed a fixture with:
  - In-progress manifest (no `risk_tier` yet)
  - Spec with `high` rule on `change_types: ["migration"]`
  - A `reviewer-result.json` with `recommendedVerdict: "READY FOR MERGE"` and a populated `riskTier` block (the classifier output from a synthetic call)
  - Stub `gh api` to succeed (existing `post-reviewer-comments` test pattern)

  Call `postReviewerComments`. Assert:
  - The POST body contains the verbatim `## Risk tier evidence` block with the correct fields.
  - The in-progress manifest, re-read after the call, has `risk_tier: "high"` and the matching `risk_tier_evidence` block.
  - The `reviewer.verdict` telemetry event (Story 4.12) is still written exactly once (no double-emission).

- (4h) **(g) Backward-compat: missing classification.** Same fixture but with `reviewer-result.json` lacking the `riskTier` block entirely. Assert: `postReviewerComments` succeeds; the POST body does NOT contain `## Risk tier evidence`; the manifest is NOT stamped (the optional `risk_tier` field remains undefined). Confirms (3f) and (3h).

- (4i) **(h) Manifest stamp best-effort.** Same as (g) but with `riskTier` present and the `writeManifest` call stubbed to throw `EACCES`. Assert: `postReviewerComments` returns successfully (does NOT raise); the POST body still contains the evidence block; the telemetry event still fires; the original POST is not rolled back. (Per 3g — manifest-stamp failure must not roll back a committed comment.)

- (4j) **`detectChangeTypes` unit tests** (separate `describe` block). A small matrix exercising the detector independently:
  - `["db/migrations/0042.sql"]` → `["migration"]`
  - `["prisma/schema.prisma"]` → `["schema"]`
  - `["db/schema.sql"]` → `["schema"]` (the `**/schema.{sql,prisma,graphql}` pattern)
  - `["package.json", "pnpm-lock.yaml"]` → `["dep-bump"]`
  - `["Cargo.lock"]` → `["dep-bump"]`
  - `[]` + `["Revert \"feat: foo\""]` → `["revert"]`
  - `["src/foo.ts"]` + `["fix: bar"]` → `[]` (no types)
  - `["db/migrations/0001.sql", "package.json"]` → `["dep-bump", "migration"]` (sorted)
  - Empty inputs → `[]`

- (4k) **`matchRules` unit tests** (separate `describe` block). Exercises the rule-matching primitive independently of the spec walk. Cover:
  - All three signal types match individually (already covered by 4b–4d at the integration level; here they exercise the primitive).
  - AND-combination: rule with `path_patterns` + `change_types` matches only when both hold; fails when only one holds.
  - `diff_size_thresholds` with `min_lines_changed: 100, max_lines_changed: 200` matches `diffSize: 150` but not `99` or `201`.
  - `picomatch` POSIX behaviour: forward-slash paths match `**/*.md` regardless of OS (no path-separator normalisation needed since inputs are POSIX).

- (4l) **Determinism / byte-stability.** A separate `it()` calls the classifier twice with identical inputs (same arrays, same order); asserts the two results are `deepStrictEqual`. A second `it()` calls with the same inputs but shuffled `changedPaths`; asserts the resulting `evidence.paths` and `evidence.change_types` are identically ordered (sorted). This is the contract that backs the verdict-marker idempotency.

- (4m) **Schema-strict assertions.** Attempt to parse a `risk_tier_evidence` block with an unknown extra key in `evidence`. Assert Zod parse fails. Same for an unknown tier value on the `risk_tier` field.

---

## Tasks / Subtasks

Implementation order is load-bearing. Each task lists its AC dependencies.

- [ ] **Task 1: Add `picomatch` dependency** (AC: #1, #2)
  - [ ] 1.1 In `plugins/crew/mcp-server/`, run `pnpm add picomatch` to add it as a regular dependency. Pin the resolved version (do NOT pre-pick a version; let pnpm resolve to the latest stable, then commit `package.json` + `pnpm-lock.yaml` with the resolved version).
  - [ ] 1.2 Also `pnpm add -D @types/picomatch` for the TypeScript types.
  - [ ] 1.3 Verify the import works: `import picomatch from "picomatch";` in a scratch file before continuing.

- [ ] **Task 2: `detectChangeTypes` helper** (AC: #1)
  - [ ] 2.1 Create `plugins/crew/mcp-server/src/lib/detect-change-types.ts`.
  - [ ] 2.2 Export `detectChangeTypes(changedPaths: string[], commitMessages: string[]): ChangeType[]`.
  - [ ] 2.3 Algorithm:
    - `migration` if any path matches `**/migrations/**` OR `**/migration/**` (via `picomatch`).
    - `schema` if any path matches `**/schema.{sql,prisma,graphql}` OR `**/*.sql` (e.g. `db/schema.sql`, `prisma/schema.prisma`).
    - `dep-bump` if any path is one of: `package.json`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `Gemfile.lock`, `Pipfile.lock`, `Cargo.lock`, `go.sum`, `composer.lock`, `Pipfile`, `requirements.txt`. Exact basename match — use `path.basename` (POSIX form).
    - `revert` if any commit message starts with the literal `Revert "` (case-sensitive).
  - [ ] 2.4 Return value: sorted lexicographically, deduplicated.
  - [ ] 2.5 JSDoc citing this story key, FR40a, the v1 heuristic taxonomy, and a note that additive change types require a coordinated spec-schema edit.
  - [ ] 2.6 Create `plugins/crew/mcp-server/src/lib/__tests__/detect-change-types.test.ts` covering AC4 sub-case (4j).

- [ ] **Task 3: `matchRules` helper** (AC: #1)
  - [ ] 3.1 Create `plugins/crew/mcp-server/src/lib/match-rules.ts`.
  - [ ] 3.2 Export `matchRule(rule: Rule, ctx: { changedPaths: string[]; detectedChangeTypes: ChangeType[]; diffSize: number }): { matched: boolean; matchedPaths: string[] }`.
  - [ ] 3.3 Implement the three-signal AND-combination per AC1 unpacked (1d). When `path_patterns` matches, `matchedPaths` is the subset of `changedPaths` that hit ANY pattern; otherwise `matchedPaths` is `[]` (the caller fills paths from change-type detection on a `change_types`-only match — see Task 4.4).
  - [ ] 3.4 Use `picomatch` with default options (`dot: false`). Reuse a per-rule compiled matcher (compile once per `path_patterns` array, reuse for the matcher's lifetime) — not cached across rules.
  - [ ] 3.5 JSDoc citing this story key, Pattern §11, AND-combination semantics.
  - [ ] 3.6 Create `plugins/crew/mcp-server/src/lib/__tests__/match-rules.test.ts` covering AC4 sub-case (4k).

- [ ] **Task 4: `classifyRiskTier` MCP tool** (AC: #1, #2)
  - [ ] 4.1 Create `plugins/crew/mcp-server/src/tools/classify-risk-tier.ts`.
  - [ ] 4.2 Export a Zod schema `RiskTierClassifierResultSchema` matching the Pattern §11 output (1b). `.strict()` on every level. Also export `RiskTierBlockSchema = RiskTierClassifierResultSchema.omit({ story_id: true })` — the on-disk shape used inside `reviewer-result.json` (where `ref` is the canonical story id at the file's top level). `read-reviewer-result-file.ts` (Task 6) consumes `RiskTierBlockSchema`; the tool's own return value uses `RiskTierClassifierResultSchema`.
  - [ ] 4.3 Implement the algorithm:
    1. Call `lookupRiskTieringSpec({ targetRepoRoot, pluginRoot })`.
    2. Call `detectChangeTypes(changedPaths, commitMessages)`.
    3. Walk tiers in `["high", "medium", "low"]` order. For each tier with rules declared, walk rules in declaration order. For each rule, call `matchRule(rule, ctx)`. On the first `matched: true`:
       - If the matched rule had `path_patterns`, `evidence.paths = matchedPaths` (sorted).
       - Else if it had `change_types`, `evidence.paths` is the subset of `changedPaths` that contributed to any detected change type matching the rule (use the same detection per-path; see Task 4.4 for the helper).
       - Else (`diff_size_thresholds` only), `evidence.paths = []`.
       - Return `{ story_id, tier, matched_rule: rule.id, evidence: { paths: <sorted>, change_types: <detected, sorted>, diff_size } }`.
    4. If no rule matches across all tiers, return `{ story_id, tier: spec.fallback_tier, matched_rule: "fallback", evidence: { paths: [], change_types: <detected, sorted>, diff_size } }`.
  - [ ] 4.4 Add a small helper `pathsContributingToChangeTypes(changedPaths, changeTypes): string[]` (also exported, internal) that for a given subset of detected change types returns the changed paths that triggered those types. Used for the `change_types`-only match's `evidence.paths`. The implementation reuses the same path-classification logic from `detectChangeTypes` (refactor `detectChangeTypes` to expose a per-path classifier internally, or duplicate the predicates — choose whichever keeps the file under ~150 lines).
  - [ ] 4.5 JSDoc citing this story key, FR40a, FR40a fallback, Pattern §11, the highest-tier-wins contract, and the no-typed-errors-of-its-own clause (propagates `lookupRiskTieringSpec`'s errors verbatim).
  - [ ] 4.6 Create `plugins/crew/mcp-server/src/tools/__tests__/classify-risk-tier.test.ts` covering AC4 sub-cases (4b)–(4f), (4l), (4m).

- [ ] **Task 5: Extend `ExecutionManifestSchema`** (AC: #3)
  - [ ] 5.1 In `plugins/crew/mcp-server/src/schemas/execution-manifest.ts`, append two optional fields after `rework_count`:
    - `risk_tier: z.enum(["low", "medium", "high"]).optional()` — the classifier's tier verdict.
    - `risk_tier_evidence: z.object({ matched_rule: z.string().min(1), paths: z.array(z.string()).default([]), change_types: z.array(ChangeTypeSchema).default([]), diff_size: z.number().int().nonnegative() }).strict().optional()` — the evidence block.
  - [ ] 5.2 Import `ChangeTypeSchema` from `./risk-tiering-spec.js` (Story 4.9). Single source of truth for the four literals.
  - [ ] 5.3 Verify (in an existing manifest round-trip test or by adding a new one) that existing manifests without these fields continue to parse.
  - [ ] 5.4 No new typed error; the existing `MalformedExecutionManifestError` covers schema-parse failures.

- [ ] **Task 6: Extend `reviewer-result.json` parser** (AC: #3)
  - [ ] 6.1 In `plugins/crew/mcp-server/src/lib/read-reviewer-result-file.ts`, extend the parsed shape with an optional `riskTier` block matching Pattern §11.
  - [ ] 6.2 Use `RiskTierBlockSchema` (exported from `tools/classify-risk-tier.ts` per Task 4.2 — the `.omit({ story_id: true })` derivation of `RiskTierClassifierResultSchema`) for the validation; on `riskTier` present, parse via `.safeParse`; on failure raise the existing `ReviewerResultFileMalformedError` with an explanatory message.
  - [ ] 6.3 Backward-compat: absent `riskTier` block is allowed (legacy fixtures and pre-this-story session results).

- [ ] **Task 7: Wire `classifyRiskTier` into `runReviewerSession`** (AC: #3, declared-exception edit to a locked file)
  - [ ] 7.1 In `plugins/crew/mcp-server/src/tools/run-reviewer-session.ts`, after the existing AC-walk and standards-walk and BEFORE writing `reviewer-result.json`:
    - Collect `changedPaths` from the existing `gh pr diff --name-only` output (or parse the `gh pr diff` output's `+++ b/<path>` lines if `--name-only` isn't already available).
    - Collect `commitMessages` from `gh pr view --json commits --jq '[.commits[].messageHeadline]'`.
    - Compute `diffSize` from the unified diff: sum of lines starting with `+` or `-` (excluding `+++` and `---` headers). Use the existing `prDiff` string already in scope.
    - Resolve `pluginRoot` via the existing helper (`getPluginRoot()` from `lib/plugin-root.ts` or its equivalent — verify the function name in the codebase before invoking).
  - [ ] 7.2 Call `classifyRiskTier({ targetRepoRoot, pluginRoot, storyId: ref, changedPaths, commitMessages, diffSize })`.
  - [ ] 7.3 Attach the result to the `reviewer-result.json` object as `riskTier: { tier, matched_rule, evidence }` (drop `story_id` — the file already has `ref`).
  - [ ] 7.4 Wrap the classifier call in try/catch. On failure (e.g. `MalformedRiskTieringSpecError`, `ShippedRiskTieringDefaultMissingError`), log via the existing typed-error path and emit the result file WITHOUT the `riskTier` block. The reviewer pass should not fail just because the spec is malformed; the absence of the block downstream (Task 8) means no body block and no manifest stamp.
  - [ ] 7.5 No SKILL.md changes — `runReviewerSession` is already the reviewer subagent's gate.

- [ ] **Task 8: Render evidence block in `composeSummaryBody`** (AC: #3, declared-exception edit)
  - [ ] 8.1 In `plugins/crew/mcp-server/src/tools/post-reviewer-comments.ts`, locate the `composeSummaryBody` function.
  - [ ] 8.2 After the version block and BEFORE the footer marker, append the evidence block per AC3 unpacked (3f) — verbatim format. Implementation: helper function `composeRiskTierEvidenceBlock(riskTier: RiskTierClassifierResult | undefined): string` that returns `""` when undefined, else the formatted block.
  - [ ] 8.3 Update `composeSummaryBody`'s callers (currently a single call site inside `postReviewerComments`) to pass `resultFile.riskTier`.
  - [ ] 8.4 Preserve the existing `<!-- crew:verdict:<plugin-version>:<story-id> -->` footer marker location — the block appears BEFORE the marker, not after.

- [ ] **Task 9: Stamp manifest in `postReviewerComments`** (AC: #3, declared-exception edit)
  - [ ] 9.1 In `plugins/crew/mcp-server/src/tools/post-reviewer-comments.ts`, after the POST/PATCH success path AND after the `emitVerdictTelemetry` call (Story 4.12 seam), call a new internal helper `stampRiskTierOnManifest(targetRepoRoot, ref, resultFile.riskTier)`.
  - [ ] 9.2 The helper:
    - If `riskTier` is undefined, return immediately (no-op).
    - Else read the in-progress manifest, set `risk_tier` and `risk_tier_evidence`, write back via `writeManifest`.
    - On any write error: log via the existing typed-error path and return; do NOT throw.
  - [ ] 9.3 The helper lives in the same file (`post-reviewer-comments.ts`) as a local function — keeps the stamping logic at the same seam as the body composition.

- [ ] **Task 10: Register `classifyRiskTier`** (AC: all)
  - [ ] 10.1 Register `classifyRiskTier` in `plugins/crew/mcp-server/src/tools/register.ts`. Bump tool-count assertion (per Story 4.11 left it at 28; this story moves it to 29).
  - [ ] 10.2 Do NOT add `classifyRiskTier` to any `permissions/*.yaml`. The reviewer subagent never calls it directly; `runReviewerSession` (already in `permissions/generalist-reviewer.yaml`) calls it via internal import.

- [ ] **Task 11: Integration test suite** (AC: #4)
  - [ ] 11.1 Create or extend `plugins/crew/mcp-server/src/tools/__tests__/post-reviewer-comments.test.ts` (or a sibling file) with AC4 sub-cases (4g), (4h), (4i).
  - [ ] 11.2 All tmpdir fixtures MUST use `await fs.mkdtemp(path.join(os.tmpdir(), "classify-risk-tier-"))` — never bare string concat, never `${os.tmpdir()}/foo` interpolation. (Pre-empt Story 4-9 / 4-12 validator catch.)
  - [ ] 11.3 Zod-error-message assertions, if any, MUST use Zod 4.x output format (`"Invalid option"` not v3's `"Invalid enum value"`); literal custom errors use `{ message: "..." }` form not v3's `errorMap`. (Pre-empt Story 4-9 / 4-12 validator catch.)
  - [ ] 11.4 The byte-stability assertion (4l) is critical for verdict-marker idempotency — do not skip.

- [ ] **Task 12: Build, vitest, dist** (AC: all)
  - [ ] 12.1 `pnpm --dir plugins/crew/mcp-server install` (must succeed with the new picomatch dep).
  - [ ] 12.2 `pnpm --dir plugins/crew/mcp-server build` passes with no TypeScript errors.
  - [ ] 12.3 `pnpm --dir plugins/crew/mcp-server test` passes — existing tests from prior stories + new tests added here.
  - [ ] 12.4 Commit `plugins/crew/mcp-server/dist/` with rebuilt output.
  - [ ] 12.5 No leftover `TODO(4.9b)` / `TODO(4-9b)` comments in any touched source file.

---

## Implementation strategy

### Why highest-tier-wins, not first-declared-wins

A PR matching both a `low` rule (e.g. `docs/**`) and a `high` rule (e.g. `**/migrations/**`) is, structurally, a migration that also updated docs. Auto-merging it as `low` would be the unsafe failure mode. Auto-merging as `high` (i.e. NOT auto-merging — pausing for human) is the safe failure mode. The classifier's contract is "if any high-rule matched, return high"; the spec author's contract is "declare your `high` rules carefully because they take precedence over your `low` rules." This is the opposite of how Story 4.9's spec walk *could* be interpreted (declaration order), so pinning it explicitly here in 4.9b prevents 4.10b from making the wrong assumption.

### Why the classifier accepts `changedPaths`/`commitMessages`/`diffSize` rather than a raw diff

The classifier is downstream of `runReviewerSession`, which already runs `gh pr diff` and `gh pr view --json commits` for its own purposes. Re-parsing the unified diff inside the classifier would duplicate work. Accepting derived inputs also makes the classifier easier to unit-test — fixtures pass in literal arrays rather than constructing diff strings. The trade-off: callers other than `runReviewerSession` (if any in the future) have to derive these inputs themselves. That's acceptable since `runReviewerSession` is the canonical caller and the others are deferred.

### Why the stamp lives in `postReviewerComments`, not `runReviewerSession` or `processReviewerTranscript`

Three candidate seams for stamping the manifest:
1. **`runReviewerSession`** — earliest point we have the classification, but the manifest doesn't exist yet for the reviewer's reasoning (the dev's `in-progress` manifest does, but stamping it before the comment is posted means the stamp could exist for a verdict comment that fails to post — orphan stamp). Reject.
2. **`processReviewerTranscript`** — Story 4.6 rev2 reads `reviewer-result.json` here and stamps `blocked_by` on failure branches. We could stamp `risk_tier` here too. But this seam runs AFTER `postReviewerComments` in the SKILL.md flow, and the stamp wants to happen on every successful POST (READY FOR MERGE, NEEDS CHANGES, BLOCKED — all of them produce a comment, all of them have a risk tier worth knowing). Stamping inside `processReviewerTranscript` only fires on the `done-ready-for-merge` branch (the others stamp `blocked_by` and return) — misses NEEDS CHANGES and BLOCKED. Reject.
3. **`postReviewerComments`** — fires on every successful POST/PATCH, regardless of verdict. The body is being composed at this seam already; pairing the body block with the manifest stamp at one site means "if the comment is on GitHub, the manifest is stamped" is trivially true. Accept.

### Why no telemetry event

Pattern §11 explicitly names the two surfaces ("story frontmatter" and "verdict comment"). Adding a third surface (telemetry) is additive and not load-bearing for any v1 consumer. Story 4.10b reads from the manifest; Epic 6 retros can read from the verdict comment (parsing the deterministic block) or the manifest. A future calibration story that wants per-rule firing counts can add a `risk.classified` event additively without breaking this contract.

### Why `picomatch` rather than rolling a glob matcher

Three reasons:
1. **Correctness on edge cases.** Patterns like `**/*.{md,sql}`, `!docs/**` negations, character classes (`[abc]`), and brace expansion are non-trivial to implement correctly. The shipped default spec uses only simple patterns, but operator overrides may use anything `picomatch` documents. Rolling a matcher would silently misbehave on legitimate operator overrides.
2. **`picomatch` is small.** ~50KB, zero runtime dependencies, used by every major JS tool that does globbing (chokidar, micromatch, fast-glob). Low maintenance burden.
3. **Story 4.9 explicitly punted the decision here.** "Add picomatch, minimatch, or any glob-matching library to package.json. The loader does NOT match patterns ... Story 4.9b is where the glob library lands." (4.9's § What this story does NOT, item p.)

### Why the evidence block in the body is verbatim formatted

The verdict body is the operator-visible surface. A deterministic, byte-stable format (with sorted arrays per AC1i) means: (a) the verdict-marker idempotency (Story 4.7) treats a re-run as an edit-in-place rather than a duplicate comment, (b) operator dashboards and humans parsing PR comments get a stable format to consume, (c) vitest can assert byte-equality of the block, (d) future tooling can grep for `## Risk tier evidence` and parse the block. The cost is one place in the codebase that pins the format; the test enforces it.

### Why backward-compat (missing `riskTier`) is preserved

This story is additive on top of Stories 4.6, 4.6b, 4.7, and 4.12. Reviewer-result fixtures from those stories' tests do not carry `riskTier`. Forcing the block's presence would require touching every existing test fixture. The "absent block ⇒ no body block, no manifest stamp" rule (AC3f, AC3h) means existing tests pass unchanged.

### Why no caching of the parsed spec

`docs/risk-tiering.md` is small (< 5KB) and parsing is cheap (yaml.parse + Zod). The classifier runs at most once per reviewer pass (and reviewer passes are minutes apart). Caching introduces invalidation complexity (mtime check? per-process cache? cross-process?) for negligible saving. A future perf story can revisit if profiling shows it matters.

### Why `change_types: ["dep-bump"]` doesn't include lockfiles in path-only matches

A rule declaring `path_patterns: ["package.json"]` matches ONLY the literal `package.json` path; a rule declaring `change_types: ["dep-bump"]` matches when ANY of the lockfile/manifest paths appear. These are different consumers — path-only rules want surgical precision; change-type rules want broad categorisation. Conflating them would force the spec author to choose either-or. The two signals are orthogonal by design.

---

## Locked files

These files are off-limits to this story. If a change appears necessary, STOP and surface the conflict — do not silently edit.

- `plugins/crew/skills/start/SKILL.md` (Stories 4.2 / 4.3b / 4.3c / 4.6 / 4.6b / 4.7) — DO NOT modify. The classifier runs inside `runReviewerSession`, which is already wired into the reviewer subagent's spawn path; no SKILL.md edit is required.
- `plugins/crew/mcp-server/src/lib/logger.ts` (Story 1.5) — DO NOT modify.
- `plugins/crew/mcp-server/src/schemas/risk-tiering-spec.ts` (Story 4.9) — DO NOT modify. The spec format is pinned by 4.9; this story is a pure consumer. Import `ChangeTypeSchema` and `RiskTieringSpec` from it.
- `plugins/crew/mcp-server/src/state/lookup-risk-tiering-spec.ts` (Story 4.9) — DO NOT modify. Consumed as-is.
- `plugins/crew/mcp-server/src/validators/risk-tiering-spec.ts` (Story 4.9) — DO NOT modify.
- `plugins/crew/docs/risk-tiering.md` (Story 4.9) — DO NOT modify. The shipped default rule set is intentionally minimal; rule expansion is a separate content-drafting pass.
- `plugins/crew/mcp-server/src/tools/process-reviewer-transcript.ts` (Story 4.6 revision 2) — DO NOT modify. The reviewer-transcript routing path is unrelated to risk classification.
- `plugins/crew/mcp-server/src/tools/process-dev-transcript.ts` — DO NOT modify.
- `plugins/crew/mcp-server/src/tools/process-reviewer-yield.ts` (Story 4.11) — DO NOT modify.
- `plugins/crew/mcp-server/src/skills/yield-parser.ts` (Story 4.11) — DO NOT modify.
- `plugins/crew/mcp-server/src/tools/apply-reviewer-labels.ts` (Story 4.8) — DO NOT modify. Label routing is 4.8's job; risk tier is 4.10b's consumer.
- `plugins/crew/mcp-server/src/tools/complete-story.ts` (Story 4.1) — DO NOT modify.
- `plugins/crew/mcp-server/src/tools/claim-next-story.ts` / `claim-story.ts` (Story 4.1) — DO NOT modify.
- `plugins/crew/permissions/generalist-dev.yaml` / `generalist-reviewer.yaml` (Story 2.2 / 4.6 / 4.12 / 4.11) — DO NOT modify. The classifier is not a subagent-callable tool surface in v1.
- `plugins/crew/catalogue/*.md` (Story 2.1 / 4.11) — DO NOT modify.
- `plugins/crew/mcp-server/src/schemas/telemetry-events.ts` (Story 1.5 / 4.12 / 4.11) — DO NOT modify. No new telemetry event in this story.

### Declared-locked-file changes (explicit exceptions)

- **`plugins/crew/mcp-server/src/schemas/execution-manifest.ts`** (Story 3.2 / 3.5 / 4.1; locked-by-default because the manifest schema is contract surface) — Task 5 appends two optional fields (`risk_tier`, `risk_tier_evidence`) at the end of the schema. Additive-extension pattern: existing manifests continue to parse; new fields are optional; field placement at the end preserves existing on-disk YAML field order for un-classified manifests. No existing field is touched.
- **`plugins/crew/mcp-server/src/tools/run-reviewer-session.ts`** (Story 4.6; locked due to deterministic-verdict-transport contract) — Task 7 adds a classifier call inside the existing reviewer pass and attaches `riskTier` to the persisted `reviewer-result.json`. The verdict-transport contract (`recommendedVerdict` remains the binding verdict surface) is unchanged; `riskTier` is an additive sibling field that downstream consumers may or may not read. The classifier call is wrapped in try/catch so a malformed spec does not break the reviewer pass.
- **`plugins/crew/mcp-server/src/tools/post-reviewer-comments.ts`** (Story 4.6b / 4.7 / 4.12; locked due to verdict-marker idempotency contract) — Tasks 8 + 9 extend `composeSummaryBody` with the evidence block (rendered between version block and footer marker; the locked marker placement is preserved) and add an in-tool helper to stamp the manifest after POST/PATCH success. Both edits are additive; the verdict-marker idempotency behaviour is unchanged because the evidence block is byte-stable (AC1i sorting) so a re-run renders identically and the find-and-edit path treats it as a no-op edit.
- **`plugins/crew/mcp-server/src/lib/read-reviewer-result-file.ts`** (Story 4.6 / 4.6b / 4.7; locked because it defines the reviewer-result file contract) — Task 6 adds an optional `riskTier` block to the parsed shape with backward-compat (absent block allowed). Existing readers see no behavioural change.
- **`plugins/crew/mcp-server/src/tools/register.ts`** (Story 1.4; locked due to tool-count assertion) — Task 10 registers `classifyRiskTier`. Bump tool-count assertion 28 → 29 in any test that pins it.
- **`plugins/crew/mcp-server/package.json`** and **`plugins/crew/mcp-server/pnpm-lock.yaml`** — Task 1 adds `picomatch` + `@types/picomatch`. Routine dependency addition; resolve via `pnpm add`, do NOT hand-pick the version.

---

## Dev Notes

### Files this story will create

- `plugins/crew/mcp-server/src/lib/detect-change-types.ts` (Task 2)
- `plugins/crew/mcp-server/src/lib/__tests__/detect-change-types.test.ts` (Task 2.6)
- `plugins/crew/mcp-server/src/lib/match-rules.ts` (Task 3)
- `plugins/crew/mcp-server/src/lib/__tests__/match-rules.test.ts` (Task 3.6)
- `plugins/crew/mcp-server/src/tools/classify-risk-tier.ts` (Task 4)
- `plugins/crew/mcp-server/src/tools/__tests__/classify-risk-tier.test.ts` (Task 4.6)

### Files this story will modify

- `plugins/crew/mcp-server/package.json` — Task 1.1 (add picomatch).
- `plugins/crew/mcp-server/pnpm-lock.yaml` — Task 1.1 (resolved lockfile).
- `plugins/crew/mcp-server/src/schemas/execution-manifest.ts` — Task 5.
- `plugins/crew/mcp-server/src/lib/read-reviewer-result-file.ts` — Task 6.
- `plugins/crew/mcp-server/src/tools/run-reviewer-session.ts` — Task 7.
- `plugins/crew/mcp-server/src/tools/post-reviewer-comments.ts` — Tasks 8 + 9.
- `plugins/crew/mcp-server/src/tools/register.ts` — Task 10.
- `plugins/crew/mcp-server/src/tools/__tests__/post-reviewer-comments.test.ts` (or sibling) — Task 11 sub-cases (4g)–(4i).
- Any existing test files pinning the tool-count assertion (search for `\.toHaveLength\(28\)` / `\.toBe\(28\)` in `__tests__/`) — Task 10.1.
- `plugins/crew/mcp-server/dist/` — Task 12.4 (rebuilt output committed).

### Conventions to pre-empt validator catches

- **Zod 4.x error format.** v4 emits `"Invalid option"` not v3's `"Invalid enum value"`; use `{ message: "..." }` form for literal custom errors. Verified against Stories 4-9 / 4-12 pass-2 validator catches.
- **Tmpdir fixtures.** Every test fixture that creates a tmpdir MUST use `await fs.mkdtemp(path.join(os.tmpdir(), "classify-risk-tier-"))`. Never bare string concatenation; never `${os.tmpdir()}/foo` interpolation; never a fixed path.
- **Cross-AC consistency.** Pattern §11 output keys are `story_id`, `tier`, `matched_rule`, `evidence: { paths, change_types, diff_size }` — snake_case in both the tool output AND the manifest field. The evidence block in the verdict body uses human-readable labels (`**tier:**`, `**matched rule:**`, etc.) but the underlying data shape is the snake_case Pattern §11 form. The fallback sentinel string is the literal `"fallback"` (lowercase, no punctuation). The manifest field name is `risk_tier` (snake_case, matching the existing field-naming convention in `ExecutionManifestSchema`). Any deviation in implementation breaks downstream consumers.
- **Dependency version pin.** Run `pnpm add picomatch @types/picomatch` and commit the lockfile; do NOT pre-pick a version from training data. (Memory rule `feedback_dependency_versions`.)
- **Picomatch import.** Default export: `import picomatch from "picomatch";`. The compiled matcher is `picomatch(patterns)` returning a `(path: string) => boolean` function. Use this as documented; do not invent alternative APIs.
- **`changedPaths` are POSIX-style.** Always `/`-separated, relative to repo root. Do not normalise from OS-native separators inside the classifier; the caller (`runReviewerSession`) is responsible for providing POSIX form (which `gh pr diff` already produces).

### Status flip clause

The orchestrator owns the `Status:` field at the top of this file (per ship-story SKILL.md). The dev agent MUST NOT edit the `Status:` field or any file under `_bmad-output/implementation-artifacts/` when implementing this story. The Status above is set to `ready-for-dev` by the create-story workflow; the orchestrator's Step 4 commit captures this value as part of the bookkeeping commit that ships in the PR.
