# Story 4.10b: Auto-merge gate, medium/high pause, and user override

story_shape: substrate

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin operator**,
I want **the dev-session prose layer to auto-merge a PR only when the reviewer says READY FOR MERGE AND the manifest's `risk_tier` is `low` AND the reviewer's rolling agreement metric meets the configured threshold — and to pause the PR with `needs-human` in every other case while never blocking my manual `gh pr merge`**,
so that **low-risk PRs land hands-free once the reviewer has earned my trust, and every higher-risk or low-agreement PR waits for a human — while my own override authority is structurally preserved**.

### What this story is, in one sentence

Add a new MCP tool `runAutoMergeGate` in `plugins/crew/mcp-server/src/tools/run-auto-merge-gate.ts` that, given a session ULID and PR number on the `done-ready-for-merge` branch, reads the `done/<ref>.yaml` manifest to extract `risk_tier`, calls `computeAgreement` (Story 4.10) to get the rolling ratio, resolves the threshold from `.crew/config.yaml` `plugin.agreement_threshold` (default 0.8), makes the deterministic gate decision via a pure `lib/auto-merge-gate.ts` helper, then either calls `gh pr merge` (auto-merge branch) or applies the `needs-human` label via `gh api .../labels` (pause branch); plus a single new line in `plugins/crew/skills/start/SKILL.md` that invokes the tool exactly on the `done-ready-for-merge` branch (and nowhere else, preserving manual-merge authority on NEEDS CHANGES / BLOCKED branches by structural omission).

### What this story does (and why it needs its own story)

PRD `FR40`/`FR41`/`FR42` pin the contract: low-risk + verdict-ready + threshold-met → auto-merge; medium/high or sub-threshold/insufficient → pause with `needs-human`; non-green verdict → no interference. Story 4.9b shipped the producer for `risk_tier` (stamped in the manifest by `postReviewerComments`); Story 4.10 shipped the producer for `agreement_metric` (the `computeAgreement` MCP tool returning `AgreementMetricResult | null`). 4.10b is the JOIN: the first story that consumes BOTH producers and turns the decision into a `gh pr merge` shell-out or a `needs-human` label.

The gate has five substrate-level decisions worth pinning in their own story rather than scattering across the SKILL.md prose:

1. **Decision purity.** The mapping from `(risk_tier, agreement_metric, threshold)` to `("auto-merge" | "pause-needs-human", reason)` is a pure function with five branches and a default. It MUST live in `lib/auto-merge-gate.ts` as `decideAutoMerge(input): AutoMergeDecision` so that future stories (Epic 6 retro stats, dashboard tools, etc.) can re-use the same exact mapping without bouncing through the MCP / shell-out layer. The reviewer-rubber-stamp memory rule (`feedback_default_to_deterministic_seams`) applies: load-bearing decisions live in tool-written artefacts, not LLM prose.

2. **Threshold resolution.** `plugin.agreement_threshold` is already declared in `schemas/workspace-config.ts` with a built-in default of `0.8`. The tool reads it via the existing `loadWorkspaceConfig` path (Story 1.2 substrate). A caller-supplied `thresholdOverride` (test seam only) takes precedence. The tool does NOT mutate config; it does NOT introduce a new schema field; it consumes what 4.10b ships in workspace-config.ts already.

3. **Manual-merge override is structural, not behavioural.** AC4 is satisfied by structural omission: the SKILL.md prose only invokes `runAutoMergeGate` on the `done-ready-for-merge` branch. On NEEDS CHANGES / BLOCKED / no-session-result, the tool is never called; `gh pr merge` from the operator's own shell proceeds unmolested because nothing else races against it. The test asserts this structurally — that the SKILL.md prose contains the gate invocation under `done-ready-for-merge` and ONLY under that branch (no invocation under any blocked branch).

4. **`risk_tier` source-of-truth is the done/<ref>.yaml manifest.** By the time `runAutoMergeGate` runs, `processReviewerTranscript` (Story 4.6 rev-2) has already called `completeStory` internally and moved the manifest from `in-progress/<ref>.yaml` to `done/<ref>.yaml`. The gate reads the done-side manifest (canonical post-completion location). If `risk_tier` is absent on the manifest (a legacy manifest from before Story 4.9b shipped, or a manifest the classifier somehow skipped), the gate treats it as a "no-tier" pause: same operational effect as medium/high (pause with `needs-human`), distinct `reason` literal for retro analysis. This is more conservative than defaulting to `low` and avoids accidentally auto-merging un-classified PRs.

5. **One MCP tool, two side-effects.** Auto-merge and pause are mutually exclusive outcomes of one decision; bundling them in a single MCP tool keeps the gate atomic and ships with one permission-spec entry (`pr-merge`) rather than two surfaces calling each other. Mirror `applyReviewerLabels` (Story 4.8) which combines decision and side-effect in one tool. A `dryRun` test seam lets vitest exercise both branches without spawning gh.

This story explicitly does NOT touch the producer code paths (4.9b's `classifyRiskTier`, 4.10's `computeAgreement`); does NOT change the threshold default in `schemas/workspace-config.ts`; does NOT alter `processReviewerTranscript`'s contract (the gate fires AFTER it returns `done-ready-for-merge`); does NOT introduce any decision other than the five branches in the AC table; does NOT add an "approve and review" or "auto-merge with mandatory wait" mode; does NOT modify how `needs-human` is applied on non-green verdicts (Story 4.8's `applyReviewerLabels` keeps that responsibility); does NOT introduce a CLI or non-MCP-tool surface for the gate; does NOT block on or otherwise depend on the PR's CI checks (a future story can layer that gate on top).

### What this story does NOT

