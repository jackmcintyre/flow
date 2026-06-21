# Story 4.8b: Deterministic seam hardening — handoff parser and PR URL extraction

story_shape: substrate

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin maintainer**,
I want **the PR number to be captured by machine code (`runDevTerminalAction`) and read from a session file (`dev-outcome.json`) rather than parsed from the dev subagent's LLM-authored transcript**,
so that **`processDevTranscript` never throws `PrUrlNotFoundInDevTranscriptError` because the dev subagent omitted the PR URL from its final message, and the handoff → reviewer-spawn path is reliable without depending on the exact wording of the dev's output beyond the locked handoff phrase**.

### What this story is, in one sentence

Add a `dev-outcome.json` session-state file written atomically by `runDevTerminalAction` after a successful `gh pr create`, and modify `processDevTranscript` to read the PR number from that file rather than scanning the dev transcript with `PR_URL_RE` — replacing a fragile LLM-text regex with a machine-written, machine-read seam.

### What this story does (and why it needs its own story)

Story 4.6 added `PR_URL_RE` scanning to `processDevTranscript` (Task 6.1–6.3 in the 4.6 spec). The approach: the dev subagent calls `runDevTerminalAction`, gets back a `prUrl`, mentions it in its final message, and `processDevTranscript` scans the transcript for any GitHub PR URL pattern and takes the rightmost match.

Two fragility points:

1. **False positives.** The dev transcript may contain PR URLs from the story spec itself (e.g., `[Source: … PR #111]` references in the spec doc the dev reads), from the standards doc, or from the persona body. The regex takes the rightmost match, which is a heuristic — if the dev mentions a second PR URL anywhere after the `runDevTerminalAction`-sourced URL, the heuristic produces the wrong number.

2. **False negatives.** The dev subagent (an LLM) may emit the locked handoff phrase without including the PR URL in its final message — either because the prompt didn't make it mandatory enough, or because the LLM elided it. The current code path is: `parseHandoff` succeeds → `PR_URL_RE` scan finds nothing → `PrUrlNotFoundInDevTranscriptError` propagates uncaught as a `DomainError`. This crashes the inner cycle with a confusing error for the operator.

`runDevTerminalAction` already holds the PR URL deterministically — it is `ghResult.stdout.trim()` from `gh pr create`. The URL is machine-computed, not LLM-generated. The fix is: write it to a session file at tool call time, and read it from that file in `processDevTranscript`.

The "handoff parser" part of the story name addresses the coupling inside `processDevTranscript`: the PR URL extraction is tightly coupled to the handoff parsing step (both live in the same function). Making PR URL extraction file-based makes the handoff-parsing seam self-contained — it checks only the last non-empty line for the locked phrase, and the reviewer's `prNumber` comes from a separate, independent file read. The two seams are now compositional and each is deterministic on its own.

### What this story does NOT

