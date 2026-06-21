# Story 4.3: Dev → reviewer handoff, reviewer spawn, and rework signal

story_shape: user-surface

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a **plugin maintainer driving the dev loop**,
I want **the dev subagent to terminate its turn with a locked handoff phrase, the `/crew:start` session to parse that phrase, spawn a clean-context reviewer subagent assembled from the `generalist-reviewer` persona, and treat a `NEEDS CHANGES` verdict as a rework signal that re-spawns the dev subagent on the same story while incrementing `rework_count`**,
so that **the verdict comes from a subagent whose context contains no implementation reasoning, and reworks are surfaced as first-class state rather than silent re-attempts.**

### What this story is, in one sentence

Ship the dev → reviewer handoff wiring that closes the inner loop of Epic 4: (1) a tolerant-but-strict parser that scans the dev subagent's final-output transcript for the verbatim locked handoff phrase `Handoff to reviewer — story <story-id> ready for review.` (with `<story-id>` substituted by the live story ref); (2) on parse-hit, the `/crew:start` session calls a new `buildPersonaSpawnPrompt({ role: "generalist-reviewer" })` and spawns the reviewer via Claude Code's `Task` tool with a clean context, passing the story ref / session ULID / PR-hint context; (3) a tolerant-but-strict parser for the reviewer subagent's final-output transcript that extracts one of three verdict sentinels (`READY FOR MERGE | NEEDS CHANGES | BLOCKED`) on the final line; (4) verdict-handling logic — `READY FOR MERGE` returns control to the `/start` loop (which then moves on; auto-merge is Story 4.10b); `NEEDS CHANGES` increments `rework_count` on the in-progress manifest and re-spawns the dev subagent with the same ref + a `rework_iteration: <n>` initial-context hint, keeping the story in `in-progress/`; (5) a grammar-drift path — when the dev's handoff phrase fails to parse, the story is blocked by setting `blocked_by: "handoff-grammar"` on the in-progress manifest (in-place rewrite via `writeManagedFile`, since `blockStory` is deferred to Story 5.1) and the chat surface emits a verbatim grammar-drift line.

### What this story fixes (and why it needs its own story)

Story 4.2 just shipped `/crew:start` and the dev-subagent spawn mechanism. The loop today is one-shot per story: the dev subagent runs, terminates, and `runStartLoop` moves to the next claimable ref. Three gaps:

- **No reviewer spawn.** The dev subagent's locked handoff phrase is currently a documentation artefact, not an executable signal — nothing parses it, nothing spawns the reviewer. Story 4.6 / 4.6b describe what the reviewer DOES; this story is what makes it BE.
- **No rework loop.** A reviewer that says `NEEDS CHANGES` has no path back into the dev subagent in v1 — the story would silently exit `/crew:start` with a paused review and no manifest signal that rework is needed.
- **No grammar-drift safety net.** If the dev subagent paraphrases its locked handoff phrase (e.g. emits `Story ready for review — handing off!`), the story would silently complete with no review and no signal. The pattern-enforcement contract from the epic (line 70) requires the parser to refuse silently-passing drift.

This story is the inner cycle of Epic 4: claim → dev → handoff-parse → reviewer-spawn → verdict-parse → (rework | continue). Stories 4.4 (`git push` + `gh pr create`), 4.6 (reviewer reads sources), 4.6b (reviewer posts comments), 4.7 (verdict footer marker), 4.9/4.9b (risk-tier), 4.10/4.10b (auto-merge), 4.11 (yield), 4.12 (telemetry) all sit downstream of this handoff. Without 4.3, the dev subagent's handoff phrase is a phrase nobody reads.

### This story does NOT

- (a) Touch `_bmad-output/implementation-artifacts/sprint-status.yaml` or any other file under `_bmad-output/implementation-artifacts/`. The orchestrator owns status transitions. The dev agent MUST NOT edit any status / state file when implementing this story.
- (b) Implement `git push`, `gh pr create`, or the PR-creation terminal action of the dev subagent. Story 4.4 owns that. The dev subagent in this story emits its locked handoff phrase as its final action; PR-creation is its job before that, but is NOT enforced here. This story's parser hooks on the handoff phrase only — whether a PR was opened first is opaque to the parser.
- (c) Implement what the reviewer subagent DOES (read sources, run ACs, post inline comments, post a verdict summary, edit by footer marker). Stories 4.6 / 4.6b / 4.7 own that. This story ships the spawn mechanism and the verdict-parse mechanism — the reviewer subagent's persona body (`generalist-reviewer.md`) already describes what it will do once it boots.
- (d) Implement the `blockStory` MCP tool or the `blocked_by` taxonomy formalisation. Story 5.1 (Epic 5) owns `blockStory`. To keep this story unblocked, the grammar-drift path uses `writeManagedFile` directly to stamp `blocked_by: "handoff-grammar"` into the in-progress/ manifest WITHOUT moving the manifest to a `blocked/` directory (no `blocked/` directory is introduced in v1 until Story 5.1 lands). The manifest stays in `in-progress/` with `blocked_by` set; Story 5.1 will retrofit the atomic move.
- (e) Implement risk-tier classification (Story 4.9 / 4.9b) or auto-merge (Story 4.10b). When the reviewer returns `READY FOR MERGE` in this story, `/crew:start` simply returns control to the outer claim-loop. No merge is performed; the PR (if Story 4.4 opened one) waits for human or for the later Story 4.10b auto-merge gate.
- (f) Implement the yield protocol (Story 4.11). If the dev subagent emits the locked yield phrase instead of the locked handoff phrase, this story's parser treats the output as "neither handoff nor verdict" and falls through to grammar-drift handling — Story 4.11 will replace that fall-through with proper yield routing.
- (g) Implement telemetry (`agent.invoke`, `reviewer.verdict` events). Story 4.12 owns telemetry. The skill MUST NOT emit JSONL events from any path added in this story; reviewer-spawn and rework-loop telemetry are wired in 4.12.
- (h) Implement reviewer time-budget enforcement (8-min hard limit per NFR2) or dev time-budget enforcement (30-min soft per NFR3). Story 4.12 owns those. This story assumes both subagents terminate within their natural budget.
- (i) Implement the reviewer subagent's PR-context discovery. The reviewer reads the PR via `gh pr diff` (FR30, Story 4.6) when Story 4.4 has opened one. This story's initial-context block passes the story ref and the latest known PR number IF available from the dev subagent's terminal output (best-effort regex against the handoff transcript for a `https://github.com/.../pull/<n>` URL). If no PR URL is parseable, the initial-context's `pr_number` field is `null` and the reviewer subagent handles the missing-PR case per its persona (Story 4.6 will tighten this contract).
- (j) Add a maximum-rework-count cap. The rework loop is unbounded in v1 (a stuck pair of subagents will burn budget until the operator notices). Story 4.12's 30-min dev budget acts as the implicit cap. A future hardening story can add an explicit `max_rework_count` config knob.
- (k) Add a `--force-handoff` operator override or any other escape hatch for grammar drift. The grammar-drift path is unconditional. The operator's recovery surface is: edit the in-progress manifest to clear `blocked_by`, then re-run `/crew:start` (which will reclaim and re-spawn the dev — see § Behavioural contract for the manifest re-entry semantics).
- (l) Implement reviewer-output verdict footer-marker idempotency. Story 4.7 owns that. The parser in this story extracts the verdict sentinel from the FIRST line matching the locked verdict grammar in the captured subagent transcript; it does NOT scan footer markers or attempt to dedupe with prior verdicts.
- (m) Re-implement the `Task` tool, `claimStory`, `buildPersonaSpawnPrompt`, `writeManagedFile`, the workspace resolver, or `parseExecutionManifest`. All shipped — this story imports and wires them.
- (n) Modify the `generalist-dev.md` or `generalist-reviewer.md` catalogue persona bodies. Their existing locked-phrase declarations are the contract this story consumes. If a future persona-prompt extension is needed to remind the dev to emit the handoff phrase verbatim, that is a follow-up story; for v1, the existing catalogue text (`generalist-dev.md` line 30 / 46) is sufficient.
- (o) Add a `rework_count` field to source stories. The field lives on the execution manifest only — source stories carry stable spec text, manifests carry runtime state. The schema change happens in `plugins/crew/mcp-server/src/schemas/execution-manifest.ts`.

---

## Acceptance Criteria

> AC1 / AC2 / AC3 are verbatim from the epic with user-surface tags applied per `plugins/crew/docs/user-surface-acs.md` rubric. AC4 is the epic's integration AC (not user-surface). AC5 is the deterministic content-structure check the brief requires; it inspects on-disk source files AND skill front-matter for verbatim anchors — internal-only, not user-surface.

