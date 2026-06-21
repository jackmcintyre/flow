# Story 4.3c: Call `completeStory` after `READY FOR MERGE` so the queue drains

story_shape: user-surface

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin operator running `/crew:start` against a multi-story backlog**,
I want **`processReviewerTranscript` to atomically complete the story whenever it parses a `READY FOR MERGE` verdict — moving the in-progress manifest to `done/` BEFORE it returns to the prose layer**,
so that **the queue actually drains across multiple stories: today the manifest stays in `in-progress/` after a green reviewer verdict, the next `claimNextStory` returns `waiting-on-in-progress` forever, and the second (and third…) ready story is never claimed without manual intervention.**

### What this story is, in one sentence

Move the `completeStory` invocation from the SKILL.md prose layer INTO `processReviewerTranscript`'s `done-ready-for-merge` branch as an internal function call. The MCP tool becomes the source of atomicity for the verdict-parse + manifest-move pair; its return shape gains a `completed: true` flag so the SKILL.md prose can confirm the move and emit the verbatim chat line `story <ref> moved to done — claiming next` before looping back to `claimNextStory`. The two `done-blocked-*` branches are unchanged (they MUST NOT call `completeStory`). The `allowed_tools` array stays at the Story 4.3b seven-tool set — `completeStory` is called as an internal function import, not through the MCP allowed_tools surface, so it does NOT need a permission entry on the `/crew:start` skill for this story.

### Smoke evidence (why we're revising mid-flight)

This story originally placed the `completeStory` call at the SKILL.md prose layer (after `processReviewerTranscript` returned `done-ready-for-merge`), anchored by an AC3 structural-anchor check on the prose text. The implementation shipped through Tasks 1–7 (`pnpm test` green, structural anchors verified). The operator-smoke on 2026-05-22 then ran the flow twice end-to-end with the implemented code:

- **Trial 1 (Story B):** Reviewer returned `READY FOR MERGE`; the prose called `completeStory`; the manifest moved to `done/`; the verbatim chat line `story <ref-B> moved to done — claiming next` was emitted; the outer loop advanced. Contract honoured.
- **Trial 2 (Story A):** Reviewer returned `READY FOR MERGE`; the prose layer surfaced the verdict line but silently SKIPPED the `completeStory` call; jumped straight to `claimNextStory`; manifest stranded in `in-progress/`; queue stalled.

Same SKILL.md text on disk. Same MCP tool. Two different runtime outcomes. The AC3 structural anchor proved the prose said the right thing; it did not prove Claude executed it. This is a pure prose-determinism flake — the load-bearing version of Epic 2's retro on LLM non-determinism. The lesson is captured in feedback memory `feedback_prose_mut_steps_need_seam.md`: prose-level MUSTs are flaky for mutating side-effects, even with a structural anchor. The fix is to move the side-effect into a tool-layer seam.

### New architectural direction

The `completeStory` call moves out of the SKILL.md prose and into `processReviewerTranscript`'s `done-ready-for-merge` branch. The MCP tool is now the atomic source of truth for the verdict-parse + manifest-move pair — once `processReviewerTranscript` returns from the green branch, the manifest is guaranteed to have moved to `done/`. The prose layer's responsibility shrinks to (a) surface the returned `chatLog`, (b) confirm the new `completed: true` flag, (c) emit the informational chat line, (d) loop back to `claimNextStory`. Informational prose stays prose; mutating side-effects move to the tool.

Concrete shape:

- `processReviewerTranscript` imports `completeStory` as an internal function (not through the MCP `register.ts` surface).
- On the `READY FOR MERGE` branch: AFTER parsing the verdict and pushing the `reviewer verdict: READY FOR MERGE — story <ref> ready for merge gate` chat line, the tool calls `completeStory({ targetRepoRoot, ref, sessionUlid })` and AWAITS it before returning.
- The return shape for the green branch gains a `completed: true` field (literal-typed). The prose reads this field to confirm the move happened before emitting the informational chat line.
- On the `BLOCKED` branch: no change — pure pass-through, no `completeStory` call, no `completed` field.
- On the reviewer-grammar-drift branch: no change — manifest gets `blocked_by: "reviewer-grammar"` stamped, no `completeStory` call, no `completed` field.
- On the `NEEDS CHANGES` (rework) branch: no change — `rework_count` increments, no `completeStory` call.

The `allowed_tools` array on `/crew:start`'s SKILL.md REVERTS from the original spec's eight-tool widening to Story 4.3b's seven-tool set. `completeStory` is invoked as an internal Node import from `process-reviewer-transcript.ts`; the prose layer never invokes it directly. The MCP tool-surface permission gate is not in this story's call path.

### What this story fixes (and why it needs its own story)

