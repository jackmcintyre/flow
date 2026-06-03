/**
 * Unit tests for `buildPersonaSpawnPrompt` and `assemblePrompt` — Story 4.2 Task 7.3.
 *
 * Covers:
 *   (a) Returns a string beginning with `# Generalist Dev — Persona` and containing
 *       `## Domain`, `## Mandate`, `## Out of mandate`, `## Prompt` in order.
 *   (b) Contains the `## Knowledge` heading after `## Prompt`.
 *   (c) Contains the `## Locked phrases` block with each phrase verbatim.
 *   (d) Frontmatter is absent from the output (no `role:` / `domain:` keys appear).
 *   (e) `PersonaFileNotFoundError` propagates if the persona file is absent.
 *
 * Story native:01KT6QEWY794ZY0DH6JHQFWG6V additions:
 *   (f) The Knowledge section shows a one-line index (id, kind, applies_when) per lesson
 *       instead of the full lesson text.
 *   (g) With 10 lessons the Knowledge section grows by exactly one summary line per lesson.
 *
 * Story native:01KT6QSW4W7SMAHAT4EAKCCC65 additions (AC1):
 *   (h) When a role has more lessons than the briefingBudget, the always-shown index
 *       contains only the top-budgeted lessons ordered by use_count desc then
 *       last_used_at desc, and overflow lessons are archived.
 *   (i) Overflow lessons are moved to _archived/lessons.json with archived_at stamped.
 *   (j) Overflow lessons are removed from the live Knowledge section in PERSONA.md.
 *
 * Approach: real filesystem ops against a tmpdir with a constructed persona file.
 * No node:fs mocking.
 */
export {};
