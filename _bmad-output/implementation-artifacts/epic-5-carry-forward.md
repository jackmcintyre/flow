# Epic 5 — Carry-Forward Log

> A running list of named follow-ups surfaced during Epic 5 work but **not yet sized into stories**. Each entry says where to fold it in when the right Epic 5 story touches the same area. This log is the alternative to either (a) opening a chore PR per follow-up or (b) letting them rot in commit messages.
>
> **Rule for additions:** if you discover a follow-up that doesn't warrant its own story but shouldn't be lost, append an entry here with a target story or `unscheduled` if no obvious carrier exists. Don't bundle into a substrate ship without a deliberate plan — that's the 5.13-class fail-grade-contradiction trap.
>
> **Started:** 2026-05-27 (deep-kettle re-plan Phase 1, Artefact A3).

## Active entries

### 1. `scan-sources.ts` `readFile` warn-instead-of-throw

**Surface:** Story 5.13 review feedback (Low).
**Touch site:** `plugins/crew/mcp-server/src/tools/scan-sources.ts` — the `readFile` call in the to-do branch (around lines 579-590) currently lets errors propagate. Lower-severity recovery would be to warn and skip the manifest rather than abort the whole scan pass.
**Fold into:** next Epic 5 story touching `scan-sources.ts`. Story 5.16 is touching it (drift-on-refresh) but is deliberately scoped to drift only — do NOT bundle. Next candidate: Story 5.2 (heartbeat-based session liveness) does not touch this file; Story 5.1 doesn't either. **Unscheduled — likely first Epic 5 backlog story to land that touches `scan-sources.ts` outside drift work.**

### 2. `renderScanResult` leading-whitespace assertion

**Surface:** Story 5.13 review feedback (Info).
**Touch site:** `plugins/crew/mcp-server/src/tools/scan-sources.ts` (search for `renderScanResult`). Add a test-side assertion that rendered output lines have no leading whitespace (cosmetic guarantee for terminal output).
**Fold into:** next Epic 5 story that adds rendered output to the scan surface.
**Unscheduled.**

### 3. `skippedRefs` formatting consistency

**Surface:** Story 5.13 review feedback (Info).
**Touch site:** `scan-sources.ts` — `result.skippedRefs.push({...})` call sites (currently 3-4) format `detail` strings differently between branches. Pick one format (e.g. `kind: payload` vs `payload`) and apply uniformly.
**Fold into:** next Epic 5 story touching the `skippedRefs` push paths.
**Unscheduled.**

### 4. `.d.ts` Zod-determinism investigation (Folded into 5.24)

**Surface:** Tripped preflight 5× through 2026-05-27 (Story 5.12 ship; Phase E pre-promotion; deep-kettle Phase 1 start; `pre-dogfood-resumption-2`; `pre-dogfood-resumption-3`). The committed `plugins/crew/mcp-server/dist/*.d.ts` files showed pure key-ordering churn (`medium` / `low` swap inside Zod enum inference output) between local `tsc` rebuilds and the committed copy.
**Fold into:** Story 5.24 — post-build `.d.ts` normaliser (`plugins/crew/mcp-server/scripts/normalise-dist.mjs`) chained into `pnpm build` that sorts `ZodEnum<{...}>` member keys alphabetically; vitest regression in `tests/build-determinism.test.ts`. Strategy C from the spec — A (pin) wouldn't have helped (Zod was already lock-pinned; drift recurred across `pnpm install` regenerations), B (rewrite schemas) doesn't address inferred-union ordering inside cross-tool composed Zod types.

### 5. Reviewer `gh pr comment` PR-scope guard (originally "7a")

**Surface:** Deep-kettle plan deferral (originally from the pre-Epic-5 enhancement plan).
**Issue:** reviewer's `gh pr comment` calls don't currently constrain themselves to the PR under review; a bug could surface comments on adjacent PRs. Not observed in canary; guard would be belt-and-braces.
**Fold into:** Epic 5 backlog only if `/crew:start` on a real story (Phase 3) surfaces a defect; otherwise defer to Epic 6→7 boundary.
**Unscheduled.**

