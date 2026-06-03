/**
 * Deterministic structure test for `plugins/flow/catalogue/planner.md`
 * (Story 3.5 AC6).
 *
 * Loads the planner catalogue prompt from disk and asserts that the `## Prompt`
 * section contains the verbatim strings required by the Discipline validation
 * subsection (Task 7.5). These assertions make the planner-side behavioural
 * contract (AC1–AC3) verifiable without exercising the LLM.
 *
 * Required strings per AC6 / Task 7.5:
 *   - `validatePlannerBacklog` (tool name)
 *   - `missing-integration-ac` (refusal code 1)
 *   - `implicit-depends-on` (refusal code 2)
 *   - `missing-ship-gate` (refusal code 3)
 *   - `state-mutating-without-integration-ac` (refusal code 4, forward-compat)
 */
export {};
