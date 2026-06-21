# Story 4.10: Agreement metric helper (`compute-agreement`)

story_shape: substrate

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin maintainer**,
I want **a `computeAgreement` MCP tool that reads `reviewer.verdict` + `reviewer.verdict.merge_action` telemetry events from `<targetRepoRoot>/.crew/telemetry/*.jsonl`, joins them by `(pr_number, session_id)`, walks the most-recent-first sorted resolved verdicts up to a configurable window size (default 50), and returns a deterministic `{ ratio, distribution, window_size, sample_size }` shape (or `null` on insufficient data)**,
so that **Story 4.10b's auto-merge gate has a measurable, deterministic input rather than a hardcoded vibes threshold — and Epic 6's outcome stats / skill-effectiveness reports have a single source of truth for "reviewer-verdict-vs-human-action agreement" without re-implementing the join walk every time**.

### What this story is, in one sentence

Add a new MCP tool `computeAgreement` in `plugins/crew/mcp-server/src/tools/compute-agreement.ts` that loads every `*.jsonl` file under `<targetRepoRoot>/.crew/telemetry/`, parses lines via the existing `TelemetryEventSchema` (Story 1.5 / Story 4.12), keeps only `reviewer.verdict` and `reviewer.verdict.merge_action` events, joins them by `(pr_number, session_id)`, applies the exclusion rules (unresolved `still-open`, `timed_out: true`, `verdict: "reviewer-failure"`), sorts the resolved pairs newest-first by the verdict event's `ts`, takes the first `last_n_verdicts` of them, and returns `{ ratio, distribution, window_size, sample_size } | null`, with a shipped `AgreementMetricResultSchema` Zod type exported for downstream consumers (4.10b) to import.

### What this story does (and why it needs its own story)

PRD `FR67` and `NFR24` pin the contract: a single rolling agreement ratio that 4.10b consumes to decide whether to auto-merge or pause for human. Architecture `core-architectural-decisions.md` §"Telemetry & Observability" lists this helper under "Stats helpers — pure TS functions reading JSONL → deterministic output; exposed as MCP tools." Story 4.12 shipped the producer events (`reviewer.verdict` on POST success; `reviewer.verdict.merge_action` retroactively via `recordPrCloseAction`) and pinned the join key `(pr_number, session_id)` in JSDoc on `RecordPrCloseActionOpts`. Story 4.10b will read `agreement_metric` from this tool's return value to gate the auto-merge decision; without 4.10, 4.10b has nothing to gate on.

The helper has four substrate-level decisions worth pinning in their own story rather than folding into 4.10b:

1. **Agreement definition.** When does a `reviewer.verdict` "agree" with a `reviewer.verdict.merge_action`? Pin the 6-cell truth table explicitly (READY FOR MERGE × merged = agree; NEEDS CHANGES × merged = disagree; etc.) so that 4.10b and Epic 6 do not re-derive it independently. The `verdict: "reviewer-failure"` literal (Story 4.12 added it for the 8-min cap substitution path) is *excluded* from the window because a timed-out reviewer's verdict is not a substantive judgment.

