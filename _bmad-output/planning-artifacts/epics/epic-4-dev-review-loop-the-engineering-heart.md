# Epic 4: Dev + Review Loop — The Engineering Heart

A primed backlog drains end-to-end with PRs raised, reviewed, labelled, and auto-merged or paused.

## Carry-forward from Epic 3 retro (2026-05-21)

These items were captured during the Epic 3 retrospective. When authoring Epic 4 stories, fold them in as ACs on existing stories where they fit, or spin them out as small standalone stories. None blocks Epic 4 kickoff.

- **[High] `detectInProgressHandEdit` wiring** — already added to Story 4.1 below (closes Story 3.7 AC3 / FR14a).
- **[Medium] Spec amendment tracking.** Story 3.5 needed a mid-flight spec amendment that landed only on local disk because `_bmad-output/implementation-artifacts/` is gitignored. Either un-ignore that directory (with implications for run-state / scratch artefacts), or move spec amendments to a tracked path. Likely needs its own story. May fit better in Epic 6 (calibration / standards evolution) than Epic 4 — revisit at planning time.
- **[Low] Surface I/O warnings in `validatePlannerBacklog`.** Add an `io_warnings?: string[]` field to the structured return. Today when `listSourceStories` throws and the pending batch already contains a ship-gate, the tool returns `{ok: true}` and the I/O error reaches `console.error` only. Real product-correctness gap on a rare path.
- **[Low] Native-source-only dedup in planner inventory display.** When a `.flow/native-stories/<ULID>.md` already has a manifest, the planner lists it twice. Cosmetic but visible during planning.
- **[Low] Move ref-format validation upstream into the planning-discipline gate.** Today malformed `depends_on` refs fail at the writer layer (Story 3.4) rather than at planning-discipline (Story 3.5). Layering improvement.
- **[Low] Friendlier `git rev-parse failed` message on no-HEAD scratch repos.** When operator-smoke uses a fresh `git init` scratch repo, the planner emits a scary-looking error. Doesn't break anything; polish for smoke sessions.

## Story 4.1: `claim-story`, dependency check, and `complete-story` MCP tools

As a plugin maintainer,
I want atomic claim and complete primitives that enforce dependency order and never observe a story in two states,
So that the dev loop has a trusted state-transition surface.

**Acceptance Criteria:**

**Given** a story in `to-do/` with all `depends_on` refs present in `done/`,
**When** `claim-story` is called,
**Then** the manifest is atomically moved to `in-progress/` with `claimed_by` set to the session ulid. _(FR17, FR18)_

**Given** a story whose `depends_on` references at least one ref not in `done/`, **When** `claim-story` is called, **Then** it returns a typed `DependenciesNotReadyError` and the manifest stays in `to-do/`. _(FR18)_

**Given** a story in `in-progress/` claimed by the calling session, **When** `complete-story` is called, **Then** the manifest is atomically moved to `done/`. _(FR19)_

**Given** a story claimed by a different session, **When** `complete-story` is called, **Then** it returns a typed `WrongClaimantError`.

**Given** a story whose `in-progress/` manifest has been hand-edited since claim, **When** `claim-story` (or any state-mutating MCP tool on the in-progress layer) is called for that ref, **Then** it invokes `detectInProgressHandEdit` from Story 3.7 on entry and refuses to proceed by propagating the typed `InProgressHandEditError` to the caller. _(FR14a, closes Story 3.7 AC3)_

**AC6 (integration):** vitest covers all five branches against a fixture; chaos test asserts no manifest observed in two state dirs across 1,000 concurrent claim attempts.

## Story 4.2: `/start` skill and per-story dev subagent spawn

As a plugin operator,
I want `/<plugin>:start` to launch the dev session and spawn a clean-context dev subagent for each claimed story,
So that the backlog drains without manual intervention and without mega-agent context drift.

**Acceptance Criteria:**

**Given** a target repo with stories in `to-do/`,
**When** I run `/<plugin>:start`,
**Then** the dev session claims the next ready story (FR18 deps satisfied) and spawns a dev subagent via the Task tool with a clean context, system prompt assembled from `generalist-dev` persona body + Knowledge section. _(FR15, FR24)_

**Given** the dev subagent's prompt assembly, **When** it runs, **Then** the persona file is read once at spawn; the subagent does not re-read mid-flight. _(Architecture §Agent invocation model)_

