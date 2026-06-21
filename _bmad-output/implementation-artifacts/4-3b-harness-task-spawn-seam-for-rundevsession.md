# Story 4.3b: Harness-side `Task`-spawn seam for `runDevSession`

story_shape: user-surface

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin maintainer driving `/crew:start` in production**,
I want **the `/crew:start` SKILL.md prose layer to own the `Task`-tool spawn of dev and reviewer subagents (using prompts and verdicts computed by pure MCP tools), rather than `runDevSession` attempting to spawn subagents itself across the MCP wire**,
so that **the inner dev↔reviewer cycle actually runs in a real Claude Code session — today's `runDevSession` ships with a stub `taskSpawnWithTranscript` (closures cannot cross MCP), so every claimed story silently fails handoff parsing and gets stamped `blocked_by: handoff-grammar`, making the user-surface ACs Stories 4.2 and 4.3 verified through dependency injection inert in any live operator session.**

### What this story is, in one sentence

Move the `Task`-tool spawn responsibility out of the MCP server and into the `/crew:start` SKILL.md prose: the prose calls a pure MCP tool to get the next dev prompt, invokes Claude Code's built-in `Task` tool itself with that prompt, captures the dev's final transcript verbatim, hands it to a new pure MCP tool `processDevTranscript` (which parses, mutates the manifest, and returns either a reviewer prompt or a terminal verdict), then — if a reviewer is to spawn — repeats the pattern with `Task` again and a second pure MCP tool `processReviewerTranscript`. The do-everything `runDevSession` tool is unregistered. Tool count moves 19 → 21 (drop `runDevSession`; add `claimNextStory`, `processDevTranscript`, `processReviewerTranscript`).

### What this story fixes (and why it needs its own story)

Story 4.3 (PR #103) shipped `runDevSession` as a single MCP-tool entry point that bundled the outer claim-loop and the inner dev↔reviewer cycle. The seam for the `Task` spawn was an injectable parameter `taskSpawnWithTranscript` on the in-process function signature. That works for vitest (the test passes a closure that returns a scripted transcript) but breaks across the MCP wire: MCP tool inputs are JSON-only — no closures, no callables. The production wiring at `plugins/crew/mcp-server/src/tools/run-dev-session.ts:73-80` falls through to a stub that returns `{ transcript: "" }`, which causes every dev subagent's "transcript" to be empty, which causes `parseHandoff` to return `{ ok: false, reason: "empty" }`, which stamps `blocked_by: handoff-grammar` on every claimed story. The PR #103 reviewer flagged this as Info-2 and the Epic 4 carry-forward retro confirmed it as a follow-up.

Three concrete gaps:

- **The MCP tool cannot spawn subagents.** Only the Claude Code harness (via the `Task` tool in skill/prose layer) can spawn a subagent. The MCP layer is JSON-RPC over stdio and has no access to harness primitives.
- **The skill prose currently delegates everything to one MCP call.** SKILL.md says "call `runDevSession`; print its `chatLog`" — the prose holds no spawn logic, so there is no place for `Task` to be invoked.
- **Unit-test pass-rate is uncoupled from production.** The existing AC4 vitest in Story 4.3 passes because the test injects a fake spawn. The integration tests do NOT exercise the production wiring path, so the bug is invisible in CI.

This story restructures the seam so the SKILL.md prose IS the loop driver — invoking `Task` directly with prompts the MCP layer computes, and feeding captured transcripts back to the MCP layer for parsing and manifest mutation. The MCP layer becomes a set of pure transcript-processors with no spawn responsibility.

### This story does NOT

- (a) Touch `_bmad-output/implementation-artifacts/sprint-status.yaml` or any other file under `_bmad-output/implementation-artifacts/`. The orchestrator owns status transitions. The dev agent MUST NOT edit any status / state file when implementing this story.
- (b) Change the locked handoff phrase grammar, the verdict sentinel grammar, the rework-count semantics, or the `blocked_by` taxonomy. Story 4.3 owns those contracts; Story 4.3b keeps them byte-identical. The `parseHandoff` / `parseVerdict` modules in `plugins/crew/mcp-server/src/skills/` are imported by the new tools verbatim — no edits to their behaviour.
- (c) Change the chat-surface lines (AC1/AC2/AC3 from Story 4.3, plus the `BLOCKED` passthrough and grammar-drift lines). The verbatim strings move from `dev-reviewer-cycle.ts` into the new transcript-processor tools, but their text is unchanged. Operator-observable behaviour is identical.
- (d) Implement `git push`, `gh pr create`, risk-tier classification, auto-merge, the yield protocol, telemetry events, or any of the downstream Epic 4 stories. Those land in 4.4 / 4.9 / 4.10b / 4.11 / 4.12.
- (e) Re-implement `claimStory`, `listClaimableTodos`, `buildPersonaSpawnPrompt`, the workspace resolver, `parseExecutionManifest`, `parseHandoff`, `parseVerdict`, or `writeManagedFile`. All shipped; this story re-wires them.
- (f) Modify the catalogue persona bodies (`generalist-dev.md`, `generalist-reviewer.md`) or the team-instantiated copies under `<targetRepoRoot>/team/<role>/PERSONA.md`. The locked-phrase contract Story 4.3 pinned on persona files is the contract this story consumes.
- (g) Move the outer claim-loop (the alphabetical scan of `to-do/`, the `claimStory` call, the queue-drained line). That stays as plain TypeScript inside the MCP layer — see § Implementation strategy for where exactly. The story focuses on the inner cycle's spawn-and-process responsibility split.
- (h) Add a recovery-from-blocked path for grammar-drift events. The current v1 recovery (operator hand-edits the manifest to clear `blocked_by`, re-runs `/crew:start`) is unchanged. Story 5.1 will retrofit the proper `blocked/` directory path.
- (i) Add a `max_rework_count` cap or any rework-loop guardrail. The unbounded rework loop semantics from Story 4.3 carry forward unchanged.
- (j) Add a separate prompt-builder MCP tool. The existing `buildPersonaSpawnPrompt` is sufficient — the SKILL.md prose calls it directly to compute dev / reviewer prompts. (We considered a new `buildDevPrompt` / `buildReviewerPrompt` pair to encapsulate role selection in the tool name; rejected because `buildPersonaSpawnPrompt` already takes `role` as an argument, and adding wrappers would inflate the allowlist without adding value.)
- (k) Persist the dev / reviewer transcript anywhere on disk. Transcripts flow from `Task` (return value) → SKILL.md prose (in-memory string) → `processDevTranscript` / `processReviewerTranscript` (MCP input argument) → discarded. There is no transcript log file in v1; Story 4.12's telemetry may add `agent.invoke` events that include transcript-length metadata, but the transcript body is not stored.
- (l) Add a `rework_iteration` history list to the manifest. Only the integer counter `rework_count` is mutated. Iteration-by-iteration audit lives in operator chat scrollback only (Story 4.12 telemetry will give us a JSONL trail later).
- (m) Persist `chatLog` anywhere. The MCP tools return chat lines for each call; the SKILL.md prose surfaces them to the operator as it goes. There is no aggregated session-level chat log file.
- (n) Touch the dev-subagent or reviewer-subagent permission specs (`plugins/crew/catalogue/permissions/generalist-dev.yaml`, `generalist-reviewer.yaml`). Those specs allow the subagent to invoke MCP tools it needs to do its work (e.g. `claimStory`, `completeStory`, `readSourceStory`); they do NOT need to include the new `processDevTranscript` / `processReviewerTranscript` tools — those are `/crew:start`-prose-only.
- (o) Re-architect the SKILL.md prose's relationship with the outer claim-loop. The outer loop (claim → spawn dev → process → maybe spawn reviewer → process → loop) is the inner cycle's responsibility; the OUTER claim-loop (next claimable ref, queue-drained termination) stays in TypeScript. The SKILL.md prose drives the inner cycle and calls a thin MCP tool (`claimNextStory`, see § Implementation strategy) that wraps the outer loop's single-iteration logic.

---

## Acceptance Criteria

> AC1, AC2, AC5 are user-surface per `plugins/crew/docs/user-surface-acs.md` rubric. AC3 is the MCP API refactor — no user-surface tag (only MCP-tool names and TypeScript signatures). AC4 is the integration test — no user-surface tag. AC6 is the deterministic content-structure check for SKILL.md anchors; it inspects on-disk source files only.

**AC1 (user-surface):**
**Given** a target repo with at least one ready story in `.crew/state/to-do/` and the operator running `/crew:start` in a real Claude Code session (NOT a vitest fixture),
**When** the inner cycle reaches the spawn-dev step,
**Then** (a) the SKILL.md prose calls `buildPersonaSpawnPrompt({ targetRepoRoot, role: "generalist-dev" })` to obtain the dev system prompt, (b) the SKILL.md prose invokes Claude Code's built-in `Task` tool with that prompt verbatim — no paraphrase, no truncation, no LLM-side rewording — and an `initial_context` block carrying `ref`, `title`, `sessionUlid`, `targetRepoRoot`, `manifestPath`, and (if rework) `rework_iteration`; (c) the dev subagent appears in the Claude Code Task-tool UI as a new clean-context subagent isolated from the calling `/crew:start` session; (d) when the dev subagent terminates, the SKILL.md prose captures its final transcript (the subagent's last message, returned by the `Task` tool) and passes it verbatim — full string, no summarisation, no editing — into `processDevTranscript({ targetRepoRoot, sessionUlid, ref, devTranscript })`; (e) the chat surface emits the verbatim Story 4.3 AC1 line `handoff received — story <story-id> — spawning generalist-reviewer subagent (clean context)` IF and only if `processDevTranscript` returns `{ next: "spawn-reviewer", reviewerPrompt, chatLog: [...] }`. _(FR26, FR27; closes Story 4.3 user-surface AC1 in production)_