2. **Cross-month windowing.** Telemetry is bucketed monthly (`<YYYY-MM>.jsonl` — architecture decision). The last-50 window can easily span months. The helper reads ALL `*.jsonl` files under `.crew/telemetry/` (file count is bounded — one per month — and per-file size is bounded by NFR21's "JSONL line per event"). The naive O(files) read is acceptable; a future perf story can add a most-recent-N-month cap if profiling shows it matters.

3. **`null` on insufficient data.** Per AC2 (and `NFR24`), an empty log or a sub-window log returns `null` rather than a misleading zero. The threshold for "insufficient" is "sample size strictly less than window size" — the window is the demanding contract; a partial sample is treated as no signal. 4.10b reads `null` as "no agreement signal yet → pause for human" (its own AC for the sub-threshold/insufficient-data branch).

4. **Unresolved exclusion.** A `reviewer.verdict` event whose corresponding `merge_action` is `"still-open"` (or absent) is excluded from the window. This is AC3 verbatim. The walk semantics: find the first N resolved verdicts (most-recent-first), skipping unresolved ones — *not* "take the most recent N verdicts and discard the unresolved ones from that prefix." The distinction matters: a long tail of open PRs preceded by 50 resolved PRs should still yield a valid metric.

This story explicitly does NOT introduce the auto-merge gate (Story 4.10b owns it), the `.crew/config.yaml` knob for tuning `last_n_verdicts` (deferred; v1 ships hardcoded default 50 and lets the caller override programmatically), Epic 6's outcome-stats or skill-effectiveness aggregations (they consume the same telemetry independently), or any caller for `computeAgreement` — Story 4.10b will be the first production caller; in v1 the tool is exercised by vitest only.

### What this story does NOT

- (a) Touch `_bmad-output/implementation-artifacts/sprint-status.yaml` or any other file under `_bmad-output/implementation-artifacts/`. The orchestrator owns status transitions. The dev agent MUST NOT edit any status/state file when implementing this story.
- (b) Implement the auto-merge gate (Story 4.10b). 4.10b reads `agreement_metric` (from this tool) + `risk_tier` (from 4.9b) and decides auto-merge / `needs-human`. This story is consumer-agnostic — it ships the producer; 4.10b ships the gate.
- (c) Modify any telemetry-emission seam. Story 4.12 owns event emission (`postReviewerComments` writes `reviewer.verdict`; `recordPrCloseAction` writes `reviewer.verdict.merge_action`). This story is a pure consumer of the JSONL produced by those seams.
- (d) Modify `TelemetryEventSchema` or any event-type schema. The discriminated union is closed; this tool reads the existing shapes via the existing schema. If a downstream change requires a new event type or field, a separate story extends the schema additively (per the 4.12 pattern).
- (e) Add a `compute-agreement` CLI or any non-MCP-tool surface. v1 ships only the MCP tool. A future Epic 6 retro CLI can call the tool over MCP if needed; the tool's deterministic output shape makes it CLI-friendly.
- (f) Introduce `.crew/config.yaml` overrides for `last_n_verdicts` or any agreement-related threshold. The tool accepts `lastNVerdicts?: number` as a caller-supplied option (default 50); 4.10b will hardcode its own threshold (0.8) on top. A future config-overlay story can add overrides without changing this tool's signature.
- (g) Cache the parsed JSONL across invocations. The tool re-reads on every call. JSONL files are bounded; agreement metric is computed at most once per reviewer pass; caching adds invalidation complexity (mtime check, cross-process coordination) for negligible saving. A Story 6.x perf story can revisit.
- (h) Watch the JSONL for changes. Read-on-call only — no fsnotify, no polling.
- (i) Emit a telemetry event of its own (e.g. `agreement.computed`). The architecture decision is one-way: helpers consume telemetry, they do not feed it back. A future story can add such an event additively if Epic 6 wants to track how often the metric was consulted.
- (j) Persist any state outside the read path. No sidecar cache, no `.crew/state/sessions/<ulid>/agreement-result.json`. Pure-function semantics: same inputs (JSONL contents) → same output.
- (k) Handle malformed JSONL lines by failing. Lines that fail `TelemetryEventSchema.safeParse` are silently skipped (with a counter included in the return shape for surface-level visibility). The `telemetry.invalid` failure-recording substrate (Story 1.5) already handles bad-event-write surfacing; this consumer is robust to mid-stream corruption.
- (l) Handle missing telemetry directory by failing. If `<targetRepoRoot>/.crew/telemetry/` does not exist (fresh repo, telemetry never written), the tool returns `null` (insufficient data) — same as an empty log. No directory creation.
- (m) Modify `apply-reviewer-labels.ts` (Story 4.8), `post-reviewer-comments.ts` (4.6b/4.7/4.12), or `record-agent-invoke.ts` (4.12). These are all upstream of `computeAgreement` and have no dependency on it.
- (n) Add `computeAgreement` to any `permissions/*.yaml`. The reviewer subagent does not call it directly; 4.10b will be the first production caller, and 4.10b runs from the SKILL.md / dev session layer where MCP tools are available without per-role permission entries (the same pattern as `classifyRiskTier` — Story 4.9b Task 10.2).
- (o) Special-case `verdict: "reviewer-failure"` in the agreement truth table. It is *excluded* from the window entirely (treated like an unresolved event). Rationale: a timed-out reviewer is a tool failure, not a substantive verdict; including it as either agreement or disagreement skews the metric. Excluding it makes the metric a measure of *substantive* reviewer accuracy.
- (p) Exclude `timed_out: true` events from the window. The `verdict: "reviewer-failure"` literal is already coupled to `timed_out: true` in the AC3 substitution path (Story 4.12 unpacked 3c–3f), and excluding by verdict covers it. Double-excluding by `timed_out: true` is a no-op but harmless; the spec mandates the verdict-based exclusion as primary and treats `timed_out` as informational.
- (q) Resolve plugin root from `import.meta.url`. The tool accepts no `pluginRoot` — it only needs `targetRepoRoot`. The telemetry directory lives under the target repo; the plugin root is irrelevant.

### Deferred work

- **`.crew/config.yaml` override for `last_n_verdicts`.** A later additive story can introduce a `plugin.agreement_window` knob; the override-resolution pattern (Story 4.9) is the template.
- **Most-recent-N-month read cap.** If telemetry history grows to many years' worth of files and read latency becomes measurable, cap the read at e.g. the 12 most-recent months. v1 reads everything.
- **Per-month / per-week agreement breakdown.** A future Epic 6 stat surfaces "agreement over the last week vs last month vs all-time." Same join logic, different windowing — extract a shared `joinResolvedVerdicts` helper at that point.
- **Per-reviewer-role agreement.** When yield-routed specialists post verdicts (Story 4.11), agreement could be sliced by `agent` (e.g. generalist-reviewer vs security-specialist). v1 collapses all reviewers into one bucket. Additive future story.
- **`agreement.computed` telemetry event.** Useful for tracking how often the metric is consulted (and at what value) for retro analysis. Not load-bearing for 4.10b. Additive.
- **Parsed-JSONL cache.** See § What this story does NOT (g). Add only if profiling shows it matters.
- **Surfacing the malformed-line skip-count to telemetry.** Currently the count is in the return shape only. A future story can emit a `telemetry.invalid` for read-side corruption to mirror the write-side pattern.

---

## Acceptance Criteria

> AC1–AC3 are verbatim from the epic (FR67 / NFR24 split as labelled). AC4 is the integration suite with a `vitest:` marker per the orchestrator's AC-marker-gap memory rule. None reference a slash command, operator-typed CLI, install-doc path, or Claude Code UI element — they describe an internal MCP tool's pure-function output and a JSONL-file consumer. Per `plugins/crew/docs/user-surface-acs.md`, this story is **substrate**; no `(user-surface)` tags apply.

**AC1:**
**Given** the telemetry log with `reviewer.verdict` events carrying both `verdict` and `eventual_merge_action`,
**When** `compute-agreement` runs over a configurable rolling window (default `last_n_verdicts: 50`),
**Then** it returns a pure deterministic ratio (agreement count / window size) along with the window's verdict distribution. _(FR67, NFR24)_

<!-- Not user-surface: AC1 describes the MCP tool's return shape. The tool is internal — never invoked directly by a subagent in v1; only by Story 4.10b's auto-merge gate via internal import (mirrors the `classifyRiskTier` pattern from Story 4.9b). -->

**AC2:**
**Given** an empty or sub-window telemetry log,
**When** the helper runs,
**Then** it returns `null` (insufficient data) rather than a misleading zero. _(NFR24)_

<!-- Not user-surface: AC2 describes the insufficient-data branch of the same internal tool. -->

**AC3:**
**Given** a `reviewer.verdict` event whose `eventual_merge_action` has not yet been resolved (PR still open),
**When** the helper computes,
**Then** the unresolved event is excluded from the window. _(FR67)_

<!-- Not user-surface: AC3 describes the join-and-filter contract — an internal property of the helper's pure-function output. -->

**AC4 (integration, vitest:):**
vitest seeds telemetry across (a) a fully-resolved window, (b) a partially-resolved window, (c) an empty log; the helper returns the expected values.

<!-- Not user-surface: vitest integration suite — internal harness only. The `vitest:` marker satisfies the AC-classifier gate per memory `project_ac_marker_gap`. -->

### Expanded acceptance specifics (folded into AC1–AC4 above; each clause maps to an AC for the AC-table gate)

**AC1 unpacked.** `computeAgreement` MCP tool, ratio and distribution shape:

- (1a) **New MCP tool: `computeAgreement`.** Signature:
  ```ts
  computeAgreement(opts: {
    targetRepoRoot: string;
    lastNVerdicts?: number;  // default 50
  }): Promise<AgreementMetricResult | null>
  ```
  Throws no typed errors of its own under normal operation. A malformed `lastNVerdicts` (zero, negative, non-integer) raises a typed `AgreementWindowInvalidError` (see § Locked files / typed errors). Filesystem read errors (other than ENOENT on the telemetry dir, which returns `null`) propagate verbatim — these are infrastructure failures the caller should see.

- (1b) **Return shape — `AgreementMetricResult`.**
  ```ts
  type AgreementMetricResult = {
    ratio: number;                 // 0.0..1.0, count of agreeing pairs / window_size
    distribution: {                // verdict literal → count in the window
      "READY FOR MERGE": number;
      "NEEDS CHANGES": number;
      "BLOCKED": number;
    };
    window_size: number;           // the effective window — equals lastNVerdicts (or default 50)
    sample_size: number;           // count of resolved pairs in the window — always == window_size on a non-null return
    skipped_unresolved: number;    // count of in-scope verdicts skipped because merge_action was "still-open" or absent
    skipped_excluded: number;      // count of in-scope verdicts skipped because verdict was "reviewer-failure" (and/or timed_out: true)
    malformed_lines: number;       // count of JSONL lines that failed TelemetryEventSchema.safeParse (silently skipped)
  };
  ```
  Exported as `AgreementMetricResultSchema` (Zod, `.strict()`-shaped) AND the inferred type. Downstream consumers (Story 4.10b) import the type and use the schema for round-trip validation if they persist the result.

- (1c) **Agreement truth table — `verdict` × `merge_action`.** A pair (one `reviewer.verdict` joined with its `reviewer.verdict.merge_action`) is "agreement" iff:

  | verdict | merge_action | agreement? |
  |---|---|---|
  | READY FOR MERGE | merged | YES |
  | READY FOR MERGE | closed-unmerged | NO |
  | NEEDS CHANGES | merged | NO |
  | NEEDS CHANGES | closed-unmerged | YES |
  | BLOCKED | merged | NO |
  | BLOCKED | closed-unmerged | YES |
  | (any) | still-open | EXCLUDED (unresolved — AC3) |
  | reviewer-failure | (any) | EXCLUDED (substituted verdict — see (1g)) |

  Concretely: `agree = (verdict === "READY FOR MERGE" && merge_action === "merged") || (verdict !== "READY FOR MERGE" && merge_action === "closed-unmerged")`. Pin this expression in code via a small `isAgreement(verdict, mergeAction): boolean` helper for unit-test legibility.

- (1d) **Join key.** `(pr_number, session_id)` — the join key declared by Story 4.12 (`record-pr-close-action.ts` JSDoc; ReviewerVerdictMergeActionEventSchema comment). A `reviewer.verdict` event with no matching `reviewer.verdict.merge_action` is treated as unresolved (skipped — AC3). A `reviewer.verdict.merge_action` event with no matching `reviewer.verdict` is silently ignored (an orphan close-action from a verdict written before this story shipped, or from a manual `recordPrCloseAction` call — no signal value).

- (1e) **Multiple `reviewer.verdict.merge_action` for one verdict.** Story 4.12 explicitly does NOT dedupe `recordPrCloseAction` writes (unpacked 2g rationale). If two merge_action events exist for the same `(pr_number, session_id)`, the helper uses the LATEST by `resolved_at` (ISO-8601 UTC string compare is correct for the schema's enforced Z-suffix format). Ties (same `resolved_at`) are broken arbitrarily but deterministically — by file-then-line order during the read walk.

- (1f) **Window ordering.** Sort all resolved pairs newest-first by the `reviewer.verdict` event's `ts` (the verdict-emission timestamp, NOT the merge_action's `resolved_at`). Then take the first `lastNVerdicts` (or default 50). If fewer than `lastNVerdicts` resolved pairs exist after exclusions, return `null` (AC2). Ties on `ts` (millisecond-precision collisions) are broken by `session_id` ascending — deterministic.

- (1g) **`verdict: "reviewer-failure"` exclusion.** A `reviewer.verdict` event with `verdict: "reviewer-failure"` is dropped from the candidate set BEFORE the join + window-take. Counted under `skipped_excluded`. Rationale: a timed-out reviewer's verdict is a tool failure, not a substantive judgment; including it as either agreement or disagreement would skew the metric. The `timed_out: true` flag is informational (Story 4.12 unpacked 3c–3f); excluding by `verdict` alone covers all current cases.

- (1h) **Distribution counts the window only.** `distribution["READY FOR MERGE"]` etc. count the verdicts that ARE in the final window (i.e. the `sample_size` pairs). Excluded and unresolved events are NOT in the distribution. The three counts always sum to `sample_size` (which on a non-null return equals `window_size`).

- (1i) **Ratio precision.** `ratio = agreementCount / window_size`. No rounding. JavaScript number precision is sufficient for the v1 window size (50). Callers (4.10b) compare against thresholds using `>=`; a future caller wanting fixed-decimal output can format at the display seam.

- (1j) **Deterministic byte-stable output.** Two calls against the same JSONL contents must produce identical results. Specifically: `distribution` keys are emitted in the literal order `["READY FOR MERGE", "NEEDS CHANGES", "BLOCKED"]` (object-literal declaration order); arrays are not part of the return; all numeric fields are derived from the same deterministic walk. This is the contract that makes the result safe to `JSON.stringify` and store in a sidecar if a future caller wants to.

**AC2 unpacked.** `null` return on insufficient data:

- (2a) **Trigger conditions for `null` return:**
  - The `.crew/telemetry/` directory does not exist (ENOENT on `readdir`).
  - The directory exists but contains no `*.jsonl` files.
  - The directory contains `*.jsonl` files but no `reviewer.verdict` events.
  - Resolved-after-exclusions pair count is strictly less than `lastNVerdicts`.

  In every case: return `null` (a literal — not an object with `ratio: 0`).

- (2b) **`null` is the only insufficient-data signal.** Downstream callers (4.10b) inspect for `null` via `=== null` and treat it as "no signal — pause for human." No `kind: "insufficient" | "ok"` discriminator; the `null` literal is sufficient and matches the FR67 / NFR24 phrasing ("returns `null`").

- (2c) **`lastNVerdicts: 0` is a configuration error, not insufficient data.** A caller passing zero (or negative, or non-integer) raises `AgreementWindowInvalidError` rather than returning `null`. The default 50 is the only sensible v1 value; future config-overlay stories can tighten or relax.

- (2d) **An exact-fit window is NOT insufficient data.** If resolved-after-exclusions pair count is exactly `lastNVerdicts`, return a non-null result with `sample_size === window_size`. The "strictly less than" boundary is the trigger.

**AC3 unpacked.** Unresolved exclusion semantics:

- (3a) **`merge_action: "still-open"` is unresolved.** A `reviewer.verdict.merge_action` event with `merge_action: "still-open"` is treated identically to no matching merge_action event existing at all. The pair is unresolved; the verdict is skipped (counted under `skipped_unresolved`).

- (3b) **Absent merge_action is unresolved.** A `reviewer.verdict` with no matching `reviewer.verdict.merge_action` in the JSONL (yet) is unresolved. Same treatment as (3a). The two cases — no event vs `still-open` event — are equivalent for windowing.

- (3c) **Walk semantics: skip-then-take, not take-then-skip.** The helper walks all resolved-after-exclusions verdicts newest-first and takes the first `lastNVerdicts` of THEM. It does NOT take the most-recent `lastNVerdicts` verdicts and then drop the unresolved/excluded ones from that prefix (which would yield a smaller-than-window sample even when older resolved verdicts exist). Distinction matters when a long tail of open PRs sits at the head of the verdict log.

- (3d) **Latest-merge-action-wins.** Per (1e): if a `(pr_number, session_id)` pair has multiple merge_action events (e.g. the PR was reopened and re-closed), the latest by `resolved_at` is canonical. A `still-open` followed by a `merged` becomes `merged` (resolved, included); a `merged` followed by a `still-open` becomes `still-open` (unresolved, excluded). The walk-newest-first uses the canonical merge_action.

**AC4 unpacked.** Integration suite scope:

- (4a) **Fixture base.** vitest tests use `await fs.mkdtemp(path.join(os.tmpdir(), "compute-agreement-"))` per `beforeEach` to create a clean `targetRepoRoot`. `afterEach` cleans via `fs.rm(..., { recursive: true, force: true })`. Tests write JSONL directly via `fs.writeFile` (no `logTelemetryEvent` calls — the consumer is under test, not the writer); each line is constructed via a helper `makeVerdictEvent({ ts, session_id, story_id, pr_number, verdict, timed_out? })` and `makeMergeActionEvent({ ts, session_id, story_id, pr_number, merge_action, resolved_at? })` that emit `TelemetryEventSchema`-valid JSON objects.

- (4b) **(a) Fully-resolved window — `pass`.** Seed 50 `reviewer.verdict` events with monotonic `ts` and matching `reviewer.verdict.merge_action` events such that 40 pairs agree and 10 disagree (mixing all three verdict literals). Call `computeAgreement` with default window. Assert:
  - `ratio: 0.8`
  - `distribution` sums to 50
  - `sample_size: 50`, `window_size: 50`
  - `skipped_unresolved: 0`, `skipped_excluded: 0`, `malformed_lines: 0`

- (4c) **(b) Partially-resolved window — `null` (insufficient).** Seed 30 fully-resolved pairs and 20 `reviewer.verdict` events with no merge_action (PRs still open). Call with default window 50. Assert: result is `null` (sample of 30 < window 50). Then call with `lastNVerdicts: 30`. Assert: `sample_size: 30`, `window_size: 30`, ratio matches the seeded agreement count, `skipped_unresolved: 20`.

- (4d) **(c) Empty log — `null`.** No `.crew/telemetry/` directory. Call. Assert: `null`. Then create the directory but write no files. Assert: `null`. Then write one `*.jsonl` file containing only `agent.invoke` events (no `reviewer.verdict`). Assert: `null`.

- (4e) **(d) `verdict: "reviewer-failure"` exclusion.** Seed 50 fully-resolved pairs of which 10 carry `verdict: "reviewer-failure"` and `timed_out: true`. Call. Assert: `null` (only 40 substantive verdicts remain; sample < window). Then call with `lastNVerdicts: 40`. Assert: `sample_size: 40`, `window_size: 40`, `skipped_excluded: 10`, distribution sums to 40.

- (4f) **(e) Cross-month windowing.** Seed events split across THREE `<YYYY-MM>.jsonl` files (e.g. `2026-03`, `2026-04`, `2026-05`) — 20 pairs per file, all resolved. Call with default 50. Assert: `sample_size: 50`, `window_size: 50`, sampled from newest-first across all three files (i.e. the 20 from `2026-05` + 20 from `2026-04` + 10 from `2026-03`).

- (4g) **(f) Latest-merge-action-wins.** Seed one `reviewer.verdict` event and two `reviewer.verdict.merge_action` events for the same `(pr_number, session_id)`: the older says `still-open`, the newer says `merged`. Call with `lastNVerdicts: 1`. Assert: `sample_size: 1`, pair counted as resolved-and-agreement. Then reverse the order (newer is `still-open`, older is `merged`). Assert: `null` (sample of 0 < window 1).

- (4h) **(g) Walk semantics — skip-then-take.** Seed 60 events of which the most recent 20 are unresolved (no merge_action), followed by 50 fully-resolved. Call with default 50. Assert: `sample_size: 50`, `window_size: 50`, `skipped_unresolved: 20`. (Confirms (3c) — the helper does NOT return `null` just because the top 20 are unresolved.)

- (4i) **(h) `lastNVerdicts` validation.** Call with `lastNVerdicts: 0`. Assert: `AgreementWindowInvalidError` thrown. Same for `-1`, `1.5`, `NaN`, `Infinity`. The error message names the offending value and the constraint (`positive integer`).

- (4j) **(i) Orphan merge_action ignored.** Seed 5 `reviewer.verdict.merge_action` events with no matching `reviewer.verdict`. Assert: `null` (no resolved pairs). No error raised; the orphans are silently ignored.

- (4k) **(j) Malformed JSONL line tolerance.** Seed 50 fully-resolved pairs interleaved with 5 lines of garbage (literal `"not-json"`, plus 2 lines of JSON that fails Zod parse — e.g. a `reviewer.verdict` with an unknown `data.foo` key, plus 2 empty lines). Call. Assert: `sample_size: 50`, `malformed_lines: 5` (empty lines do NOT count — they're skipped silently per the JSONL convention; garbage and Zod-fail lines DO count).

- (4l) **(k) Determinism / byte-stability.** Same fixture as (4b). Call twice. Assert `deepStrictEqual`. Then shuffle the seed order on disk (write events into a different filename order, or interleave between files). Call. Assert identical result — the walk's sort by `ts` (with `session_id` tie-break) guarantees stability regardless of read order.

- (4m) **(l) `AgreementMetricResultSchema` round-trip.** Take a non-null result from (4b). `JSON.stringify` → `JSON.parse` → `AgreementMetricResultSchema.parse`. Assert no errors and value equality.

- (4n) **(m) Schema-strict assertion.** Construct a `AgreementMetricResultSchema` candidate object with an extra unknown field. Assert Zod parse fails.

- (4o) **(n) MCP tool registration smoke test.** Read `register.ts`'s tool count assertion; assert it includes `computeAgreement` (count bumped from 29 to 30). This single line catches forgotten registration; no separate test file needed.

---

## Tasks / Subtasks

Implementation order is load-bearing. Each task lists its AC dependencies.

- [ ] **Task 1: Pure helper `isAgreement`** (AC: #1)
  - [ ] 1.1 Create `plugins/crew/mcp-server/src/lib/agreement.ts`.
  - [ ] 1.2 Export `isAgreement(verdict: "READY FOR MERGE" | "NEEDS CHANGES" | "BLOCKED", mergeAction: "merged" | "closed-unmerged"): boolean` implementing the truth table per AC1 unpacked (1c). The function explicitly accepts only resolved-non-excluded values — `"reviewer-failure"` and `"still-open"` are filtered upstream and never reach this helper. Caller-side exhaustiveness is enforced by the input type union.
  - [ ] 1.3 JSDoc citing this story key, FR67, NFR24, and the truth table.
  - [ ] 1.4 Create `plugins/crew/mcp-server/src/lib/__tests__/agreement.test.ts` covering all six rows of the truth table.

- [ ] **Task 2: Typed error `AgreementWindowInvalidError`** (AC: #1, #4i)
  - [ ] 2.1 In `plugins/crew/mcp-server/src/errors.ts`, append `AgreementWindowInvalidError` extending `DomainError`. Constructor: `{ lastNVerdicts: number; reason: string }`. Message: `` `computeAgreement: invalid lastNVerdicts=<lastNVerdicts> — <reason>. (FR67)` ``. Use the existing `extends DomainError` pattern; no new imports beyond what `errors.ts` already uses.

- [ ] **Task 3: `computeAgreement` MCP tool** (AC: #1, #2, #3)
  - [ ] 3.1 Create `plugins/crew/mcp-server/src/tools/compute-agreement.ts`.
  - [ ] 3.2 Export Zod schema `AgreementMetricResultSchema` matching the AC1 unpacked (1b) shape. `.strict()` at every level. Numeric fields use `z.number().int().nonnegative()` where appropriate; `ratio` is `z.number().min(0).max(1)`; `distribution` is an explicit `.strict()` object with the three literal keys. Also export `AgreementMetricResult = z.infer<typeof AgreementMetricResultSchema>`.
  - [ ] 3.3 Implement the algorithm:
    1. Validate `lastNVerdicts` (default 50): must be a positive integer, finite. Else throw `AgreementWindowInvalidError`.
    2. List `<targetRepoRoot>/.crew/telemetry/*.jsonl`. ENOENT on the directory → return `null`. No `*.jsonl` files → return `null`.
    3. Read every `*.jsonl` file. For each line: trim; if empty, skip (does NOT count as malformed). Else `JSON.parse` inside try/catch; on failure, increment `malformed_lines` and skip. Else `TelemetryEventSchema.safeParse`; on failure, increment `malformed_lines` and skip. (The two failures are distinct in reality but counted together — they're both "the read could not extract a valid event from this line.")
    4. Bucket parsed events: `verdicts` (type `reviewer.verdict`), `mergeActions` (type `reviewer.verdict.merge_action`). Discard all other types silently (do NOT count as malformed — they're valid events, just not relevant).
    5. For each `verdicts` entry: drop if `data.verdict === "reviewer-failure"`; count under `skipped_excluded`. (Per (1g).)
    6. For each remaining verdict: find the matching merge_action by `(data.pr_number, session_id)`. If multiple, pick latest by `data.resolved_at` (string compare on UTC ISO-8601). If none, or matched one has `data.merge_action === "still-open"`, mark this verdict unresolved (count under `skipped_unresolved`). Else attach the resolved `merge_action` literal (`"merged" | "closed-unmerged"`).
    7. Sort the resolved-with-merge_action verdicts newest-first by `ts` (tie-break: `session_id` ascending — see (1f)). Take the first `lastNVerdicts`.
    8. If fewer than `lastNVerdicts` resolved verdicts exist after sorting, return `null`. (Per AC2 / (2d).)
    9. Walk the window: for each verdict, compute `isAgreement(verdict, mergeAction)`; increment `agreementCount` if true. Build `distribution` by counting each verdict literal.
    10. Return `{ ratio: agreementCount / lastNVerdicts, distribution, window_size: lastNVerdicts, sample_size: lastNVerdicts, skipped_unresolved, skipped_excluded, malformed_lines }`.
  - [ ] 3.4 Inputs accepted via standard MCP-tool-schema (`opts: { targetRepoRoot: string; lastNVerdicts?: number }`). The MCP-tool-input Zod schema declares `lastNVerdicts: z.number().int().positive().optional()`; the runtime validation throws `AgreementWindowInvalidError` rather than letting Zod's default error escape, because the caller deserves the rich error message.
  - [ ] 3.5 The directory-listing step uses `fs.readdir(telemetryDir, { withFileTypes: true })` and filters by `entry.isFile() && entry.name.endsWith(".jsonl")`. Sort filenames ascending (lexicographic) so the read order is deterministic — this matters only for the tie-break on identical `ts` values (where file-then-line order is the final tiebreaker per (1e) closing sentence).
  - [ ] 3.6 JSDoc citing this story key, FR67, NFR24, the join-key (matches Story 4.12's `record-pr-close-action.ts` JSDoc), and the truth-table reference (links to `lib/agreement.ts`).
  - [ ] 3.7 Test seam: `readTelemetryDirImpl?: (dirPath: string) => Promise<string[]>` and `readFileImpl?: (filePath: string) => Promise<string>` as optional injection points on the impl's options object (mirror the `record-agent-invoke.ts` seam pattern). Production callers pass none; tests use the production defaults (real `fs`) per the 4-12 convention of "no `vi.mock` of production modules."
  - [ ] 3.8 Create `plugins/crew/mcp-server/src/tools/__tests__/compute-agreement.test.ts` covering AC4 sub-cases (4b)–(4n).

- [ ] **Task 4: MCP-tool registration** (AC: #4o)
  - [ ] 4.1 Register `computeAgreement` in `plugins/crew/mcp-server/src/tools/register.ts`. Bump tool-count assertion from 29 (post-4.9b) to 30 in any test that pins it (search for `\.toBe\(29\)` and `\.toHaveLength\(29\)` in `__tests__/`).
  - [ ] 4.2 Do NOT add `computeAgreement` to any `permissions/*.yaml`. v1 has no subagent-callable surface — Story 4.10b's auto-merge gate will call it via internal import (same pattern as `classifyRiskTier` per Story 4.9b Task 10.2). A future story that exposes the tool to a subagent (e.g. an Epic 6 "agreement dashboard" CLI) will add the permission entry then.

- [ ] **Task 5: Build, vitest, dist** (AC: all)
  - [ ] 5.1 `pnpm --dir plugins/crew/mcp-server install` (must succeed; no new dependencies).
  - [ ] 5.2 `pnpm --dir plugins/crew/mcp-server build` passes with no TypeScript errors.
  - [ ] 5.3 `pnpm --dir plugins/crew/mcp-server test` passes — existing tests from prior stories + new tests added here.
  - [ ] 5.4 Commit `plugins/crew/mcp-server/dist/` with rebuilt output. (See CLAUDE.md "Plugin build output is tracked in git" — `/plugin install` copies the tree as-is and does not run a build step; CI fails on drift.)
  - [ ] 5.5 No leftover `TODO(4.10)` / `TODO(4-10)` comments in any touched source file.

---

## Implementation strategy

### Why a pure-function MCP tool rather than a CLI

The architecture pins "Stats helpers — pure TS functions reading JSONL → deterministic output; exposed as MCP tools" (`core-architectural-decisions.md:71`). The reasoning is consistent across the codebase: a tool over MCP gets typed inputs, typed outputs, schema validation at the boundary, and is callable by SKILL.md prose (Story 4.10b's gate) and by future CLIs / dashboards uniformly. A direct CLI would duplicate the schema layer and would not be callable by 4.10b's SKILL.md prose. Reject CLI for v1.

### Why the agreement truth table is pinned in `lib/agreement.ts`

Two consumers need it: `computeAgreement` (this story) and any future Epic 6 retro stat (per-week agreement, per-reviewer agreement, etc.). Embedding it inline in `compute-agreement.ts` would force the Epic 6 stat to either re-implement it (drift risk) or pull from this file (which becomes a de-facto helper anyway). Pin it as a shared helper now to make the eventual extraction free.

### Why excluding `reviewer-failure` rather than treating it as auto-disagree

A timed-out reviewer (Story 4.12's AC3 substitution path) emits `verdict: "reviewer-failure"` because the actual reviewer never produced a verdict — the dev session substituted a comment. The merge_action that follows reflects whatever the operator decided on the substituted state, not the reviewer's judgment. Counting that as "disagreement" would penalise the metric for a tool failure rather than a substantive reviewer mistake. Counting as "agreement" would over-credit. Excluding entirely is the only honest treatment; the substituted state is a known-unknown for agreement purposes.

### Why cross-month reads are O(files), not O(events)

Telemetry files are bucketed monthly per architecture. After a year of dogfooding this repo would have ~12 files; after Epic 6 ships and customers use it, a busy repo might have a few per month (a future story could split per-week, but v1 is monthly). The read is O(file_count) for the directory listing, then O(line_count) for the parse — but only `reviewer.verdict` and `reviewer.verdict.merge_action` events are kept past the parse; the bulk (`agent.invoke`) is discarded. The window-take is O(verdict_count). All bounded by NFR21's per-event JSONL size. Caching is a future perf story; the architecture decision is "JSONL is the parseable substrate, read it on demand."

### Why `null` rather than `{ ratio: 0 }` on insufficient data

Per FR67 / NFR24 verbatim. The downstream consumer (4.10b) needs to distinguish "no signal yet — pause" from "100% disagreement — definitely pause"; both are operationally the same (pause for human), but they mean different things for retro analysis. `null` is the cleanest sentinel — JavaScript's `=== null` check is unambiguous; objects with sentinel fields invite "what does ratio: 0 with sample_size: 0 even mean" confusion. `null` is the contract.

### Why the walk is skip-then-take, not take-then-skip

A repo whose head-of-log has 20 just-opened PRs (all unresolved) and below them 50 long-since-closed PRs (all resolved) has a perfectly good 50-event agreement signal. Taking the most-recent 50 events and then dropping the unresolved ones from that prefix would yield a sample of 30 → `null`. Skipping the unresolved ones first and then taking 50 yields the correct signal. The semantic difference matters for any repo that has open PRs in flight.

### Why no schema for `lastNVerdicts: 0` at the MCP layer (we throw instead)

MCP schemas reject invalid input with generic Zod messages. The caller (4.10b) deserves a message that names the rule (`positive integer`) and the value, so the typed error is the right surface. The MCP-tool schema declares `z.number().int().positive().optional()` to catch the obvious cases at the boundary (so the bad input never reaches the impl), but the impl re-validates and throws the rich error — defense-in-depth, and future MCP-server changes can't accidentally widen the input.

### Why no caching of the parsed JSONL

`docs/risk-tiering.md` is small (architecture decision); telemetry is bounded by NFR21; the compute is called at most once per reviewer pass (and reviewer passes are minutes apart). Caching introduces invalidation complexity (mtime check? per-process cache? cross-process?) for negligible saving. The Story 4.9b deferred-work note about caching applies here verbatim: revisit if profiling shows it matters.

### Why agreement events outside the window are still counted in `skipped_*`

The return shape's `skipped_unresolved`, `skipped_excluded`, `malformed_lines` count ALL such events in the input — not just the ones that would have been in-window. Rationale: these counts surface log health to retro analysis ("we have 200 unresolved verdicts — is the merge_action emission path broken?"). A windowed-only count would hide whole-log signal. The window is for the ratio; the diagnostics are for the operator.

---

## Locked files

These files are off-limits to this story. If a change appears necessary, STOP and surface the conflict — do not silently edit.

- `plugins/crew/mcp-server/src/lib/logger.ts` (Story 1.5) — DO NOT modify. This story is a consumer, not a writer; no logger change required.
- `plugins/crew/mcp-server/src/schemas/telemetry-events.ts` (Story 1.5 / 4.12 / 4.11) — DO NOT modify. The discriminated union is closed; this story reads the existing shapes.
- `plugins/crew/mcp-server/src/tools/post-reviewer-comments.ts` (Story 4.6b / 4.7 / 4.12 / 4.9b) — DO NOT modify. `reviewer.verdict` emission is owned by 4.12; 4.9b's evidence-block changes are unrelated.
- `plugins/crew/mcp-server/src/tools/record-agent-invoke.ts` (Story 4.12) — DO NOT modify.
- `plugins/crew/mcp-server/src/tools/record-pr-close-action.ts` (Story 4.12) — DO NOT modify. The producer of `reviewer.verdict.merge_action` is the read counterpart's contract; this story reads via the schema, not via the producer's API.
- `plugins/crew/mcp-server/src/tools/run-reviewer-session.ts` (Story 4.6 / 4.9b) — DO NOT modify.
- `plugins/crew/mcp-server/src/tools/process-reviewer-transcript.ts` (Story 4.6 rev2) — DO NOT modify.
- `plugins/crew/mcp-server/src/tools/process-dev-transcript.ts` (Story 4.3b / 4.5) — DO NOT modify.
- `plugins/crew/mcp-server/src/tools/process-reviewer-yield.ts` (Story 4.11) — DO NOT modify.
- `plugins/crew/mcp-server/src/skills/yield-parser.ts` (Story 4.11) — DO NOT modify.
- `plugins/crew/mcp-server/src/tools/apply-reviewer-labels.ts` (Story 4.8) — DO NOT modify.
- `plugins/crew/mcp-server/src/tools/complete-story.ts` / `claim-next-story.ts` / `claim-story.ts` (Story 4.1) — DO NOT modify.
- `plugins/crew/mcp-server/src/tools/classify-risk-tier.ts` (Story 4.9b) — DO NOT modify.
- `plugins/crew/mcp-server/src/lib/runtime-limits.ts` (Story 4.12) — DO NOT modify. Agreement-window default lives in `compute-agreement.ts`, NOT in runtime-limits (the constants in `runtime-limits.ts` are for wall-clock caps, not for window sizing — different concept).
- `plugins/crew/skills/start/SKILL.md` (Stories 4.2 / 4.3b / 4.3c / 4.6 / 4.6b / 4.7 / 4.3c / 4.9b) — DO NOT modify.
- `plugins/crew/permissions/generalist-dev.yaml` / `generalist-reviewer.yaml` (Story 2.2 / 4.6 / 4.12 / 4.11 / 4.9b) — DO NOT modify. v1 has no subagent-callable agreement surface.
- `plugins/crew/catalogue/*.md` (Story 2.1 / 4.11) — DO NOT modify.
- `plugins/crew/mcp-server/src/schemas/execution-manifest.ts` (Story 3.2 / 3.5 / 4.1 / 4.9b) — DO NOT modify. No manifest field changes in this story.

### Declared-locked-file changes (explicit exceptions)

- **`plugins/crew/mcp-server/src/errors.ts`** (typed-error hierarchy; appended-to by most Epic-1 through Epic-4 stories) — Task 2.1 appends `AgreementWindowInvalidError`. Routine additive growth following the established `extends DomainError` pattern.
- **`plugins/crew/mcp-server/src/tools/register.ts`** (Story 1.4; locked due to tool-count assertion) — Task 4.1 registers `computeAgreement`. Bump tool-count assertion 29 → 30 in any test that pins it.

---

## Dev Notes

### Files this story will create

- `plugins/crew/mcp-server/src/lib/agreement.ts` (Task 1)
- `plugins/crew/mcp-server/src/lib/__tests__/agreement.test.ts` (Task 1.4)
- `plugins/crew/mcp-server/src/tools/compute-agreement.ts` (Task 3)
- `plugins/crew/mcp-server/src/tools/__tests__/compute-agreement.test.ts` (Task 3.8)

### Files this story will modify

- `plugins/crew/mcp-server/src/errors.ts` — Task 2.1 (append `AgreementWindowInvalidError`).
- `plugins/crew/mcp-server/src/tools/register.ts` — Task 4.1 (register `computeAgreement`, bump tool-count).
- Any existing test files pinning the tool-count assertion (search for `\.toHaveLength\(29\)` / `\.toBe\(29\)` in `__tests__/`) — Task 4.1.
- `plugins/crew/mcp-server/dist/` — Task 5.4 (rebuilt output committed).

### Current-state notes on files being modified or referenced

- **`schemas/telemetry-events.ts`** (current state per Story 1.5 + 4.12 + 4.11): defines six event schemas in the closed discriminated union — `agent.invoke`, `telemetry.invalid`, `reviewer.verdict`, `reviewer.verdict.merge_action`, `dev.budget_exceeded`, `yield.handoff`. All `.strict()`. `reviewer.verdict.data.verdict` is the enum `["READY FOR MERGE", "NEEDS CHANGES", "BLOCKED", "reviewer-failure"]`. `reviewer.verdict.merge_action.data.merge_action` is the enum `["merged", "closed-unmerged", "still-open"]`. Read-only from this story.
- **`tools/record-pr-close-action.ts`** (current state per Story 4.12 Task 6): writes `reviewer.verdict.merge_action` events with the join key `(pr_number, session_id)` documented in JSDoc. No dedup at write time — caller's responsibility, with caveat that 4.10's compute picks latest-by-`resolved_at` per (1e). Read-only from this story's perspective; the spec just confirms the produced event shape matches what 4.10 reads.
- **`tools/post-reviewer-comments.ts`** (current state per Stories 4.6b / 4.7 / 4.12 / 4.9b): emits `reviewer.verdict` on POST/PATCH success via `logTelemetryEvent`. Carries `pr_number`, `verdict`, `standards_version`, `plugin_version`, `timed_out`. Read-only.
- **`tools/register.ts`** (current state per Story 1.4 + every story since): tool-count assertion last bumped to 29 by Story 4.9b. Task 4.1 bumps to 30. The test file pinning the count is typically `__tests__/register.test.ts` or similar — search before editing.
- **`lib/runtime-limits.ts`** (current state per Story 4.12): exports `REVIEWER_HARD_CAP_MS = 480_000` and `DEV_BUDGET_MS = 1_800_000`. Wall-clock caps only — the agreement-window constant lives in `compute-agreement.ts`, not here (different concept; see Locked-files note).

### Conventions to pre-empt validator catches

- **Zod 4.x error format.** v4 emits `"Invalid option"` not v3's `"Invalid enum value"`; use `{ message: "..." }` form for literal custom errors. Verified against Stories 4-9 / 4-12 / 4-9b pass-2 validator catches.
- **Tmpdir fixtures.** Every test fixture that creates a tmpdir MUST use `await fs.mkdtemp(path.join(os.tmpdir(), "compute-agreement-"))`. Never bare string concatenation; never `${os.tmpdir()}/foo` interpolation; never a fixed path.
- **Cross-AC consistency.** The verdict literal set is exactly `["READY FOR MERGE", "NEEDS CHANGES", "BLOCKED", "reviewer-failure"]` — exact string matches, uppercase, no punctuation drift. The merge_action literal set is exactly `["merged", "closed-unmerged", "still-open"]`. The default window is `50` (named constant `DEFAULT_AGREEMENT_WINDOW = 50` exported alongside the tool for any callers wanting to reference it). The `AgreementMetricResult` return-shape field names use snake_case (`window_size`, `sample_size`, `skipped_unresolved`, `skipped_excluded`, `malformed_lines`) matching the broader Pattern §11 / telemetry-event convention.
- **Determinism.** The walk's sort by `ts` with `session_id` tie-break is the byte-stability contract. AC4 (4l) tests it explicitly; do not skip.
- **JSONL line-empty handling.** A JSONL file may end with a trailing newline; the resulting trailing empty line MUST be skipped silently (not counted as malformed). This is the standard JSONL convention; pre-empt the "did I make `malformed_lines = 1` on every well-formed file?" bug.
- **Schema-strict assertion.** `AgreementMetricResultSchema` is `.strict()` at every level. Tests asserting unknown-key rejection (AC4n) must pass — use `safeParse(...).success === false` and check the issue path.

### Testing standards

- vitest with `pnpm vitest --run` from `plugins/crew/mcp-server/`.
- `fs.mkdtemp(path.join(os.tmpdir(), "compute-agreement-"))` for tmpdir fixtures; `fs.rm(..., { recursive: true, force: true })` in `afterEach`.
- No global mocks. No `import.meta.url` mocking.
- No `vi.mock` of production modules. Test seams (`readTelemetryDirImpl`, `readFileImpl`) are injection points on the tool's options object per Story 4.12's convention.
- Class-level error assertions via `expect(fn).rejects.toThrow(AgreementWindowInvalidError)`; property assertions via `expect(...).rejects.toMatchObject({ name: "AgreementWindowInvalidError" })`.
- Round-trip JSONL: tests write events via raw `fs.writeFile` (not `logTelemetryEvent`) to keep the consumer under test isolated from the writer. Each helper (`makeVerdictEvent`, `makeMergeActionEvent`) returns a `JSON.stringify`-able object that satisfies `TelemetryEventSchema.parse` — assertions in the test setup confirm this once per helper to fail fast on fixture drift.

### Dependencies

- Story 1.5 (`lib/logger.ts`, `schemas/telemetry-events.ts`) — closed-set discriminated-union substrate.
- Story 4.12 (`tools/post-reviewer-comments.ts` emission seam, `tools/record-pr-close-action.ts`, `(pr_number, session_id)` join key) — the producer of the events this story consumes.
- Story 4.9b (`tools/classify-risk-tier.ts` pattern reference) — `(targetRepoRoot, optional config)` pure-function-MCP-tool template; same shape applies here.
- Story 4.10b — the first production consumer of this tool's return value. Not a dependency in either direction (this story can ship before 4.10b); the auto-merge gate just reads `agreement_metric` and the manifest's `risk_tier` field.
- Architecture § "Telemetry & Observability" (`core-architectural-decisions.md` lines 64-72) — JSONL storage layout, "Stats helpers as pure TS functions" decision.
- PRD `FR67` (`prd-crew-v1/functional-requirements.md`) — agreement metric requirement.
- PRD `NFR24` (`prd-crew-v1/non-functional-requirements.md`) — deterministic ratio + `null`-on-insufficient invariant.

### Status flip clause

The orchestrator owns the `Status:` field at the top of this file (per ship-story SKILL.md). The dev agent MUST NOT edit the `Status:` field or any file under `_bmad-output/implementation-artifacts/` when implementing this story. The Status above is set to `ready-for-dev` by the create-story workflow; the orchestrator's Step 4 commit captures this value as part of the bookkeeping commit that ships in the PR.