**Given** an empty `to-do/` and an empty `in-progress/`, **When** the dev session runs, **Then** it terminates naturally with a clear "queue drained" message. _(FR22)_

**AC4 (integration):** vitest runs `/start` against a 3-story fixture and asserts three subagents spawn in sequence with clean contexts.

## Story 4.3: Dev → reviewer handoff, reviewer spawn, and rework signal

As a plugin maintainer,
I want the dev subagent to hand off via a locked phrase and a clean-context reviewer subagent to spawn on receipt,
So that the verdict comes from a subagent whose context contains no implementation reasoning.

**Acceptance Criteria:**

**Given** the dev subagent has finished implementation,
**When** it emits the handoff phrase `Handoff to reviewer — story <ref> ready for review.`,
**Then** the dev session spawns a per-story reviewer subagent with a clean context, system prompt from `generalist-reviewer` persona. _(FR26, FR27)_

**Given** a reviewer that returns `NEEDS CHANGES`, **When** the dev subagent re-runs against the same story, **Then** the integration-AC failure is recorded as a rework signal (`rework_count` incremented) and the story stays in `in-progress/`. _(FR28)_

**Given** locked-phrase drift (dev emits a paraphrase), **When** the dev session parses, **Then** the parse fails and the story is blocked with `blocked_by: handoff-grammar`. _(Pattern enforcement)_

**AC4 (integration):** vitest covers happy handoff, rework loop, and grammar-drift block paths.

## Story 4.3b: Harness-side `Task`-spawn seam for `runDevSession`

As a plugin maintainer,
I want the `/flow:start` SKILL.md prose layer to drive the `Task` tool directly and feed the captured transcript into `runDevSession`, rather than the MCP tool spawning subagents itself,
So that `/flow:start` actually runs the inner dev↔reviewer cycle in production — today the MCP tool's `taskSpawnWithTranscript` parameter can't accept a closure over the wire, so the default empty-transcript stub fires for every claimed story and stamps `blocked_by: handoff-grammar` end-to-end. Without this seam, the user-surface ACs that Stories 4.2 and 4.3 verified through dependency injection are inert in a real session.

**Acceptance Criteria:**

**Given** a claimed story in `in-progress/`, **When** the operator runs `/flow:start` in a real Claude Code session, **Then** the SKILL.md prose invokes the `Task` tool to spawn the per-story dev subagent (using the prompt computed by `buildPersonaSpawnPrompt`), captures the dev's final transcript, and passes that transcript into `runDevSession` (or its successor) — no MCP tool attempts to spawn subagents on its own. _(FR-new)_

**Given** the dev subagent emits the locked handoff phrase, **When** the SKILL.md prose detects it, **Then** the prose layer spawns the reviewer subagent via `Task` (clean context, reviewer persona prompt), captures the reviewer transcript, and feeds it back into the MCP layer for verdict parsing and manifest update — the dev↔reviewer cycle's transitions are observable in the operator's chat surface (AC1/AC2/AC3 lines from Story 4.3 emit verbatim during a live run). _(FR26, FR27, FR28)_

**Given** the new seam, **When** the MCP `runDevSession` API is refactored, **Then** `taskSpawnWithTranscript` is removed (or repurposed as a pure transcript-parsing entrypoint that takes already-captured transcripts as input); the MCP tool no longer holds any subagent-spawn responsibility. _(Architecture cleanup)_

**AC4 (integration):** vitest's existing AC4 branches (happy / rework / grammar-drift) still pass against the refactored API, and a new content-structure test asserts that SKILL.md prose contains the `Task` tool invocation sites for both dev and reviewer.

**AC5 (user-surface):** an operator running `/flow:start` against a scratch repo with at least one ready story observes the AC1/AC2/AC3 chat-surface lines from Story 4.3 (handoff received / re-spawning / grammar drift) in the live session, not just in unit-test fixtures.

## Story 4.3c: Call `completeStory` after `READY FOR MERGE` so the queue drains

As a plugin operator,
I want `/flow:start` to mark a story `done` once the reviewer returns `READY FOR MERGE` (and equivalently for the `done-blocked-*` branches — those stamp `blocked_by` and stop advancing on that story),
So that the backlog actually drains across multiple stories — today the manifest stays in `in-progress/` after a green verdict, so the next pass returns `waiting on in-progress work` forever and no second story is ever claimed without manual intervention.

