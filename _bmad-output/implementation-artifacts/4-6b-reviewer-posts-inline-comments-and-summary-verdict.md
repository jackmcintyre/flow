# Story 4.6b: Reviewer posts inline comments and summary verdict

story_shape: user-surface

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin operator**,
I want **the reviewer's executed-AC results and standards judgements posted as inline-and-summary comments on the PR — composed deterministically by a tool from the persisted `reviewer-result.json` file, NOT by the reviewer LLM**,
so that **I can open any PR the agent team produced and immediately see (i) which ACs passed, (ii) which failed and why (including the artifact path or vitest filter), (iii) any manual checks the operator still owes, and (iv) a single-line verdict at the bottom of the summary — without trusting the LLM to render any of it correctly**.

### What this story is, in one sentence

Introduce a new MCP tool `postReviewerComments` that the `/crew:start` inner cycle invokes AFTER `runReviewerSession` returns (between the reviewer spawn and `processReviewerTranscript`): it reads `<targetRepoRoot>/.crew/state/sessions/<sessionUlid>/reviewer-result.json`, composes a summary comment body plus zero-or-more inline comments (one per failing `runnable-artifact-check` whose `artifactPath` resolves to a hunk in the PR diff), and posts them as a single PR review via `gh api /repos/{owner}/{repo}/pulls/{prNumber}/reviews` with `event: COMMENT` — closing the operator-readability loop that Story 4.6 left open (the verdict file exists on disk but nothing in the PR surface shows it to a human reading the review).

### What this story fixes (and why it needs its own story)

Story 4.6 made the reviewer's verdict trustworthy: `runReviewerSession` executes ACs deterministically, persists `reviewer-result.json`, and `processReviewerTranscript` reads that file to drive manifest mutations. Trust contract intact. But the PR itself — the surface an operator (or a future human collaborator scanning the PR list) opens — has no machine-posted review on it. The reviewer persona's chat goes into Claude Code's transcript; nothing is written to GitHub. An operator reading the PR sees the dev's commits + the dev's `gh pr create` body and nothing else.

Epic 4.6b's job is to put the reviewer's findings on the PR itself: inline comments on diff lines where a failing artifact-check can be attributed; a summary comment whose body walks every AC result and every standards criterion; a verdict line at the bottom so the operator can scan-read the bottom of the summary and know the bottom line.

The **load-bearing decision** is: who composes the comment text? Story 4.6 revision 2 already taught us the answer when it retired the chat-prose verdict parser: the tool composes; the LLM does not. The reviewer LLM may still emit a summary in its chat for the operator's transcript window, but the body posted to the PR is rendered deterministically from `acResults` and `standardsByCriterionId`. The grammar can never drift because no LLM step generates it.

This story applies that same principle to the comment-posting surface. The new tool reads structured input (the persisted file), composes deterministic output (the comment body + inline-comments array), and posts via `gh api` in a single call.

### What this story does NOT

- (a) Touch `_bmad-output/implementation-artifacts/sprint-status.yaml` or any other file under `_bmad-output/implementation-artifacts/`. State transitions are owned by the workflow harness.
- (b) Touch `runReviewerSession` (Story 4.6) or `processReviewerTranscript` (Story 4.6 revision 2). The verdict transport is unchanged — `postReviewerComments` is a NEW step inserted between the reviewer spawn and `processReviewerTranscript` in the SKILL.md prose, consuming the same `reviewer-result.json` file as `processReviewerTranscript`. It is a sibling, not a wrapper.
- (c) Add version stamping or footer markers to the summary comment. Story 4.7 owns both. v1's summary body has no version block and no `<!-- crew:verdict:... -->` footer; reruns post a NEW comment rather than edit the prior one. Idempotent-rerun is 4.7's job; v1 accepts comment stacking on rerun (callers in v1 only ever invoke once per inner-cycle pass).
- (d) Add labels to the PR (`reviewed-by-agent`, `needs-human`). Story 4.8 owns labelling. v1 just posts comments.
- (e) Implement risk-tier classification in the summary. Story 4.9 / 4.9b own the risk-tier surface. v1's summary body does not mention risk tier (it's effectively the no-op stub from 4.6 (e)).
- (f) Re-architect what counts as "inline". v1's inline-comment generator only handles `runnable-artifact-check` failures — and only when the failing artifact's `artifactPath` literal can be found in a `+++ b/<path>` line of the PR diff (a file the PR adds or modifies). Failing vitest ACs, manual-check-required ACs, and standards-criterion findings all fold into the summary body. Rationale: artifact-existence failures are the rubber-stamp shape from 4.3c — the highest-value inline anchor; other shapes lack a deterministic line-of-code anchor.
- (g) Compose anything from the reviewer LLM's chat output. The LLM's chat text is ignored entirely by `postReviewerComments`. The persona prose may still summarise for the operator's Claude Code transcript window, but nothing it says is read by this tool.
- (h) Modify the reviewer persona (`plugins/crew/catalogue/generalist-reviewer.md`). The persona's only mandatory action is still `runReviewerSession` (Story 4.6 Task 8.2). Adding a second mandatory tool call would reintroduce a prose-flake surface (two MUST-call-X steps instead of one). The SKILL.md prose owns the `postReviewerComments` invocation, not the persona.
- (i) Wire up real PR-comment editing. Posting always creates a new review. Editing/replacing a prior verdict comment is 4.7's idempotent-rerun job.
- (j) Add `pr-review-comment` or any new `gh` subcommand path. v1 uses `gh api` (already kebab-cased as `api` in the subcommand spec) for the single POST that creates a review with inline comments in one call. `pr-comment` and `pr-review` already in `gh_allow` are NOT used by v1 — `gh api` is sufficient and gives the inline-comments-in-the-review-payload shape we need.
- (k) Truncate or summarise the PR diff for comment composition. The diff was already read by `runReviewerSession` but NOT persisted (per Story 4.6 (3g) — only the verdict-relevant projection lives on disk). `postReviewerComments` re-calls `gh pr diff <prNumber>` to get a fresh copy. v1 accepts the duplicated network call; it's bounded (one extra `gh pr diff` per reviewer cycle) and avoids persisting heavy raw-diff data on disk.
- (l) Handle the case where `reviewer-result.json` is malformed. `runReviewerSession` writes it via `atomicWriteFile` and `processReviewerTranscript` Zod-validates on read; a malformed file is a `ReviewerResultFileMalformedError` thrown there. `postReviewerComments` runs BEFORE `processReviewerTranscript` (so it sees the malformation first); v1's tool uses the SAME `readReviewerResultFile` helper from `processReviewerTranscript` and re-raises `ReviewerResultFileMalformedError` unchanged. Symmetric error surface.
- (m) Emit telemetry. Story 4.12 owns reviewer-side telemetry; v1 adds a TODO marker where `reviewer.comments_posted` would land.
- (n) Cover the case where the PR has been closed/merged out from under the cycle. The reviewer cycle assumes the dev's PR is still open; if `gh api` returns a 4xx because the PR is closed, the typed error propagates uncaught (same pattern as 4.6's `gh pr diff` error surface). Recovery is Epic 5's job.

---

## Acceptance Criteria

> AC1, AC2, AC3, AC4 derive from the epic spec for Story 4.6b. AC5 is the user-surface contract this story makes — the operator-observable promise that the verdict is now visible on the PR itself, not just in the Claude Code transcript. Per `plugins/crew/docs/user-surface-acs.md`, AC5 is tagged `(user-surface)`; the others describe internal posting behaviour and stay untagged. AC4 retains its `(integration)` tag.