- (a) Touch `_bmad-output/implementation-artifacts/sprint-status.yaml` or any other file under `_bmad-output/implementation-artifacts/`. The orchestrator owns status transitions. The dev agent MUST NOT edit any status/state file when implementing this story.
- (b) Change `processReviewerTranscript`'s return shape. The `done-ready-for-merge` branch already returns `{ next, completed: true, chatLog }`. The gate fires AFTER `processReviewerTranscript` returns; both surfaces operate on the same `prNumber` (read from `reviewer-result.json` and `dev-outcome.json` per Stories 4.6 / 4.8b).
- (c) Modify `tools/compute-agreement.ts` or `lib/agreement.ts`. The gate is a pure consumer of `computeAgreement(opts)`. If the metric returns `null`, the gate treats it as "insufficient data → pause" (per AC3).
- (d) Modify `schemas/execution-manifest.ts` or `schemas/workspace-config.ts`. The `risk_tier` field (Story 4.9b) and the `agreement_threshold` setting (already in workspace-config) are both already shipped; the gate reads, never writes.
- (e) Stamp any new field in the manifest. The gate emits a chat-log line and (on auto-merge) shells out to `gh pr merge`; it does not persist its own decision. A future story can log `auto_merge.decision` telemetry events for retro analysis — additive.
- (f) Apply or remove the `reviewed-by-agent` label. Story 4.8's `applyReviewerLabels` already applied it at step 10a of the SKILL.md inner cycle; the gate's pause branch adds `needs-human` ON TOP, never removes anything.
- (g) Implement a wait-then-merge mode (e.g. `gh pr merge --auto`). v1 uses `gh pr merge --squash --delete-branch` directly; if CI hasn't passed, gh returns a non-zero exit and the gate surfaces it as a `gh-recoverable` block. A future story can switch to `--auto` once that flow's semantics are pinned.
- (h) Re-classify the PR's risk tier. The classifier ran in `postReviewerComments` (Story 4.9b); the manifest holds the result. Re-running the classifier here would risk drift between the manifest's stamped tier and the gate's effective tier.
- (i) Read or modify `.crew/state/sessions/<ulid>/reviewer-result.json` directly. The gate operates on the manifest (post-`completeStory`) and the workspace config. Other tools (`applyReviewerLabels`, `processReviewerTranscript`) own the session-result file.
- (j) Add a `runAutoMergeGate` entry to any `permissions/*.yaml`. The gate is called by the SKILL.md prose, which uses the inner-cycle MCP layer (the same pattern as `processReviewerTranscript`, `applyReviewerLabels` — both gate-able SKILL.md-callable tools live in `inner-cycle-allowed-tools.ts`, NOT in per-role permission specs). The new `gh_allow` entry that DOES need to land is `pr-merge` on the role used by the gate (default `generalist-dev`).
- (k) Inject a yield protocol. Story 4.11 owns yield routing; this gate runs only on `done-ready-for-merge`, which by definition has already completed reviewer routing.
- (l) Special-case repos without a `.crew/config.yaml`. `loadWorkspaceConfig` already returns the schema's defaults on a missing config; the gate inherits the `0.8` default transparently.
- (m) Run `gh pr merge` against PRs that aren't open. If the PR has been merged or closed in the meantime (race with the operator), `gh pr merge` returns a non-zero exit; the gate surfaces it as a `gh-recoverable` block. v1 does NOT pre-check the PR state — the gh call IS the check.
- (n) Cache the agreement metric or the manifest read across invocations. Same rationale as Story 4.10 — invalidation cost > saving for v1.
- (o) Auto-promote `medium` to `high` based on diff-size. The classifier's tier is canonical; the gate consumes it.
- (p) Add a CLI / dashboard surface for the gate. The MCP tool is the v1 surface; a future Epic 6 retro CLI can call it over MCP if needed.
- (q) Emit a `auto_merge.decision` telemetry event. Deferred — out of scope for v1.

### Deferred work

- **`auto_merge.decision` telemetry event.** A future story logs `{ decision, reason, risk_tier, agreement_ratio, threshold_used, pr_number, session_id }` per gate run for retro analysis. Additive — does NOT change the gate's behaviour, only its observability.
- **`gh pr merge --auto` (await-CI mode).** Replace the direct merge with `--auto` once the wait-then-merge semantics are spec'd. The gate's contract stays the same; only the execa args change.
- **Operator pre-merge confirmation flag.** A `.crew/config.yaml` knob like `plugin.auto_merge_requires_confirmation: true` would surface a chat prompt before each auto-merge. Out of scope for v1 — the threshold gate IS the confirmation mechanism.
- **Per-role override of threshold.** Currently one threshold per repo. A future story could let each role specify its own threshold. Additive — same shape.
- **Telemetry-driven threshold tuning.** A future Epic 6 story can compute "what threshold yields N% false-auto-merges over the last 100 PRs?" and surface a suggested config. v1 ships the dumb 0.8 default; tuning is manual.
- **`gh pr merge` strategy override.** Currently hardcoded `--squash --delete-branch`. A `.crew/config.yaml` knob like `plugin.merge_strategy: squash | merge | rebase` could expose this. Additive.

---

## Acceptance Criteria

> AC1–AC4 are verbatim from the epic (FR40, FR41, FR42). AC5 is the integration suite carrying the `vitest:` marker per the orchestrator's AC-marker-gap memory rule. None reference a slash command, operator-typed CLI, install-doc path, or Claude Code UI element — they describe an internal MCP tool's decision-and-side-effect contract plus a SKILL.md prose integration. Per `plugins/crew/docs/user-surface-acs.md`, this story is **substrate**; no `(user-surface)` tags apply.

**AC1:**
**Given** a PR with `verdict: READY FOR MERGE`, `risk_tier: low`, and `agreement_metric.ratio >= threshold` (default 0.8, configurable via `plugin.agreement_threshold` in `.crew/config.yaml`),
**When** the auto-merge gate runs,
**Then** the plugin calls `gh pr merge` on the PR. _(FR40)_

<!-- Not user-surface: AC1 describes an internal MCP tool calling `gh pr merge` via the existing `gh` wrapper — same shape as the `pr-create` / `pr-view` shell-outs from Story 4.4 / 4.8, none of which carry user-surface tags. -->

**AC2:**
**Given** a PR with `risk_tier: medium` or `risk_tier: high` (regardless of verdict),
**When** the auto-merge gate runs,
**Then** the PR is paused with the `needs-human` label and no merge action is taken. _(FR41)_

<!-- Not user-surface: AC2 describes the medium/high pause branch — internal decision; the `needs-human` label is already an existing artefact (Story 4.8). -->

**AC3:**
**Given** a PR with verdict `READY FOR MERGE`, `risk_tier: low`, but `agreement_metric` below threshold (or `null`),
**When** the auto-merge gate runs,
**Then** the PR is paused with `needs-human` and the surface line names the reason (sub-threshold or insufficient data). _(FR40)_

<!-- Not user-surface: AC3 describes the low-risk sub-threshold / insufficient-data pause — internal decision + chat-log line composed by the tool. -->

**AC4:**
**Given** a PR with verdict `NEEDS CHANGES` or `BLOCKED`,
**When** the user runs `gh pr merge` manually,
**Then** the plugin does not interfere — override authority is preserved. _(FR42)_

<!-- Not user-surface: AC4 is satisfied by structural omission in SKILL.md (the gate is invoked ONLY under done-ready-for-merge). Asserted via a content-structure check on SKILL.md, not by a runtime test. -->

**AC5 (integration, vitest:):**
vitest covers (a) auto-merge fires, (b) medium pauses, (c) high pauses, (d) low + sub-threshold pauses, (e) low + insufficient-data pauses, (f) manual merge override.

<!-- Not user-surface: vitest integration suite — internal harness. The `vitest:` marker satisfies the AC-classifier gate per memory `project_ac_marker_gap`. -->

### Expanded acceptance specifics (folded into AC1–AC5 above; each clause maps to an AC for the AC-table gate)

**AC1 unpacked.** Auto-merge branch — low risk, met threshold, READY FOR MERGE.

