# Story 4.7: Verdict version stamping and footer-marker idempotent rerun

story_shape: user-surface

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

<!-- Revision 2 (2026-05-24): post-merge code-review amendment.
  Six defects flagged by high-effort review after PR #111 merged:
  (1) AC1 vs Task 2.2 contradiction — body format unified to embed literal
      `standards_version` and `plugin_version` tokens per AC1.
  (2) Date-style examples violated StandardsDocSchema semver constraint —
      all examples now use `1.2.3`-style versions.
  (3) Story 4.6b's "final-line == verdict" invariant inversion not addressed —
      added Task 5.0 to migrate 4.6b's affected assertions.
  (4) GET-reviews parse breaks on null-bodied prior reviews (Copilot, plain
      approvals) — schema now accepts `body: string | null` and search skips nulls.
  (5) Stale inline-comments on rework — flagged as deferred work in § DOES NOT (m).
  (6) Broad `gh api` permission from 4.6b is a negative-capability hole that
      Story 4.8 must narrow — flagged in § DOES NOT (n).
  Plus minor: Task 1.3 audit-all-test-files instruction; `wasEdit` SKILL.md
  branch clarified; `inlineCommentCount` widened to `number | null` on PATCH;
  `__resetPluginVersionCacheForTests()` required in tests not using override. -->


## Story

As a **plugin operator reading a verdict weeks later**,
I want **every verdict comment to carry the standards-doc version and the plugin version that produced it, and reruns to edit the prior verdict in place rather than stack new ones**,
so that **I can quickly see which version of the standards was used to review a PR (and whether the verdict pre-dates a standards update), and re-triggering a review doesn't clutter the PR with duplicate verdict comments**.

### What this story is, in one sentence

Extend `postReviewerComments` (Story 4.6b) to: (1) append a human-readable version line and a machine-parseable footer marker (`<!-- crew:verdict:<plugin-version>:<ref> -->`) to every posted summary body, and (2) before posting, list existing PR reviews and PATCH-edit any prior verdict comment whose footer marker matches the current story ref — closing the "stacking duplicate verdicts on rerun" gap Story 4.6b left open.

### What this story does (and why it needs its own story)

Story 4.6b shipped the comment-posting surface: `postReviewerComments` composes a deterministic summary body and posts it as a single PR review. But the posted body carries no provenance, and reruns stack new verdict comments rather than updating the existing one.

Two concrete gaps this creates:

1. **Traceability gap.** An operator reviewing a PR weeks later can't tell at a glance whether the verdict was produced by the current standards doc or a stale one. If the standards doc was updated between runs, the operator has no way to know the verdict pre-dates the update without cross-referencing the commit history.

2. **Rerun stacking.** If the operator triggers a second review pass (e.g. after a dev pushes a fix), `postReviewerComments` creates a second "Reviewer commented" entry on the PR. After three rework cycles the PR has three verdict entries; the operator has to read all three to find the latest.

Story 4.7 closes both gaps by: (1) adding a version block to `composeSummaryBody` (extending the two pure helpers, which are tested exhaustively), and (2) adding a prior-verdict search step to `postReviewerComments` that GETs existing reviews, scans for the footer-marker token, and PATCHes the prior comment if found.

The footer marker `<!-- crew:verdict:<plugin-version>:<ref> -->` is an HTML comment — invisible in rendered GitHub markdown, machine-parseable by the tool. It is the anchor for the idempotent-rerun search on every subsequent pass.

### What this story does NOT

- (a) Touch `_bmad-output/implementation-artifacts/sprint-status.yaml`. State transitions owned by the workflow harness.
- (b) Add risk-tier to the version block. Story 4.9/4.9b own risk-tier classification; v1's version block is `standards_version` + `plugin_version` only.
- (c) Add PR labels. Story 4.8 owns labelling.
- (d) Change the verdict-line grammar from Story 4.6b. `**Verdict: READY FOR MERGE**` / `**Verdict: NEEDS CHANGES** [...]` / `**Verdict: BLOCKED** [...]` are unchanged. The version line and footer marker are appended AFTER the verdict line.
- (e) Narrow `gh_allow_args` for the `api` subcommand added by Story 4.6b. A future story can narrow if needed; v1 uses the same broad `api` entry for GET, POST, and PATCH.
- (f) Handle the case where GitHub returns a non-200 on PATCH (e.g. 422 for a dismissed review). v1 propagates `GhApiResponseShapeError` uncaught; Epic 5 owns recovery.
- (g) Add the footer marker to inline comments. Only the top-level summary review body carries it. Inline diff-line comments (from Story 4.6b) are unchanged.
- (h) Include a timestamp in the footer marker. v1's marker is `<!-- crew:verdict:<plugin-version>:<ref> -->` — plugin version and story ref only.
- (i) Emit telemetry. Story 4.12 owns telemetry.
- (j) Change the `ReviewerSessionResult` in-memory type from Story 4.6. Only the persisted `reviewer-result.json` projection gains `standardsVersion`; the in-memory type is unchanged.
- (k) Touch `processReviewerTranscript`, `claimStory`, `completeStory`, or any state-machine primitive.
- (l) Create a new `getPluginVersion` helper. `lib/plugin-version.ts` already exports `getPluginVersion()` (sync, cached) and its JSDoc already cites Story 4.7 as a caller. Use it directly.
- (m) **Reconcile stale inline comments on rework.** PATCH cannot update inline comments (GitHub API limitation). When a rework cycle FIXES a previously-failing artifact-check, the original `AC<n> FAIL — ENOENT` inline comment persists on the diff line while the new summary body says `AC<n> ✅`. This is a real user-surface trust regression on Story 4.6b's AC1 contract (inline comments reflect verdict). v1 of this story does not solve it — the rationale (line ~277 in § Implementation strategy) downgrades it to "cosmetic" but that is a deferred call, not a designed-around solution. Follow-up story should either (a) resolve stale inline comments on rework via `gh api PATCH /repos/.../pulls/comments/<id>` with body annotation or `gh api DELETE`, (b) hide-then-re-post the review on rework, or (c) explicitly retire Story 4.6b's inline-comment promise. Out of scope here; surfaced as deferred work.
- (n) **Narrow `gh_allow` for `api`.** Story 4.6b added bare `- api` with no `gh_allow_args` constraint. The reviewer can call `gh api` with any URL and any `--method`. Story 4.7's GET+PATCH usage widens the practical surface. **This is a negative-capability hole that Story 4.8 (next in epic; enforces "reviewer never merges/closes/pushes") MUST narrow** — e.g. via `gh_allow_args["api"]` restricting URLs to `/repos/<owner>/<repo>/pulls/<n>/reviews(/<id>)?` and methods to GET/POST/PATCH. v1 of this story does not narrow; defer to 4.8 implementer, who needs to know `api` is currently unconstrained.