**AC1:**
**Given** the in-memory pass/fail results persisted by Story 4.6 (`<targetRepoRoot>/.crew/state/sessions/<sessionUlid>/reviewer-result.json`),
**When** the reviewer posts (via the new `postReviewerComments` MCP tool, invoked from the SKILL.md prose AFTER the reviewer spawn returns and BEFORE `processReviewerTranscript` runs),
**Then** inline review comments are posted on the diff lines they reference — one inline comment per failing `runnable-artifact-check` whose `artifactPath` is found as a `+++ b/<path>` (or `+++ a/<path>` rename) target in the unified diff returned by `gh pr diff <prNumber>`. _(FR33)_

<!-- Not user-surface: AC1 describes the tool's internal posting mechanism. AC5 is the operator-facing promise. -->

**AC2:**
**Given** the reviewer's summary comment,
**When** posted,
**Then** its final non-empty line matches exactly one of:
- `**Verdict: READY FOR MERGE**`
- `**Verdict: NEEDS CHANGES** [<N> issues, <M> questions]`
- `**Verdict: BLOCKED** [<reason>]`

where `<N>` is the integer count of `acResults` entries with `status === "fail"`, `<M>` is the integer count of `acResults` entries with `applicability === "manual-check-required"`, and `<reason>` is one of: `no ACs declared`, `manual checks required`, `reviewer-result-file-malformed`. The summary body is composed deterministically by `postReviewerComments` from `reviewer-result.json` — no LLM text generation step exists in the composition path. _(FR34)_

<!-- Not user-surface: AC2 describes the deterministic grammar of the summary string. AC5 carries the operator-observable contract. -->

