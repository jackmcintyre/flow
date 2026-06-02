# Epic 5: Orchestration & Recovery — Visibility and Resilience

A user leaves the dev loop running and trusts nothing fails silently. Stuck / stale / blocked / source-drift / routing-failure surface as one-line lines; sessions recover from death.

## Story 5.1: `block-story` MCP tool and `blocked_by` taxonomy

As a plugin maintainer,
I want a `block-story` MCP tool that atomically moves a manifest to `blocked/` with a typed `blocked_by` reason,
So that downstream surfaces (orchestration, retros) can route by reason.

**Acceptance Criteria:**

**Given** a story in `in-progress/`,
**When** `block-story(ref, blocked_by)` is called,
**Then** the manifest is atomically moved to `blocked/` with `blocked_by` set to one of `source-drift | planning-discipline | routing-failure | gh-defer | gh-retry | gh-needs-human | dep-not-built | reviewer-grammar-error | user`. _(FR20)_

**Given** a story blocked,
**When** the dev session picks the next available story,
**Then** it claims from `to-do/` without waiting for the blocker to resolve. _(FR21)_

**AC3 (integration):** vitest covers all `blocked_by` reasons and asserts dev keeps picking.

## Story 5.2: Heartbeat-based session liveness

As a plugin maintainer,
I want each session to write a heartbeat file at a configurable interval and stale-claim detection to use `2× interval` as its threshold,
So that orchestration can distinguish a session that died from a session that's working.

**Acceptance Criteria:**

**Given** any session (planning, dev, orchestration),
**When** it starts,
**Then** it writes `<target-repo>/.flow/sessions/<session-id>.json` and refreshes it every N seconds (default 30, configurable).

**Given** a session writing heartbeats, **When** the process exits cleanly, **Then** the heartbeat file is removed; on crash it remains stale.

**Given** a `claimed_by` referencing a session whose heartbeat is older than `2× interval` (or missing), **When** the stale-claim helper inspects, **Then** the claim is reported as stale. _(FR51)_

**AC4 (integration):** vitest covers heartbeat write/refresh/clean-exit/stale-detection across simulated session lifecycles.

## Story 5.3: `/watch` skill and orchestration polling loop

As a plugin operator,
I want `/<plugin>:watch` to run an orchestration session that polls `in-progress/` and `blocked/` on a configurable interval,
So that I see what needs my attention without breaking the dev loop.

**Acceptance Criteria:**

**Given** a target repo,
**When** I run `/<plugin>:watch`,
**Then** the orchestration session boots and polls `in-progress/` and `blocked/` every N seconds (default 120, configurable). _(FR16, FR49)_

**Given** the orchestration loop, **When** a polling pass runs, **Then** it completes within 30 seconds under normal load (NFR4 target). _(NFR4)_

**Given** the orchestration session, **When** it inspects the dev loop's state, **Then** it can only read manifests + heartbeats + telemetry; it cannot mutate dev-loop state directly (except moving a user-resolved blocker back to `to-do/`). _(FR54)_

**AC4 (integration):** vitest runs orchestration against a fixture with 5 stories in mixed states and asserts the loop reads but never writes to `in-progress/`.

## Story 5.4: Stuck-story and stale-claim detection

As a plugin operator,
I want orchestration to detect stories whose dev subagent has stalled and stories whose claims are orphaned,
So that I notice work that needs unblocking without polling files myself.

**Acceptance Criteria:**

**Given** a story in `in-progress/` whose `agent.invoke` (for the current claim) shows wall-clock beyond the per-story dev budget,
**When** orchestration polls,
**Then** the story is surfaced as `[stuck] <ref> — dev subagent exceeded budget (<elapsed> min)`. _(FR50, NFR3)_

**Given** a story whose `claimed_by` references a stale session (per Story 5.2),
**When** orchestration polls,
**Then** the story is surfaced as `[stale-claim] <ref> — session <session-id> not alive`. _(FR51)_

**AC3 (integration):** vitest seeds fixtures for each condition and asserts the surface lines.

## Story 5.4b: Paused-for-human surface

As a plugin operator,
I want orchestration to surface PRs awaiting human action after a configurable threshold,
So that paused PRs don't sit invisibly in `in-progress/` while I assume the loop is still running.

**Acceptance Criteria:**

**Given** a story in `in-progress/` whose PR carries the `needs-human` label,
**When** orchestration polls and the PR has had no state change (no new comment, no label change, no review) for ≥ `plugin.paused_for_human_threshold_hours` (default 4, configurable),
**Then** the story is surfaced as `[paused-for-human] <ref> — awaiting your action since <ts>`.

**Given** a paused PR the user has just commented on or merged,
**When** orchestration polls,
**Then** the surface line disappears (PR state change is the silence-breaker).

**Given** the surface taxonomy,
**When** I look at Story 5.5's stable prefix tags,
**Then** `[paused-for-human]` is included alongside `[blocked] / [stuck] / [stale-claim] / [source-drift] / [routing-failure]`.

**AC4 (integration):** vitest seeds a `needs-human`-labelled PR with a timestamp beyond threshold and asserts the surface line appears; advances PR state and asserts the line disappears on next poll.

## Story 5.5: One-line terminal surface and user-resolved blocker move-back

As a plugin operator,
I want orchestration to print one line per surfaced item and to move a story back to `to-do/` once I've cleared the blocker,
So that I can resolve a backlog of blockers in a single sitting.

**Acceptance Criteria:**

**Given** blockers, stuck stories, stale claims, source-drift cases, and routing-failures,
**When** orchestration produces its surface,
**Then** each item is rendered as exactly one terminal line with a stable prefix tag (`[blocked]`, `[stuck]`, `[stale-claim]`, `[source-drift]`, `[routing-failure]`). _(FR52)_

**Given** a user-edited manifest in `blocked/` where `blocked_by` has been cleared, **When** orchestration polls, **Then** the manifest is atomically moved back to `to-do/`. _(FR53)_

**AC3 (integration):** vitest seeds three blocked stories with different `blocked_by` values, clears two, runs one orchestration pass, and asserts move-back behaviour.

## Story 5.6: Fault-injection vitest harness and session-death recovery

As a plugin maintainer,
I want fault-injection tests that kill sessions at three checkpoints and assert clean re-launch with no state corruption,
So that NFR7's measurement contract is enforced in CI.

**Acceptance Criteria:**

**Given** the vitest fault-injection harness, **When** it kills a session mid-claim (after manifest move, before claim record), **Then** re-launching the dev skill detects the orphaned claim, recovers, and produces no duplicate PR or duplicate verdict. _(NFR7 checkpoint 1)_

**Given** the harness, **When** it kills a session mid-dev (after dev subagent spawn, before handoff), **Then** re-launch resumes from filesystem state with no story observed in two state directories simultaneously. _(NFR7 checkpoint 2, NFR9)_

**Given** the harness, **When** it kills a session post-handoff-pre-review, **Then** re-launch resumes the reviewer step without re-running the dev subagent. _(NFR7 checkpoint 3)_

**Given** any fault injection on dev or reviewer, **When** the failure occurs, **Then** the story's state directory is unchanged from the pre-fault snapshot OR the story is in exactly one of `to-do/`, `in-progress/`, `blocked/`, `done/` — never observed as done-then-failed or failed-then-done. _(NFR9)_

**AC5 (integration):** the harness above runs in CI and gates merges.

## Story 5.7: Back-to-back idempotency integration test

As a plugin maintainer,
I want every `/<plugin>:*` skill exercised twice back-to-back from the same workspace state,
So that NFR10's idempotency measurement contract is enforced in CI.

**Acceptance Criteria:**

**Given** any skill in the plugin's `skills/` directory,
**When** the integration test invokes the skill twice back-to-back from the same fixture state,
**Then** (a) no new story manifests are created on the second run, (b) no new PRs or duplicate comments are posted, (c) no persona file gains a duplicate Knowledge entry, (d) the second run's terminal output explicitly states the no-op or resume condition. _(NFR10)_

**AC2 (integration):** the test above runs in CI for every skill and gates merges.

## Story 5.8: No-silent-failures CI pairing assertion

As a plugin maintainer,
I want CI to fail when any JSONL invocation entry lacks a paired artifact at its declared sink,
So that NFR6's measurement contract is enforced and silent failures are structurally prevented.

**Acceptance Criteria:**

**Given** the JSONL telemetry log and the declared sink for each event type (PR comment, story frontmatter field, orchestration surface line, or `failure-log/` entry),
**When** the pairing assertion runs in CI,
**Then** every recorded invocation has a paired artifact OR a recorded failure event explaining why no artifact was produced. _(NFR6)_

**Given** an agent invocation that produces no artifact and no failure event,
**When** the assertion runs,
**Then** CI fails with the offending event id and the missing sink.

**Given** the catch-all failure path,
**When** an agent crashes without producing a verdict/blocker/surface,
**Then** a `failure-log/<ts>-<ref>.md` entry is written with stack trace + diagnostic context.

**AC4 (integration):** vitest covers the three branches (artifact present / artifact absent → CI fails / failure-log catches uncaught crash).

## Story 5.9: Telemetry-as-files and session-death recovery guide

As a plugin operator,
I want all telemetry readable as local files and a one-page guide for when a session dies,
So that I can debug and recover without consulting a remote service or running diagnostics.

**Acceptance Criteria:**

**Given** the telemetry directory, **When** I open any file with a text editor, **Then** I can read the events as plain JSONL lines without needing the plugin running. _(FR70)_

**Given** the README, **When** I navigate to the "what to do if a session dies" page, **Then** it tells me (a) check `<target-repo>/.flow/sessions/` for stale heartbeats, (b) re-run the launching skill, (c) inspect the latest `failure-log/` entry if anything's amiss; the page fits on one screen. _(FR75)_

## Story 5.10: Persist dev transcript to disk before any MCP call

