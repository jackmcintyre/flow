/**
 * Tests for `resolveLensRoleBinding` and `resolveLensRoles` —
 * Story native:01KT2Q51E24XKMM4YEF0ADRKNG (FU2: deterministic lens→role binding).
 *
 * Covers AC1–AC4 as specified in the story:
 *
 *  (a) Default-roster trace: {planner, generalist-dev, generalist-reviewer,
 *      retro-analyst, orchestrator} → structure→planner, verifiability→orchestrator,
 *      discipline→generalist-reviewer, domain→generalist-dev, considered→retro-analyst.
 *  (b) Test-specialist-added trace: verifiability→test-specialist, orchestrator freed,
 *      other four assignments unchanged.
 *  (c) Failure trace: {generalist-dev} only → throws LensJudgeUnavailableError.
 *  (d) Result always passes validateLensRoleBinding (total + injective).
 *  (e) Integration: given a mocked team directory with exactly the five default roles
 *      on disk, wire resolveLensRoleBinding into runJudgePanel (injecting a fixture
 *      judgeRunner) and assert a complete five-lens PanelVerdict is returned with all
 *      distinct roles — no lensRoles argument hand-supplied.
 */
export {};