<!-- User-surface: AC1 names `/crew:start` (rubric i) and references the Task-tool UI surface (rubric iv) plus the verbatim chat line the operator reads. The dependencies (Task tool, processDevTranscript, buildPersonaSpawnPrompt) are all callable from day-one of merge — no deferred caller. This AC is the live version of Story 4.3's AC1 which only verified via injected closures. -->

**AC2 (user-surface):**
**Given** the dev subagent has terminated and emitted the verbatim locked handoff phrase, and `processDevTranscript` has returned `{ next: "spawn-reviewer", reviewerPrompt }`,
**When** the SKILL.md prose continues the inner cycle,
**Then** (a) the prose invokes Claude Code's `Task` tool with the `reviewerPrompt` returned by `processDevTranscript` — verbatim, no paraphrase, no edits — and an `initial_context` block carrying `ref`, `title`, `sessionUlid`, `targetRepoRoot`; (b) the reviewer subagent appears in the Claude Code Task-tool UI as a new clean-context subagent isolated from both the calling `/crew:start` session AND the dev subagent's context; (c) when the reviewer terminates, the SKILL.md prose captures its final transcript and passes it verbatim into `processReviewerTranscript({ targetRepoRoot, sessionUlid, ref, manifestPath, reviewerTranscript })`; (d) on a `NEEDS CHANGES` verdict the tool returns `{ next: "rework-dev", devPrompt, reworkIteration, chatLog: [...] }` and the chat surface emits the verbatim Story 4.3 AC2 line `reviewer verdict: NEEDS CHANGES — re-spawning generalist-dev subagent (rework iteration <n>)`; the SKILL.md prose then re-invokes `Task` with the new `devPrompt` (which already carries `rework_iteration` in its initial-context block) and loops back to step (d) of AC1; (e) on a `READY FOR MERGE` verdict the tool returns `{ next: "done-ready-for-merge", chatLog: [...] }` and the chat surface emits `reviewer verdict: READY FOR MERGE — story <story-id> ready for merge gate`; (f) on a `BLOCKED` verdict the tool returns `{ next: "done-blocked-reviewer-verdict", chatLog: [...] }` and the chat surface emits `reviewer verdict: BLOCKED — story <story-id> awaiting human`. _(FR26, FR27, FR28; closes Story 4.3 user-surface AC2 in production)_

<!-- User-surface: AC2 names `/crew:start` (rubric i), the Task-tool UI surface (rubric iv), AND the verbatim chat lines (rubric iv) for all three reviewer-verdict branches. All sub-clauses are reachable in a live session without a deferred caller. -->

**AC3:**
**Given** the refactored MCP surface,
**When** the server registers its tools at startup,
**Then** (a) `runDevSession` is NOT registered (the tool is unregistered from `plugins/crew/mcp-server/src/tools/register.ts`); (b) three new MCP tools are registered: `claimNextStory`, `processDevTranscript`, and `processReviewerTranscript`; (c) total tool count is exactly **21** (Story 4.3 baseline 19, minus `runDevSession`, plus `claimNextStory`, `processDevTranscript`, `processReviewerTranscript`); (d) `processDevTranscript` takes `{ targetRepoRoot, sessionUlid, ref, devTranscript }` and returns one of: `{ next: "spawn-reviewer", reviewerPrompt: string, chatLog: string[] }`, `{ next: "done-blocked-handoff-grammar", chatLog: string[] }`, or — if and only if the dev transcript captured does not contain the handoff phrase as its last non-empty line but DOES carry a recognisable "done, no review yet" signal (see § Behavioural contract for the fallback case) — `{ next: "done-handoff-but-no-review-yet", chatLog: string[] }` (this last branch is reserved for forward compatibility and is NOT returnable from v1 — the v1 tool returns only the first two shapes; the type is declared for ABI stability so Story 5.x can extend without bumping the schema); (e) `processReviewerTranscript` takes `{ targetRepoRoot, sessionUlid, ref, manifestPath, reviewerTranscript }` and returns one of: `{ next: "rework-dev", devPrompt: string, reworkIteration: number, chatLog: string[] }`, `{ next: "done-ready-for-merge", chatLog: string[] }`, `{ next: "done-blocked-reviewer-verdict", chatLog: string[] }`, or `{ next: "done-blocked-reviewer-grammar", chatLog: string[] }`; (f) neither tool spawns subagents, performs git operations, calls `gh`, or writes to any path outside the in-progress manifest for `ref` — pure transcript-in / verdict-out functions with one bounded I/O surface (the manifest read/write for `rework_count` and `blocked_by`). _(Architecture cleanup; FR-new)_

<!-- Not user-surface: AC3 names MCP tool names and TypeScript signatures. The operator never types `processDevTranscript`. -->

**AC4 (integration):**
vitest covers the existing Story 4.3 AC4 branches (happy / rework / grammar-drift / two-iteration rework) against the refactored API, plus new branches specific to the spawn-seam refactor:

- (a) **Happy handoff (refactored):** the test composes the inner cycle by calling `processDevTranscript` with a scripted dev transcript ending in the verbatim handoff phrase, asserts the return shape is `{ next: "spawn-reviewer", reviewerPrompt, chatLog }`, asserts `reviewerPrompt` equals what `buildPersonaSpawnPrompt({ role: "generalist-reviewer" })` would return for the test fixture, then calls `processReviewerTranscript` with a scripted reviewer transcript ending `**Verdict: READY FOR MERGE**`, asserts the return shape is `{ next: "done-ready-for-merge", chatLog }`, asserts the manifest on disk has NO `rework_count` and NO `blocked_by`, asserts the cumulative `chatLog` across both calls contains the Story 4.3 AC1 line and the `READY FOR MERGE` passthrough line verbatim.

- (b) **Rework loop (refactored):** given a transcript ending in `**Verdict: NEEDS CHANGES** [...]` and a manifest with `rework_count: 0`, calling `processReviewerTranscript` returns `{ next: "rework-dev", devPrompt: <buildPersonaSpawnPrompt({ role: "generalist-dev" }).systemPrompt verbatim>, reworkIteration: 1, chatLog: [...] }`. The manifest on disk shows `rework_count: 1`. The `chatLog` contains the verbatim `reviewer verdict: NEEDS CHANGES — re-spawning generalist-dev subagent (rework iteration 1)` line. The unit test MUST NOT assert anything about an `initial_context` block — that block is assembled by SKILL.md prose at `Task`-invocation time and is observable only in the integration test (AC4 happy/rework integration scenarios) or operator smoke (AC5). Then: second `processDevTranscript` call with a fresh handoff transcript → reviewer prompt. Second `processReviewerTranscript` call with a `READY FOR MERGE` transcript → `{ next: "done-ready-for-merge", chatLog }`, manifest still reads `rework_count: 1`, AC2 verbatim line appears with `<n>=1`.

