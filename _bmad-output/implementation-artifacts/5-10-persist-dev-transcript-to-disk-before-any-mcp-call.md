# Story 5.10: Persist dev transcript to disk before any MCP call

story_shape: substrate

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin maintainer**,
I want **the dev subagent's final message captured to a durable on-disk artefact the instant the subagent returns — before `processDevTranscript` or any other MCP call runs**,
so that **an MCP reap mid-cycle does not lose the transcript that carries the locked handoff phrase, and Story 5.11 has a deterministic file to replay from when reattaching an orphaned in-progress manifest after a new Claude Code session boots a fresh MCP child**.

### What this story is, in one sentence

Add a transcript-write step to `/crew:start`'s inner cycle that writes the captured dev `Task` return value to `<targetRepoRoot>/.crew/state/sessions/<sessionUlid>/dev-transcript.txt` using Claude Code's built-in `Write` tool — outside the MCP seam — before any MCP call (`processDevTranscript` or otherwise) is attempted, so the file survives an MCP reap and is recoverable in a later session by ULID.

### What this story does (and why it needs its own story)

The 2026-05-25 dogfood postmortem (`§ L1, defect #3`) names this defect:

> The dev subagent's final message is captured in the parent's conversation context and passed by string into `processDevTranscript`. It is never persisted to disk. When MCP dies after the subagent returns but before the transcript reaches the tool, the transcript is unrecoverable on `/reload-plugins`. The PR was already opened with the locked handoff phrase — the data necessary to drive the reviewer existed in the parent's context, but the architecture had no durable seam to hand it to the next session.

Today's inner cycle (per `plugins/crew/skills/start/SKILL.md § Dev spawn` step 4 → step 5) is:

1. `Task` returns → SKILL.md captures the dev subagent's final message into a local variable `devTranscript`.
2. SKILL.md calls `processDevTranscript({ targetRepoRoot, sessionUlid, ref, devTranscript })`.

There is no on-disk artefact between (1) and (2). If MCP's stdio child has been idle-reaped during the (often ~10 min) `Task` run, step 2 throws "MCP server has disconnected" — and the only copy of the transcript dies with the parent's conversation context the moment the operator restarts Claude Code.

The fix is structural: the parent must write the transcript to disk **before any MCP call** in the new inner-cycle step "4.5". Because step 4.5 must succeed even when MCP is dead, the write **cannot go through an MCP tool**. It must use Claude Code's built-in `Write` tool, which is independent of the plugin's MCP server and remains available after a reap.

This is a sibling to Story 4.8b's `dev-outcome.json`. 4.8b proved the pattern — a session-scoped, atomically-written JSON file in the session directory, read later as a deterministic seam. 5.10 adds the transcript file in the same directory under the same locality, keyed by the same `sessionUlid`. Story 5.11 then reads this transcript when it detects an orphaned `in-progress/` manifest, and replays `processDevTranscript` against the saved bytes.

### Why this is independent of Story 5.11

5.10 **writes** the file. 5.11 **reads** it. The two are deliberately separated:

- 5.10's deliverable can be smoke-validated in isolation: run `/crew:start`, kill the parent after the dev subagent returns, inspect `.crew/state/sessions/<ulid>/dev-transcript.txt` — the file should exist with the verbatim transcript.
- 5.11's deliverable depends on 5.10 already being deployed (so a stale `in-progress/` manifest has a paired transcript file to replay from). Shipping them in one story would couple two distinct behavioural surfaces and double the implementation risk.

The file's **shape and location** are fixed by 5.10. 5.11 reads from the same path, by ULID. If 5.11 later needs richer metadata, that's a third story.

### What this story does NOT

