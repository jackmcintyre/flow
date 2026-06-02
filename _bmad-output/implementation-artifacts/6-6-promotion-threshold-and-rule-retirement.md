# Story 6.6: Promotion threshold and rule retirement

story_shape: substrate
Status: review

## Story

As a **plugin operator**,
I want **a deterministic helper that counts how often each failure class fired over the window, flags classes that cross a promotion threshold as new-rule candidates and rules whose class has gone quiet as retirement candidates, and a retirement apply path that removes or demotes a stale rule and regenerates the standards doc**,
So that **the standards doc grows from observed misses *and* relaxes when a rule stops earning its slot — and the "grow or retire" decision rests on counted evidence the operator can see, not on the analyst's vibes**.

This story closes the calibration loop's feedback arm. Story 6.5 made an accepted `rule` proposal mutate the registry; Story 6.5b made it regenerate the standards doc under the ≤10 cap. This story supplies the *upstream* signal — **which** rules to propose and **which** to retire — and the *downstream* `rule-retirement` apply path. The load-bearing piece is a **deterministic fire-count helper**: it rolls up per-failure-class fire counts from the cycle's done manifests and telemetry, compares them to configurable thresholds, and hands the retro analyst a structured list of promotion candidates and retirement candidates. The analyst then drafts the `rule` / `rule-retirement` proposals from that evidence (it never counts in prose). Accepting a `rule-retirement` proposal removes the rule (or demotes its `level` to `advisory`) and regenerates the standards doc by reusing Story 6.5b's `regenerate-standards`.

## Dependencies

- **Builds on Story 6.5** (registry schema + `rule` apply handler; it repointed `KIND_TO_STORY["rule-retirement"]` to `"Story 6.6"`) and **Story 6.5b** (`regenerate-standards`, which the retirement apply path reuses after removing/demoting a rule).
- **Consumes the retro-input bundle (shipped, 6.2/6.3):** `gatherRetroInputs` already returns `doneManifests`, `telemetrySummary`, `priorProposals`, and `ruleRegistry`. This story adds a computed fire-count rollup + candidate lists to that bundle (or a sibling helper the analyst calls) so the analyst receives counted evidence.
- **Consumes story-level failure data (shipped, 6.1):** `record-story-retro` writes `failure_class` onto each done manifest; the fire-count helper rolls these up. It also reads `reviewer.verdict`-shaped telemetry for the same window.
- **Soft dependency on Story 6.12 (cycle boundaries — NOT yet built):** the retirement rule is phrased "not fired for ≥ M consecutive *cycles*." Cycle boundaries land in 6.12. Until then this story treats the available telemetry/manifest history as a single configurable window and approximates "M cycles" over it (see Implementation Notes); the promotion path (within-window counts) is fully correct today. Note the degradation in the completion notes.
- **Is the last rule-side story of Epic 6b;** the skill-side (6.7) and team-side (6.10) handlers register into the same gate independently.

## Acceptance Criteria

**AC1 — a deterministic helper counts per-failure-class fires over the window (integration):**

A pure helper (no LLM) reads the gathered retro inputs (done manifests' `failure_class` fields plus the window's telemetry) and returns, per failure class, a fire count over the window and the rules currently registered against that class. It is fully deterministic — same inputs yield the same counts — and counts nothing it cannot source from a manifest or a telemetry event. A vitest seeds done manifests and telemetry with a known distribution of failure classes and asserts the per-class fire counts match by hand, including a class with zero fires and a class with no registered rule.
vitest: plugins/flow/mcp-server/src/lib/__tests__/failure-class-fire-counts.test.ts

**AC2 — classes crossing a configurable promotion threshold are flagged as new-rule candidates for the analyst (integration):**

The helper flags every failure class whose window fire count is at or above a configurable promotion threshold (documented default) **and** has no rule already registered against it as a promotion candidate, surfacing the class and its count. These candidates are exposed to the retro analyst through the input bundle; the retro-analyst catalogue instructs it to draft one `rule` proposal per promotion candidate (carrying that class), and to draft none for a class that already has a rule. A vitest drives the helper over seeded telemetry crossing and not-crossing the threshold and asserts exactly the right classes are flagged as promotion candidates, and that an already-ruled class is not flagged.
vitest: plugins/flow/mcp-server/src/lib/__tests__/failure-class-fire-counts.test.ts

**AC3 — rules whose class has gone quiet are flagged as retirement candidates with the evidence (integration):**

