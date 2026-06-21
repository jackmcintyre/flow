# Story 4.8: Reviewer labels and negative-capability enforcement

story_shape: user-surface

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin operator**,
I want **every reviewer run to label the PR with `reviewed-by-agent` (always) and `needs-human` (on any non-green outcome), and the reviewer to be structurally incapable of closing, merging, pushing, or requesting changes via the GitHub API**,
so that **I can scan the PR list and see at a glance which PRs have been agent-reviewed and which need manual attention — without risking that a reviewer bug accidentally merges or closes a PR it was only supposed to comment on**.

### What this story is, in one sentence

Introduce a new MCP tool `applyReviewerLabels` that the `/crew:start` inner cycle invokes after `processReviewerTranscript` (and also in the error handler when the reviewer cycle fails), and tighten `generalist-reviewer.yaml` by removing two unused and potentially-destructive subcommands (`pr-comment`, `pr-review`) from `gh_allow` — so the execa wrapper structurally refuses those calls rather than relying on prose instructions not to make them.

### What this story does (and why it needs its own story)

Story 4.6b shipped the comment-posting surface; Story 4.7 made reruns idempotent. But neither story touches the PR label surface. A reviewer can complete a full pass — read sources, execute ACs, post a verdict comment — and leave the PR with no label. An operator scanning the PR list has no signal to distinguish "agent-reviewed, needs action" from "not yet reviewed".

Two gaps this creates:

1. **No scan-line signal.** Without labels, the operator has to open each PR and read the verdict comment to know whether action is needed. Labels turn the PR list into a triage queue.

2. **Unused permissions on the reviewer's `gh_allow`.** `pr-comment` and `pr-review` were added to the reviewer's permission spec before Story 4.6b replaced them with `gh api` for all reviewer-side posting. They are now unused by any tool in the reviewer chain, but still present — meaning a future bug in a tool using the reviewer's permissions could inadvertently call them. `pr-review` in particular has a `--request-changes` flag that would create a blocking review state, which the reviewer is explicitly not supposed to be able to do (FR37, FR38).

Story 4.8 closes both gaps: (1) adds label-posting via a new `applyReviewerLabels` tool, and (2) tightens the permission spec by removing the two unused subcommands.

### What this story does NOT

- (a) Touch `_bmad-output/implementation-artifacts/sprint-status.yaml`.
- (b) Touch `runReviewerSession`, `postReviewerComments`, or `processReviewerTranscript`. The label tool is a new sibling step in the SKILL.md prose, not a wrapper around the existing tools.
- (c) Create the GitHub labels if they don't exist. v1 assumes `reviewed-by-agent` and `needs-human` are pre-created on the target repo. If `gh api` returns a 422 (label not found), `applyReviewerLabels` propagates `GhApiResponseShapeError` uncaught. A follow-up story can add label-creation bootstrapping (`gh label create --force`); v1's scope is assignment only.
- (d) Remove existing labels (e.g. remove `needs-human` once the dev reworks and the next reviewer pass says `READY FOR MERGE`). Label reconciliation is out of scope for v1; operators can remove labels manually. Labels are additive only.
- (e) Narrow `gh_allow_args` for the `api` subcommand. Story 4.7 surfaced this gap (bare `- api` with no URL or method restriction). Closing it requires `gh_allow_args` to support regex or prefix matching — currently only exact-string matching is implemented. Story 4.8 defers this; it is captured as deferred work (see § Deferred work below). The `api` entry remains broadly permitted in v1.
- (f) Add `pr-edit` or any new subcommand to `gh_allow`. Labels are posted via the existing `api` subcommand (`POST /repos/{owner}/{repo}/issues/{prNumber}/labels` is a GitHub REST API call reachable via `gh api`). No new `gh_allow` entries are needed beyond removing the two unused ones.
- (g) Add the `reviewed-by-agent` or `needs-human` labels to any file the README/install docs tell users to copy. Labels are applied programmatically to the target repo's PR; they are not part of the plugin installation path.
- (h) Emit telemetry. Story 4.12 owns telemetry; v1 adds a `TODO: reviewer.labels_applied` marker.
- (i) Handle the case where the PR has been closed or merged before `applyReviewerLabels` runs. A 404 or 422 from `gh api` propagates as `GhApiResponseShapeError` uncaught — same pattern as `postReviewerComments`.
- (j) Narrow `gh_allow_args["pr-edit"]` for a future `pr-edit` subcommand. `pr-edit` is NOT added to `gh_allow` by this story — labels go through `api`. If a future story adds `pr-edit`, it must handle `gh_allow_args` narrowing at that time.

### Deferred work