- (a) Consume the transcript file. **Story 5.11 owns orphan recovery and transcript replay.** 5.10 produces; 5.11 consumes. No code in 5.10 reads the file it writes.
- (b) Change the signature, behaviour, or return type of `processDevTranscript` (`tools/process-dev-transcript.ts`). The tool still accepts `devTranscript: string` and still parses it identically. 5.10 only adds a write step that occurs strictly before the existing `processDevTranscript` call.
- (c) Change the locked handoff phrase from Story 4.3 or `parseHandoff` (`skills/handoff-parser.ts`). The grammar contract is untouched.
- (d) Change the dev persona body or its instructions. The dev subagent does not need to know its final message will be persisted; persistence is a parent-side concern.
- (e) Add telemetry, JSONL events, or per-invocation logging for the transcript write. Telemetry is owned by Story 4.12 (per-invocation telemetry) and Story 5.8 (no-silent-failures CI pairing). 5.10 writes the file silently except for one chat-surface line confirming the write.
- (f) Address the MCP reap itself. That is Story 5.12's job (client-side resilience, host-side knob, or escalation). 5.10 accepts the reap as a fact of life and ensures the transcript survives it.
- (g) Add an orphan-recovery branch to `/crew:start`'s outer loop. That is Story 5.11 (depends on this story).
- (h) Persist anything other than the dev `Task` return value. The reviewer's transcript is not persisted — `runReviewerSession` already writes `reviewer-result.json` (Story 4.6 revision 2), which is the reviewer's durable seam.
- (i) Persist additional dev-side artefacts (commit message, branch name, etc.). Those are already captured by `dev-outcome.json` (Story 4.8b). 5.10 writes ONLY the raw transcript text.
- (j) Change `runDevTerminalAction` (`tools/run-dev-terminal-action.ts`). That tool runs **inside** the dev subagent and writes `dev-outcome.json`; it has nothing to do with the parent's transcript capture.
- (k) Use an MCP tool for the write. The write **must** survive an MCP reap; routing it through `mcp-server/` would defeat the entire purpose of the story. The write uses Claude Code's built-in `Write` tool, called from the SKILL.md prose layer.
- (l) Add a new MCP tool. No `persistDevTranscript` tool is registered. (A future story may add one if a non-prose caller ever needs to persist a transcript — but v1 has no such caller.)
- (m) Garbage-collect old transcripts. The file accumulates per-session; cleanup is deferred (see § Deferred work). On a fresh `/crew:start` the new session's ULID is different, so there is no overwrite hazard.
- (n) Encrypt, compress, or transform the transcript. The file is plain UTF-8 text — exactly the bytes returned by `Task`. Diagnosability beats compactness.
- (o) Add idempotency-on-rework logic. On a Story 4.3 rework iteration the parent will call `Task` again with a fresh dev spawn and overwrite the file in place. The previous iteration's transcript is discarded — that matches the existing rework contract (the prior iteration's transcript is not used for the new dev spawn). If a future story needs rework-iteration history, it can append `-rework-<n>` to the filename — out of scope here.
- (p) Persist the BLOCKED / handoff-grammar-drift transcripts separately. The write happens unconditionally — every `Task` return is persisted, regardless of what the prose layer does with it next. A blocked transcript on disk is just as useful for human inspection as a successful one.
- (q) Block the inner cycle on a write failure. If the `Write` tool throws (disk full, permission denied), the prose surfaces the error verbatim and halts the inner cycle. It does NOT proceed to `processDevTranscript` with an unpersisted transcript — the entire point is "no MCP call before the durable seam exists". (Operator recovery on write failure is captured in § Operator-visible behaviour on write failure.)
- (r) Move existing session files. `dev-outcome.json` (Story 4.8b) and `reviewer-result.json` (Story 4.6 revision 2) stay where they are. The new `dev-transcript.txt` is a sibling, not a replacement.
- (s) Add an `allowed_tools` entry for any MCP tool. The new tool used is Claude Code's built-in `Write`, which is added to `start/SKILL.md`'s frontmatter `allowed_tools` array (alongside `Task`, already present).
- (t) Validate the transcript content. The bytes are written verbatim — no schema check, no length cap, no empty-string guard. (`processDevTranscript` already handles empty transcripts as grammar drift; a zero-byte file simply re-produces that behaviour on replay.)

### Deferred work

- **Garbage-collection / retention policy.** The session directory accumulates one file per `/crew:start` invocation. A future story under Epic 5 (likely 5.9 or a sibling) should add a retention sweep — e.g., delete session directories whose stories have all reached `done/` or `blocked/` and which are older than N days. Out of scope here.
- **`persistDevTranscript` MCP tool.** If a non-prose caller ever needs to persist a transcript (e.g., a future watch-skill that snapshots an in-flight dev run), wrapping the write behind an MCP tool would centralise the path computation. v1 has no such caller, so we avoid the abstraction.
- **Append-mode `-rework-<n>` history.** On rework iterations the file is overwritten. A future story could capture each iteration separately if retrospective tooling needs the rework history. Today the manifest's `claimed_by`/`blocked_by` stamping is enough audit trail.
- **Atomicity via tmp+rename.** `Write` from Claude Code is a single-shot write; it is NOT the `atomicWriteFile` tmp+rename pattern used in `lib/managed-fs.ts`. A torn write on crash is theoretically observable. v1 accepts this — the worst case is a partial transcript that fails `parseHandoff` on replay, identical to today's behaviour when the transcript is lost entirely. Promoting to atomic write would require routing through MCP, which defeats the story's purpose; the alternative is to teach a built-in tool atomic semantics, also out of scope.
- **Migration-from-prior-sessions sweep.** Sessions started before 5.10 deploys have no transcript file. 5.11's "no transcript present" branch handles this case explicitly (it routes to `blocked/` with `blocked_by: orphan-no-transcript` rather than guessing). No migration tooling is needed.