The helper flags every registered rule whose `target_failure_class` has not fired for at least a configurable M windows (documented default M=5) as a retirement candidate, carrying `target_rule_id`, `fire_count_over_window`, and a `recommended_action` of `retire` (zero fires) or `relax` (demote to advisory — low but non-zero fires). The analyst drafts a `rule-retirement` proposal per retirement candidate from these fields so the operator sees the count, not just the recommendation. A vitest seeds a registry plus telemetry where one rule's class is silent and another's still fires, and asserts only the silent rule is flagged, with the correct `target_rule_id`, `fire_count_over_window`, and `recommended_action`.
vitest: plugins/flow/mcp-server/src/lib/__tests__/failure-class-fire-counts.test.ts

**AC4 — accepting a `rule-retirement` proposal removes or demotes the rule and regenerates the standards doc (integration):**

A `rule-retirement`-kind apply handler is registered into the production gate. On confirm, for `recommended_action: retire` it removes the rule matching `target_rule_id` from `docs/discipline-rules.yaml`; for `relax` it demotes that rule's `level` to `advisory` in place. Either way it then regenerates `docs/standards.md` via Story 6.5b's `regenerate-standards`, returns both changed paths, and the gate commits both files plus the proposal stamp in one commit. Comments and untouched rules in the registry survive (comment-preserving write). A `target_rule_id` that matches no rule raises a typed `RuleNotFoundError` before any write, leaving the tree clean. A vitest drives an accepted `rule-retirement` (retire) and a second (relax) through the production gate and asserts: the rule is gone / demoted, the standards doc is regenerated to match, one commit carried both files, comments survived, and an unknown `target_rule_id` raises `RuleNotFoundError` with no mutation.
vitest: plugins/flow/mcp-server/src/tools/__tests__/apply-rule-retirement.test.ts

**AC5 — config, catalogue, errors, and registration are wired with the DomainError envelope (artifact):**

The promotion threshold and the M-window retirement horizon are configurable with documented defaults (not magic numbers buried in code). The `rule-retirement` handler is registered into `createProductionRegistry()` so `KIND_TO_STORY`'s `"Story 6.6"` pointer now resolves to a real handler; `RuleNotFoundError` is defined extending `DomainError`. The retro-analyst catalogue (`catalogue/retro-analyst.md`) is updated to instruct drafting promotion/retirement proposals strictly from the helper's computed candidates — it must not count fires itself.
artifact: plugins/flow/mcp-server/src/lib/proposal-apply-registry.ts

## Definition of Done

- [x] All five ACs met.
- [x] `pnpm --dir plugins/flow/mcp-server test` green; the two new test files cover every integration AC clause.
- [x] `pnpm --dir plugins/flow/mcp-server build` green; `dist/` rebuilt and staged in the same commit (CI fails on `src`/`dist` drift).
- [ ] PR opens against `main`. CI green.
- [ ] Reviewer cycle clean — AC1–AC4 are runnable vitest, AC5 is file-presence/registration; the reviewer's runnable-AC pass should be all-green.
- [x] The fire-count + candidate computation is a deterministic helper with hand-checkable numbers — the analyst consumes it, it does not re-derive counts in prose.
- [x] Retirement apply reuses `regenerate-standards` (no second projection implementation) and the comment-preserving registry write from 6.5.
- [x] Scope held: no change to the gate machinery (6.4), the `rule` apply path (6.5), or the standards projection (6.5b) beyond calling it. The cycle-window approximation is documented pending Story 6.12.

## Implementation Notes

### The deterministic helper (the load-bearing seam)

Per the project's deterministic-seam discipline, the load-bearing decision — *which* rules to propose or retire — must live in a tool/helper, not in the analyst's prose. Build a pure helper, e.g. `computeFailureClassFireCounts(inputs, config)`, that:

- rolls up `failure_class` occurrences from `doneManifests` (written by 6.1) and the window's telemetry events, returning a `Map<failure_class, { fireCount, registeredRuleIds: string[] }>`;
- derives **promotion candidates** (count ≥ `promotionThreshold` AND no registered rule for the class);
- derives **retirement candidates** (a registered rule whose class is silent for ≥ M windows), each carrying `target_rule_id`, `fire_count_over_window`, `recommended_action: retire | relax`.

The helper takes config `{ promotionThreshold, retirementWindows (M), relaxFloor }` with documented defaults (M=5 per the epic; pick and document the promotion threshold and the relax floor). The retro analyst receives the helper's output via the input bundle and drafts proposals from it; the analyst's catalogue is updated to forbid counting in prose. This keeps the calibration decision auditable and testable without an LLM in the assertion path (AC1–AC3 test the helper directly).

### The cycle-window approximation (pending Story 6.12)