- (c) **Grammar drift block (refactored):** first `processDevTranscript` call with a paraphrased dev transcript → assert return is `{ next: "done-blocked-handoff-grammar", chatLog }`, assert the on-disk manifest now reads `blocked_by: "handoff-grammar"`, assert the chat log contains the verbatim AC3 grammar-drift line from Story 4.3, assert `processReviewerTranscript` is NOT called.

- (d) **Two-iteration rework convergence (refactored):** three `processDevTranscript` calls and three `processReviewerTranscript` calls scripted to NEEDS CHANGES → NEEDS CHANGES → READY FOR MERGE; final manifest `rework_count: 2`. AC2 chat line appears twice with `<n>=1` then `<n>=2`.

- (e) **Reviewer grammar drift (refactored):** `processReviewerTranscript` called with a reviewer transcript whose last non-empty line is `Verdict: APPROVED` (unrecognised sentinel) → assert return is `{ next: "done-blocked-reviewer-grammar", chatLog }`, manifest now reads `blocked_by: "reviewer-grammar"`, the verbatim reviewer-grammar-drift line is in the chat log.

- (f) **Reviewer BLOCKED passthrough (refactored):** reviewer transcript ending `**Verdict: BLOCKED** [under-specified story]` → assert return is `{ next: "done-blocked-reviewer-verdict", chatLog }`, manifest is NOT mutated (no `blocked_by`, no `rework_count`), the chat log contains the verbatim BLOCKED passthrough line.

- (g) **Tool count:** assert the registered MCP tool list contains exactly **21** entries and contains `claimNextStory`, `processDevTranscript`, and `processReviewerTranscript` but does NOT contain `runDevSession`.

**AC5 (user-surface):**
**Given** an operator running `/crew:start` against a scratch repo with at least one ready story, the hired `generalist-dev` and `generalist-reviewer` personas, and a real Claude Code session,
**When** the operator observes the live session,
**Then** they see (a) the Story 4.2 outer-loop lines (claim, spawning generalist-dev, etc.) verbatim, (b) the dev subagent appears in the Task-tool UI panel and runs to completion, (c) on a happy handoff, the verbatim `handoff received — story <story-id> — spawning generalist-reviewer subagent (clean context)` line appears in chat, (d) the reviewer subagent then appears in the Task-tool UI panel as a new clean-context subagent, (e) the reviewer's verdict line appears verbatim in chat (`READY FOR MERGE`, `NEEDS CHANGES` with rework iteration, or `BLOCKED` passthrough — whichever the live reviewer emits), (f) the manifest at `<targetRepoRoot>/.crew/state/in-progress/<story-id>.yaml` reflects the live verdict — `rework_count` incremented on rework, `blocked_by` stamped on grammar drift, unchanged on `READY FOR MERGE`. The operator MUST NOT see the empty-transcript bug (every story stamped `blocked_by: handoff-grammar`) that ships with Story 4.3 pre-refactor. _(closes the carry-forward from Epic 3 retro / PR #103 Info-2)_

<!-- User-surface: AC5 is the live-session smoke test. The operator OBSERVES the Task-tool UI (rubric iv), the chat-surface lines (rubric iv), and the resulting manifest on disk (rubric iii — a path the docs may instruct the operator to inspect during the smoke). This is the AC that catches the Story 4.3 production-vs-test gap; it is the reason this story exists. -->

**AC6:**
**Given** the new files added by this story —
- `plugins/crew/mcp-server/src/tools/process-dev-transcript.ts`
- `plugins/crew/mcp-server/src/tools/process-reviewer-transcript.ts`

— and the rewritten skill file `plugins/crew/skills/start/SKILL.md` and the updated `plugins/crew/mcp-server/src/tools/register.ts`,
**When** each file is inspected by content-structure assertions,
**Then** the following anchors MUST be present:

- (i) `plugins/crew/skills/start/SKILL.md` front-matter `allowed_tools` array, parsed as an unordered set, equals exactly `{getStatus, mintSessionUlid, claimNextStory, processDevTranscript, processReviewerTranscript, buildPersonaSpawnPrompt, Task}` — set-equality, order-agnostic. `Task` is Claude Code's built-in subagent-spawn tool; it MUST be listed for the prose to invoke it. The assertion catches both a missing entry and any unexpected additional entry.
- (ii) `plugins/crew/skills/start/SKILL.md` contains a `# Inner cycle: dev → reviewer → rework` section (H1 `#` or H2 `##` both accepted via regex).
- (iii) The same section contains the verbatim substring `invoke the Task tool with the devPrompt returned by buildPersonaSpawnPrompt` (the dev-spawn invocation site anchor — prose may surround it with other words but this substring MUST appear).
- (iv) The same section contains the verbatim substring `invoke the Task tool with the reviewerPrompt returned by processDevTranscript` (the reviewer-spawn invocation site anchor).
- (v) The same section contains the verbatim substring `pass the captured devTranscript to processDevTranscript` (the dev-transcript handoff anchor).
- (vi) The same section contains the verbatim substring `pass the captured reviewerTranscript to processReviewerTranscript` (the reviewer-transcript handoff anchor).
- (vii) The same section contains an absolute-modal invariant statement to the effect of `MUST pass the transcript verbatim — no summarisation, no editing` (substring match on `MUST pass the transcript verbatim`).
- (viii) The `# Failure modes` section names `HandoffGrammarDriftError` AND `blocked_by: handoff-grammar` (preserved from Story 4.3) AND adds a new bullet for `ReviewerGrammarDriftError` / `blocked_by: reviewer-grammar` (preserved from Story 4.3 — anchor MUST remain).
- (ix) `process-dev-transcript.ts` contains the verbatim string `re-spawning generalist-dev subagent (rework iteration` is NOT in this file (the rework chat line is emitted by `process-reviewer-transcript.ts` — see § Behavioural contract for the line-emission ownership table) and `process-dev-transcript.ts` DOES contain the verbatim string `handoff received — story` AND the verbatim string `handoff grammar drift — story`.
- (x) `process-reviewer-transcript.ts` contains the verbatim string `re-spawning generalist-dev subagent (rework iteration` AND the verbatim string `reviewer verdict: READY FOR MERGE` AND the verbatim string `reviewer verdict: BLOCKED` AND the verbatim string `reviewer grammar drift — story`.
- (xi) `plugins/crew/mcp-server/src/tools/register.ts` contains zero occurrences of the literal `"runDevSession"` (set-equality assertion that the tool name does not appear anywhere in the registration file — the tool is gone, not just commented out).

<!-- AC6 inspects internal source files and skill front-matter. Not user-surface (no slash command, no CLI command, no Claude Code UI element). The anchors make the user-surface ACs (AC1, AC2, AC5) mechanically checkable without an operator smoke pass; the smoke pass is still required by the ship gate per AC5, but AC6 ensures the file contents that drive AC1 / AC2 are deterministically present. -->

---

## Behavioural contract

The `/crew:start` skill's inner cycle (dev → reviewer → rework) is now divided across three layers: (i) the SKILL.md prose, which owns `Task`-tool spawn responsibility; (ii) the two pure MCP tools `processDevTranscript` and `processReviewerTranscript`, which own parsing, verdict computation, and manifest mutation; (iii) the helper `buildPersonaSpawnPrompt`, which owns prompt assembly. The dev/reviewer persona files themselves (and their locked-phrase grammar) are untouched — Story 4.3's pinning carries forward.

Both new tool source files MUST cite this section by full path (`_bmad-output/implementation-artifacts/4-3b-harness-task-spawn-seam-for-rundevsession.md § Behavioural contract`) in TSDoc at the top of the file. The SKILL.md prose MUST cite this section as an HTML comment in the file header so a future SKILL.md editor can find the source of the invariants.

### SKILL.md prose invariants (load-bearing for AC1, AC2, AC5)

The SKILL.md prose's `# Inner cycle: dev → reviewer → rework` section is a user-surface contract. The following invariants govern what the prose MUST and MUST NOT do.