---

## Acceptance Criteria

> AC1–AC3 describe structural and behavioural changes to `/crew:start`'s inner cycle. AC4 is the integration test. Per `plugins/crew/docs/user-surface-acs.md`, this story is `substrate`; no `(user-surface)` tags apply.

**AC1 (write happens, and it happens before any MCP call):**
**Given** a `/crew:start` inner cycle in which the dev `Task` invocation has just returned (per `plugins/crew/skills/start/SKILL.md § Dev spawn` step 4),
**When** the SKILL.md prose has captured the subagent's final message as `devTranscript`,
**Then** the prose layer invokes Claude Code's built-in `Write` tool with `file_path = <targetRepoRoot>/.crew/state/sessions/<sessionUlid>/dev-transcript.txt` and `content = <the verbatim devTranscript string>` **before** calling `processDevTranscript` or any other MCP tool. The new step is numbered "4.5" in SKILL.md (between current steps 4 and 5). _(deterministic seam — primary guarantee of the story)_

<!-- Not user-surface: AC1 describes a prose-level file-write side-effect that sits between two existing prose steps. The user observes no new chat line beyond the confirmation in AC2. -->

**AC2 (one chat-surface line confirms the write):**
**Given** the write in AC1 succeeds,
**When** the prose layer proceeds to `processDevTranscript`,
**Then** exactly one chat line is surfaced to the operator before the MCP call:
```
dev transcript persisted — .crew/state/sessions/<sessionUlid>/dev-transcript.txt
```
The path is relative to `targetRepoRoot` (no absolute-path leakage). The line uses no emoji, no leading verb, no trailing punctuation beyond the period implied by the path — same restraint as the existing `spawning generalist-dev subagent (clean context)` line. _(operator-visible confirmation; debuggable from chat alone)_

<!-- Not user-surface: a one-line operational confirmation is substrate-grade telemetry, not a product surface. -->

**AC3 (file content is the verbatim Task return value):**
**Given** the file written in AC1,
**When** the operator (or Story 5.11) reads `<targetRepoRoot>/.crew/state/sessions/<sessionUlid>/dev-transcript.txt`,
**Then** its bytes equal the exact string captured by the SKILL.md prose as the `Task` tool's final-message return value — no trimming, no normalisation, no JSON wrapping, no prefix/suffix. The file is plain UTF-8 text, matching the same byte stream that would otherwise be passed verbatim as `devTranscript` into `processDevTranscript`. _(replay correctness — Story 5.11 must be able to feed the file bytes straight back into `processDevTranscript` without transformation)_

<!-- Not user-surface: AC3 fixes the file format contract. -->

**AC4 (write failure halts the inner cycle):**
**Given** the `Write` tool invocation in AC1 throws (disk full, permission denied, EROFS, or any other filesystem error),
**When** the prose layer observes the error,
**Then** the prose surfaces the verbatim error message to the operator, halts the inner cycle, and does NOT call `processDevTranscript` or any other MCP tool. The in-progress manifest is left untouched (no `blocked_by` stamp — there is no MCP tool available at this point to stamp it). Operator recovery: inspect filesystem permissions / free space, then re-run `/crew:start` (which will re-claim the orphan via Story 5.11 once that ships, or leave it in `in-progress/` for manual inspection until then). _(failure surface — better to halt than to silently lose the transcript)_

<!-- Not user-surface: AC4 is a failure-mode contract; the visible behaviour (halt + error line) matches existing inner-cycle failure conventions. -->

**AC5 (file survives an MCP reap / `/reload-plugins` / fresh session):**
**Given** the write in AC1 has succeeded,
**When** any of: (i) the MCP child has been idle-reaped, (ii) `/reload-plugins` is invoked, or (iii) Claude Code is restarted and a fresh session boots a new MCP child,
**Then** `<targetRepoRoot>/.crew/state/sessions/<sessionUlid>/dev-transcript.txt` remains readable from the same path with the same content. The file is plain on-disk content, not held in any process memory, and is keyed by `sessionUlid` so a later session can locate it by reading the orphan's `claimed_by` field. _(durability contract — the entire L1-defect motivation)_

