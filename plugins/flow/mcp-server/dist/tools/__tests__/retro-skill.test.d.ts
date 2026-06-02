/**
 * Story 6.2 AC4 — two-halves test for the `/flow:retro` substrate.
 *
 * Half 1 — Negative-capability allowlist test:
 *   Loads the PRODUCTION `plugins/flow/permissions/retro-analyst.yaml` (no
 *   fixtures, no mocks) and asserts:
 *     (a) `tools_allow` CONTAINS the four read-only / write-bounded affordances
 *         the analyst is meant to have: Read, gatherRetroInputs,
 *         writeRetroProposal, Task.
 *     (b) `tools_allow` DOES NOT contain any tool that mutates canonical state.
 *         Explicit deny-list assertion against the known mutators, plus a regex
 *         catch-all for any future apply* / regenerate* / mutate* / delete* tool.
 *   This is the load-bearing seam — memory `project_reviewer_first_call_enforcement_needed`
 *   shows prose-only mandates get skipped under load; the YAML denial is what
 *   makes FR60 binding. (AC4 half 1)
 *
 * Half 2 — Fixture-cycle gather test:
 *   Seeds a tmp `.crew/` with three done/ manifests (one with lessons populated,
 *   one without lessons, one with `lessons: []`), one telemetry file with three
 *   valid events plus one corrupted line, and two prior proposals. Calls
 *   `gatherRetroInputs` and asserts the returned bundle shape. (AC4 half 2)
 *
 * Both halves are pure deterministic — no LLM invocation, no network.
 */
export {};
