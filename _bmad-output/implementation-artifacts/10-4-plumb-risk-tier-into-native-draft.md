# Story 10.4: Plumb `risk_tier` into the native draft

story_shape: substrate
Status: ready-for-dev

## Story

As the judge panel's "Considered" lens (and the Quality Lead who owns the risk-tiered bar),
I want a native story's `risk_tier` computed from its declared paths and **persisted** at scan time — not left to a fallback because no diff exists yet,
so that the Considered lens grades each draft at the correct low/medium/high bar (rubric §3.5) during judging, pre-build. Today the judge panel recomputes risk from `draft.changedPaths`, which is empty before a build — so author-time judging silently defaults to the fallback tier. This story makes `risk_tier` a first-class, persisted field from scan onward (the post-build reviewer stamp later refines it from the real diff).

## Dependencies

- **Depends on 10.2** (`cited_sources[]` — the author-time declared-path signal this story feeds to `classifyRiskTier`). Builds on the existing `classifyRiskTier` tool and the existing manifest `risk_tier`/`risk_tier_evidence` fields (no schema change needed — they already exist, optional).
- **Is a prerequisite for** trustworthy judging on native drafts (10.7's end-to-end proof relies on the Considered lens grading at the right tier).
- **Touches `scan-sources.ts` (manifest creation) and `judge-panel.ts` (read the persisted tier).** Does NOT touch the discipline validator. Build-safe vs the live Epic 6 drain (does not share the validator/standards surface).

## Acceptance Criteria

**AC1 — a scanned native story carries a meaningful, persisted risk_tier the Considered lens reads (integration):**

Drive `/crew:scan` then the judge panel on a temp native workspace. (a) A native story whose `cited_sources` include state-mutating paths (matching the high/medium rules in the risk-tiering spec) produces a `to-do/` manifest stamped with a non-fallback `risk_tier` (e.g. `high`/`medium`) and `risk_tier_evidence`; a story citing only low-risk paths is stamped `low`. (b) The judge panel reads that persisted `risk_tier` and the Considered lens applies the matching §3.5 bar (the existing judge-panel test that asserts "the Considered bar scales with risk tier" passes when the tier comes from the manifest, not a fresh empty-diff computation). Observable spine: a native draft is judged at a tier derived from its declared paths, persisted before any build.

vitest: plugins/crew/mcp-server/tests/scan-sources.test.ts

**AC2 — scan computes and stamps risk_tier from declared paths, additively and BMad-safe (unit):**

When creating a native `to-do/` manifest, `scanSources` calls `classifyRiskTier({ targetRepoRoot, pluginRoot, storyId: ref, changedPaths: <story.cited_sources>, commitMessages: [], diffSize: 0 })` (author-time mode — path-pattern matching with no diff) and stamps `risk_tier` + `risk_tier_evidence` on the manifest. A BMad/legacy story with no `cited_sources` is NOT stamped (`risk_tier` stays `undefined`) — no regression to BMad scanning.

vitest: plugins/crew/mcp-server/tests/scan-sources.test.ts

**AC3 — the judge panel prefers the persisted tier; legacy still recomputes (unit):**

`runJudgePanel` uses the manifest's persisted `risk_tier` when present (single source of truth), and falls back to the current compute-from-`draft.changedPaths` behavior only when it is absent (legacy/BMad). The Considered lens receives the persisted tier.

vitest: plugins/crew/mcp-server/src/tools/__tests__/judge-panel.test.ts

**AC4 — classifyRiskTier returns a real tier in author-time mode (unit):**

`classifyRiskTier` with declared `changedPaths`, `commitMessages: []`, `diffSize: 0` matches `path_patterns` rules and returns a meaningful tier (not just `fallback`) — confirming author-time classification is separable from a git diff. A path set matching a high-tier rule returns `high` with the matched rule id in evidence.

vitest: plugins/crew/mcp-server/src/tools/__tests__/classify-risk-tier.test.ts

## Definition of Done

- [ ] All four ACs met.
- [ ] `pnpm --dir plugins/crew/mcp-server test` green — full suite (scan + judge are load-bearing).
- [ ] `pnpm --dir plugins/crew/mcp-server build` green; `dist/` rebuilt.
- [ ] `pnpm knip` green.
- [ ] PR opens against `main`. CI green.
- [ ] Reviewer cycle clean.
- [ ] Additive/BMad-safe: no manifest-schema change (fields exist); BMad scan unaffected (no `cited_sources` → no stamp → existing fallback path).

## Implementation Notes

### Scope discipline — what this story does and does NOT build

**Builds:** author-time (scan-time) computation + persistence of `risk_tier`/`risk_tier_evidence` from the story's declared paths, and the judge panel preferring the persisted value.

**Does NOT build:**
- A new manifest field — `risk_tier` + `risk_tier_evidence` already exist (execution-manifest.ts L264-279, optional).
- A dedicated "touched paths" field — this story uses `cited_sources` as the author-time path signal (see Edge cases for why, and the future-refinement note). No new schema.
- Any change to the post-build reviewer stamp (`stampRiskTierOnManifest`) — that keeps refining the tier from the real diff after the build; this story only adds the earlier, author-time value.

### The seam (do not reinvent)

- **`classifyRiskTier`** (classify-risk-tier.ts L132) takes `changedPaths`/`commitMessages`/`diffSize` as first-class data — no git dependency. Author-time call: `changedPaths = story.cited_sources`, `commitMessages: []`, `diffSize: 0`. It loads the rule spec via `lookupRiskTieringSpec` (target-repo `docs/risk-tiering.md` → shipped default) — unchanged.
- **Manifest fields** `risk_tier` (`z.enum(["low","medium","high"]).optional()`) and `risk_tier_evidence` (L264-279) — write the classifier's `tier` and `{ matched_rule, paths, change_types, diff_size }` into them. Already in the schema; no migration.
- **Scan stamping** mirrors the post-build `stampRiskTierOnManifest` pattern (post-reviewer-comments.ts L142-179) — but at manifest *creation* in `scanSources`, not post-build. Reuse the evidence shape.
- **Judge read** — `runJudgePanel` (judge-panel.ts L331-342) currently calls `classifyRiskTier` itself; change it to prefer `manifest.risk_tier` when set, else keep the current call. The `JudgeRunner.riskTier` param + Considered-lens bar (judge-panel.ts L117-124, /crew:judge SKILL.md L32) are unchanged.

### Files touched

**UPDATE:**
- `plugins/crew/mcp-server/src/tools/scan-sources.ts` — on native `to-do/` manifest creation, compute + stamp `risk_tier`/`risk_tier_evidence` from `story.cited_sources` (gated to native/enriched stories with declared paths).
- `plugins/crew/mcp-server/src/tools/judge-panel.ts` (~L331-342) — prefer the persisted `risk_tier`; fall back to compute when absent.

(No schema change. No new files unless a shared "compute author-time risk" helper is cleaner than inlining in scan.)

### Edge cases worth surfacing in dev/review

- **`cited_sources` (read) ≠ files touched (written).** classifyRiskTier was designed for the post-build *changed* paths. At author time the best available signal is `cited_sources` (the blast radius the author read), which approximates risk. This is deliberate and bounded: the Considered lens only *selects a bar*, and the Quality Lead can override; the reviewer's post-build stamp later corrects the tier from the real diff. A dedicated structured `touched_paths[]` field is a possible future refinement — explicitly out of scope here (would be its own small story).
- **Fallback is still correct when there's nothing to go on.** A native story with empty/low-signal `cited_sources` lands at the spec's `fallback_tier` (medium) — same as today, just now persisted.
- **Don't double-classify.** Once scan stamps the tier, the judge must not silently recompute over the empty author-time diff (that would re-introduce the fallback bug). Prefer-persisted (AC3) is the fix.
- **BMad non-regression:** the stamp is gated to native stories with `cited_sources`; BMad scans are untouched and the judge's existing compute path still serves them until cutover.

### Risk + build notes (drain context)

- **Risk tier: medium.** Touches scan (manifest creation) and judge wiring; additive (no schema change), default-safe (absent tier → existing fallback). Full-suite-green is the ship gate.
- **Build/verify:** `pnpm --dir plugins/crew/mcp-server test` + `build` + `pnpm knip`, all green. Deterministic.
- **Build-safe vs the live Epic 6 drain** — does not touch the discipline validator / standards surface.

### References

- [Source: _bmad-output/planning-artifacts/native-refoundation-plan-2026-05-31.md §3] — "risk_tier carried from classifyRiskTier so the Considered lens applies the right bar — plumb into the draft, not just post-review."
- [Source: _bmad-output/planning-artifacts/rubric-story-quality-2026-05-31.md §3.5] — the Considered lens's risk-tiered bar (low / medium-high / highest).
- [Source: plugins/crew/mcp-server/src/tools/classify-risk-tier.ts L132-198] — the classifier (separable path-matching; rule-spec lookup; fallback tier).
- [Source: plugins/crew/mcp-server/src/schemas/execution-manifest.ts L264-279] — existing `risk_tier`/`risk_tier_evidence` manifest fields.
- [Source: plugins/crew/mcp-server/src/tools/judge-panel.ts L331-342, L117-124] — where the panel classifies + passes `riskTier` to the Considered lens.
- [Source: plugins/crew/mcp-server/src/tools/post-reviewer-comments.ts L142-179] — the post-build `stampRiskTierOnManifest` pattern to mirror (at scan instead of post-build).
- [Source: _bmad-output/implementation-artifacts/10-2-native-tasks-ac-refs-cited-sources-and-narrative.md] — `cited_sources`, the author-time path signal this story consumes.
