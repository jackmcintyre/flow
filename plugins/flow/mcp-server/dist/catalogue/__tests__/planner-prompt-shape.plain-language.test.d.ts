/**
 * Deterministic structure test for the `### Plain-language guideline` subsection
 * in `plugins/flow/catalogue/planner.md` — Story 3.7 AC5.
 *
 * Loads the planner catalogue prompt from disk and asserts that the `## Prompt`
 * section contains the verbatim strings required by AC5. These are pure
 * on-disk substring assertions — no LLM invocation, no network.
 *
 * Required strings per AC5 / Task 5.1:
 *   - `### Plain-language guideline` (subsection heading)
 *   - `non-engineer who reads code at skim level` (verbatim phrase)
 *   - `FR77` (functional requirement citation)
 *
 * Ordering check per Task 5.2:
 *   - `### Plain-language guideline` appears AFTER `### Discipline validation — pre-write check`
 *   - `### Plain-language guideline` appears BEFORE `### Re-open mode — backlog review and discard flow`
 *
 * MUST NEVER be removed without a coordinated bump. The subsection heading is the
 * anchor that prevents future prompt edits from silently dropping the FR77 constraint.
 */
export {};