**AC1 (user-surface):**
**Given** the dev subagent has finished implementation and emits the locked handoff phrase `Handoff to reviewer — story <story-id> ready for review.` (with `<story-id>` substituted by the live story ref, e.g. `Handoff to reviewer — story 01J9P0K2N3MZX0YV4S5RTQ4ABC ready for review.`) as a line in its final-output transcript,
**When** the `/crew:start` dev session captures the subagent's transcript and runs the handoff parser,
**Then** the chat surface (a) prints a single line `handoff received — story <story-id> — spawning generalist-reviewer subagent (clean context)`, (b) `buildPersonaSpawnPrompt({ targetRepoRoot, role: "generalist-reviewer" })` is called exactly once for the reviewer spawn (fresh read of `<targetRepoRoot>/team/generalist-reviewer/PERSONA.md`), and (c) the reviewer subagent runs as a `Task`-tool spawn whose system prompt is the assembled `generalist-reviewer` persona text (frontmatter-stripped body + Knowledge section + appended Locked-phrases sentinel block, per Story 4.2 § buildPersonaSpawnPrompt composition), with a fresh context isolated from both the calling `/start` session AND the dev subagent's context. _(FR26, FR27)_

<!-- User-surface: AC1 describes the chat-surface line the operator reads, plus the Claude Code Task-tool UI surface where a new reviewer subagent appears in a fresh context (rubric iv — Task-tool UI panel). Mirrors Story 4.2 AC2's judgement that subagent spawn is user-surface. All dependencies (buildPersonaSpawnPrompt, Task, the parser added here) are runnable on day-one of merge — no deferred caller. -->