---

## Acceptance Criteria

> AC1 and AC2 are verbatim from the epic. AC3 is the integration suite. AC4 is the user-surface contract — the operator-observable promise that the version stamp is visible and reruns are idempotent. Per `plugins/crew/docs/user-surface-acs.md`, AC4 is tagged `(user-surface)`; the others describe internal behaviour and stay untagged.

**AC1:**
**Given** the reviewer's summary comment (composed and posted by `postReviewerComments`),
**When** posted (first run) or PATCH-edited (rerun),
**Then** the body includes both `standards_version` (from `reviewer-result.json`'s `standardsVersion` field) and `plugin_version` (from `getPluginVersion()`) in the stable format described in AC1 unpacked, and ends with the footer marker `<!-- crew:verdict:<plugin-version>:<ref> -->` as its absolute last line. _(FR35, NFR22)_

<!-- Not user-surface: AC1 describes the comment body's content-structure — what fields are present and in what order. The operator-observable promise is AC4. -->

**AC2:**
**Given** a PR with a prior verdict comment that carries the footer marker `<!-- crew:verdict:[^:]+:<ref> -->` (any plugin version, same story ref),
**When** the reviewer reruns (`postReviewerComments` is called again for the same story and PR),
**Then** it locates the prior comment by scanning existing PR reviews for the footer-marker pattern, and PATCH-edits the prior review body in place; no new review is posted. _(FR39, NFR11)_

<!-- Not user-surface: AC2 describes the PATCH path inside `postReviewerComments`. The operator-observable effect (single comment on the PR after rerun) is AC4. -->

**AC3 (integration):**
vitest runs `postReviewerComments` twice against the same fixture PR (first run: GET returns empty review list, POST creates a new review with `id: 1`; second run: GET returns `[{ id: 1, body: "...<footer-marker>..." }]`, PATCH updates the prior review) and asserts: `gh api POST` stub was called exactly once, `gh api PATCH` stub was called exactly once, and the body passed to both POST and PATCH contains the version line and footer marker as the last line.

<!-- Not user-surface: vitest integration suite — internal harness only. -->

**AC4 (user-surface):**
**Given** a target repo where `/crew:start` has already completed one review pass for a story (a first verdict comment with the footer marker exists on the PR),
**When** the operator runs `/crew:start` again for the same story and the inner cycle invokes `postReviewerComments`,
**Then** the operator observes:
- (a) **Exactly one verdict comment** on the PR after the second run — the prior comment was edited in place, not duplicated. Running `gh pr view <prNumber> --comments` shows one reviewer comment, not two.
- (b) **Version information visible** in the comment body: the literal tokens `standards_version:` and `plugin_version:` appear in the body (e.g. `` `standards_version: 1.2.3` · `plugin_version: 0.1.0` ``).
- (c) **The footer marker** `<!-- crew:verdict:` appears at the end of the comment body (inspectable via raw GitHub view or `gh api`).

<!-- User-surface: AC4 references `/crew:start` (slash command) and the PR surface observable via `gh pr view --comments`. -->

### Expanded acceptance specifics

**AC1 unpacked.** Version block format and footer-marker placement:

- (1a) **`standardsVersion` on the persisted file (declared locked-file change on Story 4.6):** `runReviewerSession` adds `standardsVersion: string` to the `reviewer-result.json` projection, populated from `standards.version` (the `StandardsDoc.version` field already read by `lookupStandards` inside the composite tool). The `ReviewerResultFileShape` interface and its Zod schema gain `standardsVersion: string`. The in-memory `ReviewerSessionResult` type is NOT changed. The `readReviewerResultFile` helper (extracted by Story 4.6b) Zod schema is extended with `standardsVersion: z.string().optional().default("")` for backward compatibility when reading files produced by a pre-4.7 plugin build.

- (1b) **`plugin_version` source:** use the existing `getPluginVersion()` from `plugins/crew/mcp-server/src/lib/plugin-version.ts`. It is sync, load-once cached, reads from `.claude-plugin/plugin.json`. No new helper is needed. Call it inside `postReviewerComments` with no arguments (it resolves the plugin root itself via `fileURLToPath`).

- (1c) **Version block placement in the summary body:** `composeSummaryBody` is extended to accept `{ standardsVersion: string, pluginVersion: string }` as additional parameters (alongside the existing `ReviewerResultFileShape` input). The version block is appended to the body AFTER the verdict line. The body format embeds the literal tokens `standards_version` and `plugin_version` (verbatim from AC1, which is verbatim from epic):
  ```
  **Verdict: READY FOR MERGE**

  `standards_version: <standardsVersion>` · `plugin_version: <pluginVersion>`
  <!-- crew:verdict:<pluginVersion>:<ref> -->
  ```
  The `ref` value comes from `result.ref` in the file shape. The HTML comment `<!-- crew:verdict:... -->` is invisible in rendered GitHub markdown; it is the absolute last line of the body string (no trailing newline after it). The version line is one blank line below the verdict line for visual breathing room. The backtick code-spans make the field names visually distinct and greppable in raw markdown.

- (1d) **Footer-marker format (verbatim):** `<!-- crew:verdict:<pluginVersion>:<ref> -->`. Single space after `<!--` and before `-->`. The `<ref>` component is the story ref embedded literally (e.g. `native:01HZ-fixture-story`, `bmad:PROJ-123`). If the ref contains special characters they are included verbatim — the marker is an HTML comment and needs no encoding.

- (1e) **`composeVerdictLine` is unchanged:** the function still returns exactly one of the three sentinel-form strings from Story 4.6b. The version block and footer marker are appended by `composeSummaryBody` AFTER calling `composeVerdictLine`. The `composeVerdictLine` signature and return type do not change.

- (1f) **Unit test extensions for `composeSummaryBody`:** Story 4.6b's existing test suite is extended with cases asserting (using exact-string assertions on the output):
  - The version line `` `standards_version: <standardsVersion>` · `plugin_version: <pluginVersion>` `` appears verbatim (exact-string match including backticks and the middle-dot separator `·`).
  - The literal tokens `standards_version` and `plugin_version` appear in the body (deterministic content-structure check — directly satisfies AC1).
  - The footer marker `<!-- crew:verdict:<pluginVersion>:<ref> -->` is the absolute last line of the body (`body.split("\n").at(-1) === marker`).
  - The verdict line immediately precedes the version block (order assertion: verdict line position < version line position < footer marker position).
  - When `standardsVersion` is `""` (file produced by pre-4.7 build, `.optional().default("")` in effect): the version line renders `` `standards_version: (unknown)` · `plugin_version: <pluginVersion>` ``.

**AC2 unpacked.** Prior-verdict search, PATCH path, and POST fallback:

- (2a) **New Step 4a in `postReviewerComments`:** inserted AFTER the existing Step 4 (PR-context resolution: `owner`, `repo` from `gh pr view`) and BEFORE Step 5 (inline-comment generation). Step 4a:
  1. Call `getPluginVersion()` to obtain `pluginVersion` (sync; the call is inside the `postReviewerComments` async function but the function itself is sync-returns-string).
  2. Call `gh({ role, permissions, subcommand: "api", args: ["/repos/${owner}/${repo}/pulls/${prNumber}/reviews", "--method", "GET"], execaImpl })`. Parse the response as `Array<{ id: number; body: string | null }>`. On non-array or parse failure, raise `GhApiResponseShapeError({ subcommand: "api", url: "/reviews", cause })`. Note: `body: null` is COMMON on real PRs — GitHub returns `body: null` for approval-only reviews (Copilot, plain approvals, CODEOWNERS auto-reviews). The Zod schema MUST accept `body: z.string().nullable()` (or `z.string().optional()`) so null-bodied prior reviews don't crash the GET parse.
  3. Search the array for the FIRST item whose `body` is a non-null string AND matches the JS regex `new RegExp("<!-- crew:verdict:[^:]+:" + escapeRegex(result.ref) + " -->")`. Reviews with `body == null` are SKIPPED in the search (treated as non-matching, not as errors). Store the matching `id` as `priorReviewId: number | null`.

- (2b) **`escapeRegex` helper:** a one-liner pure function `(s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")`. Inline in `post-reviewer-comments.ts` or extracted to `lib/escape-regex.ts` — implementer's choice. Unit-test via the AC3 fixture.

- (2c) **PATCH path (edit-in-place):** if `priorReviewId !== null`, call `gh({ role, permissions, subcommand: "api", args: ["/repos/${owner}/${repo}/pulls/${prNumber}/reviews/${priorReviewId}", "--method", "PATCH", "--input", "-"], input: JSON.stringify({ body: newSummaryBody }), execaImpl })`. Parse response for `id`. Return `{ next: "posted", postedReviewId: priorReviewId, wasEdit: true, priorReviewId, inlineCommentCount: null, verdictLine }`. NOTE: `inlineCommentCount: null` (not 0) signals "this PATCH did not author inline comments; the original POST's inline comments persist on the review" — distinct from "this review has 0 inline comments". Downstream consumers (telemetry, chat surfaces) MUST treat `null` as "unknown / unchanged from prior pass", not as zero. NOTE: on the PATCH path, the `comments` array (inline comments) from Story 4.6b is NOT re-submitted — GitHub's PATCH reviews endpoint updates the review body only; inline comments cannot be updated in bulk. v1 accepts this limitation: the inline comments from the first pass remain as-is; only the summary body is updated. The downside (stale inline comments after rework — see § What this story does NOT (m)) is acknowledged as deferred work.

- (2d) **POST fallback:** if `priorReviewId === null`, the existing POST path from Story 4.6b runs unchanged (the full `{ event, body, comments }` payload). `wasEdit = false`, `priorReviewId = null`.

- (2e) **`PostReviewerCommentsResult` shape extension:** the `"posted"` variant gains two additional fields: `wasEdit: boolean` and `priorReviewId: number | null`. The existing `inlineCommentCount: number` widens to `number | null` (PATCH path returns `null`; POST path returns the count as before). The `"skipped-no-session-result"` variant is unchanged.

- (2f) **GET response edge cases:**
  - Empty array (no reviews yet): `priorReviewId = null`; POST path taken.
  - Review list contains a footer marker for a DIFFERENT `ref` (same PR, different story): no match; POST path taken. Rationale: the operator may run multiple stories' reviewer passes against the same PR (unlikely in v1 but possible); the ref in the marker ensures we only update our own verdict.
  - `gh api GET` returns `GhRecoverableError` (rate limit, auth, network): propagates uncaught, same surface as all other `gh` errors in this tool.

**AC3 unpacked.** Two-run integration test:

- (3a) **Fixture base:** tmpdir with `<tmp>/.crew/state/sessions/<sessionUlid>/reviewer-result.json` populated with `{ sessionUlid, ref: "native:01HZ-fixture-story", recommendedVerdict: "READY FOR MERGE", acResults: {}, standardsByCriterionId: {}, sourceStoryRef: "native:01HZ-fixture-story", prNumber: 42, standardsVersion: "1.2.3" }`. The `pluginVersionOverride: "1.0.0-test"` seam is used. NOTE: `standardsVersion` in the projection file is just a `string` (no validation), but production values come from `lookupStandards` which enforces strict semver via `StandardsDocSchema.version: /^\d+\.\d+\.\d+$/` — fixtures that round-trip through `lookupStandards` (e.g. by writing a real `docs/standards.md`) MUST use semver values like `1.2.3`, not date-style.

- (3b) **Discriminating stub routing:**
  - `gh pr diff 42` → fixture unified diff (same as Story 4.6b's stub).
  - `gh pr view 42 --json baseRepository` → `{"baseRepository":{"name":"crew","owner":{"login":"jackmcintyre"}}}`.
  - `gh api /repos/.../pulls/42/reviews --method GET`:
    - First invocation: returns `[]`.
    - Second invocation: returns `[{ "id": 1, "body": "# Reviewer summary...\n**Verdict: READY FOR MERGE**\n\n`standards_version: 1.2.3` · `plugin_version: 1.0.0-test`\n<!-- crew:verdict:1.0.0-test:native:01HZ-fixture-story -->" }]`.
    - Coverage for null-bodied prior reviews: include in the GET fixture an additional review like `{ "id": 99, "body": null }` (Copilot/approval-only shape) to assert the search skips it without raising.
  - `gh api /repos/.../pulls/42/reviews --method POST --input -` → `{"id":1}`.
  - `gh api /repos/.../pulls/42/reviews/1 --method PATCH --input -` → `{"id":1}`.

- (3c) **First-run assertions:** `wasEdit === false`; POST stub called once; PATCH stub NOT called; the body in the POST `input` has `<!-- crew:verdict:1.0.0-test:native:01HZ-fixture-story -->` as the last line.

- (3d) **Second-run assertions:** `wasEdit === true`, `priorReviewId === 1`; PATCH stub called once with body in `input`; POST stub NOT called on second run; the body in the PATCH `input` also has the footer marker as the last line.

- (3e) **Wrong-ref non-match:** a third test case where the GET returns `[{ id: 2, body: "<!-- crew:verdict:1.0.0:different-ref -->" }]` — asserts POST path is taken (no match for `native:01HZ-fixture-story`), `wasEdit === false`.

**AC4 unpacked.** Operator-smoke contract:

- (4a) **Smoke extension:** extend the Story 4.6b operator-smoke harness with a second `postReviewerComments` invocation. The discriminating stub follows (3b): first call's GET returns `[]`; second call's GET returns the prior verdict with the footer marker. Assert per (4b).

- (4b) **Operator-observable assertions:**
  - POST stub called exactly once across both invocations.
  - PATCH stub called exactly once on the second invocation.
  - The body in both POST and PATCH payloads contains both literal tokens `standards_version:` and `plugin_version:` (exact-string `.includes` checks) and the footer marker (`<!-- crew:verdict:`).
  - The SKILL.md prose's chat log for the second pass includes `wasEdit: true` context (the chat-line variant from Task 5).

- (4c) **Smoke-gate tag:** tagged per `plugins/crew/docs/user-surface-acs.md`. Operator may substitute manual-paste evidence per § Pre-PR gate.

---

## Tasks / Subtasks

Implementation order is load-bearing.

- [x] **Task 1: Extend `ReviewerResultFileShape` to carry `standardsVersion`** (AC: #1)
  - [x] 1.1 Open `plugins/crew/mcp-server/src/tools/run-reviewer-session.ts`. Add `standardsVersion: string` to the `ReviewerResultFileShape` interface. In the projection-write step (where `fileProjection` is assembled before `atomicWriteFile`), populate `standardsVersion: standards.version` (the `standards` local variable already holds the `StandardsDoc` return from `lookupStandards`). The in-memory `ReviewerSessionResult` type is NOT changed.
  - [x] 1.2 Open `plugins/crew/mcp-server/src/lib/read-reviewer-result-file.ts` (extracted by Story 4.6b). Widen the Zod schema to include `standardsVersion: z.string().optional().default("")` for backward compatibility when reading pre-4.7 projection files. Update the return-type annotation to match.
  - [x] 1.3 Audit all test files that hand-craft `reviewer-result.json` content (grep for `ReviewerResultFileShape` and `recommendedVerdict` in the test tree to find every site — at minimum `process-reviewer-transcript.test.ts`, `run-reviewer-session.test.ts`, and any inner-cycle integration tests). Add `standardsVersion: "1.2.3"` (or any semver-shaped string) to each fixture. Tests relying on `.optional().default("")` do not need this but it is good practice. Verify `pnpm build` passes — TypeScript will surface any fixture site you missed once `standardsVersion: string` is non-optional on the interface.

- [x] **Task 2: Extend `composeSummaryBody` with version block and footer marker** (AC: #1, #3)
  - [x] 2.1 Open `plugins/crew/mcp-server/src/lib/compose-reviewer-summary.ts`. Extend `composeSummaryBody` to accept `{ standardsVersion: string; pluginVersion: string }` as additional parameters (alongside the existing `ReviewerResultFileShape` input). Add them as a second argument object or merge into a unified options shape — match the existing function's style.
  - [x] 2.2 After the verdict line, append version block and footer marker. The footer marker is the absolute last character sequence in the returned string (no trailing newline).
  - [x] 2.3 `composeVerdictLine` is unchanged — do not modify it.
  - [x] 2.4 Extend `plugins/crew/mcp-server/src/lib/__tests__/compose-reviewer-summary.test.ts` with all required assertions.

- [x] **Task 3: Add prior-verdict search and PATCH to `postReviewerComments`** (AC: #2, #3)
  - [x] 3.1 Open `plugins/crew/mcp-server/src/tools/post-reviewer-comments.ts`. Add `pluginVersionOverride?: string` test seam.
  - [x] 3.2 Import `getPluginVersion` from `../lib/plugin-version.js`. In `postReviewerComments`, call `const pluginVersion = pluginVersionOverride ?? getPluginVersion()`.
  - [x] 3.3 After Step 4 (PR-context resolution) and before Step 5 (inline-comment generation), insert Step 4a: GET existing reviews, search for prior verdict, store `priorReviewId`.
  - [x] 3.4 Pass `{ standardsVersion: result.standardsVersion, pluginVersion }` to `composeSummaryBody`.
  - [x] 3.5 If `priorReviewId !== null`: PATCH path. `wasEdit = true`.
  - [x] 3.6 If `priorReviewId === null`: existing POST path. `wasEdit = false`.
  - [x] 3.7 Update `PostReviewerCommentsResult`'s `"posted"` variant to include `wasEdit: boolean` and `priorReviewId: number | null`.
  - [x] 3.8 Implement `escapeRegex` — inline one-liner in `post-reviewer-comments.ts`.

- [x] **Task 4: Update the SKILL.md chat-log step** (AC: #4)
  - [x] 4.1 Open `plugins/crew/skills/start/SKILL.md`. Add `wasEdit` handling: `wasEdit === true` → `reviewer-comments updated in place on PR #<prNumber>`.
  - [x] 4.2 The `allowed_tools` array is NOT widened — no new MCP tools are registered by this story.

- [x] **Task 5: Integration test suite extension** (AC: #3, #4)
  - [x] 5.0 **Migrate Story 4.6b's existing test assertions whose contract was "final-line == verdict".** All final-line assertions updated to check footer marker is last line and verdict is in body.
  - [x] 5.1 Extend `post-reviewer-comments.test.ts` with two-run scenario, wasEdit assertions, wrong-ref non-match, null-body skip.
  - [x] 5.2 Extend `makeDiscriminatingStub` routing to handle `gh api GET .../reviews` and `gh api PATCH .../reviews/<id>`.

- [x] **Task 6: Operator-smoke extension for AC4** (AC: #4)
  - [x] 6.1 Extend the Story 4.6b operator-smoke harness with second `postReviewerComments` call.
  - [x] 6.2 Assert body contains version line and footer marker on both runs.
  - [x] 6.3 Tagged per smoke-gate convention.

- [x] **Task 7: Build, vitest, dist** (AC: all)
  - [x] 7.1 `pnpm build` passes. `dist/` committed per CLAUDE.md.
  - [x] 7.2 All vitest tests pass (938 pass, 0 fail). No tool-count assertion bumped.
  - [x] 7.3 `canonical-fs-guard.test.ts` still passes.

---

## Behavioural contract (user-surface)

**These invariants MUST hold at all times in the running plugin. If a future change appears to break one, the change is wrong — revisit the story or open a follow-up.**

### MUST

- **MUST append a version line and footer marker to every posted summary body.** Format: `` `standards_version: <standardsVersion>` · `plugin_version: <pluginVersion>` `` followed by `<!-- crew:verdict:<pluginVersion>:<ref> -->` as the absolute last line. The literal tokens `standards_version` and `plugin_version` MUST appear verbatim (verbatim from AC1, verbatim from epic). Enforced by extended `composeSummaryBody` unit tests.
- **MUST search existing PR reviews for a footer-marker match before posting.** One GET call per `postReviewerComments` invocation. If found, PATCH; else POST.
- **MUST use the exact footer-marker format for both writing and searching.** The written format and the search regex MUST be kept in sync; drift in either direction breaks idempotent reruns.
- **MUST propagate `GhApiResponseShapeError`, `GhRecoverableError`, `PluginManifestMissingError` (from `getPluginVersion`), and `GhSubcommandDeniedError` verbatim.** No swallow, no retry.
- **MUST set `wasEdit: true` and carry `priorReviewId` on the PATCH path.**

### MUST NOT

- **MUST NOT post a new review when a prior verdict comment exists for the same ref.** Duplicate posting is the exact failure mode this story closes.
- **MUST NOT include the `comments` inline-comment array in the PATCH body.** GitHub's PATCH reviews endpoint updates the review body only; the `comments` array is for the initial POST. Sending it on PATCH would create duplicate inline comments.
- **MUST NOT add the footer marker or version block to inline diff-line comments.** Only the top-level summary review body carries them.
- **MUST NOT change the verdict-line grammar** from Story 4.6b's three sentinel forms. The version block is appended after the verdict line; it does not replace it.
- **MUST NOT touch sprint-status.yaml or any orchestrator-state file.**

### NEVER

- **NEVER match a prior verdict from a different story ref.** The footer-marker search regex includes the current story ref; a prior verdict for a co-located review pass on the same PR but a different story must NOT be overwritten.
- **NEVER POST a new review AND PATCH the prior one in the same invocation.** One side-effect per invocation: either PATCH (edit path) or POST (first-run path). Never both.
- **NEVER spawn subagents from `postReviewerComments` or any MCP tool.** Subagent spawn is exclusively the SKILL.md prose layer's responsibility.

---

## Implementation strategy

### Why version metadata is embedded in the body (not a separate comment)

A separate "metadata" comment would add a second PR timeline entry per review pass, compounding the stacking problem. Embedding the version line (human-readable) and the footer marker (machine-parseable HTML comment, invisible in rendered markdown) in the existing summary body keeps the PR timeline clean — one review per pass regardless of how many rework cycles occur.

### Why PATCH the existing review (not delete + re-post)

`PATCH /repos/{owner}/{repo}/pulls/{prNumber}/reviews/{review_id}` updates the body atomically. Delete + re-post would: (a) briefly remove the verdict (race with a human reading the PR), (b) reset the review's creation timestamp (losing audit trail), and (c) require two `gh api` calls instead of one. PATCH is the correct tool.

### Why inline comments are NOT re-submitted on PATCH

GitHub's reviews API `PATCH` endpoint only accepts `{ body }` — it does not support updating or appending inline comments. Inline comments on a PR review are immutable after the review is created. v1 accepts this: the inline artifact-check comments from the first pass remain accurate across rework cycles (they anchor to specific diff lines that were added in the original commit; if the dev fixes the artifact in a new commit, those lines are still present). If the diff changes significantly between rework passes, inline comments may become stale — but that is cosmetic, not a correctness issue, and is addressed by the human operator inspecting the summary body.

### Why the footer marker uses `:` as the separator (despite refs containing `:`)

The footer marker format `<!-- crew:verdict:<plugin-version>:<ref> -->` is designed to be searched with a regex that matches ANY plugin version (`[^:]+`) followed by the LITERAL ref (including its `:` separators). The search regex uses `escapeRegex(result.ref)` to match the ref verbatim, so the colon in `native:01HZ-...` is matched literally (`\:`). The `[^:]+` before it greedily matches the plugin version segment (which by semver convention contains no colons). This is unambiguous.

### Why `standardsVersion` is added to the projection file (not re-read from disk)

`postReviewerComments` could call `lookupStandards(targetRepoRoot)` again. But the projection file was designed as the single source of truth for the reviewer cycle's verdict-relevant data (Story 4.6 revision 2 rationale). Adding `standardsVersion` is consistent with that design: the file captures what the reviewer USED, not what the current standards doc says. If the operator updates `docs/standards.md` between `runReviewerSession` and `postReviewerComments`, the version stamp correctly reflects the review's actual inputs, not the current state.

---

## Locked files

Files off-limits to this story. If a change appears necessary, STOP and surface the conflict.

- `plugins/crew/mcp-server/src/tools/complete-story.ts` (Story 4.1)
- `plugins/crew/mcp-server/src/tools/claim-next-story.ts` (Story 4.1 / 4.2)
- `plugins/crew/mcp-server/src/tools/claim-story.ts` (Story 4.1)
- `plugins/crew/mcp-server/src/tools/process-reviewer-transcript.ts` (Story 4.6 revision 2)
- `plugins/crew/catalogue/generalist-reviewer.md` (Story 4.6)
- `plugins/crew/permissions/gh-error-map.yaml` (Story 4.5)
- `plugins/crew/mcp-server/src/lib/find-hunk-line.ts` (Story 4.6b)
- `plugins/crew/mcp-server/src/lib/plugin-version.ts` (Story 1.9; already cites Story 4.7 as a caller — use as-is, do NOT modify)
- `plugins/crew/mcp-server/src/skills/verdict-parser.ts` (Story 4.3/4.6 — `@deprecated`, no callers)

### Declared-locked-file changes (explicit exceptions)

- **`plugins/crew/mcp-server/src/tools/run-reviewer-session.ts`** (Story 4.6) — Task 1 adds `standardsVersion: string` to `ReviewerResultFileShape` and populates it from `standards.version` in the projection-write step. Bounded: one new field on the projection object; the in-memory `ReviewerSessionResult` type is unchanged; existing tests remain green (additive field, no behaviour change to existing paths).
- **`plugins/crew/mcp-server/src/lib/read-reviewer-result-file.ts`** (Story 4.6b) — Task 1.2 extends the Zod schema with `standardsVersion: z.string().optional().default("")`. Purely additive and backward-compatible; existing `processReviewerTranscript` tests pass unchanged.
- **`plugins/crew/mcp-server/src/lib/compose-reviewer-summary.ts`** (Story 4.6b) — Task 2 adds the version block and footer marker. `composeVerdictLine` is unchanged. The `composeSummaryBody` signature gains two new required parameters; callers are updated in Task 3.
- **`plugins/crew/mcp-server/src/tools/post-reviewer-comments.ts`** (Story 4.6b) — Task 3 inserts the GET prior-verdict search step and conditional PATCH/POST logic. The existing inline-comment generator, `skipped-no-session-result` return path, and Step 5–8 structure (inline comments, POST) are preserved; GET + conditional PATCH are inserted between Steps 4 and 5.
- **`plugins/crew/skills/start/SKILL.md`** (Stories 4.2/4.3b/4.3c/4.6/4.6b) — Task 4 adds the `wasEdit`-conditional chat line to the `postReviewerComments` result handler. `allowed_tools` is NOT widened.

---

## Dev Notes

### Files this story will create

- None required — all changes are to existing files.
- Optional: `plugins/crew/mcp-server/src/lib/escape-regex.ts` (if not inlined — implementer's choice).

### Files this story will modify

- `plugins/crew/mcp-server/src/tools/run-reviewer-session.ts` (Task 1; `standardsVersion` projection field)
- `plugins/crew/mcp-server/src/lib/read-reviewer-result-file.ts` (Task 1.2; Zod schema widening)
- `plugins/crew/mcp-server/src/lib/compose-reviewer-summary.ts` (Task 2; version block + footer marker)
- `plugins/crew/mcp-server/src/lib/__tests__/compose-reviewer-summary.test.ts` (Task 2.4)
- `plugins/crew/mcp-server/src/tools/post-reviewer-comments.ts` (Task 3; GET search + PATCH path)
- `plugins/crew/mcp-server/src/tools/__tests__/post-reviewer-comments.test.ts` (Task 5)
- `plugins/crew/skills/start/SKILL.md` (Task 4; wasEdit chat line)
- Operator-smoke harness under `plugins/crew/mcp-server/src/__tests__/operator-smoke-helpers/` (Task 6)
- `plugins/crew/mcp-server/dist/` (rebuild; commit per CLAUDE.md)

### Current-state notes on files being modified

- **`run-reviewer-session.ts`** (Story 4.6 revision 2): `ReviewerResultFileShape` projection contains `{ sessionUlid, ref, recommendedVerdict, acResults, standardsByCriterionId, sourceStoryRef, prNumber }`. The `standards.version` field is already held in-memory (it is part of `ReviewerSessionResult.standards` from `lookupStandards`). Task 1 threads it into the projection.
- **`compose-reviewer-summary.ts`** (Story 4.6b): exports `composeVerdictLine(result: ReviewerResultFileShape)` and `composeSummaryBody(result: ReviewerResultFileShape)`. Task 2 adds two parameters to `composeSummaryBody`.
- **`post-reviewer-comments.ts`** (Story 4.6b): five-to-eight-step async function. Current Step 4 resolves `owner/repo` via `gh pr view`. Task 3 inserts a new Step 4a between Step 4 and Step 5 (inline comments).
- **`plugin-version.ts`** (Story 1.9): exports `getPluginVersion(): string` and `__resetPluginVersionCacheForTests(): void`. Its JSDoc explicitly names Story 4.7 as a caller. Use it as-is.

### Testing standards

- vitest with the existing pattern: `pnpm vitest --run` from the mcp-server directory.
- `vi.fn()` / `vi.spyOn()` for stubbing; no global mocks.
- `execaImpl` / `pluginVersionOverride` test seams for all external calls.
- `__resetPluginVersionCacheForTests()` in `beforeEach` for any test touching `getPluginVersion`.
- `__resetGhErrorMapCacheForTests()` in `beforeEach` (Story 4.5 pattern).

### Dependencies

- Story 4.6 (`runReviewerSession`, `ReviewerResultFileShape`, `reviewer-result.json` shape, `standards.version` in-memory)
- Story 4.6b (`postReviewerComments`, `composeSummaryBody`, `composeVerdictLine`, `readReviewerResultFile`, `PostReviewerCommentsResult`, `GhApiResponseShapeError`, `makeDiscriminatingStub` test helper)

### References

- [Source: `_bmad-output/planning-artifacts/epics/epic-4-dev-review-loop-the-engineering-heart.md#Story 4.7`]
- [Source: `plugins/crew/docs/user-surface-acs.md`] (user-surface tag conventions)
- [Source: `_bmad-output/implementation-artifacts/4-6b-reviewer-posts-inline-comments-and-summary-verdict.md`] (the story this extends)
- [Source: `_bmad-output/implementation-artifacts/4-6-reviewer-subagent-read-sources-and-run-acs.md`] (projection file shape; `standards.version` note)
- [Source: `plugins/crew/mcp-server/src/lib/plugin-version.ts`] (existing `getPluginVersion()` — cites Story 4.7)
- [Source: `plugins/crew/mcp-server/src/tools/run-reviewer-session.ts`] (current `ReviewerResultFileShape` definition)

---

## Previous story intelligence

### From Story 4.6b (just shipped / in-progress)

- `postReviewerComments` always POSTs a new review. The PATCH extension in this story replaces the POST on the edit path; the `gh api` subcommand and `--input` pipe pattern remain unchanged.
- `composeSummaryBody` is pure and unit-tested. The version-block extension adds two parameters; existing test cases gain the version block in their expected output (additive).
- The `makeDiscriminatingStub` shared helper routes by `cmd` and `args[0..1]`. Extend to route `gh api GET .../reviews` and `gh api PATCH .../reviews/<id>` in Task 5.2.

### From Story 4.6

- `standards.version` is available in the composite tool's in-memory return at the point the projection is written. The explicit note in Story 4.6 (3e): "Story 4.7 will read it for version stamping. v1 just preserves it." — Task 1 makes that actionable.
- `lib/plugin-version.ts` already exists and already names Story 4.7 in its JSDoc. No new helper needed.

### Git intelligence (recent commits)

```
798e4f6 feat(4.6): runReviewerSession — read sources, run ACs, close the rubber-stamp loop (#109)
cc4acf3 feat(4.5): gh-error-map.yaml, recoverable-error classifier, and processDevTranscript routing (#108)
30fbaea feat(4.3c): completeStory side-effect on processReviewerTranscript drains the queue (#107)
ff2d5c4 feat(4.4): Dev subagent git push and gh pr create terminal action (#106)
```

Pattern: Epic 4 commits follow `feat(4.X): <subject>`. Story 4.7's commit follows `feat(4.7): <subject>`.

---

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

None — clean run, all ACs satisfied without debug iterations.

### Completion Notes List

- Task 1: Added `standardsVersion: string` to `ReviewerResultFileShape` interface and populated it from `standards.version` in `runReviewerSession`'s projection write. Extended `readReviewerResultFile` to backfill `""` for pre-4.7 files (no Zod used, manual backfill in the parsed object for backward compat). Updated 5 fixture factories across 5 test files to include `standardsVersion: "1.2.3"`.
- Task 2: Extended `composeSummaryBody` to accept `ComposeSummaryBodyVersionInfo { standardsVersion, pluginVersion }` as second argument. Appended version line and footer marker after verdict line. Footer marker is absolute last line (concatenated, not in parts array). Rewrote and extended compose-reviewer-summary.test.ts with new Story 4.7 assertions.
- Task 3: Added `escapeRegex` helper inline in `post-reviewer-comments.ts`. Added Step 4a (GET reviews, search for prior verdict footer marker, store `priorReviewId`). PATCH path returns `wasEdit: true, inlineCommentCount: null`. POST path returns `wasEdit: false`. Updated `PostReviewerCommentsResult` `"posted"` variant with `wasEdit`, `priorReviewId`, and widened `inlineCommentCount: number | null`. Added `pluginVersionOverride` seam.
- Task 4: Updated SKILL.md to add `wasEdit === true` branch (chat line: `reviewer-comments updated in place on PR #<prNumber>`).
- Task 5.0: Migrated 4.6b stale "final-line == verdict" assertions in ac3-grammar-drift-impossibility.test.ts, post-reviewer-comments.test.ts, and compose-reviewer-summary.test.ts to check footer marker as last line.
- Task 5.1-5.2: Rewrote gh-execa-stub.ts with `apiRoutes` discriminating by URL+method. Added two-run scenario, wrong-ref non-match, null-body skip tests to post-reviewer-comments.test.ts.
- Task 6: Extended ac5-4-6b smoke harness with second postReviewerComments invocation; asserted PATCH on rerun and POST not called.
- Task 7: `pnpm build` clean, `pnpm vitest --run` 938 pass / 0 fail. Dist committed in same commit.

### File List

- `plugins/crew/mcp-server/src/tools/run-reviewer-session.ts` (Task 1: `standardsVersion` field + projection)
- `plugins/crew/mcp-server/src/lib/read-reviewer-result-file.ts` (Task 1.2: backward-compat backfill)
- `plugins/crew/mcp-server/src/lib/compose-reviewer-summary.ts` (Task 2: version block + footer marker)
- `plugins/crew/mcp-server/src/lib/__tests__/compose-reviewer-summary.test.ts` (Task 2.4: extended tests)
- `plugins/crew/mcp-server/src/tools/post-reviewer-comments.ts` (Task 3: GET/PATCH/escapeRegex/seam)
- `plugins/crew/mcp-server/src/tools/__tests__/post-reviewer-comments.test.ts` (Task 5: migrated + new tests)
- `plugins/crew/mcp-server/src/tools/__tests__/ac3-grammar-drift-impossibility.test.ts` (Task 5.0: migrated)
- `plugins/crew/mcp-server/src/tools/__tests__/process-reviewer-transcript.test.ts` (Task 1.3: fixture)
- `plugins/crew/mcp-server/src/tools/__tests__/inner-cycle.integration.test.ts` (Task 1.3: fixture)
- `plugins/crew/mcp-server/src/__tests__/test-helpers/gh-execa-stub.ts` (Task 5.2: apiRoutes routing)
- `plugins/crew/mcp-server/src/__tests__/operator-smoke-helpers/ac5-4-6b-post-reviewer-comments.smoke.test.ts` (Task 6: smoke extension)
- `plugins/crew/skills/start/SKILL.md` (Task 4: wasEdit chat line)
- `plugins/crew/mcp-server/dist/` (Task 7: rebuilt dist)