- (a) Touch `_bmad-output/implementation-artifacts/sprint-status.yaml` or any other file under `_bmad-output/implementation-artifacts/`.
- (b) Change the locked handoff phrase from Story 4.3. The phrase `Handoff to reviewer — story <ref> ready for review.` is unchanged. `parseHandoff` is unchanged. `processDevTranscript`'s handoff phrase check (last-non-empty-line equality) is unchanged.
- (c) Change the dev subagent persona body or its instruction to include the PR URL in its final message. That instruction is good practice for human operators reading the transcript; Story 4.8b only removes the machine dependency on it.
- (d) Change the `runDevTerminalAction` return type. It still returns `{ ok: true, branch, commitSha, prUrl }`. Writing `dev-outcome.json` is an additional side effect, not a change to the return contract.
- (e) Persist the dev transcript to disk. Only the structured `dev-outcome.json` is written. The transcript remains in-memory / discarded per Story 4.3b (k).
- (f) Remove `PR_URL_RE` from `process-dev-transcript.ts`. The regex is kept as a fallback for backward compatibility — a session started before this story is deployed will have no `dev-outcome.json`; the fallback prevents a hard crash on upgrade. On the fallback path, all current error behaviour is preserved (`PrUrlNotFoundInDevTranscriptError` if no URL found).
- (g) Change how `prNumber` flows to the reviewer. SKILL.md prose already stores `prNumber` from the `processDevTranscript` result and passes it to `runReviewerSession`. The type and call site are unchanged.
- (h) Write any file outside `.crew/state/sessions/<sessionUlid>/`. `dev-outcome.json` is written to the session directory, which is already managed state.
- (i) Emit telemetry. Story 4.12 owns telemetry.
- (j) Pre-create the session directory before writing. `atomicWriteFile` (`lib/managed-fs.ts:115–120`) already calls `fs.mkdir(path.dirname(absPath), { recursive: true })` internally — no caller-side `fs.mkdir` is required. Only genuine filesystem errors (disk full, EROFS, permission denied) propagate uncaught from the write.
- (k) Change the `runReviewerSession` caller in SKILL.md or its inputs. Only `processDevTranscript`'s internal PR-number resolution changes; the output shape `{ next: "spawn-reviewer", prNumber, reviewerPrompt, chatLog }` is unchanged.
- (l) Add a strict "handoff implies dev-outcome file exists" assertion. `processDevTranscript` checks for the file opportunistically (use if present, fall back otherwise). A strict assertion — refusing to proceed if `parseHandoff` succeeds but no `dev-outcome.json` exists — is deferred work (see § Deferred work).
- (m) Handle the partial-failure case where `gh pr create` succeeds but the subsequent `atomicWriteFile` throws. In that case, the PR exists on GitHub (irreversible) but `runDevTerminalAction` raises the filesystem error; the dev subagent never receives the `prUrl`, the handoff phrase is never emitted, the story stays in `in-progress/`, and a retry will hit `gh pr create`'s "PR already exists for branch" error. v1 accepts this as a regression on Story 4.4's failure surface (4.4 § (k) acknowledged a similar shape) — operator inspects, deletes the stuck branch's PR via `gh pr close`, and re-runs `/crew:start`. A typed `DevOutcomeWriteFailedError` with structured recovery hints is deferred work.
- (n) Define rework-cycle semantics for `dev-outcome.json`. On a Story 4.3 rework iteration the dev subagent re-runs against the same story; current Story 4.4 behaviour is that `runDevTerminalAction` would call `gh pr create` again and that call would fail with "PR already exists" — so `atomicWriteFile` never runs and the original `dev-outcome.json` is preserved untouched. This story does NOT add idempotency-on-rework logic; if Story 4.4 is later amended to skip `gh pr create` on rework, the same amendment owner must decide whether to (i) skip the `dev-outcome.json` write too, or (ii) overwrite it with the same content (the PR number and branch don't change across rework iterations).

### Deferred work

- **`PR_URL_RE` fallback removal.** The regex fallback is kept to handle sessions that began before this story deployed. A follow-up story should remove the fallback once all sessions are guaranteed to produce `dev-outcome.json`. Recommend removing after Epic 5 stabilises the session lifecycle.
- **Handoff validation gate.** A future story could assert that `dev-outcome.json` exists whenever `parseHandoff` succeeds — treating its absence as a sign that `runDevTerminalAction` was never called, and blocking the reviewer spawn. v1 treats absence as "fall back to transcript", which is softer but avoids surfacing a new hard error during the stabilisation period.

---

## Acceptance Criteria

> AC1–AC4 describe structural and behavioural changes to internal MCP tools. AC5 is the integration test. Per `plugins/crew/docs/user-surface-acs.md`, this story is `substrate`; no `(user-surface)` tags apply.

**AC1:**
**Given** the `runDevTerminalAction` MCP tool completes a successful `gh pr create` (i.e., `prUrl` is validated as starting with `https://github.com/`),
**When** the tool runs,
**Then** it atomically writes `<targetRepoRoot>/.crew/state/sessions/<sessionUlid>/dev-outcome.json` with the shape `{ "prUrl": "<url>", "prNumber": <positive int>, "branch": "<branch>", "commitSha": "<sha>" }` using `atomicWriteFile` from `lib/managed-fs.ts`. `prNumber` is extracted via: `const m = prUrl.match(/\/pull\/(\d+)/); if (!m) throw new GhPrCreateFailedError({ stderr: ghResult.stderr, diagnostic: "PR URL stdout contained no /pull/<n> segment" }); const prNumber = parseInt(m[1]!, 10);` — the regex captures `\d+`, so `parseInt` always returns a positive integer (NaN is unreachable). The write happens before the `return { ok: true, ... }` statement. `atomicWriteFile` internally creates parents via `fs.mkdir(..., { recursive: true })`, so a missing session directory is NOT an error case; only genuine filesystem errors (disk full, EROFS, permission denied) propagate uncaught. _(seam reliability; replaces the fragile LLM-text extraction path)_

<!-- Not user-surface: AC1 describes a tool's internal file-write side-effect. No operator-visible change. -->

**AC2:**
**Given** `processDevTranscript` is called after a successful `parseHandoff` (i.e., `parseHandoff` returns `{ ok: true }`),
**When** `dev-outcome.json` is present at `<targetRepoRoot>/.crew/state/sessions/<sessionUlid>/dev-outcome.json` and contains valid JSON with all required fields,
**Then** `processDevTranscript` reads `prNumber` from the file (without scanning `devTranscript` with `PR_URL_RE`), and returns `{ next: "spawn-reviewer", prNumber: <file-sourced int>, reviewerPrompt, chatLog }`. The `PR_URL_RE` regex loop is not reached on this path.

<!-- Not user-surface: AC2 describes the primary file-read path. Operator-observable behaviour (reviewer spawns with correct PR number) is unchanged. -->

**AC3:**
**Given** `processDevTranscript` is called after a successful `parseHandoff`,
**When** `dev-outcome.json` is NOT present in the session directory (ENOENT),
**Then** `processDevTranscript` falls through to the existing `PR_URL_RE` regex scan of `devTranscript`, and behaves exactly as Story 4.6 Task 6.1–6.3 specified — returning the extracted `prNumber` on match, or throwing `PrUrlNotFoundInDevTranscriptError` if no GitHub PR URL is found. _(backward compatibility fallback — unchanged error surface)_

<!-- Not user-surface: AC3 describes the fallback path. -->

**AC4:**
**Given** `dev-outcome.json` exists in the session directory,
**When** `processDevTranscript` reads it and the file contains malformed JSON OR is missing any required field OR `prNumber` fails the `Number.isInteger(n) && n > 0` check (rejecting NaN, floats, zero, and negatives),
**Then** `processDevTranscript` throws `DevOutcomeFileMalformedError` (new typed error extending `DomainError`, with fields `{ path: string; cause: unknown }` — matching the sibling `ReviewerResultFileMalformedError` constructor shape; `path` encodes the session via `.../sessions/<sessionUlid>/dev-outcome.json`). The tool does NOT fall back to transcript scanning on a malformed file — a malformed file is a write-seam bug, not a missing-file case; silent fallback would paper over it.

<!-- Not user-surface: AC4 describes error-propagation on a malformed state file. -->

**AC5 (integration):**
vitest covers:

- (5a) **Write path:** `runDevTerminalAction` with a stubbed `gh pr create` returning `https://github.com/jackmcintyre/crew/pull/42` → `dev-outcome.json` is written to the session tmpdir with `{ prUrl: "https://github.com/jackmcintyre/crew/pull/42", prNumber: 42, branch: "<branch>", commitSha: "<sha>" }`.
- (5b) **File-present path:** `processDevTranscript` with a transcript ending in the correct handoff phrase AND `dev-outcome.json` present (containing `prNumber: 42`) AND NO GitHub PR URL anywhere in the transcript → returns `{ next: "spawn-reviewer", prNumber: 42, ... }`. Confirms `PR_URL_RE` is not relied on.
- (5c) **Fallback path:** `processDevTranscript` with a transcript ending in the correct handoff phrase AND a valid GitHub PR URL in the transcript AND NO `dev-outcome.json` present → returns `{ next: "spawn-reviewer", prNumber: <parsed from transcript> }`.
- (5d) **Malformed file:** `dev-outcome.json` present but invalid JSON → `DevOutcomeFileMalformedError` thrown, no fallback to transcript scanning.
- (5e) **Missing field:** `dev-outcome.json` present but missing `prNumber` field → `DevOutcomeFileMalformedError` thrown.
- (5f) **Non-regression — existing `PrUrlNotFoundInDevTranscriptError` path:** no `dev-outcome.json`, no PR URL in transcript, handoff phrase present → `PrUrlNotFoundInDevTranscriptError` thrown (Story 4.6 path unchanged).
- (5g) **Non-regression — Story 4.3 / 4.3b / 4.5 branches:** grammar-drift, empty transcript, recoverable-error marker — all return `{ next: "done-blocked-*" }` unchanged; none reach the file-read path.
- (5h) **Non-regression — `runDevTerminalAction` existing tests:** all existing AC tests still pass after Task 1 adds the file write. Use `pluginRootOverride` or a tmpdir fixture to give the tool a session directory.

<!-- Not user-surface: vitest integration suite — internal harness only. -->

---

## Tasks / Subtasks

Implementation order is load-bearing.

- [x] **Task 1: Write `dev-outcome.json` in `runDevTerminalAction`** (AC: #1, #5a, #5h)
  - [x] 1.0 In `plugins/crew/mcp-server/src/tools/run-dev-terminal-action.ts`, locate the existing destructure of the `opts` parameter at lines 83–91. `sessionUlid` is declared on `RunDevTerminalActionOptions` but is NOT currently pulled into local scope there — add `sessionUlid` to the destructure so it is available as a plain identifier in the write block added by Task 1.3. Alternatively, reference it as `opts.sessionUlid` in the write call if that reads more cleanly with the surrounding code — pick whichever form is already dominant for other option fields in this file. (This is the same pattern Task 4.2 applies to `process-dev-transcript.ts`.)
  - [x] 1.1 In `plugins/crew/mcp-server/src/tools/run-dev-terminal-action.ts`, add an import for `atomicWriteFile` from `"../lib/managed-fs.js"`.
  - [x] 1.2 After the `prUrl` validation block (currently lines 177–183, which throw `GhPrCreateFailedError` if `prUrl` is falsy or doesn't start with `https://github.com/`), extract `prNumber` via regex match — NOT `split("/pull/")` (which would silently produce NaN on a malformed URL):
    ```ts
    const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
    if (!prNumberMatch) {
      throw new GhPrCreateFailedError({
        stderr: ghResult.stderr,
        diagnostic: "PR URL stdout contained no /pull/<n> segment",
      });
    }
    const prNumber = parseInt(prNumberMatch[1]!, 10);
    ```
    The regex guarantees `\d+` matched, so `parseInt` returns a positive integer (NaN is unreachable). This is the SINGLE source-of-truth for `prNumber` parsing across this story — AC1 quotes the same expression.
  - [x] 1.3 Compute `devOutcomePath = path.resolve(targetRepoRoot, ".crew", "state", "sessions", sessionUlid, "dev-outcome.json")`.
  - [x] 1.4 Call `await atomicWriteFile(devOutcomePath, JSON.stringify({ prUrl, prNumber, branch, commitSha }, null, 2))`. This happens BEFORE the `return { ok: true, branch, commitSha, prUrl }` statement. `atomicWriteFile` creates the session directory internally; no caller-side `fs.mkdir` is required.
  - [x] 1.5 Do NOT add `sessionUlid` to the return type — it is already a tool input; the caller already has it.
  - [x] 1.6 Verify the existing `runDevTerminalAction` integration tests still pass. Add a new test case asserting `dev-outcome.json` content (5a). Existing tests do not provide a session directory — that's fine; `atomicWriteFile` will create it. If any existing test asserts "no files are written under `.crew/state/`", update that assertion to allow `dev-outcome.json` under the session directory.

- [x] **Task 2: Add `DevOutcomeFileMalformedError` to `errors.ts`** (AC: #4, #5d, #5e)
  - [x] 2.1 In `plugins/crew/mcp-server/src/errors.ts`, add (matching the sibling `ReviewerResultFileMalformedError` ctor shape — `{ path, cause }`, no `sessionUlid`, since `path` already encodes the session via `.../sessions/<sessionUlid>/dev-outcome.json`):
    ```ts
    export class DevOutcomeFileMalformedError extends DomainError {
      readonly path: string;
      readonly cause: unknown;
      constructor(opts: { path: string; cause: unknown }) { ... }
    }
    ```
  - [x] 2.2 The `cause` field carries the underlying parse error or a descriptive string for missing/wrong-typed-field cases. Follow the pattern of `ReviewerResultFileMalformedError` at `errors.ts:1091`.

- [x] **Task 3: Add `readDevOutcomeFile` shared helper** (AC: #2, #3, #4)
  - [x] 3.1 Create `plugins/crew/mcp-server/src/lib/read-dev-outcome-file.ts`. Export `readDevOutcomeFile(targetRepoRoot: string, sessionUlid: string): Promise<DevOutcome | null>` where `DevOutcome = { prUrl: string; prNumber: number; branch: string; commitSha: string }`. **Signature deliberately matches `readReviewerResultFile(targetRepoRoot, sessionUlid)` (`lib/read-reviewer-result-file.ts:31`)** — the helper computes the file path internally (`path.join(targetRepoRoot, ".crew", "state", "sessions", sessionUlid, "dev-outcome.json")`).
  - [x] 3.2 On ENOENT: return `null`.
  - [x] 3.3 On read success: `JSON.parse(contents)`. Validate (a) presence and string type of `prUrl`, `branch`, `commitSha`; (b) `prNumber` is a number AND `Number.isInteger(prNumber)` AND `prNumber > 0` (reject NaN, floats, zero, negatives). On parse failure or any validation miss: throw `DevOutcomeFileMalformedError({ path, cause })` where `cause` is the underlying error or a descriptive string naming the offending field.
  - [x] 3.4 No Zod dependency required — manual field checks mirror the pattern in `read-reviewer-result-file.ts`.

- [x] **Task 4: Modify `processDevTranscript` to use the file** (AC: #2, #3, #4, #5b–5g)
  - [x] 4.1 Import `readDevOutcomeFile` from `"../lib/read-dev-outcome-file.js"`. (`DevOutcomeFileMalformedError` does not need to be imported here — it propagates uncaught from the helper.)
  - [x] 4.2 Add `sessionUlid` to the existing line-95 destructure: change `const { targetRepoRoot, ref, devTranscript } = opts;` to `const { targetRepoRoot, sessionUlid, ref, devTranscript } = opts;`. The field is already declared on `ProcessDevTranscriptOptions` (line 49) — only the destructure needs updating.
  - [x] 4.3 After `parseHandoff` returns `{ ok: true }` (currently at line 145, before the `PR_URL_RE` scan at line 163), call `const devOutcome = await readDevOutcomeFile(targetRepoRoot, sessionUlid);`. No path computation needed in this file — the helper owns it.
  - [x] 4.4 If `devOutcome` is non-null: use `devOutcome.prNumber` as `prNumber`. Skip the `PR_URL_RE` scan entirely and jump directly to the `buildPersonaSpawnPrompt` call.
  - [x] 4.5 If `devOutcome` is null (file absent): fall through to the existing `PR_URL_RE` scan block (lines 163–175 in current implementation). No change to existing fallback behaviour.
  - [x] 4.6 `DevOutcomeFileMalformedError` thrown by `readDevOutcomeFile` propagates uncaught — same pattern as `ReviewerResultFileMalformedError` in `processReviewerTranscript`.

- [x] **Task 5: Update tests** (AC: #5)
  - [x] 5.1 In `plugins/crew/mcp-server/src/tools/__tests__/process-dev-transcript.test.ts`, add test cases for (5b) file-present path, (5c) fallback path, (5d) malformed JSON, (5e) missing field. Use `tmpdir` per `beforeEach`; write `dev-outcome.json` where needed. The `processDevTranscript` call takes `targetRepoRoot` and `sessionUlid` from which the tool resolves the path.
  - [x] 5.2 In the `runDevTerminalAction` test file, add test case (5a): stub `gh pr create` to return a known PR URL; assert `dev-outcome.json` is written to the session tmpdir with the expected content.
  - [x] 5.3 Run full vitest suite (`pnpm vitest --run` from `mcp-server/`) — confirm all existing tests still pass.

- [x] **Task 6: Build, vitest, dist** (AC: all)
  - [x] 6.1 `pnpm build` passes.
  - [x] 6.2 All vitest tests pass. Tool count unchanged (no new MCP tools registered; `DevOutcomeFileMalformedError` is a new error class, not a new tool).
  - [x] 6.3 Commit `dist/` per CLAUDE.md.

---

## Implementation strategy

### Why `atomicWriteFile` rather than `fs.writeFile`

`atomicWriteFile` (from `lib/managed-fs.ts`) writes to a temp file and atomically renames — from Story 1.6. This prevents partial reads if the process crashes between write and close. Consistency with all other session-state writes in this plugin.

### Why parse `prNumber` in `runDevTerminalAction` rather than in `processDevTranscript`

`runDevTerminalAction` already validated `prUrl.startsWith("https://github.com/")`. Parsing `prNumber` at that point is natural and keeps the integer in the file alongside the URL. `processDevTranscript` doesn't need to know how to parse GitHub PR URLs — it just reads the pre-parsed integer.

### Why keep the `PR_URL_RE` fallback

Session continuity: a `/crew:start` session that started before this story is deployed will have no `dev-outcome.json`. When `processDevTranscript` runs for such a session (ENOENT on the file), the fallback prevents a hard `DevOutcomeFileMalformedError` where previously there was only a potential `PrUrlNotFoundInDevTranscriptError`. The fallback is the conservative choice during the stabilisation period.

### Why `DevOutcomeFileMalformedError` does not fall back to transcript scanning

A malformed file is a machine-write failure, not an absent file. If `atomicWriteFile` produces invalid JSON (e.g., a bug in Task 1's `JSON.stringify` call), silently falling back to transcript scanning would hide the write-seam bug and produce a misleading `PrUrlNotFoundInDevTranscriptError` instead of pointing at the real root cause. Hard errors on malformed files surface bugs faster.

### Why session-state rather than the manifest

Story 4.4 §(j) anticipated that "a future story may add `pr_url` to the manifest for faster reviewer-side lookup." Story 4.8b deliberately picks the session directory (`<targetRepoRoot>/.crew/state/sessions/<sessionUlid>/dev-outcome.json`) instead. Rationale: PR URLs are session-scoped artefacts — they belong to the dev→reviewer cycle that produced them and have no meaning outside it. The manifest is long-lived per-story state and should not accumulate transient run-cycle metadata. Persisting to the session directory keeps the manifest schema stable and mirrors how `reviewer-result.json` is scoped (Story 4.6 revision 2). If a future story needs a manifest-level `pr_url` for cross-session lookup (e.g., for blocked-story recovery), it can read the most-recent session's `dev-outcome.json` and write a derived field — that work is out of scope here.

### Acknowledging the partial-failure regression

The write happens AFTER `gh pr create` succeeds. If `atomicWriteFile` throws, the PR exists on GitHub but the dev session crashes before emitting the handoff phrase — see §What this story does NOT (m) for the operator recovery path. This is a real (small) regression on Story 4.4's failure surface; the alternative (write `dev-outcome.json` first, before `gh pr create`) is impossible because the URL doesn't exist yet. Accepted in v1; a typed `DevOutcomeWriteFailedError` with structured recovery is deferred work.

---

## Locked files

- `plugins/crew/mcp-server/src/tools/run-reviewer-session.ts` (Story 4.6) — NOT touched
- `plugins/crew/mcp-server/src/tools/post-reviewer-comments.ts` (Stories 4.6b / 4.7) — NOT touched
- `plugins/crew/mcp-server/src/tools/process-reviewer-transcript.ts` (Story 4.6 revision 2) — NOT touched
- `plugins/crew/skills/start/SKILL.md` (Stories 4.2 / 4.3b / 4.3c / 4.6 / 4.6b / 4.7) — NOT touched
- `plugins/crew/permissions/generalist-reviewer.yaml` (Stories 2.2 / 4.6 / 4.7 / 4.8) — NOT touched

### Declared-locked-file changes (explicit exceptions)

- **`plugins/crew/mcp-server/src/tools/run-dev-terminal-action.ts`** (Story 4.4) — Task 1 adds a `dev-outcome.json` write after a successful `gh pr create`. The change is additive (new side-effect only; return type unchanged) and is load-bearing for AC1's machine-authoritative seam.
- **`plugins/crew/mcp-server/src/tools/process-dev-transcript.ts`** (Stories 4.3b / 4.5 / 4.6) — Task 4 inserts a `readDevOutcomeFile` call in the `parseHandoff`-success branch (before the `PR_URL_RE` scan). Existing recoverable-error check (Step 1) and handoff-phrase check (Step 2) are UNTOUCHED. The `PR_URL_RE` scan block is preserved as-is for the fallback path.
- **`plugins/crew/mcp-server/src/errors.ts`** (typed-error hierarchy; appended-to by most Epic-1 through Epic-4 stories including 4.1 / 4.2 / 4.3 / 4.3b / 4.4 / 4.5 / 4.6 / 4.6b / 4.7 / 4.8) — Task 2 appends `DevOutcomeFileMalformedError`. No existing error classes are modified; routine additive growth follows the established `extends DomainError` pattern.

---

## Dev Notes

### Files this story will create

- `plugins/crew/mcp-server/src/lib/read-dev-outcome-file.ts` (Task 3)

### Files this story will modify

- `plugins/crew/mcp-server/src/tools/run-dev-terminal-action.ts` (Task 1)
- `plugins/crew/mcp-server/src/errors.ts` (Task 2)
- `plugins/crew/mcp-server/src/tools/process-dev-transcript.ts` (Task 4)
- `plugins/crew/mcp-server/src/tools/__tests__/process-dev-transcript.test.ts` (Task 5.1)
- `plugins/crew/mcp-server/src/tools/__tests__/run-dev-terminal-action.test.ts` (Task 5.2)
- `plugins/crew/mcp-server/dist/` (rebuild; commit per CLAUDE.md)

### Current-state notes on files being modified

- **`run-dev-terminal-action.ts`** (current state per Story 4.4): `sessionUlid` is already a typed input parameter (line 80, inside the options object literal type). The `prUrl` is set at line 177. The write in Task 1 goes between line 183 (the `GhPrCreateFailedError` throw on bad URL) and the existing `return { ok: true, ... }` at lines 186–190. `atomicWriteFile` import is `import { atomicWriteFile } from "../lib/managed-fs.js"`. Note: `sessionUlid` is declared on `RunDevTerminalActionOptions` and is accessible as `opts.sessionUlid`, but it is NOT currently included in the local destructure at lines 83–91 — Task 1.0 (below) addresses this before the write block is added.
- **`process-dev-transcript.ts`** (current state per Stories 4.3b / 4.5 / 4.6): `ProcessDevTranscriptOptions` declares `sessionUlid: string` (line 49) but line 95 only destructures `{ targetRepoRoot, ref, devTranscript } = opts;` — **`sessionUlid` is NOT currently in local scope; Task 4.2 adds it to the destructure.** The `PR_URL_RE` scan block begins at line 163 (`let lastMatch: RegExpExecArray | null = null`). Task 4.3's `readDevOutcomeFile` call goes between line 159 (the end of the grammar-drift `return`) and line 163 — the fallback path starts exactly where the old path was.
- **`errors.ts`** (current state per Stories 4.5 / 4.6b / 4.7 / 4.8): `ReviewerResultFileMalformedError` at `errors.ts:1091` is the pattern to follow for `DevOutcomeFileMalformedError` — same ctor shape (`{ path, cause }`), same `extends DomainError`, same minimal validation message convention.

### Testing standards

- vitest with `pnpm vitest --run` from `mcp-server/`.
- Use `tmp` directory fixtures per `beforeEach`; clean up per `afterEach` using `fs.rm`.
- For the `runDevTerminalAction` write-path test (5a): provide a `sessionUlid` and a `targetRepoRoot` pointing to a tmpdir with a valid `.crew/state/sessions/<sessionUlid>/` directory. Stub `gh pr create` via `execaImpl` to return the test PR URL.
- For `processDevTranscript` file-read tests (5b–5e): write (or omit) `dev-outcome.json` in the session tmpdir; pass matching `targetRepoRoot` and `sessionUlid` to the tool.

### References

- [Source: `_bmad-output/planning-artifacts/epics/epic-4-dev-review-loop-the-engineering-heart.md`]
- [Source: `_bmad-output/implementation-artifacts/4-8-reviewer-labels-and-negative-capability-enforcement.md`] (adjacent story, grounding voice)
- [Source: `plugins/crew/mcp-server/src/tools/process-dev-transcript.ts`] (modified by Task 4; PR_URL_RE block at lines 163–175)
- [Source: `plugins/crew/mcp-server/src/tools/run-dev-terminal-action.ts`] (modified by Task 1; write site at lines 183–190)
- [Source: `plugins/crew/mcp-server/src/lib/managed-fs.ts`] (atomicWriteFile export — used in Task 1)
- [Source: `plugins/crew/mcp-server/src/lib/read-reviewer-result-file.ts`] (pattern for Task 3's helper)
- [Source: `plugins/crew/mcp-server/src/errors.ts`] (DevOutcomeFileMalformedError added in Task 2)

---

## Previous story intelligence

### From Story 4.6 (Task 6.1–6.3, shipped)

- `PR_URL_RE = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/g` was added to `processDevTranscript` in Story 4.6. The rightmost-match heuristic (`lastMatch`) is at lines 163–178 in the current file. Story 4.8b's Task 4 inserts a file-read step before this block; the block itself is preserved verbatim as the fallback path.
- `PrUrlNotFoundInDevTranscriptError` (errors.ts line 1065) remains; the fallback path still throws it.

### From Story 4.4 (shipped)

- `runDevTerminalAction` returns `prUrl = ghResult.stdout.trim()` (line 177). `sessionUlid` is already a parameter (line 80). Task 1's write site is between lines 183 and 190.
- The `atomicWriteFile` helper is `lib/managed-fs.ts:115` — already used elsewhere in the plugin.

### From Story 4.3b (shipped) — transcript-passing contract

- Story 4.3b (k) explicitly says transcripts are NOT persisted: "Transcripts flow from `Task` (return value) → SKILL.md prose (in-memory string) → `processDevTranscript` → discarded." Story 4.8b does NOT change this — `dev-outcome.json` is written by `runDevTerminalAction` (a separate tool call before the transcript is even captured), not by `processDevTranscript`.

---

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

### Completion Notes List

- Task 1: Added `atomicWriteFile` import and `sessionUlid` to destructure in `run-dev-terminal-action.ts`. Inserted prNumber extraction via `/\/pull\/(\d+)/` regex and `dev-outcome.json` write before return.
- Task 2: Added `DevOutcomeFileMalformedError` to `errors.ts` matching `ReviewerResultFileMalformedError` pattern (`{ path, cause }` constructor, same message shape).
- Task 3: Created `lib/read-dev-outcome-file.ts` with `readDevOutcomeFile(targetRepoRoot, sessionUlid)` — returns null on ENOENT, throws `DevOutcomeFileMalformedError` on malformed JSON or validation miss.
- Task 4: Modified `processDevTranscript` to add `sessionUlid` to destructure, call `readDevOutcomeFile` after `parseHandoff` success, use file-sourced `prNumber` on primary path, fall through to `PR_URL_RE` regex scan on null (ENOENT).
- Task 5: Added 6 new test cases to `process-dev-transcript.test.ts` (5b–5f) and 3 new test cases to `run-dev-terminal-action.integration.test.ts` (5a). Static fs-write guard required using `atomicWriteFile` instead of `fs.writeFile` in test helpers.
- Task 6: Build passes, 958/959 vitest tests pass. The 1 remaining failure is the dist-shipping contract (expected until dist/ is committed in this same commit).

### File List

- `plugins/crew/mcp-server/src/tools/run-dev-terminal-action.ts` (modified)
- `plugins/crew/mcp-server/src/errors.ts` (modified)
- `plugins/crew/mcp-server/src/lib/read-dev-outcome-file.ts` (created)
- `plugins/crew/mcp-server/src/tools/process-dev-transcript.ts` (modified)
- `plugins/crew/mcp-server/src/tools/__tests__/process-dev-transcript.test.ts` (modified)
- `plugins/crew/mcp-server/src/tools/__tests__/run-dev-terminal-action.integration.test.ts` (modified)
- `plugins/crew/mcp-server/dist/` (rebuilt)