**AC3:**
**Given** the verdict-line grammar is composed by a tool (not by an LLM),
**When** `postReviewerComments` runs against any valid `reviewer-result.json`,
**Then** the verdict line always matches one of the three forms in AC2 by construction — grammar drift is structurally impossible. The legacy "verdict-grammar drift in the reviewer's output → `BLOCKED [reviewer-grammar-error]`" branch from the original epic AC is REMOVED: the LLM no longer composes the verdict line, so the failure mode it guarded against cannot occur. If a future caller hands `postReviewerComments` a malformed `reviewer-result.json`, the tool propagates `ReviewerResultFileMalformedError` verbatim (same as `processReviewerTranscript`). _(Pattern §12 — superseded by Story 4.6 revision 2's tool-seam architecture)_

<!-- Not user-surface: AC3 is a structural-anchor AC asserting the impossibility of an obsolete failure mode. -->

**AC4 (integration):**
vitest drives `postReviewerComments` against fixture `reviewer-result.json` files (one `READY FOR MERGE`, one `NEEDS CHANGES` with a failing artifact-check whose path appears in the stubbed `gh pr diff` output, one `NEEDS CHANGES` with a failing artifact whose path is NOT in the diff, one `BLOCKED` with manual-check-required ACs, one with no ACs at all) and asserts each branch produces (a) the expected `gh api` call shape (URL path, JSON body's `body` and `comments` arrays), (b) the expected verdict-line grammar at the end of the body per AC2, (c) the inline-comments array has the expected length and per-item shape (`path`, `line`, `body`), and (d) the tool's return value matches the documented shape including a `postedReviewId` (extracted from the stubbed `gh api` response).

<!-- Not user-surface: vitest integration suite — internal harness only. -->

**AC5 (user-surface):**
**Given** a target repo with the Story 4.6 rubber-stamp reproducer (one ready story with `artifact: target-file.txt`; dev persona stubbed to handoff without creating the artifact),
**When** the operator runs `/crew:start` against the scratch repo end-to-end and the inner cycle reaches the post-reviewer step,
**Then** the operator can open the PR in GitHub (or run `gh pr view <prNumber> --comments`) and observe:
- (a) **A new PR review of type `COMMENTED`** posted by the gh-authenticated user, with a body whose final line is `**Verdict: NEEDS CHANGES** [1 issues, 0 questions]`.
- (b) **At least one inline review comment** anchored to the PR's diff that names the missing artifact `target-file.txt` and includes the literal string `ENOENT` in the body.
- (c) **The summary body** lists each AC under a "## Acceptance criteria" heading with a pass/fail emoji and the AC's `reason` field verbatim — including `target-file.txt` for the failing AC. _(FR33, FR34 — operator-observable promise)_

<!-- User-surface: AC5 names `/crew:start` (operator surface) AND the PR review surface (GitHub UI / `gh pr view`). Smoke-gate via operator-smoke before merging. -->

### Expanded acceptance specifics (folded into AC1–AC5 above)

**AC1 unpacked.** Inline-comment generation mechanics:

- (1a) **Composite tool entrypoint:** a new MCP tool `postReviewerComments` is registered (added to `register.ts`'s tool list and to the SKILL.md `allowed_tools` array). Signature: `postReviewerComments({ targetRepoRoot: string, sessionUlid: string, role?: string, execaImpl?: typeof execa, pluginRootOverride?: string }) → Promise<PostReviewerCommentsResult>`. The `role` default is `"generalist-reviewer"`; `execaImpl` and `pluginRootOverride` are the test seams matching `runReviewerSession`'s pattern.
- (1b) **Input contract:** the tool reads `<targetRepoRoot>/.crew/state/sessions/<sessionUlid>/reviewer-result.json` using the SAME helper as `processReviewerTranscript` (extract `readReviewerResultFile` from `process-reviewer-transcript.ts` into a shared module `lib/read-reviewer-result-file.ts` so both tools call the same parser). On `ENOENT`, the tool returns a new typed `PostReviewerCommentsResult` variant `{ next: "skipped-no-session-result", postedReviewId: null }` rather than throwing — rationale: the missing-file case is already handled loudly by `processReviewerTranscript` downstream; `postReviewerComments` skipping silently here is appropriate (no review to post if there's no verdict to render). On malformed JSON, the tool raises `ReviewerResultFileMalformedError` (re-thrown from the shared helper).
- (1c) **PR-diff re-read:** the tool calls `gh({ role, permissions, subcommand: "pr-diff", args: [String(prNumber)] })` exactly the same way `runReviewerSession` did. `prNumber` is read from the persisted file (it was carried on the projection per Story 4.6 (3g)). The recoverable-error path (`GhRecoverableError`) propagates uncaught — same surface as Story 4.6.
- (1d) **PR-context resolution:** the tool needs `{owner}`, `{repo}` for the `gh api` URL. Resolve via `gh pr view <prNumber> --json baseRepository` (add `pr-view` to the `gh_allow` for reviewer if not already present — it IS already present, per the current `generalist-reviewer.yaml`). The parsed JSON returns `{ baseRepository: { name, owner: { login } } }`. v1 does NOT shell `git config` or guess the remote; the GitHub-authoritative shape lives in `gh pr view`.
- (1e) **Inline-comment generator (failing-artifact-check only):** for each `AcResult` where `applicability === "runnable-artifact-check"` AND `status === "fail"`:
  1. Search the unified diff for a header line matching `/^\+\+\+ [ab]\/(.+)$/m` whose capture group equals the AC's `artifactPath` (exact-string match; no glob).
  2. If found: locate the diff hunk that owns the matching `+++` line; pick the FIRST line in that hunk's `@@` range as the inline-comment `line` number (the `+` side's starting line, parsed from `@@ -<old>,<oldN> +<newStart>,<newN> @@`). The `path` is the matched capture group. The `body` is `**AC<index> FAIL** — ${reason}\n\nThe AC declared \`artifact: ${artifactPath}\` but the file does not exist on disk at the dev's branch HEAD. The dev claimed it was created; \`fs.access\` returned ENOENT.`
  3. If NOT found in the diff: skip the inline comment for this AC. Fold the finding into the summary body's "## Acceptance criteria" section instead (the failing AC is still surfaced, just without an inline anchor).
- (1f) **Inline-comment exclusions:** failing `runnable-vitest` ACs, `manual-check-required` ACs, and any standards-criterion finding do NOT generate inline comments in v1. They fold into the summary body. Rationale per (f) in § "What this story does NOT": these shapes lack a deterministic line-of-code anchor. Future stories can extend the inline-comment generator if real story spec output reveals a stable line-mapping pattern.
- (1g) **Single `gh api` POST:** all inline comments AND the summary body ship in ONE `gh api /repos/{owner}/{repo}/pulls/{prNumber}/reviews` call with body shape:
  ```json
  {
    "event": "COMMENT",
    "body": "<summary body string>",
    "comments": [
      { "path": "<artifact-path>", "line": <int>, "body": "<inline-comment body>" }
      // ... one per matched failing artifact-check
    ]
  }
  ```
  Rationale: GitHub's reviews API supports inline comments only as a sub-array of a review POST; posting them as separate `pr review-comment` calls is awkward (each becomes a top-level review). One POST creates one review with N inline comments — atomic operator surface.
- (1h) **`gh api` invocation shape:** `gh({ role, permissions, subcommand: "api", args: ["/repos/${owner}/${repo}/pulls/${prNumber}/reviews", "--method", "POST", "--input", "-"] })` — the request body is piped via `execaImpl.input` (or `inputFile`) since the request is JSON. The `subcommand: "api"` requires adding `api` to `gh_allow` for `generalist-reviewer` (Task 2 below). The kebab-segments rule in `gh.ts` splits `api` → `["api"]` (single segment), which is correct.
- (1i) **Response parsing:** the `gh api` call returns the created review's JSON; v1 parses `JSON.parse(stdout).id` as `postedReviewId: number` and returns it on the result. If parsing fails (unexpected response shape), raise a new typed `GhApiResponseShapeError({ subcommand: "api", url: <url>, cause })` and let it propagate. (Future-proofing — gh's response shape is stable but not contractually frozen for us.)

**AC2 unpacked.** Deterministic summary-body composition:

- (2a) **Summary body skeleton (composed by `composeSummaryBody(resultFile)`):**
  ```
  # Reviewer summary — ${ref}

  ## Acceptance criteria

  ${perAcLines.join("\n")}

  ## Standards check

  ${standardsLines.join("\n") || "_No standards criteria declared._"}

  ${manualChecksSection || ""}

  ${verdictLine}
  ```
- (2b) **Per-AC line format:**
  - **Pass (any applicability with `status === "pass"`):** `- ✅ **AC${index}** — ${reason}`
  - **Fail (runnable-* with `status === "fail"`):** `- ❌ **AC${index}** — ${reason}`
  - **Manual-check-required:** `- ⚠️ **AC${index}** — ${reason}` (also appears under the "Manual checks required before merge" section)
  - ACs are emitted in numeric-index order. Empty `acResults` produces a single line `_No ACs declared in the source story._`.
- (2c) **Standards-check section:** v1 emits one line per `standardsByCriterionId` entry: `- 📋 **${criterion.name}** — _(deterministic standards-vs-diff cross-check is Story 4.6b-future; v1 just lists the criterion's `name`/`what` for operator reference)_`. Specifically: `- 📋 **${criterion.name}** — ${criterion.what}`. Rationale: Story 4.6 (3d) deferred standards-criterion cross-checking to a future story; v1 lists the rubric so the operator can spot-check, but does not assert pass/fail per criterion. Empty `standardsByCriterionId` (no doc) produces `_No standards criteria declared._`.
- (2d) **Manual-checks-required section:** emitted ONLY if any `AcResult` has `applicability === "manual-check-required"`. Format:
  ```
  ## Manual checks required before merge

  ${manualAcs.map(ac => `- AC${ac.index}: ${ac.reason}`).join("\n")}
  ```
- (2e) **Verdict line (the load-bearing single line at the bottom):** composed by a pure function `composeVerdictLine(resultFile)`:
  - `recommendedVerdict === "READY FOR MERGE"` → `**Verdict: READY FOR MERGE**`
  - `recommendedVerdict === "NEEDS CHANGES"` → `**Verdict: NEEDS CHANGES** [${N} issues, ${M} questions]` where `N = Object.values(acResults).filter(r => r.status === "fail").length` and `M = Object.values(acResults).filter(r => r.applicability === "manual-check-required").length`.
  - `recommendedVerdict === "BLOCKED"` → `**Verdict: BLOCKED** [${reason}]` where `reason` is selected by this closed table:
    - If `Object.keys(acResults).length === 0` → `no ACs declared`
    - Else if `Object.values(acResults).some(r => r.applicability === "manual-check-required")` → `manual checks required`
    - Else → `unknown` (defensive default; should never fire given Story 4.6's deterministic algorithm — but the verdict-line function has no access to that algorithm and must handle every input shape).
- (2f) **`composeSummaryBody` and `composeVerdictLine` are pure functions, exported separately:** placed in `lib/compose-reviewer-summary.ts`. Pure inputs (`ReviewerResultFileShape`), no I/O, no time-of-day, no env reads. Unit-testable in isolation; the integration suite (AC4) tests the full posting path; the unit suite (in `lib/__tests__/`) tests every branch of `composeVerdictLine` exhaustively (one test per closed-table row) and the body skeleton (one test per AC-count × manual-check combination).
- (2g) **No version stamp, no footer marker:** v1's summary body MUST NOT include a `<!-- crew:verdict:... -->` footer marker or a `standards_version`/`plugin_version` block. Story 4.7 adds both AND switches the posting path to edit-in-place if a prior verdict comment exists. v1's summary body terminates at the verdict line (no trailing newline-padded HTML comment).

**AC3 unpacked.** Why the grammar-drift branch is removed:

- (3a) **The original branch was a fallback for LLM-composed verdict text.** When the reviewer LLM was the verdict author, the locked-phrase parser had to defend against paraphrase. Story 4.6 revision 2 retired that parser; Story 4.6b ships a deterministic composer. There is no LLM step in the path from `reviewer-result.json` to the posted summary body — the entire chain is `runReviewerSession (tool)` → `reviewer-result.json (file)` → `postReviewerComments (tool, composing the body)` → `gh api (subprocess)`. No prose, no paraphrase, no drift.
- (3b) **Inverse test (the structural anchor):** the AC4 vitest suite asserts the verdict-line format by exact-string comparison for every closed-table row. If a future change tries to add an emoji, change the bracket grammar, or introduce a parallel verdict path, those tests fail.
- (3c) **Open file-malformed surface:** the only path by which an invalid verdict line could ship is a malformed `reviewer-result.json`. That case throws `ReviewerResultFileMalformedError` (the shared `readReviewerResultFile` helper raises it; v1 lets it propagate uncaught — same surface as `processReviewerTranscript`).

**AC4 unpacked.** Integration-suite fixtures and stub shape:

- (4a) **Fixture base:** a tmpdir created by `mkdtempSync(path.join(os.tmpdir(), "crew-4-6b-"))` containing:
  - `<tmp>/.crew/config.yaml` declaring `active_adapter: native` (needed so `loadRolePermissions` / `getPluginRoot` paths resolve; the reviewer's `runReviewerSession` was already cached, so v1's tool can short-circuit some workspace reads — but DOES still need `loadRolePermissions` for the `gh()` call).
  - `<tmp>/.crew/state/sessions/<sessionUlid>/reviewer-result.json` written verbatim per the variant under test (six variants — see (4c)).
- (4b) **Stub seam for `gh`:** the same `execaImpl?: typeof execa` test seam as `run-reviewer-session.test.ts`. Use `makeDiscriminatingStub` (introduced in Story 4.6 Issue 2; extract to a shared test helper `__tests__/test-helpers/gh-execa-stub.ts` if not already extracted) routing by `cmd` and `args[0..1]`:
  - `cmd === "gh" && args[0] === "pr" && args[1] === "diff"` → return the fixture diff.
  - `cmd === "gh" && args[0] === "pr" && args[1] === "view"` → return `{"baseRepository":{"name":"crew","owner":{"login":"jackmcintyre"}}}` (the JSON payload `gh pr view --json baseRepository` would emit).
  - `cmd === "gh" && args[0] === "api"` → return `{"id":12345}` (the stub review-creation response).
- (4c) **Test variants:**
  - **(4c-i) READY FOR MERGE, all-pass:** `reviewer-result.json` with two passing artifact-checks. Asserts: `gh api` body's `comments` array is empty; summary body ends with `**Verdict: READY FOR MERGE**`; `postedReviewId === 12345`.
  - **(4c-ii) NEEDS CHANGES, failing artifact in diff:** `reviewer-result.json` with one failing `runnable-artifact-check` for `src/added-but-missing.ts`. Diff contains `+++ b/src/added-but-missing.ts`. Asserts: `comments` array length 1; comment's `path === "src/added-but-missing.ts"`, `line` matches the hunk start parsed from the fixture diff, `body` contains `ENOENT`; summary body ends with `**Verdict: NEEDS CHANGES** [1 issues, 0 questions]`.
  - **(4c-iii) NEEDS CHANGES, failing artifact NOT in diff:** failing artifact-check for `nonexistent/path.txt`; diff does NOT contain that path. Asserts: `comments` array is empty (no inline anchor available); summary body's "## Acceptance criteria" section still lists the failing AC with `❌`; verdict line `**Verdict: NEEDS CHANGES** [1 issues, 0 questions]`.
  - **(4c-iv) BLOCKED, manual checks required:** two `manual-check-required` ACs, one passing artifact-check. Asserts: `comments` array empty; summary body includes "## Manual checks required before merge" section listing both manual ACs; verdict line `**Verdict: BLOCKED** [manual checks required]`.
  - **(4c-v) BLOCKED, no ACs declared:** `acResults: {}`. Asserts: per-AC section emits `_No ACs declared in the source story._`; verdict line `**Verdict: BLOCKED** [no ACs declared]`.
  - **(4c-vi) Missing-file path:** no `reviewer-result.json` at the expected path. Asserts: `postReviewerComments` returns `{ next: "skipped-no-session-result", postedReviewId: null }`; the `gh` stub is NOT called.
- (4d) **`gh api` body assertion:** intercept the `--input -` payload via the `input` option on the stub (capture the string passed to `execaImpl` as the `input` parameter); JSON-parse it; assert exact shape per (1g).
- (4e) **Negative path — recoverable `gh pr diff` error:** `execaImpl` for `gh pr diff` returns `{ exitCode: 4, stderr: "API rate limit exceeded", stdout: "" }`; asserts `GhRecoverableError` propagates uncaught.
- (4f) **Negative path — malformed `reviewer-result.json`:** write invalid JSON to the file; assert `ReviewerResultFileMalformedError` propagates uncaught.
- (4g) **Negative path — malformed `gh api` response:** `gh api` stub returns non-JSON stdout; assert `GhApiResponseShapeError` is raised with the URL and cause.

**AC5 unpacked.** The operator-surface contract and the smoke-gate evidence:

- (5a) **Reproducer:** extend the Story 4.6 operator-smoke fixture (under `plugins/crew/mcp-server/src/__tests__/operator-smoke-helpers/`) with the post-reviewer step. The same scratch repo, same stubbed dev that handoffs without creating `target-file.txt`, same `runReviewerSession` returning `recommendedVerdict: "NEEDS CHANGES"`. The new step: after the reviewer Task returns and before `processReviewerTranscript`, the SKILL.md prose invokes `postReviewerComments`. The smoke stubs `gh api` (mirroring (4b)) and captures the body payload.
- (5b) **Operator-observable assertion:** the captured `gh api` body's `body` field, when split on `\n`, has a final non-empty line of exactly `**Verdict: NEEDS CHANGES** [1 issues, 0 questions]`. The `comments` array has length 1 (the failing artifact-check's path appears in the fixture diff). The inline comment's `body` contains both `target-file.txt` and `ENOENT`.
- (5c) **Manifest-state non-regression:** the smoke also asserts the Story 4.6 invariants still hold — the in-progress manifest is stamped `blocked_by: "reviewer-verdict-needs-changes"`, NOT moved to `done/`. Story 4.6b adds posting on top; it must not regress the verdict-transport contract.
- (5d) **Manual-paste alternative:** per `plugins/crew/docs/user-surface-acs.md` § Pre-PR gate, the operator may substitute manual-paste evidence (verbatim Claude Code transcript output) showing the captured `gh api` invocation in place of the automated smoke. The structured-body assertion (5b) is mechanically guaranteed by the deterministic composer; the operator-paste path is for verifying the integration glue (SKILL.md prose actually invokes `postReviewerComments`).
- (5e) **Smoke-gate tag:** the new operator-smoke step file is tagged so it runs in the pre-PR smoke gate.

---

## Tasks / Subtasks

The implementation order is load-bearing. Follow it.

- [ ] **Task 1: Extract `readReviewerResultFile` into a shared module** (AC: #1, #3)
  - [ ] 1.1 Create `plugins/crew/mcp-server/src/lib/read-reviewer-result-file.ts`. Move the helper from `tools/process-reviewer-transcript.ts` (lines ~110–158) into it verbatim. Export `readReviewerResultFile(targetRepoRoot: string, sessionUlid: string): Promise<ReviewerResultFileShape | null>` and the `ReviewerResultFileShape` type re-export. The helper retains its behaviour: `null` on ENOENT, `ReviewerResultFileMalformedError` on parse/shape failure.
  - [ ] 1.2 Update `tools/process-reviewer-transcript.ts` to import the helper from the new module. Delete the inline implementation. Run the existing `process-reviewer-transcript.test.ts` to confirm no behavioural change.
  - [ ] 1.3 (No unit test added — the shared helper's behaviour is covered by the existing `process-reviewer-transcript.test.ts` ENOENT/malformed cases. AC4 (4f) exercises it from the new tool's path.)

- [ ] **Task 2: Add `api` to reviewer `gh_allow`** (AC: #1)
  - [ ] 2.1 Edit `plugins/crew/permissions/generalist-reviewer.yaml`. Add `- api` to the `gh_allow` list. Preserve `pr-view`, `pr-comment`, `pr-review`, `pr-diff`.
  - [ ] 2.2 No schema change (the spec accepts any string subcommand). If a permissions test suite exists under `plugins/crew/permissions/__tests__/`, add a fixture-load assertion confirming `api` is present.

- [ ] **Task 3: Create `composeReviewerSummary` and `composeVerdictLine` pure helpers** (AC: #2, #3)
  - [ ] 3.1 Create `plugins/crew/mcp-server/src/lib/compose-reviewer-summary.ts`. Export:
    - `composeVerdictLine(result: ReviewerResultFileShape): string` — per (2e) closed table.
    - `composeSummaryBody(result: ReviewerResultFileShape): string` — per (2a) skeleton, (2b) per-AC, (2c) standards, (2d) manual-checks, ending with the verdict line from `composeVerdictLine`.
  - [ ] 3.2 Both helpers are pure: no I/O, no `Date.now()`, no env reads. Inputs are the parsed file shape only.
  - [ ] 3.3 Add unit tests in `plugins/crew/mcp-server/src/lib/__tests__/compose-reviewer-summary.test.ts`:
    - `composeVerdictLine`: one case per closed-table row from (2e), plus the defensive `"unknown"` BLOCKED variant.
    - `composeSummaryBody`: one case per (variant × manual-check presence) combination — at minimum {READY FOR MERGE, NEEDS CHANGES, BLOCKED} × {has manual ACs, no manual ACs} × {has standards, no standards}. Exact-string assertions on the final line; structural assertions on section headings.

- [ ] **Task 4: Implement `postReviewerComments` MCP tool** (AC: #1, #2, #3)
  - [ ] 4.1 Create `plugins/crew/mcp-server/src/tools/post-reviewer-comments.ts`. Export `postReviewerComments(opts) → Promise<PostReviewerCommentsResult>` per (1a) signature. Add the `execaImpl?: typeof execa` and `pluginRootOverride?: string` test seams (matching `runReviewerSession`'s pattern).
  - [ ] 4.2 Step 1 — read the persisted file via `readReviewerResultFile`. On `null`, return `{ next: "skipped-no-session-result", postedReviewId: null }` immediately (no further `gh` calls).
  - [ ] 4.3 Step 2 — call `gh({ role, permissions, subcommand: "pr-diff", args: [String(result.prNumber)] })` to fetch the unified diff. Permissions loaded via `loadRolePermissions(role, pluginRootOverride ?? getPluginRoot())` (same pattern as `runReviewerSession`).
  - [ ] 4.4 Step 3 — call `gh({ role, permissions, subcommand: "pr-view", args: [String(result.prNumber), "--json", "baseRepository"] })`. Parse stdout as JSON; extract `{ name, owner: { login } }`. If parsing fails, raise `GhApiResponseShapeError({ subcommand: "pr-view", cause })`.
  - [ ] 4.5 Step 4 — generate inline comments per (1e):
    - Iterate `Object.values(result.acResults)`.
    - For each `applicability === "runnable-artifact-check" && status === "fail"`: search the diff for `/^\+\+\+ [ab]\/(.+)$/m` whose capture equals `acResult.artifactPath`. If match, locate the next `@@ -<old>,<oldN> +<newStart>,<newN> @@` line below it and parse `newStart` as the inline `line`. Build the inline comment per (1e.2).
    - Helper: `findHunkLineForPath(diff: string, path: string): number | null` — pure function in `lib/find-hunk-line.ts`, unit-tested.
  - [ ] 4.6 Step 5 — compose the summary body via `composeSummaryBody(result)`.
  - [ ] 4.7 Step 6 — build the `gh api` request body per (1g) shape. JSON-stringify. Invoke `gh({ role, permissions, subcommand: "api", args: ["/repos/${owner}/${repo}/pulls/${prNumber}/reviews", "--method", "POST", "--input", "-"], execaImpl })` passing the JSON body via the `input` field on `execaImpl` (extend `gh()` to forward an optional `input` field if it doesn't already — see Task 4a).
  - [ ] 4.8 Step 7 — parse `gh api` stdout as JSON; extract `id` as `postedReviewId: number`. On parse failure, raise `GhApiResponseShapeError`.
  - [ ] 4.9 Step 8 — return `{ next: "posted", postedReviewId: <id>, inlineCommentCount: comments.length, verdictLine: <line> }`.
  - [ ] 4.10 Add top-of-file JSDoc citing this story spec.

- [ ] **Task 4a: Extend `gh()` to pipe a stdin body** (AC: #1)
  - [ ] 4a.1 Open `plugins/crew/mcp-server/src/lib/gh.ts`. Add an optional `input?: string` field to the `gh()` opts shape. When provided, forward as `{ input }` to the `execaImpl` call (line ~91). The `execa` library natively supports this — string is piped to the subprocess's stdin.
  - [ ] 4a.2 Update the existing tests in `lib/__tests__/gh.test.ts` to confirm passing `input` does not break any existing path (the field is optional; default behaviour unchanged).
  - [ ] 4a.3 Add one new test asserting that `input` is forwarded to the stub's `execaImpl` call options.

- [ ] **Task 5: Register `postReviewerComments` as an MCP tool** (AC: #1)
  - [ ] 5.1 Open `plugins/crew/mcp-server/src/tools/register.ts`. Add the import. Register under tool name `"postReviewerComments"` with a Zod input schema mirroring the options.
  - [ ] 5.2 Wrap the handler in the existing `DomainError → { isError: true, content: [...] }` envelope.
  - [ ] 5.3 Verify via the existing register-suite tests that the tool is enumerated and callable.

- [ ] **Task 6: Add `GhApiResponseShapeError` to errors.ts** (AC: #1)
  - [ ] 6.1 Open `plugins/crew/mcp-server/src/errors.ts`. Add `GhApiResponseShapeError extends DomainError`; constructor `{ subcommand: string; url?: string; cause: unknown }`; message: `"gh ${subcommand} returned an unexpected response shape${url ? \" at \" + url : \"\"}. Cause: ${cause}. This is either a gh CLI change or a stub mismatch in tests."`.

- [ ] **Task 7: Update the SKILL.md inner cycle to invoke `postReviewerComments`** (AC: #1, #5)
  - [ ] 7.1 Open `plugins/crew/skills/start/SKILL.md`. In the `allowed_tools` array (line 4), add `postReviewerComments`. (Set-equality widens from the current eight-tool set to nine.)
  - [ ] 7.2 In the reviewer-handling step (the step that calls `processReviewerTranscript` after the reviewer Task returns), insert a NEW step BEFORE the `processReviewerTranscript` call: `postReviewerComments({ targetRepoRoot, sessionUlid })`. The tool runs first; its return value is informational (logged to the operator's chat surface via the existing chatLog pattern, if applicable); the cycle then proceeds to `processReviewerTranscript` regardless of the post-comments outcome.
  - [ ] 7.3 Specifically handle the `next: "skipped-no-session-result"` return: log a chat line "post-reviewer-comments skipped — no reviewer-result.json (the missing-file case will be handled by processReviewerTranscript next)" and proceed.
  - [ ] 7.4 On uncaught throws from `postReviewerComments` (e.g. `GhRecoverableError`, `GhApiResponseShapeError`, `ReviewerResultFileMalformedError`): surface verbatim, halt the inner cycle (same pattern as Story 4.6's uncaught-error surface). Do NOT proceed to `processReviewerTranscript` — the verdict transport is still on disk, but a posting failure indicates an environmental problem worth pausing for.
  - [ ] 7.5 Do NOT add prose telling the reviewer persona to compose comment text. The persona's mandatory tool call (Story 4.6 Task 8.2) is still `runReviewerSession`; `postReviewerComments` is invoked from SKILL.md prose, not from inside the reviewer subagent.

- [ ] **Task 8: Implement the integration test suite** (AC: #4)
  - [ ] 8.1 Create `plugins/crew/mcp-server/src/tools/__tests__/post-reviewer-comments.test.ts`. Build the fixture per (4a) in `beforeEach`; tear down with `rmSync`.
  - [ ] 8.2 Extract `makeDiscriminatingStub` from `run-reviewer-session.test.ts` into `__tests__/test-helpers/gh-execa-stub.ts` if not already extracted. Extend the routing to cover `gh pr view --json baseRepository` and `gh api`.
  - [ ] 8.3 Implement each variant from (4c-i) through (4c-vi) as a separate `it()` case. Use the captured `input` field on the stub to JSON-parse and assert the `gh api` body shape.
  - [ ] 8.4 Implement the negative paths (4e), (4f), (4g) as separate `it()` cases.
  - [ ] 8.5 Use `__resetGhErrorMapCacheForTests` in `beforeEach` to keep the gh-error-map cache deterministic (same pattern as Story 4.5 / 4.6 tests).

- [ ] **Task 9: Add unit tests for the inline-hunk-line helper** (AC: #1)
  - [ ] 9.1 Create `plugins/crew/mcp-server/src/lib/__tests__/find-hunk-line.test.ts`. Cases:
    - Diff contains the path in a `+++ b/<path>` line; hunk line returned matches `@@ +<newStart>` parse.
    - Diff contains the path with `+++ a/<path>` (rename source); same return.
    - Diff does NOT contain the path; returns `null`.
    - Diff contains the path multiple times (multi-file diff with matching name); returns the FIRST occurrence's hunk line.

- [ ] **Task 10: Operator-smoke extension for AC5** (AC: #5)
  - [ ] 10.1 Extend the Story 4.6 operator-smoke harness with the post-reviewer step per (5a). Add a `gh api` stub mirroring (4b).
  - [ ] 10.2 Capture the body payload passed to `gh api` (via the `input` field on the discriminating stub). Assert per (5b): final line of body matches `**Verdict: NEEDS CHANGES** [1 issues, 0 questions]` exactly; `comments` array length 1; inline comment's body contains both `target-file.txt` and `ENOENT`.
  - [ ] 10.3 Assert per (5c): the in-progress manifest is at `.crew/state/in-progress/<ref>.yaml` AND NOT at `.crew/state/done/<ref>.yaml`; `blocked_by === "reviewer-verdict-needs-changes"`.
  - [ ] 10.4 Tag the test file so it runs in the pre-PR smoke gate per `plugins/crew/docs/user-surface-acs.md`. Operator may substitute manual-paste evidence per (5d).

- [ ] **Task 11: Update docs (if affected)** (no AC; housekeeping)
  - [ ] 11.1 Skim `plugins/crew/docs/` for any reviewer-flow doc that describes verdict surface or PR-comment posting. Update to mention `postReviewerComments` as the deterministic composer + poster. Do NOT create new docs.

---

## Behavioural contract (user-surface)

**These invariants are the contract this story makes. They MUST hold at all times in the running plugin.**

### MUST

- **MUST compose the summary body and inline comments deterministically from `reviewer-result.json` — no LLM step in the composition path.** Verified mechanically: `composeSummaryBody` and `composeVerdictLine` are pure functions; `postReviewerComments` calls them with the parsed file shape and posts the result; the reviewer LLM's chat is not consulted.
- **MUST end the summary body with a verdict line matching exactly one of the three forms in AC2.** Verified by exact-string unit tests on `composeVerdictLine` over every closed-table row.
- **MUST emit one inline comment per failing `runnable-artifact-check` whose `artifactPath` is found in the PR diff's `+++ b/<path>` lines.** Other AC shapes (failing vitest, manual-check-required) fold into the summary body without an inline anchor.
- **MUST post all inline comments and the summary in a single `gh api` POST to `/repos/{owner}/{repo}/pulls/{prNumber}/reviews` with `event: COMMENT`.** One atomic operator-surface action; no per-comment fan-out.
- **MUST propagate `GhRecoverableError`, `GhApiResponseShapeError`, `ReviewerResultFileMalformedError`, and `GhSubcommandDeniedError` verbatim.** No swallow, no retry, no paper-over.
- **MUST return `{ next: "skipped-no-session-result", postedReviewId: null }` on ENOENT for `reviewer-result.json`.** The missing-file case is silent here (the loud blocker is `processReviewerTranscript`'s job).

### MUST NOT

- **MUST NOT compose the summary body or verdict line from the reviewer LLM's chat output.** The LLM's chat is ignored by `postReviewerComments`. Reintroducing prose-scraping reopens the trial-7 failure mode that Story 4.6 revision 2 closed.
- **MUST NOT post a verdict line whose grammar does not match one of the three closed-table forms.** Enforced by the exact-string unit tests on `composeVerdictLine`.
- **MUST NOT add a version-stamp block, footer marker, or any other metadata to the summary body.** Story 4.7 owns version stamping and idempotent reruns. v1 keeps the body minimal.
- **MUST NOT add labels to the PR.** Story 4.8 owns labelling.
- **MUST NOT mutate the manifest or the persisted `reviewer-result.json`.** The tool is read-only against state; the only side-effect is the `gh api` POST.
- **MUST NOT call `gh api` with `--method GET` or any read-only verb in v1.** The only `gh api` call in v1 is the POST to the reviews endpoint. Future stories may add reads; v1 does not.
- **MUST NOT add `postReviewerComments` to the reviewer persona's `tools_allow` list.** The tool is invoked from SKILL.md prose, not from inside the subagent. Adding it to the persona would invite a second mandatory tool call inside the reviewer — the prose-flake surface Story 4.6 worked to eliminate.

### NEVER

- **NEVER infer an inline-comment line from anything except a literal `@@ +<newStart>` hunk header for a `+++ b/<artifactPath>` match.** Heuristic line-picking (e.g. "find a line containing the artifact name") risks anchoring comments to unrelated context. If the path isn't in the diff, the finding folds into the summary body without an inline anchor — better no anchor than a wrong anchor.
- **NEVER spawn subagents from `postReviewerComments` or any MCP tool.** Subagent spawn is exclusively the SKILL.md prose layer's responsibility. (Same invariant as `runReviewerSession`, `processReviewerTranscript`, `processDevTranscript`.)
- **NEVER stack multiple `gh api` POSTs per reviewer cycle.** One review per cycle; many inline comments inside it.

---

## Implementation strategy

### Why a separate tool, not extending `runReviewerSession`

`runReviewerSession` is the read-and-execute step. Coupling posting into it would conflate two responsibilities (compute the verdict; post the verdict) and would make the test seam awkward (every `runReviewerSession` test would have to stub `gh api`). The separation matches the existing pattern: `runReviewerSession` writes a file; `processReviewerTranscript` reads it and mutates the manifest; `postReviewerComments` reads it and posts comments. Each tool has one read input (the file or the manifest), one output side-effect (a file write, a manifest move, a `gh api` POST). Clean seams; easy to test; easy to retire individually if a future architecture moves a piece.

### Why deterministic composition (no LLM step)

The Story 4.6 revision 2 lesson, applied one step further: anywhere a downstream surface needs a load-bearing artifact, the artifact must be composed by a deterministic tool. The PR review body is operator-load-bearing — the operator scans the verdict line to decide whether to merge. Letting an LLM author that line reintroduces the trial-7 failure mode (paraphrase, trailing prose, footer drift). The composer is a pure function; its output grammar is exhaustively unit-tested; the comment shape is fixed by construction.

The reviewer persona's chat output IS still LLM-authored — but it lives in Claude Code's transcript window, not on the PR. The operator can read it for context if they're watching the cycle live; the persisted PR review is the surface that lives beyond the session.

### Why a single `gh api` POST instead of `gh pr review` + per-comment fan-out

GitHub's reviews API treats inline comments as a sub-array of a single review POST. Posting them as separate top-level requests would either (a) require multiple `gh api` calls (fan-out + state coordination if any fails mid-stream), or (b) require the looser `gh pr comment` path which creates issue-level comments, not inline review comments. The single-POST shape is atomic, idempotent within the call, and produces the operator surface the AC describes (one "Reviewer commented" entry in the PR timeline carrying everything).

### Why `gh api` instead of a new `gh pr review-comment` subcommand entry

`gh pr review` exists and can post review summaries with `--body`, but its inline-comment support is limited (it doesn't expose the `--input` JSON path for inline comments cleanly). `gh api` exposes the raw REST endpoint which natively supports the `comments: []` shape. Adding `api` to the reviewer's `gh_allow` is one new permission entry; it's used only for this single endpoint. (`api` is broad — future stories should consider narrowing via `gh_allow_args` if other `gh api` calls land.)

### Why this story is `user-surface`

The reviewer's verdict is now visible on the PR — to anyone reading the PR list, not just to the operator watching the `/crew:start` session live. That changes the operator's mental model from "Claude Code told me what happened" to "the PR carries an inspectable verdict." That's a user-surface promise; AC5 makes it gateable.

---

## Locked files

The following files are off-limits to this story's implementation. If a change to any of these appears necessary, STOP and surface the conflict — do not edit.

- `plugins/crew/mcp-server/src/tools/complete-story.ts` (Story 4.1)
- `plugins/crew/mcp-server/src/tools/claim-next-story.ts` (Story 4.1 / 4.2)
- `plugins/crew/mcp-server/src/tools/claim-story.ts` (Story 4.1)
- `plugins/crew/mcp-server/src/tools/run-reviewer-session.ts` (Story 4.6 — this story is a sibling consumer of the persisted file; runReviewerSession is unchanged)
- `plugins/crew/mcp-server/src/tools/process-reviewer-transcript.ts` (Story 4.6 revision 2 — verdict transport contract unchanged. Task 1 EXTRACTS a helper out of this file; it does not modify the public behaviour.)
- `plugins/crew/catalogue/generalist-reviewer.md` (Story 4.6 — persona prose unchanged; `postReviewerComments` is NOT a persona tool)
- `plugins/crew/permissions/gh-error-map.yaml` (Story 4.5)
- `plugins/crew/skills/handoff-parser.js` and `plugins/crew/mcp-server/src/skills/handoff-parser.ts` (Story 4.3)
- `plugins/crew/mcp-server/src/skills/verdict-parser.ts` (Story 4.3 / 4.6 — `@deprecated`, no callers; do not undelete)

### Declared-locked-file changes (explicit exceptions)

- **`plugins/crew/mcp-server/src/tools/process-reviewer-transcript.ts`** (Story 4.6 revision 2) — Task 1 extracts the `readReviewerResultFile` helper into `lib/read-reviewer-result-file.ts`. The public behaviour, return-union, and `recommendedVerdict`-switching path are byte-identical after the extraction. Only the location of the helper changes; the existing test suite covers behaviour preservation.
- **`plugins/crew/mcp-server/src/lib/gh.ts`** (Story 4.4 / 4.5) — Task 4a adds an optional `input?: string` field that forwards to `execa`'s `input` option. Existing callers do not pass it; default behaviour is unchanged. The change is additive and the `execa` library natively supports `input`.
- **`plugins/crew/skills/start/SKILL.md`** (Stories 4.2 / 4.3b / 4.3c / 4.6) — Task 7 adds one entry to `allowed_tools` (`postReviewerComments`) and inserts one new step in the reviewer-handling block BEFORE the existing `processReviewerTranscript` call. The completion seam (4.3c) and the file-based verdict transport (4.6) are UNTOUCHED. The new step's failure modes are surfaced verbatim per the existing pattern.
- **`plugins/crew/permissions/generalist-reviewer.yaml`** (Stories 2.2 / 4.6) — Task 2 adds `- api` to `gh_allow`. Existing entries are preserved.

---

## Dev Notes

### Files this story will create

- `plugins/crew/mcp-server/src/tools/post-reviewer-comments.ts` (Task 4)
- `plugins/crew/mcp-server/src/tools/__tests__/post-reviewer-comments.test.ts` (Task 8)
- `plugins/crew/mcp-server/src/lib/read-reviewer-result-file.ts` (Task 1; extracted)
- `plugins/crew/mcp-server/src/lib/compose-reviewer-summary.ts` (Task 3)
- `plugins/crew/mcp-server/src/lib/find-hunk-line.ts` (Task 4.5 helper)
- `plugins/crew/mcp-server/src/lib/__tests__/compose-reviewer-summary.test.ts` (Task 3.3)
- `plugins/crew/mcp-server/src/lib/__tests__/find-hunk-line.test.ts` (Task 9)
- `plugins/crew/mcp-server/src/__tests__/test-helpers/gh-execa-stub.ts` (Task 8.2; extract if not already)

### Files this story will modify

- `plugins/crew/mcp-server/src/tools/process-reviewer-transcript.ts` (Task 1.2; helper extraction — no behavioural change)
- `plugins/crew/mcp-server/src/lib/gh.ts` (Task 4a; additive `input` field)
- `plugins/crew/mcp-server/src/tools/register.ts` (Task 5)
- `plugins/crew/mcp-server/src/errors.ts` (Task 6; one new error class)
- `plugins/crew/permissions/generalist-reviewer.yaml` (Task 2)
- `plugins/crew/skills/start/SKILL.md` (Task 7; allowed_tools + new step)
- Operator-smoke harness under `plugins/crew/mcp-server/src/__tests__/operator-smoke-helpers/` (Task 10)

### Current-state notes on files being modified

- **`process-reviewer-transcript.ts`** (current state per Story 4.6 revision 2): exports `processReviewerTranscript({ targetRepoRoot, sessionUlid, ref, manifestPath })`. Reads `reviewer-result.json` via inline `readReviewerResultFile` helper (lines ~110–158). Switches on `recommendedVerdict`. Task 1 extracts the helper; no behavioural change.
- **`gh.ts`** (current state per Stories 4.4 / 4.5): exports `gh({ role, permissions, subcommand, args?, execaImpl?, pluginRootOverride? })`. Subcommand kebab-splits into `gh` segments. Task 4a adds optional `input?: string` forwarded to `execaImpl`.
- **`SKILL.md`** (current state per Story 4.6): nine `allowed_tools` including `runReviewerSession`. The reviewer-handling step invokes `Task` to spawn the reviewer, then `processReviewerTranscript`. Task 7 inserts `postReviewerComments` between those two steps.
- **`generalist-reviewer.yaml`** (current state): four `gh_allow` entries. Task 2 adds `api`.
- **`run-reviewer-session.ts`** (current state per Story 4.6): exports `runReviewerSession`, persists `reviewer-result.json` with the projection shape per `ReviewerResultFileShape`. Locked for this story.

### Testing standards

- vitest with the existing pattern: `pnpm vitest --run` from the mcp-server directory.
- `vi.fn()` / `vi.spyOn()` for stubbing; no global mocks.
- tmpdir fixtures via `mkdtempSync` with `rmSync` teardown.
- `execaImpl` test seam for every `execa` call; never spawn real `gh` in tests.
- Use `makeDiscriminatingStub` (extract to a shared helper) to route by `cmd` / `args[0..1]`.
- AC4's integration suite lives in `tools/__tests__/`; unit suites in `lib/__tests__/`.

### References

- [Source: `_bmad-output/planning-artifacts/epics/epic-4-dev-review-loop-the-engineering-heart.md#Story 4.6b`]
- [Source: `plugins/crew/docs/user-surface-acs.md`] (user-surface tag conventions)
- [Source: `_bmad-output/implementation-artifacts/4-6-reviewer-subagent-read-sources-and-run-acs.md`] (verdict-transport contract this story consumes; revision-2 file shape)
- [Source: `plugins/crew/mcp-server/src/tools/run-reviewer-session.ts`] (`ReviewerResultFileShape` export and persistence path)
- [Source: `plugins/crew/mcp-server/src/tools/process-reviewer-transcript.ts`] (current location of `readReviewerResultFile`; Task 1 extracts)
- [Source: `plugins/crew/mcp-server/src/lib/gh.ts`] (gh wrapper; Task 4a additive change)
- [Source: `plugins/crew/permissions/generalist-reviewer.yaml`] (Task 2 adds `api`)
- [Source: `plugins/crew/skills/start/SKILL.md`] (Task 7 inserts the new step)
- [Source: `_bmad-output/implementation-artifacts/4-5-gh-error-map-yaml-and-recoverable-error-classification.md`] (recoverable-error contract; uncaught propagation)
- [Source: `_bmad-output/implementation-artifacts/4-4-dev-subagent-git-push-and-gh-pr-create-terminal-action.md`] (`gh` wrapper invocation pattern)
- Project memory: `project_reviewer_rubber_stamps.md`
- Project memory: `feedback_prose_mut_steps_need_seam.md`
- Project memory: `feedback_default_to_deterministic_seams.md`
- Project memory: `project_locked_phrase_grammar_drift.md` (the failure mode this story's deterministic composer prevents from reappearing on the PR surface)

---

## Previous story intelligence

### From Story 4.6 (just shipped)

- The verdict transport is `reviewer-result.json` at `<targetRepoRoot>/.crew/state/sessions/<sessionUlid>/`. Shape exported as `ReviewerResultFileShape` from `run-reviewer-session.ts`. v1 of `postReviewerComments` consumes this file as its sole input (plus a re-read of the diff).
- The `readReviewerResultFile` helper lives inline in `process-reviewer-transcript.ts`. Two tools need it (`processReviewerTranscript` and the new `postReviewerComments`); Task 1 extracts it cleanly into `lib/`.
- The reviewer persona's mandatory tool call is `runReviewerSession`. Do NOT add a second mandatory tool call inside the persona — that resurrects the prose-flake surface 4.6 worked to eliminate. The new tool is a SKILL.md-prose-invoked sibling.
- The Story 4.6 (3g) decision to persist only the verdict-relevant projection (no `prDiff`, no `sourceStory`) means `postReviewerComments` re-calls `gh pr diff`. That's intentional — keep the persisted file small; pay one extra `gh` round-trip per cycle.
- Story 4.6 Issue 2's `makeDiscriminatingStub` pattern is reusable; extract to a shared test helper.

### From Story 4.5

- `gh-error-map.yaml` v1 row set covers `pr diff` and `pr view` failures (rate-limit, auth, network-blip). The same classes apply to `gh api` failures and need no new entries.

### From Story 4.4

- The `gh` wrapper's subcommand kebab-split rule (`"pr-diff" → ["pr", "diff"]`) applies to `api → ["api"]` cleanly (single segment).

### From Story 4.3c

- The "tool-layer side-effects beat prose-level MUSTs" pattern (`completeStory` call inside `processReviewerTranscript`) is the template. This story applies the same pattern to comment-posting: SKILL.md prose calls one tool; the tool composes and posts; no prose-level MUST-instructions about comment format.

### Git intelligence (recent commits)

```
798e4f6 feat(4.6): runReviewerSession — read sources, run ACs, close the rubber-stamp loop (#109)
cc4acf3 feat(4.5): gh-error-map.yaml, recoverable-error classifier, and processDevTranscript routing (#108)
30fbaea feat(4.3c): completeStory side-effect on processReviewerTranscript drains the queue (#107)
ff2d5c4 feat(4.4): Dev subagent git push and gh pr create terminal action (#106)
5018a82 test(4.3b): add claim-next-story coverage and AC suite
```

Pattern: every Epic 4 commit follows `feat(4.X): <subject>`. Story 4.6b's commit follows `feat(4.6b): <subject>`.

---

## Latest tech information

### `gh api /repos/{owner}/{repo}/pulls/{number}/reviews` (verified 2026-05-24)

- POST with body `{ event, body, comments[] }` creates a review. Returns 200 with the created review JSON (carries `id`, `state`, `body`, etc.).
- `event: "COMMENT"` posts the review without an approval/changes-requested state (the negative-capability constraint per Story 4.8 — the reviewer agent must never `APPROVE` or `REQUEST_CHANGES`; comment-only is correct for v1).
- `comments[]` items shape: `{ path, line, body }` where `line` is the line number in the diff's `+` side. (Optional fields `side`, `start_line`, `start_side` for multi-line comments — v1 single-line only.)
- Authentication is implicit via `gh`'s authenticated session; no token plumbing needed.
- `gh api` with `--input -` reads the request body from stdin. `--method POST` is required (default is GET).

### `gh pr view <number> --json baseRepository`

- Returns `{"baseRepository":{"name":"<repo>","owner":{"login":"<owner>"}}}` on stdout.
- Cheaper than `gh repo view` (no extra round-trip; the PR object already carries the base repo).

### `execa` `input` option

- Accepts a string or Buffer; piped to the child process's stdin. Native execa support — no wrapper code needed beyond forwarding the option.

---

## Project context reference

This story is part of **Epic 4 (Dev + Review Loop)** — the engineering heart of the v1 plugin. Story 4.6 made the reviewer's verdict trustworthy (deterministic computation, file-based transport). Story 4.6b makes that verdict visible to anyone reading the PR — closing the "verdict lives in the operator's transcript only" gap. Without 4.6b, a future human reviewer scanning the PR list sees no machine-posted verification; they have to trust the dev's PR body and the commit history.

Sequencing: 4.6b unlocks 4.7 (which adds version-stamping + idempotent edit-in-place to the posted comments), 4.8 (which adds labels alongside the comments), and 4.10b (which auto-merges on `READY FOR MERGE` + low risk — relying on the operator-visible verdict trail this story produces).

---

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