- (1a) **Tool signature.** `runAutoMergeGate(opts: { targetRepoRoot, prNumber, ref, sessionUlid, thresholdOverride?, lastNVerdictsOverride?, dryRun?, execaImpl?, computeAgreementImpl?, readManifestImpl?, loadWorkspaceConfigImpl?, role?, pluginRootOverride? }) → Promise<AutoMergeGateResult>`. The signature mirrors `applyReviewerLabels` (Story 4.8) with additional test seams for the agreement + config + manifest reads. `thresholdOverride` (number 0..1) bypasses the workspace-config read entirely — test-only. `lastNVerdictsOverride` (positive integer) forwards into `computeAgreement` — test-only. `dryRun: true` skips the gh shell-out and returns the decision as if it had been executed (no execa call). `role` defaults to `"generalist-dev"`.
- (1b) **Decision branch — auto-merge.** `risk_tier === "low"` AND `agreement_metric !== null` AND `agreement_metric.ratio >= threshold_used` → `decision: "auto-merge"`, `reason: "low-risk-met-threshold"`. The tool MUST call `gh pr merge <prNumber> --squash --delete-branch` via the role's `gh_allow: pr-merge` entry. On gh success the result carries `merged: true` and a single chat-log line: `auto-merge fired — PR #<n> merged (risk_tier: low, agreement: <ratio>, threshold: <t>)`.
- (1c) **`gh pr merge` flags.** Hardcoded `--squash --delete-branch` for v1 — matches the team's existing convention (Story 4.4 PR-create flow assumes squash semantics). Future stories may parameterise; the gate ships with one shape.
- (1d) **Threshold resolution.** Resolve `threshold_used` in this order: (i) caller-supplied `thresholdOverride` (test seam — `0 <= n <= 1`), (ii) workspace-config `plugin.agreement_threshold` from `loadWorkspaceConfig(targetRepoRoot)` (default `0.8` per `schemas/workspace-config.ts`). The tool never reads `.crew/config.yaml` directly; it always goes through `loadWorkspaceConfig` so future schema changes propagate transparently. `threshold_used` is stamped in the returned `AutoMergeGateResult` for retro analysis.
- (1e) **Agreement metric resolution.** Call `computeAgreement({ targetRepoRoot, lastNVerdicts: lastNVerdictsOverride })`. Use the production default (50) when no override is passed. The metric is `null` (insufficient) or a `AgreementMetricResult`; the gate uses `result === null` and `result.ratio` directly (no rounding, no fixed-decimal coercion).
- (1f) **Ratio comparison uses `>=`, not `>`.** A ratio EQUAL to the threshold qualifies for auto-merge. Pin this in code: `agreement_metric.ratio >= threshold_used`. AC5(d) exercises the boundary case.
- (1g) **Permission spec.** `plugins/crew/permissions/generalist-dev.yaml` gains `pr-merge` in `gh_allow`. The `gh` wrapper rejects subcommands not in `gh_allow`; without this entry the auto-merge branch raises `GhSubcommandDeniedError`.

**AC2 unpacked.** Medium/high pause — risk-tier triggered pause regardless of agreement.

- (2a) **Decision branch — medium pause.** `risk_tier === "medium"` → `decision: "pause-needs-human"`, `reason: "medium-risk"`. The tool MUST add the `needs-human` label via `gh api POST /repos/<owner>/<repo>/issues/<prNumber>/labels` — same shape as `applyReviewerLabels` (Story 4.8) but a single-label call. The agreement metric is STILL computed and stamped in the result (for retro analysis), but does NOT influence the decision.
- (2b) **Decision branch — high pause.** `risk_tier === "high"` → `decision: "pause-needs-human"`, `reason: "high-risk"`. Same label-application path as (2a).
- (2c) **Owner/repo resolution.** Read via `gh pr view <prNumber> --json baseRepository` — the same pattern as `applyReviewerLabels`. The `pr-view` subcommand is already in `gh_allow` for `generalist-dev` (verified in current state); no permission-spec change needed for this branch.
- (2d) **No `reviewed-by-agent` re-application.** That label was added at step 10a; the gate adds only `needs-human` (one new label). Re-applying `reviewed-by-agent` would be a no-op but the API call is avoided.
- (2e) **No-tier pause (defensive).** If the manifest's `risk_tier` field is `undefined` (legacy manifest pre-4.9b, or classifier-skipped), the gate treats it as `decision: "pause-needs-human"`, `reason: "no-tier-no-signal"`. Distinct reason for retro analysis; same operational effect as medium/high.
- (2f) **Chat-log line shape.** `auto-merge gate paused — PR #<n> labelled needs-human (reason: <reason>, risk_tier: <tier>, agreement: <ratio or "null">, threshold: <t>)`. The `<reason>` literal is one of the enum values pinned in (5c).

**AC3 unpacked.** Low-risk + sub-threshold / insufficient-data pause.

- (3a) **Decision branch — low risk, sub-threshold.** `risk_tier === "low"` AND `agreement_metric !== null` AND `agreement_metric.ratio < threshold_used` → `decision: "pause-needs-human"`, `reason: "low-risk-sub-threshold"`. Same label-application path as (2a).
- (3b) **Decision branch — low risk, insufficient data.** `risk_tier === "low"` AND `agreement_metric === null` → `decision: "pause-needs-human"`, `reason: "low-risk-insufficient-data"`. Same label-application path as (2a). The `agreement_metric` field in the returned result is `null`.
- (3c) **Surface line names the reason.** The chat-log line per (2f) substitutes the appropriate `reason` literal. AC3's "names the reason (sub-threshold or insufficient data)" is satisfied by the distinct enum values in (5c).

**AC4 unpacked.** Manual-merge override — structural, not behavioural.

- (4a) **Gate invocation is conditional in SKILL.md.** The gate is invoked EXACTLY under the `done-ready-for-merge` branch of step 12. It is NOT invoked under `done-blocked-reviewer-needs-changes`, `done-blocked-reviewer-blocked`, `done-blocked-no-session-result`, or any error path. This is a structural assertion against SKILL.md content (AC5f).
- (4b) **No CI / PR-state check in the gate.** The gate does not query `gh pr view` for `state`; it does not refuse to operate on a closed PR. If the operator has merged manually between `processReviewerTranscript` returning and the gate firing, `gh pr merge` returns a non-zero exit and the gate surfaces it as `GhRecoverableError`. The gate does NOT race a manual merge — it gracefully fails behind one.
- (4c) **No tool surface for "skip the gate".** Operators wanting to disable auto-merge on a per-PR basis can apply `do-not-auto-merge` to the PR — BUT the gate does NOT consult any such label in v1. (Future story may add label-based skip; v1 ships threshold-and-tier-only.) Operators wanting to disable repo-wide can set `plugin.agreement_threshold: 1.01` (mathematically unreachable). Document in deferred work.

