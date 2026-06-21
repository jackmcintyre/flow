# Story 5.21: Reviewer first-tool-call deterministic seam

story_shape: substrate
Status: done

## Story

As a **plugin operator**,
I want **the reviewer cycle to be structurally incapable of completing without `runReviewerSession` having been called first**,
So that **a reviewer subagent that reasons around its prose mandate (skipping the tool call entirely) cannot waste a spawn and force manual recovery**.

This story is independent — no spec or code dependencies on other in-flight Epic 5 stories. Pairs in spirit with Story 5.20 (orphan-recovery branch) but they ship separately.

## Acceptance Criteria

**AC1:**

The reviewer-spawning orchestration calls `runReviewerSession` **before** the reviewer subagent begins its turn — either (a) the spawning skill/tool invokes `runReviewerSession` directly as part of constructing the persona spawn prompt, OR (b) a pre-handoff guard in the post-spawn flow fails-loud if `agent_invokes` for the spawned session doesn't contain `runReviewerSession`. Implementation choice (a vs b) is the dev's to make based on which is cleaner — both satisfy the AC. The "first tool call MUST be `runReviewerSession`" prose mandate in `team/generalist-reviewer/PERSONA.md` (or equivalent) becomes belt-and-braces, not load-bearing.
`artifact: plugins/crew/mcp-server/src/tools/build-persona-spawn-prompt.ts OR the reviewer spawn-handler in plugins/crew/mcp-server/src/tools/register.ts (dev picks the seam)`

**AC2:**

The persona prose mandate stays in place as documentation but is no longer the structural enforcement mechanism. A change-log comment near the prose-mandate line names this story and links to the deterministic seam location (file + function name). Future readers learn the prose is non-load-bearing without having to trace runtime behaviour.
`artifact: plugins/crew/team/generalist-reviewer/PERSONA.md (or the reviewer persona file the spawning code consumes — confirm path in dev)`

**AC3 (integration):**

Seed a reviewer-spawn fixture where the simulated subagent's `agent_invokes` record is empty (i.e. the persona skipped the mandated call). Assert the orchestration either (a) injects the `runReviewerSession` call regardless, OR (b) fails-loud with a typed error that names the missing call. Assert the manifest does NOT progress to a verdict without `runReviewerSession` having been invoked at least once for the session.
`vitest: plugins/crew/mcp-server/src/tools/__tests__/reviewer-first-call-seam.test.ts`

**AC4 (integration):**

Seed a reviewer-spawn fixture where the simulated subagent calls `runReviewerSession` as its first action (the happy path). Assert no double-call, no fail-loud, no behavioural drift from the current passing reviewer cycle.
`vitest: plugins/crew/mcp-server/src/tools/__tests__/reviewer-first-call-seam.test.ts`

## Implementation Notes

### Files touched

**MODIFY:**

- `plugins/crew/mcp-server/src/tools/build-persona-spawn-prompt.ts` OR `plugins/crew/mcp-server/src/tools/register.ts` (reviewer spawn-handler) — pick the cleaner seam. The choice between approach (a) call-the-tool-yourself and approach (b) post-spawn-guard depends on how the existing reviewer spawn flow is structured. Read both files before deciding; document the choice in the PR body.
- `plugins/crew/team/generalist-reviewer/PERSONA.md` (or equivalent persona path — confirm by grepping for `runReviewerSession` MUST-call language) — add the change-log comment naming Story 5.21 and pointing to the deterministic seam.

**NEW:**

- `plugins/crew/mcp-server/src/tools/__tests__/reviewer-first-call-seam.test.ts` — vitest fixtures for AC3 (seam enforces) and AC4 (happy path regression). Mock `agent_invokes` shape; assert routing.

### Build artefacts

After any change in `plugins/crew/mcp-server/src/`, the dev agent MUST run `pnpm -r build` and stage the resulting `plugins/crew/mcp-server/dist/` changes in the same commit. CI fails on drift between `src/` and `dist/` per project CLAUDE.md § "Plugin build output is tracked in git".

### Dependencies

None. Leaf story.

### Context (for grounding, not implementation)

- Memory `project_reviewer_first_call_enforcement_needed` carries the canary-1 (bmad:5.19) failure shape: reviewer terminated in 14.7s with 2 tool uses, never invoked `runReviewerSession`, reasoned around the missing `docs/standards.md` and produced a non-verdict. Rubber-stamp guard caught it but the cost was a wasted spawn + manual manifest recovery.
- Memory `feedback_default_to_deterministic_seams` is the project-wide principle: load-bearing decisions live in tool-written artefacts, not LLM prose. This story applies that principle to the reviewer's first-call mandate.
- Memory `feedback_prose_mut_steps_need_seam` is the same shape of fix applied earlier to dev-side mutating steps.
- Carry-forward entry 9 in `_bmad-output/implementation-artifacts/epic-5-carry-forward.md` is the prerequisite write — already authored.
- This story does NOT cover the orphan-recovery reviewer-only re-spawn branch — that's Story 5.20.

### Edge cases worth surfacing in dev/review

- **Approach (a) vs (b) trade-off:** approach (a) is more aligned with the deterministic-seams principle but requires the orchestration to have the inputs `runReviewerSession` needs. Approach (b) is a guard, not a seam — it catches but doesn't prevent. Dev should pick (a) if feasible; document why (b) was chosen if it wasn't.
- **The existing rubber-stamp guard** (`done-blocked-no-session-result`) stays in place as belt-and-braces — it's the downstream safety net. This story closes the upstream gap.
- **Pairs naturally with Story 5.18** (structural parser) — both move load-bearing decisions out of LLM prose. 5.18 is not yet authored; reference for sequencing only.

## Definition of Done

- [ ] All ACs met; all vitest cases green.
- [ ] `pnpm -r build` passes; `dist/` rebuilt and staged.
- [ ] PR opens against `dev`. CI green.
- [ ] Reviewer cycle clean (no rubber-stamp guard fires on this story's PR — meta-validation that the seam works).
- [ ] `_bmad-output/implementation-artifacts/epic-5-carry-forward.md` entry 9 marked "Folded into 5.21."