Surfaced during 4.3b operator smoke (PR #105 retro): two seeded stories ran the full dev↔reviewer cycle and both reached `READY FOR MERGE`, but neither moved to `done/` — the queue stalled at the third pass. This story is a temporary bridge until Story 4.10b's auto-merge gate lands; for v1 dogfooding, completion is "reviewer said ready" rather than "PR merged on GitHub".

**Acceptance Criteria:**

**Given** `processReviewerTranscript` returns `{ next: "done-ready-for-merge", ... }`, **When** the SKILL.md prose handles the verdict, **Then** the prose layer calls `completeStory({ targetRepoRoot, ref, sessionUlid })` to atomically move the manifest from `in-progress/<ref>.yaml` to `done/<ref>.yaml` (Story 4.1 FR19 semantics) before looping back to `claimNextStory`. The operator observes a verbatim chat-surface line `story <ref> moved to done — claiming next` at the end of that story's cycle. _(FR19, FR-new)_

**Given** `processReviewerTranscript` returns `{ next: "done-blocked-reviewer-verdict" }` or `{ next: "done-blocked-reviewer-grammar" }`, **When** the SKILL.md prose handles either verdict, **Then** the prose layer does NOT call `completeStory` — the story stays in `in-progress/` with `blocked_by` already stamped by the MCP tool, and the prose emits the verbatim blocked chat line from Story 4.3 unchanged. (We do not auto-blocked-resolve in v1.) _(Architecture clarity)_

**Given** the SKILL.md prose's `allowed_tools` array, **When** the inner cycle runs, **Then** `completeStory` is in the array (set-equality must widen from Story 4.3b's seven-tool set to include it). _(Tool surface)_

**AC4 (integration):** vitest covers the full claim → dev → reviewer-ready → complete → claim-next loop end-to-end against a tmpdir fixture with two ready stories; final disk state has both manifests in `done/` and `to-do/` / `in-progress/` empty.

**AC5 (user-surface):** an operator running `/flow:start` against a scratch repo with two ready stories observes both manifests reach `done/` and the operator sees `story <ref> moved to done — claiming next` after each.

## Story 4.4: Dev subagent `git push` and `gh pr create` terminal action

As a plugin maintainer,
I want the dev subagent to push and open a PR following the pinned commit/PR conventions,
So that downstream stories (review, auto-merge) have a consistent PR shape to operate on.

**Acceptance Criteria:**

**Given** a finished implementation,
**When** the dev subagent emits its terminal action,
**Then** it creates a branch `story/<ref-slug>-<title-slug>`, commits in conventional-commits format with body wrapping at 72, and opens a PR via `gh pr create` with title `<type>(<ref>): <story title>` and a machine-section body (story link, ACs checklist) followed by a free-form summary. _(FR29, Pattern §9)_

**Given** the dev subagent's permission spec, **When** it attempts `--no-verify` or unsanctioned `--force-with-lease`, **Then** the execa wrapper refuses the call. _(Pattern §9, NFR16)_

**AC3 (integration):** vitest runs the dev terminal action against a fixture repo and asserts branch name, commit shape, and PR shape match conventions.

## Story 4.5: `gh-error-map.yaml` and recoverable-error classification

As a plugin maintainer,
I want a versioned mapping of `gh` exit codes and stderr patterns to `defer | retry | needs-human`,
So that `gh` rate limits, auth expiry, and network blips don't cascade into spurious story failures.

**Acceptance Criteria:**

**Given** `plugins/<plugin>/permissions/gh-error-map.yaml`, **When** parsed, **Then** each entry declares `exit_code`, optional `stderr_regex`, and `class` (`defer | retry | needs-human`). _(NFR18)_

**Given** a `gh` call that fails with a mapped error,
**When** the execa wrapper inspects the result,
**Then** it raises a typed `GhRecoverableError` carrying the class; the dev session moves the story to `blocked/` with `blocked_by: gh-<class>` rather than marking it failed. _(NFR18)_

**AC3 (integration):** vitest stubs `gh` to return each mapped error class and asserts story stays in `in-progress/` or moves to `blocked/`, never to a failed state.

## Story 4.6: Reviewer subagent — read sources and run ACs