**AC5 unpacked.** Integration suite scope.

- (5a) **Fixture base.** vitest tests use `await fs.mkdtemp(path.join(os.tmpdir(), "auto-merge-gate-"))` per `beforeEach`. `afterEach` cleans via `fs.rm(..., { recursive: true, force: true })`. Tests write a minimal `done/<ref>.yaml` manifest via `fs.writeFile` using a helper `makeDoneManifest({ ref, risk_tier, sessionUlid })` that emits an `ExecutionManifestSchema`-valid YAML (status `done`, `claimed_by` = sessionUlid). Tests seed JSONL telemetry via the same `makeVerdictEvent` / `makeMergeActionEvent` helpers used by Story 4.10's compute-agreement tests (DRY-via-import from `lib/__tests__/test-helpers/agreement-fixtures.ts` if Story 4.10 extracted them; else inline copies).
- (5b) **Tool seam — gh injection.** The integration tests pass `execaImpl` and inspect its call args. Pattern: a fake execa that records every invocation with `{ subcommand, args, input }` and returns canned `{ stdout, exitCode }` based on the subcommand. The gate's `gh` wrapper is NOT mocked — the real wrapper is exercised; only the underlying `execa` is replaced.
- (5c) **Reason enum.** The set of `reason` literals is closed:
  ```ts
  type AutoMergeGateReason =
    | "low-risk-met-threshold"
    | "low-risk-sub-threshold"
    | "low-risk-insufficient-data"
    | "medium-risk"
    | "high-risk"
    | "no-tier-no-signal";
  ```
  `AutoMergeGateResultSchema` declares it as a Zod enum. Tests assert the right literal per branch.
- (5d) **(a) Auto-merge fires.** Seed a low-risk done manifest. Seed 50 fully-resolved verdicts with agreement 0.8 (matching the default threshold exactly). Call `runAutoMergeGate({ ..., dryRun: false, execaImpl: fakeExeca })`. Assert: `decision: "auto-merge"`, `reason: "low-risk-met-threshold"`, `merged: true`, fakeExeca was called with `["pr", "merge", "<prNumber>", "--squash", "--delete-branch"]`. Then re-test with `ratio: 0.81` (strictly above) — same result. Then re-test with `thresholdOverride: 0.85` and agreement still at 0.8 — assert pause branch (cross-check with AC3).
- (5e) **(b) Medium pauses.** Seed a medium-risk done manifest. Seed 50 fully-resolved verdicts with agreement 1.0 (perfect). Call. Assert: `decision: "pause-needs-human"`, `reason: "medium-risk"`, `merged: false`, `labelsApplied: ["needs-human"]`, fakeExeca was called for `pr view` (owner-repo lookup) AND for `api POST .../labels` with `{"labels":["needs-human"]}` — but NOT for `pr merge`.
- (5f) **(c) High pauses.** Seed a high-risk done manifest. Same shape as (5e), `reason: "high-risk"`.
- (5g) **(d) Low + sub-threshold pauses.** Low-risk manifest. Seed 50 verdicts with agreement 0.7 (below default 0.8). Call. Assert: `decision: "pause-needs-human"`, `reason: "low-risk-sub-threshold"`, labels applied, no merge call. Then re-test with `thresholdOverride: 0.6` and agreement 0.7 — assert auto-merge fires (cross-check threshold-override path).
- (5h) **(e) Low + insufficient-data pauses.** Low-risk manifest. Seed only 30 verdicts (sub-window for default 50). Assert: `agreement_metric: null`, `decision: "pause-needs-human"`, `reason: "low-risk-insufficient-data"`, labels applied. Then re-test with `lastNVerdictsOverride: 30` — assert agreement is computed and decision flips to whatever the 30-window ratio says.
- (5i) **(f) Manual-merge override (structural).** Read `plugins/crew/skills/start/SKILL.md` (the worktree copy). Assert the file contains `runAutoMergeGate` (gate invocation present). Assert it appears EXACTLY under the `done-ready-for-merge` branch and does NOT appear under any `done-blocked-*` branch. The assertion uses regex on the section markers — pin the test fixture text per (5l).
- (5j) **(g) No-tier pause.** Seed a done manifest without `risk_tier` (legacy manifest). Assert: `decision: "pause-needs-human"`, `reason: "no-tier-no-signal"`, labels applied. The agreement metric is still computed and stamped in the result.
- (5k) **(h) Boundary — ratio exactly equals threshold.** Seed agreement 0.8 with threshold 0.8 default. Assert: auto-merge fires (the `>=` boundary). Pin the test to catch a future drift to `>`.
- (5l) **(i) SKILL.md content-structure.** A separate vitest asserts the SKILL.md prose under `done-ready-for-merge` contains the literal `runAutoMergeGate({ targetRepoRoot, prNumber, ref, sessionUlid })` (with `prNumber` reused from earlier in the inner-cycle — the same `prNumber` that flowed into `applyReviewerLabels`). This is the structural anchor that AC4 / AC5(f) rely on. Use a regex that allows whitespace flex but pins the tool name and the argument keys.
- (5m) **(j) MCP tool registration smoke.** Assert `register.ts`'s registration list includes `runAutoMergeGate`. Bump tool-count assertions from 30 (post-4.10) to 31 in every test that pins it.
- (5n) **(k) `dryRun: true` path.** Same setup as (5d). Pass `dryRun: true`. Assert: `decision: "auto-merge"`, `merged: false` (because dry-run), `dryRun: true` reflected in the returned result, fakeExeca NOT called for `pr merge` (but agreement and config reads still occurred).
- (5o) **(l) GhRecoverableError on `pr merge` failure.** Same setup as (5d), but fakeExeca returns a non-zero exit with stderr matching the `defer` class from `gh-error-map.yaml`. Assert: `runAutoMergeGate` throws `GhRecoverableError` with `class: "defer"`; the test verifies the gh wrapper's error mapping is invoked (no special-casing in the gate).
- (5p) **(m) `pr-merge` denied without permission entry.** Stub `loadRolePermissions` to return a permission spec WITHOUT `pr-merge` in `gh_allow`. Assert: `runAutoMergeGate` throws `GhSubcommandDeniedError` on the merge subcommand. (Confirms the permission-spec edit in (1g) is load-bearing.)
- (5q) **(n) `AutoMergeGateResultSchema` round-trip.** Take a non-throw result from (5d). `JSON.stringify` → `JSON.parse` → `AutoMergeGateResultSchema.parse`. Assert no errors and value equality. Assert schema strictness — adding an unknown field fails parse.

---

## Tasks / Subtasks

Implementation order is load-bearing. Each task lists its AC dependencies.