The epic phrases retirement as "≥ M consecutive *cycles*," but cycle boundaries (6.12) do not exist yet. For v1, treat the available manifest/telemetry history as a single window and make M a window-count the helper can evaluate over the data it has (e.g. partition the window by a configurable span, or treat "no fire across the whole available history of length ≥ threshold" as the retirement signal). Make the windowing a seam so 6.12 can swap real cycle boundaries in without touching the candidate logic. Document the chosen approximation in the completion notes; the promotion path is unaffected (it is a within-window count).

### The `rule-retirement` apply handler (reuses 6.5 + 6.5b)

Implement `ProposalApplyHandler` for `type: "rule-retirement"` and register it into `createProductionRegistry()` alongside the `rule` handler:

- `previewDiff` — show the rule being removed or the `level` demotion, plus the resulting standards-doc change; **no write/commit**.
- `apply` — match `target_rule_id` in the registry (raise `RuleNotFoundError` if absent, before any write); for `retire` remove the rule, for `relax` set `level: "advisory"`; write the registry through the managed-fs guard (comment-preserving, reusing 6.5's seam); call `regenerate-standards` (6.5b) to rewrite `docs/standards.md`; return `{ changedPaths: ["docs/discipline-rules.yaml", "docs/standards.md"] }`. **No commit** — the gate commits. Reuse 6.5b's working-tree-atomic posture: if regeneration fails, restore the registry and re-raise so the gate commits nothing.

`recommended_action` comes off the proposal (the analyst set it from the helper's signal); the handler honours it rather than re-deciding.

### Files touched

**NEW:**
- `plugins/flow/mcp-server/src/lib/failure-class-fire-counts.ts` — the deterministic rollup + candidate helper.
- `plugins/flow/mcp-server/src/lib/apply-rule-retirement.ts` — the `rule-retirement` apply handler (or co-locate with the rule handler from 6.5).
- `plugins/flow/mcp-server/src/lib/__tests__/failure-class-fire-counts.test.ts` — AC1–AC3.
- `plugins/flow/mcp-server/src/tools/__tests__/apply-rule-retirement.test.ts` — AC4.

**UPDATE:**
- `plugins/flow/mcp-server/src/tools/gather-retro-inputs.ts` — surface the computed promotion/retirement candidates in the bundle (or expose the helper for the analyst to call).
- `plugins/flow/mcp-server/src/lib/proposal-apply-registry.ts` — register the `rule-retirement` handler in `createProductionRegistry()`.
- `plugins/flow/catalogue/retro-analyst.md` — instruct drafting proposals strictly from the helper's candidates; forbid in-prose counting.
- `plugins/flow/mcp-server/src/errors.ts` — add `RuleNotFoundError` extending `DomainError`.

### Existing seams to wire into (do not reinvent)

- **Retro inputs:** `gatherRetroInputs` / `RetroInputs` in `tools/gather-retro-inputs.ts` (done manifests, telemetry summary, prior proposals, rule registry).
- **Proposal shapes:** `RuleRetirementProposalSchema` (`target_rule_id`, `fire_count_over_window`, `recommended_action: retire | relax`) and `RuleProposalSchema` in `schemas/retro-proposal.ts`.
- **Registry + regenerate:** the 6.5 comment-preserving registry write seam and the 6.5b `regenerate-standards` library function — reuse both; do not re-implement projection or YAML handling.
- **Gate seam:** `ProposalApplyHandler` / `createProductionRegistry()` / `KIND_TO_STORY` in `lib/proposal-apply-registry.ts`.
- **Errors:** `DomainError` base; mirror an existing typed-error constructor.
- **Test conventions:** mirror `tools/__tests__/accept-proposal.test.ts` for the apply test (tmpRoot, injected git seam, telemetry assertion); a plain unit-test fixture for the pure helper.

### Edge cases worth surfacing in dev/review

- **A class with a rule AND a high fire count is NOT a promotion candidate** (a rule already guards it) — only unruled classes promote. Test it.
- **`relax` vs `retire`.** Zero fires → `retire`; non-zero-but-below-floor → `relax` (demote to advisory). Pin the floor and the boundary in tests.
- **Unknown `target_rule_id`.** A retirement proposal whose rule was already removed (e.g. applied twice across runs) must fail closed with `RuleNotFoundError` and no mutation — the gate's idempotency covers the same-id re-accept, but a stale proposal pointing at a since-removed rule is a distinct case.
- **Retirement that would empty the standards doc.** Removing the last rule would make `regenerate-standards` violate `.min(1)` criteria. Decide and document the behaviour (recommended: refuse the retirement with a clear error rather than write an invalid standards doc).
- **Comment survival on removal/demotion.** Removing or editing one rule must preserve the file's other comments (reuse 6.5's Document-API seam); assert it.

### Risk + build notes (drain context)

- This is a `medium`-risk change: it registers a second canonical-state mutation handler (retirement) and feeds the analyst's proposal generation. Expect the auto-merge gate to **pause for a human merge**.
- Code change touching lib + tool + catalogue + errors: rebuild and commit `dist/` in the same change; full `pnpm build` + `pnpm test` green from `plugins/flow/mcp-server` before the PR.
- Do not write any `.flow/state` manifest. Canonical surfaces written: `docs/discipline-rules.yaml` and `docs/standards.md` (both via the retirement handler reusing 6.5/6.5b seams).

### References

- Epic 6 file, Story 6.6 block.
- Stories 6.5 / 6.5b (the registry, apply handler, and regenerate function this builds on).
- Architecture: `_bmad-output/planning-artifacts/architecture/skill-calibration-loop.md` — the "Retirement criterion (symmetric to FR64a)" and "Pattern fire-count threshold" sections (the promotion/retirement symmetry and the configurable M-cycle horizon).
- PRD: FR64 (promotion threshold), FR64a (rule retirement with evidence).
- Story 6.12 (cycle boundaries) — the soft dependency the windowing seam anticipates.

## Dev Agent Record

### Completion Notes

Implemented all five ACs. Key decisions:

- **`computeFailureClassFireCounts`** (`src/lib/failure-class-fire-counts.ts`): Pure deterministic helper. Defaults: `promotionThreshold=3`, `retirementWindows=5`, `relaxFloor=1`. Zero fires → `retire`; [1, relaxFloor) → `relax`; ≥ relaxFloor (default: 1+) → not a retirement candidate. A class with an existing rule and high fire count is NOT a promotion candidate.

- **Windowing approximation** (pending 6.12): v1 treats all available manifest/telemetry history as a single window via the injectable `WindowingSeam` interface. `SINGLE_WINDOW_SEAM` is the default. Story 6.12 can inject real cycle-boundary partitioning without touching the candidate logic.

- **`makeRuleRetirementApplyHandler`** (`src/lib/apply-rule-retirement.ts`): Reuses `regenerateStandards` (6.5b) and the comment-preserving Document API (6.5). Guard order: `RuleNotFoundError` before any write; `RetirementWouldEmptyRegistryError` (retire-only) before any write. `relax` on the last rule is permitted.

- **`replaceRuleNode` comment preservation**: Updated to copy `commentBefore` from the old node to the new node, so human-authored YAML comments survive a relax/edit-in-place operation.

- **`gather-retro-inputs.ts`** extended with `fireCountSignal` (promotion + retirement candidates) computed from the deterministic helper when the registry is present.

- **`catalogue/retro-analyst.md`** updated with strict instructions to draft proposals ONLY from the helper's computed candidates.

- **`removeRuleNode`** added to `schemas/discipline-rules.ts` for the retire path.

- **`RuleNotFoundError`** and **`RetirementWouldEmptyRegistryError`** added to `errors.ts` extending `DomainError`.

- **Production registry**: `createProductionRegistry()` in `lib/proposal-apply-registry.ts` now registers `rule-retirement`.

Tests: 1882/1882 passing. Knip clean. Build green. dist/ rebuilt in same commit.

### File List

**New files:**
- `plugins/flow/mcp-server/src/lib/failure-class-fire-counts.ts`
- `plugins/flow/mcp-server/src/lib/apply-rule-retirement.ts`
- `plugins/flow/mcp-server/src/lib/__tests__/failure-class-fire-counts.test.ts`
- `plugins/flow/mcp-server/src/tools/__tests__/apply-rule-retirement.test.ts`

**Modified files:**
- `plugins/flow/mcp-server/src/errors.ts`
- `plugins/flow/mcp-server/src/schemas/discipline-rules.ts`
- `plugins/flow/mcp-server/src/lib/proposal-apply-registry.ts`
- `plugins/flow/mcp-server/src/tools/gather-retro-inputs.ts`
- `plugins/flow/catalogue/retro-analyst.md`
- `plugins/flow/mcp-server/tests/canonical-fs-guard.test.ts`
- `plugins/flow/mcp-server/dist/` (rebuilt)
- `_bmad-output/implementation-artifacts/6-6-promotion-threshold-and-rule-retirement.md`

### Change Log

- feat(6.6): fire-count helper + rule-retirement apply path (2026-06-01)