### 6. Standards-criterion cross-check in reviewer summary (originally "7b")

**Surface:** Deep-kettle plan deferral.
**Issue:** reviewer summary doesn't currently cross-check against the standards doc's criteria. Belt-and-braces; only relevant if auto-merge gate is re-enabled in scope.
**Fold into:** Epic 5 backlog only if auto-merge gate re-enable becomes scope.
**Unscheduled.**

### 7. Reviewer-contract change (carried debt — memory M2 captures rationale)

**Surface:** Deep-kettle plan, carried-debt decision 2026-05-27.
**Issue:** deterministic AC verification (reviewer LLM parses ACs for `artifact:` / `vitest:` markers, gates verdict on regex/grep-shaped checks) is structurally misaligned with content-trivial ACs — trailing-newline judgement on `hello.md`, blank-line removal on specs, locked-phrase grammar drift. Each fix accretes another convention. Meta-grammar tax that compounds for the non-engineer target user.
**Why deferred:** Epic 5 backlog is internal-API substrate where deterministic AC verification fits cleanly. Fragility becomes acute at Epic 7 (canary install, plain-language pass, first-run polish) where ACs describe end-user observation.
**Fold into:** dedicated planning round at Epic 6→Epic 7 boundary. Hard-required before Epic 7 ships.
**Do not** add new AC-marker conventions during Epic 5 to paper over this — capture each new instance here instead. See memory `feedback_reviewer_contract_carried_debt`.

### 8. Orphan-recovery missing reviewer-only branch (Folded into 5.20)

