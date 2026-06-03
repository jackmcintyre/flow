/**
 * Integration tests for the inner dev → reviewer cycle through tool composition
 * — Story 4.3b Task 10; Story 4.3c Task 6.
 *
 * Behavioural contract source:
 *   _bmad-output/implementation-artifacts/4-3b-harness-task-spawn-seam-for-rundevsession.md § Behavioural contract
 *   _bmad-output/implementation-artifacts/4-3c-call-completestory-after-ready-for-merge.md § Behavioural contract
 *
 * Composes `processDevTranscript`, `processReviewerTranscript`, and `claimNextStory`
 * in the order the SKILL.md prose will compose them. The Claude Code `Task` tool is
 * NOT in the loop — this is a unit-level integration test of the MCP layer's
 * composition correctness.
 *
 * NOTE (Story 4.3c): `completeStory` is no longer called directly by the test code
 * on the green branch. `processReviewerTranscript` calls `completeStory` internally
 * when it parses a `READY FOR MERGE` verdict. The test asserts the side-effect by
 * inspecting the on-disk manifest state after `processReviewerTranscript` returns.
 * The `completeStory` import is retained for the blocked-branch negative assertions.
 *
 * Each test case seeds a fixture tmpdir with:
 *   - `.flow/config.yaml` (native adapter)
 *   - `.flow/state/in-progress/<ref>.yaml` (pre-claimed manifest)
 *   - `team/generalist-dev/PERSONA.md`
 *   - `team/generalist-reviewer/PERSONA.md`
 *
 * Covers the AC4 branches (a)–(g):
 *   (a) Happy handoff + READY FOR MERGE.
 *   (b) Rework loop: NEEDS CHANGES × 1 → READY FOR MERGE.
 *   (c) Grammar drift (handoff drift).
 *   (d) Two-iteration rework convergence.
 *   (e) Reviewer grammar drift.
 *   (f) Reviewer BLOCKED passthrough.
 *   (g) Tool count assertion (22 tools, contains new tools, does not contain runDevSession).
 *
 * AC4 (4.3c) — two-story drain via processReviewerTranscript internal seam:
 *   Two stories driven through claimNextStory → processDevTranscript →
 *   processReviewerTranscript (which internally calls completeStory and returns
 *   completed: true), then third claimNextStory returns queue-drained.
 *   (h) Blocked branch: processReviewerTranscript does NOT move manifest, returned
 *       object has no `completed` field.
 *   (i) Reviewer-grammar-drift branch: same MUST NOT pattern as (h).
 *
 * Story 4.3b Task 10.1–10.4; Story 4.3c Task 6.1–6.6.
 */
export {};