As a plugin maintainer,
I want the reviewer subagent to read the story, diff, and standards before any commentary is produced,
So that downstream comment-posting always operates on validated, executed-AC results rather than raw diff guesses.

**Acceptance Criteria:**

**Given** a PR opened by the dev subagent,
**When** the reviewer subagent boots,
**Then** it reads the source story (via the adapter), the PR diff (via `gh pr diff`), and `docs/standards.md`; all three reads complete before any verdict reasoning begins. _(FR30, FR32)_

**Given** the story's acceptance criteria, **When** the reviewer runs them, **Then** runnable ACs (integration-tagged ones in particular) are executed and pass/fail results are captured in memory for the comment-posting step. _(FR31)_

**Given** the standards-doc lookup, **When** the reviewer reads it, **Then** the criteria array is held in memory keyed by id so each can be checked against the diff independently. _(FR32)_

**AC4 (integration):** vitest drives the reviewer's read-and-execute phase against a fixture PR and asserts (a) all three reads succeed, (b) integration-AC execution returns structured pass/fail per AC.

## Story 4.6b: Reviewer posts inline comments and summary verdict

As a plugin operator,
I want the reviewer's executed-AC results and standards judgements posted as inline-and-summary comments on the PR,
So that I can scan the PR and see exactly what passed, what failed, and the bottom-line verdict.

**Acceptance Criteria:**

**Given** the in-memory pass/fail results from Story 4.6,
**When** the reviewer posts,
**Then** inline review comments are posted on the diff lines they reference. _(FR33)_

**Given** the reviewer's summary comment, **When** posted, **Then** its final line matches exactly one of: `**Verdict: READY FOR MERGE**`, `**Verdict: NEEDS CHANGES** [<N> issues, <M> questions]`, or `**Verdict: BLOCKED** [<reason>]`. _(FR34)_

**Given** verdict-grammar drift in the reviewer's output, **When** the dev session parses it, **Then** the verdict is treated as `BLOCKED [reviewer-grammar-error]` and the PR is labelled `needs-human`. _(Pattern §12)_

**AC4 (integration):** vitest drives the reviewer against fixture PRs (one passing, one needs-changes, one grammar-drift) and asserts each branch produces the expected inline + summary comments.

## Story 4.7: Verdict version stamping and footer-marker idempotent rerun

As a plugin operator reading a verdict weeks later,
I want every verdict comment to carry the standards-doc version and the plugin version that produced it,
And I want reruns to edit the prior verdict, not stack new ones.

**Acceptance Criteria:**

**Given** the reviewer's summary comment,
**When** posted,
**Then** the body includes both `standards_version` (parsed from `docs/standards.md`) and `plugin_version` (from the plugin manifest) in a stable format, and ends with the footer marker `<!-- crew:verdict:<plugin-version>:<ref> -->`. _(FR35, NFR22)_

**Given** a PR with a prior verdict comment,
**When** the reviewer reruns,
**Then** it locates the prior comment by grepping for the footer marker and edits it in place; no new comment is posted. _(FR39, NFR11)_

**AC3 (integration):** vitest runs the reviewer twice on the same PR and asserts a single verdict comment with edited body.

## Story 4.8: Reviewer labels and negative-capability enforcement

As a plugin operator,
I want every reviewer run to label the PR appropriately and never close, merge, push, or edit,
So that the reviewer cannot accidentally take a destructive action.

**Acceptance Criteria:**

**Given** a successful reviewer run, **When** complete, **Then** the PR carries the label `reviewed-by-agent`; on `NEEDS CHANGES`, `BLOCKED`, or reviewer-failure, the PR also carries `needs-human`. _(FR36)_

**Given** the reviewer's permission spec, **When** the reviewer attempts `pr-close`, `pr-merge`, `pr-review --request-changes`, or any push-capable subcommand, **Then** the execa wrapper refuses the call. _(FR37, FR38, NFR16)_

**AC3 (integration):** vitest covers each label branch and each refused negative capability.

## Story 4.8b: Deterministic seam hardening — handoff parser and PR URL extraction

As a plugin maintainer,
I want the dev → reviewer handoff to source `prNumber` from a tool-written state file rather than scanning the dev's chat transcript with a regex,
So that the seam survives prose drift in the dev agent's narration.

**Acceptance Criteria:**