**Surface:** Canary-1 (bmad:5.19) Path B closeout, 2026-05-27. See memory `project_orphan_recovery_no_reviewer_only_branch`.
**Issue:** `/crew:start`'s orphan-recovery branch only handled the dev-incomplete + replay shape; when an orphan was found with dev already shipped (PR open and green) and only the reviewer side missing, the loop fell through to Path B manual closeout instead of respawning just the reviewer.
**Fold into:** Story 5.20 (shipped 2026-05-27, PR #166) — adds the reviewer-only respawn branch when manifest has a PR but no reviewer transcript.

### 9. Reviewer first-tool-call enforcement gap (Folded into 5.21)

**Surface:** Canary-1 (bmad:5.19) reviewer-skip incident, 2026-05-27. See memory `project_reviewer_first_call_enforcement_needed`.
**Issue:** the reviewer subagent reasoned around its persona prose mandate ("MUST call `runReviewerSession` first") and skipped the call under load. Manifest never progressed to verdict; operator forced into manual recovery. Persona prose alone is not load-bearing for orchestration enforcement — repeats the prose-mandate-vs-deterministic-seam pattern Jack flagged in `feedback_default_to_deterministic_seams` and `feedback_prose_mut_steps_need_seam`.
**Fold into:** Story 5.21 — either inject `runReviewerSession` from spawning orchestration OR fail-loud post-spawn if `agent_invokes` lacks the call. Persona prose stays as belt-and-braces.

### 10. `markStoryShipped` MCP tool for manual-merge closeout (stop-gap)

**Surface:** 2026-05-27 canary-1 (bmad:5.19) AND canary-2 (bmad:5.22) — both ended with Jack manually merging a BLOCKED PR (classifier carried debt, entry 7 / `feedback_reviewer_contract_carried_debt`) and hand-editing the manifest from `in-progress/` (or `blocked/`) to `done/`. Cleanup per closeout: write manifest to `done/`, delete from origin, strip `blocked_by` + `claimed_by`, flip `status` to `done`. Five+ commands each time.
**Touch site:** new MCP tool `markStoryShipped(ref: string)` in `plugins/crew/mcp-server/src/tools/`. Atomic write semantics; consumed by an operator-facing slash command (e.g. `/crew:mark-shipped <ref>`) or surfaced as a one-shot CLI helper.
**Why deferred to protected backlog:** if the classifier work (entry 7) lands first, this tool's surface disappears — the BLOCKED-on-merged-PR case stops happening because the classifier stops false-positiving. Authoring now risks wasted spec work.
**Fold into:** Story 5.23 (stub-only, protected backlog — see epic-5). Trigger condition: 3 more manual closeouts after 2026-05-27 (instances 1 and 2 already counted), OR classifier work slips past Epic 7 entry without resolution.

### 11. Structural / AST-style story parser (Folded into 5.18 stub)

**Surface:** Memory `project_current_blocker_story_parser` (parser brittleness as top blocker, pre-canary). Materialised as regex widening in 5.14 (vocabulary) and 5.17 (AC-heading shape) — both shipped. Carry-forward entry promotes the eventual structural refactor from informal tracking to story-shaped protected backlog.
**Touch site:** `plugins/crew/mcp-server/src/adapters/bmad/parse-bmad-story.ts` and `plugins/crew/mcp-server/src/adapters/native/parse-native-story.ts` — replace chain-of-regexes with markdown-AST extraction (remark/mdast or equivalent). Drop-in: same `parseSourceStory` interface and return shape.
**Why deferred to protected backlog:** current parser + 5.14 + 5.17 widening patches accommodate authored stories acceptably. Structural refactor is substantial (~1-2 weeks) and only pays off when a non-BMad adapter or external planner integration lands. Trigger condition in the story body gates authoring to that moment.
**Fold into:** Story 5.18 (stub-only, protected backlog — see epic-5).

### 12. Skip-and-flag parser resilience (refines entry 1)

**Surface:** 2026-05-28, `/crew:scan` blocked when authoring Epic 6 stories. The 5.18 protected-backlog stub has no `## Acceptance Criteria` section by design; the BMad adapter's `parseBmadStory` returns `acceptance_criteria: []`, which fails the SourceStory Zod's `.min(1)` at the boundary. **The first malformed story aborts the entire scan pass** — every other ready-for-dev story is starved of an execution manifest until the offender is fixed or hidden.
**Workaround applied:** flipped 5.18 `Status: backlog` → `Status: optional` so the adapter skips it (per `bmad/index.ts:235`). Smallest fix; protected-stub semantic preserved.
**Underlying signal:** the right behaviour is **skip-and-flag**: catch the per-file parse failure, surface it on the result (skippedRefs with reason `"malformed-source"` and detail), continue processing the rest of the queue. One bad spec shouldn't block 60+ valid ones. This is **scope-relevant to Story 5.18** when authored — the structural parser's resilience contract should be skip-per-file by default, abort-the-scan as an explicit opt-in (and even then, only on truly catastrophic states like an unreadable storiesRoot directory).
**Adjacency to entry 1:** entry 1 covers the `readFile` resilience path (file unreadable → skip-and-flag); this entry covers the `parseSourceStory` resilience path (file readable but malformed → skip-and-flag). Same shape, different failure mode. When 5.18 is eventually authored, fold both into its AC set.
**Fold into:** Story 5.18 (when triggered). Until then: noted here so the next `Status: backlog` stub doesn't repeat the surprise.

### 13. `runReviewerSession` artifact-check against PR branch (architectural defect)

**Surface:** 2026-05-28, bmad:5.24 re-roll under cleaned markers. After fixing the marker classifier (entry 7 partial-mitigation via spec authoring discipline), the reviewer's artifact-check then failed because the dev's new files (`scripts/normalise-dist.mjs`, `tests/build-determinism.test.ts`) exist only on the PR branch (`bmad-5-24-zod-determinism-dts-fix`), not on the orchestrator's local `dev` branch where `runReviewerSession` runs `fs.access(path.resolve(targetRepoRoot, artifactPath))`. Verdict returned NEEDS CHANGES on false-negative grounds.
**Why this was hidden before:** every previously-shipped story had backticked-marker ACs that fell through the classifier to `manual-check-required` → verdict BLOCKED → Jack override. The artifact-check filesystem path was **never successfully exercised** in production. Fixing the marker classifier exposes this gap on the next story.
**Touch site:** `plugins/crew/mcp-server/src/tools/run-reviewer-session.ts § runArtifactCheck`. The current `fs.access(path.resolve(targetRepoRoot, artifactPath))` assumes the dev's artifacts exist at `targetRepoRoot`. They don't — they live on the PR branch in a sibling worktree at `../crew-<ref>` (the dev's worktree, torn down after handoff).
**Right architecture:** before running artifact / vitest checks, fetch the PR head ref via `gh pr view <prNumber> --json headRefName,headRefOid`, then either (a) checkout that ref in a temporary worktree and use that path as the check root, or (b) use `git show <sha>:<path>` to verify file existence without checkout. Option (a) is more robust for vitest (which needs the source tree). Option (b) is faster for pure artifact-presence checks.
**Workaround applied to ship bmad:5.24:** manually merged the PR branch into local `dev` before re-running the reviewer (`git merge origin/bmad-5-24-zod-determinism-dts-fix --no-ff`), then pushed dev to close the PR. Operator override; not sustainable.
**Fold into:** new Epic 5 substrate story — author next session. Suggested title: "reviewer-session artifact-check against PR branch via gh-fetched worktree". Estimated scope: ~2-3 hours including tests + dist rebuild.

### 14. `runVitestCheck` workspace-aware cwd (architectural defect)

**Surface:** 2026-05-28, bmad:5.24 re-roll under cleaned markers AND post-merge to fix entry 13's filesystem gap. Reviewer's vitest check then failed because `runVitestCheck` invokes `pnpm vitest --run -t '<filter>'` with `cwd: targetRepoRoot` — but this repo is a pnpm workspace with **no root `package.json`**; the package owning vitest is `plugins/crew/mcp-server/`. Error: `ERR_PNPM_NO_PKG_MANIFEST`. Test never executes, status:fail, verdict: NEEDS CHANGES.
**Why this was hidden before:** same reason as entry 13 — vitest path was never reached because markers were never recognised. First exposed on 2026-05-28.
**Touch site:** `plugins/crew/mcp-server/src/tools/run-reviewer-session.ts § runVitestCheck`. Hardcoded `cwd: targetRepoRoot`.
**Right architecture:** locate the package containing the test file by walking up from the resolved test path until the nearest `package.json`; use that directory as `cwd`. Or use `pnpm --filter <package>` shaped invocation that finds the package by name. The runVitestCheck function only knows `testNameFilter`, not the file path — so the simpler fix is to scan for `package.json` files under `targetRepoRoot`, identify the one containing the test, and use that.
**Workaround applied:** none. 5.24 shipped via operator override of the BLOCKED-then-NEEDS-CHANGES verdict chain.
**Fold into:** new Epic 5 substrate story — author next session. Suggested title: "reviewer-vitest workspace-aware cwd resolution". Estimated scope: ~30-60 min including tests. Can land independently of entry 13 OR be bundled.

### 15. Calibration loop validation status (meta-observation)

**Surface:** 2026-05-28, bmad:5.24 re-roll. Cumulative finding across entries 7, 13, 14: the reviewer toolchain's verdict path has **three structural gaps** (marker classifier, artifact-fs, vitest-cwd) that combine to make a clean tool-driven READY-FOR-MERGE verdict **structurally impossible** on any code-changing story today. Every shipped story to date has reached `done/` via operator override of a BLOCKED verdict (proximate cause: marker classifier; root cause: cumulative gaps that compound). The "calibration loop returns clean READY-FOR-MERGE without human override" proof point doesn't exist in v1 of this codebase yet.
**Implication for proof-point story:** the eventual writeup must either (a) acknowledge that v1 ships via human override on every story, with substrate fixes promised in the next iteration, or (b) wait until entries 7+13+14 are addressed before claiming the loop closes cleanly. Option (b) is the honest framing for a clean v1 claim.
**Fold into:** sequencing decision for next planning round. Entries 13 + 14 should land before any further Epic 6 stories ship via /crew:start. Entry 7 (marker classifier) is partially mitigated by spec authoring discipline (the 6.1/6.2/6.3 specs already use clean markers); a permanent fix is its own substrate story.

### 16. `build:watch` doesn't chain the 5.24 normaliser (Folded into 5.28)

**Surface:** 2026-05-28, `/ship-story 5-27` preflight halted on dirty tree. `pnpm build:watch` (which CLAUDE.md tells operators to keep running for the dev loop) is defined as bare `tsc -p tsconfig.json --watch` — the normaliser chained into `pnpm build` by Story 5.24 (commit `ee3506d`) is **not** wired into the watcher. Every tsc recompile emits unnormalised `.d.ts`; working tree drifts continuously while build:watch is on. Observed 8 drifted `.d.ts` files (`catalogue`, `execution-manifest`, `gh-error-map`, `persona`, `risk-tiering-spec`, `telemetry-events`, `classify-risk-tier`, `run-auto-merge-gate`) matching the exact Zod enum-key reordering pattern 5.24 was designed to canonicalise.
**Why this was hidden before:** 5.24 was validated by CI (which runs `pnpm build`, normaliser-chained) and by Jack's manual `pnpm build` cycles. Nobody ran a clean `build:watch` against the post-5.24 `dev` tree and checked for drift — the AC set covered the one-shot path only.
**Workaround applied:** `git restore plugins/crew/mcp-server/dist/` + kill watchers before retrying preflight. Same as the pre-5.24 workaround; recurs every time `build:watch` runs.
**Fold into:** Story 5.28 — small wrapper script `scripts/watch-and-normalise.mjs` that spawns `tsc --watch`, parses tsc's "Found N errors. Watching for file changes." sentinel from stdout, and runs `normaliseDistTree` from the existing `scripts/normalise-dist.mjs` after each successful emit. Re-uses 5.24's export; no new deps. CI unaffected (still uses `pnpm build`).
**Scope discipline:** do NOT touch the `pnpm build` script (5.24's domain) or the normaliser itself (5.24's domain). The fix is additive — one new wrapper + one one-line edit to `package.json`'s `build:watch` script.

## Promotion history

> Phase 2 (`dev → main` ff-promotion) records appended here as they happen, per deep-kettle plan Artefact P2.

- **2026-05-27 — `pre-dogfood-resumption-2`** at HEAD `6f70f09` (ff-only from `dev`). Contents: 5.15 stub + ship (PR #160), 5.16 stub + ship (PR #161), D1/D2/A3 chore bundle, dist rebuild for D2. Ruleset 16642015 relax → ff-promote → restore cycle ran clean — no auto-mode classifier block on `git checkout main` (M1 narrowing held). `.d.ts` Zod-determinism drift reappeared on `dev` post-checkout (4th occurrence — entry 4 above is now eligible for promotion to story 5.17 per its "fourth time" trigger).
- **2026-05-27 — `pre-dogfood-resumption-3`** at HEAD `9d9007e` (ff-only from `dev`). Contents: 5.19 (PR #165 scan-sources readFile/parse resilience), 5.20 (PR #166 orphan-recovery reviewer-only respawn), 5.21 (PR #167 reviewer first-call deterministic seam), 5.22 (PR #168 renderScanResult leading-whitespace assertion), `docs/standards.md` authored, 5.23 stub (markStoryShipped protected backlog), planning chore commit (9d9007e). Ruleset 16642015 relax → ff-promote → restore cycle ran via a bash trap so the restore was guaranteed-on-exit; ran clean. Auto-mode classifier blocked the first attempt on option-text ambiguity ("I drive end-to-end via gh api" parsed as Jack-driven, not agent-driven); resolved by explicit re-authorization. `.d.ts` Zod-determinism drift reappeared on `dev` post-checkout (**5th occurrence** — entry 4's "fourth time" trigger is now well past; promote to a real Epic 5 substrate story or accept as ongoing cosmetic noise).