> Added 2026-05-25 as post-mortem follow-up from the dogfood rollback.
> Source: `_bmad-output/postmortems/2026-05-25-dogfood-rollback.md` § L1 (defect #3).

As a plugin maintainer,
I want the dev subagent's final message captured to a durable on-disk artefact the instant the subagent returns — before `processDevTranscript` or any other MCP call runs,
So that an MCP reap mid-cycle does not lose the transcript that carries the handoff phrase and PR URL.

**Acceptance Criteria:**

**Given** a `/flow:start` outer loop with a dev subagent that has just returned,
**When** the parent receives the subagent's final message,
**Then** the raw transcript is written to `<target-repo>/.flow/state/transcripts/<session-ulid>.txt` (or equivalent durable path) **before** any MCP tool call is attempted.

**Given** a transcript on disk, **When** MCP is later restarted (e.g. via `/reload-plugins` or a fresh Claude Code session), **Then** the transcript remains readable from the same path with the same content.

**Given** a dev subagent that returned but whose `processDevTranscript` call failed (MCP disconnect, crash, or any error), **When** the operator inspects the workspace, **Then** the persisted transcript is locatable by session ULID alongside the still-in-progress manifest.

**AC4 (integration):** vitest covers (a) transcript write happens before the tool-call attempt, (b) transcript survives a simulated MCP restart, (c) write is atomic (no partial files on crash).

## Story 5.11: Orphan-recovery branch in `/flow:start`

> Added 2026-05-25 as post-mortem follow-up from the dogfood rollback.
> Source: `_bmad-output/postmortems/2026-05-25-dogfood-rollback.md` § L1 (defect #2).
> Depends on Story 5.10.

As a plugin operator,
I want `/flow:start` to detect an orphaned in-progress manifest (one whose `claimed_by` references a session that's no longer alive) and offer to replay its persisted transcript instead of silently moving on to the next claimable story,
So that a mid-cycle MCP reap does not strand a real PR in `in-progress/` with no path to verdict.

**Acceptance Criteria:**

**Given** an in-progress manifest whose `claimed_by` session ULID is not the current session's ULID (and whose heartbeat — per Story 5.2 — is stale or absent),
**When** the outer loop of `/flow:start` begins a new claim cycle,
**Then** the loop surfaces the orphan with a one-line `[orphan] <ref> — claimed_by <stale-ulid>` and asks the operator whether to reattach or skip.

**Given** the operator chooses to reattach **AND** a persisted transcript from Story 5.10 exists for the stale session ULID,
**When** the loop proceeds,
**Then** it replays `processDevTranscript` from the persisted transcript and resumes the inner cycle from the handoff step (reviewer spawn) — not from the dev step.

**Given** the operator chooses to reattach **AND** no persisted transcript exists,
**When** the loop proceeds,
**Then** it routes the manifest to `blocked/` with `blocked_by: orphan-no-transcript` rather than silently dropping the work.

**Given** the operator chooses to skip,
**When** the loop proceeds,
**Then** the orphan is left in `in-progress/` (operator's responsibility) and the loop alphabetically picks the next claimable story.

**AC5 (integration):** vitest seeds an orphaned manifest with and without a persisted transcript and asserts (a) reattach-with-transcript replays the reviewer step exactly once, (b) reattach-without-transcript moves to `blocked/` with the typed reason, (c) skip preserves orphan state.

## Story 5.12: MCP child resilient to parent stdin-close (or confirm host-side knob)

> Added 2026-05-25 as post-mortem follow-up from the dogfood rollback.
> Source: `_bmad-output/postmortems/2026-05-25-dogfood-rollback.md` § L1 (defect #1).
> Independent of 5.10 / 5.11.

As a plugin maintainer,
I want the flow MCP server child to survive Claude Code's parent stdin-close, OR — if that's structurally a host responsibility — confirmation that the host's idle-reap threshold is operator-configurable,
So that long subagent runs (>10 min) do not trigger an MCP reap mid-cycle.

**Acceptance Criteria:**

**Given** the flow MCP server running as a stdio child of Claude Code, **When** the parent closes the child's stdin after an idle threshold (~10 min observed on 2026-05-25), **Then** at least one of:

- (a) **client-side fix:** the MCP server child remains alive and responsive to new tool calls after stdin close, OR
- (b) **host-side knob:** documented confirmation (linked from `plugins/flow/docs/`) that the host's idle threshold is configurable in `~/.claude/settings.json` and a recommended setting for crew users is published, OR
- (c) **escalation artefact:** a written request to Anthropic with the reproduction (diag log from 2026-05-25 + minimal SDK repro) and a tracked response.

**Given** the chosen path (a/b/c), **When** an operator runs `/flow:start` with a single subagent that takes 15+ min, **Then** the MCP server is still responsive on subagent return and `processDevTranscript` succeeds without `/reload-plugins`.

**AC3 (integration):** if path (a) was taken, vitest covers an idle-survival test (kill parent stdin, assert server still answers a follow-up tool call). If path (b) or (c) was taken, the documented artefact is committed under `plugins/flow/docs/` and linked from the resilience guide (Story 5.9).

**Note:** path (a) is preferred for durability. Paths (b)/(c) are acceptable fallbacks if Anthropic's host architecture makes (a) impossible. The diagnostic instrumentation that produced today's evidence is captured in the postmortem § L7 follow-up #5.

## Story 5.13: Planner-validator — prose vs manifest deps at scan time (+ typed `blocked_by`)

> Added 2026-05-27 from the pre-Epic-5 enhancement plan.
> Source: postmortem § L4 + Epic 4 retro § Carry-forward remediation (typed `blocked_by`).
> Independent of 5.10 / 5.11 / 5.12. Closes the last functional pre-dogfood gap.

As a plugin operator,
I want `/flow:scan` to refuse to write a `to-do/` manifest whose `depends_on` set drifts from the dependencies declared in the spec's prose, AND I want `blocked_by` reasons to be a typed enum rather than a free-string sink,
So that planner-author mistakes are caught before claim time and `blocked/` manifests can be programmatically routed instead of inscrutably re-surfaced to the operator.

**Acceptance Criteria:**

**AC1:** `scanSources` extracts dep references from the spec body (well-defined patterns: explicit `Depends on:` lines, `[[story-key]]` cross-references, etc. — exact patterns TBD by spec author). When the extracted set drifts from the manifest's `depends_on`, the scan refuses to write and surfaces `[deps-drift] <ref> — prose: {...}, manifest: {...}` on stderr.

**AC2:** `blocked_by` is a typed enum, not a free string. Initial members: `handoff-grammar | deps-drift | quota-exhausted | worktree-leak | reviewer-verdict-needs-changes | reviewer-verdict-blocked | reviewer-no-session-result | gh-defer | gh-needs-human | orphan-no-transcript` (the last entry rides on 5.11's existing `blockOrphanNoTranscript` path). Zod-enforced at the boundary; existing writes migrate to typed values.

**AC3:** `/flow:start`'s blocked-recovery surface (per memory `project_blocked_recovery_prose_lies`) uses the typed reason to render a per-case operator hint, not the current generic "clear blocked_by and re-run" prose.

**AC4 (integration):** vitest covers (a) a synthetic spec whose prose declares a dep the manifest omits → scan refuses with `[deps-drift]`; (b) a `blocked_by` write with an unknown enum value → Zod rejects at the boundary; (c) `/flow:start` surfaces the typed-reason hint for each enum member.

**AC5 (integration):** existing `blocked/` fixtures in tests are migrated to typed values; no test references a free-string `blocked_by`.

---

## Story 5.15: Fix `gh pr view --json baseRepository` non-field in 3 reviewer/auto-merge tools

> Added 2026-05-27 from the first dogfood canary against `jackmcintyre/scratch` (PR #1).
> Source: canary halt at `/flow:start` reviewer step. Diagnosis in `/tmp/handoff-2026-05-27-canary-baseRepository-fix.md`.
> Blocks dogfood resumption. Substrate.

As a plugin operator,
I want `/flow:start`'s reviewer and auto-merge tools to query a valid `gh` field for the base repo identity,
So that the reviewer step doesn't halt every story with `Unknown JSON field: "baseRepository"`.

**Background:** Three tools call `gh pr view <n> --json baseRepository`, but `baseRepository` is not a real `gh pr view` JSON field (confirmed against gh 2.92.0; real fields include `baseRefName, baseRefOid, headRepository, headRepositoryOwner, isCrossRepository`). Tests pass because `run-auto-merge-gate.test.ts:54` mocks a synthetic `baseRepository: { name, owner: { login } }` shape that never gets validated against the real `gh` schema — classic stub-vs-real gap. Every canary `/flow:start` halts the inner cycle at `apply-reviewer-labels` and `postReviewerComments`.

**Acceptance Criteria:**

**AC1:** All three call sites stop referencing `baseRepository` from `gh pr view --json`. Replacement source for the base-repo `{owner, name}` is `gh repo view --json owner,name` (the base repo for a PR opened against the current repo IS the current repo). Spec author MAY pick `git config --get remote.origin.url` parsing instead if it's strictly simpler; pick one and apply uniformly. `artifact: plugins/flow/mcp-server/src/tools/post-reviewer-comments.ts, plugins/flow/mcp-server/src/tools/apply-reviewer-labels.ts, plugins/flow/mcp-server/src/tools/run-auto-merge-gate.ts`

**AC2:** A real-gh integration test exercises the new code path against actual `gh repo view --json owner,name` output, skipped (not failed) when `gh` is unavailable on the host. The test asserts that the returned shape matches what the three tools consume. `vitest: plugins/flow/mcp-server/src/tools/__tests__/gh-base-repo.integration.test.ts`

**AC3:** A cheap guard test fails if any file under `plugins/flow/mcp-server/src/` contains the string `baseRepository` in a `gh pr view --json` context (grep-based; assertion text names the offending file:line). Prevents regression. `vitest: plugins/flow/mcp-server/src/tools/__tests__/no-base-repository-field.test.ts`

**AC4:** The existing mock in `run-auto-merge-gate.test.ts:54` is updated to match the new real shape (or removed if no longer needed). Other affected tests are migrated in the same change. `vitest: plugins/flow/mcp-server/src/tools/__tests__/run-auto-merge-gate.test.ts`

**AC5 (manual canary):** After merge, re-running `/flow:start` against scratch repo `jackmcintyre/scratch` (orphan in-progress manifest preserved from today's canary) advances past the reviewer step without the `Unknown JSON field` halt. Documented in retro notes; not a CI gate.

---

## Story 5.16: `scan-sources` deps-drift on source-hash refresh (to-do branch)

> Added 2026-05-27 from the deep-kettle re-plan (drain follow-ups before re-promoting `dev → main`).
> Source: review of `scan-sources.ts` after Story 5.13 shipped — the to-do source-hash refresh branch (lines 577-615) rewrites the manifest on source change without calling `checkDepsDrift`, bypassing the gate that Story 5.13 added at lines 404 (blocked-branch) and 496 (currentState === null). Drift introduced by an operator edit after first scan is silently absorbed.
> Substrate; narrowed to 2 ACs to avoid the fail-grade contradiction risk Story 5.13 hit at first pass.

As a plugin operator,
I want `/flow:scan` to refuse to overwrite a `to-do/` manifest when the refreshed source body's prose deps drift from the manifest's `depends_on`,
So that planner-author drift introduced after the first scan is caught with the same `[deps-drift]` signal as drift introduced at first scan or in `blocked/`.

**Background:** Story 5.13 added `checkDepsDrift` and wired it into two branches: line 404 (blocked-branch source-hash change) and line 496 (`currentState === null`, fresh write). The to-do refresh branch at lines 592-610 — entered when an existing `to-do/` manifest has a stale `source_hash` — calls `writeManagedFile` directly without the drift gate. This is the third branch and it leaks. Symmetry is the fix.

**Acceptance Criteria:**

**AC1:** The to-do source-hash refresh branch in `scan-sources.ts` (currently lines 592-610) calls `checkDepsDrift(story)` before rewriting the manifest. When `driftDetail !== null`, the branch follows the same shape as line 404's blocked-branch path: write a `blocked/` manifest via `writeDepsDriftBlockedManifest`, push to `result.skippedRefs` with reason `discipline-violation` + detail `deps-drift-prose-vs-manifest: ...`, push to `result.blockedRefs` and `result.depsDriftRefs`, then `continue` (do NOT rewrite the to-do manifest). Refusal text matches the other two branches verbatim. `artifact: plugins/flow/mcp-server/src/tools/scan-sources.ts`

**AC2 (integration):** vitest covers the new branch end-to-end: seed a `to-do/` manifest whose `depends_on` matches the original spec; edit the spec on disk to introduce a prose dep the manifest omits (changing `source_hash`); run `scanSources`; assert (a) the to-do manifest is NOT overwritten — original hash and depends_on preserved, (b) a `blocked/` manifest is written with `blocked_by: deps-drift` and the typed `depsDriftRefs` entry surfaces, (c) a complementary case where the spec is edited without introducing drift still updates the to-do manifest's hash normally (idempotency control). `vitest: plugins/flow/mcp-server/src/tools/__tests__/scan-sources-drift-on-refresh.test.ts`

---

## Story 5.14: BMad-parser vocabulary widening (`draft`, `approved`, `review`)

> Added 2026-05-27 after Phase 0 of the `cosmic-forging-spark` plan surfaced the actual root cause: scan-failure on `Status: review` (20 of 60 specs). Diagnosis in `_bmad-output/postmortems/2026-05-27-parser-brittleness-diagnosis.md` (local-only). Supersedes the `planner-template-clamp` scope proposed in the reframe doc — the planner template is the wrong file.
> Substrate; 2 ACs.

As a plugin operator,
I want `/flow:scan` to recognise the BMad lifecycle states `draft`, `approved`, and `review` instead of throwing `MalformedBmadStoryError`,
So that the existing 60-spec corpus in `_bmad-output/implementation-artifacts/` scans clean and Phase 2 of the dogfood plan can start.

**Background:** `parse-bmad-story.ts`'s `isKnownBmadStatus` (lines 165-174) and `map-bmad-status.ts`'s `BmadStatus` type accept six values (`backlog | ready-for-dev | in-progress | done | optional | contexted`). The BMad-side lifecycle that the installed `bmad-create-story` + ship-story flow advances through emits additional states — most notably `review`, which appears on 20 of 60 spec files in this repo. The first alphabetical scan target hits one of those and the whole scan dies. The fix is mechanical: widen the enum + add execution-state mappings + tests. The deeper "`sprint-status.yaml` is canonically authoritative for execution state" question is structural-parser-shaped and stays in Story 5.18.

**Acceptance Criteria:**

**AC1:** `BmadStatus` (in `plugins/flow/mcp-server/src/adapters/bmad/map-bmad-status.ts`) and the mirror `isKnownBmadStatus` (in `plugins/flow/mcp-server/src/adapters/bmad/parse-bmad-story.ts:165-174`) both accept `draft`, `approved`, `review` in addition to today's six values. `mapBmadStatusToExecution` maps `draft → "to-do"`, `approved → "to-do"`, `review → "in-progress"`. The lifecycle table in `plugins/flow/docs/spikes/bmad-format.md` is updated to match. Unit tests cover the new values in both directions (parser accepts; `mapBmadStatusToExecution` returns the expected execution state). `reconcileStatus` is unaffected (its default branch already routes via the mapping it just received). `artifact: plugins/flow/mcp-server/src/adapters/bmad/map-bmad-status.ts`

**AC2 (integration):** vitest runs `parseBmadStory` over every `.md` file in `_bmad-output/implementation-artifacts/` (using the real repo path as the fixture root via a `path.resolve(__dirname, ...)` walk), asserts zero `MalformedBmadStoryError` throws, and asserts every result's `raw_frontmatter.status` round-trips the on-disk literal. **Precondition baked into the same commit:** `4-3c-call-completestory-after-ready-for-merge.md`'s `Status: revised — re-implement per new architectural direction (tool-layer seam)` is normalised to `Status: done` (the spec is marked `done` in `sprint-status.yaml`). The free-text grammar is explicitly NOT accepted — `revised — ...` remains a `MalformedBmadStoryError` by design. `vitest: plugins/flow/mcp-server/src/adapters/bmad/__tests__/parse-bmad-story-corpus.integration.test.ts`

---

## Story 5.19: `scan-sources` `readFile` resilience — warn-instead-of-throw on malformed manifest read

> Added 2026-05-27 as Phase 2 canary-1 of the `cosmic-forging-spark` plan.
> Source: `epic-5-carry-forward.md` entry 1. The to-do branch's `readFile` call currently throws on any per-file error, aborting the whole scan pass. Lower-severity recovery: warn and skip the single manifest.
> Substrate; 2 ACs.

As a plugin operator,
I want `/flow:scan` to skip a single malformed/unreadable manifest with a warning rather than abort the whole scan,
So that one bad spec doesn't block scanning the other 59.

**Acceptance Criteria:**

**AC1:** The to-do branch's `readFile` call site in `scan-sources.ts` (currently around lines 579-590, per `epic-5-carry-forward.md` entry 1) wraps the read in `try/catch`. On error, push to `result.skippedRefs` with reason `"unreadable-manifest"` and detail `"<errno>: <path>"`, then `continue`. The scan completes; the other manifests are processed normally. Refusal text matches the existing `skippedRefs` convention. `artifact: plugins/flow/mcp-server/src/tools/scan-sources.ts`

**AC2 (integration):** vitest seeds a fixture with 3 valid manifests + 1 deliberately-malformed-yaml manifest under `to-do/`, runs `scanSources`, asserts (a) the 3 valid manifests scan clean, (b) the bad one appears in `result.skippedRefs` with reason `"unreadable-manifest"` and a non-empty `detail` field, (c) `scanSources` returns without throwing at the boundary (the per-file error is contained). `vitest: plugins/flow/mcp-server/src/tools/__tests__/scan-sources-readfile-resilience.test.ts`

---

## Story 5.17: BMad-parser AC-heading regex widening (descriptive `**AC<n> — <title>:**` shape)

> Added 2026-05-27 as Phase 2 substrate-fix-loop iteration #1 — `/flow:scan` halted on `1-1-scaffold-the-plugin-skeleton.md` AC heading shape, the second parser brittleness to surface in 4 hours (after 5.14 Status vocab).
> Source: `parse-bmad-story.ts:217`'s `headingRe` regex rejects `**AC1 — Install & build pass cleanly:**` (descriptive title between digit and colon). 17 of 60 specs in `_bmad-output/implementation-artifacts/` use the descriptive shape, including the just-shipped 5.14 spec — this is a live BMad authoring pattern, not legacy debt.
> Substrate; 2 ACs.

As a plugin operator,
I want `/flow:scan` to recognise BMad AC headings in the descriptive shape (`**AC1 — <description>:**`) in addition to today's strict shape (`**AC1:**` or `**AC1 (tag):**`),
So that the existing 60-spec corpus in `_bmad-output/implementation-artifacts/` scans clean and the Phase 2 canary can resume.

**Background:** `parse-bmad-story.ts:217`'s `headingRe` is `/^\*\*AC(\d+)(?:\s*\(([^)]+)\))?:\*\*\s*$/` — strict end-of-line after the colon, with an optional parenthetical tag before the colon. The descriptive shape `**AC1 — Install & build pass cleanly:**` (em-dash + title between digit and colon) fails this regex; the parser then throws `MalformedBmadStoryError` from `parse-bmad-story.ts:232-236` ("no recognisable **AC<n>:** headings"). The 17 affected files (Epic 1 cluster, 2-4, 2-5, 4-2, 5-10, 5-12, 5-14) cover ~28% of the corpus. The deeper "structural markdown AST parser" direction is still Story 5.18's territory; this story is a regex widening per the established 5.14 playbook.

**Acceptance Criteria:**

**AC1:** The `headingRe` regex in `plugins/flow/mcp-server/src/adapters/bmad/parse-bmad-story.ts:217` is widened to also accept an optional em-dash-separated description between the digit and the colon: `/^\*\*AC(\d+)(?:\s+—\s+[^()]*?)?(?:\s*\(([^)]+)\))?:\*\*\s*$/` (or equivalent — the dev may refine the exact pattern as long as the corpus walk in AC2 passes). The description token is discarded; it's documentation. The parenthetical tag (when present) continues to behave as today (`(integration)` and `(user-surface)` map to `kind: "integration"`, anything else to `kind: "unit"`). Unit tests cover: (a) strict shape `**AC1:**` (regression — must still parse); (b) tagged shape `**AC2 (integration):**` (regression); (c) descriptive shape `**AC3 — Some title:**`; (d) descriptive + tagged shape `**AC4 — Some title (integration):**`. `artifact: plugins/flow/mcp-server/src/adapters/bmad/parse-bmad-story.ts`

**AC2 (integration):** Extend (or supersede) the corpus-walk test at `plugins/flow/mcp-server/src/adapters/bmad/__tests__/parse-bmad-story-corpus.integration.test.ts` (introduced by Story 5.14) so it asserts the full `parseBmadStory` pipeline — not just `Status:` round-trip — completes for every `.md` file in `_bmad-output/implementation-artifacts/`. After widening, the 17 currently-malformed files (`1-1, 1-2, 1-2b, 1-3, 1-4, 1-5, 1-6, 1-7, 1-7a, 1-10, 1-13, 2-4, 2-5, 4-2, 5-10, 5-12, 5-14`) MUST parse without throwing AND yield `acceptance_criteria` arrays with at least one AC each. Note: this AC also closes a likely gap in the 5.14 test — if the 5.14 test had asserted full pipeline parsing, the 17 files would have failed it pre-merge. Verify and extend. `vitest: plugins/flow/mcp-server/src/adapters/bmad/__tests__/parse-bmad-story-corpus.integration.test.ts`

---

## Story 5.20: Orphan-recovery — reviewer-only re-spawn when PR exists and transcript is consumed

> Added 2026-05-27 from canary-1 (bmad:5.19) Path B closeout.
> Source: carry-forward entry 8 in `_bmad-output/implementation-artifacts/epic-5-carry-forward.md`; memory `project_orphan_recovery_no_reviewer_only_branch`.

As a plugin operator,
I want `/flow:start` to retry only the reviewer when an orphan has no transcript but its PR is open and green,
So that reviewer-side failures don't force me into Path B manual closeout when dev already shipped.

**Acceptance Criteria:**

**AC1:** `scanOrphanedInProgress` returns `hasOpenPR: boolean` per orphan, computed via `gh pr list --head <branch>`.
**AC2:** `/flow:start` orchestration routes orphan with `hasTranscript: false` AND `hasOpenPR: true` → spawn-reviewer-only (skip dev replay); preserves the no-PR branch as `blocked_by: orphan-no-transcript`.
**AC3 (integration):** vitest fixture (manifest + no transcript + open PR mocked) asserts `hasOpenPR: true` AND routing produces "spawn-reviewer" with no `blocked_by` stamp.
**AC4 (regression):** vitest fixture (manifest + no transcript + no PR) preserves current `blocked_by: orphan-no-transcript` behaviour.

## Story 5.21: Reviewer first-tool-call deterministic seam

> Added 2026-05-27 from canary-1 (bmad:5.19) reviewer-skip incident.
> Source: carry-forward entry 9 in `_bmad-output/implementation-artifacts/epic-5-carry-forward.md`; memory `project_reviewer_first_call_enforcement_needed`.

As a plugin operator,
I want the reviewer cycle to be structurally incapable of completing without `runReviewerSession` having been called first,
So that a reviewer subagent that reasons around its prose mandate cannot waste a spawn and force manual recovery.

**Acceptance Criteria:**

**AC1:** Reviewer-spawning orchestration calls `runReviewerSession` before the reviewer subagent begins its turn — either (a) the spawning skill/tool invokes it directly OR (b) a post-spawn guard fails-loud if `agent_invokes` lacks the call. Dev picks the cleaner seam; the persona prose mandate becomes belt-and-braces.
**AC2:** Persona prose mandate stays but is annotated with a change-log comment naming Story 5.21 and pointing to the deterministic seam location.
**AC3 (integration):** vitest with empty `agent_invokes` asserts orchestration either injects the call or fails-loud; manifest does NOT progress to verdict without `runReviewerSession` invoked.
**AC4 (regression):** vitest happy path — subagent calls `runReviewerSession` first; no double-call, no fail-loud, no behavioural drift.

## Story 5.22: `renderScanResult` leading-whitespace test assertion

> Added 2026-05-27 as canary-2 target — small substrate story to validate the loop end-to-end after 5.20 + 5.21 substrate fixes shipped.
> Source: carry-forward entry 2 in `_bmad-output/implementation-artifacts/epic-5-carry-forward.md` (Story 5.13 review-feedback Info).

As a plugin operator,
I want a regression assertion that `renderScanResult`'s output has no leading whitespace on any non-empty line,
So that terminal-rendered scan results stay cosmetically clean and future refactors can't quietly introduce indentation drift.

**Acceptance Criteria:**

**AC1 (vitest):** Add a test in scan-sources coverage that splits `renderScanResult` output by `\n` and asserts each non-empty line passes `!/^\s/.test(line)`. Fixture should render ≥5 non-empty lines.
**AC2 (regression-direction):** Test passes on current `dev` HEAD without modifying `renderScanResult` first; if it fails, fix the render (single-line entries, no indent), don't weaken the assertion.

## Story 5.23: `markStoryShipped` MCP tool — manual-merge closeout stop-gap (stub-only, protected backlog)

> Stub-only — protected backlog. Added 2026-05-27 from canary-1 + canary-2 manual-closeout friction.
> Source: carry-forward entry 10 in `_bmad-output/implementation-artifacts/epic-5-carry-forward.md`.

**Trigger condition (verbatim — do NOT author the spec until this fires):**

This story MUST NOT be authored or shipped unless one of the following triggers:

1. The manual-merge closeout pattern (eyeball PR + hand-edit manifest from `in-progress/` or `blocked/` to `done/` + strip `blocked_by`/`claimed_by` + flip `status` to `done`) repeats 3 or more additional times after 2026-05-27 (canary-1 and canary-2 already count as instances 1 and 2 — trigger fires on instance 5 cumulative), OR
2. The AC-marker classifier work (carried debt, carry-forward entry 7 / `feedback_reviewer_contract_carried_debt`) slips past Epic 7 entry without resolution.

When either trigger fires, author the full spec via `/bmad-create-story 5.23` and ship via `/ship-story 5-23`. Until then, leave this block in place as a protected backlog marker.

**Scope sketch (NOT authoritative — spec authoring required when triggered):**

New MCP tool `markStoryShipped(ref: string)` that:

- Moves the manifest from `in-progress/` or `blocked/` to `done/`.
- Strips `blocked_by` and `claimed_by` fields.
- Sets `status: done`.
- Atomic write semantics (no half-state).
- Surfaced via an operator-facing slash command (`/flow:mark-shipped <ref>`) or one-shot CLI helper.

**Why not now:** if the classifier carried debt resolves first (Epic 6→7), this tool's surface disappears — the BLOCKED-with-merged-PR case stops happening because the classifier stops false-positiving. Authoring now risks wasted spec work. Same shape of protection as Story 5.18 (structural parser) — trigger-condition gating, no premature authoring.

## Story 5.18: Structural / AST-style story parser (stub-only, protected backlog)

> Stub-only — protected backlog. Added 2026-05-28 (originally proposed in `sprint-change-proposal-2026-05-27-reframe.md` Phase B; promoted from carry-forward entry 11 on Phase A complete).
> Source: memory `project_current_blocker_story_parser`; trigger-condition gated.

As a plugin operator,
I want the BMad story parser to extract semantic fields from a markdown AST rather than chain-matching brittle line-shape regexes,
So that stories from any planner (BMad, native, future adapters) survive minor formatting drift without losing scan/validate capability.

**Trigger condition (verbatim — do NOT author the spec until this fires):**

This story MUST NOT be authored or shipped unless one of the following triggers:

1. A **non-BMad adapter input shape** lands (e.g. JIRA, Linear, GitHub Issues, a custom user adapter whose `parseSourceStory` differs structurally from `parseBmadStory` / `parseNativeStory`) — author 5.18 BEFORE merging that adapter.
2. An **external-planner integration** ships — same shape as (1).
3. **Cumulative regex-widening cost** exceeds the structural-refactor cost — when total widening surface in `parse-bmad-story.ts` / `parse-native-story.ts` gets too large to safely add another widening, OR when a proposed widening would conflict with another.

When any trigger fires, author the full spec via `/bmad-create-story 5.18` and ship via `/ship-story 5-18`. Until then, leave this block in place as protected backlog.

**Scope sketch (NOT authoritative — spec authoring required when triggered):**

Replace chain-of-whitespace-strict-regexes in `parse-bmad-story.ts` and `parse-native-story.ts` with markdown-AST extraction (`remark` / `mdast` or equivalent). Drop-in: same interface, same return shape, same error types. No upstream callers change.

**Why not now:** Current parser + 5.14 + 5.17 widening patches accommodate authored stories acceptably. Cost-per-widening has been small (~quarterly). Structural refactor is substantial (~1-2 weeks). Trigger ensures authoring at the moment it pays off.

## Story 5.24: `.d.ts` Zod-determinism fix — eliminate cosmetic dist/ drift across clean rebuilds

> Added 2026-05-27 post-`pre-dogfood-resumption-3` (5th occurrence of the drift).
> Source: carry-forward entry 4 in `_bmad-output/implementation-artifacts/epic-5-carry-forward.md`.

As a plugin operator,
I want the `.d.ts` files under `plugins/flow/mcp-server/dist/` to be byte-identical across clean `tsc` rebuilds,
So that the working-tree-clean invariant holds without the `git restore plugins/flow/mcp-server/dist/` workaround.

**Acceptance Criteria:**

**AC1:** Build determinism — two consecutive clean builds produce byte-identical `dist/`, verified 5 times consecutively.
**AC2:** Root cause documented in story Dev Notes — names the specific Zod construct(s), version/build behaviour responsible, and why the chosen fix strategy resolves it.
**AC3 (integration):** vitest in `plugins/flow/mcp-server/tests/build-determinism.test.ts` runs the build twice and asserts `dist/` is byte-identical between runs. Investigation-first story; dev picks strategy (pin Zod / explicit enums / post-build normaliser) after diagnosis.

## Story 5.25: Always-on MCP lifecycle logging + server-initiated keepalive — diagnose and prevent mid-session disconnects

> Added 2026-05-28 from the post-5.12 disconnect-friction investigation.
> Source: plan at `~/.claude/plans/continue-optimized-patterson.md`; informed by Anthropic issues #36308, #43177, #57207 and the MCP spec § stdio transport shutdown.
> Re-investigates Story 5.12's keep-alive: external evidence shows stdin-close IS the spec's shutdown signal, so 5.12's setInterval is fighting the spec (zombie process). The real lever is preventing the parent's idle timer from ticking via periodic server-initiated traffic.

As a plugin operator,
I want the flow MCP server to (a) emit a persistent JSON-line lifecycle log so every disconnect reveals its trigger, (b) send a periodic keepalive ping that resets the parent's idle timer before the ~10 min reap fires, (c) survive unhandled errors and stdout EPIPE without crashing, and (d) drop Story 5.12's zombie-keeping setInterval since stdin-close is the spec-correct shutdown signal,
So that mid-session "tools no longer available" stops being the dominant friction in long sessions, and so that when disconnects do happen, the log file tells me exactly which trigger fired.

**Acceptance Criteria:**

**AC1:**
The MCP server appends JSON lines to a stable log path (default `~/.flow/mcp-lifecycle.log`, overridable via `FLOW_MCP_LIFECYCLE_LOG` env). Events captured each as one JSON line: `boot` (pid, timestamp, plugin version), `transport.connected`, `tool.call` (name, ms-since-boot), `keepalive.sent`, `keepalive.response`, `stdin.end`, `stdin.close`, `stdout.error`, `transport.onclose`, `signal` (SIGTERM/SIGINT/SIGHUP), `uncaughtException`, `unhandledRejection`, `beforeExit`, `exit` (code). Logging is fail-open — an unwritable log path never crashes the server. The opt-in `FLOW_MCP_DIAG` env from Story 5.12 is migrated into this layer (the old separate stderr stream is removed).
artifact: plugins/flow/mcp-server/src/lib/lifecycle-log.ts
artifact: plugins/flow/mcp-server/src/index.ts

**AC2:**
The server sends a JSON-RPC ping request (`{method: "ping"}`) to the client every 5 minutes (configurable via `FLOW_MCP_KEEPALIVE_MS`, default 300000; disable with `0`). Each ping is logged as `keepalive.sent`; the client's pong reply is logged as `keepalive.response`. The keepalive uses the SDK's `Protocol.request()` method (inherited by `Server`) — no new MCP scaffolding is introduced. Ping failures are logged but do not crash the server. The timer is unref'd so it does not by itself hold the process alive after stdin close.
artifact: plugins/flow/mcp-server/src/index.ts

**AC3:**
The server installs `process.on('uncaughtException')`, `process.on('unhandledRejection')`, and `process.stdout.on('error')` handlers that log the event to the lifecycle log and do NOT exit the process. The existing `main().catch(err => process.exit(1))` is preserved (it only fires on init failure, not on in-flight errors). SIGTERM/SIGINT default behaviour is unchanged — the server still terminates cleanly on signals (no custom handler added).
artifact: plugins/flow/mcp-server/src/index.ts

**AC4:**
The module-level `_keepAliveHandle` setInterval and the `swallowStdinEnd`/`swallowStdinClose`/`process.stdin.resume()` block from Story 5.12 are removed from `plugins/flow/mcp-server/src/index.ts`. The story spec must document the justification: per MCP stdio transport spec, stdin close IS the parent's shutdown signal; the server should exit cleanly when it receives one. AC2's keepalive prevents stdin close from being the parent's choice in the first place; if the parent decides to shut down, we honour it.
artifact: plugins/flow/mcp-server/src/index.ts

**AC5:**
The existing test `plugins/flow/mcp-server/src/__tests__/mcp-stdin-close-resilience.test.ts` is renamed to `mcp-stdin-close-shutdown.test.ts` and rewritten to assert the new contract: on stdin close, the child exits cleanly within 5 seconds with exit code 0. The "survive stdin close" assertions are deleted; the SIGTERM and dispatch-regression assertions are preserved.
vitest: plugins/flow/mcp-server/src/__tests__/mcp-stdin-close-shutdown.test.ts

**AC6 (integration):**
vitest spawns the real `dist/index.js` with `FLOW_MCP_LIFECYCLE_LOG` set to a tmp path, drives a `tools/list` call, sends SIGTERM, and asserts the log file contains the expected event sequence (`boot` → `transport.connected` → `tool.call` → `signal` → `exit`). A second test asserts that an unwritable log path (e.g., `/proc/nonexistent/log`) does not crash the server (server still answers tool calls; log writes silently noop).
vitest: plugins/flow/mcp-server/src/__tests__/mcp-lifecycle-log.test.ts

**AC7 (integration):**
vitest spawns the dist with `FLOW_MCP_KEEPALIVE_MS=2000` and `FLOW_MCP_LIFECYCLE_LOG` set to a tmp path. After 7 seconds, the test reads the log and asserts at least 3 `keepalive.sent` events and at least 1 `keepalive.response` event (proving the SDK's auto-pong path works end-to-end). A second test sets `FLOW_MCP_KEEPALIVE_MS=0` and asserts no `keepalive.sent` events appear within 5 seconds (disabled-by-zero contract).
vitest: plugins/flow/mcp-server/src/__tests__/mcp-keepalive.test.ts

**Note:** AC2's effectiveness against the real parent (does Claude Code's idle timer reset on incoming traffic?) is unverifiable in isolated tests — we can only confirm in real sessions. The lifecycle log from AC1 is the post-ship verification mechanism: if `stdin.end` events stop appearing in long idle sessions, the keepalive is working; if they still appear, the parent's timer is wall-clock and we revisit in a follow-up story (not a blocker for this one — the log gives us the signal).

## Story 5.26: `runReviewerSession` artifact-check against PR branch

> Added 2026-05-28 after bmad:5.24 re-roll exposed the gap.
> Source: carry-forward entry 13 in `_bmad-output/implementation-artifacts/epic-5-carry-forward.md`.

As a plugin operator,
I want the reviewer's artifact-presence check to verify against the PR branch's filesystem (not the orchestrator's local `dev`),
So that the reviewer can return a true verdict on dev-shipped code without requiring an operator-side pre-merge.

**Context:** `runReviewerSession.runArtifactCheck` currently does `fs.access(path.resolve(targetRepoRoot, artifactPath))`. `targetRepoRoot` is the orchestrator's working dir, which sits on `dev` — but the dev subagent's new files live on the PR's head branch (e.g. `bmad-5-24-zod-determinism-dts-fix`) in a sibling worktree at `../crew-<ref>` that gets torn down after handoff. Net effect: every PR's artifact check sees "file missing" → status:fail → verdict:NEEDS CHANGES. This was hidden in v1 because the marker classifier (carry-forward entry 7) returned manual-check-required for every backticked-marker AC, so the artifact-check filesystem path was never reached. Fixing markers in spec authoring discipline (6.1/6.3/6.2 now do this) exposed this gap.

**Acceptance Criteria:**

**AC1:** Before running per-AC artifact checks, `runReviewerSession` fetches the PR's `headRefName` and `headRefOid` via `gh pr view <prNumber> --json headRefName,headRefOid`, then materialises that ref's filesystem state for the duration of the check.
**AC2:** The check root used by `runArtifactCheck` and `runVitestCheck` is the PR-branch filesystem, not `targetRepoRoot`. Implementation strategy is dev's choice: (a) `git worktree add <tmp> <sha>` + use `<tmp>` as check root + tear down on exit; or (b) for artifact-presence only, `git cat-file -e <sha>:<path>` to verify without checkout. Strategy (a) is required for AC3.
**AC3 (integration):** vitest seeds a tmp git repo with two branches (orchestrator branch lacking the artifact; PR branch containing it), seeds a `to-do/<ref>.yaml` + reviewer-result.json shape that drives `runReviewerSession`, runs the reviewer against a stub PR number with `gh` mocked to return the PR-branch ref, asserts artifact check passes against the PR branch's filesystem rather than the orchestrator's. Repeats for the missing-artifact case (returns status:fail correctly).
**AC4:** On any `gh` failure during the head-ref fetch (recoverable or otherwise), surface a typed error and halt the reviewer session — do NOT silently fall back to the local-filesystem check. Old behaviour is structurally wrong; failing-closed is correct.
**AC5:** After check completion, the temporary worktree (if strategy a) is cleaned up unconditionally (try/finally). Stale temp worktrees from prior interrupted runs are detected and reaped on subsequent invocations.

## Story 5.27: `runVitestCheck` workspace-aware cwd resolution

> Added 2026-05-28 after bmad:5.24 re-roll exposed the gap.
> Source: carry-forward entry 14 in `_bmad-output/implementation-artifacts/epic-5-carry-forward.md`.

As a plugin operator,
I want the reviewer's vitest invocation to run from the package directory that owns the test file (not the workspace root),
So that vitest checks succeed in monorepo / pnpm-workspace target repos that have no root `package.json`.

**Context:** `runReviewerSession.runVitestCheck` currently invokes `pnpm vitest --run -t '<filter>'` with `cwd: targetRepoRoot`. The crew repo is a pnpm workspace with no root `package.json` (the vitest-owning package is `plugins/flow/mcp-server/`). Invocation fails with `ERR_PNPM_NO_PKG_MANIFEST`; test never executes; AC status:fail; verdict:NEEDS CHANGES. Hidden behind the same marker-classifier issue as Story 5.26 until 2026-05-28.

**Acceptance Criteria:**

**AC1:** `runVitestCheck` resolves the cwd from the test file's location: walks up from the resolved absolute path of the test file (derived from the `vitest:` marker) until it finds the nearest `package.json`, and uses that directory as the `cwd` for the `pnpm vitest` invocation.
**AC2:** If no `package.json` is found between the test file and `targetRepoRoot` (inclusive), the check returns status:fail with a clear reason naming the missing-manifest condition — does NOT silently fall back to `targetRepoRoot`.
**AC3 (integration):** vitest seeds a fixture mimicking the crew workspace shape: outer dir with no `package.json`, inner `plugins/flow/mcp-server/` with a valid `package.json` + a passing vitest test. Asserts `runVitestCheck` (a) correctly identifies `plugins/flow/mcp-server` as cwd, (b) runs vitest there, (c) returns status:pass. Repeat for a fixture with no nested `package.json` — asserts status:fail with the missing-manifest reason.
**AC4:** Dependency on Story 5.26: this story sits on top of 5.26's PR-branch check root. If 5.26 hasn't shipped, the test-file path resolves against `targetRepoRoot` (orchestrator's local dev) and the workspace walk happens there — which still works for this repo's shape. If 5.26 has shipped, the walk happens inside the PR-branch worktree. Both paths must be exercised by AC3.

## Story 5.28: `build:watch` chains `normalise-dist.mjs` after each tsc recompile

> Added 2026-05-28 after `/ship-story 5-27` preflight tripped on Zod-determinism drift while `pnpm build:watch` was the active dev loop.
> Source: carry-forward entry 16 in `_bmad-output/implementation-artifacts/epic-5-carry-forward.md`.

As a plugin operator,
I want `pnpm build:watch` to run `scripts/normalise-dist.mjs` after every tsc recompile (the same chain `pnpm build` uses),
So that the dev loop CLAUDE.md tells me to keep running stops producing continuous `dist/*.d.ts` drift that blocks `/ship-story` preflight on every substrate story.

**Context:** Story 5.24 (commit `ee3506d`) wired the normaliser into `pnpm build` as `tsc -p tsconfig.json && node scripts/normalise-dist.mjs`. It only covered the one-shot build, which is what CI calls. `pnpm build:watch` is still bare `tsc -p tsconfig.json --watch`, so the watcher emits unnormalised `.d.ts` after every source change. Observed 2026-05-28: a fresh `pnpm build:watch` against `dev` produced 8 drifted `.d.ts` files matching the exact Zod enum-key reordering pattern (`haiku`/`opus`/`sonnet`, `BLOCKED`/`NEEDS CHANGES`/`READY FOR MERGE`, retry/needs-human, etc.) that 5.24's normaliser is designed to canonicalise. `/ship-story`'s preflight halts on dirty tree, so every substrate-story flow is now blocked-by-default whenever the dev watcher is running — which CLAUDE.md instructs operators to keep on (memory `project_dev_loop_plugin_dir`).

**Acceptance Criteria:**

**AC1 (user-surface):** `pnpm --dir plugins/flow/mcp-server build:watch` invokes `scripts/normalise-dist.mjs` after each tsc recompile cycle. No new runtime or dev dependencies are introduced — package.json `dependencies` / `devDependencies` are byte-identical to pre-story state (verified by diff). The watcher remains responsive (tsc-foreground; normaliser runs async post-emit) and inert when no source changes occur (no busy loop, no periodic re-runs without a tsc rebuild).
artifact: plugins/flow/mcp-server/package.json
artifact: plugins/flow/mcp-server/scripts/watch-and-normalise.mjs

**AC2 (user-surface):** With a clean working tree, running `pnpm --dir plugins/flow/mcp-server build:watch` and then editing any `.ts` source file that produces a `.d.ts` containing a `z.enum([...])` (the construct sensitive to V8 hidden-class ordering — see 5.24 Dev Notes) results in a working tree that returns to clean once the watcher's recompile cycle settles. Validated 5 times consecutively — zero drift on any pair across an edit→settle cycle.
artifact: plugins/flow/mcp-server/scripts/watch-and-normalise.mjs

**AC3 (integration):** vitest in `plugins/flow/mcp-server/tests/build-watch-determinism.test.ts` spawns `pnpm build:watch` (or the wrapper script directly) as a child process inside a tmp project copy (or the package under test), triggers an idempotent source touch that forces a `.d.ts` re-emit, waits for the normaliser to settle (poll-with-timeout, ~5–10s cap), and asserts the resulting `.d.ts` files are byte-identical to what `pnpm build` (one-shot) produces from the same source. Child process and any spawned tsc workers are torn down unconditionally (try/finally + process-group teardown).
vitest: plugins/flow/mcp-server/tests/build-watch-determinism.test.ts

**AC4:** Root cause and design choice documented in the story's Dev Notes. The note names (a) why the bare `tsc --watch` path bypassed the 5.24 fix, (b) why the chosen seam (wrapper script vs. tsc programmatic API vs. fs.watch on `dist/`) was picked, and (c) what edge cases were considered (orphan child processes, debouncing rapid edits, normaliser concurrency with mid-emit tsc writes). Technical specifics required — one paragraph minimum.
artifact: _bmad-output/implementation-artifacts/5-28-build-watch-normaliser-chaining.md

## Story 5.29: Hand-edit check uses manifest-only baseline (not live source story)

> Added 2026-05-28 as follow-up to PR #176 close-out. `processReviewerTranscript` refused READY FOR MERGE because `deriveSourceBaseline` re-reads the live source story, which the dev legitimately edited (`implementation_notes`). Every Epic 6a close-out repeats this until fixed.
> Source: `_bmad-output/implementation-artifacts/5-29-hand-edit-check-manifest-only-baseline.md`.

As a dev/reviewer agent and the operator orchestrating them,
I want the in-progress hand-edit check to compare the on-disk in-progress manifest against a baseline captured at claim time, not against the current source story file,
So that the legitimate dev workflow of filling `## Implementation Notes` in the source story stops tripping `InProgressHandEditError` and blocking every successful close-out.

**Context:** `detectInProgressHandEdit`'s baseline is currently derived from the live source story (via `deriveSourceBaseline` → `activeAdapter.readSourceStory`). When the dev edits the source story's Implementation Notes section during a story — which the placeholder text instructs them to do — the next `claimStory`/`completeStory` call sees `source_hash` and `implementation_notes` drift between the captured manifest and the recomputed source baseline, throws `InProgressHandEditError`, and refuses to advance. The fix narrows the check to manifest-only fields: snapshot the manifest at claim time (sidecar `in-progress/<ref>.snapshot.yaml`), compare manifest-to-sidecar at completion. Source-story tamper detection by re-reading the live source is removed from the in-progress guard. PR #176 (bmad:6.1) hit this defect on close-out and had to be operator-overridden.

**Acceptance Criteria:**

**AC1:** `detectInProgressHandEdit` compares the on-disk in-progress manifest against a baseline that was snapshotted at claim time (sidecar file or persisted on the manifest) and no longer re-reads the source story file to rebuild the baseline. `deriveSourceBaseline` is either removed at the in-progress check call sites (`claimStory` re-entry path, `completeStory`) or its return value is replaced by a manifest-snapshot loader. Source-hash drift between the in-progress manifest and the current source story is no longer a hand-edit signal.
artifact: plugins/flow/mcp-server/src/state/manifest-state-machine.ts
artifact: plugins/flow/mcp-server/src/tools/complete-story.ts
artifact: plugins/flow/mcp-server/src/tools/claim-story.ts

**AC2 (integration — regression):** A vitest test exercises the end-to-end dev-fills-implementation_notes path: claimed manifest in `in-progress/` with `implementation_notes` captured at claim time, then simulate the dev's edit by rewriting the source story file's `## Implementation Notes` section. Call `completeStory` (or `processReviewerTranscript` → `completeStory`). Assert the call succeeds (no `InProgressHandEditError`), the manifest moves from `in-progress/` to `done/`, and no source-file drift is reported. This is the regression guard for PR #176's defect.
vitest: plugins/flow/mcp-server/src/state/__tests__/detect-in-progress-hand-edit.test.ts

**AC3 (integration — no false negatives):** A vitest test confirms operator manifest-tampering is still detected after the narrowing. Hand-edit the in-progress manifest file directly (flip `withdrawn`, reorder `acceptance_criteria`, change `title`) while leaving the source story file untouched. Call `claimStory` re-entry or `completeStory`. Assert `InProgressHandEditError` is thrown with the correct `changedFields` array. Existing c1–c3 hand-edit cases (`title`, `acceptance_criteria`, `withdrawn`) each remain detected.
vitest: plugins/flow/mcp-server/src/state/__tests__/detect-in-progress-hand-edit.test.ts

**AC4:** `detectInProgressHandEdit` JSDoc is updated to reflect the new contract ("compares the on-disk in-progress manifest against the claim-time manifest snapshot; does not consult the source story file"). The Story 3.7 caller contract reference is updated to point at this story. `deriveSourceBaseline` either has its JSDoc updated to note it is no longer used by the in-progress guard (if retained for other reasons) or is removed entirely if no remaining call sites exist. The c4 case in the existing test file (`source hash drift detected`) is updated or removed so the test name no longer implies source-file drift detection from the in-progress guard.
artifact: plugins/flow/mcp-server/src/state/manifest-state-machine.ts
artifact: plugins/flow/mcp-server/src/state/derive-source-baseline.ts
artifact: plugins/flow/mcp-server/src/state/__tests__/detect-in-progress-hand-edit.test.ts

## Story 5.30: MCP cascade halt seam in `/flow:start` + lifecycle-log diagnostic fields

> Added 2026-05-28 after RCA confirmed Claude Code's `Task`-return SIGTERM cascade kills the parent MCP child paired with the subagent's child (8/8 paired SIGTERMs across 4 incidents in `~/.flow/mcp-lifecycle.log`).
> Source: `~/.claude/plans/linked-knitting-stardust.md` § Recommendation — Path A.

As a plugin operator,
I want `/flow:start` to halt cleanly with a verbatim recovery line when the parent MCP child has been killed mid-cycle by Claude Code's subagent-termination cascade, AND I want the lifecycle log to carry `ppid` + `pgid` (and optional `sessionUlid`) on every event,
So that the cascade failure mode stops manifesting as a stranded in-progress manifest with no operator-visible explanation, and future RCAs on disconnect events take minutes rather than the multi-hour pid-correlation pass that surfaced the cascade in the first place.

**Context:** Stories 5.10/5.11/5.12 and 5.25 addressed idle-reap (a different failure mode); the cascade was invisible until 2026-05-28's RCA. The fix surface (process group semantics for subagent-spawned children) lives in Claude Code; we cannot fix the cascade from plugin code. Path A is the v1 strategy: accept the limitation, halt cleanly via a deterministic typed-error seam, add diagnostic fields so the next incident is observable from the log file alone. Paths B (HTTP daemon) and D2 (detached proxy) are deferred — D2 is the v1.1 candidate.

**Acceptance Criteria:**

**AC1:** A new typed error class `McpDisconnectedError` exists in `plugins/flow/mcp-server/src/errors.ts`, extending `DomainError`. The MCP-call wrapper used by `/flow:start`'s inner cycle catches the SDK's "tools no longer available" / "MCP server has disconnected" surface and re-raises as `McpDisconnectedError`, carrying `methodName`, `causeMessage`, and optional `ref`.
artifact: plugins/flow/mcp-server/src/errors.ts

**AC2:** `plugins/flow/skills/start/SKILL.md` gains a new "Failure modes" entry for `McpDisconnectedError`. When this error is caught at any MCP call site inside the inner cycle, the prose layer emits the verbatim halt line `[mcp-cascade-halted] MCP child killed by subagent Task termination — restart Claude Code and re-run /flow:start. The in-progress manifest will surface as an orphan; choose "reattach" to resume without losing work.` and stops — no further MCP calls; the manifest is left for Story 5.20's orphan-recovery branch on the next restart. The entry references memory `project_mcp_cascade_sigterm`.
artifact: plugins/flow/skills/start/SKILL.md

**AC3 (integration):** A vitest test in `plugins/flow/mcp-server/src/__tests__/mcp-lifecycle-log.test.ts` asserts that every event emitted by `createLifecycleLog().log(...)` and `createLifecycleLog().logSync(...)` carries `ppid` and `pgid` fields. The test covers every event-name the server emits today (`boot`, `transport.connected`, `tool.call`, `keepalive.sent`, `keepalive.response`, `keepalive.error`, `stdin.end`, `stdin.close`, `stdout.error`, `transport.onclose`, `signal`, `uncaughtException`, `unhandledRejection`, `beforeExit`, `exit`). `sessionUlid` MAY be present when `FLOW_SESSION_ULID` env var is set; the test covers both presence and absence.
vitest: plugins/flow/mcp-server/src/__tests__/mcp-lifecycle-log.test.ts

**AC4 (integration):** A vitest test in `plugins/flow/mcp-server/src/__tests__/start-skill-mcp-disconnect.test.ts` simulates an MCP disconnect during the inner cycle and asserts (a) the verbatim halt line is emitted, (b) no further MCP calls are attempted after the halt, and (c) `McpDisconnectedError` is raised with the expected `methodName` / `causeMessage` fields.
vitest: plugins/flow/mcp-server/src/__tests__/start-skill-mcp-disconnect.test.ts

## Story 5.31: Path D2 feasibility spike — detached proxy + parent-owned MCP daemon

> Added 2026-05-28 as the v1.1 reliability candidate identified by the MCP-cascade RCA (`~/.claude/plans/linked-knitting-stardust.md` § Recommendation, step 4).
> Time-boxed research spike. No production code modified. Output is a notes file with concrete evidence answering five blocking questions; the spike's exit is either "all five answered with green evidence" or "one hard blocker, escalate".

As a **plugin engineer planning v1.1 reliability work**,
I want **a half-day spike that confirms or invalidates Path D2 — a detached proxy script that re-execs the real MCP server in its own process group so the server survives the SIGTERM cascade that Story 5.30 only halts cleanly against**,
So that **the next reliability investment is grounded in concrete evidence (manifest support confirmed, OS-level detachment validated, framing/lockfile/auth patterns decided) rather than design speculation, and we either commit to building D2 as v1.1's headline story or pivot to Path B (HTTP daemon) without losing a week to a dead end**.

**Context:** Story 5.30 ships Path A (accept the cascade, halt cleanly, document). The RCA memo identifies Path D2 as the right v1.1 investment: 2–3 days of engineering for the same outcome as Path B (HTTP daemon, 4–7 days) without B's first-install ergonomic regression. D2's shape: the plugin manifest points at a stdio shim (`mcp-proxy.js`); on first connection, the shim `spawn(..., { detached: true, stdio: 'ignore' })`s the real MCP server, putting it in its own process group; the shim forwards JSON-RPC frames over a per-user unix socket between Claude Code's stdio and the daemon; when the host SIGTERMs the proxy's process group at subagent `Task` return, the detached daemon survives. None of this is built by the spike — the spike investigates the five questions that, if any answer is hostile, would invalidate the entire approach before the build is scheduled. The spike must NOT modify `plugin.json`, `mcp-server/src/`, or any other production code; output is a notes document under `_bmad-output/implementation-artifacts/spikes/`.

**Acceptance Criteria:**

**AC1 (spike notes file exists with all five answers):** A notes file at `_bmad-output/implementation-artifacts/spikes/d2-feasibility-notes.md` exists and answers all five investigation questions below, each with concrete evidence (a URL with quoted excerpt, a runnable repro snippet with observed output, or a quoted fragment of an existing source file). The notes file's top section names the spike's verdict in one of three forms: `proceed-with-d2`, `pivot-to-path-b`, or `blocked-escalate-to-jack` with the named blocker.
artifact: _bmad-output/implementation-artifacts/spikes/d2-feasibility-notes.md

**AC2 (manifest support — Q1):** The notes file answers: does Claude Code's plugin manifest at `plugins/flow/.claude-plugin/plugin.json` support pointing `mcpServers.*.command` at an arbitrary stdio shim (e.g., a one-line bash script that `exec`s the real server) and have the host treat the shim as the MCP child? Evidence: either (a) a quoted excerpt from Claude Code's MCP docs (https://code.claude.com/docs/en/mcp.md) confirming the manifest treats `command` as an arbitrary executable path, OR (b) a runnable repro outside this repo (a tiny test plugin with a shell shim) showing MCP tools list correctly through the shim. The notes record the verdict as `manifest-supports-shim: yes | no | unclear-with-caveats`.
artifact: _bmad-output/implementation-artifacts/spikes/d2-feasibility-notes.md

**AC3 (OS-level detachment — Q2):** The notes file answers: does `spawn(..., { detached: true, stdio: 'ignore' })` from a Node child actually survive a SIGTERM to its grandparent's process group on darwin? Evidence: a 20–40 line standalone Node repro outside this repo (not in `plugins/flow/`) that (a) spawns a "real server" child with `detached: true` + `stdio: 'ignore'`, (b) sends `SIGTERM` to the parent's process group via `process.kill(-pgid, 'SIGTERM')`, and (c) observes the detached child's pid is still alive 2s later (`process.kill(pid, 0)` returns truthy). The notes include the repro source verbatim and the observed terminal output. Records verdict as `detached-survives-sigterm: yes | no | partial-with-caveats`.
artifact: _bmad-output/implementation-artifacts/spikes/d2-feasibility-notes.md

**AC4 (JSON-RPC framing — Q3):** The notes file answers: what's the cleanest framing for the shim's stdio→unix-socket bridge? The shim must forward JSON-RPC frames between Claude Code (stdio) and the daemon (unix socket). The notes identify any framing gotchas (chunked frames across socket reads, large payloads >64KB exceeding default buffer sizes, partial reads requiring buffering, line-delimited vs Content-Length framing) and recommend one framing approach with rationale. Evidence: either (a) a quoted reference to the MCP SDK's transport framing (`@modelcontextprotocol/sdk` source or docs via Context7), OR (b) a quoted note from the spike's investigation of the existing `plugins/flow/mcp-server/src/index.ts` stdio transport setup. Records verdict as `framing-approach: <named approach>` (e.g., `line-delimited-json`, `content-length-prefixed`).
artifact: _bmad-output/implementation-artifacts/spikes/d2-feasibility-notes.md

**AC5 (lockfile + stale-daemon detection — Q4):** The notes file answers: what's the right pattern for "is a daemon already running, or do I need to spawn one"? The notes evaluate at minimum two patterns — (a) PID file + `kill(pid, 0)` check, and (b) optimistic socket-connect probe — and recommend one with rationale covering: stale-PID handling on crash, race condition on first two concurrent shim spawns, cross-session correctness when multiple Claude Code instances run. Evidence: either a quoted reference from a well-known daemon's source (sshd, pgsql, redis), or a short pseudocode sketch validated against the four edge cases above. Records verdict as `daemon-liveness-pattern: <pidfile-with-kill-zero | socket-connect-probe | hybrid>`.
artifact: _bmad-output/implementation-artifacts/spikes/d2-feasibility-notes.md

**AC6 (auth / multi-user safety — Q5):** The notes file answers: does the unix socket need a per-connection token, or is filesystem permission (`0600` on the socket path under `~/.flow/`) sufficient for the darwin reference platform? The notes identify the threat model (other unprivileged processes on the same machine; not a network adversary — unix sockets are local-only), evaluate filesystem-permission-only vs token-handshake-on-connect, and recommend one with rationale. Evidence: either a quoted reference from unix-socket auth best-practices (e.g., man 2 socket section on `SO_PEERCRED` / macOS equivalents) or a quoted note on equivalent patterns in adjacent local-IPC daemons. Records verdict as `socket-auth: <filesystem-permission-only | token-handshake | other>`.
artifact: _bmad-output/implementation-artifacts/spikes/d2-feasibility-notes.md

## Story 5.32: Path D2 build — detached proxy + parent-owned MCP daemon

> Added 2026-05-28 as the v1.1 reliability build that retires Story 5.30's restart-per-cascade UX cost. Story 5.31's spike returned `proceed-with-d2` with green evidence across Q1–Q5; this story implements the patterns the spike locked in.
> Risk tier: **medium** — changes the boot path of the entire MCP server.

As a **plugin operator running `/flow:start` cycles with subagent fan-out**,
I want **the MCP server to survive the SIGTERM cascade that the Claude Code host fires when a subagent `Task` returns, by relocating the real server into its own process group behind a stdio proxy shim**,
So that **`/flow:start` no longer halts on every subagent return, the verbatim `[mcp-cascade-halted]` line shipped by Story 5.30 never appears for cascade reasons in steady state, and one Claude Code session can drain the backlog without per-story restarts**.

**Context:** Story 5.30 ships the halt seam (Path A — "accept + document"). Story 5.31's spike de-risked D2: `manifest-supports-shim: yes`, `detached-survives-sigterm: yes`, `framing-approach: line-delimited-json`, `daemon-liveness-pattern: hybrid`, `socket-auth: filesystem-permission-only`. Verdict `proceed-with-d2` with concrete evidence (URL+quote for Q1, runnable repro+observed output for Q2, SDK source quotes for Q3, edge-case matrix + redis source for Q4, threat model + ssh-agent/gpg-agent/docker reference for Q5). This story builds: (a) a Node proxy shim that the plugin manifest points at instead of `node …/dist/index.js`, (b) per-user unix socket transport at `~/.flow/mcp-daemon.sock` with mode 0600, (c) hybrid daemon-liveness (PID file + `kill(0)` + connect-probe + flock for spawn race), (d) plugin manifest updated to point at the proxy. The proxy spawns the real server `detached: true, stdio: 'ignore'` so it ends up in its own pgid (Q2's repro confirmed it reparents to ppid=1 after parent SIGTERM); the shim then byte-forwards stdio↔socket. When the host SIGTERMs its pgid at subagent `Task` return, the shim dies; the daemon survives; the next subagent's MCP traffic reconnects via the same socket. The build estimate from the RCA memo is 2–3 engineering days, now de-risked by the spike.

**Acceptance Criteria:**

**AC1 (proxy shim spawn — detached child + JSON-RPC initialize forward):** A vitest unit test asserts the proxy shim's spawn path. Given a fake stdio pair (in-memory streams), when the proxy starts with no daemon present, it (a) spawns a child process via `child_process.spawn` with `detached: true` and `stdio: 'ignore'`, (b) calls `child.unref()`, (c) writes a JSON-RPC `initialize` request through stdio and confirms it reaches the daemon via the unix socket, (d) the spawned child's pid is recorded in the PID file. Test must inject the daemon binary path (env var or constructor arg) so the test daemon is a tiny vitest fixture, not the real MCP server.
vitest: plugins/flow/mcp-server/src/__tests__/proxy-spawn.test.ts

**AC2 (lockfile lifecycle — spawn, reuse, respawn-on-stale):** A vitest unit test exercises three flows against the proxy's daemon-acquisition logic: (a) no PID file exists → proxy spawns daemon, writes PID file, connects socket; (b) PID file exists and `kill(pid, 0)` returns truthy AND connect-probe succeeds → proxy reuses, no spawn; (c) PID file exists but `kill(pid, 0)` returns ESRCH (stale PID, daemon crashed) → proxy unlinks PID + socket, spawns new daemon. Each branch asserts the observed action (spawn count, PID-file contents, connect attempts) against a vitest mock of `child_process.spawn`, `process.kill`, and `net.connect`. The flock-based concurrent-spawn race (per Q4 hybrid recommendation) is exercised by a fourth case asserting that two concurrent acquire calls result in one spawn, one wait-and-reuse.
vitest: plugins/flow/mcp-server/src/__tests__/proxy-lockfile.test.ts

**AC3 (end-to-end — daemon survives proxy SIGTERM):** A vitest integration test under `tests/` (not `src/__tests__/`) drives the real proxy script (`plugins/flow/mcp-proxy/bin/mcp-proxy.js`) against the real built MCP daemon (`plugins/flow/mcp-server/dist/index.js`). The test (a) starts the proxy with stdio piped, (b) sends one JSON-RPC `initialize` request, awaits the response, (c) captures the daemon's pid from the PID file, (d) sends `SIGTERM` to the proxy via `process.kill(proxy.pid, 'SIGTERM')`, (e) waits 2 seconds, (f) asserts `process.kill(daemonPid, 0)` returns truthy (daemon alive) and the daemon's ppid is now 1 (reparented to init). Cleanup: SIGKILL the daemon at test end. Test is darwin-only (`describe.skipIf(process.platform !== 'darwin')`); Linux/Windows are out of scope for v1.1 per the spike's platform scoping.
vitest: plugins/flow/mcp-server/tests/proxy-daemon-survives-sigterm.integration.test.ts

**AC4 (plugin manifest points at proxy):** `plugins/flow/.claude-plugin/plugin.json` is updated so `mcpServers.crew.command` is `${CLAUDE_PLUGIN_ROOT}/mcp-proxy/bin/mcp-proxy.js` (no `args`, no `node` wrapper — the shim file begins with a `#!/usr/bin/env node` shebang and is executable). The `cwd` field stays as `${CLAUDE_PLUGIN_ROOT}`. The manifest file's structure is otherwise unchanged.
artifact: plugins/flow/.claude-plugin/plugin.json

**AC5 (proxy script exists, executable, shebang):** The file `plugins/flow/mcp-proxy/bin/mcp-proxy.js` exists, begins with `#!/usr/bin/env node`, and has mode `0755` (executable bit set; `fs.statSync(path).mode & 0o111` is truthy). The source is checked in under `plugins/flow/mcp-proxy/src/` (TypeScript) and built/normalised into `plugins/flow/mcp-proxy/bin/` per the existing `mcp-server/scripts/normalise-dist.mjs` pattern. The committed `bin/mcp-proxy.js` is the runtime artefact the manifest points at.
artifact: plugins/flow/mcp-proxy/bin/mcp-proxy.js

**AC6 (unix socket bound at mode 0600 under ~/.flow/):** A vitest unit test asserts the daemon's socket-binding path. When the daemon starts, it (a) creates `~/.flow/` with mode `0700` if missing, (b) binds the unix socket at `~/.flow/mcp-daemon.sock`, (c) `fs.statSync(socketPath).mode & 0o777` equals `0o600`. The test uses a temp `HOME` env override (`process.env.HOME = tmpdir`) so the real `~/.flow/` is not touched. Per Q5's verdict (`socket-auth: filesystem-permission-only`), no token-handshake is implemented; the daemon optionally verifies peer EUID via `getsockopt(LOCAL_PEEREUID)` as defence-in-depth (covered by the same test asserting the verify hook is wired, even if the verify call is a no-op on platforms without the API).
vitest: plugins/flow/mcp-server/src/__tests__/daemon-socket-mode.test.ts

## Story 5.34: Auto-merge gate: grant generalist-dev the repo-view + api gh subcommands

> Added 2026-05-29 after the bmad:6.3 close-out failure: the reattached orphan reviewed READY FOR MERGE, then `runAutoMergeGate` died on a `repo-view` denial; story 6.3 still landed in `done/` and PR #180 was merged manually.
> Source: `_bmad-output/implementation-artifacts/5-34-auto-merge-gate-gh-allowlist-repo-view-api.md`.

As the operator orchestrating `/flow:start` and the generalist-dev agent that runs the auto-merge gate,
I want `generalist-dev`'s gh allowlist to include the `repo-view` and `api` subcommands that `runAutoMergeGate` actually invokes,
So that the auto-merge gate stops throwing `GhSubcommandDeniedError (NFR17)` on its `pause-needs-human` branch and can complete the merge/label decision it was built to make, instead of dying silently after a clean review on every story.

**Context:** `runAutoMergeGate` (`plugins/flow/mcp-server/src/tools/run-auto-merge-gate.ts`) defaults to role `generalist-dev` (`const role = opts.role ?? "generalist-dev"`) and loads that role's permissions via the production `loadRolePermissions` path. On its `auto-merge` branch it calls `gh pr merge` (subcommand `pr-merge`). On its `pause-needs-human` branch it first calls `gh repo view --json owner,name` (subcommand `repo-view`) to resolve owner/repo, then `gh api POST /repos/<owner>/<repo>/issues/<prNumber>/labels` (subcommand `api`) to apply the `needs-human` label. But `plugins/flow/permissions/generalist-dev.yaml` has `gh_allow: [pr-create, pr-view, pr-comment, pr-merge]` — it is missing both `repo-view` and `api`. So the gate throws `GhSubcommandDeniedError` and is blocked for every story. (`generalist-reviewer.yaml` has `[pr-diff, pr-view, api, repo-view]`, which is why reviewer-side tools like `postReviewerComments`/`applyReviewerLabels` work — they run as the reviewer role.) The defect was latent since the auto-merge gate shipped (PR #154) and was masked because the gate's vitest tests mock the gh layer AND their in-test permission fixtures include `repo-view`, so the real-allowlist gap never surfaced. It was discovered 2026-05-29 draining story bmad:6.3. The fix adds `repo-view` and `api` to the real `generalist-dev.yaml` allowlist (keeping the existing four) and adds regression coverage that exercises the REAL loaded role allowlist — not a mock fixture — so the mock-masking gap that hid this cannot recur.

**Acceptance Criteria:**

**AC1:** `plugins/flow/permissions/generalist-dev.yaml`'s `gh_allow` list contains both `repo-view` and `api`, in addition to the existing `pr-create`, `pr-view`, `pr-comment`, and `pr-merge` entries. No existing entry is removed and no other field of the file is changed. This is a deterministic content-structure check against the production permission file.
artifact: plugins/flow/permissions/generalist-dev.yaml

**AC2 (integration — regression):** A vitest test drives `runAutoMergeGate` down BOTH the `pause-needs-human` branch and the `auto-merge` branch, loading the REAL `generalist-dev` role permissions via the production `loadRolePermissions` path (NOT a hand-built or mock `gh_allow` array), with the gh shell-out itself faked or run in dry-run. It asserts that neither path throws `GhSubcommandDeniedError` for `repo-view`, `api`, or `pr-merge`. This is the regression guard for the 2026-05-29 bmad:6.3 close-out failure.
vitest: plugins/flow/mcp-server/src/tools/__tests__/run-auto-merge-gate.test.ts

**AC3 (regression):** A vitest test loads the real `generalist-dev.yaml` via `loadRolePermissions({ role: "generalist-dev" })` and asserts its `gh_allow` is a superset of every gh subcommand `runAutoMergeGate` can invoke (`pr-merge`, `repo-view`, `api`). The test reads the PRODUCTION permission file, not a fixture, so the mock-masking gap that hid this defect cannot recur.
vitest: plugins/flow/mcp-server/src/state/__tests__/load-role-permissions.test.ts