**Given** `runDevTerminalAction` completes a successful `gh pr create`, **When** the tool returns, **Then** it atomically writes `<targetRepoRoot>/.flow/state/sessions/<sessionUlid>/dev-outcome.json` containing `{ prUrl, prNumber, branch, commitSha }`. _(seam reliability; replaces LLM-text extraction)_

**Given** `processDevTranscript` runs after a successful handoff parse, **When** `dev-outcome.json` exists and validates, **Then** the tool reads `prNumber` from the file and skips the `PR_URL_RE` regex scan; on ENOENT it falls back to the existing transcript regex unchanged; on malformed/invalid JSON it throws `DevOutcomeFileMalformedError` with NO transcript fallback. _(robust primary path + back-compat fallback + fail-loud on write-seam bugs)_

**AC3 (integration):** vitest covers (a) write path on success, (b) file-present read path with no PR URL in transcript, (c) fallback to transcript scan when file absent, (d) malformed-file error without fallback, (e) non-regression on Story 4.3 / 4.3b / 4.5 / 4.6 branches.

## Story 4.9: Risk-tiering spec format and override resolution

As a plugin maintainer,
I want a parseable risk-tiering spec format with a shipped default and target-repo override path,
So that the classifier in Story 4.9b has a stable contract to consume.

**Acceptance Criteria:**

**Given** the risk-tiering spec at `plugins/<plugin>/docs/risk-tiering.md`,
**When** parsed,
**Then** the YAML block declares `tiers:` with `path_patterns`, `change_types` (revert | migration | schema | dep-bump), and `diff_size_thresholds`; the body is human-readable Markdown. _(Architecture §Risk-tier classification)_

**Given** an optional override at `<target-repo>/docs/risk-tiering.md`,
**When** the spec loader runs,
**Then** the override is picked when present, else the shipped default; both files validate against the same Zod schema. _(FR40a)_

**Given** a malformed risk-tiering spec, **When** the loader parses, **Then** it raises a typed `MalformedRiskTieringSpecError` with a human-readable error citing the offending key. _(FR40a)_

**AC4 (integration):** vitest covers (a) shipped-default loads, (b) override wins when present, (c) malformed override errors clearly.

## Story 4.9b: Risk-tier classifier code, evidence stamping, and fallback

As a plugin operator,
I want each story stamped with a `risk_tier` derived from path patterns, change types, and diff size,
So that the auto-merge gate has a deterministic input rather than a vibes call.

**Acceptance Criteria:**

**Given** a story's diff and the loaded spec from Story 4.9,
**When** `classify-risk-tier` runs,
**Then** it returns `{ tier: low | medium | high, matched_rule: <rule-id>, evidence: { paths, change_types, diff_size } }`. _(FR40a)_

**Given** a diff matching no declared rule,
**When** the classifier runs,
**Then** it returns `tier: medium` with `matched_rule: "fallback"`. _(FR40a fallback)_

**Given** a classified story,
**When** the result lands,
**Then** `risk_tier` is stamped in the manifest and the evidence block is recorded in the verdict comment body. _(Pattern §11)_

**AC4 (integration):** vitest covers four classification branches (path match, change-type match, size match, fallback) and asserts evidence is stamped both places.

## Story 4.10: Agreement metric helper (`compute-agreement`)

As a plugin maintainer,
I want a deterministic agreement-metric helper that reads JSONL telemetry and reports the rolling verdict-vs-action ratio,
So that the auto-merge gate in Story 4.10b has a measurable input rather than a hardcoded threshold.

**Acceptance Criteria:**

**Given** the telemetry log with `reviewer.verdict` events carrying both `verdict` and `eventual_merge_action`,
**When** `compute-agreement` runs over a configurable rolling window (default `last_n_verdicts: 50`),
**Then** it returns a pure deterministic ratio (agreement count / window size) along with the window's verdict distribution. _(FR67, NFR24)_

**Given** an empty or sub-window telemetry log,
**When** the helper runs,
**Then** it returns `null` (insufficient data) rather than a misleading zero. _(NFR24)_

**Given** a `reviewer.verdict` event whose `eventual_merge_action` has not yet been resolved (PR still open),
**When** the helper computes,
**Then** the unresolved event is excluded from the window. _(FR67)_

**AC4 (integration):** vitest seeds telemetry across (a) a fully-resolved window, (b) a partially-resolved window, (c) an empty log; the helper returns the expected values.

## Story 4.10b: Auto-merge gate, medium/high pause, and user override

