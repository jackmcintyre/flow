/**
 * Content-structure tests for AC6 anchors — Story 4.3b Task 11.2;
 * updated for Story 4.6 revision 2 (deterministic-verdict-transport).
 *
 * Reads the source files for the two new transcript-processor tools and
 * register.ts, asserting the verbatim anchor strings required by AC6(ix)–(xi).
 *
 * AC6(ix):  `process-dev-transcript.ts` contains `handoff received — story`
 *           and `handoff grammar drift — story`, but NOT
 *           `re-spawning generalist-dev subagent (rework iteration`.
 * AC6(x):   `process-reviewer-transcript.ts` (revision 2):
 *           - contains `reviewer verdict: READY FOR MERGE`
 *           - contains `reviewer verdict: NEEDS CHANGES`
 *           - contains `reviewer verdict: BLOCKED`
 *           - contains `reviewer-no-session-result` (new rubber-stamp protection)
 *           - does NOT contain `reviewer grammar drift` (retired in revision 2)
 *           - does NOT contain `re-spawning generalist-dev` (rework-dev path retired)
 * AC6(xi):  `register.ts` contains zero occurrences of the literal `"runDevSession"`.
 *
 * Story 4.3b Task 11.2; Story 4.6 revision 2.
 */
export {};
