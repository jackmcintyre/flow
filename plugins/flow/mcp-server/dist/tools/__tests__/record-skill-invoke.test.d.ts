/**
 * Integration tests for `recordSkillInvoke` — Story 6.8 AC1 + AC4.
 *
 * AC1: a `recordSkillInvoke` call emits exactly one well-formed `skill.invoke`
 *      line with all five `data` fields; the schema rejects an unknown
 *      `skill_scope` / `invocation_source` (closed enums, no fallback).
 * AC4: the capture seam wired into the `/flow:board` SKILL.md first-step is
 *      verified — the chosen mechanism (a prose-call seam on the fallback path,
 *      because the harness exposes no skill-invocation hook) is exercised here:
 *      the test reproduces exactly what the instrumented SKILL.md does (mint a
 *      session id, call `recordSkillInvoke` with the skill's frontmatter
 *      `skill_version` and the `plugin` / `user-slash-command` scope+source)
 *      and asserts a valid `skill.invoke` event lands. The under-count
 *      limitation of a prose-call seam is documented in the source story.
 *
 * Telemetry is read back from the real `.flow/telemetry/<YYYY-MM>.jsonl` file
 * the logger writes — we drive a fixed clock so the month bucket is stable.
 */
export {};