As a plugin operator,
I want low-risk PRs to auto-merge only once the reviewer has earned my trust,
And to always retain the ability to merge manually regardless of verdict.

**Acceptance Criteria:**

**Given** a PR with `verdict: READY FOR MERGE`, `risk_tier: low`, and `agreement_metric ≥ threshold` (default 0.8, configurable via `plugin.agreement_threshold` in `.flow/config.yaml`),
**When** the auto-merge gate runs,
**Then** the plugin calls `gh pr merge` on the PR. _(FR40)_

**Given** a PR with `risk_tier: medium` or `risk_tier: high` (regardless of verdict),
**When** the auto-merge gate runs,
**Then** the PR is paused with the `needs-human` label and no merge action is taken. _(FR41)_

**Given** a PR with verdict `READY FOR MERGE`, `risk_tier: low`, but `agreement_metric` below threshold (or `null`),
**When** the auto-merge gate runs,
**Then** the PR is paused with `needs-human` and the surface line names the reason (sub-threshold or insufficient data). _(FR40)_

**Given** a PR with verdict `NEEDS CHANGES` or `BLOCKED`,
**When** the user runs `gh pr merge` manually,
**Then** the plugin does not interfere — override authority is preserved. _(FR42)_

**AC5 (integration):** vitest covers (a) auto-merge fires, (b) medium pauses, (c) high pauses, (d) low + sub-threshold pauses, (e) low + insufficient-data pauses, (f) manual merge override.

## Story 4.11: Yield protocol — locked phrase, domain routing, in-domain insistence

As a plugin operator,
I want generalists to yield to hired specialists when work falls in the specialist's `domain:`,
So that the rubber-stamping "AI reviews AI" failure mode is structurally avoided.

**Acceptance Criteria:**

**Given** a generalist reviewer encountering work inside a hired specialist's `domain:`,
**When** it emits the locked yield phrase `This sits in <role>'s domain — handing off.`,
**Then** the runtime looks up the role by exact-match domain, spawns the specialist reviewer subagent with a clean context, and routes the review. _(FR99, FR100, FR102)_

**Given** a specialist asked to defer inside its own domain,
**When** the specialist runs,
**Then** it refuses to defer even when another agent has produced a contrary verdict (in-domain insistence). _(FR101)_

**Given** a yield whose named role has no hired match,
**When** the runtime looks up the domain,
**Then** the yield surfaces as `[routing-failure] no hired role matches domain "<x>"` on the orchestration surface; the story is blocked with `blocked_by: routing-failure`. _(FR100)_

**Given** any yield, **When** routing succeeds, **Then** a `yield.handoff` telemetry event records both roles and the triggering domain. _(FR103, NFR29)_

**Given** work where no hired specialist's domain matches, **When** the generalist runs, **Then** the generalist handles the work without yield. _(FR104)_

**AC6 (integration):** vitest covers the five yield branches against a fixture with a hired security specialist.

## Story 4.12: Per-invocation telemetry and runtime soft/hard limits

As a plugin maintainer,
I want every agent invocation to record an `agent.invoke` event and every reviewer verdict to record a `reviewer.verdict` event,
So that the agreement metric, outcome stats, and skill effectiveness all have authoritative data.

**Acceptance Criteria:**

**Given** any agent subagent spawn, **When** the subagent runs, **Then** the dev session writes an `agent.invoke` event (agent type, story id, wall-clock runtime, timestamp). _(FR65)_

**Given** any reviewer summary comment, **When** posted, **Then** a `reviewer.verdict` event is written carrying PR number, verdict sentinel, standards version, plugin version, and the eventual merge action (filled in retrospectively when the PR closes). _(FR66)_

**Given** a reviewer exceeding 8 min wall-clock, **When** the dev session inspects, **Then** it substitutes the verdict comment with a failure comment, applies `needs-human`, and does not mark the story failed. _(NFR2)_

**Given** a dev subagent exceeding its per-story budget (default 30 min),
**When** the orchestration session next polls,
**Then** it surfaces the story as stuck. _(NFR3, see also Story 5.4)_

**AC5 (integration):** vitest covers (a) `agent.invoke` written on every spawn, (b) `reviewer.verdict` written on every verdict comment, (c) hard-8-min substitution, (d) 30-min dev budget surfaces in the next poll.

---