- **MUST** invoke Claude Code's built-in `Task` tool (NOT a custom MCP tool, NOT a shell command, NOT a direct in-process function call) to spawn both the dev subagent AND the reviewer subagent. The `Task` tool is the only sanctioned subagent-spawn surface in v1 — its clean-context guarantee (FR24, FR27) is structural.
- **MUST** use the system prompt returned by the prompt-source tool VERBATIM. The prose MUST NOT paraphrase, truncate, edit, summarise, or "improve" the prompt text. For the dev spawn the source is `buildPersonaSpawnPrompt({ role: "generalist-dev" })`; for a fresh reviewer spawn the source is `processDevTranscript`'s `reviewerPrompt` return field; for a rework dev spawn the source is `processReviewerTranscript`'s `devPrompt` return field. (The two transcript-processors call `buildPersonaSpawnPrompt` internally so the prose never needs to choose which builder to call — the next prompt is always handed to the prose by the tool that just decided what should happen.)
- **MUST** pass the dev's final transcript (the `Task` tool's returned subagent final message) VERBATIM as the `devTranscript` argument of `processDevTranscript`. The prose MUST NOT summarise the transcript, MUST NOT trim leading/trailing context, MUST NOT extract "just the handoff line" — the full final-message string is the contract. (Drift cases like "the dev emitted the handoff phrase mid-transcript and then said something else" are detectable only if the parser sees the full transcript; trimming would silently corrupt the grammar-drift detection.)
- **MUST** pass the reviewer's final transcript VERBATIM as the `reviewerTranscript` argument of `processReviewerTranscript` — same rationale.
- **MUST** invoke the next tool in the chain ONLY when the previous tool's return shape indicates the next step. If `processDevTranscript` returns `{ next: "done-blocked-handoff-grammar", chatLog }`, the prose MUST NOT then invoke `Task` for the reviewer — the next action is "surface the chatLog, return to the outer claim-loop." The `next` field of each tool's return is the canonical control-flow signal.
- **MUST** surface every entry of the returned `chatLog` to the operator in order, before any subsequent tool call. The verbatim chat lines are the user-surface signal — buffering them or re-ordering them silently degrades the operator-observable contract that AC1 / AC2 / AC5 pin.
- **MUST NOT** invoke `Task` with a prompt the prose layer composes itself. The prompt MUST come from one of the three sanctioned sources (`buildPersonaSpawnPrompt` for the initial dev spawn; the two transcript-processors' return fields for subsequent spawns). The SKILL.md prose holds no prompt-string knowledge — that is the persona files' job.
- **MUST NOT** skip the `processDevTranscript` / `processReviewerTranscript` step under any circumstance. The prose MUST NOT "shortcut" to a manifest write directly, MUST NOT parse the transcript inline (no LLM regex eyeballing), MUST NOT call `claimStory` / `completeStory` from inside the inner cycle. All manifest mutations go through the transcript-processor tools. (The OUTER claim-loop — `claimNextStory` and queue-drained termination — is separate and remains the operator's signal that a new story is being attempted.)
- **MUST NOT** call `Task` for the reviewer spawn until `processDevTranscript` has returned `next: "spawn-reviewer"`. The handoff phrase parse is the gate that authorises the reviewer; an empty or grammar-drift transcript MUST block the reviewer spawn (AC3 from Story 4.3 carries forward as the v1 grammar-drift surface).
- **NEVER** mutate the manifest from the SKILL.md prose layer directly. The prose has no `writeManagedFile` access — `allowed_tools` does NOT include any direct file-write tool. All state changes go through the transcript-processor tools, which own the manifest mutation contract.
- **NEVER** modify `sprint-status.yaml`, source story files, `.git/` content, or any file outside `<targetRepoRoot>/.crew/state/in-progress/`. (Same write-surface constraint Story 4.3 pinned; carries forward.)

### `processDevTranscript` invariants

Pure function of `(targetRepoRoot, sessionUlid, ref, devTranscript)`. The signature is JSON-only — the tool runs across the MCP wire.

- **MUST** call `parseHandoff(devTranscript, ref)` exactly once. The parser is Story 4.3's existing module (`plugins/crew/mcp-server/src/skills/handoff-parser.ts`) and is imported verbatim — no re-implementation, no regex tweaks.
- **MUST** on `parseHandoff` returning `{ ok: false, reason: "drift" | "empty" }`: (i) read the in-progress manifest at `<targetRepoRoot>/.crew/state/in-progress/<ref>.yaml`, (ii) stamp `blocked_by: "handoff-grammar"`, (iii) write the manifest atomically via `atomicWriteFile`, (iv) return `{ next: "done-blocked-handoff-grammar", chatLog: [<Story 4.3 AC3 verbatim line>] }`. The chat-line text is identical to Story 4.3's `dev-reviewer-cycle.ts` emission (`handoff grammar drift — story <ref> blocked. expected verbatim phrase: "Handoff to reviewer — story <ref> ready for review." Edit the manifest to clear blocked_by and re-run /crew:start.`).
- **MUST** on `parseHandoff` returning `{ ok: true }`: (i) call `buildPersonaSpawnPrompt({ targetRepoRoot, role: "generalist-reviewer" })` to compute the reviewer prompt, (ii) return `{ next: "spawn-reviewer", reviewerPrompt: <buildPersonaSpawnPrompt's systemPrompt>, chatLog: [<Story 4.3 AC1 verbatim line>] }`. The chat-line text: `handoff received — story <ref> — spawning generalist-reviewer subagent (clean context)`.
- **MUST NOT** spawn anything. **MUST NOT** call `Task` (the MCP server has no access to `Task` in v1; this is a structural guarantee — the tool runs over JSON-RPC stdio).
- **MUST NOT** mutate the manifest on the happy-path (handoff parsed OK). The only manifest write performed by this tool is the `blocked_by: "handoff-grammar"` stamp on the grammar-drift path.
- **MUST NOT** read or write any file outside `<targetRepoRoot>/.crew/state/in-progress/<ref>.yaml` and `<targetRepoRoot>/team/<role>/PERSONA.md` (indirectly, via `buildPersonaSpawnPrompt`). The static-fs-guard test enforces this.
- **MUST** be unit-tested against every branch enumerated above: happy-path (handoff parsed), drift, empty transcript. Use the precedent from `plugins/crew/mcp-server/src/skills/__tests__/dev-reviewer-cycle.test.ts` as a structural template, but the new test fixture targets `processDevTranscript` directly.

### `processReviewerTranscript` invariants

Pure function of `(targetRepoRoot, sessionUlid, ref, manifestPath, reviewerTranscript)`. Note `manifestPath` is an explicit argument (rather than computed from `ref`) so the MCP layer can sanity-check the caller has the right manifest in mind; the parser does NOT compute the manifest path itself, which keeps the tool's file-read surface explicit and inspectable.

- **MUST** call `parseVerdict(reviewerTranscript)` exactly once. The parser is Story 4.3's existing module (`plugins/crew/mcp-server/src/skills/verdict-parser.ts`) and is imported verbatim.
- **MUST** on `parseVerdict` returning `{ ok: false, reason: "drift" | "empty" | "unknown-sentinel" }`: (i) read the in-progress manifest, (ii) stamp `blocked_by: "reviewer-grammar"`, (iii) write the manifest atomically, (iv) return `{ next: "done-blocked-reviewer-grammar", chatLog: [<Story 4.3 verbatim reviewer-grammar-drift line>] }`. Chat-line text: `reviewer grammar drift — story <ref> blocked. expected verbatim final line: "**Verdict: <SENTINEL>**" where SENTINEL is one of READY FOR MERGE | NEEDS CHANGES | BLOCKED.`
- **MUST** on `{ ok: true, sentinel: "READY FOR MERGE" }`: return `{ next: "done-ready-for-merge", chatLog: [<verbatim ready-for-merge passthrough>] }`. No manifest mutation. Chat-line text: `reviewer verdict: READY FOR MERGE — story <ref> ready for merge gate`.
- **MUST** on `{ ok: true, sentinel: "BLOCKED" }`: return `{ next: "done-blocked-reviewer-verdict", chatLog: [<verbatim BLOCKED passthrough>] }`. No manifest mutation. Chat-line text: `reviewer verdict: BLOCKED — story <ref> awaiting human`.
- **MUST** on `{ ok: true, sentinel: "NEEDS CHANGES" }`: (i) read the in-progress manifest, (ii) increment `rework_count` (default `undefined → 1`), (iii) write the manifest atomically — BEFORE composing the dev re-spawn prompt, so the new value is on-disk before any concurrent reader observes it, (iv) call `buildPersonaSpawnPrompt({ targetRepoRoot, role: "generalist-dev" })` to compute the dev re-spawn prompt, (v) return `{ next: "rework-dev", devPrompt: <buildPersonaSpawnPrompt's systemPrompt>, reworkIteration: <new rework_count>, chatLog: [<Story 4.3 AC2 verbatim line with <n> substituted>] }`. Chat-line text: `reviewer verdict: NEEDS CHANGES — re-spawning generalist-dev subagent (rework iteration <n>)`.
- **MUST NOT** spawn anything. **MUST NOT** call `Task`. **MUST NOT** call `completeStory` (Story 4.10b's auto-merge gate will eventually trigger that — the inner cycle returns control to the outer claim-loop on `done-ready-for-merge`, and the manifest stays in `in-progress/`).
- **MUST NOT** mutate the manifest on the `READY FOR MERGE` or `BLOCKED` path — they are pass-through.
- **MUST NOT** read or write any file outside the manifest at `manifestPath` and the persona files via `buildPersonaSpawnPrompt`.
- **MUST** be unit-tested against every branch: `READY FOR MERGE`, `NEEDS CHANGES`, `BLOCKED`, drift / empty / unknown-sentinel.

### Chat-line emission ownership table

| Chat line (verbatim) | Owner (file emitting) |
|---|---|
| `handoff received — story <ref> — spawning generalist-reviewer subagent (clean context)` | `process-dev-transcript.ts` |
| `handoff grammar drift — story <ref> blocked. …` | `process-dev-transcript.ts` |
| `reviewer verdict: NEEDS CHANGES — re-spawning generalist-dev subagent (rework iteration <n>)` | `process-reviewer-transcript.ts` |
| `reviewer verdict: READY FOR MERGE — story <ref> ready for merge gate` | `process-reviewer-transcript.ts` |
| `reviewer verdict: BLOCKED — story <ref> awaiting human` | `process-reviewer-transcript.ts` |
| `reviewer grammar drift — story <ref> blocked. …` | `process-reviewer-transcript.ts` |
| `claiming <ref> — <title>` (Story 4.2) | unchanged — still emitted by the outer claim-loop tool (`claimNextStory`, see § Implementation strategy) |
| `spawning generalist-dev subagent (clean context)` (Story 4.2) | NEW: emitted by SKILL.md prose immediately before the first `Task` invocation for a freshly claimed story; the prose prints this line verbatim (it's a fixed string, no interpolation, no operator-observable risk in being prose-emitted). |
| `queue drained — to-do/ and in-progress/ are both empty. …` (Story 4.2) | unchanged — emitted by `claimNextStory` when it returns the drain signal. |

The `spawning generalist-dev subagent (clean context)` line being prose-emitted (rather than tool-emitted) is the one operator-observable string the SKILL.md prose owns. The string is a fixed literal — no interpolation, no per-story state — so the prose layer cannot accidentally drift it. The AC6 content-structure test (anchor iii) verifies its presence in the SKILL.md body.

### Manifest re-entry semantics (carries forward from Story 4.3)

When `blocked_by: handoff-grammar` or `blocked_by: reviewer-grammar` is stamped, the manifest stays in `in-progress/`. No `blocked/` directory in v1 — Story 5.1's deliverable. Operator recovery: hand-edit the manifest to remove `blocked_by:`, re-run `/crew:start`. `claimStory` does NOT re-claim (the story is already claimed by the dev session ULID). v1's full recovery for a blocked-in-progress story remains "delete the in-progress manifest, re-add the source story to `to-do/`, re-scan, re-claim" — clumsy but viable.

### "Done, no review yet" forward-compatibility branch (declared, not exercised)

The `processDevTranscript` return type declares a third branch `{ next: "done-handoff-but-no-review-yet", chatLog: string[] }` that is NOT returnable from the v1 implementation. The branch exists for ABI stability: Story 5.x (or a hypothetical future flow that allows a dev to terminate cleanly without requesting review — e.g. a no-code-change story) can extend `processDevTranscript` to return this shape without bumping the tool's schema or rewriting the SKILL.md prose's switch statement. v1 tests assert the branch is unreachable; v5 tests will exercise it. The TypeScript discriminated-union typing keeps the SKILL.md prose's switch exhaustive without forcing v1 to invent semantics it doesn't have.

---

## Tasks / Subtasks

- [x] **Task 1 — Add `claimNextStory` MCP tool to own outer claim-loop iteration (AC: 3, 4)**
  - [x] 1.1 Create `plugins/crew/mcp-server/src/tools/claim-next-story.ts`. Top of file: TSDoc citing § Behavioural contract by full path.
  - [x] 1.2 The tool wraps a single iteration of `runStartLoop`'s outer pass: call `listClaimableTodos`, pick the first `depsReady: true` candidate, call `claimStory`, return `{ next: "spawn-dev", ref, title, manifestPath, chatLog: [<claiming line>] }` OR `{ next: "queue-drained", chatLog: [<queue drained line>] }` OR `{ next: "waiting-on-in-progress", chatLog: [<waiting line>] }`.
  - [x] 1.3 The tool MUST NOT spawn anything. **MUST NOT** mutate state beyond the `claimStory` call (which is the only sanctioned state mutation).
  - [x] 1.4 Export from `plugins/crew/mcp-server/src/tools/claim-next-story.ts` as `claimNextStory(opts)`.
  - [x] 1.5 Register in `plugins/crew/mcp-server/src/tools/register.ts` with `inputSchema { targetRepoRoot, sessionUlid }` required.
  - [x] 1.6 No `console.*`. Chat lines flow through the returned `chatLog`. Errors propagate as typed `DomainError`s — `register.ts` already wraps `DomainError` into `isError: true` content responses (existing convention).

- [x] **Task 2 — Create `processDevTranscript` MCP tool (AC: 1, 3, 4, 6)**
  - [x] 2.1 Create `plugins/crew/mcp-server/src/tools/process-dev-transcript.ts`. Top of file: TSDoc citing § Behavioural contract.
  - [x] 2.2 Import `parseHandoff` from `../skills/handoff-parser.js` (verbatim — no re-implementation). Import `buildPersonaSpawnPrompt` from `./build-persona-spawn-prompt.js`. Import `parseExecutionManifest` from `../schemas/execution-manifest.js`. Import `atomicWriteFile` from `../lib/managed-fs.js`. Import `node:fs/promises` and `yaml` for the manifest read/write.
  - [x] 2.3 Define and export the discriminated-union return type per § Behavioural contract.
  - [x] 2.4 Implement `processDevTranscript({ targetRepoRoot, sessionUlid, ref, devTranscript })` per the invariants table above.
  - [x] 2.5 Register the tool in `register.ts` with `inputSchema { targetRepoRoot, sessionUlid, ref, devTranscript }` all required (all strings).

- [x] **Task 3 — Create `processReviewerTranscript` MCP tool (AC: 2, 3, 4, 6)**
  - [x] 3.1 Create `plugins/crew/mcp-server/src/tools/process-reviewer-transcript.ts`. Top of file: TSDoc citing § Behavioural contract.
  - [x] 3.2 Import `parseVerdict` from `../skills/verdict-parser.js`. Import `buildPersonaSpawnPrompt`, `parseExecutionManifest`, `atomicWriteFile` per Task 2.
  - [x] 3.3 Define and export the discriminated-union return type.
  - [x] 3.4 Implement `processReviewerTranscript({ targetRepoRoot, sessionUlid, ref, manifestPath, reviewerTranscript })` per the invariants table above.
  - [x] 3.5 Register the tool in `register.ts` with all five inputs required.

- [x] **Task 4 — Delete or refactor `runDevSession`, `runStartLoop`, `runDevReviewerCycle` (AC: 3, 4)**
  - [x] 4.1 Delete `plugins/crew/mcp-server/src/tools/run-dev-session.ts`. Move helpers into `lib/manifest-io.ts`.
  - [x] 4.2 Unregister `runDevSession` from `register.ts` — delete the registration block entirely.
  - [x] 4.3 Delete `plugins/crew/mcp-server/src/skills/dev-reviewer-cycle.ts`.
  - [x] 4.4 Delete `plugins/crew/mcp-server/src/skills/start-loop.ts`.
  - [x] 4.5 Delete associated test files: `dev-reviewer-cycle.test.ts`, `start-skill.integration.test.ts`, `run-dev-session.test.ts`.
  - [x] 4.6 Parsers (`handoff-parser.ts`, `verdict-parser.ts`) are NOT deleted — kept verbatim.

- [x] **Task 5 — Rewrite `plugins/crew/skills/start/SKILL.md` to drive the inner cycle (AC: 1, 2, 5, 6)**
  - [x] 5.1 Update front-matter `allowed_tools` to the exact set `[getStatus, mintSessionUlid, claimNextStory, processDevTranscript, processReviewerTranscript, buildPersonaSpawnPrompt, Task]`.
  - [x] 5.2 Rewrite the `# Steps` section to reflect the new control flow.
  - [x] 5.3 Write the new `# Inner cycle: dev → reviewer → rework` section with all required anchor strings.
  - [x] 5.4 Update the `# Failure modes` section: preserve all entries including `HandoffGrammarDriftError`, `blocked_by: handoff-grammar`, `ReviewerGrammarDriftError`, `blocked_by: reviewer-grammar`.
  - [x] 5.5 Update the file-header HTML comment to cite this story's behavioural contract by full path.

- [x] **Task 6 — Update tool-count assertions and acceptance test (AC: 3, 4)**
  - [x] 6.1 Bump tool-count assertions in `ask-mode-enforcement.test.ts`, `ask-skill.test.ts`, `get-team-snapshot.test.ts` from 19 to **21**.
  - [x] 6.2 `acceptance.test.ts` does not assert a tool count — no change needed.
  - [x] 6.3 New assertion in `inner-cycle.integration.test.ts` AC4(g): tool list contains new tools and NOT `runDevSession`.

- [x] **Task 7 — Manifest-IO shared utility (AC: 3)**
  - [x] 7.1 Create `plugins/crew/mcp-server/src/lib/manifest-io.ts`.
  - [x] 7.2 Export `readManifest(absPath)`.
  - [x] 7.3 Export `writeManifest(absPath, manifest)`.
  - [x] 7.4 Moved `readManifestFromDisk` / `writeManifestToDisk` helpers verbatim (renamed).

- [x] **Task 8 — Unit tests for `processDevTranscript` (AC: 1, 4, 6)**
  - [x] 8.1 Create `plugins/crew/mcp-server/src/tools/__tests__/process-dev-transcript.test.ts`.
  - [x] 8.2 Cover all four branches (happy handoff, drift, empty, whitespace-only).
  - [x] 8.3 Regression assertion: no Task-spawn seam needed (test compiles and passes without one).

- [x] **Task 9 — Unit tests for `processReviewerTranscript` (AC: 2, 4, 6)**
  - [x] 9.1 Create `plugins/crew/mcp-server/src/tools/__tests__/process-reviewer-transcript.test.ts`.
  - [x] 9.2 Cover all branches: READY FOR MERGE (w/ and w/o bracket), NEEDS CHANGES (first and second rework), BLOCKED (w/ and w/o bracket), drift/empty/unknown-sentinel.

- [x] **Task 10 — Integration tests: end-to-end inner cycle through tool composition (AC: 1, 2, 4, 5)**
  - [x] 10.1 Create `plugins/crew/mcp-server/src/tools/__tests__/inner-cycle.integration.test.ts`.
  - [x] 10.2 Cover all AC4 branches (a)–(g) with fixture tmpdir target repo.
  - [x] 10.3 Assert cumulative `chatLog` matches verbatim lines.
  - [x] 10.4 Assert final manifest state on disk matches AC4 expectations.

- [x] **Task 11 — Content-structure tests for AC6 anchors (AC: 6)**
  - [x] 11.1 Rewrite `start-skill-content.test.ts` with new AC6 anchors.
  - [x] 11.2 Create `processors-content.test.ts` checking anchor strings in tool source files and register.ts.

- [ ] **Task 12 — User-surface smoke evidence for AC5 (AC: 5)**
  - [ ] 12.1 AC5 requires `user_surface_verified` evidence from a real `/crew:start` session (vitest cannot exercise the live Task-tool flow).
  - [ ] 12.2 Operator-smoke procedure documented in the story spec.
  - [ ] 12.3 Separate smoke session needed for grammar-drift branch.

- [x] **Task 13 — Build, full vitest suite, fs-guard regression (AC: all)**
  - [x] 13.1 `pnpm build` passes. `dist/` committed.
  - [x] 13.2 All 710 tests pass across 64 test files.
  - [x] 13.3 `canonical-fs-guard.test.ts` passes — new tools write via `atomicWriteFile` through `manifest-io.ts`.
  - [x] 13.4 No telemetry emit added.

---

## Implementation strategy

### Why the SKILL.md prose owns `Task` spawn (the load-bearing decision)

Three architectural options were considered:

- (a) **Keep `runDevSession` and find a way to pass the `Task` tool through MCP.** Rejected because MCP is JSON-only over stdio — closures, callables, and tool references cannot cross the wire. Workarounds (e.g. an MCP-server-side HTTP client that calls back into the Claude Code harness) would require either reverse-engineering the harness's IPC or running a sidecar that can invoke `Task` on behalf of the MCP server. Both options multiply complexity and introduce a non-standard control surface.

- (b) **Drive the inner cycle entirely from SKILL.md prose with NO MCP composite tools.** Rejected because the parsers (`parseHandoff`, `parseVerdict`) and the manifest mutations (`rework_count` increment, `blocked_by` stamp) require deterministic TypeScript — letting the LLM-driven prose parse the transcript with a regex is the exact failure mode `user-surface-acs.md` calls out. ("Document-driven verification has a known blind spot…")

- (c) **Split spawn (prose) from parse-and-mutate (MCP).** Chose. The prose holds zero parse logic and zero state-mutation logic — it just calls `Task`, hands the transcript to the next tool, and switches on the tool's `next` field. All control flow lives in plain TypeScript inside the two transcript-processor tools.

This is the same architectural pattern other Claude Code skills use for live-session work: the harness owns subagent spawn, the MCP server owns deterministic data transformations, and the skill prose is the routing layer that maps user intent to the right tool sequence.

### Why two tools, not one composite

A single composite tool (e.g. `processTranscript({ role, transcript })`) was considered. Rejected because:

- The two tools have different return shapes — `processDevTranscript` may return a reviewer-prompt or a block-handoff; `processReviewerTranscript` may return a dev-prompt-for-rework, a ready-for-merge, a BLOCKED, or a block-reviewer. A single composite would have a union type covering both, requiring the SKILL.md prose's switch statement to handle six cases instead of three+four.
- The role argument would be a footgun — operator-readable skills should not require the prose to pass `role: "generalist-dev"` correctly; the tool name `processDevTranscript` makes the role explicit at the call site.
- The two tools have different input shapes — `processReviewerTranscript` needs `manifestPath` (for the rework write); `processDevTranscript` needs only `ref` (the manifest path is derived from `ref` in the v1 path layout). Forcing a composite to take a unionised input shape obscures which fields are required for which role.

### Why the outer claim-loop also becomes an MCP tool (`claimNextStory`)

Story 4.3's `runDevSession` bundled the outer claim-loop and inner cycle into one MCP call. The outer loop (alphabetical `to-do/` scan, `claimStory` call, queue-drained termination) is itself non-trivial control flow — letting the SKILL.md prose iterate `to-do/` manually would require the prose to call `listClaimableTodos` directly, parse the result, pick a candidate, call `claimStory` — too many opportunities for LLM-driven control-flow drift.

The new `claimNextStory` MCP tool wraps a single iteration of the outer loop. The SKILL.md prose's outer loop is reduced to `while (true) { call claimNextStory; switch on next; if queue-drained, break; else run inner cycle; }` — three lines of prose-readable control flow, all deterministic switching on tool return values.

### Why `runStartLoop` and `runDevReviewerCycle` are deleted (not refactored)

Story 4.3's `runStartLoop` was the orchestrator-in-TypeScript that held both the outer claim-loop and the inner cycle as a single in-process function. With the inner cycle now hosted by SKILL.md prose and the outer claim-loop hosted by `claimNextStory`, neither function has a caller. Keeping them as dead code would bloat the surface area and confuse future readers (the file would say "the orchestrator lives here" while production wiring goes elsewhere). Delete is the cleaner signal.

The pure parsers (`handoff-parser.ts`, `verdict-parser.ts`) are KEPT — they are consumed verbatim by the new transcript-processor tools. Their unit tests pass unchanged.

### Why the static-fs-guard check is unchanged

The `canonical-fs-guard.test.ts` regression check enforces that MCP tools route manifest writes through `atomicWriteFile` (Story 1.6's primitive). The new tools comply — their manifest writes go through `manifest-io.ts`'s `writeManifest`, which calls `atomicWriteFile`. No new exemptions are added.

### Why the tool-count jump from 19 → 21 (not 20)

The brief suggested "19 → 20 (or 19 if you keep one composite tool)." After deeper analysis, the correct count is 21: drop one (`runDevSession`), add three (`claimNextStory`, `processDevTranscript`, `processReviewerTranscript`). The `claimNextStory` addition was not in the brief but is required by the same architectural argument (the SKILL.md prose should not iterate `to-do/` directly). If we omitted `claimNextStory` and let the prose call `listClaimableTodos` + `claimStory` directly, the tool count would be 20 — but the SKILL.md prose would need to parse the `listClaimableTodos` JSON response, pick a candidate, handle the deps-not-ready case, and emit the `claiming <ref>` line itself. That's exactly the prose-driven-control-flow pattern AC1's "MUST come from the MCP tool" invariant exists to prevent.

### Why `rework_iteration` is in the dev `initial_context` block (not in the dev prompt)

The dev subagent's persona prompt is role-keyed (one prompt per role, not per spawn). Embedding `rework_iteration` in the prompt would require either (a) re-composing the persona prompt per spawn with the iteration count inlined — couples `buildPersonaSpawnPrompt` to a specific use case — or (b) appending the iteration count as a suffix to the prompt — drifts the prompt from the verbatim persona body.

Instead, `rework_iteration` lives in the `initial_context` block that `Task` passes to the subagent alongside the system prompt. The persona prompt instructs the dev to "read your initial context for `rework_iteration`; if set, acknowledge the prior reviewer feedback before re-attempting." This is the pattern Story 4.3 established and Story 4.3b preserves.

### Why `Task` is in `allowed_tools` even though it's a Claude Code built-in

Claude Code skills declare their tool surface in `allowed_tools` regardless of whether the tool is custom MCP or built-in harness. The permission gate enforces the declared set — if `Task` were absent from `allowed_tools`, the prose's `Task` invocation would be refused by the harness. (Reference: Story 1.4's permission allowlist scaffolding.) The AC6 anchor i set-equality test specifically lists `Task` to catch a regression where someone removes it thinking it's redundant.

### How the operator-smoke evidence path works

Per `plugins/crew/docs/user-surface-acs.md` §How the gate uses this, AC5 (user-surface) requires a `user_surface_verified` event in the ship-story run log carrying `ac_refs` covering AC5 and a `pasted_output` block with the verbatim chat-surface output of a real `/crew:start` session. The operator follows Task 12.2's smoke procedure, pastes the output, and the pre-PR gate accepts. AC1 and AC2 (also user-surface) are covered by the same paste IF the live session exercises both — i.e. the dev subagent emits the handoff phrase (AC1), the reviewer emits a verdict (AC2). A single smoke session covers all three if the story drives the happy path. The grammar-drift branch needs a second smoke session (operator deliberately paraphrases the dev's handoff phrase, observes the AC3 drift line).

### Risks and mitigations

- **Risk: SKILL.md prose drifts the verbatim chat lines.** Mitigation: AC6 anchors iii–vii are content-structure checks that catch any prose edit that loses an anchor string. The CI test runs on every PR.
- **Risk: A future story adds a fourth transcript-processor tool and breaks the SKILL.md prose's switch exhaustiveness.** Mitigation: the discriminated-union return types use a `next: "..."` literal field; TypeScript enforces exhaustive switches at compile time. A new branch forces a SKILL.md prose update.
- **Risk: The Claude Code `Task` tool's return shape changes between versions.** Mitigation: the SKILL.md prose treats the `Task` return value as "the subagent's final message string" — a contract that has been stable since `Task` shipped. If the contract changes, the prose's transcript-capture step is the one location that needs an update; the parsers and tools are unaffected.
- **Risk: An operator runs `/crew:start` on a repo whose hired personas have drifted from the catalogue.** Mitigation: `buildPersonaSpawnPrompt` reads `<targetRepoRoot>/team/<role>/PERSONA.md` (the hired copy) on every call. If a knowledge edit lands between dev and reviewer turns, the next reviewer spawn picks it up.

---

## Dev Notes

### File map (likely — refine during implementation)

**New files:**
- `plugins/crew/mcp-server/src/tools/claim-next-story.ts`
- `plugins/crew/mcp-server/src/tools/process-dev-transcript.ts`
- `plugins/crew/mcp-server/src/tools/process-reviewer-transcript.ts`
- `plugins/crew/mcp-server/src/lib/manifest-io.ts`
- `plugins/crew/mcp-server/src/tools/__tests__/claim-next-story.test.ts`
- `plugins/crew/mcp-server/src/tools/__tests__/process-dev-transcript.test.ts`
- `plugins/crew/mcp-server/src/tools/__tests__/process-reviewer-transcript.test.ts`
- `plugins/crew/mcp-server/src/tools/__tests__/inner-cycle.integration.test.ts`
- `plugins/crew/mcp-server/src/tools/__tests__/processors-content.test.ts`

**Modified files:**
- `plugins/crew/skills/start/SKILL.md` (substantial rewrite — front-matter + steps + new inner-cycle section + failure-modes update)
- `plugins/crew/mcp-server/src/tools/register.ts` (unregister `runDevSession`; register `claimNextStory`, `processDevTranscript`, `processReviewerTranscript`)
- `plugins/crew/mcp-server/tests/ask-mode-enforcement.test.ts` (tool count 19 → 21)
- `plugins/crew/mcp-server/tests/ask-skill.test.ts` (tool count 19 → 21)
- `plugins/crew/mcp-server/tests/get-team-snapshot.test.ts` (tool count 19 → 21)
- `plugins/crew/mcp-server/src/skills/__tests__/start-skill-content.test.ts` (AC6 anchor updates)
- `plugins/crew/mcp-server/dist/` (rebuild; commit per CLAUDE.md)

**Deleted files:**
- `plugins/crew/mcp-server/src/tools/run-dev-session.ts`
- `plugins/crew/mcp-server/src/skills/dev-reviewer-cycle.ts`
- `plugins/crew/mcp-server/src/skills/start-loop.ts`
- `plugins/crew/mcp-server/src/tools/__tests__/run-dev-session.test.ts`
- `plugins/crew/mcp-server/src/skills/__tests__/dev-reviewer-cycle.test.ts`
- `plugins/crew/mcp-server/src/skills/__tests__/start-loop.test.ts` (if it exists)
- `plugins/crew/mcp-server/src/skills/__tests__/start-skill.integration.test.ts` (Story 4.2 integration test — replaced by `inner-cycle.integration.test.ts`)

**Untouched (consumed verbatim):**
- `plugins/crew/mcp-server/src/skills/handoff-parser.ts` and its test
- `plugins/crew/mcp-server/src/skills/verdict-parser.ts` and its test
- `plugins/crew/mcp-server/src/tools/build-persona-spawn-prompt.ts` and its test
- `plugins/crew/mcp-server/src/tools/claim-story.ts`, `complete-story.ts`, `list-claimable-todos.ts`, `mint-session-ulid.ts`
- `plugins/crew/mcp-server/src/schemas/execution-manifest.ts` (`rework_count`, `blocked_by` already declared per Story 4.3 Task 7)
- `plugins/crew/catalogue/generalist-dev.md`, `generalist-reviewer.md` (locked-phrase declarations unchanged)
- `plugins/crew/catalogue/permissions/generalist-dev.yaml`, `generalist-reviewer.yaml` (subagent permission specs — neither subagent needs the new tools)

### State of files being modified (read these before editing)

- **`plugins/crew/skills/start/SKILL.md`**: Currently a 79-line skill file. Front-matter `allowed_tools: [getStatus, mintSessionUlid, runDevSession]`. `# Steps` section is five steps ending in `call runDevSession`. `# Inner cycle` section (3 sub-bullets) and `# Failure modes` section are already present from Story 4.3 but reference `runDevSession`. The rewrite preserves the Story 4.2 outer-loop description and the queue-drained line; replaces the `runDevSession` call with the new `claimNextStory` loop; expands `# Inner cycle` with explicit `Task` invocation sites.

- **`plugins/crew/mcp-server/src/tools/register.ts`**: 723 lines, 19 `registerTool` calls (Story 4.3 baseline). The `runDevSession` registration is at lines 682–722. Delete this block. Add three new blocks following the same DomainError-handling pattern (see `claimStory`'s handler at lines 455–484 for the canonical try/catch shape).

- **`plugins/crew/mcp-server/src/skills/dev-reviewer-cycle.ts`**: 230 lines. The orchestration logic across `runDevReviewerCycle` is what moves into `processDevTranscript` (lines 100–147 = handoff parse + grammar-drift handling) and `processReviewerTranscript` (lines 168–229 = verdict parse + rework / ready / blocked / grammar-drift handling). Read the file end-to-end before authoring the two new tools — the chat-line strings are the canonical source.

- **`plugins/crew/mcp-server/src/tools/run-dev-session.ts`**: 123 lines. The `readManifestFromDisk` / `writeManifestToDisk` helpers at lines 100–123 move into the new `manifest-io.ts` verbatim. The `runDevSession` function itself is deleted.

- **`plugins/crew/mcp-server/src/skills/start-loop.ts`**: ~400 lines. The outer claim-loop logic (the `while` loop that iterates `listClaimableTodos`, calls `claim`, surfaces `claiming <ref>` lines, terminates on queue-drained) is the source material for `claim-next-story.ts`. Read sections in this file:
  - `QUEUE_DRAINED_LINE` and `WAITING_ON_IN_PROGRESS_LINE` exports (verbatim string constants — preserve in `claim-next-story.ts`)
  - `processCandidate` function (single-candidate logic — adapt to the single-iteration tool shape)
  - Outer loop structure (the prose layer now drives this iteration)

### Tests that will run on this story

- All existing vitest suites under `plugins/crew/mcp-server/`. The new tool-count assertions catch any new tool not in the new triple.
- New unit tests for `claimNextStory`, `processDevTranscript`, `processReviewerTranscript`.
- New integration test composing the two transcript-processor tools (no live Claude Code).
- AC6 content-structure tests for SKILL.md anchors and tool source-file anchors.
- The ship-story pre-PR gate, on PR open, refuses unless AC1 / AC2 / AC5 carry `user_surface_verified` events (manual operator smoke per Task 12).

### Coding conventions to follow

- TypeScript strict mode (already on in `plugins/crew/mcp-server/tsconfig.json`).
- camelCase tool names (`processDevTranscript`, not `process_dev_transcript`).
- Discriminated unions with literal `next: "..."` fields for return types — matches the `parseHandoff` / `parseVerdict` precedent.
- TSDoc at top of every new file citing the behavioural-contract source path.
- No `console.*` in tool source files — all output flows through the returned `chatLog: string[]`.
- All manifest writes route through `atomicWriteFile` (Story 1.6's primitive) via `lib/manifest-io.ts`.
- All `DomainError` subclasses propagate from tools; `register.ts` wraps them in `isError: true` content responses (existing pattern — see `claimStory`'s handler).

### Project Structure Notes

- The plugin's MCP server lives under `plugins/crew/mcp-server/`. Its `src/tools/` directory holds MCP-tool entry points; `src/skills/` holds pure helpers that tools compose (parsers, orchestration logic — though after this story `src/skills/` shrinks because the two big helpers are deleted).
- The skill files live under `plugins/crew/skills/<skill-name>/SKILL.md`. The `crew:start` skill is at `plugins/crew/skills/start/SKILL.md`.
- The catalogue (role templates) lives at `plugins/crew/catalogue/`; team-instantiated personas live at `<targetRepoRoot>/team/<role>/PERSONA.md` in the target repo (not in the plugin).
- The build output at `plugins/crew/mcp-server/dist/` is tracked in git (per CLAUDE.md §Process notes — `/plugin install` does not run a build step).

### References

- Epic: `_bmad-output/planning-artifacts/epics/epic-4-dev-review-loop-the-engineering-heart.md` § Story 4.3b
- Story 4.3 spec (the precursor, whose `runDevSession` this story refactors): `_bmad-output/implementation-artifacts/4-3-dev-reviewer-handoff-reviewer-spawn-and-rework-signal.md`
- Story 4.2 spec (the outer claim-loop, whose `runStartLoop` is also refactored): `_bmad-output/implementation-artifacts/4-2-start-skill-and-per-story-dev-subagent-spawn.md`
- User-surface AC convention: `plugins/crew/docs/user-surface-acs.md`
- PR #103 reviewer's Info-2 finding (the production bug this story closes): `plugins/crew/mcp-server/src/tools/run-dev-session.ts:73-80`
- Epic 4 carry-forward retro (the explicit follow-up commitment): epic file lines 9–14
- Architecture: `_bmad-output/planning-artifacts/architecture/` (sharded — start at `index.md`; relevant sections: §Agent invocation model, §MCP Tool Naming, §Skill prose ↔ MCP layer split)
- PRD: `_bmad-output/planning-artifacts/prd-crew-v1/` (sharded — start at `index.md`; relevant FRs: FR15, FR17, FR18, FR19, FR24, FR26, FR27, FR28)

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (1M context)

### Debug Log References

No blocking issues encountered.

### Completion Notes List

- Implemented all three new MCP tools: `claimNextStory`, `processDevTranscript`, `processReviewerTranscript`.
- Extracted `readManifest`/`writeManifest` helpers into `lib/manifest-io.ts`.
- Deleted `run-dev-session.ts`, `dev-reviewer-cycle.ts`, `start-loop.ts`, and their tests.
- Rewrote `SKILL.md` with all AC6 anchor strings: Task tool spawn in prose, verbatim transcript handoff, `allowed_tools` set-equality.
- Bumped tool count assertions 19 → 21 across three test files.
- All 710 tests pass (64 test files). Build is clean. dist/ updated.
- Task 12 (AC5 live smoke) is deferred to the ship gate — requires a real Claude Code session.

### File List

**New files:**
- `plugins/crew/mcp-server/src/tools/claim-next-story.ts`
- `plugins/crew/mcp-server/src/tools/process-dev-transcript.ts`
- `plugins/crew/mcp-server/src/tools/process-reviewer-transcript.ts`
- `plugins/crew/mcp-server/src/lib/manifest-io.ts`
- `plugins/crew/mcp-server/src/tools/__tests__/process-dev-transcript.test.ts`
- `plugins/crew/mcp-server/src/tools/__tests__/process-reviewer-transcript.test.ts`
- `plugins/crew/mcp-server/src/tools/__tests__/inner-cycle.integration.test.ts`
- `plugins/crew/mcp-server/src/tools/__tests__/processors-content.test.ts`

**Modified files:**
- `plugins/crew/skills/start/SKILL.md` (substantial rewrite — front-matter + steps + inner-cycle section + failure-modes update)
- `plugins/crew/mcp-server/src/tools/register.ts` (removed `runDevSession`; added `claimNextStory`, `processDevTranscript`, `processReviewerTranscript`)
- `plugins/crew/mcp-server/src/skills/__tests__/start-skill-content.test.ts` (AC6 anchor assertions)
- `plugins/crew/mcp-server/src/skills/__tests__/parsers-content.test.ts` (removed dev-reviewer-cycle.ts references)
- `plugins/crew/mcp-server/tests/ask-mode-enforcement.test.ts` (tool count 19 → 21)
- `plugins/crew/mcp-server/tests/ask-skill.test.ts` (tool count 19 → 21)
- `plugins/crew/mcp-server/tests/get-team-snapshot.test.ts` (tool count 19 → 21)
- `plugins/crew/mcp-server/dist/` (rebuilt)

**Deleted files:**
- `plugins/crew/mcp-server/src/tools/run-dev-session.ts`
- `plugins/crew/mcp-server/src/skills/dev-reviewer-cycle.ts`
- `plugins/crew/mcp-server/src/skills/start-loop.ts`
- `plugins/crew/mcp-server/src/tools/__tests__/run-dev-session.test.ts`
- `plugins/crew/mcp-server/src/skills/__tests__/dev-reviewer-cycle.test.ts`
- `plugins/crew/mcp-server/src/skills/__tests__/start-skill.integration.test.ts`

### Change Log

- 2026-05-22: Story 4.3b implementation — harness-side Task-spawn seam for runDevSession. Deleted runDevSession/runStartLoop/runDevReviewerCycle; added claimNextStory, processDevTranscript, processReviewerTranscript MCP tools; extracted manifest-io.ts; rewrote SKILL.md prose to own Task invocations. Tool count 19 → 21.