Story 4.3b (PR #105) shipped the refactored `/crew:start` inner cycle. Story 4.3c's first implementation attempted the queue-drain fix at the prose layer; operator-smoke proved that approach is non-deterministic for a mutating side-effect. This revision moves the side-effect into the tool layer so it CAN'T be skipped — there is no longer a prose step to forget.

Three concrete gaps the revision closes:

- **The mutating step is now atomic with the verdict parse.** Once `processReviewerTranscript` returns `done-ready-for-merge`, the manifest has moved. The prose cannot skip the move because the prose is not the caller.
- **The user-surface signal is still emitted.** The new `completed: true` flag on the green-branch return shape gives the prose layer a deterministic switch to drive the `story <ref> moved to done — claiming next` chat line. The chat line is informational (no mutation), so prose-emission is the right surface — prose-level structural anchors are fine for informational lines.
- **The architecture stays inspectable.** `processReviewerTranscript` already mutates the manifest on the `NEEDS CHANGES` and reviewer-grammar-drift branches; adding the move-to-done mutation on the green branch is a symmetric extension of the same write-surface, not a new write surface.

This story remains a **temporary bridge fix** until Story 4.10b's auto-merge gate lands. Story 4.10b will eventually want to interpose a gate between the verdict parse and the manifest move; when that happens it will refactor `processReviewerTranscript` (or the call site) accordingly. Story 4.3c's contract is "READY FOR MERGE means done" until 4.10b widens it.

### This story does NOT

- (a) Touch `_bmad-output/implementation-artifacts/sprint-status.yaml` or any other file under `_bmad-output/implementation-artifacts/`. The orchestrator owns status transitions. The dev agent MUST NOT edit any status / state file when implementing this story.
- (b) Implement Story 4.10b's auto-merge gate. The `completeStory` call this story adds is the v1 bridge — it ignores PR state. Story 4.10b will replace the bare call with a gate; this story does not pre-empt that work.
- (c) Modify the `completeStory` MCP tool's behaviour, signature, or error model. The tool already exists (Story 4.1) and is registered in `plugins/crew/mcp-server/src/tools/register.ts`. Story 4.3c only adds a new internal-function caller (`process-reviewer-transcript.ts`); the tool body, its `inputSchema`, its `WrongClaimantError` / `InProgressHandEditError` / `ManifestNotFoundError` raises, and its dist artefacts are byte-identical before and after this story. **`plugins/crew/mcp-server/src/tools/complete-story.ts` is LOCKED — do not modify.**
- (d) Change the chat-surface lines from Story 4.3b. The existing `handoff received`, `reviewer verdict: READY FOR MERGE`, `reviewer verdict: NEEDS CHANGES`, `reviewer verdict: BLOCKED`, `handoff grammar drift`, and `reviewer grammar drift` lines stay byte-identical. We ADD one new line emitted by the prose layer: `story <ref> moved to done — claiming next`.
- (e) Auto-resolve `blocked_by` on either `done-blocked-*` branch. The `done-blocked-reviewer-verdict` and `done-blocked-reviewer-grammar` branches MUST NOT call `completeStory`. The story stays in `in-progress/` with `blocked_by` semantics unchanged from Story 4.3b.
- (f) Widen the `/crew:start` SKILL.md `allowed_tools` array. **This is a REVERSAL from the original spec.** Original Story 4.3c added `completeStory` to `allowed_tools` (7 → 8). The revision REVERTS that change: `completeStory` is now called internally from `process-reviewer-transcript.ts`, so the skill's prose layer does not need a permission entry. Final `allowed_tools` stays at exactly the Story 4.3b seven-tool set: `[getStatus, mintSessionUlid, claimNextStory, processDevTranscript, processReviewerTranscript, buildPersonaSpawnPrompt, Task]`. **Why we reversed this:** the original architectural decision placed the mutating step at the prose layer, which required the permission entry. The smoke-evidence above proved the prose-layer approach is non-deterministic; moving the call to the tool layer means the prose never invokes `completeStory` directly, so the permission entry is no longer needed. See feedback memory `feedback_prose_mut_steps_need_seam.md`.
- (g) Add a `done-handoff-but-no-review-yet` completion path. Story 4.3b declared that branch in the discriminated-union return type for ABI stability; it is NOT returnable from v1. Story 4.3c does NOT add a `completeStory` call for this branch either.
- (h) Change the rework branch. `next: "rework-dev"` continues to loop back to step 3 (dev spawn) inside the inner cycle. `rework_count` is incremented in-place by `processReviewerTranscript` and the manifest stays in `in-progress/`. No `completeStory` call.
- (i) Move the `completeStory` call out of `processReviewerTranscript` into some other tool (e.g. `claimNextStory`). The completion signal originates in the inner cycle's reviewer verdict; co-locating the move with the parse is the whole point of this revision.
- (j) Persist anything about the completion beyond what `completeStory` already does (move manifest, stamp `status: "done"`, preserve `claimed_by`). No new telemetry events, no chatLog summary file. The single `story <ref> moved to done — claiming next` line is the only new user-observable artefact.
- (k) Add a `force` flag, idempotency check, or retry around `completeStory`. The tool's existing errors (`InProgressHandEditError`, `WrongClaimantError`, `ManifestNotFoundError`) propagate verbatim out of `processReviewerTranscript`. If `completeStory` throws, `processReviewerTranscript` MUST let the error propagate (it is the caller's caller's responsibility — the MCP `register.ts` `DomainError` wrapper handles serialisation).
- (l) Touch the dev or reviewer persona files, the locked handoff phrase, the verdict sentinel grammar, or the `blocked_by` taxonomy. None of these change.
- (m) Add `completeStory` to the dev or reviewer subagent permission specs. Those subagents do NOT call `completeStory` for this flow.
- (n) Change `claimNextStory`'s return shapes or its drain logic. `queue-drained` and `waiting-on-in-progress` continue to mean what they meant in Story 4.3b. After this story, the `waiting-on-in-progress` path becomes a genuine "another session has claimed this story" signal rather than the same-session stall it currently is.

---

## Acceptance Criteria

> AC1 and AC5 are user-surface per `plugins/crew/docs/user-surface-acs.md` rubric. AC2 is internal logic (about NOT calling a tool on blocked branches) — no tag. AC3 is structural / unit-test anchored — no tag. AC4 is the integration test — `(integration)` tag.

**AC1 (user-surface):**
**Given** the SKILL.md prose's inner cycle has just received `{ next: "done-ready-for-merge", completed: true, chatLog: [...] }` from `processReviewerTranscript` for a story with ref `<ref>` originally in `<targetRepoRoot>/.crew/state/in-progress/<ref>.yaml`,
**When** the prose handles the verdict,
**Then** (a) the manifest at `<targetRepoRoot>/.crew/state/in-progress/<ref>.yaml` no longer exists and a manifest at `<targetRepoRoot>/.crew/state/done/<ref>.yaml` exists with `status: "done"` and the original `claimed_by` preserved (this is the side-effect of `processReviewerTranscript`'s internal `completeStory` call, performed BEFORE the tool returned to the prose); (b) the prose surfaces every entry of the returned `chatLog` (including the `reviewer verdict: READY FOR MERGE — story <ref> ready for merge gate` line) to the operator in order; (c) the prose reads the `completed: true` flag and emits the verbatim chat-surface line `story <ref> moved to done — claiming next` (no paraphrase, no reordering, no leading or trailing whitespace beyond a newline), AFTER surfacing the chatLog and BEFORE the next `claimNextStory` call; (d) only after this line is emitted does the prose return to outer loop step 4 (`claimNextStory`). _(FR19, FR-new; closes the queue-drain stall observed in PR #105 operator smoke and the prose-determinism flake observed in the 2026-05-22 smoke)_

<!-- User-surface: AC1 names `/crew:start`'s observable chat surface (rubric iv — a chat-surface line) AND the on-disk manifest state at `<targetRepoRoot>/.crew/state/done/<ref>.yaml` (rubric iii). The trigger has moved from prose-driven to tool-driven; the user-observable contract is identical. -->

**AC2:**
**Given** `processReviewerTranscript` is parsing a reviewer transcript whose verdict sentinel is `BLOCKED`, OR whose final-line grammar is drifted/missing/unknown,
**When** the tool handles either case,
**Then** (a) the tool MUST NOT call `completeStory` — the story stays in `<targetRepoRoot>/.crew/state/in-progress/<ref>.yaml` with `blocked_by` stamped only on the grammar-drift branch (per Story 4.3b semantics); (b) the returned object MUST NOT contain a `completed: true` field on either branch (the field is exclusive to the `done-ready-for-merge` shape); (c) the prose layer surfaces the existing verbatim `reviewer verdict: BLOCKED — story <ref> awaiting human` or `reviewer grammar drift — story <ref> blocked. …` line from the returned chatLog; (d) the prose MUST NOT emit the `story <ref> moved to done — claiming next` line on either branch; (e) the prose returns to outer loop step 4 (`claimNextStory`). _(Architecture clarity; preserves Story 4.3b semantics; prevents accidental completion of a blocked story)_

<!-- Not user-surface: AC2 is a MUST-NOT assertion about internal tool logic. The user-observed chat lines on these branches are unchanged from Story 4.3b. -->

**AC3:**
The following structural and behavioural anchors MUST be present:

- (i) The `processReviewerTranscript` return type union includes the green-branch shape `{ next: "done-ready-for-merge"; completed: true; chatLog: string[] }`. The `completed` field is a literal-true type. The three non-green branches do NOT carry this field. (TypeScript type assertion — `tsc` catches drift; unit test asserts the field's presence on a green-branch fixture.)
- (ii) A unit test in `plugins/crew/mcp-server/src/tools/__tests__/process-reviewer-transcript.test.ts` (or a sibling test file) asserts: when `processReviewerTranscript` is invoked with a `READY FOR MERGE` transcript against a seeded in-progress manifest, the manifest at `in-progress/<ref>.yaml` no longer exists and a manifest at `done/<ref>.yaml` exists with `status: "done"` and preserved `claimed_by`, AND the returned object has `completed: true`. The assertion is the seam contract.
- (iii) The same test file asserts: when `processReviewerTranscript` is invoked with a `BLOCKED` transcript, the manifest stays at `in-progress/<ref>.yaml` (no `done/` entry created), the returned object does NOT have a `completed` field, and the returned `next` is `"done-blocked-reviewer-verdict"`.
- (iv) The same test file asserts: when `processReviewerTranscript` is invoked with a grammar-drift transcript (e.g. missing the `**Verdict: …**` sentinel), the manifest stays at `in-progress/<ref>.yaml` with `blocked_by: "reviewer-grammar"` stamped, no `done/` entry created, the returned object does NOT have a `completed` field, and the returned `next` is `"done-blocked-reviewer-grammar"`.
- (v) The SKILL.md prose at `plugins/crew/skills/start/SKILL.md` still contains the verbatim chat-line literal `story <ref> moved to done — claiming next` in its `# Inner cycle: dev → reviewer → rework` section's `## Reviewer spawn` verdict-handling block (em dash character `—` (U+2014), lowercase, no internal punctuation drift). AC1 prose anchor — informational chat line stays prose-emitted. Asserted by the existing `start-skill-content.test.ts`.
- (vi) The SKILL.md prose contains an instruction to loop back to outer loop step 4 (`claimNextStory`) on the `done-ready-for-merge` branch after emitting the new chat line. Substring match on `claimNextStory` within the verdict-handling block.
- (vii) The `/crew:start` SKILL.md front-matter `allowed_tools` array, parsed as an unordered set, equals exactly the Story 4.3b seven-tool set `{getStatus, mintSessionUlid, claimNextStory, processDevTranscript, processReviewerTranscript, buildPersonaSpawnPrompt, Task}` — set-equality, order-agnostic, exactly seven entries. The set-equality assertion catches both a stray `completeStory` entry (if a prior implementation pass left it in) and any unexpected addition. **This REVERSES the original spec's 7 → 8 widening; the AC3 anchor count vs Story 4.3b is `7 stays at 7`, not `8`.**
- (viii) The `# Failure modes` section of SKILL.md mentions that `completeStory`'s errors (`InProgressHandEditError`, `WrongClaimantError`) can surface through `processReviewerTranscript` on the `READY FOR MERGE` branch. Substring match on `completeStory` within the failure-modes section. The wording change vs the original spec: errors now propagate THROUGH `processReviewerTranscript` (not from a prose-layer call), because that is the actual call site.

<!-- Not user-surface: AC3 covers TypeScript type, unit test, and content-structure anchors. The user-observable behaviour is anchored by AC1 (chat line + on-disk state) and AC5 (live operator smoke). -->

**AC4 (integration):**
vitest covers the full claim → dev → reviewer-ready → claim-next loop end-to-end against a tmpdir fixture target repo seeded with two ready stories. The test composes the inner cycle by calling the tool functions directly with scripted transcripts (no actual `Task` spawn — that's AC5's smoke). For each of the two stories the test:

- (a) Calls `claimNextStory` → asserts `{ next: "spawn-dev", ref, title, manifestPath, chatLog }`, asserts the manifest moved to `in-progress/`.
- (b) Calls `processDevTranscript` with a scripted handoff-phrase transcript → asserts `{ next: "spawn-reviewer", reviewerPrompt, chatLog }`.
- (c) Calls `processReviewerTranscript` with a scripted `READY FOR MERGE` transcript → asserts `{ next: "done-ready-for-merge", completed: true, chatLog }`. **No external `completeStory` call is made by the test code on this branch — the test asserts that the side-effect was performed internally by `processReviewerTranscript` before it returned.** Specifically: asserts the manifest at `<targetRepoRoot>/.crew/state/in-progress/<ref>.yaml` no longer exists and `<targetRepoRoot>/.crew/state/done/<ref>.yaml` exists with parsed manifest `status === "done"` and preserved `claimed_by === sessionUlid`.
- (d) Asserts the synthetic chat log (assembled by the test as the SKILL.md prose would assemble it — concatenating returned `chatLog`s plus the simulated `story <ref> moved to done — claiming next` line emitted after observing `completed: true`) contains the verbatim line `story <ref> moved to done — claiming next` exactly once per story, AFTER the `reviewer verdict: READY FOR MERGE — story <ref> ready for merge gate` line for that story.

After both stories have been driven through the loop, the test then:

- (e) Calls `claimNextStory` a third time → asserts `{ next: "queue-drained", chatLog: [<verbatim queue-drained line>] }`.
- (f) Asserts final on-disk state: `<targetRepoRoot>/.crew/state/to-do/` is empty, `<targetRepoRoot>/.crew/state/in-progress/` is empty, `<targetRepoRoot>/.crew/state/done/` contains exactly the two ref files with `status: "done"`. No `blocked/` content created.

Negative-coverage assertions (within the same test file):

- (g) Reviewer-`BLOCKED` branch: A separate test case seeds one story, drives it through `claimNextStory` → `processDevTranscript` → `processReviewerTranscript` with a `**Verdict: BLOCKED** [reason]` transcript → asserts the manifest stays in `in-progress/`, asserts `done/` is empty, asserts the returned object does NOT contain a `completed` field. The test verifies that `processReviewerTranscript` itself did not invoke `completeStory` (manifest position is the observable proof — it did not move).
- (h) Reviewer-grammar-drift branch: Same shape as (g) but with an unrecognised reviewer-final-line sentinel; asserts manifest in `in-progress/` with `blocked_by: "reviewer-grammar"`, `done/` empty, returned object has no `completed` field.

**AC5 (user-surface):**
**Given** an operator running `/crew:start` against a scratch repo seeded with two ready source stories, hired `generalist-dev` and `generalist-reviewer` personas, and a real Claude Code session,
**When** the operator observes the live session through to natural termination,
**Then** they see (a) the Story 4.2 outer-loop lines for the first story; (b) the Story 4.3b inner-cycle lines for the first story through to `reviewer verdict: READY FOR MERGE — story <ref-A> ready for merge gate`; (c) the verbatim line `story <ref-A> moved to done — claiming next`; (d) the outer-loop lines for the second story; (e) the inner-cycle lines for the second story through to `reviewer verdict: READY FOR MERGE — story <ref-B> ready for merge gate`; (f) the verbatim line `story <ref-B> moved to done — claiming next`; (g) the queue-drained line; (h) on-disk state shows `to-do/` empty, `in-progress/` empty, and `done/<ref-A>.yaml` and `done/<ref-B>.yaml` both present with `status: "done"`. The operator MUST NOT observe the queue-stall bug (the `waiting on in-progress work` line between stories). **Per feedback memory `feedback_prose_mut_steps_need_seam.md`, this smoke MUST be run at least twice (two independent fresh-session trials), and both trials MUST pass.** A single-trial pass is insufficient evidence — the 2026-05-22 flake passed once and failed once on the same code. _(closes the PR #105 carry-forward AND the 2026-05-22 prose-determinism flake)_

<!-- User-surface: AC5 names `/crew:start` (rubric i), the chat-surface lines (rubric iv), and the on-disk manifest state (rubric iii). The double-trial requirement is the determinism guardrail — a single trial is insufficient to prove the seam holds because the original prose-layer implementation passed a single trial before being caught by the second. -->

---

## Behavioural contract

The new architecture moves the MUST list onto `processReviewerTranscript` (the mutating step) and trims the SKILL.md prose contract to informational chat-line emission + control flow. Both files this story touches MUST cite this section by full path (`_bmad-output/implementation-artifacts/4-3c-call-completestory-after-ready-for-merge.md § Behavioural contract`).

### `processReviewerTranscript` invariants (load-bearing for AC1, AC2, AC3, AC4)

- **MUST** call `completeStory({ targetRepoRoot, ref, sessionUlid })` internally on the `READY FOR MERGE` branch BEFORE returning to the caller. The call uses an internal function import from `./complete-story.js` — not the MCP `register.ts` tool surface. The default `role: "orchestrator"` is correct for this caller.
- **MUST** await the `completeStory` promise to resolution before returning. If `completeStory` throws, `processReviewerTranscript` MUST let the error propagate verbatim — no swallow, no wrap, no transform. The existing `register.ts` `DomainError` → `isError: true` wrapping serialises the error at the MCP boundary.
- **MUST** push the existing `reviewer verdict: READY FOR MERGE — story <ref> ready for merge gate` chat line into `chatLog` BEFORE calling `completeStory` (so the operator sees the verdict even if the move throws). The chat line ordering relative to the tool call is observable in the case of a thrown error.
- **MUST** include `completed: true` as a literal-typed field on the green-branch return shape. The field is exclusive to that branch; the three non-green branches MUST NOT include the field.
- **MUST NOT** call `completeStory` on the `BLOCKED` branch. The manifest stays in `in-progress/` with no `blocked_by` stamp (Story 4.3b passthrough semantics, unchanged).
- **MUST NOT** call `completeStory` on the reviewer-grammar-drift branch. The manifest stays in `in-progress/` with `blocked_by: "reviewer-grammar"` already stamped (Story 4.3b semantics, unchanged).
- **MUST NOT** call `completeStory` on the `NEEDS CHANGES` rework branch. The manifest stays in `in-progress/` with `rework_count` incremented (Story 4.3b semantics, unchanged).
- **NEVER** introduce a new error-wrapping layer around `completeStory`. The error model is already complete (`InProgressHandEditError`, `WrongClaimantError`, `ManifestNotFoundError`); shielding them at the `processReviewerTranscript` boundary would hide operator-recovery signals.

### SKILL.md prose invariants (load-bearing for AC1, AC2, AC3, AC5)

- **MUST** read the `completed` field on the `done-ready-for-merge` branch of the return-shape switch and treat its presence as the trigger to emit the informational chat line.
- **MUST** emit the verbatim chat-surface line `story <ref> moved to done — claiming next` (em dash U+2014, lowercase, no leading/trailing whitespace beyond a newline, no emoji) AFTER surfacing the returned `chatLog` and BEFORE the next `claimNextStory` call. The line is a fixed literal with one interpolation point (`<ref>`).
- **MUST** return to outer loop step 4 (`claimNextStory`) only after the chat line is emitted.
- **MUST NOT** invoke `completeStory` directly. The prose layer is not in the call path for the mutating step anymore. (This is enforceable structurally: `completeStory` is not in `allowed_tools`.)
- **MUST NOT** emit the `story <ref> moved to done — claiming next` line on any non-green branch (BLOCKED, grammar drift, handoff drift, or rework). The line is a successful-completion signal.
- **NEVER** mutate the manifest from the SKILL.md prose layer directly. The prose has no `writeManagedFile` in `allowed_tools` and never will under v1.
- **NEVER** modify `sprint-status.yaml`, source story files, `.git/` content, or any file outside `<targetRepoRoot>/.crew/state/`.

### Chat-line emission ownership table

Carries forward from Story 4.3b with one new row (the bottom row).

| Chat line (verbatim) | Owner (file emitting) |
|---|---|
| `handoff received — story <ref> — spawning generalist-reviewer subagent (clean context)` | `process-dev-transcript.ts` (unchanged) |
| `handoff grammar drift — story <ref> blocked. …` | `process-dev-transcript.ts` (unchanged) |
| `reviewer verdict: NEEDS CHANGES — re-spawning generalist-dev subagent (rework iteration <n>)` | `process-reviewer-transcript.ts` (unchanged) |
| `reviewer verdict: READY FOR MERGE — story <ref> ready for merge gate` | `process-reviewer-transcript.ts` (unchanged) |
| `reviewer verdict: BLOCKED — story <ref> awaiting human` | `process-reviewer-transcript.ts` (unchanged) |
| `reviewer grammar drift — story <ref> blocked. …` | `process-reviewer-transcript.ts` (unchanged) |
| `claiming <ref> — <title>` | `claimNextStory` (unchanged) |
| `spawning generalist-dev subagent (clean context)` | SKILL.md prose (unchanged) |
| `queue drained — to-do/ and in-progress/ are both empty. …` | `claimNextStory` (unchanged) |
| **`story <ref> moved to done — claiming next`** | **SKILL.md prose (NEW — emitted in response to `completed: true` flag returned by `processReviewerTranscript`)** |

The new line stays prose-emitted (not tool-emitted). Rationale: it is informational, not a side-effect; it announces the move that `processReviewerTranscript` has already performed. Prose-emission of informational lines is acceptable per `feedback_prose_mut_steps_need_seam.md` — only mutating steps need the tool-layer seam.

### `completeStory` call-site invariants

The `completeStory` MCP tool is unchanged by this story. Its behaviour, signature, error model, dist artefact, and unit tests are byte-identical before and after. The only new thing is a new internal caller (`process-reviewer-transcript.ts`).

- The tool's `inputSchema` declares `{ targetRepoRoot, ref, sessionUlid, role? }` with the first three required. `processReviewerTranscript` passes the first three and omits `role`.
- The tool raises `InProgressHandEditError` if the in-progress manifest has been hand-edited since claim, `WrongClaimantError` if `sessionUlid` does not match the manifest's `claimed_by`, `ManifestNotFoundError` if the ref does not exist in `in-progress/`. All three are `DomainError` subclasses and surface through `register.ts`'s `isError: true` wrapping path.
- The tool's atomic move via `moveBetweenStates` is single-syscall and crash-safe: either the manifest is in `in-progress/` (move not yet performed) or in `done/` (move complete). There is no intermediate state.
- The tool's `writeManagedFile` call with `role: "orchestrator"` is exempt from the FR14a canonical-fs-guard's check; orchestrator is the sanctioned umbrella role for prose-driven and tool-internal mutations.

### Manifest re-entry semantics

After `processReviewerTranscript` returns from the green branch, the manifest at `<targetRepoRoot>/.crew/state/done/<ref>.yaml` has `status: "done"` and the original `claimed_by` preserved. The story is invisible to subsequent `claimNextStory` calls. Identical to the original spec.

### Forward compatibility with Story 4.10b

Story 4.10b will replace `processReviewerTranscript`'s direct `completeStory` call with a gate-aware path: on `READY FOR MERGE`, it will either complete (low-tier auto-merge passed) or pause the manifest in `in-progress/` with a `paused_for: "medium-tier" | "high-tier"` stamp. The chat-line contract (`story <ref> moved to done — claiming next`) stays byte-identical for the green path; 4.10b adds new lines for the paused branches.

Story 4.3c locks in two invariants 4.10b will preserve:
- The `completeStory` call site lives in `processReviewerTranscript` (or in a successor tool called by it) — not in the SKILL.md prose. The seam stays at the tool layer.
- The chat line `story <ref> moved to done — claiming next` remains the user-surface signal that a story actually reached `done/`.

---

## Tasks / Subtasks

- [ ] **Task 1 — REVERT the original Task 1 (`allowed_tools` widening). (AC: 3(vii))**
  - [ ] 1.1 Open `plugins/crew/skills/start/SKILL.md`. Locate the front-matter `allowed_tools` array. If `completeStory` is present (from the original Story 4.3c implementation), REMOVE it. Final array equals exactly the Story 4.3b seven-tool set: `[getStatus, mintSessionUlid, claimNextStory, processDevTranscript, processReviewerTranscript, buildPersonaSpawnPrompt, Task]`.
  - [ ] 1.2 No other front-matter changes.

- [ ] **Task 2 — Extend `processReviewerTranscript` to call `completeStory` on the green branch. (AC: 1, 3(i), 3(ii))**
  - [ ] 2.1 Open `plugins/crew/mcp-server/src/tools/process-reviewer-transcript.ts`. Import `completeStory` from `./complete-story.js`.
  - [ ] 2.2 Update the return-type union: change the green-branch shape from `{ next: "done-ready-for-merge"; chatLog: string[] }` to `{ next: "done-ready-for-merge"; completed: true; chatLog: string[] }`. The `completed` field is literal-typed `true`.
  - [ ] 2.3 In the `if (sentinel === "READY FOR MERGE")` block: AFTER pushing the existing `reviewer verdict: READY FOR MERGE — …` line into `chatLog`, call `await completeStory({ targetRepoRoot, ref, sessionUlid })` (note: `sessionUlid` is currently in `opts` and is unused in the existing implementation — confirm it is still available on the options shape; it is, per the current `ProcessReviewerTranscriptOptions` interface).
  - [ ] 2.4 Update the return statement on the green branch to include `completed: true as const`.
  - [ ] 2.5 Do NOT add try/catch around `completeStory`. Errors propagate verbatim per the behavioural contract.
  - [ ] 2.6 Update the tool's TSDoc header to reflect the new responsibility: "On `READY FOR MERGE`: calls `completeStory` internally to atomically move the manifest to `done/` BEFORE returning. The prose layer reads the `completed: true` flag to confirm the move and emit its informational chat line." Cite this story's behavioural contract section.
  - [ ] 2.7 Verify no changes to the `NEEDS CHANGES`, `BLOCKED`, or grammar-drift branches.

- [ ] **Task 3 — Update the SKILL.md `# Inner cycle` prose to drive on `completed: true`. (AC: 1, 3(v), 3(vi))**
  - [ ] 3.1 Open `plugins/crew/skills/start/SKILL.md`. Locate the `## Reviewer spawn` subsection's step that switches on the `next` field returned by `processReviewerTranscript`.
  - [ ] 3.2 If the original Story 4.3c implementation added prose like `call completeStory({ targetRepoRoot, ref, sessionUlid })`, REMOVE that prose. The prose layer no longer invokes `completeStory`.
  - [ ] 3.3 On the `done-ready-for-merge` branch, the prose MUST instruct: (1) surface every entry of the returned `chatLog`; (2) confirm `completed: true` is present on the returned object (the prose should mention this flag by name as a structural anchor for AC3); (3) emit the verbatim chat line `story <ref> moved to done — claiming next` (em dash U+2014); (4) return to outer loop step 4 (`claimNextStory`).
  - [ ] 3.4 Update or add an absolute-modal invariant statement in the verdict-handling prose: `MUST NOT invoke completeStory directly — processReviewerTranscript performs the move internally on the done-ready-for-merge branch.` This anchors the new architecture in the prose for future readers.
  - [ ] 3.5 Update the file-header HTML comment to cite this story's revised behavioural contract: `<!-- Completion seam (revised): _bmad-output/implementation-artifacts/4-3c-call-completestory-after-ready-for-merge.md § Behavioural contract -->`. If the original Story 4.3c citation comment is present, replace it; otherwise append.
  - [ ] 3.6 Verify the inner-cycle prose still contains every Story 4.3b anchor — no regressions.

- [ ] **Task 4 — Update `# Failure modes` for the new propagation path. (AC: 3(viii))**
  - [ ] 4.1 In `plugins/crew/skills/start/SKILL.md`'s `# Failure modes` section, ensure there is a bullet or sentence noting that `completeStory`'s errors (`InProgressHandEditError`, `WrongClaimantError`, `ManifestNotFoundError`) can propagate THROUGH `processReviewerTranscript` on the green branch. If the original Story 4.3c implementation has wording about prose-layer `completeStory` calls, REWRITE to reflect that the call now lives inside `processReviewerTranscript`.
  - [ ] 4.2 Substring `completeStory` MUST still appear at least once in the failure-modes section.

- [ ] **Task 5 — Unit test for `processReviewerTranscript`'s new seam. (AC: 3(ii), 3(iii), 3(iv))**
  - [ ] 5.1 Locate or create the unit test file for `processReviewerTranscript` (likely `plugins/crew/mcp-server/src/tools/__tests__/process-reviewer-transcript.test.ts`).
  - [ ] 5.2 Add a test case: seed a tmpdir target repo with an in-progress manifest (use the existing seed helper from Story 4.3b's test suite), call `processReviewerTranscript` with a `READY FOR MERGE` transcript, assert: (a) `result.next === "done-ready-for-merge"`; (b) `result.completed === true`; (c) the in-progress manifest no longer exists on disk; (d) the done manifest exists with `status: "done"` and preserved `claimed_by`.
  - [ ] 5.3 Add a test case: same setup, call with a `BLOCKED` transcript, assert: (a) `result.next === "done-blocked-reviewer-verdict"`; (b) `"completed" in result === false`; (c) the in-progress manifest still exists; (d) no done manifest exists.
  - [ ] 5.4 Add a test case: same setup, call with a grammar-drift transcript (no `**Verdict: …**` line), assert: (a) `result.next === "done-blocked-reviewer-grammar"`; (b) `"completed" in result === false`; (c) the in-progress manifest exists with `blocked_by: "reviewer-grammar"` stamped; (d) no done manifest exists.
  - [ ] 5.5 Add a test case: same setup, call with a `NEEDS CHANGES` transcript, assert: (a) `result.next === "rework-dev"`; (b) `"completed" in result === false`; (c) the in-progress manifest exists with `rework_count` incremented; (d) no done manifest exists.
  - [ ] 5.6 Run `pnpm -C plugins/crew/mcp-server test process-reviewer-transcript` → must pass.

- [ ] **Task 6 — Update the inner-cycle integration test for the moved seam. (AC: 4)**
  - [ ] 6.1 Open `plugins/crew/mcp-server/src/tools/__tests__/inner-cycle.integration.test.ts`.
  - [ ] 6.2 In the existing `AC4 (4.3c)` describe blocks (added by the original implementation), REMOVE any test code that calls `completeStory` directly. The test should now drive only `claimNextStory` → `processDevTranscript` → `processReviewerTranscript` and assert that the side-effect of the third call moved the manifest to `done/`.
  - [ ] 6.3 Update the green-branch assertions to include `completed: true` on the returned object.
  - [ ] 6.4 Update the synthetic-chatLog assembly: the prose-simulation now appends the `story <ref> moved to done — claiming next` line only when `completed: true` is observed (test mirrors the actual prose contract).
  - [ ] 6.5 Update the negative-coverage assertions (BLOCKED branch and grammar-drift branch): assert the returned object does NOT have a `completed` field on these branches.
  - [ ] 6.6 Run `pnpm -C plugins/crew/mcp-server test inner-cycle.integration` → must pass.

- [ ] **Task 7 — Update the SKILL.md content-structure test. (AC: 3(v), 3(vi), 3(vii))**
  - [ ] 7.1 Open `plugins/crew/mcp-server/src/skills/__tests__/start-skill-content.test.ts`.
  - [ ] 7.2 Update the `allowed_tools` set-equality assertion BACK to the Story 4.3b seven-tool set: `{getStatus, mintSessionUlid, claimNextStory, processDevTranscript, processReviewerTranscript, buildPersonaSpawnPrompt, Task}`. If the original Story 4.3c implementation expanded this to eight, revert. AC3(vii).
  - [ ] 7.3 Keep the AC3(v) substring assertion: inner-cycle section contains the verbatim substring `story <ref> moved to done — claiming next` (em dash).
  - [ ] 7.4 Keep an AC3(vi) substring assertion: inner-cycle section contains `claimNextStory` (the loop-back step).
  - [ ] 7.5 REMOVE any assertion from the original implementation that the inner-cycle section contains `call completeStory({ targetRepoRoot, ref, sessionUlid })` — the prose no longer calls the tool directly.
  - [ ] 7.6 ADD an assertion that the inner-cycle section contains a `MUST NOT invoke completeStory` (or equivalent) substring, reflecting the new prose contract.
  - [ ] 7.7 Keep the failure-modes substring assertion on `completeStory` (AC3(viii)).
  - [ ] 7.8 Run `pnpm -C plugins/crew/mcp-server test start-skill-content` → must pass.

- [ ] **Task 8 — Tool-count assertions and full suite. (AC: all)**
  - [ ] 8.1 Confirm the tool count in `plugins/crew/mcp-server/tests/ask-mode-enforcement.test.ts`, `ask-skill.test.ts`, `get-team-snapshot.test.ts` is unchanged — Story 4.3c does NOT add or remove any registered MCP tools.
  - [ ] 8.2 Run `pnpm -C plugins/crew/mcp-server build` → must pass; commit any `dist/` changes per CLAUDE.md guidance.
  - [ ] 8.3 Run the full vitest suite: `pnpm -C plugins/crew/mcp-server test`. All tests pass.
  - [ ] 8.4 `canonical-fs-guard.test.ts` should pass unchanged.

- [ ] **Task 9 — User-surface smoke evidence for AC1 + AC5 (AC: 1, 5)**
  - [ ] 9.1 Operator-smoke procedure (executed by Jack or another live operator after Tasks 1–8):
    - Step a: From a clean Claude Code session, run `/plugin uninstall crew@crew` then `/plugin install crew@crew` against the freshly-built plugin tree.
    - Step b: Initialise a scratch target repo. Add `.crew/config.yaml` with `adapter: native`.
    - Step c: Run `/crew:hire` then `/crew:skip-hiring` to instantiate personas.
    - Step d: Seed two trivial source stories. Run `/crew:scan` to populate `to-do/`.
    - Step e: Run `/crew:start`. Observe through to natural termination.
    - Step f: Verify both `story <ref-A> moved to done — claiming next` and `story <ref-B> moved to done — claiming next` lines are emitted, the queue-drained line follows, and the on-disk state matches AC5(h).
  - [ ] 9.2 **Run the smoke procedure TWICE on fresh sessions.** Per `feedback_prose_mut_steps_need_seam.md`, a single-trial pass is insufficient evidence (the original prose-layer implementation passed Trial 1 and failed Trial 2 on the same code). The tool-layer seam should be deterministic — if the second trial fails, the seam is wrong and the dev agent MUST iterate.
  - [ ] 9.3 Paste verbatim chat-surface output from BOTH trials into `user_surface_verified` events in the ship-story run log, with `ac_refs: [AC1, AC5]`.

---

## Implementation strategy

### Why we moved the call from prose to tool (smoke evidence)

The original spec placed the `completeStory` call at the SKILL.md prose layer with an AC3 structural-anchor verifying the prose text was on disk. The operator-smoke on 2026-05-22 ran the flow twice; one trial honoured the contract, one trial silently skipped the call. Same code, two outcomes. The structural anchor proved the prose said the right thing; it did not prove Claude executed it. This is exactly the prose-determinism flake described in feedback memory `feedback_prose_mut_steps_need_seam.md`: informational prose can rely on structural anchors, but mutating side-effects must live in tools.

Moving the call into `processReviewerTranscript` removes the prose layer from the call path. There is no longer a prose step to skip — once the tool returns, the move has happened.

### Why `processReviewerTranscript` (not `claimNextStory` or a new tool)

- The completion signal originates with the reviewer verdict. The verdict parse already lives inside `processReviewerTranscript`. Co-locating the manifest move with the verdict parse is the smallest possible change that closes the determinism gap.
- `processReviewerTranscript` already mutates the manifest on two branches (`NEEDS CHANGES` increments `rework_count`; grammar drift stamps `blocked_by`). Adding a third mutation on the green branch is a symmetric extension of an existing write-surface, not a new write surface.
- A new wrapper tool would inflate the tool count without architectural benefit.
- Moving the call into `claimNextStory` would require it to know which ref the inner cycle just finished — an out-of-band channel the current shape doesn't support.

### Why `completeStory` is called as an internal function import, not through the MCP tool surface

- The MCP `register.ts` tool surface is the boundary between the SKILL.md prose layer (the LLM-driven harness) and the deterministic tool code. Internal function calls between tools do not need to traverse this boundary — they are pure Node imports, type-checked by TypeScript, no JSON serialisation, no permission gate.
- Since `processReviewerTranscript` is itself an MCP tool registered through `register.ts`, its callers (the SKILL.md prose) already have the necessary permission. The tool's internal use of `completeStory` is an implementation detail.
- Crucially: this means `completeStory` does NOT need to be added to the `/crew:start` SKILL.md `allowed_tools` array. The original spec's 7 → 8 widening is reversed.

### Why the chat line stays prose-emitted

The new `story <ref> moved to done — claiming next` line is informational (it announces a completed mutation, doesn't perform one). Prose-emission of informational lines is fine per the feedback memory — the determinism risk is on mutating steps, not on chat-line literals. The structural anchor in `start-skill-content.test.ts` catches drift in the literal.

An alternative would be for `processReviewerTranscript` to push the new line into its returned `chatLog`. That would be tool-emission. It works but has two drawbacks: (a) it couples the tool's return shape to the prose layer's chat surface, requiring tool churn if the line ever changes; (b) it's redundant with the `completed: true` flag that already signals the move. Keeping prose responsible for informational lines and tools responsible for mutations preserves the clean split.

### Why the new `completed: true` flag (not just the existing `next` field)

The `next` field carries the discriminated-union tag for the prose-layer switch. Adding `completed: true` as a separate field is a redundant signal that explicitly confirms "the side-effect ran." Two reasons:

- It anchors the prose-layer contract: the prose layer's MUST is to emit the chat line when `completed === true`, not when `next === "done-ready-for-merge"`. If a future refactor splits the green branch into multiple sub-shapes (e.g. 4.10b's gated-vs-immediate), `completed` stays the operator-observable contract.
- It future-proofs against 4.10b: when the gate is added, some green-verdict outcomes will NOT complete the manifest (paused for medium/high tier). Those return shapes can use `next: "done-ready-for-merge"` but omit `completed`, signalling to the prose that the manifest is still in flight.

### Risks and mitigations

- **Risk: the existing Story 4.3b tests assumed `processReviewerTranscript` does not move the manifest on the green branch.** Mitigation: Story 4.3b's tests on the BLOCKED, grammar-drift, and NEEDS CHANGES branches are unchanged. The green-branch test will need updating; that's part of Task 6.
- **Risk: an upstream caller of `processReviewerTranscript` (other than the SKILL.md prose) does not expect the side-effect.** Mitigation: there is only one upstream caller in the codebase — the `/crew:start` skill — and it is updated in Task 3. The MCP tool-surface contract is widened to include the new side-effect; the existing schema's `inputSchema` and `outputSchema` (if any) need a corresponding update.
- **Risk: the em-dash character in the chat line gets normalised.** Mitigation: AC3(v) verbatim substring assertion (unchanged from original).
- **Risk: the second smoke trial fails like 2026-05-22.** Mitigation: that flake was a prose-determinism failure. The tool-layer seam removes the prose step entirely — the determinism risk surface is now confined to the deterministic Node code path. If the second trial fails anyway, something else is wrong (e.g. `completeStory` throwing on a precondition the test fixture didn't hit) and the dev agent must investigate.

---

## Dev Notes

### Files this story touches

**Modified files:**
- `plugins/crew/mcp-server/src/tools/process-reviewer-transcript.ts` — add `completeStory` internal call on the `READY FOR MERGE` branch; add `completed: true` to the green-branch return shape; update TSDoc and behavioural-contract citation. **This file IS being modified now (reversal from original spec).**
- `plugins/crew/skills/start/SKILL.md` — revert front-matter `allowed_tools` to the seven-tool set; rewrite the verdict-handling prose to drive on `completed: true` and emit the informational chat line; update file-header citation; update `# Failure modes` wording.
- `plugins/crew/mcp-server/src/tools/__tests__/process-reviewer-transcript.test.ts` (existing or new) — unit tests for the seam (AC3(ii)–(iv)).
- `plugins/crew/mcp-server/src/tools/__tests__/inner-cycle.integration.test.ts` — remove direct `completeStory` calls from the test code; add `completed: true` assertions on green-branch returns; update synthetic-chatLog assembly.
- `plugins/crew/mcp-server/src/skills/__tests__/start-skill-content.test.ts` — revert `allowed_tools` set-equality to seven-tool set; update prose-anchor assertions per Task 7.

**Locked / untouched (must not be modified by this story):**
- `plugins/crew/mcp-server/src/tools/complete-story.ts` — Story 4.1 LOCKED. Byte-identical before and after.
- `plugins/crew/mcp-server/src/tools/register.ts` — `completeStory` already registered; no signature or registration changes.
- `plugins/crew/mcp-server/src/tools/process-dev-transcript.ts` — unchanged.
- `plugins/crew/mcp-server/src/tools/claim-next-story.ts` — unchanged.
- `plugins/crew/mcp-server/src/skills/handoff-parser.ts` and `verdict-parser.ts` — pure parsers, unchanged.
- `plugins/crew/catalogue/generalist-dev.md`, `generalist-reviewer.md` — persona bodies, unchanged.
- `plugins/crew/catalogue/permissions/generalist-dev.yaml`, `generalist-reviewer.yaml` — subagent permission specs, unchanged.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — DO NOT EDIT.

**New files:**
- None. (Possibly a new test file if `process-reviewer-transcript.test.ts` does not already exist; either way it's the standard sibling location.)

**Deleted files:**
- None.

### Why we reversed the "do NOT modify `process-reviewer-transcript.ts`" decision

The original Story 4.3c spec explicitly prohibited modifying `process-reviewer-transcript.ts`, on the grounds that "keeping the call in the prose preserves the one-tool-one-responsibility split Story 4.3b established." That decision was right in principle but wrong in practice. The 2026-05-22 operator-smoke flake (one of two trials silently skipping the prose call) demonstrated that prose-level MUSTs are non-deterministic for mutating side-effects. The "one-tool-one-responsibility" split is preserved by `completeStory` remaining a separate tool with its own atomic move primitive — `processReviewerTranscript` now COMPOSES `completeStory` rather than duplicating its logic. Composition is the right pattern; the original spec's choice between prose-composes-tools and tools-compose-tools defaulted to the former and got bitten by determinism. The revision chooses the latter for the mutating step.

See `feedback_prose_mut_steps_need_seam.md` for the broader lesson and the rule going forward: **mutating side-effects in multi-step skill flows must live behind a tool-layer seam.**

### Previous story intelligence (Story 4.3b)

Story 4.3b's inner-cycle architecture is the canonical reference. Key takeaways:

- Story 4.3b's `processReviewerTranscript` already mutates the manifest on two branches (`NEEDS CHANGES`, grammar drift). Adding a third mutation on the green branch is a symmetric extension.
- Story 4.3b's `allowed_tools` is exactly `[getStatus, mintSessionUlid, claimNextStory, processDevTranscript, processReviewerTranscript, buildPersonaSpawnPrompt, Task]`. Story 4.3c STAYS at this seven-tool set (reverting the original 4.3c widening).
- Story 4.3b's `start-skill-content.test.ts` and `inner-cycle.integration.test.ts` are the test scaffolding Story 4.3c extends.
- Story 4.3b's behavioural contract for chat-line ownership is the canonical reference for the new line's emission site (the SKILL.md prose layer, for informational lines).

### Standards-doc reference

`docs/standards.md` (Story 1.3's parser scope) — Story 4.3c does NOT introduce any new standards-criteria checks.

### Project Structure Notes

The architectural shift is small: one MCP tool gains one new internal-function call; the prose layer loses one direct invocation and gains one switch on a new return-shape field. No new abstractions, no new files, no new dependencies. The shift is in WHERE the mutation lives, not WHAT it does.

### References

- `_bmad-output/planning-artifacts/epics/epic-4-dev-review-loop-the-engineering-heart.md § Story 4.3c` — source story brief.
- `_bmad-output/implementation-artifacts/4-3b-harness-task-spawn-seam-for-rundevsession.md § Behavioural contract` — inner-cycle architectural contract.
- `_bmad-output/implementation-artifacts/4-2-start-skill-and-per-story-dev-subagent-spawn.md § Behavioural contract` — outer-loop architectural contract.
- `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md § FR19` — atomic complete semantics.
- `plugins/crew/docs/user-surface-acs.md` — rubric for `(user-surface)` AC tagging.
- `plugins/crew/mcp-server/src/tools/complete-story.ts` — the LOCKED MCP tool.
- `plugins/crew/mcp-server/src/tools/process-reviewer-transcript.ts` — the tool this story EXTENDS.
- `plugins/crew/skills/start/SKILL.md` — the prose file this story trims.
- Feedback memory `feedback_prose_mut_steps_need_seam.md` — the lesson driving the architectural reversal.

## Dev Agent Record

### Agent Model Used

(to be filled by dev agent during re-implementation)

### Debug Log References

Original Story 4.3c implementation: Tasks 1–7 completed against the prose-layer architecture; all vitest tests passed; AC3 structural anchors verified. Operator-smoke on 2026-05-22 ran the flow twice; one trial honoured the contract, one silently skipped the `completeStory` prose call. Status reverted from `review` to `revised` and the spec rewritten with a tool-layer seam.

### Completion Notes List

(to be filled by dev agent during re-implementation; previous implementation's notes are superseded by this revision)

### File List

(to be filled by dev agent during re-implementation)