**AC2 (user-surface):**
**Given** the reviewer subagent has returned with a final-output transcript whose final non-empty line is `**Verdict: NEEDS CHANGES**` (or `**Verdict: NEEDS CHANGES** [<N> issues, <M> questions]` — the bracketed counts are tolerated but ignored by this story's parser),
**When** the `/crew:start` dev session runs the verdict parser,
**Then** (a) the chat surface prints a single line `reviewer verdict: NEEDS CHANGES — re-spawning generalist-dev subagent (rework iteration <n>)` where `<n>` is the post-increment value of `rework_count`, (b) the in-progress manifest at `<targetRepoRoot>/.crew/state/in-progress/<story-id>.yaml` is rewritten via `writeManagedFile` with `rework_count` incremented (defaulting `undefined → 1` for first rework), (c) the dev subagent is re-spawned via `Task` with a freshly-assembled `generalist-dev` persona prompt AND an `initial_context.rework_iteration` field set to the new `rework_count`, (d) the story remains in `in-progress/` (no atomic move), and (e) the loop awaits the re-spawned dev's termination and then re-runs the handoff parser — so a rework can iterate without leaving the inner cycle. _(FR28)_

<!-- User-surface: AC2's chat-surface line is operator-observable (rubric iv). The Task-tool UI shows a fresh dev subagent (rubric iv). The rework_count increment is internal — but it IS visible to the operator via the verbatim chat line, which is what makes the AC user-surface. -->

**AC3 (user-surface):**
**Given** the dev subagent has terminated and its final-output transcript contains NO line matching the locked handoff grammar (either silence, a paraphrase like `story is ready for review`, an unrelated last line, or the handoff line with a wrong `<story-id>` substituted),
**When** the `/crew:start` dev session runs the handoff parser,
**Then** (a) the chat surface prints a single line `handoff grammar drift — story <story-id> blocked. expected verbatim phrase: "Handoff to reviewer — story <story-id> ready for review." Edit the manifest to clear blocked_by and re-run /crew:start.`, (b) the in-progress manifest at `<targetRepoRoot>/.crew/state/in-progress/<story-id>.yaml` is rewritten via `writeManagedFile` with `blocked_by: "handoff-grammar"` set (story stays in `in-progress/` — no atomic move; Story 5.1 will retrofit), (c) NO reviewer spawn occurs, and (d) `runStartLoop` continues to the next claimable candidate per Story 4.2's outer loop. _(Pattern enforcement; epic line 70)_

<!-- User-surface: AC3's chat-surface line is the operator's only signal that drift occurred — it MUST be verbatim and discoverable (rubric iv). The phrase `Handoff to reviewer — story <story-id> ready for review.` literal is part of the operator-facing recovery message. The slash command `/crew:start` is named in the message (rubric i). -->

**AC4 (integration):**
vitest covers four branches against fixture transcripts:
- (a) **Happy handoff:** seed an in-progress manifest, drive `runStartLoop` (or the new `runDevReviewerCycle` helper — see § Implementation strategy) with a fake `taskSpawn` whose first invocation (the dev subagent) returns a transcript ending with `Handoff to reviewer — story <story-id> ready for review.` and whose second invocation (the reviewer) returns a transcript ending with `**Verdict: READY FOR MERGE**`. Assert (i) `buildPrompt` was called twice with roles `generalist-dev` and `generalist-reviewer` in that order, (ii) two `taskSpawn` calls with distinct system prompts, (iii) the AC1 verbatim chat line is in `chatLog`, (iv) `rework_count` is NOT written (no rework occurred), (v) `blocked_by` is NOT written, (vi) the loop returns control normally.
- (b) **Rework loop (one iteration):** same setup; first reviewer transcript ends with `**Verdict: NEEDS CHANGES** [2 issues, 0 questions]`; second dev transcript ends with the handoff phrase verbatim; second reviewer transcript ends with `**Verdict: READY FOR MERGE**`. Assert (i) **four** `taskSpawn` calls in order: dev, reviewer, dev, reviewer, (ii) the manifest on disk after the rework reads `rework_count: 1` (then `rework_count: 1` retained — second rework does not happen because the second reviewer passes), (iii) the AC2 verbatim chat line is in `chatLog` (with `<n>` = `1`), (iv) the loop returns control normally.
- (c) **Grammar drift block:** first dev transcript ends with `story 01ABC ready for review.` (no `Handoff to reviewer —` prefix). Assert (i) zero reviewer spawns, (ii) AC3 verbatim chat line is in `chatLog`, (iii) the on-disk manifest after the call reads `blocked_by: "handoff-grammar"`, (iv) the manifest is still in `in-progress/` (no move), (v) the outer `runStartLoop` continues to next candidate.
- (d) **Two-iteration rework convergence:** dev → reviewer NEEDS CHANGES → dev → reviewer NEEDS CHANGES → dev → reviewer READY FOR MERGE. Assert (i) six `taskSpawn` calls in the precise dev/reviewer alternation, (ii) the final on-disk manifest reads `rework_count: 2`, (iii) AC2 verbatim chat line appears twice in `chatLog` — once with `<n>` = `1`, once with `<n>` = `2`.

**AC5:**
**Given** the new files added by this story —
- `plugins/crew/mcp-server/src/skills/handoff-parser.ts`
- `plugins/crew/mcp-server/src/skills/verdict-parser.ts`
- `plugins/crew/mcp-server/src/skills/dev-reviewer-cycle.ts`

— and the updated skill file `plugins/crew/skills/start/SKILL.md`,
**When** each file is inspected,
**Then** the following anchors MUST be present:
- (i) `handoff-parser.ts` exports a named `HANDOFF_PHRASE_TEMPLATE` constant whose value is exactly `"Handoff to reviewer — story <story-id> ready for review."` (anchor: file contains the substring `HANDOFF_PHRASE_TEMPLATE = "Handoff to reviewer — story <story-id> ready for review."`);
- (ii) `verdict-parser.ts` exports a named `VERDICT_SENTINELS` constant containing the three strings `READY FOR MERGE`, `NEEDS CHANGES`, and `BLOCKED` (anchor: each substring appears as a string-literal value in the file);
- (iii) `dev-reviewer-cycle.ts` contains the verbatim string `re-spawning generalist-dev subagent (rework iteration` (per AC2 chat-line anchor — minus the closing parenthesis so the test pins the prefix without coupling to `<n>` interpolation syntax);
- (iv) `dev-reviewer-cycle.ts` contains the verbatim string `handoff grammar drift — story` (per AC3 chat-line anchor);
- (v) `plugins/crew/skills/start/SKILL.md` contains a new `# Inner cycle: dev → reviewer → rework` section (H1 or H2; both accepted) whose prose contains the verbatim string `spawn the generalist-reviewer subagent via Claude Code's Task tool`;
- (vi) `plugins/crew/skills/start/SKILL.md`'s `# Failure modes` section names the new typed error class `HandoffGrammarDriftError` AND the new manifest-state value `blocked_by: handoff-grammar`;
- (vii) `plugins/crew/skills/start/SKILL.md`'s front-matter `allowed_tools` array equals exactly the set `{getStatus, mintSessionUlid, runDevSession}` (set-equality, order-agnostic — assert as an unordered set, catching both a missing entry and any unexpected additional entry). Post-4.3, the SKILL.md prose calls only these three MCP tools directly per Task 6.2: `getStatus` (preflight), `mintSessionUlid` (session ID), and `runDevSession` (the bundled loop body). `buildPersonaSpawnPrompt` is no longer listed because it is wrapped by `runDevSession`'s internals and is not invoked from SKILL.md prose. The handoff/verdict parsers and manifest rework-rewrite happen inside the orchestrator session and do not get their own MCP tool entries.

<!-- AC5 inspects internal source files and skill front-matter — no user-surface rubric applies. AC5 is the deterministic content-structure check the brief requires; the anchors make the AC mechanically checkable. The story_shape: user-surface tag is justified by AC1/AC2/AC3, which are user-surface. -->

---

## Behavioural contract

The `/crew:start` skill's inner cycle (dev → reviewer → rework) is governed by prompt-level and parser-level invariants stated in absolute modal language. The two LLM surfaces this story touches are (a) the dev subagent's terminal-line emission (already pinned by `generalist-dev.md`'s `locked_phrases.handoff`) and (b) the reviewer subagent's terminal-line emission (already pinned by `generalist-reviewer.md`'s `locked_phrases.verdict`). The orchestrator-side parsers and the orchestration logic between them are plain TypeScript; their invariants are pinned here so future edits to either persona OR either parser can be reviewed against a fixed contract. Both new parser source files MUST cite this section by file path (`_bmad-output/implementation-artifacts/4-3-dev-reviewer-handoff-reviewer-spawn-and-rework-signal.md § Behavioural contract`) in TSDoc at the top of the file so a future parser-editor can find the source of the invariants.

### Handoff parser invariants

- **MUST** match the verbatim phrase `Handoff to reviewer — story <story-id> ready for review.` where `<story-id>` is the live story ref (string equality after substitution). The match is anchored to a single line (the line is the entire content between two newlines, ignoring trailing whitespace). The em-dash character `—` (U+2014) is part of the literal; an en-dash (`–`, U+2013) or a hyphen (`-`) does NOT match — this is required to keep the locked phrase distinguishable from natural prose.
- **MUST NOT** match a paraphrase. Examples that MUST fail:
  - `Handoff to the reviewer — story 01ABC ready for review.` (extra "the")
  - `Handoff to reviewer - story 01ABC ready for review.` (hyphen, not em-dash)
  - `Handoff to reviewer — story 01ABC ready for review!` (exclamation, not period)
  - `handoff to reviewer — story 01ABC ready for review.` (case mismatch on first word)
  - `Handoff to reviewer — story <story-id> ready for review.` (literal placeholder, not substituted) — see § Live-ref substitution below.
- **MUST** take the LAST non-empty line of the dev subagent's final-output transcript and compare it with strict `===` against the expected literal (the substituted handoff phrase). If the last non-empty line is not an exact match, return `{ ok: false, reason: "drift" }` — even if an earlier line in the transcript was a valid match. Last-line semantics: the dev's final terminal utterance is the only one that counts; a dev that emits the correct phrase mid-transcript and then says anything else fails as drift.
- **MUST** treat an empty transcript or an all-whitespace transcript as `{ ok: false, reason: "empty" }` (per AC3). A transcript whose last non-empty line is unrelated is a `drift` event, not an `empty` event.
- **MUST** verify the `<story-id>` token in the matched line equals the live story ref. A correct phrase with a wrong ref (e.g. dev claimed `01ABC` and emitted handoff for `01DEF`) is a grammar-drift event — the dev MUST NOT redirect the reviewer to a different story.
- **MUST** be implemented as a pure function `parseHandoff(transcript: string, expectedRef: string): { ok: true } | { ok: false; reason: "drift" | "empty" }`. The unsubstituted-placeholder case (a transcript line containing literal `<story-id>` instead of the live ref) is one flavour of grammar drift — it returns `drift`, same as any other paraphrase or mismatch; the outer cycle treats it identically. No regex backtracking, no LLM-driven matching, no `eval`. The function MUST be unit-tested against all bullet examples above.

### Verdict parser invariants

- **MUST** match the verbatim sentinel grammar `**Verdict: <SENTINEL>**` where `<SENTINEL>` ∈ `{READY FOR MERGE, NEEDS CHANGES, BLOCKED}`, on the LAST non-empty line of the reviewer transcript. Lines after the sentinel are tolerated only if they are entirely whitespace.
- **MUST** tolerate an optional trailing `[<bracket-content>]` after the closing `**` (e.g. `**Verdict: NEEDS CHANGES** [2 issues, 0 questions]` or `**Verdict: BLOCKED** [reviewer-grammar-error]`). The bracket content is captured as `details: string | undefined` but is NOT consulted by this story's logic — Story 4.6b / 4.7 will use it.
- **MUST NOT** match a paraphrase. Examples that MUST fail:
  - `Verdict: READY FOR MERGE` (missing `**` bolding)
  - `**Verdict: READY-FOR-MERGE**` (hyphenated, not spaced)
  - `**Verdict: ready for merge**` (lowercase sentinel)
  - `**Verdict: APPROVED**` (unrecognised sentinel value)
- **MUST** treat any of (empty transcript / no sentinel match / unrecognised sentinel) as `parseVerdict` returning `{ ok: false; reason: "drift" | "empty" | "unknown-sentinel" }`. The orchestrator handles a failed verdict parse the same way it handles a failed handoff parse — drift means block. (Pattern §12 from epic; full treatment in Story 4.6b. For this story, the inner cycle treats parse-fail by setting `blocked_by: "reviewer-grammar"` on the in-progress manifest and surfacing a verbatim chat line `reviewer grammar drift — story <story-id> blocked. expected verbatim final line: "**Verdict: <SENTINEL>**" where SENTINEL is one of READY FOR MERGE | NEEDS CHANGES | BLOCKED.` — see Task 4.3 for the chat-surface contract.)
- **MUST** be implemented as a pure function `parseVerdict(transcript: string): { ok: true; sentinel: VerdictSentinel; details?: string } | { ok: false; reason: "drift" | "empty" | "unknown-sentinel" }`.

### Inner-cycle orchestration invariants

- **MUST** spawn the reviewer via Claude Code's `Task` tool — never via a direct shell-out, a Bash invocation, an in-process function call, or by reusing the dev subagent's context. The clean-context guarantee (FR24, FR27) is structural.
- **MUST** call `buildPersonaSpawnPrompt({ targetRepoRoot, role: "generalist-reviewer" })` exactly once per reviewer spawn — never cache across spawns. A persona-knowledge edit between dev and reviewer turns MUST be picked up at the next reviewer spawn.
- **MUST** preserve the `sessionUlid` of the outer `/crew:start` invocation across every inner-cycle spawn (both reviewer and re-spawned dev). The reviewer's `claimed_by` field is NOT mutated — only the dev's initial-claim ULID lives in the manifest. The reviewer's spawn carries the ULID in its initial-context block (`session_ulid` field) for telemetry purposes only.
- **MUST NOT** call `claimStory` for the reviewer spawn — the story is already claimed by the dev. The reviewer is a follow-on actor in the same claim window.
- **MUST NOT** call `completeStory` from inside the inner cycle when the verdict is `READY FOR MERGE`. Story 4.10b's auto-merge gate (or the operator's manual merge in v1) is what eventually closes the loop; the inner cycle returns control to `runStartLoop` with the manifest still in `in-progress/`. This is intentional — the story is "done from the dev/reviewer perspective" but not yet "merged"; conflating those would force premature `completeStory` calls before the PR is closed. (Story 4.10b will wire `completeStory` to the merge event.)
- **MUST** rewrite the in-progress manifest atomically via `writeManagedFile` whenever it mutates `rework_count` or `blocked_by`. No partial writes. Mirror the `claim-story.ts` / `complete-story.ts` precedent for managed writes.
- **MUST** increment `rework_count` BEFORE re-spawning the dev — the new value MUST be visible on-disk to anyone reading the manifest concurrently (a debugging operator running `cat .crew/state/in-progress/<story-id>.yaml`).
- **MUST NEVER** modify `sprint-status.yaml`, any source story file, any `.git/` content, or any file outside `<targetRepoRoot>/.crew/state/in-progress/`. The inner cycle's only write surface is the active in-progress manifest and the chat output.
- **MUST** terminate the inner cycle naturally — either on a `READY FOR MERGE` verdict (return to outer loop), a `BLOCKED` verdict (return to outer loop; the reviewer's `BLOCKED` is informational, not a manifest mutation in this story), a handoff grammar-drift event (manifest stamped `blocked_by: handoff-grammar`, return), or a verdict grammar-drift event (manifest stamped `blocked_by: reviewer-grammar`, return). The inner cycle MUST NOT recurse beyond the natural rework loop driven by `NEEDS CHANGES` verdicts.
- **MUST NOT** post any chat surface line OTHER than those enumerated in AC1 / AC2 / AC3 and the BLOCKED-passthrough line (`reviewer verdict: BLOCKED — story <story-id> awaiting human` — verbatim). No emoji, no decorative prefixes, no JSON wrapping.

### Live-ref substitution (a load-bearing detail)

The dev subagent's catalogue persona at `plugins/crew/catalogue/generalist-dev.md` line 15 declares `handoff: "Handoff to reviewer — story <story-id> ready for review."` — the `<story-id>` token is a literal placeholder in the catalogue. When the persona is hired (Story 2.4's `instantiatePersona`), the placeholder is NOT substituted — the team/ persona file carries the same literal. When the dev subagent is spawned via `buildPersonaSpawnPrompt` (Story 4.2), the persona body is concatenated verbatim into the system prompt, including the placeholder. The dev subagent is therefore receiving a phrase with `<story-id>` in it; for the subagent to emit a substituted phrase, two things MUST hold:

- The dev subagent's initial-context block (passed by `runStartLoop`) MUST include the live `ref` field (per Story 4.2 § AC1 — already shipped). The subagent reads the ref from its context.
- The dev subagent's persona prompt MUST instruct it to substitute the ref into the locked phrase at emission time. The catalogue body line 30 says `Open the PR with the locked handoff phrase` — implicit; Story 4.3 makes this instruction explicit by appending one sentence to the assembled prompt's `## Locked phrases` block (introduced in Story 4.2 Task 4.3) BEFORE the spawn. **Concrete instruction:** when `build-persona-spawn-prompt.ts` assembles the prompt for either `generalist-dev` or `generalist-reviewer`, it appends to the `## Locked phrases (do not paraphrase)` block one extra line for each phrase containing a `<...>` token: `Substitute <story-id> with the live story ref from your initial context before emission; emit the substituted phrase verbatim.` This makes the substitution requirement LLM-readable. The `build-persona-spawn-prompt.ts` change is in scope for this story (Task 5).

(An alternative considered: pre-substitute the ref in the persona body before composing the spawn prompt. Rejected because the substitution is per-story-spawn and the persona body is per-role — substitution would require carrying the ref into `buildPersonaSpawnPrompt`'s API, which couples a generic prompt-assembly tool to a specific use case. The chosen path keeps `buildPersonaSpawnPrompt` role-keyed and pushes substitution into the LLM, with an explicit instruction.)

### Manifest re-entry semantics (for grammar-drift recovery)

When `blocked_by: handoff-grammar` (or `blocked_by: reviewer-grammar`) is stamped into the in-progress manifest, the manifest stays in `in-progress/`. The story is NOT moved to a `blocked/` directory (Story 5.1's deliverable). The operator's recovery path:

1. The operator opens `<targetRepoRoot>/.crew/state/in-progress/<story-id>.yaml` and removes the `blocked_by:` key.
2. The operator re-runs `/crew:start`.
3. `claimStory` (Story 4.1) does NOT re-claim the story — it's already claimed (`claimed_by` is set, `status: "in-progress"`). Story 4.2's `runStartLoop` enumerates `to-do/` only — it does NOT re-enter the inner cycle for already-claimed in-progress stories.

This is a known v1 gap. The full recovery requires Story 5.1's `blockStory` + the `blocked/` directory + a recovery-from-blocked path. For v1, the operator's recovery is to manually delete the in-progress manifest and re-add the source story to `to-do/` — clumsy but viable. Document this in SKILL.md's failure-modes section so the operator knows the limitation.

(An alternative considered: have `runStartLoop` also re-scan `in-progress/` for stories with `blocked_by` set but no active session, and re-enter the inner cycle. Rejected: bleeds Story 5.1's scope into Story 4.3 and complicates the chaos-test invariant — "no manifest observed in two state dirs" — that Story 4.1 pinned. Defer to 5.1.)

---

## Tasks / Subtasks

- [ ] **Task 1 — Handoff parser (AC: 1, 3, 4, 5)**
  - [ ] 1.1 Create `plugins/crew/mcp-server/src/skills/handoff-parser.ts`. Top of file: TSDoc citing § Behavioural contract by full path.
  - [ ] 1.2 Export `HANDOFF_PHRASE_TEMPLATE = "Handoff to reviewer — story <story-id> ready for review."` (verbatim; the `—` is U+2014).
  - [ ] 1.3 Export `parseHandoff(transcript: string, expectedRef: string): HandoffParseResult` (typed union per § Behavioural contract).
  - [ ] 1.4 Implementation: split transcript on `\n`, trim trailing whitespace per line, find the LAST non-empty line. Build the expected literal by replacing `<story-id>` in `HANDOFF_PHRASE_TEMPLATE` with `expectedRef`. Compare with strict `===`. If no match, walk backwards to see if any prior line equals the expected literal — if YES (a dev that emitted the phrase mid-transcript and then said something else), still return drift (the last line is the canonical terminal action). The unsubstituted-placeholder case (last line equals the template with literal `<story-id>` still present) is just one flavour of drift — `===` will fail and the function returns `{ ok: false, reason: "drift" }`; no special-casing needed.
  - [ ] 1.5 No `console.*`. No I/O. Pure function.

- [ ] **Task 2 — Verdict parser (AC: 2, 4, 5)**
  - [ ] 2.1 Create `plugins/crew/mcp-server/src/skills/verdict-parser.ts`. Top of file: TSDoc citing § Behavioural contract.
  - [ ] 2.2 Export `VERDICT_SENTINELS = ["READY FOR MERGE", "NEEDS CHANGES", "BLOCKED"] as const` and a `VerdictSentinel` type.
  - [ ] 2.3 Export `parseVerdict(transcript: string): VerdictParseResult` (typed union per § Behavioural contract). The result on success: `{ ok: true, sentinel: VerdictSentinel, details?: string }`.
  - [ ] 2.4 Implementation: find last non-empty line. Match against the regex `/^\*\*Verdict: (READY FOR MERGE|NEEDS CHANGES|BLOCKED)\*\*(?: \[([^\]]*)\])?$/`. Note the `^`/`$` anchors are applied to the LINE not the transcript — use a per-line match, not `RegExp.MULTILINE` on the whole transcript (avoids accidental matches embedded in arbitrary middle prose).
  - [ ] 2.5 No `console.*`. No I/O. Pure function.

- [ ] **Task 3 — Inner-cycle orchestration helper (AC: 1, 2, 3, 4)**
  - [ ] 3.1 Create `plugins/crew/mcp-server/src/skills/dev-reviewer-cycle.ts`. Top of file: TSDoc citing § Behavioural contract; export shape mirrors `start-loop.ts`'s injectable-deps style.
  - [ ] 3.2 Export `runDevReviewerCycle(opts: RunDevReviewerCycleOptions): Promise<RunDevReviewerCycleResult>` where:
    ```ts
    interface RunDevReviewerCycleOptions {
      targetRepoRoot: string;
      sessionUlid: string;
      ref: string;
      title: string;
      manifestPath: string; // absolute path to in-progress/<story-id>.yaml
      deps: RunDevReviewerCycleDeps;
    }
    interface RunDevReviewerCycleDeps {
      buildPrompt: (opts: { targetRepoRoot: string; role: "generalist-dev" | "generalist-reviewer" }) => Promise<{ systemPrompt: string }>;
      taskSpawnWithTranscript: (args: TaskSpawnWithTranscriptArgs) => Promise<{ transcript: string }>;
      readManifest: (absPath: string) => Promise<ExecutionManifest>;
      writeManifest: (absPath: string, manifest: ExecutionManifest, opts: { role: string }) => Promise<void>;
    }
    interface RunDevReviewerCycleResult {
      chatLog: string[];
      finalState: "ready-for-merge" | "needs-changes-resolved" | "blocked-handoff-grammar" | "blocked-reviewer-grammar" | "blocked-reviewer-verdict";
    }
    ```
    The `taskSpawnWithTranscript` shape is a thin extension of Story 4.2's `taskSpawn` that returns the subagent's final-output transcript text. See § Implementation strategy for why this changes the seam shape.
  - [ ] 3.3 Implementation outline:
    1. Build the dev prompt; spawn dev; capture transcript.
    2. Run `parseHandoff(transcript, ref)`. On drift / empty: rewrite manifest with `blocked_by: "handoff-grammar"`, push AC3 verbatim chat line, return `finalState: "blocked-handoff-grammar"`.
    3. On handoff parse-ok: push the AC1 verbatim chat line; build reviewer prompt; spawn reviewer; capture transcript.
    4. Run `parseVerdict(reviewerTranscript)`. On drift / empty / unknown-sentinel: rewrite manifest with `blocked_by: "reviewer-grammar"`, push verbatim drift line, return `finalState: "blocked-reviewer-grammar"`.
    5. On `READY FOR MERGE`: push `reviewer verdict: READY FOR MERGE — story <story-id> ready for merge gate`, return `finalState: "ready-for-merge"`.
    6. On `BLOCKED`: push `reviewer verdict: BLOCKED — story <story-id> awaiting human`, return `finalState: "blocked-reviewer-verdict"`.
    7. On `NEEDS CHANGES`: read manifest; increment `rework_count` (default `undefined → 1`); write manifest; push AC2 verbatim chat line with the new `<n>`; re-spawn dev; GOTO step 2.
  - [ ] 3.4 No `console.*`. Chat output flows through the returned `chatLog: string[]`. Errors flow through typed-error contracts: on a `writeManagedFile` failure, propagate the error (`runStartLoop` will surface it verbatim per Story 4.2 § Behavioural contract).
  - [ ] 3.5 Recursion bound: implemented as a `while` loop, not actual recursion. No artificial cap on iterations — see § does NOT (j).

- [ ] **Task 4 — Wire the cycle into `runStartLoop` (AC: 1, 2, 3, 4)**
  - [ ] 4.1 Modify `plugins/crew/mcp-server/src/skills/start-loop.ts`'s `processCandidate` function: replace the existing `await deps.taskSpawn({...})` block (which spawns the dev subagent and waits for it to terminate) with `await runDevReviewerCycle({ targetRepoRoot, sessionUlid, ref, title: displayTitle, manifestPath: <absolute-resolved-path>, deps: ... })`.
  - [ ] 4.2 Extend `RunStartLoopDeps` to include the four new dependencies needed by `runDevReviewerCycle` (`taskSpawnWithTranscript`, `readManifest`, `writeManifest` — note `buildPrompt` is already injected per Story 4.2). The existing `taskSpawn` field in `RunStartLoopDeps` is REPLACED with `taskSpawnWithTranscript` whose return shape is `{ transcript: string }` rather than `void`. Production callers (`register.ts` wiring) MUST update accordingly — see Task 6.
  - [ ] 4.3 The verbatim Story 4.2 chat lines (`claiming <story-id> — <title>` and `spawning generalist-dev subagent (clean context)`) are still emitted by `processCandidate` BEFORE delegating to `runDevReviewerCycle` — `runDevReviewerCycle` does NOT re-emit them. Once delegated, the cycle's `chatLog` is appended into the outer `chatLog`.
  - [ ] 4.4 If `runDevReviewerCycle` throws (a typed error from `writeManagedFile`, `claimStory`'s `InProgressHandEditError` propagated through the manifest reader, etc.), `processCandidate` surfaces it verbatim per the existing pattern and continues to the next candidate.
  - [ ] 4.5 Update Story 4.2's existing integration tests under `mcp-server/src/skills/__tests__/start-skill.integration.test.ts` — the fake `taskSpawn` now returns a transcript. Each existing test case MUST supply a happy-path handoff phrase in its fake transcript so the dev → reviewer cycle terminates cleanly (or supply a reviewer-fake whose transcript ends with `**Verdict: READY FOR MERGE**`). The Story 4.2 tests cover the OUTER loop's behaviour; they MUST continue to pass after the inner cycle is added.

- [ ] **Task 5 — Extend `buildPersonaSpawnPrompt` to instruct ref-substitution (AC: 1, 4)**
  - [ ] 5.1 Modify `plugins/crew/mcp-server/src/tools/build-persona-spawn-prompt.ts`'s assembly logic (Story 4.2 Task 4.2/4.3). When appending the `## Locked phrases (do not paraphrase)` block, for each phrase string that contains a `<...>` token (`<role>`, `<story-id>`, `<intent>`, `<next role>`, `<SENTINEL>` — pattern: any `<` followed by non-`>` characters followed by `>`), append one additional line: `Substitute <token> with the live value from your initial context before emission; emit the substituted phrase verbatim.` Repeat per token. If the phrase has no tokens, no additional line.
  - [ ] 5.2 Update the unit test at `plugins/crew/mcp-server/src/tools/__tests__/build-persona-spawn-prompt.test.ts`: add a case asserting that for `generalist-dev`, the assembled prompt contains the substitution instruction for `<story-id>` (per `generalist-dev.md` line 15). Add a similar assertion for `generalist-reviewer` (whose verdict phrase contains `<SENTINEL>`).
  - [ ] 5.3 Add a regression assertion: a phrase WITHOUT a `<...>` token (none exist in v1 catalogue but the test guards against future additions) does NOT receive a spurious substitution instruction.

- [ ] **Task 6 — Production wiring in `register.ts` (AC: all)**
  - [ ] 6.1 The wiring of `runStartLoop` lives inside the `crew:start` skill's runtime (not as an MCP tool). In v1 the wiring is invoked by SKILL.md prose through the MCP tools it exposes. The four new dependencies (`taskSpawnWithTranscript`, `readManifest`, `writeManifest`, and the unchanged `buildPrompt`) are NOT new MCP tools — they are internal seams.
    - **Decision:** to avoid introducing operator-facing MCP tools whose only use is wiring (which would inflate the allowlist and increase the surface area the dev subagent might mis-use), the production caller composes them in-process. The SKILL.md prose calls `buildPersonaSpawnPrompt` and `claimStory` (already-allowed MCP tools); the inner-cycle logic, manifest reads/writes, and parser invocations are all bundled into a NEW MCP tool `runDevSession` introduced in this story. See Task 6.2.
  - [ ] 6.2 Create `plugins/crew/mcp-server/src/tools/run-dev-session.ts`. This tool is the single MCP-tool entry point for the entire `/crew:start` loop body (outer + inner). The skill's SKILL.md prose is reduced to "call `getStatus`, mint a `sessionUlid`, then call `runDevSession({ targetRepoRoot, sessionUlid })`". The tool internally wires `runStartLoop` and `runDevReviewerCycle` with the production dependencies (`listClaimableTodos`, `claimStory`, `buildPersonaSpawnPrompt`, the Claude Code `Task` tool — wrapped to capture transcript text, see § Implementation strategy — `parseExecutionManifest`, and `writeManagedFile`).
  - [ ] 6.3 Register `runDevSession` in `plugins/crew/mcp-server/src/tools/register.ts`. Tool count bumps 18 → 19 (per Story 4.2's existing assertions in `ask-mode-enforcement.test.ts`, `ask-skill.test.ts`, `get-team-snapshot.test.ts` — update each from 18 to 19).
  - [ ] 6.4 Add `runDevSession` to `plugins/crew/skills/start/SKILL.md` front-matter `allowed_tools`. The dev and reviewer subagent permission specs MUST NOT include `runDevSession` — it is `/start`-only.
  - [ ] 6.5 Update SKILL.md prose: the `# Steps` section is simplified to point at `runDevSession` (the loop is no longer step-by-step in SKILL.md prose; the prose says "call `runDevSession`; surface any thrown typed error verbatim; the tool's return value carries a `chatLog: string[]` — print each entry to the operator in order"). The verbatim AC3 (Story 4.2) queue-drained line and AC5(iii) (Story 4.2) spawn-instruction string MUST remain in the SKILL.md body (the existing Story 4.2 content-structure test asserts them — do not regress). Add the new `# Inner cycle: dev → reviewer → rework` section per AC5(v).

- [ ] **Task 7 — Manifest schema extension (AC: 2, 3, 4, 5)**
  - [ ] 7.1 Edit `plugins/crew/mcp-server/src/schemas/execution-manifest.ts`. Add a new optional field to `ExecutionManifestSchema`:
    ```ts
    /**
     * Count of NEEDS CHANGES verdict rounds the dev/reviewer pair has run on
     * this story. `undefined` ≡ `0`. Incremented in-place by Story 4.3's
     * inner cycle on every NEEDS CHANGES verdict.
     *
     * Added in Story 4.3 (FR28).
     */
    rework_count: z.number().int().nonnegative().optional(),
    ```
    Place this AFTER the existing `claimed_by` field (the `.strict()` schema requires every key be declared).
  - [ ] 7.2 Extend the `blocked_by` union to admit `"handoff-grammar"` and `"reviewer-grammar"` as recognised literal values (in addition to the existing `"planning-discipline"` and `"source-drift"` literals, and the string-fallback). Updated shape:
    ```ts
    blocked_by: z
      .union([
        z.literal("planning-discipline"),
        z.literal("source-drift"),
        z.literal("handoff-grammar"),
        z.literal("reviewer-grammar"),
        z.string(),
      ])
      .optional(),
    ```
    Keep the trailing `z.string()` fallback for forward compatibility (Story 5.1's full taxonomy will register more values).
  - [ ] 7.3 Update tests in `plugins/crew/mcp-server/src/schemas/__tests__/execution-manifest.test.ts` (or whatever file currently covers the schema — locate via `grep -l ExecutionManifestSchema mcp-server/src/schemas/__tests__/`): add cases asserting a manifest with `rework_count: 3` parses successfully and a manifest with `rework_count: -1` raises `MalformedExecutionManifestError`. Add cases asserting `blocked_by: "handoff-grammar"` and `blocked_by: "reviewer-grammar"` parse successfully.
  - [ ] 7.4 No source-story format change. The field is manifest-only. `scan-sources.ts` does NOT need to populate `rework_count` — its absence is the implicit default `0`.

- [ ] **Task 8 — Unit tests for parsers (AC: 1, 2, 3, 4, 5)**
  - [ ] 8.1 `mcp-server/src/skills/__tests__/handoff-parser.test.ts` covers every bullet under § Handoff parser invariants:
    - happy path (exact phrase, exact ref) → `{ ok: true }`
    - paraphrases listed in the invariants section → each → `{ ok: false, reason: "drift" }` (or `"empty"` for the empty transcript case)
    - en-dash / hyphen substitution → drift
    - case mismatch on first word → drift
    - placeholder NOT substituted (literal `<story-id>` in the matched line) → `{ ok: false, reason: "drift" }`
    - extra whitespace after the period → match succeeds (trailing whitespace tolerated per implementation)
    - multiple historical matches with a paraphrase last line → drift (last-line semantics)
  - [ ] 8.2 `mcp-server/src/skills/__tests__/verdict-parser.test.ts` covers every bullet under § Verdict parser invariants:
    - each of the three sentinels (with and without bracket trailer)
    - paraphrases listed in invariants → drift / unknown-sentinel as appropriate
    - empty transcript → empty
    - whitespace-only transcript → empty
    - sentinel embedded mid-transcript with unrelated last line → drift
    - bracket trailer with unusual content (e.g. `[]`, `[unicode-content]`) → parses, `details` captured

- [ ] **Task 9 — Unit test for `runDevReviewerCycle` (AC: 1, 2, 3, 4)**
  - [ ] 9.1 `mcp-server/src/skills/__tests__/dev-reviewer-cycle.test.ts` — fixture tmpdir with a pre-claimed in-progress manifest. Use fakes for `buildPrompt`, `taskSpawnWithTranscript`, `readManifest`, `writeManifest`. Cover:
    - (a) happy handoff + READY FOR MERGE → no manifest writes, `finalState: "ready-for-merge"`, chatLog contains AC1 verbatim
    - (b) NEEDS CHANGES → manifest write with `rework_count: 1` → second cycle happy → final manifest read shows `rework_count: 1`, chatLog contains AC2 verbatim with `<n>` = `1`
    - (c) handoff drift → manifest write with `blocked_by: "handoff-grammar"`, `finalState: "blocked-handoff-grammar"`, no reviewer spawn, chatLog contains AC3 verbatim
    - (d) reviewer verdict drift → manifest write with `blocked_by: "reviewer-grammar"`, `finalState: "blocked-reviewer-grammar"`, chatLog contains the verbatim reviewer-drift line per § Behavioural contract
    - (e) BLOCKED verdict → no manifest write, `finalState: "blocked-reviewer-verdict"`, chatLog contains the verbatim BLOCKED passthrough line
    - (f) two-iteration rework convergence (NEEDS CHANGES → NEEDS CHANGES → READY FOR MERGE) → manifest `rework_count: 2`, chatLog has the AC2 verbatim line twice with `<n>` = `1` then `<n>` = `2`
  - [ ] 9.2 The fixture manifest reader/writer pair uses real `node:fs/promises` against the tmpdir; the `Task`-spawn fake records its calls and returns whatever transcript the test case scripted.

- [ ] **Task 10 — Integration test through `runDevSession` (AC: 4, 5)**
  - [ ] 10.1 `mcp-server/src/tools/__tests__/run-dev-session.test.ts` — end-to-end with all real wiring EXCEPT the Claude Code `Task` tool, which is faked. Cover AC4 branches (a)–(d) per the AC table. Each fixture seeds a target-repo tmpdir with `.crew/config.yaml`, a hired generalist-dev persona, a hired generalist-reviewer persona (Story 2.4's `instantiatePersona` precedent), and a populated `.crew/state/to-do/` with one or more refs. The fake `Task` returns scripted transcripts.
  - [ ] 10.2 Assertions:
    - AC4(a): **two** `taskSpawn` calls recorded in order (generalist-dev then generalist-reviewer) with distinct system prompts; first prompt contains the dev persona body, second prompt contains the reviewer persona body; chat log contains the handoff-received line verbatim; manifest ends up in `in-progress/` with no `blocked_by` and no `rework_count`.
    - AC4(b): one rework iteration recorded; final manifest has `rework_count: 1`.
    - AC4(c): handoff drift on first dev → manifest has `blocked_by: "handoff-grammar"`, no reviewer spawn for that story.
    - AC4(d): two reworks; final manifest `rework_count: 2`.

- [ ] **Task 11 — Content-structure tests for AC5 anchors (AC: 5)**
  - [ ] 11.1 Update or extend `mcp-server/src/skills/__tests__/start-skill-content.test.ts` (Story 4.2 Task 8.6 introduced this file) to include the AC5(v)/(vi)/(vii) anchors:
    - assert the SKILL.md body contains `# Inner cycle: dev → reviewer → rework` (header line — H1 `#` or H2 `##` both accepted via regex)
    - assert the body contains the verbatim string `spawn the generalist-reviewer subagent via Claude Code's Task tool`
    - assert the `# Failure modes` section contains the substring `HandoffGrammarDriftError` AND the substring `blocked_by: handoff-grammar`
    - assert that the SKILL.md front-matter `allowed_tools` array equals exactly the set `{"getStatus", "mintSessionUlid", "runDevSession"}` (set-equality, order-agnostic) — parse the front-matter YAML and compare as a set so future re-orderings don't break the test, and so the assertion catches both a missing entry and any unexpected additional entry. These are the three MCP tools the SKILL.md prose calls directly post-4.3 per Task 6.2; `buildPersonaSpawnPrompt` is wrapped by `runDevSession` and intentionally absent.
  - [ ] 11.2 Add `mcp-server/src/skills/__tests__/parsers-content.test.ts` that:
    - reads `handoff-parser.ts` and asserts the literal `HANDOFF_PHRASE_TEMPLATE = "Handoff to reviewer — story <story-id> ready for review."` is present (file substring match)
    - reads `verdict-parser.ts` and asserts each sentinel string is present as a file substring
    - reads `dev-reviewer-cycle.ts` and asserts the AC5(iii) and AC5(iv) verbatim chat-line prefixes are present as file substrings

- [ ] **Task 12 — Update Story 4.2 tool-count assertions and final wiring (AC: all)**
  - [ ] 12.1 Bump tool-count assertions across `mcp-server/tests/ask-mode-enforcement.test.ts`, `mcp-server/tests/ask-skill.test.ts`, `mcp-server/tests/get-team-snapshot.test.ts` from 18 to 19 (one new tool: `runDevSession`).
  - [ ] 12.2 Run `pnpm build` at the plugin root. Commit `plugins/crew/mcp-server/dist/` per CLAUDE.md §Process notes.
  - [ ] 12.3 Run the full vitest suite. All existing tests MUST remain green.
  - [ ] 12.4 Static-fs-guard check: the new parser files (`handoff-parser.ts`, `verdict-parser.ts`) MUST NOT import `node:fs` at all — they are pure string functions. `dev-reviewer-cycle.ts` does NOT import `node:fs` directly either — manifest I/O is routed through the injected `readManifest`/`writeManifest` seams. The new `run-dev-session.ts` MAY import `writeManagedFile` (via the `lib/managed-fs.js` whitelist) and `parseExecutionManifest`. The existing `canonical-fs-guard.test.ts` enforces this.
  - [ ] 12.5 No telemetry emit. Story 4.12 owns telemetry. The inner cycle's `chatLog` is the only operator surface.

---

## Implementation strategy

### Why a new `taskSpawnWithTranscript` seam (replacing Story 4.2's `taskSpawn`)

Story 4.2's `taskSpawn` was `(args) => Promise<void>` — fire-and-forget; the loop continues when the subagent finishes. That shape is fine for the dev-only loop, but the inner cycle needs the dev subagent's final-output transcript to parse for the locked handoff phrase. The simplest evolution is to extend the seam: `taskSpawnWithTranscript` returns `{ transcript: string }` where `transcript` is the concatenated final-output text of the spawned subagent.

In production, the Claude Code `Task` tool returns a structured result that includes the subagent's terminal output. The wrapping function in `run-dev-session.ts` extracts the relevant text field and returns it as the `transcript` string. Tests pass a fake whose `transcript` is whatever the test case scripted.

The narrower alternative (a second seam for "give me the last transcript line") was rejected: the parsers need the full transcript to detect drift cases like "the handoff phrase was emitted mid-transcript but the last line is unrelated."

### Why bundle everything into one `runDevSession` MCP tool

Three options were considered:

- (a) **Expose every seam as an MCP tool.** Operator-facing surface area inflates; the dev/reviewer subagents (whose tool allowlists are tight per Stories 2.2 / 2.3) would either accidentally have access or require separate whitelists.
- (b) **Drive the inner cycle from SKILL.md prose.** The LLM-driven skill prose would need to: call `claimStory`, build the dev prompt, spawn dev, capture transcript, parse the phrase, possibly write the manifest, build the reviewer prompt, spawn reviewer, etc. This embeds non-trivial control flow in LLM prose — the exact failure mode the user-surface AC convention is designed to prevent.
- (c) **Bundle everything into one MCP tool (`runDevSession`).** The SKILL.md prose is reduced to "call this one tool; surface its `chatLog` to the operator." All control flow lives in plain TypeScript, exhaustively unit-tested.

Chose (c). This is the same precedent Story 4.2 set with `listClaimableTodos` (folding the queue-pre-scan + deps-check into one tool to keep the SKILL.md prose simple).

### Manifest-write atomicity for `rework_count` increment

The increment is a read-modify-write on `<targetRepoRoot>/.crew/state/in-progress/<story-id>.yaml`. The "atomic" guarantee comes from `writeManagedFile`'s underlying `tmp + rename` (Story 1.6's primitive). Within the inner cycle, there is only one writer: the orchestrator session that claimed the story. Concurrent writers are structurally impossible because `claimStory` mints exactly one `claimed_by` per story, and `runDevSession` runs serially per ref.

The dev subagent itself does NOT write to the manifest — its persona allowlist (per Story 4.2 Task 5) contains `claimStory` / `completeStory` / `blockStory` / `readSourceStory` etc., but not a direct manifest-write tool. The `rework_count` increment is exclusively an orchestrator concern.

### Why grammar drift does NOT move the manifest to `blocked/`

Story 5.1 (Epic 5) introduces the `blocked/` directory and the `blockStory` MCP tool that atomically moves a manifest there. Until 5.1 lands, Story 4.3 has two choices for grammar-drift handling:

- (i) Block the entire Epic 4 chain on Story 5.1.
- (ii) Stamp `blocked_by` into the in-progress manifest in-place; defer the directory move to 5.1's retrofit.

Chose (ii). The in-place stamp is a complete signal: the manifest reader can detect a blocked-in-progress story by checking `blocked_by !== undefined`. Future Story 5.1's migration will (a) detect any existing `blocked_by`-stamped in-progress manifests at startup, (b) atomically move them to `blocked/`, (c) update `runDevSession`'s grammar-drift path to call `blockStory` instead of the in-place stamp. Story 5.1's retrofit is one find-replace and a new integration test.

### Why the BLOCKED verdict does NOT stamp `blocked_by`

A reviewer's `**Verdict: BLOCKED**` is an informational signal in v1 — the reviewer noticed something the dev/reviewer cycle cannot resolve (an under-specified story, a missing dependency the reviewer surfaced, etc.). The standard recovery is operator intervention. Stamping `blocked_by` on the manifest in this case would conflate the reviewer's "I can't verdict this" with the orchestrator's "this needs a human" — semantically different. The verbatim chat line `reviewer verdict: BLOCKED — story <story-id> awaiting human` is the orchestrator surface; the operator reads it and either edits the story or moves on. Story 4.8 (reviewer labelling) and Story 5.1 (`blocked_by` taxonomy) together formalise the BLOCKED handling — for v1, the inner cycle just returns control.

### Recursion depth and "stuck loop" risk

The rework loop is unbounded. A pathological dev/reviewer pair that emits `NEEDS CHANGES` forever will spin until the operator notices (or Story 4.12's 30-min dev budget triggers the stuck-story surface). This is acceptable for v1 — the agreement-metric machinery (Story 4.10) and the auto-merge gate (Story 4.10b) are what eventually catch a pathological pair by surfacing the rolling agreement ratio.

Adding an explicit `max_rework_count` cap was considered. Rejected for v1 because:
- a wrong cap (too low) silently kills a story the pair was about to converge on
- a wrong cap (too high) doesn't prevent the pathological case
- the cap is a calibration knob best added with empirical data

A future Epic 5 / 6 story can add the cap if telemetry shows the need.

### Chat-surface wording

All verbatim chat lines from this story are pinned in § Behavioural contract and the ACs. They share the precedent set by Story 4.2 (`claiming <story-id> — <title>`, `spawning generalist-dev subagent (clean context)`, the queue-drained line): plain ASCII, no emoji, no decorative prefixes, em-dash separator where used. The drift lines are intentionally long-form because they double as operator recovery instructions.

---

## Architecture compliance

- **`Task` tool is the only canonical subagent-spawn primitive.** Architecture §Per-story subagent. Both the dev re-spawn and the reviewer spawn route through `Task`. Mirrors Story 4.2's compliance.
- **Persona injection at spawn time, single read.** Architecture §Persona injection. `buildPersonaSpawnPrompt` is called once per spawn (per role); the reviewer's persona is read fresh on each spawn so accumulated knowledge (Story 6's `appendPersonaKnowledge`) is in scope.
- **Filesystem is the only coordination surface (NFR19).** The inner cycle's only on-disk write is the in-progress manifest. No new lockfile, no new daemon. The fact that `claimStory` already pinned exclusive access (one `claimed_by` per ref) means there is no race window in the rework increment.
- **MCP tool naming.** One new tool: `runDevSession`. CamelCase verb-noun. Flat namespace.
- **No new MCP server, no new package.** All work lands inside `plugins/crew/mcp-server/`.
- **No `gh` invocation from `/start` or `runDevSession`.** Story 4.4 owns `gh`; the dev subagent calls it via its allowlist; the orchestrator does not.
- **No source-side writes.** The inner cycle is read-only against source stories.
- **`docs/standards.md` is untouched.** Story 4.6 owns reviewer-side standards reads; the orchestrator does not consult standards in this story.
- **Locked-phrase contract (Architecture §Implementation patterns line 7).** The locked phrases live in the catalogue persona files; the parsers in this story consume them verbatim. The phrase strings are NOT duplicated in `handoff-parser.ts` source — the template lives there, and the test asserts the catalogue value matches. (If a future catalogue edit changes the phrase, the parser test fails — that is the intended coupling.) See Task 1.2 for the constant declaration.

## Library / framework requirements

- **No new top-level dependencies.** All parsing is pure string ops. `yaml` (Zod) for manifest reads is already a transitive dep.
- **TypeScript conventions** per § 6 of `implementation-patterns-consistency-rules.md`: kebab-case filenames (`handoff-parser.ts`, `verdict-parser.ts`, `dev-reviewer-cycle.ts`, `run-dev-session.ts`), named exports only, no `any`, typed errors extending `DomainError`.
- **New typed error class:** `HandoffGrammarDriftError extends DomainError` — emitted by the parser when the orchestrator wants a thrown signal rather than a tagged-union result (the orchestrator pattern-matches on the tagged-union return per the parser invariants; the error class is reserved for the SKILL.md failure-modes documentation and for any caller that prefers exception-style flow control). Declared in `plugins/crew/mcp-server/src/lib/errors.ts` (the existing typed-error hub — confirm path at implementation time; mirror `DependenciesNotReadyError` from Story 4.1 if the hub layout differs).

## File structure requirements

New files:
- `plugins/crew/mcp-server/src/skills/handoff-parser.ts`
- `plugins/crew/mcp-server/src/skills/verdict-parser.ts`
- `plugins/crew/mcp-server/src/skills/dev-reviewer-cycle.ts`
- `plugins/crew/mcp-server/src/tools/run-dev-session.ts`
- `plugins/crew/mcp-server/src/skills/__tests__/handoff-parser.test.ts`
- `plugins/crew/mcp-server/src/skills/__tests__/verdict-parser.test.ts`
- `plugins/crew/mcp-server/src/skills/__tests__/dev-reviewer-cycle.test.ts`
- `plugins/crew/mcp-server/src/skills/__tests__/parsers-content.test.ts`
- `plugins/crew/mcp-server/src/tools/__tests__/run-dev-session.test.ts`

Modified files (UPDATE, not NEW — read fully before editing):
- `plugins/crew/mcp-server/src/skills/start-loop.ts` — replace `taskSpawn` dep with `taskSpawnWithTranscript`; delegate inner cycle to `runDevReviewerCycle` (Task 4).
- `plugins/crew/mcp-server/src/tools/build-persona-spawn-prompt.ts` — extend locked-phrases block with per-token substitution instructions (Task 5).
- `plugins/crew/mcp-server/src/tools/build-persona-spawn-prompt.test.ts` — add the substitution-instruction assertions (Task 5.2/5.3).
- `plugins/crew/mcp-server/src/schemas/execution-manifest.ts` — add `rework_count` field, extend `blocked_by` union (Task 7).
- `plugins/crew/mcp-server/src/tools/register.ts` — register `runDevSession` (Task 6.3).
- `plugins/crew/skills/start/SKILL.md` — add `# Inner cycle` section, update `# Steps` to point at `runDevSession`, add `runDevSession` to `allowed_tools`, extend `# Failure modes` (Task 6.4/6.5).
- `plugins/crew/mcp-server/tests/ask-mode-enforcement.test.ts` — tool-count 18 → 19.
- `plugins/crew/mcp-server/tests/ask-skill.test.ts` — tool-count 18 → 19.
- `plugins/crew/mcp-server/tests/get-team-snapshot.test.ts` — tool-count 18 → 19.
- `plugins/crew/mcp-server/src/skills/__tests__/start-skill.integration.test.ts` — fake-transcripts updated so the outer-loop tests don't drift into the inner cycle's grammar-drift path (Task 4.5).
- `plugins/crew/mcp-server/src/skills/__tests__/start-skill-content.test.ts` — add AC5(v)/(vi) assertions (Task 11.1).
- `plugins/crew/mcp-server/src/schemas/__tests__/execution-manifest.test.ts` (or equivalent) — add rework_count / blocked_by cases (Task 7.3).

Files explicitly NOT modified:
- `plugins/crew/permissions/generalist-dev.yaml` — no permission entries change. The dev subagent's existing allowlist already supports its re-spawn (no new tool calls).
- `plugins/crew/permissions/generalist-reviewer.yaml` — no permission entries change. The reviewer's existing allowlist is what Story 4.6 / 4.6b will consume; this story spawns the subagent but does not implement its internal behaviour.
- `plugins/crew/catalogue/generalist-dev.md` — catalogue persona body unchanged. The substitution instruction is appended at spawn time by `buildPersonaSpawnPrompt`, not baked into the catalogue.
- `plugins/crew/catalogue/generalist-reviewer.md` — same.
- `plugins/crew/mcp-server/src/tools/claim-story.ts` / `complete-story.ts` — unchanged. The inner cycle does not claim or complete; it operates within the dev's existing claim window.
- `plugins/crew/mcp-server/src/skills/__tests__/start-skill-content.test.ts` — the existing Story 4.2 assertions (queue-drained line, AC5(iii) spawn-instruction string) MUST remain green; only ADDITIONS are made.

Build output (regenerate, do not hand-edit):
- `plugins/crew/mcp-server/dist/` — committed per CLAUDE.md §Process notes.

## Testing requirements

- **vitest** (project precedent). Co-locate tests with production modules under `__tests__/`. New integration test under `mcp-server/src/tools/__tests__/run-dev-session.test.ts`.
- **Tmpdir fixtures** for manifest I/O. Real `node:fs/promises mkdtemp` + `afterEach` cleanup. Mirror `claim-story.test.ts`.
- **No mocking of `node:fs`.** Real reads/writes against tmpdirs.
- **`Task`-tool fake** in every integration test. The fake records its call args (system prompt, initial context) and returns whatever transcript the test scripts.
- **Parser tests are pure.** No I/O; just string inputs and expected typed-union outputs.
- **Content-structure tests are mandatory** per the brief: they pin the verbatim file contents that AC5 asserts.
- **Chat-output verbatim assertions** use `expect(chatLog).toContain("<verbatim string>")` — exact-string match, no regex tolerance. Drift breaks the test.
- **No `console.log` / `console.error`** in any new production file. Errors flow through typed-error contracts; chat output flows through the returned `chatLog`.
- **Coverage target:** every AC4 branch has a named test. Every § Behavioural contract bullet has at least one assertion (parser tests cover the parser invariants; the cycle test covers the orchestration invariants).

## Previous story intelligence

- **Story 4.2 (just landed):** Shipped `/crew:start`, `runStartLoop`, `buildPersonaSpawnPrompt`, `listClaimableTodos`, `mintSessionUlid`. Story 4.3's inner cycle plugs into `runStartLoop.processCandidate` — replacing the one-shot `taskSpawn` with a `runDevReviewerCycle` call. The fake-transcript pattern (`taskSpawnWithTranscript`) extends Story 4.2's `taskSpawn` seam. Story 4.2's content-structure test (`start-skill-content.test.ts`) is the precedent for Story 4.3's `parsers-content.test.ts`.
- **Story 4.1:** Shipped `claimStory` and `completeStory`. Story 4.3 does NOT call either from the inner cycle — the claim is already held by the dev session, and the complete signal (PR merge) lives outside this story. Story 4.1's atomic-rename precedent informs the `writeManagedFile` use here for in-place mutation: even though no rename occurs, the tmp+rename guarantees a consistent on-disk view of the mutated manifest.
- **Story 3.7:** Shipped `detectInProgressHandEdit`. Story 4.3's manifest writes go through `writeManagedFile` which (per Story 1.6) already coordinates with the hand-edit detector. If the operator hand-edits the in-progress manifest BETWEEN the dev's handoff and the reviewer's spawn, the next manifest-write attempt by `runDevReviewerCycle` will trigger the hand-edit guard via `writeManagedFile` and propagate `InProgressHandEditError`. This is the expected behaviour — surface verbatim, do NOT auto-recover.
- **Story 3.4 / 3.5 / 3.6:** Shipped `parseExecutionManifest`, the planning-discipline gate, `isClaimable`. The inner cycle uses `parseExecutionManifest` (via `readManifest` dep) for every manifest read. No new discipline-gate touches.
- **Story 2.3 / 2.4:** Shipped `readPersona`, `instantiatePersona`. Story 4.2's `buildPersonaSpawnPrompt` (also from 2.3 era — confirm) is extended in this story to add per-token substitution instructions.
- **Story 1.6 (canonical-fs guard):** Forbids non-whitelisted files from importing write-shaped `node:fs` APIs. Story 4.3's parser files MUST NOT import `node:fs` at all (pure functions). `dev-reviewer-cycle.ts` does manifest I/O via injected seams. `run-dev-session.ts` is the production wiring caller — it MAY import `writeManagedFile` from the whitelist.
- **Lesson from Epic 3 retro (2026-05-21):** "Don't ship user-surface ACs whose chat surface depends on a deferred caller." Story 4.3's AC1 / AC2 / AC3 chat surfaces are runnable on day-one of merge — every dependency (`Task`, `buildPersonaSpawnPrompt`, `writeManagedFile`, `parseExecutionManifest`, and the new parsers) is shipped in this story or earlier. No paper promises.
- **Lesson from Epic 3 retro: `detectInProgressHandEdit` wiring.** Already wired in Story 4.1. The inner cycle inherits the wiring for free via `writeManagedFile`.
- **Lesson from Story 1.7 / 1.7a retro:** Pre-PR smoke gate (Story 1.8) requires user-surface evidence. Story 4.3 is a `user-surface` story; the gate will require either an automated e2e (the AC4 integration test through `runDevSession` counts) or an operator-pasted Claude Code transcript showing the dev → reviewer handoff on a fixture target repo. Both routes are open; ship-story chooses.

## References

- Epic source: `_bmad-output/planning-artifacts/epics/epic-4-dev-review-loop-the-engineering-heart.md` § Story 4.3 (lines 56–72).
- PRD: `_bmad-output/planning-artifacts/prd-crew-v1/functional-requirements.md` FR26 (dev → reviewer handoff), FR27 (per-story reviewer subagent), FR28 (rework signal).
- Predecessor spec (Story 4.2): `_bmad-output/implementation-artifacts/4-2-start-skill-and-per-story-dev-subagent-spawn.md` — especially § Behavioural contract, Task 4 (buildPersonaSpawnPrompt composition), Task 8 (start-loop seam pattern).
- Predecessor spec (Story 4.1): `_bmad-output/implementation-artifacts/4-1-claim-story-dependency-check-and-complete-story-mcp-tools.md` — claim window semantics, atomic-rename pattern.
- Architecture: `_bmad-output/planning-artifacts/architecture/core-architectural-decisions.md` § Agent invocation model (per-story subagent + persona injection + verdict marker).
- Architecture: `_bmad-output/planning-artifacts/architecture/implementation-patterns-consistency-rules.md` § 7 (Locked phrases), § 4 (MCP tool naming), § 6 (TypeScript conventions).
- User-surface AC convention: `plugins/crew/docs/user-surface-acs.md`.
- Catalogue: `plugins/crew/catalogue/generalist-dev.md` — `locked_phrases.handoff` source of truth.
- Catalogue: `plugins/crew/catalogue/generalist-reviewer.md` — `locked_phrases.verdict` source of truth; reviewer mandate.
- Source: `plugins/crew/mcp-server/src/skills/start-loop.ts` (Story 4.2 — Task 4 extends this).
- Source: `plugins/crew/mcp-server/src/tools/build-persona-spawn-prompt.ts` (Story 4.2 — Task 5 extends this).
- Source: `plugins/crew/mcp-server/src/tools/claim-story.ts` (Story 4.1 — write-managed pattern reference).
- Source: `plugins/crew/mcp-server/src/lib/managed-fs.ts` (`writeManagedFile`).
- Source: `plugins/crew/mcp-server/src/schemas/execution-manifest.ts` (Task 7 extends this).

### Project Structure Notes

- The `plugins/crew/mcp-server/src/skills/` directory introduced by Story 4.2 (for loop-body code that is NOT an MCP tool but is too orchestration-heavy for `src/lib/`) is the natural home for `handoff-parser.ts`, `verdict-parser.ts`, and `dev-reviewer-cycle.ts`. If the architecture review prefers `lib/parsers/` instead, the dev agent SHOULD surface the question rather than picking unilaterally — but the default per Story 4.2's precedent is `skills/`.
- No changes to the plugin's top-level layout, `plugin.json` manifest, or marketplace metadata.
- Plugin semver: additive (one new tool, one new optional manifest field, one new SKILL.md section). A minor bump on `plugins/crew/.claude-plugin/plugin.json` is appropriate but NOT required if Story 4.2 already bumped this cycle's version — confirm at implementation time.

## Dev Agent Record

### Agent Model Used

_Filled by the dev agent at implementation time._

### Debug Log References

_Filled by the dev agent at implementation time._

### Completion Notes List

_Filled by the dev agent at implementation time._

### File List

_Filled by the dev agent at implementation time._

### Change Log

_Filled by the dev agent at implementation time._