- [ ] **Task 1: Pure helper `decideAutoMerge`** (AC: #1, #2, #3, #4)
  - [ ] 1.1 Create `plugins/crew/mcp-server/src/lib/auto-merge-gate.ts`.
  - [ ] 1.2 Export `decideAutoMerge(input: { risk_tier: "low" | "medium" | "high" | undefined; agreement_metric: AgreementMetricResult | null; threshold: number }): { decision: "auto-merge" | "pause-needs-human"; reason: AutoMergeGateReason }`. Implements the six-branch decision per AC5(c). Pure function — no I/O, no async.
  - [ ] 1.3 Export `AutoMergeGateReason` type alias as the closed union per (5c).
  - [ ] 1.4 JSDoc citing this story key, FR40 / FR41 / FR42, and a per-branch table.
  - [ ] 1.5 Create `plugins/crew/mcp-server/src/lib/__tests__/auto-merge-gate.test.ts` covering each branch (six rows + boundary case + no-tier).

- [ ] **Task 2: `runAutoMergeGate` MCP tool** (AC: #1, #2, #3, #5)
  - [ ] 2.1 Create `plugins/crew/mcp-server/src/tools/run-auto-merge-gate.ts`.
  - [ ] 2.2 Export Zod schema `AutoMergeGateResultSchema` (`.strict()` at every level) with shape:
    ```ts
    {
      decision: "auto-merge" | "pause-needs-human",
      reason: AutoMergeGateReason,   // the six-literal enum
      risk_tier: "low" | "medium" | "high" | null,
      agreement_metric: AgreementMetricResult | null,
      threshold_used: z.number().min(0).max(1),
      merged: z.boolean(),
      labelsApplied: z.array(z.string()),
      dryRun: z.boolean(),
      prNumber: z.number().int().positive(),
      chatLog: z.array(z.string()),
    }
    ```
    Also export `AutoMergeGateResult = z.infer<...>`.
  - [ ] 2.3 Implement the algorithm:
    1. Validate `thresholdOverride` if present (must be `0 <= n <= 1`, finite, NaN-free); else `AutoMergeGateThresholdInvalidError`.
    2. Load workspace-config via `loadWorkspaceConfig(targetRepoRoot)`. Resolve `threshold_used = thresholdOverride ?? config.plugin.agreement_threshold`.
    3. Read `done/<ref>.yaml` manifest via `readManifest(path.join(targetRepoRoot, ".crew", "state", "done", `${ref}.yaml`))`. Extract `risk_tier`. (Note: read from `done/` because `processReviewerTranscript` already moved the manifest before this tool runs.)
    4. Call `computeAgreement({ targetRepoRoot, lastNVerdicts: lastNVerdictsOverride })`. Get `AgreementMetricResult | null`.
    5. Call `decideAutoMerge({ risk_tier, agreement_metric, threshold })`. Get `{ decision, reason }`.
    6. Compose the chat-log line per (1b) or (2f).
    7. If `dryRun: true` → return `{ ..., merged: false, labelsApplied: [], dryRun: true }`.
    8. If `decision === "auto-merge"` → call `gh pr merge <prNumber> --squash --delete-branch` via the `gh` wrapper; on success set `merged: true`, `labelsApplied: []`.
    9. If `decision === "pause-needs-human"` → resolve owner/repo via `gh pr view <prNumber> --json baseRepository`, then `gh api POST /repos/<owner>/<repo>/issues/<prNumber>/labels` with `{"labels":["needs-human"]}`. Set `merged: false`, `labelsApplied: ["needs-human"]`.
    10. Return the full `AutoMergeGateResult`.
  - [ ] 2.4 Inputs accepted via standard MCP-tool-schema. Test seams: `execaImpl`, `computeAgreementImpl`, `readManifestImpl`, `loadWorkspaceConfigImpl`, `pluginRootOverride` — all optional, production callers pass none.
  - [ ] 2.5 JSDoc citing this story key, FR40 / FR41 / FR42, the six-branch decision table (linked to `lib/auto-merge-gate.ts`), and the locked `gh pr merge` shape `--squash --delete-branch`.
  - [ ] 2.6 Create `plugins/crew/mcp-server/src/tools/__tests__/run-auto-merge-gate.test.ts` covering AC5(d)–(o).

- [ ] **Task 3: Typed errors** (AC: #1)
  - [ ] 3.1 In `plugins/crew/mcp-server/src/errors.ts`, append `AutoMergeGateThresholdInvalidError extends DomainError`. Constructor: `{ threshold: number; reason: string }`. Message: `` `runAutoMergeGate: invalid threshold=<threshold> — <reason>. (FR40)` ``. Use the existing `extends DomainError` pattern.

- [ ] **Task 4: Permission spec — `pr-merge` allowance** (AC: #1, #5p)
  - [ ] 4.1 Edit `plugins/crew/permissions/generalist-dev.yaml`: append `pr-merge` to `gh_allow`. The role that fires the gate (default `generalist-dev`) needs the wrapper allowance.
  - [ ] 4.2 No other permission specs change. Reviewer (`generalist-reviewer.yaml`) does NOT get `pr-merge` — the reviewer's negative-capability invariant (Story 4.8) preserves the "reviewer cannot merge" rule.

- [ ] **Task 5: MCP-tool registration** (AC: #5m)
  - [ ] 5.1 Register `runAutoMergeGate` in `plugins/crew/mcp-server/src/tools/register.ts`. Bump tool-count assertion from 30 (post-4.10) to 31 in any test that pins it (search for `\.toBe\(30\)` and `\.toHaveLength\(30\)` under `__tests__/`).
  - [ ] 5.2 Add `runAutoMergeGate` to the inner-cycle allowed-tools array `plugins/crew/mcp-server/src/tools/inner-cycle-allowed-tools.ts` (or whichever file the SKILL.md inner cycle reads — search for the existing `processReviewerTranscript`, `applyReviewerLabels` entries in that allow-list to find the file). The gate is invoked from SKILL.md prose, so it must be in the inner-cycle allow-list.

- [ ] **Task 6: SKILL.md integration** (AC: #1, #2, #3, #4, #5i, #5l)
  - [ ] 6.1 Edit `plugins/crew/skills/start/SKILL.md`. Locate step 12's `done-ready-for-merge` branch. AFTER the existing chat-surface line and BEFORE `return to outer loop step 4`, insert a new sub-step `12.1`:
    ```
    12.1. invoke runAutoMergeGate({ targetRepoRoot, prNumber, ref, sessionUlid }). Switch on the `decision` field:
       - `auto-merge` → log every entry of the returned `chatLog` to the operator, then return to outer loop step 4.
       - `pause-needs-human` → log every entry of the returned `chatLog` to the operator. The PR now carries the `needs-human` label; do NOT loop into rework — the story is already in `done/`. Return to outer loop step 4.
       - If `runAutoMergeGate` throws `GhRecoverableError`: log the error verbatim AND a follow-up line `auto-merge gate deferred — operator should re-run /crew:start or merge manually`. The manifest is already in `done/`; the story is closed from the plugin's POV. Return to outer loop step 4.
       - If `runAutoMergeGate` throws `AutoMergeGateThresholdInvalidError` or any other typed error: log the error verbatim and halt the inner cycle. The manifest is in `done/`; the operator needs to fix `.crew/config.yaml` before continuing.
    ```
    Mirror the existing step-12 prose style — sub-step numbering, verbatim chat-log surfacing, "return to outer loop step 4" closure.
  - [ ] 6.2 Do NOT add the gate invocation under any other branch of step 12. AC4 is satisfied by structural omission.
  - [ ] 6.3 Update the "# Failure modes" section of SKILL.md to add `AutoMergeGateThresholdInvalidError` and a brief `auto-merge-gate-deferred` entry (for the `GhRecoverableError` case).

- [ ] **Task 7: Build, vitest, dist** (AC: all)
  - [ ] 7.1 `pnpm --dir plugins/crew/mcp-server install` (must succeed; no new dependencies).
  - [ ] 7.2 `pnpm --dir plugins/crew/mcp-server build` passes with no TypeScript errors.
  - [ ] 7.3 `pnpm --dir plugins/crew/mcp-server test` passes — existing tests from prior stories + new tests added here.
  - [ ] 7.4 Commit `plugins/crew/mcp-server/dist/` with rebuilt output. (CLAUDE.md "Plugin build output is tracked in git" — `/plugin install` copies the tree as-is and does not run a build step; CI fails on drift.)
  - [ ] 7.5 No leftover `TODO(4.10b)` / `TODO(4-10b)` comments in any touched source file.

---

## Implementation strategy

### Why one MCP tool, two side-effects

The decision (`risk_tier` × `agreement_metric` × `threshold` → `("auto-merge" | "pause-needs-human", reason)`) and the side-effect (`gh pr merge` OR `gh api .../labels`) are atomically coupled — every gate run must produce exactly one of the two outcomes, and the side-effect is determined entirely by the decision. Splitting them across two MCP tools would force SKILL.md prose to branch on `decision` and call a second tool, which both widens the prose surface and risks the prose making a different call than the decision implied (rubber-stamp risk). Mirror `applyReviewerLabels` (Story 4.8) — one tool, decision + side-effect, with a `dryRun` test seam for unit assertions.

### Why the decision logic lives in `lib/auto-merge-gate.ts`, not inline in the MCP tool

Two reasons: (i) unit-testability — pure functions are testable without spinning up the MCP tool's full I/O stack (manifest read, config read, computeAgreement); (ii) future re-use — Epic 6 retro stats / dashboard tools will need to render "what would the gate have decided?" for historical PRs, and they should share the exact mapping. The split is the same Story 4.10 used between `lib/agreement.ts` (`isAgreement` truth table) and `tools/compute-agreement.ts` (the JSONL walk + windowing).

### Why `gh pr merge --squash --delete-branch` hardcoded for v1

Story 4.4's `gh pr create` flow already assumes squash semantics (PR titles use conventional-commits format suitable for squash messages). `--delete-branch` is the team's branch hygiene convention. Parameterising would expand the MCP-tool surface and risk drift between `pr-create` and `pr-merge`. A future story can add `plugin.merge_strategy` — additive, doesn't change the gate's decision shape.

### Why `>=` for the threshold comparison, not `>`

FR40 says "agreement_metric ≥ threshold" verbatim. A team that has tuned to 0.8 expects a fresh "0.8 exact" to auto-merge, not surprise-pause. AC5(k) tests the boundary explicitly to catch a regression to `>`.

### Why read `risk_tier` from `done/<ref>.yaml`, not `in-progress/`

By the time the gate runs, `processReviewerTranscript` has already called `completeStory` internally on the `done-ready-for-merge` branch (Story 4.6 rev-2 / 4.3c). The manifest has been atomically moved from `in-progress/<ref>.yaml` to `done/<ref>.yaml`. Reading from `in-progress/` would hit ENOENT. The `done/` path is canonical post-completion.

### Why a "no-tier" pause rather than defaulting to `low` (or `high`)

A missing `risk_tier` on a `done` manifest means either (a) the manifest predates Story 4.9b (legacy / migration), or (b) the classifier somehow skipped this PR (bug). Defaulting to `low` would auto-merge under conditions the classifier didn't bless; defaulting to `high` is operationally identical to medium/high pause. The distinct `reason: "no-tier-no-signal"` enum literal lets retros distinguish "intentional pause" from "accidental absence" without changing operational behaviour.

### Why the integration tests inject `execaImpl` rather than mocking the `gh` wrapper

`vi.mock` of production modules creates stub-vs-real gaps (Epic 2 retro #80 — see `feedback_default_to_deterministic_seams` memory). Injecting at the execa layer exercises the real `gh` wrapper code (subcommand validation, args resolution, error mapping) and only replaces the actual subprocess spawn. AC5(p)'s "denied without permission entry" assertion explicitly exercises the real `gh` wrapper — that test couldn't exist if the wrapper was mocked.

### Why the structural assertion on SKILL.md (AC5(i)/(l)) instead of an end-to-end test of the prose layer

The SKILL.md prose runs in Claude Code, not in vitest — there's no way to "execute" the prose in unit tests. The structural assertion (file contains the literal `runAutoMergeGate({ targetRepoRoot, prNumber, ref, sessionUlid })` under the `done-ready-for-merge` branch and ONLY there) is the closest unit-testable proxy. Operator-smoke verification belongs to a future dogfood pass, not this story (post-2026-05-25 rollback memo: dogfooding paused until L1 defects fixed; this story ships substrate-only).

### Why no telemetry event on the gate decision (deferred)

Each `auto_merge.decision` event would be useful for retro analysis but adds zero behaviour to the gate itself. Shipping the event in this story would mean either (i) extending `TelemetryEventSchema` (touches a locked file from 4.10's lock list) or (ii) writing raw JSONL bypassing the schema (anti-pattern). A future additive story can extend the schema once Epic 6's retro framework needs it.

---

## Locked files

These files are off-limits to this story. If a change appears necessary, STOP and surface the conflict — do not silently edit.

- `plugins/crew/mcp-server/src/tools/compute-agreement.ts` (Story 4.10) — DO NOT modify. This story is a pure consumer.
- `plugins/crew/mcp-server/src/lib/agreement.ts` (Story 4.10) — DO NOT modify. The truth table is owned by 4.10.
- `plugins/crew/mcp-server/src/schemas/telemetry-events.ts` (Story 1.5 / 4.12 / 4.11) — DO NOT modify. No new event type in this story (deferred).
- `plugins/crew/mcp-server/src/schemas/execution-manifest.ts` (Story 3.2 / 3.5 / 4.1 / 4.9b) — DO NOT modify. The `risk_tier` field already exists; the gate reads only.
- `plugins/crew/mcp-server/src/schemas/workspace-config.ts` (Story 1.2 / earlier) — DO NOT modify. `plugin.agreement_threshold` already exists with default `0.8`.
- `plugins/crew/mcp-server/src/tools/classify-risk-tier.ts` (Story 4.9b) — DO NOT modify. The classifier is upstream.
- `plugins/crew/mcp-server/src/tools/post-reviewer-comments.ts` (Story 4.6b / 4.7 / 4.12 / 4.9b) — DO NOT modify. Stamps `risk_tier`; no change needed.
- `plugins/crew/mcp-server/src/tools/run-reviewer-session.ts` (Story 4.6 / 4.9b) — DO NOT modify.
- `plugins/crew/mcp-server/src/tools/process-reviewer-transcript.ts` (Story 4.6 rev-2) — DO NOT modify. The gate fires AFTER it returns.
- `plugins/crew/mcp-server/src/tools/process-dev-transcript.ts` (Story 4.3b / 4.5) — DO NOT modify.
- `plugins/crew/mcp-server/src/tools/apply-reviewer-labels.ts` (Story 4.8) — DO NOT modify. The gate has its own label-application path (single label, gated on decision).
- `plugins/crew/mcp-server/src/tools/complete-story.ts` / `claim-next-story.ts` / `claim-story.ts` (Story 4.1) — DO NOT modify.
- `plugins/crew/mcp-server/src/tools/process-reviewer-yield.ts` (Story 4.11) — DO NOT modify.
- `plugins/crew/mcp-server/src/tools/record-pr-close-action.ts` (Story 4.12) — DO NOT modify.
- `plugins/crew/mcp-server/src/tools/record-agent-invoke.ts` (Story 4.12) — DO NOT modify.
- `plugins/crew/mcp-server/src/lib/runtime-limits.ts` (Story 4.12) — DO NOT modify.
- `plugins/crew/mcp-server/src/lib/manifest-io.ts` (Story 3.2 / 4.1) — DO NOT modify. The gate uses `readManifest` as-is.
- `plugins/crew/mcp-server/src/lib/gh.ts` (Story 4.4 / 4.5 / 4.8) — DO NOT modify. The gate uses the wrapper as-is.
- `plugins/crew/mcp-server/src/lib/gh-error-map.ts` (Story 4.5) — DO NOT modify.
- `plugins/crew/catalogue/*.md` (Story 2.1 / 4.11) — DO NOT modify.
- `plugins/crew/permissions/generalist-reviewer.yaml` (Story 2.2 / 4.6 / 4.12 / 4.11 / 4.9b) — DO NOT modify. The reviewer never gets `pr-merge` allowance.
- `plugins/crew/permissions/orchestrator.yaml`, `planner.yaml`, `hiring-manager.yaml`, `ask-mode.yaml`, `debugger.yaml`, `docs-specialist.yaml`, `retro-analyst.yaml`, `security-specialist.yaml`, `test-specialist.yaml` — DO NOT modify.

### Declared-locked-file changes (explicit exceptions)

- **`plugins/crew/mcp-server/src/errors.ts`** (typed-error hierarchy; appended-to by most Epic-1 through Epic-4 stories) — Task 3.1 appends `AutoMergeGateThresholdInvalidError`. Routine additive growth following the established `extends DomainError` pattern.
- **`plugins/crew/mcp-server/src/tools/register.ts`** (Story 1.4; locked due to tool-count assertion) — Task 5.1 registers `runAutoMergeGate`. Bump tool-count assertion 30 → 31 in any test that pins it.
- **`plugins/crew/mcp-server/src/tools/inner-cycle-allowed-tools.ts`** (Story 4.3b — the SKILL.md inner-cycle allow-list source) — Task 5.2 appends `runAutoMergeGate` to the array. Pattern: same as the 4.3c widening for `completeStory`.
- **`plugins/crew/skills/start/SKILL.md`** (Story 4.2 / 4.3 / 4.3b / 4.3c / 4.6 / 4.6b / 4.7 / 4.8 / 4.9b / 4.11 / 4.12) — Task 6 integrates the gate at step 12. This is the JOIN integration this story exists to ship.
- **`plugins/crew/permissions/generalist-dev.yaml`** (Story 2.2 / 4.1 / 4.4 / 4.8 / 4.9b) — Task 4.1 appends `pr-merge` to `gh_allow`. The role that fires the gate needs the allowance.

---

## Dev Notes

### Files this story will create

- `plugins/crew/mcp-server/src/lib/auto-merge-gate.ts` (Task 1)
- `plugins/crew/mcp-server/src/lib/__tests__/auto-merge-gate.test.ts` (Task 1.5)
- `plugins/crew/mcp-server/src/tools/run-auto-merge-gate.ts` (Task 2)
- `plugins/crew/mcp-server/src/tools/__tests__/run-auto-merge-gate.test.ts` (Task 2.6)

### Files this story will modify

- `plugins/crew/mcp-server/src/errors.ts` — Task 3.1 (append `AutoMergeGateThresholdInvalidError`).
- `plugins/crew/mcp-server/src/tools/register.ts` — Task 5.1 (register `runAutoMergeGate`, bump tool-count 30 → 31).
- `plugins/crew/mcp-server/src/tools/inner-cycle-allowed-tools.ts` — Task 5.2 (append `runAutoMergeGate`).
- `plugins/crew/permissions/generalist-dev.yaml` — Task 4.1 (append `pr-merge` to `gh_allow`).
- `plugins/crew/skills/start/SKILL.md` — Task 6 (insert step 12.1 under `done-ready-for-merge` branch + Failure-modes entries).
- Any existing test files pinning the tool-count assertion (search for `\.toHaveLength\(30\)` / `\.toBe\(30\)` under `__tests__/`) — Task 5.1.
- `plugins/crew/mcp-server/dist/` — Task 7.4 (rebuilt output committed).

### Current-state notes on files being modified or referenced

- **`schemas/execution-manifest.ts`** (current state per Story 4.9b — line 185 of file as shipped): the `risk_tier` field is `z.enum(["low", "medium", "high"]).optional()`. Optional because legacy manifests in `to-do/` may not have it. The gate handles `undefined` via the `no-tier-no-signal` branch. Read-only.
- **`schemas/workspace-config.ts`** (current state per Story 1.2 + later): `PluginSettingsSchema` declares `agreement_threshold: z.number().min(0).max(1).default(0.8)`. The default `0.8` is already pinned — this story consumes it. Read-only.
- **`tools/compute-agreement.ts`** (current state per Story 4.10): exports `computeAgreement(opts) → Promise<AgreementMetricResult | null>` and `AgreementMetricResultSchema`. The gate imports the type, not the schema (Zod parsing is the producer's responsibility). Read-only.
- **`tools/process-reviewer-transcript.ts`** (current state per Story 4.6 rev-2 + 4.3c): on `recommendedVerdict === "READY FOR MERGE"`, internally calls `completeStory` which atomically moves `in-progress/<ref>.yaml` to `done/<ref>.yaml`. Returns `{ next: "done-ready-for-merge", completed: true, chatLog }`. The gate fires AFTER this return; the manifest is canonical-located at `done/<ref>.yaml`. Read-only.
- **`tools/apply-reviewer-labels.ts`** (current state per Story 4.8): applies `reviewed-by-agent` (always) and `needs-human` (non-green) at step 10a. For READY FOR MERGE only `reviewed-by-agent` is applied. The gate's pause branch ADDS `needs-human` ON TOP — single-label call, NOT a re-application. Read-only.
- **`permissions/generalist-dev.yaml`** (current state): `gh_allow` contains `pr-create, pr-view, pr-comment`. Task 4.1 appends `pr-merge`. The `gh_allow_args: {}` block stays empty.
- **`permissions/generalist-reviewer.yaml`** (current state): `gh_allow` contains `pr-view, pr-diff`. Crucially, NO `pr-merge` — Story 4.8's negative-capability invariant. This story does NOT change that.
- **`skills/start/SKILL.md`** (current state per Stories 4.2 / 4.3 / 4.3b / 4.3c / 4.6 / 4.6b / 4.7 / 4.8 / 4.9b / 4.11 / 4.12): step 12 has three branches: `done-ready-for-merge`, `done-blocked-reviewer-needs-changes`, `done-blocked-reviewer-blocked`, `done-blocked-no-session-result`. Task 6 adds sub-step 12.1 under the `done-ready-for-merge` branch only.
- **`tools/register.ts`** (current state per Story 4.10): 30 `server.registerTool` calls. Tool count last bumped to 30 by Story 4.10. Task 5.1 bumps to 31.
- **`tools/inner-cycle-allowed-tools.ts`** (current state per Story 4.3c widening): the allow-list includes the seven tools used by SKILL.md prose at the time of 4.3c. The gate is the eighth (or wherever the count sits post-4.11 / 4.12).

### Conventions to pre-empt validator catches

- **Zod 4.x error format.** v4 emits `"Invalid option"` not v3's `"Invalid enum value"`; use `{ message: "..." }` form for literal custom errors. Verified against Stories 4-9 / 4-12 / 4-9b / 4-10 pass-2 validator catches.
- **Tmpdir fixtures.** Every test fixture that creates a tmpdir MUST use `await fs.mkdtemp(path.join(os.tmpdir(), "auto-merge-gate-"))`. Never bare string concatenation; never `${os.tmpdir()}/foo` interpolation; never a fixed path.
- **Cross-AC literal consistency.** The `reason` enum is exactly `["low-risk-met-threshold", "low-risk-sub-threshold", "low-risk-insufficient-data", "medium-risk", "high-risk", "no-tier-no-signal"]` — exact kebab-case, no punctuation drift. The decision literals are exactly `["auto-merge", "pause-needs-human"]`. The label literal is exactly `"needs-human"` (matches Story 4.8). The gh subcommand allowance is exactly `"pr-merge"` (matches gh wrapper's kebab-to-space split).
- **Threshold comparison.** Always `>=`. AC5(k) tests the boundary; a regression to `>` flips the boundary case and is the easy mistake.
- **Default threshold value.** `0.8` is the workspace-config default — DO NOT hardcode `0.8` in `runAutoMergeGate`. Always resolve via `loadWorkspaceConfig`; the test seam (`thresholdOverride`) is the only escape hatch.
- **Determinism.** Two calls against the same manifest + telemetry + config must produce identical results (the `chatLog` array, the `agreement_metric`, etc.). The `gh` shell-outs are the only non-deterministic step — tests use `execaImpl` to control them.
- **Schema-strict assertion.** `AutoMergeGateResultSchema` is `.strict()` at every level. Tests asserting unknown-key rejection (AC5q) must pass.

### Testing standards

- vitest with `pnpm vitest --run` from `plugins/crew/mcp-server/`.
- `fs.mkdtemp(path.join(os.tmpdir(), "auto-merge-gate-"))` for tmpdir fixtures; `fs.rm(..., { recursive: true, force: true })` in `afterEach`.
- No global mocks. No `import.meta.url` mocking.
- No `vi.mock` of production modules. Test seams (`execaImpl`, `computeAgreementImpl`, `readManifestImpl`, `loadWorkspaceConfigImpl`, `pluginRootOverride`) are injection points on the tool's options object per Story 4.12 / 4.10 convention.
- Class-level error assertions via `expect(fn).rejects.toThrow(GhRecoverableError)`; property assertions via `expect(...).rejects.toMatchObject({ name: "GhRecoverableError", class: "defer" })`.
- The `execaImpl` mock is a small object — records calls into an array and returns canned results. Pattern: import `type { execa }` and declare the fake as `Mock<typeof execa>` for type safety; the per-test setup pushes scripted responses onto a queue.
- For SKILL.md content-structure tests (AC5i/l), read the file via `fs.readFile` against the worktree-absolute path, then assert via regex on the relevant section markers (`^12\.1\.` etc.). Pin the test to fail-fast on any drift to a different sub-step number.

### Dependencies

- Story 4.10 (`tools/compute-agreement.ts`, `lib/agreement.ts`, `AgreementMetricResult` type) — the agreement-metric producer this story consumes.
- Story 4.9b (`schemas/execution-manifest.ts:185` `risk_tier` field, classifier emission in `postReviewerComments`) — the risk-tier producer this story consumes.
- Story 4.6 rev-2 / 4.3c (`processReviewerTranscript`'s `done-ready-for-merge` branch + internal `completeStory` call) — the inner-cycle hook point.
- Story 4.8 (`applyReviewerLabels`, `needs-human` label semantics) — the label-application pattern reference.
- Story 4.5 (`gh-error-map.yaml` + `GhRecoverableError`) — the gate inherits the recoverable-error class via the `gh` wrapper.
- Story 4.4 (`gh` wrapper + `pr-create` flow) — same wrapper used for `pr-merge`.
- Story 1.2 (`loadWorkspaceConfig`, `schemas/workspace-config.ts:PluginSettings.agreement_threshold`) — the threshold-resolution path.
- Story 3.2 / 4.1 (`lib/manifest-io.ts` `readManifest`, `state/manifest-state-machine.ts` directory layout) — the manifest read path (canonical `done/<ref>.yaml`).
- Architecture § "Auto-merge gate" — the threshold-and-tier contract.
- PRD `FR40` / `FR41` / `FR42` — the AC source.

### Status flip clause

The orchestrator owns the `Status:` field at the top of this file (per ship-story SKILL.md). The dev agent MUST NOT edit the `Status:` field or any file under `_bmad-output/implementation-artifacts/` when implementing this story. The Status above is set to `ready-for-dev` by the create-story workflow; the orchestrator's Step 4 commit captures this value as part of the bookkeeping commit that ships in the PR.
