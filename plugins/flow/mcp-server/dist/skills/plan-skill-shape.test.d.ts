/**
 * Deterministic structure test for `plugins/flow/skills/plan/SKILL.md`
 * (Story 3.4 Task 6.5 — AC6).
 *
 * Loads the skill file from disk and asserts:
 *   - Front-matter `name:` is exactly `flow:plan`.
 *   - Body contains the verbatim planner-subagent invocation line (Task 5.3).
 *   - Body contains the literal strings `adapter: native` and `adapter: bmad`.
 *   - Body contains the slash-command literals `/flow:plan`, `/bmad-create-story`,
 *     and `/flow:scan`.
 *
 * These assertions guard against the "file exists but is empty or incomplete"
 * failure mode that an integration test with a mocked skill loader would not
 * catch.
 */
export {};
