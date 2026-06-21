# Story 5.11: Orphan-recovery branch in `/crew:start`

story_shape: substrate

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin operator**,
I want **`/crew:start` to detect an orphaned in-progress manifest (one whose `claimed_by` ULID is not the current session's ULID) and offer to replay its persisted dev transcript instead of silently moving on to the next claimable story**,
so that **a mid-cycle MCP reap does not strand a real PR in `in-progress/` with no path to a verdict — closing L1 defect #2 from the 2026-05-25 dogfood-rollback postmortem and unblocking dogfood resumption**.

### What this story is, in one sentence

Add an outer-loop **orphan-recovery branch** to `/crew:start` that runs **before** `claimNextStory`, scans `<targetRepoRoot>/.crew/state/in-progress/`, surfaces any manifest whose `claimed_by` ULID differs from the current session ULID as a one-line `[orphan] <ref> — claimed_by <stale-ulid>` chat surface, asks the operator to choose `reattach` or `skip`, and routes the chosen path through (a) **transcript replay** if the Story 5.10 transcript file exists for the stale session, or (b) atomic move to `blocked/` with `blocked_by: orphan-no-transcript` if it does not, or (c) **no-op preservation** if the operator skips.

### What this story does (and why it needs its own story)

The 2026-05-25 dogfood postmortem (`§ L1, defect #2`) names this defect:

> When MCP died after the dev subagent returned, the in-progress manifest stayed pinned to a now-dead session ULID. The next `/crew:start` invocation called `claimNextStory`, which only inspects `to-do/`. It walked right past the stranded `in-progress/` manifest. No surface line. No prompt. The PR was already open with a locked handoff phrase — but the orchestrator had no path back to it.

Story 5.10 (shipped 2026-05-25) added the durable seam — the dev transcript is now persisted to `<targetRepoRoot>/.crew/state/sessions/<sessionUlid>/dev-transcript.txt` **before** any MCP call. 5.10 writes; **5.11 reads**.

The fix is structural: `/crew:start`'s outer claim loop must check `in-progress/` **before** asking `claimNextStory` for the next to-do candidate. If any in-progress manifest has a `claimed_by` ULID that does not match the current session's ULID, that manifest is an orphan. The orchestrator surfaces it, the operator decides whether to reattach (replay the transcript and resume from the reviewer step) or skip (leave it for human inspection), and the loop continues.

### Why DEGRADED orphan detection (ULID-mismatch ONLY, no heartbeat)

The original epic-block AC1 references the Story 5.2 heartbeat surface ("whose heartbeat is stale or absent"). **Story 5.2 has not shipped.** This story ships with the ULID-mismatch check **only**:

- **Detector this story implements:** `manifest.claimed_by !== currentSessionUlid` — and that is the only criterion.
- **What's deferred to 5.2:** the additional "AND heartbeat is stale or absent" tightening. The carry-forward is documented in § Future tightening (deferred to Story 5.2).

The product trade-off Jack accepted: shipping degraded closes L1 defect #2 (the rollback's "stale claims ignored, story stranded" defect) without blocking on the full Story 5.2 heartbeat surface. The worst-case false positive in the degraded design is **one operator prompt** during a (very rare) concurrent-session scenario — two operators running `/crew:start` against the same target repo at the same time. Acceptable: the operator sees one extra `[orphan]` line and chooses skip; no state is corrupted.

### What this story does NOT

- (a) Implement Story 5.2 heartbeat-based liveness. The detection criterion is ULID-mismatch only. § Future tightening (deferred to Story 5.2) documents the carry-forward.
- (b) Add a new MCP tool. The orphan-recovery branch is **prose-driven** in `start/SKILL.md`, reading manifests via filesystem inspection from the SKILL prose (using a small set of read-only seams; see § Implementation strategy). The route-to-blocked path uses `moveBetweenStates` via a new MCP tool (see § Implementation strategy for tool naming).
- (c) Change `processDevTranscript`'s signature or behaviour. The reattach-with-transcript path passes the persisted transcript bytes verbatim into the existing tool — same input contract as the original dev-spawn path.
- (d) Change the dev or reviewer persona. The dev subagent is NOT re-spawned on reattach-with-transcript; the persisted transcript captures its final message, which is the only input `processDevTranscript` needs. On reattach we go straight from "transcript ready" → reviewer spawn.
- (e) Garbage-collect transcripts. Once an orphan is reattached or skipped, the transcript file is left in place. Cleanup is deferred (see § Deferred work).
- (f) Add telemetry, JSONL events, or per-invocation logging. Owned by Story 4.12 / 5.8. 5.11 surfaces exactly the chat lines this spec names — nothing more.
- (g) Detect non-orphan in-progress manifests claimed by the current session ULID. Those are the session's own work-in-progress (e.g. a rework iteration) — they pass through this branch untouched.
- (h) Address the MCP reap itself. That is Story 5.12's job (client-side resilience, host-side knob, or escalation).
- (i) Auto-reattach. The operator MUST choose `reattach` or `skip` explicitly. There is no auto-mode default, no timeout-to-skip, no remembered preference across runs. Each `[orphan]` surfaces gets its own prompt.
- (j) Handle multiple orphans in parallel. They are surfaced and prompted **one at a time**, in alphabetical ref order. A `skip` on orphan A advances to orphan B's prompt; a `reattach` on orphan A runs the full reattach inner-cycle (transcript replay → reviewer spawn → verdict) before the loop returns to consider orphan B.
- (k) Handle in-progress manifests whose `claimed_by` field is **absent** (malformed). Those are not orphans-in-the-ULID-mismatch sense — they are a different defect (a manifest that was hand-edited or written incorrectly). Out of scope. The existing `completeStory` `WrongClaimantError` already names this case for the complete-side; the orphan branch SKIPS such manifests silently (they are not surfaced as `[orphan]`) and the operator inspects them manually. Future tightening: surface as `[malformed-claim]`; not in this story.
- (l) Modify `claimNextStory`'s behaviour. The orphan check is a **separate** outer-loop step that runs before each `claimNextStory` call. `claimNextStory` continues to scan only `to-do/`.
- (m) Persist any new on-disk artefact. The orphan branch reads existing files (manifests + Story 5.10 transcripts) and routes state via existing primitives (`moveBetweenStates` + manifest field writes via `atomicWriteFile`).
- (n) Use a Claude Code prompt or modal. The choice is a chat-line prompt — the operator types `reattach` or `skip` in chat, matching the existing pattern for inner-cycle continuation. No TUI primitive, no new harness.
- (o) Surface orphans during the inner cycle (mid-dev or mid-reviewer). The check runs ONLY at the top of the outer loop, before the next `claimNextStory`. An orphan that appears mid-inner-cycle (because, e.g., another concurrent session crashed) is picked up on the next outer-loop iteration — same alphabetical-pass guarantee.

### Future tightening (deferred to Story 5.2)

Once Story 5.2 ships the heartbeat surface (`<targetRepoRoot>/.crew/sessions/<session-id>.json` with a `2× interval` staleness threshold), AC1's orphan-detection criterion should be tightened from:

> **5.11 (this story):** `manifest.claimed_by !== currentSessionUlid`

to:

> **5.11 + 5.2:** `manifest.claimed_by !== currentSessionUlid` **AND** (the heartbeat file at `<targetRepoRoot>/.crew/sessions/<manifest.claimed_by>.json` is absent OR has not been refreshed within the staleness window).

The tightening matters because a legitimate concurrent session running against the same target repo is — under the degraded detector — falsely surfaced as an orphan. The heartbeat check confirms the claiming session is actually dead before prompting the operator.

When 5.2 is authored, its spec MUST include a task to retrofit the additional `AND` clause into the SKILL.md orphan-detection prose, plus a new vitest case asserting that a live heartbeat suppresses the orphan surface.

In the meantime, the **worst-case false positive** is one operator prompt during a rare concurrent-session scenario. The operator chooses `skip` and the loop continues — no state corruption, no missed work.

### Deferred work

- **Heartbeat-based tightening (Story 5.2).** See § Future tightening (deferred to Story 5.2). Authoring follow-up captured.
- **Transcript-file garbage collection.** Once an orphan reaches `done/` (via reattach + green reviewer) or `blocked/` (via reattach-no-transcript or operator manual route), the transcript file at `<targetRepoRoot>/.crew/state/sessions/<sessionUlid>/dev-transcript.txt` is no longer load-bearing. A future story under Epic 5 (likely 5.9 or a sibling retention story) should sweep stale session directories.
- **Auto-mode orphan-policy config.** A future operator-facing setting (e.g. `plugin.orphan_policy: prompt | always-reattach | always-skip`) could remove the per-orphan prompt for power users. Out of scope here; the explicit per-prompt is the conservative default while operators are still learning what an orphan means.
- **Multiple-orphan batch UX.** v1 prompts one orphan at a time. A future enhancement could list all orphans up front, then prompt once with a batch decision. v1 priorities favour explicitness.
- **Orphan inside a sub-skill (e.g. `/crew:watch`).** Once Story 5.3 ships `/crew:watch`, that skill could surface `[orphan]` lines too (since it also reads `in-progress/`). The detection logic should be extracted into a shared helper at that point. For now, the logic lives inline in `/crew:start`'s SKILL.md prose.

---

## Acceptance Criteria

> AC1 is `user-surface` per `plugins/crew/docs/user-surface-acs.md` rubric (iv) — it names a Claude Code chat-line surface and a prompt the operator types into. AC2–AC4 describe internal state transitions verified by vitest. AC5 is the integration suite.

**AC1 (user-surface):**

<!-- rubric (iv): any Claude Code UI element the user is expected to observe (chat-surface line + operator prompt) -->
**Given** an in-progress manifest at `<targetRepoRoot>/.crew/state/in-progress/<ref>.yaml` whose `claimed_by` session ULID is not the current session's ULID,
**When** the outer loop of `/crew:start` begins a new claim cycle (i.e., before invoking `claimNextStory`),
**Then** the loop surfaces exactly one chat line of the verbatim shape:

```
[orphan] <ref> — claimed_by <stale-ulid>
```

with `<ref>` and `<stale-ulid>` substituted at runtime, immediately followed by a single-line operator prompt of the shape:

```
reattach or skip? (reattach replays the persisted transcript; skip leaves the manifest in place)
```

The structural anchor for downstream verification is the literal substring `[orphan] <ref> — claimed_by <stale-ulid>` in the rendered chat stream — a vitest harness MUST be able to grep stdout/log for this exact substring (with `<ref>` and `<stale-ulid>` substituted) to confirm AC1 fired. _(artifact: — structural anchor in chat surface; operator-observable)_

<!-- artifact: The literal `[orphan] <ref> — claimed_by <stale-ulid>` line is the structural anchor. A vitest test seeds an orphan manifest, drives the prose, and greps the captured chat stream for the literal substring. -->

**AC2:**
**Given** the operator chooses `reattach` **AND** a persisted Story 5.10 transcript file exists at `<targetRepoRoot>/.crew/state/sessions/<stale-ulid>/dev-transcript.txt`,
**When** the loop proceeds,
**Then** the loop (a) re-claims the manifest under the current session ULID (rewriting `claimed_by` from `<stale-ulid>` to the current `<sessionUlid>` via an atomic manifest write), (b) reads the transcript file bytes verbatim, (c) passes those bytes as `devTranscript` to `processDevTranscript({ targetRepoRoot, sessionUlid, ref, devTranscript })`, and (d) continues the inner cycle from the **reviewer spawn step** — NOT from the dev spawn step. The dev subagent is NOT re-spawned. _(vitest: — replay-from-transcript assertion; covered by AC5 fixture A)_

<!-- Not user-surface: AC2 is an internal state transition. The operator observes the chat lines emitted by `processDevTranscript` (already-existing surface) and the reviewer spawn line — no new visible behaviour beyond what the normal inner cycle prints. -->

**AC3:**
**Given** the operator chooses `reattach` **AND** no persisted transcript exists at `<targetRepoRoot>/.crew/state/sessions/<stale-ulid>/dev-transcript.txt` (the file is missing — e.g. the orphan was created before Story 5.10 deployed, or the session ULID directory was manually cleaned),
**When** the loop proceeds,
**Then** the loop atomically moves the manifest from `<targetRepoRoot>/.crew/state/in-progress/<ref>.yaml` to `<targetRepoRoot>/.crew/state/blocked/<ref>.yaml` via `moveBetweenStates`, and the moved manifest carries `blocked_by: orphan-no-transcript`. The chat line surfaced to the operator is:

```
[blocked] <ref> — orphan-no-transcript: no persisted transcript for session <stale-ulid>; manual recovery required
```

_(vitest: — `blocked/` routing + `blocked_by: orphan-no-transcript` stamp; covered by AC5 fixture B)_

<!-- Not user-surface: AC3 names a chat line, but the line is a deterministic byproduct of the same chat-surface convention AC1 establishes — verified by vitest as an internal state assertion. The user-surface gate is satisfied by AC1's coverage of the orphan surface. -->

**AC4:**
**Given** the operator chooses `skip` (regardless of whether a transcript exists),
**When** the loop proceeds,
**Then** the orphan manifest is left in `<targetRepoRoot>/.crew/state/in-progress/<ref>.yaml` **untouched** (no `claimed_by` rewrite, no move, no field mutation), and the outer loop advances to the next orphan-or-claim step (i.e., re-runs the orphan scan against the remaining in-progress manifests, then falls through to `claimNextStory`). The skipped orphan MUST surface again on the next `/crew:start` invocation (since its state has not changed) — `skip` is a per-invocation deferral, not a permanent dismissal. _(vitest: — skip preserves orphan state; covered by AC5 fixture C)_

<!-- Not user-surface: AC4 is a no-op state assertion. The operator already observed the orphan via AC1; the absence of state mutation is the contract. -->

**AC5 (integration, vitest:):**
vitest covers five fixture scenarios (5a–5e), each seeding a target-repo tmpdir with the relevant manifests and (where applicable) transcript files:

- **(5a) Fixture A — reattach with transcript present.** Seed `in-progress/<ref>.yaml` with `claimed_by: <stale-ulid>` and `<targetRepoRoot>/.crew/state/sessions/<stale-ulid>/dev-transcript.txt` containing a valid handoff transcript (locked handoff phrase + PR URL). Drive the orphan-recovery branch with operator input `reattach`. Assert: (i) the orphan chat line matches the AC1 literal, (ii) the manifest's `claimed_by` is rewritten to the current `<sessionUlid>`, (iii) `processDevTranscript` is invoked exactly once with the verbatim transcript bytes, (iv) the inner cycle proceeds to reviewer spawn (NOT dev spawn) — observed via call-order assertion against a mocked `Task` tool.

- **(5b) Fixture B — reattach with transcript absent.** Seed `in-progress/<ref>.yaml` with `claimed_by: <stale-ulid>` and NO transcript file. Drive operator input `reattach`. Assert: (i) the orphan chat line matches the AC1 literal, (ii) the manifest is moved from `in-progress/` to `blocked/` via `moveBetweenStates`, (iii) the moved manifest's `blocked_by` field equals `orphan-no-transcript`, (iv) the `[blocked]` chat line per AC3 is surfaced, (v) `processDevTranscript` is NOT called.

- **(5c) Fixture C — skip preserves orphan state.** Seed `in-progress/<ref>.yaml` with `claimed_by: <stale-ulid>`. Drive operator input `skip`. Assert: (i) the orphan chat line matches the AC1 literal, (ii) the manifest at `in-progress/<ref>.yaml` is byte-identical to the seeded version (no `claimed_by` rewrite, no field mutation), (iii) the manifest is NOT moved out of `in-progress/`, (iv) the outer loop proceeds to `claimNextStory` (or to the next orphan if multiple are seeded).

- **(5d) Fixture D — alphabetical orphan ordering.** Seed two in-progress manifests, both orphans (each with `claimed_by` ≠ current ULID), with refs `b-second` and `a-first`. Drive the loop. Assert: (i) the AC1 chat line for `a-first` is surfaced **before** the line for `b-second`, (ii) the operator prompt for `a-first` is awaited and resolved before the prompt for `b-second` is rendered.

- **(5e) Fixture E — current-session manifest is NOT an orphan.** Seed `in-progress/<ref>.yaml` with `claimed_by` equal to the current session ULID. Drive the loop. Assert: (i) no `[orphan]` chat line is surfaced for this manifest, (ii) the outer loop proceeds to `claimNextStory` without an orphan branch.

_(vitest: — full integration suite under `mcp-server/src/__tests__/orphan-recovery.test.ts` or equivalent; covers AC1 + AC2 + AC3 + AC4 with deterministic fixtures)_

<!-- Not user-surface: vitest integration suite — internal harness only. -->

---

## Behavioural contract

This section governs the prose-level invariants for the orphan-recovery branch in `start/SKILL.md`. Absolute modals — MUST, MUST NOT, NEVER — are load-bearing; the reviewer enforces them verbatim.

- **The orphan-recovery prompt MUST be a single line of the shape `[orphan] <ref> — claimed_by <stale-ulid>`** followed by exactly one operator-facing prompt of the shape `reattach or skip? (reattach replays the persisted transcript; skip leaves the manifest in place)`. No additional explanatory prose between the two lines; no emoji; no trailing punctuation beyond the `?` in the prompt.

- **The orphan-recovery prompt MUST NOT auto-select reattach or skip.** The operator's typed input (`reattach` or `skip`) is required to advance. There is no timeout-to-default, no remembered preference, no auto-mode override. A `/crew:start` invocation that has not yet received operator input on a surfaced orphan MUST block at the prompt — it MUST NOT silently skip or silently reattach.

- **The orphan-recovery prompt MUST NOT spawn a subagent before the operator's choice.** The dev subagent and reviewer subagent are spawned by `Task` only after the operator types `reattach` (and only on the reviewer-spawn side, since dev is NOT re-spawned on reattach — the persisted transcript is replayed). On `skip`, no spawn occurs. Recovery is initiated by the operator's input — never anticipated.

- **The orphan scan MUST run at the top of every outer-loop iteration**, immediately before each `claimNextStory` call. It MUST NOT run inside the inner cycle (mid-dev, mid-reviewer). It MUST NOT run only once per `/crew:start` invocation — a newly-appearing orphan (e.g. from a concurrent session that died between iterations) MUST be picked up on the next iteration.

- **The orphan scan MUST surface orphans in alphabetical ref order** when multiple exist. The operator MUST be prompted on each in turn (one at a time); a `skip` on the first does NOT silently auto-skip the rest.

- **The orphan-detection criterion MUST be ULID-mismatch only** (`manifest.claimed_by !== currentSessionUlid`). It MUST NOT depend on Story 5.2's heartbeat (which has not shipped). When 5.2 ships, the detector is tightened — see § Future tightening (deferred to Story 5.2).

- **A manifest whose `claimed_by` is absent (malformed) MUST NOT be surfaced as `[orphan]`.** Such manifests are a different defect class; operator manual inspection is required. The scan skips them silently.

- **On `reattach` with a transcript present, the manifest's `claimed_by` MUST be rewritten** to the current session ULID via an atomic manifest write (using `atomicWriteFile` through the manifest-io seam) **before** `processDevTranscript` is invoked. This is required so that `completeStory` (called internally by `processReviewerTranscript` on the green branch) does not raise `WrongClaimantError`.

- **On `reattach` with no transcript, the move-to-blocked MUST be atomic** — a single `moveBetweenStates({ from: "in-progress", to: "blocked" })` call, followed by a manifest field-write stamping `blocked_by: orphan-no-transcript`. The two operations MUST run in this order; if the move succeeds but the field-write fails, the manifest is in `blocked/` without a `blocked_by` — recoverable by the operator. (No new compound primitive is introduced; this matches the existing `processDevTranscript`'s `blocked_by` stamping pattern on the grammar-drift branch.)

- **On `skip`, the manifest MUST NOT be mutated.** No `claimed_by` rewrite, no field add, no move. Byte-identity preservation is the contract — the next `/crew:start` invocation MUST re-surface the orphan if it is still orphaned.

---

## Tasks / Subtasks

Implementation order is load-bearing. The SKILL.md change is the deliverable; the new MCP tool exists to support the atomic state transitions; the vitest suite exists to verify the contract.

- [x] **Task 1: Add the `scanOrphanedInProgress` MCP read-only helper** (AC: #1)
  - [x] 1.1 Create `plugins/crew/mcp-server/src/tools/scan-orphaned-in-progress.ts`. Signature: `scanOrphanedInProgress({ targetRepoRoot, sessionUlid }): Promise<{ orphans: { ref: string; staleUlid: string; manifestPath: string; transcriptPath: string; hasTranscript: boolean }[] }>`.
  - [x] 1.2 Behaviour: enumerate `<targetRepoRoot>/.crew/state/in-progress/*.yaml`, parse each via `parseExecutionManifest`, filter to those whose `claimed_by` is defined AND `!== sessionUlid`, return them in alphabetical ref order (sort by ref). For each, compute `transcriptPath = <targetRepoRoot>/.crew/state/sessions/<staleUlid>/dev-transcript.txt` and stat it to set `hasTranscript`.
  - [x] 1.3 No write side-effects. Pure read. Propagate `MalformedExecutionManifestError` verbatim. Skip manifests with absent `claimed_by` silently (see Behavioural contract — out-of-scope defect class).
  - [x] 1.4 Register the tool in `mcp-server/src/tools/register.ts` alongside the existing read-only tools. Add to `allowed_tools` in `start/SKILL.md` (see Task 4).
  - [x] 1.5 Unit tests in `plugins/crew/mcp-server/src/tools/__tests__/scan-orphaned-in-progress.test.ts` cover: (a) no in-progress → empty array, (b) current-session manifest only → empty array (5e fixture), (c) one stale-ULID manifest with transcript → one orphan with `hasTranscript: true`, (d) one stale-ULID manifest without transcript → `hasTranscript: false`, (e) two stale-ULID manifests → returned in alphabetical ref order (5d fixture), (f) absent `claimed_by` → skipped silently.

- [x] **Task 2: Add the `reattachOrphan` MCP tool for the transcript-present path** (AC: #2)
  - [x] 2.1 Create `plugins/crew/mcp-server/src/tools/reattach-orphan.ts`. Signature: `reattachOrphan({ targetRepoRoot, ref, currentSessionUlid }): Promise<{ chatLog: string[] }>`.
  - [x] 2.2 Behaviour: (i) load `in-progress/<ref>.yaml` via `readManifest`, (ii) verify `claimed_by` is set and not equal to `currentSessionUlid` (else throw a typed `NotAnOrphanError`), (iii) rewrite `manifest.claimed_by` to `currentSessionUlid` via `writeManifest` (atomic via `atomicWriteFile`), (iv) return a `chatLog` entry of the verbatim shape `reattaching <ref> — claimed_by rewritten from <staleUlid> to <currentSessionUlid>`.
  - [x] 2.3 Register in `register.ts` and add to `allowed_tools` in `start/SKILL.md`.
  - [x] 2.4 Unit tests in `plugins/crew/mcp-server/src/tools/__tests__/reattach-orphan.test.ts` cover: (a) successful rewrite — manifest's `claimed_by` is byte-equal to `currentSessionUlid` after the call, (b) `NotAnOrphanError` raised when `claimed_by === currentSessionUlid`, (c) `ManifestNotFoundError` raised when the ref is absent from `in-progress/`.

- [x] **Task 3: Add the `blockOrphanNoTranscript` MCP tool for the no-transcript path** (AC: #3)
  - [x] 3.1 Create `plugins/crew/mcp-server/src/tools/block-orphan-no-transcript.ts`. Signature: `blockOrphanNoTranscript({ targetRepoRoot, ref, staleUlid }): Promise<{ chatLog: string[] }>`.
  - [x] 3.2 Behaviour: (i) load `in-progress/<ref>.yaml` via `readManifest`, (ii) call `moveBetweenStates({ targetRepoRoot, ref, from: "in-progress", to: "blocked" })`, (iii) load the now-blocked manifest from `blocked/<ref>.yaml`, set `blocked_by: "orphan-no-transcript"`, persist via `writeManifest`, (iv) return a `chatLog` entry of the verbatim shape `[blocked] <ref> — orphan-no-transcript: no persisted transcript for session <staleUlid>; manual recovery required`.
  - [x] 3.3 Register in `register.ts` and add to `allowed_tools` in `start/SKILL.md`.
  - [x] 3.4 Unit tests in `plugins/crew/mcp-server/src/tools/__tests__/block-orphan-no-transcript.test.ts` cover: (a) successful move + `blocked_by` stamp, (b) manifest no longer present in `in-progress/<ref>.yaml`, (c) chat line matches AC3's literal shape.
  - [x] 3.5 **Note on the `blocked_by` taxonomy:** Story 5.1 (`block-story` tool + `blocked_by` taxonomy) has not shipped. The taxonomy of valid `blocked_by` values is currently established by `processDevTranscript`'s grammar-drift / gh-error paths (`handoff-grammar`, `gh-defer`, `gh-retry`, `gh-needs-human`, `reviewer-verdict-needs-changes`, `reviewer-verdict-blocked`, `reviewer-no-session-result`). 5.11 adds `orphan-no-transcript` to this de-facto set. When 5.1 ships, the taxonomy will be formalised — that story's spec MUST include `orphan-no-transcript` in the formal allow-list.

- [x] **Task 4: Extend `start/SKILL.md` with the orphan-recovery branch** (AC: #1, #2, #3, #4)
  - [x] 4.1 Add `scanOrphanedInProgress`, `reattachOrphan`, `blockOrphanNoTranscript` to the `allowed_tools` frontmatter array (in addition to the existing tools).
  - [x] 4.2 In `# Steps`, insert a new step `3.5: Orphan-recovery branch` between current step 3 (`mintSessionUlid`) and current step 4 (`Outer loop: claim the next story`).
  - [x] 4.3 Add invariant blocks in `# Inner cycle: dev → reviewer → rework` near the existing transcript-persistence invariant.
  - [x] 4.4 Append to `# Failure modes`: NotAnOrphanError, unrecognised choice, Read failure entries.
  - [x] 4.5 Add `Read` to `allowed_tools` (it is needed to read the persisted transcript file in step 3.5.5.b).

- [x] **Task 5: Integration test suite** (AC: #5)
  - [x] 5.1 Add `plugins/crew/mcp-server/src/__tests__/orphan-recovery.test.ts`. Use `tmp` directory fixtures per `beforeEach`; clean up per `afterEach` via `fs.rm({ recursive: true, force: true })`.
  - [x] 5.2 Cover the five fixtures from AC5 (5a–5e).
  - [x] 5.3 Mock the `processDevTranscript` invocation in 5a using a spy that captures the `devTranscript` argument. Assert byte-equality between the captured argument and the seeded transcript file content.
  - [x] 5.4 Run `pnpm vitest --run` from `mcp-server/`. All existing tests still pass (1300/1300).

- [x] **Task 6: Build, vitest, dist** (AC: all)
  - [x] 6.1 `pnpm build` passes from `mcp-server/`.
  - [x] 6.2 All vitest tests pass. Tool count in `register.ts` increases by 3 (32 → 35). start-skill-content.test.ts updated to 16 tools.
  - [x] 6.3 Commit `plugins/crew/mcp-server/dist/` per `CLAUDE.md § Plugin build output is tracked in git`.
  - [x] 6.4 Canonical-fs-guard test in `tests/canonical-fs-guard.test.ts` passes — new test files whitelisted; production tools route through existing sanctioned seams.

---

## Implementation strategy

### Why a new MCP tool per state-transition path (`reattachOrphan`, `blockOrphanNoTranscript`)

The orphan branch's state mutations are canonical-state writes (`claimed_by` rewrite on the in-progress manifest; move from `in-progress/` to `blocked/` + `blocked_by` stamp). Per `FR81 / NFR16` and the canonical-fs guard, those writes MUST live inside `mcp-server/src/**` tools — not in SKILL.md prose. Story 5.10's exception (using built-in `Write` for the transcript) was justified by the MCP-reap durability requirement; that exception does NOT apply here. The orphan branch runs at the top of the outer loop, when MCP is healthy — there is no reap-survival requirement.

Two narrow tools (`reattachOrphan` for the rewrite, `blockOrphanNoTranscript` for the move + stamp) keep each tool's surface single-purpose and testable. Combining them into one `resolveOrphan` tool with a discriminator parameter would couple two distinct state transitions and complicate the spawn-or-not-spawn decision (which is owned by the SKILL.md prose, not the tool).

### Why `Read` for the transcript replay, not a new tool

The transcript file at `<targetRepoRoot>/.crew/state/sessions/<staleUlid>/dev-transcript.txt` is a plain UTF-8 text file. Story 5.10 deliberately did not register a `readDevTranscript` MCP tool (its § Deferred work documents this as a future option if a non-prose caller appears). 5.11 has a prose caller — `start/SKILL.md` — and the built-in `Read` tool is sufficient. Adding an MCP tool would introduce an abstraction with one caller and no second consumer in sight.

### Why the orphan scan runs before every `claimNextStory`, not once per session

A concurrent session running against the same target repo may die between the current session's outer-loop iterations. If the scan only ran at the top of `/crew:start`, a newly-appearing orphan would be invisible until the next `/crew:start` invocation. Running the scan at the top of every outer-loop iteration costs one directory listing per iteration — negligible overhead, much stronger recovery guarantee.

### Why the prompt is per-orphan, not batched

A batch prompt ("orphans found: A, B, C — choose policy: reattach-all / skip-all / per-orphan") is a UX optimisation for power users with many concurrent orphans. v1 operators are still learning what an orphan means. The explicit per-orphan prompt is the conservative default; batching is § Deferred work.

### Why ULID-mismatch is sufficient as the v1 detector

See § Why DEGRADED orphan detection and § Future tightening (deferred to Story 5.2). The trade-off Jack has accepted: one extra operator prompt in the rare concurrent-session false-positive scenario vs. blocking 5.11 on Story 5.2's heartbeat surface. The product gain (closing L1 defect #2, unblocking dogfood resumption) outweighs the cost.

### Why no auto-mode default

Auto-mode would silently mutate state (either reattaching or skipping) without operator confirmation. Both branches are non-trivial: `reattach` replays a transcript from a now-dead session that may contain a real PR with already-shipped commits; `skip` leaves a strand of work in `in-progress/` that the operator must remember to revisit. The explicit choice is the safety surface.

### Why the SKILL.md orphan-resolution loop runs to completion before falling through to `claimNextStory`

Falling through with unresolved orphans would mean `claimNextStory` and the inner cycle would run concurrently with un-prompted orphans still in `in-progress/`. The scan would re-fire on the next outer-loop iteration, but the operator would face a confused mix of orphan prompts interleaved with new-claim activity. Resolving all orphans first, then advancing to `claimNextStory`, gives the operator a clean mental model.

---

## Locked files

- `plugins/crew/mcp-server/src/tools/process-dev-transcript.ts` (Stories 4.3b / 4.5 / 4.6 / 4.8b / 5.10) — NOT touched. The reattach-with-transcript path feeds bytes into this tool unchanged.
- `plugins/crew/mcp-server/src/tools/claim-next-story.ts` (Story 4.3b) — NOT touched. The orphan branch is a separate outer-loop step.
- `plugins/crew/mcp-server/src/tools/run-dev-terminal-action.ts` (Stories 4.4 / 4.8b) — NOT touched. The dev subagent is NOT re-spawned on reattach.
- `plugins/crew/mcp-server/src/tools/complete-story.ts` (Story 4.1) — NOT touched. The `claimed_by` rewrite is performed by `reattachOrphan`, not `completeStory`; the post-rewrite `claimed_by` matches the current session ULID, so `completeStory`'s `WrongClaimantError` check is satisfied when the green branch later runs.
- `plugins/crew/mcp-server/src/lib/managed-fs.ts` (Story 1.6) — NOT touched. The new tools route through the existing `atomicWriteFile` / `writeManagedFile` seams.
- `plugins/crew/mcp-server/src/state/manifest-state-machine.ts` (Story 1.6) — NOT touched. The new tools call `moveBetweenStates` through its existing exports.
- `plugins/crew/mcp-server/src/lib/manifest-io.ts` (Story 4.3b) — NOT touched. The new tools call `readManifest` / `writeManifest` through their existing exports.

### Declared-locked-file changes (explicit exceptions)

- **`plugins/crew/skills/start/SKILL.md`** (Stories 4.2 / 4.3b / 4.3c / 4.6 / 4.6b / 4.7 / 4.8 / 5.10) — Tasks 4.1–4.5. The frontmatter `allowed_tools` array gains `scanOrphanedInProgress`, `reattachOrphan`, `blockOrphanNoTranscript`, and `Read`. A new step 3.5 is inserted in `# Steps` between current step 3 and current step 4. Two invariant blocks are added in `# Inner cycle`. Three new failure-mode entries are appended to `# Failure modes`. All changes are additive; existing prose is not renumbered (step 4 stays step 4 — the new step is "3.5", matching Story 5.10's "4.5" pattern).
- **`plugins/crew/mcp-server/src/tools/register.ts`** (every prior tool-bearing story) — Task 1.4 / 2.3 / 3.3. Three new tool registrations are added. No existing registration is modified.

---

## Dev Notes

### Files this story will create

- `plugins/crew/mcp-server/src/tools/scan-orphaned-in-progress.ts` (Task 1) — pure-read scan helper, alphabetical ref order.
- `plugins/crew/mcp-server/src/tools/reattach-orphan.ts` (Task 2) — atomic `claimed_by` rewrite.
- `plugins/crew/mcp-server/src/tools/block-orphan-no-transcript.ts` (Task 3) — atomic move + `blocked_by` stamp.
- `plugins/crew/mcp-server/src/tools/__tests__/scan-orphaned-in-progress.test.ts` (Task 1.5).
- `plugins/crew/mcp-server/src/tools/__tests__/reattach-orphan.test.ts` (Task 2.4).
- `plugins/crew/mcp-server/src/tools/__tests__/block-orphan-no-transcript.test.ts` (Task 3.4).
- `plugins/crew/mcp-server/src/__tests__/orphan-recovery.test.ts` (Task 5) — integration suite covering AC5's five fixtures.

### Files this story will modify

- `plugins/crew/skills/start/SKILL.md` (Task 4 — `allowed_tools`, step 3.5, invariants, failure modes).
- `plugins/crew/mcp-server/src/tools/register.ts` (Tasks 1.4 / 2.3 / 3.3 — three new registrations).
- `plugins/crew/mcp-server/src/skills/__tests__/start-skill-content.test.ts` (Task 6.2 — tool-count assertion update).

### Files this story will NOT modify

- Any existing tool file under `mcp-server/src/tools/` other than `register.ts`.
- Any file under `mcp-server/src/lib/` or `mcp-server/src/state/` (the new tools consume existing seams).
- Any file under `mcp-server/src/schemas/` — the `ExecutionManifest` schema already supports `claimed_by` and `blocked_by` as optional fields (Story 4.1).

### Current-state notes on files being modified

- **`plugins/crew/skills/start/SKILL.md`** (per Story 5.10's already-shipped state):
  - Frontmatter `allowed_tools` at line 4: `[getStatus, mintSessionUlid, claimNextStory, processDevTranscript, processReviewerTranscript, buildPersonaSpawnPrompt, runReviewerSession, postReviewerComments, applyReviewerLabels, runAutoMergeGate, Task, Write]`. Task 4.1 appends `scanOrphanedInProgress, reattachOrphan, blockOrphanNoTranscript, Read`.
  - `# Steps` section (lines ~26–39): step 3 is `mintSessionUlid` (line 31); step 4 is `Outer loop: claim the next story` (line 33). Task 4.2's new step 3.5 inserts between them.
  - `# Inner cycle` invariants block at lines 45–49 contains the existing transcript-persistence invariant from Story 5.10. Task 4.3 appends two new invariant statements below it (or in a sibling block — choose the convention that matches the existing structure).
  - `# Failure modes` section starts ~line 147. Task 4.4 appends three new entries after the existing `Write` failure entry from Story 5.10.

- **`plugins/crew/mcp-server/src/tools/register.ts`**: register pattern is established (every existing tool follows the same shape). Tasks 1.4 / 2.3 / 3.3 follow the same shape for the three new tools.

- **`plugins/crew/mcp-server/src/tools/claim-next-story.ts`**: read-only context for this story. The orphan branch is SEPARATE from `claimNextStory`. `listClaimableTodos` (the helper that scans `to-do/`) already reports `inProgressCount` — the orphan branch does NOT need to reuse it; it has its own scan via `scanOrphanedInProgress`.

- **State directory layout (read-only context):**
  - `<targetRepoRoot>/.crew/state/to-do/<ref>.yaml` — scanned by `claimNextStory`.
  - `<targetRepoRoot>/.crew/state/in-progress/<ref>.yaml` — scanned by `scanOrphanedInProgress` (this story).
  - `<targetRepoRoot>/.crew/state/blocked/<ref>.yaml` — destination for the no-transcript path.
  - `<targetRepoRoot>/.crew/state/done/<ref>.yaml` — destination for the reattach-with-transcript-and-green-reviewer path (via `completeStory` called internally by `processReviewerTranscript`).
  - `<targetRepoRoot>/.crew/state/sessions/<sessionUlid>/dev-transcript.txt` — written by Story 5.10; READ by this story on the reattach path.
  - `<targetRepoRoot>/.crew/state/sessions/<sessionUlid>/dev-outcome.json` — written by Story 4.8b; not read by this story.
  - `<targetRepoRoot>/.crew/state/sessions/<sessionUlid>/reviewer-result.json` — written by Story 4.6 revision 2; not read by this story.

### Testing standards

- vitest with `pnpm vitest --run` from `mcp-server/`.
- Use `tmp` directory fixtures per `beforeEach`; clean up per `afterEach` using `fs.rm({ recursive: true, force: true })`.
- Unit tests for each new tool (Tasks 1.5, 2.4, 3.4) exercise the tool's contract directly — no MCP-server spawn, no SKILL.md prose.
- The integration test (Task 5) chains the three new tools through the five fixtures from AC5. The SKILL.md prose's chat-line surfacing and operator-prompt blocking are smoke-only — documented in the test file's docstring (matches Story 5.10's pattern).

### References

- [Source: `_bmad-output/postmortems/2026-05-25-dogfood-rollback.md § L1 defect #2 "Stale in-progress claims ignored"`] — root motivation for this story.
- [Source: `_bmad-output/planning-artifacts/epics/epic-5-orchestration-recovery-visibility-and-resilience.md § Story 5.11`] — story stub and ACs being expanded here. Note: the epic-block AC1 wording includes a heartbeat clause that is DROPPED in this spec (see § Why DEGRADED orphan detection).
- [Source: `_bmad-output/implementation-artifacts/5-10-persist-dev-transcript-to-disk-before-any-mcp-call.md`] — depended-on story; produces the transcript file this story reads.
- [Source: `plugins/crew/skills/start/SKILL.md § Steps` step 3 → step 4] — the seam where step 3.5 is inserted.
- [Source: `plugins/crew/skills/start/SKILL.md § Inner cycle` invariants block] — pattern for the new invariants in Task 4.3.
- [Source: `plugins/crew/mcp-server/src/tools/claim-next-story.ts`] — outer-loop seam pattern; the orphan branch is a sibling, not a modification.
- [Source: `plugins/crew/mcp-server/src/tools/list-claimable-todos.ts`] — alphabetical-sort pattern (`yamlEntries.sort()`) reused in `scanOrphanedInProgress`.
- [Source: `plugins/crew/mcp-server/src/tools/complete-story.ts`] — `claimed_by` validation pattern; the post-reattach `claimed_by` must match the current ULID so this tool's check passes when the green branch later runs.
- [Source: `plugins/crew/mcp-server/src/lib/manifest-io.ts`] — `readManifest` / `writeManifest` seams used by the new tools.
- [Source: `plugins/crew/mcp-server/src/lib/managed-fs.ts:115`] — `atomicWriteFile` primitive (Story 1.6); used transitively via `writeManifest`.
- [Source: `plugins/crew/mcp-server/src/state/manifest-state-machine.ts:76`] — `moveBetweenStates` primitive (Story 1.6); used by `blockOrphanNoTranscript`.
- [Source: `plugins/crew/docs/user-surface-acs.md § What counts as a user-surface § (iv)`] — rubric for AC1's `(user-surface)` tag.
- [Source: project memory `feedback_default_to_deterministic_seams`] — principle: load-bearing decisions live in tool-written artefacts. 5.11's `claimed_by` rewrite and `blocked_by` stamp follow this principle; the operator's reattach/skip choice is the only LLM-prose decision in the branch.
- [Source: project memory `project_ac_marker_gap`] — AC marker convention; every AC in this spec carries either `artifact:` or `vitest:` per the convention.
- [Source: project memory `project_dogfood_paused_until_l1`] — the dogfood pause is keyed on this story (L1 defect #2) landing.

---

## Previous story intelligence

### From Story 5.10 (shipped 2026-05-25)

- Story 5.10 wrote the transcript file at `<targetRepoRoot>/.crew/state/sessions/<sessionUlid>/dev-transcript.txt` via Claude Code's built-in `Write` tool, **before** any MCP call, so the file survives an MCP reap. This story READS that file via Claude Code's built-in `Read` tool — the symmetric pattern. The `Read` is from the SKILL.md prose layer, not from inside an MCP tool, so the read is not gated by MCP availability either.
- Story 5.10 deliberately did NOT register a `persistDevTranscript` MCP tool (the durability requirement made it incompatible). 5.11 deliberately does NOT register a `readDevTranscript` MCP tool either, for the same reason: the only caller is prose, and an MCP tool would add abstraction without a second consumer.
- Story 5.10's § Deferred work names "migration from prior sessions" — sessions started before 5.10 deployed have no transcript file. **5.11's no-transcript path handles this case explicitly** (it routes to `blocked/` with `blocked_by: orphan-no-transcript`). This is the migration shape — no separate migration tooling is needed.
- Story 5.10's file is written verbatim — no trimming, no JSON-wrap, no normalisation. 5.11 reads the file's bytes verbatim and passes them straight to `processDevTranscript`'s `devTranscript: string` input. Byte-identity is the load-bearing contract.

### From Story 4.8b (shipped 2026-05-24) — deterministic-seam pattern

- Established the session-directory pattern: `<targetRepoRoot>/.crew/state/sessions/<sessionUlid>/<artefact>.json`. 5.11 reads from the same directory.
- Established the "deterministic seam" principle: machine-written, machine-read files replace fragile LLM-text extraction. 5.11's reattach-with-transcript path consumes the deterministic seam Story 5.10 created.

### From Story 4.3b (shipped) — outer-loop and `claimNextStory` contract

- `claimNextStory` returns a discriminated-union with `next` in `{ spawn-dev, queue-drained, waiting-on-in-progress }`. The SKILL.md prose drives the outer loop. 5.11 inserts a new outer-loop step (3.5) **before** `claimNextStory` — it does not modify `claimNextStory` or its result type.
- The session ULID is minted once per `/crew:start` invocation via `mintSessionUlid`. 5.11 uses this ULID as the `currentSessionUlid` argument throughout the orphan branch.

### From Story 4.1 (shipped) — `claimed_by` field semantics

- `claimed_by` is stamped by `claimStory` on the in-progress move (Story 4.2). It is preserved by `completeStory` on the done move (for retro attribution). It is validated by `completeStory`'s `WrongClaimantError` check.
- The `ExecutionManifest` schema already has `claimed_by` as an optional string field (line 169 of `schemas/execution-manifest.ts`). 5.11 rewrites this field on the reattach path via `writeManifest` — no schema change needed.

### From the 2026-05-25 postmortem

- The L1 defect named three preventions: (1) persist the dev transcript to disk (Story 5.10, shipped), (2) **add orphan recovery (this story)**, (3) make MCP resilient to stdin close (Story 5.12, pending). Shipping 5.11 closes defect #2 and brings dogfood-readiness from 1/3 to 2/3.
- The postmortem's "stop, don't fix forward" rule means a failed 5.11 dogfood run halts — it does NOT loop into auto-recovery. 5.11's prompt-the-operator design is consistent with this rule.

---

## Dev Agent Record

### Agent Model Used

claude-sonnet-4-6

### Debug Log References

None — clean first-pass implementation. Resolved two classes of test failures on first run: (1) six tool-count assertions across test files (32 → 35), (2) canonical-fs-guard whitelist missing four new test files. Both fixed before final commit.

### Completion Notes List

- Implemented three new MCP tools: `scanOrphanedInProgress` (pure read, alphabetical sort), `reattachOrphan` (atomic claimed_by rewrite + NotAnOrphanError), `blockOrphanNoTranscript` (move to blocked/ + orphan-no-transcript stamp).
- Added `NotAnOrphanError` to `errors.ts`.
- Extended `SKILL.md` with step 3.5 (orphan-recovery branch), two invariant blocks, three failure-mode entries, and `Read`/three new tools in `allowed_tools` (12 → 16).
- Unit tests: 3 files covering all specified scenarios (scan: 9 cases, reattach: 4 cases, block: 4 cases).
- Integration suite: `orphan-recovery.test.ts` covering all five AC5 fixtures (5a–5e) with processDevTranscript mocked for 5a byte-equality assertion.
- All 1300 tests pass after updating six tool-count assertions and whitelisting four test files in canonical-fs-guard.
- Behavioural contract invariants confirmed in SKILL.md: verbatim `[orphan]` surface line, verbatim `reattach or skip?` prompt, MUST NOT spawn subagent, MUST run before every `claimNextStory`.

### File List

- `plugins/crew/mcp-server/src/tools/scan-orphaned-in-progress.ts` (new)
- `plugins/crew/mcp-server/src/tools/reattach-orphan.ts` (new)
- `plugins/crew/mcp-server/src/tools/block-orphan-no-transcript.ts` (new)
- `plugins/crew/mcp-server/src/tools/__tests__/scan-orphaned-in-progress.test.ts` (new)
- `plugins/crew/mcp-server/src/tools/__tests__/reattach-orphan.test.ts` (new)
- `plugins/crew/mcp-server/src/tools/__tests__/block-orphan-no-transcript.test.ts` (new)
- `plugins/crew/mcp-server/src/__tests__/orphan-recovery.test.ts` (new)
- `plugins/crew/mcp-server/src/errors.ts` (modified — NotAnOrphanError added)
- `plugins/crew/mcp-server/src/tools/register.ts` (modified — 3 new tool registrations)
- `plugins/crew/skills/start/SKILL.md` (modified — allowed_tools, step 3.5, invariants, failure modes)
- `plugins/crew/mcp-server/src/skills/__tests__/start-skill-content.test.ts` (modified — tool count 12 → 16)
- `plugins/crew/mcp-server/src/tools/__tests__/compute-agreement.test.ts` (modified — tool count 32 → 35)
- `plugins/crew/mcp-server/src/tools/__tests__/inner-cycle.integration.test.ts` (modified — tool count 32 → 35)
- `plugins/crew/mcp-server/src/tools/__tests__/run-auto-merge-gate.test.ts` (modified — tool count 32 → 35)
- `plugins/crew/mcp-server/tests/ask-mode-enforcement.test.ts` (modified — tool count 32 → 35)
- `plugins/crew/mcp-server/tests/ask-skill.test.ts` (modified — tool count 32 → 35)
- `plugins/crew/mcp-server/tests/get-team-snapshot.test.ts` (modified — tool count 32 → 35)
- `plugins/crew/mcp-server/tests/canonical-fs-guard.test.ts` (modified — whitelist 4 new test files)
- `plugins/crew/mcp-server/dist/` (rebuilt — all new and modified TS compiled)

---

## Dependencies

- **Story 5.10** (shipped 2026-05-25) — writes the dev transcript file this story reads. Hard dependency.

(No dependency on Story 5.2 — see § Why DEGRADED orphan detection and § Future tightening (deferred to Story 5.2).)