- **`api` URL / method narrowing.** `gh_allow_args["api"]` in `generalist-reviewer.yaml` remains `{}` (no restriction). The reviewer can call `gh api` with any URL and any `--method`. Closing this requires extending the `gh_allow_args` enforcement in `gh.ts` to support regex patterns or prefix matching; v1's exact-string match cannot represent dynamic PR URLs (`/repos/{owner}/{repo}/pulls/{n}/reviews/{id}`). Follow-up story: add `gh_allow_args` regex mode and restrict `api` to the reviews and labels endpoints used by `postReviewerComments` and `applyReviewerLabels`.
  - **Scope renegotiation note:** Story 4.7's § DOES NOT (n) explicitly flagged this narrowing as a Story 4.8 MUST. This spec consciously renegotiates that to defer, because the enforcement primitive (`gh_allow_args` regex or prefix matching) doesn't exist yet — adding it is its own engineering work and would double the surface area of Story 4.8. The negative-capability gap is partially closed by Task 1's subcommand removals; full closure waits on the follow-up story that adds the primitive. This is a deliberate scope call, not an oversight.

---

## Acceptance Criteria

> AC1 and AC2 derive from the epic spec for Story 4.8. AC3 is the integration suite. AC4 is the user-surface contract — the operator-observable label signal on the PR. Per `plugins/crew/docs/user-surface-acs.md`, AC4 is tagged `(user-surface)`; the others describe internal behaviour and stay untagged.

**AC1:**
**Given** the `applyReviewerLabels` MCP tool is called after a completed reviewer cycle,
**When** `recommendedVerdict` is `"READY FOR MERGE"`,
**Then** the tool calls `gh api POST /repos/{owner}/{repo}/issues/{prNumber}/labels` with body `{"labels":["reviewed-by-agent"]}` and no other label call is made — `needs-human` is NOT added on a green verdict. _(FR36)_

<!-- Not user-surface: AC1 describes the tool's internal label-posting logic. AC4 carries the operator-observable contract. -->