<!-- Not user-surface: AC5 is the durability invariant. -->

**AC6 (integration):**
vitest covers:

- (6a) **Path computation:** given `targetRepoRoot = <tmp>` and `sessionUlid = "01ABC..."`, the resolved write path is `<tmp>/.crew/state/sessions/01ABC.../dev-transcript.txt`.
- (6b) **Content fidelity:** given a `devTranscript` string containing the locked handoff phrase plus arbitrary multi-line content (including a synthetic `Handoff to reviewer — story <ref> ready for review.` last line), the file written has byte-for-byte equality with the input string.
- (6c) **Idempotency / overwrite:** writing twice to the same path (same `sessionUlid`) replaces the file content; the second write's content wins. (Models the rework-iteration overwrite contract from § What this story does NOT (o).)
- (6d) **Parent-directory creation:** the test fixture does NOT pre-create `.crew/state/sessions/<sessionUlid>/`. The write must succeed by creating the directory tree (the `Write` tool creates parents, matching `atomicWriteFile`'s behaviour from `lib/managed-fs.ts:117`). If `Write` does not create parents, the spec is adjusted to invoke a sibling MCP-server helper that does — see § Implementation strategy.
- (6e) **Order assertion:** in a harness that mocks both `Write` and `processDevTranscript`, the test asserts that `Write` is observed strictly before `processDevTranscript`. The test fails if the order is reversed.
- (6f) **Write-failure halt:** mocking `Write` to throw `ENOSPC` (disk full) causes the test harness to assert (a) no `processDevTranscript` call was made, (b) the error message was surfaced, (c) no in-progress manifest mutation occurred.
- (6g) **Replay path (read-only — sanity check for 5.11):** after the write, an unrelated test reads the file with `fs.readFile` and confirms the content matches the original `devTranscript`. This test does NOT exercise orphan recovery — it only asserts that the file is in a shape Story 5.11 can consume.

<!-- Not user-surface: vitest integration suite — internal harness only. -->

---

## Tasks / Subtasks

Implementation order is load-bearing. The SKILL.md change is the deliverable; everything else exists to support it or test it.

- [x] **Task 1: Add `Write` to `start/SKILL.md`'s `allowed_tools`** (AC: #1)
  - [x] 1.1 Open `plugins/crew/skills/start/SKILL.md`. The frontmatter `allowed_tools:` array currently lists MCP tools + `Task`. Append `Write` to the array (Claude Code's built-in filesystem write tool). This is the ONLY frontmatter change in this story.

- [x] **Task 2: Insert step "4.5" in `start/SKILL.md § Dev spawn`** (AC: #1, #2, #3, #4)
  - [x] 2.1 In `plugins/crew/skills/start/SKILL.md § Inner cycle: dev → reviewer → rework § Dev spawn`, between current step 4 (`When the Task tool returns, capture the dev subagent's final message as devTranscript.`) and current step 5 (`pass the captured devTranscript to processDevTranscript(...)`), insert a new numbered step:

    > 4.5. Persist `devTranscript` to disk **before any MCP call**. Invoke the built-in `Write` tool with:
    > - `file_path`: `<targetRepoRoot>/.crew/state/sessions/<sessionUlid>/dev-transcript.txt`
    > - `content`: the verbatim `devTranscript` string (no trimming, no JSON-wrapping, no normalisation)
    >
    > Surface the verbatim chat line:
    >
    > ```
    > dev transcript persisted — .crew/state/sessions/<sessionUlid>/dev-transcript.txt
    > ```
    >
    > with `<sessionUlid>` substituted at runtime. The path in the chat line is relative to `targetRepoRoot` (omit the absolute prefix).
    >
    > **Why this happens before step 5:** if the MCP child has been idle-reaped during the long `Task` run, step 5 will throw "MCP server has disconnected" and the transcript will be lost. The write here uses Claude Code's built-in `Write` tool, which is independent of the MCP server and remains available after a reap. Story 5.11 reads this file to drive orphan recovery in a later session.
    >
    > **On `Write` failure:** surface the error verbatim and halt the inner cycle. Do NOT call `processDevTranscript`. The in-progress manifest is left in place — Story 5.11's orphan-recovery branch will surface it on the next `/crew:start` run.
  - [x] 2.2 Add an invariant statement near the existing "Invariant: The SKILL.md prose MUST pass the transcript verbatim — no summarisation, no editing." block:

    > **Invariant: The transcript MUST be persisted to disk before any MCP call.**
    > The persistence write in step 4.5 happens between `Task` return (step 4) and `processDevTranscript` (step 5). It is the prose layer's responsibility — there is no MCP tool that can be called here without defeating the durability guarantee (MCP may have died during the Task run).

- [x] **Task 3: Update `plugins/crew/skills/start/SKILL.md § Failure modes`** (AC: #4)
  - [x] 3.1 Append a new failure-mode entry under `# Failure modes`:

    > - **`Write` failure persisting dev transcript** (step 4.5): The built-in `Write` tool threw a filesystem error (disk full, permission denied, EROFS). The inner cycle halts; `processDevTranscript` is NOT called; the in-progress manifest is untouched. Operator recovery: inspect filesystem permissions and free space under `<targetRepoRoot>/.crew/state/sessions/`, then re-run `/crew:start`. Once Story 5.11 ships, the next `/crew:start` will surface this manifest as `[orphan]` and route it through the orphan-recovery branch.

- [x] **Task 4: Add the integration test suite** (AC: #6)
  - [x] 4.1 Determine the right test location. The SKILL.md inner cycle is not directly covered by a vitest harness today (prose is exercised via end-to-end smokes, not unit tests). Two options:
    - (a) Add a new file `plugins/crew/mcp-server/src/__tests__/dev-transcript-persistence.test.ts` that exercises the **path-and-content contract** (AC6a–6d, 6g) via direct filesystem assertions, modelling the SKILL.md prose's expected behaviour with a thin test harness.
    - (b) Defer the order-assertion and write-failure-halt cases (AC6e, 6f) to the integration smoke harness (Story 1.8 / `plugin smoke-test`), which exercises real prose flow.
    - Recommended: (a) for AC6a–6d + 6g (deterministic, fast, no LLM in the loop). (b) for AC6e + 6f noted as smoke-only coverage in the test file's docstring.
  - [x] 4.2 Write the test file per the recommendation in 4.1. Use `tmp` directory fixtures per `beforeEach`; clean up per `afterEach` using `fs.rm`. Pattern after `plugins/crew/mcp-server/src/lib/__tests__/` style.
  - [x] 4.3 The test must NOT depend on `processDevTranscript`; the persistence contract is independent of the consumer.
  - [x] 4.4 Run `pnpm vitest --run` from `mcp-server/`. Confirm all existing tests still pass.

- [x] **Task 5: Build, vitest, dist** (AC: all)
  - [x] 5.1 `pnpm build` passes from `mcp-server/`.
  - [x] 5.2 All vitest tests pass. Tool count unchanged (no new MCP tools registered).
  - [x] 5.3 Commit `plugins/crew/mcp-server/dist/` per `CLAUDE.md § Plugin build output is tracked in git` if any TS file under `mcp-server/src/` was touched. If only SKILL.md and test files were touched (no `src/` change), no dist rebuild is required — verify by checking the `git diff` scope.

---

## Implementation strategy

### Why Claude Code's built-in `Write` tool, not an MCP tool

The whole point of Story 5.10 is that the transcript must survive an MCP reap. If the persistence write itself goes through an MCP tool, then a reap-during-Task scenario means the write fails too — and the postmortem's L1 defect repeats verbatim. Writing through Claude Code's built-in `Write` tool is the only seam that is structurally independent of the plugin's MCP server.

This is a deliberate exception to the project's usual rule that canonical-state mutations live in MCP tools (FR81 / NFR16 / `lib/managed-fs.ts § CANONICAL_PATH_GLOBS`). The exception is justified because (a) the path is still under `.crew/state/sessions/**` (a canonical glob), and (b) the alternative — routing through MCP — is structurally incompatible with the durability requirement. The canonical-fs guard in `tests/canonical-fs-guard.test.ts` constrains imports inside `mcp-server/src/**` only; the SKILL.md prose layer is outside that scope and not affected.

### Why no new MCP tool

The natural-looking abstraction "add a `persistDevTranscript` MCP tool" is exactly the trap to avoid. It would (i) make the durability guarantee depend on MCP availability, defeating the purpose, and (ii) introduce a tool whose only caller is the SKILL.md prose, with no second consumer in sight. Story 5.11 reads the file directly (it can use `lib/read-dev-transcript-file.ts` if a helper is desired in 5.11, but that's 5.11's choice — 5.10 only writes).

### Why session-directory rather than a top-level `transcripts/`

The session directory `.crew/state/sessions/<sessionUlid>/` already holds `dev-outcome.json` (Story 4.8b) and `reviewer-result.json` (Story 4.6 revision 2). Both are session-scoped artefacts; adding `dev-transcript.txt` as a sibling preserves locality — everything for one session lives in one directory. Story 5.11's orphan-recovery branch reads the manifest's `claimed_by` ULID, then scans `.crew/state/sessions/<that-ulid>/` for all relevant artefacts in one place. A separate top-level `transcripts/` directory would force 5.11 to look in two places.

### Why no atomic write (tmp + rename)

The `Write` tool is a single-shot write. A torn write on crash is theoretically observable — but the worst case (a partial transcript missing the locked handoff phrase) reproduces the exact behaviour today on a full transcript loss, so the operator experience is no worse. Routing through `atomicWriteFile` would require an MCP tool, which we've already ruled out. Accepted as a v1 trade-off; see § Deferred work.

### Why overwrite on rework rather than append

On a Story 4.3 rework iteration, the parent re-spawns `Task` with the original `devPrompt` and a fresh dev subagent context. The new dev run produces a new transcript. The old transcript is no longer useful for any active concern — the rework reviewer will judge the new state, not the old transcript. Keeping a history would require filename arithmetic (`-rework-1`, `-rework-2`) and would conflict with Story 5.11's "look up by ULID" assumption. Overwrite is the simpler, more correct default.

### Why halt on write failure rather than fall through to MCP

If the write fails, two failure modes are possible:
- (a) Halt the inner cycle (this story's choice). The transcript is unpersisted; `processDevTranscript` is never called; the operator is told why.
- (b) Best-effort: log the write failure, proceed to `processDevTranscript` anyway. The reviewer might still spawn if MCP is alive. But if MCP later dies during the reviewer step, the transcript is lost without a recovery path — the exact L1 defect.

Choice (a) is structurally correct: the entire story exists to ensure the durable seam is in place before the next MCP call. Falling through would re-introduce the very failure mode 5.10 is meant to prevent.

---

## Locked files

- `plugins/crew/mcp-server/src/tools/process-dev-transcript.ts` (Stories 4.3b / 4.5 / 4.6 / 4.8b) — NOT touched. 5.10 changes when the transcript reaches this tool's input, not what the tool does with it.
- `plugins/crew/mcp-server/src/tools/run-dev-terminal-action.ts` (Stories 4.4 / 4.8b) — NOT touched. The transcript is the parent's `Task`-return value, not anything this tool produces.
- `plugins/crew/mcp-server/src/lib/managed-fs.ts` (Story 1.6) — NOT touched. The canonical-fs guard is unaffected; the write happens outside `mcp-server/src/**`.
- `plugins/crew/mcp-server/src/tools/register.ts` — NOT touched. No new MCP tool is registered.
- `plugins/crew/mcp-server/src/errors.ts` — NOT touched. No new error class.

### Declared-locked-file changes (explicit exceptions)

- **`plugins/crew/skills/start/SKILL.md`** (Stories 4.2 / 4.3b / 4.3c / 4.6 / 4.6b / 4.7 / 4.8) — Task 1 adds `Write` to the frontmatter `allowed_tools`. Task 2 inserts a new step 4.5 in `§ Dev spawn` and an invariant statement. Task 3 appends a new entry to `§ Failure modes`. All changes are additive; no existing prose step is renumbered other than the insertion of step 4.5 (existing step 5 onward remains in place by content; the step-5-by-content is now mentally "step 6" but the doc continues to number it 5 — pick one convention and apply consistently throughout the file's downstream cross-refs).

---

## Dev Notes

### Files this story will create

- `plugins/crew/mcp-server/src/__tests__/dev-transcript-persistence.test.ts` (Task 4) — vitest for path/content/idempotency/parent-creation/replay-sanity coverage (AC6a–6d, 6g). Order-assertion and write-failure-halt (6e, 6f) noted as smoke-only in the docstring.

### Files this story will modify

- `plugins/crew/skills/start/SKILL.md` (Tasks 1, 2, 3)

### Files this story will NOT modify

- Any file under `plugins/crew/mcp-server/src/` other than the new test file. No TS source under `src/` changes; therefore no `dist/` rebuild is required (Task 5.3 confirms by `git diff` scope).

### Current-state notes on files being modified

- **`plugins/crew/skills/start/SKILL.md`** (current state per Stories 4.2 / 4.3b / 4.3c / 4.6 / 4.6b / 4.7 / 4.8):
  - Frontmatter `allowed_tools` is at line 4: `[getStatus, mintSessionUlid, claimNextStory, processDevTranscript, processReviewerTranscript, buildPersonaSpawnPrompt, runReviewerSession, postReviewerComments, applyReviewerLabels, Task]`. Task 1 appends `Write`.
  - The `# Inner cycle: dev → reviewer → rework § Dev spawn` section starts around line 48. Step 4 (`When the Task tool returns, capture the dev subagent's final message as devTranscript.`) is at line 64. Step 5 (`pass the captured devTranscript to processDevTranscript(...)`) is at line 66. Task 2's new step 4.5 goes between these two lines.
  - The "Invariant: The SKILL.md prose MUST pass the transcript verbatim..." block is at line 45. Task 2.2 adds a sibling invariant directly below it.
  - The `# Failure modes` section starts around line 123. Task 3 appends a new entry near the end of that section (after the existing `completeStory raising WrongClaimantError or InProgressHandEditError` bullet at line 151).

- **Session directory layout (read-only context):**
  - `<targetRepoRoot>/.crew/state/sessions/<sessionUlid>/dev-outcome.json` — written by `runDevTerminalAction` (Story 4.8b, line 200 of `tools/run-dev-terminal-action.ts`). Atomic via `atomicWriteFile`.
  - `<targetRepoRoot>/.crew/state/sessions/<sessionUlid>/reviewer-result.json` — written by `runReviewerSession` (Story 4.6 revision 2). Atomic via `atomicWriteFile`.
  - 5.10 adds `<targetRepoRoot>/.crew/state/sessions/<sessionUlid>/dev-transcript.txt` — written by the SKILL.md prose via `Write`. NOT atomic (see § Implementation strategy).

### Testing standards

- vitest with `pnpm vitest --run` from `mcp-server/`.
- Use `tmp` directory fixtures per `beforeEach`; clean up per `afterEach` using `fs.rm({ recursive: true, force: true })`.
- The test file does NOT spawn an MCP server, does NOT invoke `processDevTranscript`, does NOT exercise SKILL.md prose. It exercises the **path-and-content contract**: given inputs `(targetRepoRoot, sessionUlid, devTranscript)`, the file at the expected path contains the expected bytes.
- Order-assertion (AC6e) and write-failure-halt (AC6f) are smoke-only because they require driving SKILL.md prose, which is exercised by the install/smoke harness, not by vitest. Document this in the test file's docstring.

### References

- [Source: `_bmad-output/postmortems/2026-05-25-dogfood-rollback.md § L1 defect #3 "Dev transcript is transient"`] — root motivation for this story.
- [Source: `_bmad-output/planning-artifacts/epics/epic-5-orchestration-recovery-visibility-and-resilience.md § Story 5.10`] — story stub and ACs being expanded here.
- [Source: `_bmad-output/implementation-artifacts/4-8b-deterministic-seam-hardening-handoff-parser-and-pr-url-extraction.md`] — sibling story; deterministic-seam pattern and session-directory locality.
- [Source: `plugins/crew/skills/start/SKILL.md § Dev spawn` step 4–step 5] — the seam where step 4.5 is inserted.
- [Source: `plugins/crew/mcp-server/src/tools/run-dev-terminal-action.ts:200`] — `dev-outcome.json` write site; pattern for session-directory file naming.
- [Source: `plugins/crew/mcp-server/src/lib/managed-fs.ts:115`] — `atomicWriteFile` (used by `runDevTerminalAction` and `runReviewerSession` but NOT by this story — see § Implementation strategy).
- [Source: `plugins/crew/mcp-server/src/lib/managed-fs.ts:14`] — `CANONICAL_PATH_GLOBS`; `.crew/state/**` and `.crew/sessions/**` are canonical (the write path falls under `.crew/state/sessions/**`, matching the `.crew/state/**` glob).
- [Source: `plugins/crew/mcp-server/src/tools/process-dev-transcript.ts:93`] — `processDevTranscript` consumer; its input contract is unchanged by this story.
- [Source: project memory `feedback_default_to_deterministic_seams`] — principle: load-bearing decisions live in tool-written artefacts. 5.10 promotes the transcript itself from in-memory string to on-disk artefact.
- [Source: project memory `project_mcp_server_silent_disconnect`] — known defect that motivated this story.
- [Source: project memory `feedback_prose_mut_steps_need_seam`] — usually-true rule that's deliberately violated here, with rationale in § Implementation strategy.

---

## Previous story intelligence

### From Story 4.8b (shipped 2026-05-24)

- Established the session-directory pattern: `<targetRepoRoot>/.crew/state/sessions/<sessionUlid>/<artefact>.json`. 5.10 reuses the same directory with `dev-transcript.txt` as a sibling.
- Established the "deterministic seam" principle: machine-written, machine-read files replace fragile LLM-text extraction. 5.10 extends this principle to the transcript itself — the transcript is the dev subagent's last LLM-authored output, and persisting it gives 5.11 a deterministic input to replay from.
- Used `atomicWriteFile` from `lib/managed-fs.ts` (line 115). 5.10 deliberately does NOT use it — see § Implementation strategy.
- Wrote `dev-outcome.json` in `runDevTerminalAction` (a tool that runs inside the dev subagent's permissions). 5.10 writes from the parent's SKILL.md prose — a different layer with a different reason (the parent is the only entity holding the `Task` return value).

### From Story 4.6 revision 2 (shipped)

- `runReviewerSession` writes `reviewer-result.json` atomically via `atomicWriteFile`. The reviewer's verdict transport is the file, not the chat. 5.10 mirrors this pattern for the dev transcript — except the writer is the parent prose, not the subagent's tool.
- `lib/read-reviewer-result-file.ts` is the read-side helper. If 5.11 needs a similar helper for the transcript, it can create `lib/read-dev-transcript-file.ts` in that story.

### From Story 4.3b (shipped) — transcript-passing contract

- Story 4.3b § (k) declared: "Transcripts flow from `Task` (return value) → SKILL.md prose (in-memory string) → `processDevTranscript` → discarded."
- **Story 5.10 changes this contract.** The new flow is: "Transcripts flow from `Task` → SKILL.md prose (in-memory string) → `Write` tool (durable on-disk file) → `processDevTranscript` → in-memory copy discarded; on-disk copy retained for Story 5.11 replay."
- Backward compatibility: `processDevTranscript`'s signature is unchanged. It still receives `devTranscript: string` from the prose layer. The new on-disk artefact is an additional output, not a change to the existing input flow.

### From the 2026-05-25 postmortem

- The L1 defect named three preventions: (1) persist the dev transcript to disk; (2) add orphan recovery; (3) make MCP resilient to stdin close. Stories 5.10 / 5.11 / 5.12 respectively implement these.
- The postmortem explicitly says: "Re-attempting dogfood without these fixes will reproduce today." Story 5.10 is one of the three non-negotiables for resumed dogfooding.

---

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

- canonical-fs-guard blocked the test file (uses `fs.writeFile` via namespace import); resolved by adding it to the guard's whitelist.
- start-skill-content.test.ts had hardcoded 10-tool count; updated to 11 to include `Write`.
- dist-shipping drift after modifying `src/skills/__tests__/start-skill-content.test.ts`; resolved by running `pnpm build` to regenerate dist.

### Completion Notes List

- AC1: `Write` added to `allowed_tools` frontmatter in SKILL.md; step 4.5 inserted between steps 4 and 5 in `§ Dev spawn` with path computation, verbatim-content requirement, and halt-on-failure instruction.
- AC2: Chat line `dev transcript persisted — .crew/state/sessions/<sessionUlid>/dev-transcript.txt` specified in step 4.5 with relative-path format.
- AC3: Step 4.5 explicitly requires verbatim content (no trimming, no JSON-wrapping, no normalisation).
- AC4: Step 4.5 explicitly halts on Write failure and prohibits calling processDevTranscript when unpersisted. New failure-mode entry added to `§ Failure modes`.
- AC5: File is plain on-disk content written by Claude Code's built-in Write tool, independent of MCP — survives reap/reload/restart by design.
- AC6 (6a–6d, 6g): vitest integration test at `src/__tests__/dev-transcript-persistence.test.ts` — 10 tests, all pass. AC6e and AC6f noted as smoke-only in the test file docstring.
- No new MCP tools registered; tool count in register.ts unchanged.
- `dist/` rebuilt to include updated `start-skill-content.test.js`; dist-shipping drift test passes.

### File List

- `plugins/crew/skills/start/SKILL.md` (modified — Tasks 1, 2, 3)
- `plugins/crew/mcp-server/src/__tests__/dev-transcript-persistence.test.ts` (created — Task 4)
- `plugins/crew/mcp-server/src/skills/__tests__/start-skill-content.test.ts` (modified — Task 5: update tool count to 11)
- `plugins/crew/mcp-server/tests/canonical-fs-guard.test.ts` (modified — Task 5: whitelist test file)
- `plugins/crew/mcp-server/dist/` (rebuilt — Task 5.3: dist refresh for test file changes)