**AC2:**
**Given** `applyReviewerLabels` is called with any non-green outcome — `recommendedVerdict` is `"NEEDS CHANGES"` or `"BLOCKED"`, OR the caller passes `verdictOverride: "reviewer-failure"` (which takes precedence over `recommendedVerdict` regardless of the file's value, including when `recommendedVerdict === "READY FOR MERGE"`),
**When** the tool runs,
**Then** it makes two `gh api POST` calls in sequence: first adds `reviewed-by-agent`, then adds `needs-human`. Both calls use the same endpoint shape as AC1 (`POST /repos/{owner}/{repo}/issues/{prNumber}/labels`). The two calls are sequential, not batched — the `needs-human` call runs only if `reviewed-by-agent` succeeds, and any `GhApiResponseShapeError` or `GhRecoverableError` on either call propagates uncaught. _(FR36)_

<!-- Not user-surface: AC2 describes the two-label sequence for non-green verdicts. The operator-observable effect is AC4. -->

**AC3:**
**Given** the reviewer's updated `generalist-reviewer.yaml` (with `pr-comment` and `pr-review` removed from `gh_allow`),
**When** any tool invoking `gh()` with the reviewer's permissions attempts the subcommand `pr-close`, `pr-merge`, `pr-review`, or `pr-comment`,
**Then** the `gh` wrapper throws `GhSubcommandDeniedError` before any subprocess is spawned — the enforcement is at the permission-spec layer, not at the prose layer. _(FR37, FR38, NFR16)_

<!-- Not user-surface: AC3 describes the enforcement contract of gh.ts against the permission spec. -->

**AC4 (integration):**
vitest covers:
- (4a) AC1 label branch: `applyReviewerLabels` with `READY FOR MERGE` → exactly one `gh api POST /labels` call with `{"labels":["reviewed-by-agent"]}`; no `needs-human` call.
- (4b) AC2 label branches: `applyReviewerLabels` with `NEEDS CHANGES`, `BLOCKED`, and `verdictOverride: "reviewer-failure"` each → exactly two `gh api POST /labels` calls in sequence.
- (4c) AC3 denial branches: `gh({ role: "generalist-reviewer", permissions, subcommand: "pr-close", ... })` → `GhSubcommandDeniedError`; repeat for `pr-merge`, `pr-review`, `pr-comment`; assert the subcommand was refused before any `execa` call.
- (4d) Error propagation: stub `gh api` to return a `GhRecoverableError` on the first label call; assert `applyReviewerLabels` propagates the error uncaught and the second label call is NOT made.
- (4e) Missing-file path: no `reviewer-result.json` at the expected path (or ENOENT); `applyReviewerLabels` returns `{ next: "skipped-no-session-result" }` without calling `gh`.

<!-- Not user-surface: vitest integration suite — internal harness only. -->

**AC5 (user-surface):**
**Given** a target repo where `/crew:start` has completed a reviewer pass for a story whose verdict is `NEEDS CHANGES`,
**When** the inner cycle invokes `applyReviewerLabels` as part of the post-reviewer step,
**Then** the operator can run `gh pr view <prNumber> --json labels` (or open the PR in GitHub) and observe:
- (a) The label `reviewed-by-agent` is present on the PR.
- (b) The label `needs-human` is present on the PR.
- (c) Running the same command after a `READY FOR MERGE` pass shows `reviewed-by-agent` but NOT `needs-human` (assuming labels were not manually added).

<!-- User-surface: AC5 references `gh pr view <prNumber> --json labels`, a CLI command the operator types verbatim (rubric ii). Smoke-gate via operator-smoke before merging. -->

### Expanded acceptance specifics

**AC1 / AC2 unpacked.** `applyReviewerLabels` tool contract:

- **(1a) Tool signature:** `applyReviewerLabels({ targetRepoRoot: string, sessionUlid: string, verdictOverride?: "reviewer-failure", role?: string, execaImpl?: typeof execa, pluginRootOverride?: string }) → Promise<ApplyReviewerLabelsResult>`. The `role` default is `"generalist-reviewer"`. The `execaImpl` and `pluginRootOverride` seams match `postReviewerComments`'s pattern.
- **(1b) Input resolution:** the tool reads `<targetRepoRoot>/.crew/state/sessions/<sessionUlid>/reviewer-result.json` via `readReviewerResultFile` (shared helper from Story 4.6b). On ENOENT (`null` return), the tool returns `{ next: "skipped-no-session-result" }` without making any `gh` calls. On malformed JSON, propagates `ReviewerResultFileMalformedError` uncaught.
- **(1c) Verdict determination:** if `verdictOverride` is `"reviewer-failure"`, use that regardless of what `reviewer-result.json` says. Otherwise, use `result.recommendedVerdict` from the file.
- **(1d) PR context:** the tool needs `{owner}`, `{repo}`, and `prNumber`. `prNumber` comes from `result.prNumber` (carried in the projection per Story 4.6 §3g). `owner`/`repo` come from calling `gh({ role, permissions, subcommand: "pr-view", args: [String(prNumber), "--json", "baseRepository"] })` — exactly as `postReviewerComments` does in Step 4. `pr-view` remains in `gh_allow`.
- **(1e) Label call shape:** `gh({ role, permissions, subcommand: "api", args: ["/repos/${owner}/${repo}/issues/${prNumber}/labels", "--method", "POST", "--input", "-"], input: JSON.stringify({ labels: [labelName] }), execaImpl })`. This reuses the `--input -` pattern from `postReviewerComments` Task 4a. The `labels` endpoint accepts an array; v1 sends one label per call (two sequential calls for non-green outcomes) to keep error attribution clear.
- **(1f) Response parsing:** parse `JSON.parse(stdout)` and verify it is an array (the labels endpoint returns the updated label list). If parsing fails or it's not an array, raise `GhApiResponseShapeError({ subcommand: "api", url: "/labels", cause })`.
- **(1g) Return value:** `{ next: "applied", labelsApplied: string[] }` on success (the list of labels that were sent, e.g. `["reviewed-by-agent"]` or `["reviewed-by-agent", "needs-human"]`).

**AC3 unpacked.** Negative-capability enforcement:

- **(3a) Removed subcommands:** `generalist-reviewer.yaml` is modified to REMOVE `pr-comment` and `pr-review` from `gh_allow`. After this story, the reviewer's `gh_allow` contains exactly: `pr-view`, `pr-diff`, `api`. Rationale: `pr-comment` and `pr-review` have been unused by any tool in the reviewer chain since Story 4.6b replaced them with `gh api`. Their presence in `gh_allow` is a latent negative-capability hole — `pr-review --request-changes` would create a blocking review state the reviewer is explicitly forbidden from setting. Removal is the structural fix; prose instructions to "not call it" are not the correct enforcement layer.
- **(3b) Already-denied subcommands:** `pr-close`, `pr-merge`, and any push-capable subcommand (`push`, `push-force`) were never in `gh_allow` — they are already denied by the existing `gh` wrapper enforcement. AC3 tests these explicitly to assert the current `gh.ts` enforcement is correct and not accidentally broken by this story's changes.
- **(3c) Verification by loading the real YAML:** the AC4c vitest cases load `generalist-reviewer.yaml` via `loadRolePermissions("generalist-reviewer", pluginRootOverride)` (the production path) and assert `GhSubcommandDeniedError` is thrown without any `execa` call on each denied subcommand. This tests the file change end-to-end through the real permission-loading path.

**AC4 unpacked.** Integration-suite fixture and stub shape:

- **(4a) Fixture base:** tmpdir with `.crew/config.yaml` (adapter: native) and `.crew/state/sessions/<sessionUlid>/reviewer-result.json` written per the variant under test. `pluginRootOverride` points to the worktree's `plugins/crew` directory.
- **(4b) Stub seam for `gh`:** same `makeDiscriminatingStub` pattern as Story 4.6b / 4.7, extended to route:
  - `cmd === "gh" && args[0] === "pr" && args[1] === "view"` → `{"baseRepository":{"name":"crew","owner":{"login":"jackmcintyre"}}}`.
  - `cmd === "gh" && args[0] === "api" && url.includes("/labels")` → `[{"name":"reviewed-by-agent","color":"0075ca",...}]` (the labels endpoint's array response).
  - Both route by inspecting `args[0]` and (for `api`) the URL segment in `args` array.
- **(4c) `reviewer-result.json` variants:** `recommendedVerdict: "READY FOR MERGE"`, `"NEEDS CHANGES"`, `"BLOCKED"`. For the `verdictOverride` case, use a file with `recommendedVerdict: "READY FOR MERGE"` but pass `verdictOverride: "reviewer-failure"` — assert the tool treats it as non-green (two label calls).
- **(4d) Capture label payload:** capture the `input` option on the `gh api` stub; JSON-parse it; assert `{ labels: ["reviewed-by-agent"] }` on the first call and `{ labels: ["needs-human"] }` on the second.
- **(4e) Negative path — recoverable error on first label call:** stub `gh api /labels` to return `{ exitCode: 4, stderr: "API rate limit exceeded" }`; assert `GhRecoverableError` propagates, second label call not made.

**AC5 unpacked.** Operator-smoke contract:

- **(5a) Reproducer:** extend the Story 4.6b / 4.7 operator-smoke harness with an `applyReviewerLabels` call after the `processReviewerTranscript` mock. The same scratch repo, the same reviewer result file (verdict `NEEDS CHANGES`).
- **(5b) Assertions:** the captured `gh api POST /labels` calls show two calls: first for `reviewed-by-agent`, second for `needs-human`. The return value is `{ next: "applied", labelsApplied: ["reviewed-by-agent", "needs-human"] }`.
- **(5c) Non-regression:** Story 4.6b / 4.7 invariants still hold — the in-progress manifest is stamped `blocked_by: "reviewer-verdict-needs-changes"`, NOT moved to `done/`.
- **(5d) Smoke-gate tag:** tagged per `plugins/crew/docs/user-surface-acs.md`. Operator may substitute manual-paste evidence from a real `/crew:start` run showing `gh pr view --json labels` output.

---

## Tasks / Subtasks

Implementation order is load-bearing.

- [x] **Task 1: Remove unused subcommands from `generalist-reviewer.yaml`** (AC: #3)
  - [x] 1.1 Open `plugins/crew/permissions/generalist-reviewer.yaml`. Remove `- pr-comment` and `- pr-review` from `gh_allow`. After this change `gh_allow` contains exactly: `pr-view`, `pr-diff`, `api`. Preserve `gh_allow_args: {}` — empty, unchanged.
  - [x] 1.2 Verify no existing tool under `plugins/crew/mcp-server/src/tools/` calls `gh({ subcommand: "pr-comment", ... })` or `gh({ subcommand: "pr-review", ... })` with role `"generalist-reviewer"` — grep for both strings in the tools directory to confirm zero callers. If a caller is found, STOP and surface the conflict — do not remove the subcommand.
  - [x] 1.3 **Update test fixtures that hand-write `generalist-reviewer.yaml` content.** Two test files contain literal `pr-comment` / `pr-review` lines in their fixture YAML; they will silently drift from production after Task 1.1 unless updated in the same change. After updating, the fixtures must match production's 3-entry `gh_allow` shape (`pr-view`, `pr-diff`, `api`).
    - `plugins/crew/mcp-server/src/tools/__tests__/post-reviewer-comments.test.ts` (around lines 148-153 — the multi-line `gh_allow` block).
    - `plugins/crew/mcp-server/src/__tests__/operator-smoke-helpers/ac5-4-6b-post-reviewer-comments.smoke.test.ts` (around lines 267-272).
    - Do NOT touch `plugins/crew/mcp-server/src/tools/__tests__/build-persona-spawn-prompt.test.ts` — its `pr-comment` line is on the `generalist-dev` persona fixture, NOT `generalist-reviewer`, and is unrelated to this story.
    - Rationale: AC3 asserts the production YAML is loaded via `loadRolePermissions` and the removed subcommands are denied. Hand-written fixtures with stale entries would pass under green ACs while production drifts — exactly the bugfix-1 failure mode this project's planning discipline guards against.
  - [x] 1.4 Run `pnpm build` to confirm the YAML change does not break any TypeScript that imports the permission schema.

- [x] **Task 2: Add `GhApiResponseShapeError` call site for label response** (AC: #1, #2)
  - [x] 2.1 Confirm `GhApiResponseShapeError` (added in Story 4.6b, `errors.ts`) accepts the shape `{ subcommand: string; url?: string; cause: unknown }`. No change needed if it does — this task is a precondition check.

- [x] **Task 3: Implement `applyReviewerLabels` MCP tool** (AC: #1, #2)
  - [x] 3.1 Create `plugins/crew/mcp-server/src/tools/apply-reviewer-labels.ts`. Export `applyReviewerLabels(opts) → Promise<ApplyReviewerLabelsResult>` per AC1/AC2 unpacked signature.
  - [x] 3.2 Step 1 — read `reviewer-result.json` via `readReviewerResultFile`. On `null`, return `{ next: "skipped-no-session-result" }`.
  - [x] 3.3 Step 2 — resolve `prNumber` from `result.prNumber`. Load permissions via `loadRolePermissions(role, pluginRootOverride ?? getPluginRoot())`.
  - [x] 3.4 Step 3 — resolve `owner`/`repo` via `gh({ role, permissions, subcommand: "pr-view", args: [String(prNumber), "--json", "baseRepository"], execaImpl })`. Parse response. Raise `GhApiResponseShapeError` on parse failure (mirror `postReviewerComments` Task 4.4 pattern).
  - [x] 3.5 Step 4 — determine verdict: `verdictOverride ?? result.recommendedVerdict`. Map to label list:
    - `"READY FOR MERGE"` → `["reviewed-by-agent"]`
    - `"NEEDS CHANGES"` | `"BLOCKED"` | `"reviewer-failure"` → `["reviewed-by-agent", "needs-human"]`
  - [x] 3.6 Step 5 — for each label in the list (in order), call `gh({ role, permissions, subcommand: "api", args: ["/repos/${owner}/${repo}/issues/${prNumber}/labels", "--method", "POST", "--input", "-"], input: JSON.stringify({ labels: [label] }), execaImpl })`. Parse response as array; raise `GhApiResponseShapeError` on parse failure. Any `GhRecoverableError` propagates uncaught immediately (abort remaining label calls).
  - [x] 3.7 Step 6 — return `{ next: "applied", labelsApplied: <labels sent> }`.
  - [x] 3.8 Add top-of-file JSDoc citing this story spec.

- [x] **Task 4: Register `applyReviewerLabels` as an MCP tool** (AC: #1, #2)
  - [x] 4.1 Open `plugins/crew/mcp-server/src/tools/register.ts`. Add the import. Register under tool name `"applyReviewerLabels"` with a Zod input schema mirroring the options (all fields optional except `targetRepoRoot` and `sessionUlid`).
  - [x] 4.2 Wrap the handler in the existing `DomainError → { isError: true, content: [...] }` envelope.
  - [x] 4.3 Verify via the existing register-suite tests that the tool is enumerated and callable. Update the tool-count assertion (if present) to include `applyReviewerLabels`.

- [x] **Task 5: Update SKILL.md inner cycle to invoke `applyReviewerLabels`** (AC: #1, #2, #5)
  - [x] 5.1 Open `plugins/crew/skills/start/SKILL.md`. In the `allowed_tools` array, add `applyReviewerLabels`.
  - [x] 5.2 After the `processReviewerTranscript` call (which moves the manifest based on verdict), insert a new step: `applyReviewerLabels({ targetRepoRoot, sessionUlid })`. Log result to chat surface: `reviewer labels applied: ${result.labelsApplied.join(", ")} on PR #${prNumber}`.
  - [x] 5.3 In the error handler for the reviewer cycle (where `postReviewerComments` or `processReviewerTranscript` uncaught errors are surfaced): insert a best-effort `applyReviewerLabels({ targetRepoRoot, sessionUlid, verdictOverride: "reviewer-failure" })` call BEFORE surfacing the original error to the operator. Wrap this call in its own try/catch — if the label call also fails, log the secondary failure but surface the original error unchanged. (The label-on-failure call is best-effort; it MUST NOT mask the original failure.)
  - [x] 5.4 The `skipped-no-session-result` return from `applyReviewerLabels` — log a chat line "apply-reviewer-labels skipped — no reviewer-result.json" and proceed. Do NOT halt; the missing-file case is already surfaced by the prior `processReviewerTranscript` step.

- [x] **Task 6: Implement the integration test suite** (AC: #4)
  - [x] 6.1 Create `plugins/crew/mcp-server/src/tools/__tests__/apply-reviewer-labels.test.ts`.
  - [x] 6.2 Fixture: tmpdir per `beforeEach`; `reviewer-result.json` written per variant; `readReviewerResultFile` path resolved via `pluginRootOverride`.
  - [x] 6.3 Implement AC4 variants (4a)–(4e) as separate `it()` cases. Use `makeDiscriminatingStub` (Story 4.6b shared helper). Capture `input` option on the `gh api /labels` stub to assert the label payload.
  - [x] 6.4 Implement AC3 denial cases: load `generalist-reviewer.yaml` via `loadRolePermissions`, call `gh()` with each denied subcommand, assert `GhSubcommandDeniedError` with no execa call. Use `vi.spyOn(execaImpl, ...)` or a capturing stub to assert zero invocations.
  - [x] 6.5 Use `__resetGhErrorMapCacheForTests()` in `beforeEach`.

- [x] **Task 7: Operator-smoke extension for AC5** (AC: #5)
  - [x] 7.1 Extend the Story 4.6b / 4.7 operator-smoke harness with the `applyReviewerLabels` call per AC5 unpacked (5a)–(5b).
  - [x] 7.2 Assert the two sequential label `gh api POST` calls (using captured `input` fields on the stub).
  - [x] 7.3 Non-regression: Story 4.6b / 4.7 manifest-state invariants still hold per AC5 (5c).
  - [x] 7.4 Tag the test file so it runs in the pre-PR smoke gate.

- [x] **Task 8: Build, vitest, dist** (AC: all)
  - [x] 8.1 `pnpm build` passes. Commit `dist/` per CLAUDE.md.
  - [x] 8.2 All vitest tests pass. Tool-count assertion updated for `applyReviewerLabels`.
  - [x] 8.3 Confirm `canonical-fs-guard.test.ts` still passes.

---

## Behavioural contract (user-surface)

**These invariants are the contract this story makes. They MUST hold at all times in the running plugin.**

### MUST

- **MUST apply `reviewed-by-agent` to every PR that completes a reviewer cycle.** Applied on `READY FOR MERGE`, `NEEDS CHANGES`, `BLOCKED`, and `reviewer-failure`. No reviewer-cycle completion may skip this label.
- **MUST apply `needs-human` in addition to `reviewed-by-agent` on every non-green outcome.** Non-green: `NEEDS CHANGES`, `BLOCKED`, `reviewer-failure`.
- **MUST call the two label-posting `gh api` calls sequentially, not batched.** If the first call fails, the second MUST NOT run. Error attribution is clear: the first `GhRecoverableError` surfaces the failing label name.
- **MUST return `{ next: "skipped-no-session-result" }` on ENOENT for `reviewer-result.json`.** Silent skip — the loud blocker is already surfaced by `processReviewerTranscript`.
- **MUST propagate `GhRecoverableError`, `GhApiResponseShapeError`, and `ReviewerResultFileMalformedError` verbatim.** No swallow, no retry, no paper-over.
- **MUST invoke `applyReviewerLabels` in the error handler with `verdictOverride: "reviewer-failure"` on reviewer-cycle failure.** The error handler MUST wrap this call in its own try/catch so a label-application failure cannot mask the original error.

### MUST NOT

- **MUST NOT batch both label calls into a single `gh api` request.** The GitHub labels endpoint accepts an array, but v1 sends one label per call to keep error attribution clear and the stub seam simple.
- **MUST NOT add `needs-human` on a `READY FOR MERGE` outcome.** The green verdict must not trigger a human-intervention label.
- **MUST NOT mutate the manifest, `reviewer-result.json`, or any state file.** `applyReviewerLabels` is read-only against local state; the only side-effect is the two `gh api` POST calls.
- **MUST NOT call `gh pr-comment`, `gh pr-review`, or any subcommand removed from `gh_allow`.** The permission spec is the enforcement surface; prose instructions are not sufficient.

### NEVER

- **NEVER remove labels from the PR.** Labels are additive only. Removing `needs-human` after a subsequent READY FOR MERGE verdict is explicitly deferred work.
- **NEVER spawn subagents from `applyReviewerLabels` or any MCP tool.** Subagent spawn is exclusively the SKILL.md prose layer's responsibility.
- **NEVER call `gh api` with `--method DELETE` or `--method PUT` in this tool.** v1 only POSTs to the labels endpoint.

---

## Implementation strategy

### Why a separate tool, not extending `postReviewerComments`

`postReviewerComments` is the comment-posting step; it knows the verdict from `reviewer-result.json`. Coupling label-posting into it would conflate two responsibilities (post comments; apply labels) and complicate the `reviewer-failure` error-handling path — when `postReviewerComments` itself fails, we still need to apply `needs-human`, but the call is now inside the failed tool.

A separate `applyReviewerLabels` tool called from SKILL.md prose handles both the normal path (called after `processReviewerTranscript`) and the error path (called in the SKILL.md catch block with `verdictOverride: "reviewer-failure"`) cleanly, without any tool having to inspect its own exception.

### Why remove `pr-comment` and `pr-review` rather than add `gh_allow_args` restrictions

The principle: unused permissions should be removed. `pr-comment` and `pr-review` have been unused in the reviewer's tool chain since Story 4.6b retired them in favour of `gh api`. Adding `gh_allow_args` restrictions on them would be dead code — it restricts calls that no tool makes. Removal is the correct action; it shrinks the attack surface and removes the `pr-review --request-changes` risk structurally.

### Why labels go through `gh api` rather than `gh pr edit`

`gh pr edit --add-label <name>` is the user-facing shorthand, but routing it through the `gh` wrapper would require adding `pr-edit` to `gh_allow`. The `api` subcommand is already in `gh_allow` and is how `postReviewerComments` posts reviews. Reusing it for label assignment keeps the subcommand surface smaller. The downside (`api` being broad) is the deferred narrowing work already flagged.

---

## Locked files

- `plugins/crew/mcp-server/src/tools/complete-story.ts` (Story 4.1)
- `plugins/crew/mcp-server/src/tools/claim-next-story.ts` (Story 4.1 / 4.2)
- `plugins/crew/mcp-server/src/tools/claim-story.ts` (Story 4.1)
- `plugins/crew/mcp-server/src/tools/run-reviewer-session.ts` (Story 4.6)
- `plugins/crew/mcp-server/src/tools/post-reviewer-comments.ts` (Story 4.6b / 4.7 — label-posting is a sibling step, not an extension of this tool)
- `plugins/crew/mcp-server/src/tools/process-reviewer-transcript.ts` (Story 4.6 revision 2)
- `plugins/crew/catalogue/generalist-reviewer.md` (Story 4.6)
- `plugins/crew/permissions/gh-error-map.yaml` (Story 4.5)
- `plugins/crew/mcp-server/src/lib/find-hunk-line.ts` (Story 4.6b)
- `plugins/crew/mcp-server/src/lib/compose-reviewer-summary.ts` (Story 4.6b / 4.7)
- `plugins/crew/mcp-server/src/lib/plugin-version.ts` (Story 1.9)

### Declared-locked-file changes (explicit exceptions)

- **`plugins/crew/permissions/generalist-reviewer.yaml`** (Stories 2.2 / 4.6 / 4.7) — Task 1 removes `pr-comment` and `pr-review` from `gh_allow`. The change is a reduction (no new entries), and is load-bearing for AC3's negative-capability enforcement.
- **`plugins/crew/skills/start/SKILL.md`** (Stories 4.2 / 4.3b / 4.3c / 4.6 / 4.6b / 4.7) — Task 5 adds `applyReviewerLabels` to `allowed_tools`, inserts the label step after `processReviewerTranscript`, and adds the best-effort label call in the error handler. Existing steps are UNTOUCHED.

---

## Dev Notes

### Files this story will create

- `plugins/crew/mcp-server/src/tools/apply-reviewer-labels.ts` (Task 3)
- `plugins/crew/mcp-server/src/tools/__tests__/apply-reviewer-labels.test.ts` (Task 6)

### Files this story will modify

- `plugins/crew/permissions/generalist-reviewer.yaml` (Task 1; remove `pr-comment`, `pr-review`)
- `plugins/crew/mcp-server/src/tools/register.ts` (Task 4)
- `plugins/crew/skills/start/SKILL.md` (Task 5; `allowed_tools` + new post-processReviewerTranscript step + error-handler label call)
- Operator-smoke harness under `plugins/crew/mcp-server/src/__tests__/operator-smoke-helpers/` (Task 7)
- `plugins/crew/mcp-server/dist/` (rebuild; commit per CLAUDE.md)

### Current-state notes on files being modified

- **`generalist-reviewer.yaml`** (current state per Story 4.7): `gh_allow: [pr-view, pr-comment, pr-review, pr-diff, api]`, `gh_allow_args: {}`. Task 1 removes `pr-comment` and `pr-review`, leaving `gh_allow: [pr-view, pr-diff, api]`.
- **`register.ts`** (current state per Story 4.6b / 4.7): enumerates tools including `postReviewerComments`. Task 4 adds `applyReviewerLabels` to the list.
- **`SKILL.md`** (current state per Story 4.7): `allowed_tools` includes `postReviewerComments`; the inner cycle calls `postReviewerComments` → `processReviewerTranscript`. Task 5 inserts `applyReviewerLabels` after `processReviewerTranscript`.

### Testing standards

- vitest with `pnpm vitest --run` from `mcp-server/`.
- `execaImpl` test seam on all `gh` calls; never spawn real `gh` in tests.
- `makeDiscriminatingStub` (Story 4.6b shared helper under `__tests__/test-helpers/`).
- `__resetGhErrorMapCacheForTests()` in `beforeEach`.

### References

- [Source: `_bmad-output/planning-artifacts/epics/epic-4-dev-review-loop-the-engineering-heart.md#Story 4.8`]
- [Source: `plugins/crew/docs/user-surface-acs.md`]
- [Source: `_bmad-output/implementation-artifacts/4-7-verdict-version-stamping-and-footer-marker-idempotent-rerun.md`] (deferred-work note on `api` narrowing)
- [Source: `_bmad-output/implementation-artifacts/4-6b-reviewer-posts-inline-comments-and-summary-verdict.md`] (label-call-via-api decision context; `makeDiscriminatingStub` pattern)
- [Source: `plugins/crew/permissions/generalist-reviewer.yaml`] (Task 1 modifies)
- [Source: `plugins/crew/mcp-server/src/lib/gh.ts`] (`gh()` wrapper; `gh_allow_args` exact-string semantics)
- [Source: `plugins/crew/mcp-server/src/lib/read-reviewer-result-file.ts`] (shared helper; Task 3 uses)
- [Source: `plugins/crew/mcp-server/src/tools/post-reviewer-comments.ts`] (pattern for `pr-view` → owner/repo resolution; `gh api --input -` pattern)

---

## Previous story intelligence

### From Story 4.7 (just shipped)

- Story 4.7's § DOES NOT (n) explicitly flags: "`api` is currently unconstrained; Story 4.8 MUST narrow." v1's narrowing is deferred (requires `gh_allow_args` regex support). This spec documents the gap and defers; future implementers must not be surprised.
- The `wasEdit` / `priorReviewId` return fields on `postReviewerComments` are Story 4.7 additions. `applyReviewerLabels` does NOT read them — it reads `reviewer-result.json` directly.

### From Story 4.6b (shipped)

- `readReviewerResultFile` (shared helper, `lib/read-reviewer-result-file.ts`) and `makeDiscriminatingStub` (shared test helper, `__tests__/test-helpers/gh-execa-stub.ts`) are reused here.
- The `gh api --input -` pipe pattern (passing JSON body via `input` option on `execaImpl`) is the established pattern for `gh api` calls. Task 3 reuses it verbatim.
- Story 4.6b Task (1j) explicitly notes `pr-comment` and `pr-review` are "already in `gh_allow` but NOT used by v1 — `gh api` is sufficient". Task 1 of this story acts on that note.

### From Story 4.3 / 4.3b (error-handler pattern)

- The SKILL.md inner cycle error handler currently surfaces uncaught errors verbatim. Story 4.8 extends the handler with a best-effort label call. The "best-effort in catch block, never mask the original error" pattern is established by Story 4.3b's `blocked_by: handoff-grammar` path.

### Git intelligence (recent commits)

```
feat(4.6b): reviewer posts inline comments and summary verdict
feat(4.7): verdict version stamping and footer-marker idempotent rerun
chore: mark 4-6b done in sprint-status
spec(4-7): rev 2 — fix six defects from post-merge code review
```

Pattern: Epic 4 commits follow `feat(4.X): <subject>`. Story 4.8's commit follows `feat(4.8): <subject>`.

---

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

None — implementation proceeded without blockers.

### Completion Notes List

- Task 1: Removed `pr-comment` and `pr-review` from `generalist-reviewer.yaml` (permissions + catalogue). Zero production callers confirmed. Two test fixtures updated to match. `pnpm build` passes.
- Task 2: Confirmed `GhApiResponseShapeError` accepts `{ subcommand: string; url?: string; cause: unknown }` — no change needed.
- Task 3: Created `apply-reviewer-labels.ts`. Implements sequential label-posting via `gh api POST /issues/{prNumber}/labels`, one call per label. `verdictOverride: "reviewer-failure"` forces non-green treatment regardless of file content.
- Task 4: Registered `applyReviewerLabels` in `register.ts`. Tool count assertions updated from 24 → 25 across three test files.
- Task 5: Updated `SKILL.md` — `applyReviewerLabels` added to `allowed_tools`; step 10a inserted after `processReviewerTranscript`; error handler updated with best-effort label call in its own try/catch.
- Task 6: Created `apply-reviewer-labels.test.ts` with all AC4 variants (4a–4e) and AC3 denial branches for `pr-comment`, `pr-review`, `pr-close`, `pr-merge`.
- Task 7: Created `ac5-4-8-apply-reviewer-labels.smoke.test.ts` extending the 4.6b/4.7 smoke harness. Asserts two sequential label calls and non-regression of manifest-state invariants.
- Task 8: All 949 tests pass. `dist/` rebuilt and included in commit.
- Note: `permissions-enforcement.test.ts` positive guard for `pr-review` updated to assert `pr-view` and `api` present, and `pr-review`/`pr-comment` absent (correctly reflecting the new negative-capability enforcement).

### File List

- `plugins/crew/permissions/generalist-reviewer.yaml` — removed `pr-comment`, `pr-review` from `gh_allow`
- `plugins/crew/catalogue/generalist-reviewer.md` — removed `pr-comment`, `pr-review` from `gh_allow` (parity with permissions)
- `plugins/crew/mcp-server/src/tools/apply-reviewer-labels.ts` — new tool
- `plugins/crew/mcp-server/src/tools/register.ts` — added `applyReviewerLabels` import and registration
- `plugins/crew/skills/start/SKILL.md` — added `applyReviewerLabels` to `allowed_tools`, inserted step 10a, updated error handler
- `plugins/crew/mcp-server/src/tools/__tests__/apply-reviewer-labels.test.ts` — new test suite (AC4 + AC3 denial)
- `plugins/crew/mcp-server/src/__tests__/operator-smoke-helpers/ac5-4-8-apply-reviewer-labels.smoke.test.ts` — new smoke test (AC5)
- `plugins/crew/mcp-server/src/tools/__tests__/post-reviewer-comments.test.ts` — fixture updated (removed `pr-comment`, `pr-review`)
- `plugins/crew/mcp-server/src/__tests__/operator-smoke-helpers/ac5-4-6b-post-reviewer-comments.smoke.test.ts` — fixture updated
- `plugins/crew/mcp-server/src/tools/__tests__/inner-cycle.integration.test.ts` — tool count 24 → 25
- `plugins/crew/mcp-server/src/skills/__tests__/start-skill-content.test.ts` — `allowed_tools` set updated (9 → 10)
- `plugins/crew/mcp-server/tests/ask-skill.test.ts` — tool count 24 → 25
- `plugins/crew/mcp-server/tests/ask-mode-enforcement.test.ts` — tool count 24 → 25
- `plugins/crew/mcp-server/tests/get-team-snapshot.test.ts` — tool count 24 → 25
- `plugins/crew/mcp-server/tests/permissions-enforcement.test.ts` — positive guard updated (pr-view + api present; pr-review + pr-comment absent)
- `plugins/crew/mcp-server/dist/` — rebuilt
