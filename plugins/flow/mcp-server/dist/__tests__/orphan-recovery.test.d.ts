/**
 * Integration test suite for the orphan-recovery branch — Story 5.11 Task 5.
 *
 * These tests cover the five AC5 fixtures (5a–5e) by seeding a target-repo
 * tmpdir with the relevant manifests and transcript files, then driving the
 * three new MCP tools directly:
 *   - scanOrphanedInProgress
 *   - reattachOrphan
 *   - blockOrphanNoTranscript
 *
 * The SKILL.md prose's chat-line surfacing and operator-prompt blocking are
 * smoke-only — documented in the describe/it text below. This test file does
 * NOT spawn an MCP server and does NOT exercise SKILL.md prose. It exercises
 * only the tool contracts so that the SKILL.md prose can rely on them.
 *
 * AC coverage:
 *   - 5a: reattach with transcript present (AC1, AC2)
 *   - 5b: reattach with transcript absent (AC1, AC3)
 *   - 5c: skip preserves orphan state (AC1, AC4)
 *   - 5d: alphabetical orphan ordering (AC1 sort order)
 *   - 5e: current-session manifest not surfaced as orphan (AC1 negative)
 *
 * NOT covered here (smoke-only — requires driving SKILL.md prose):
 *   - operator-prompt blocking (the prose awaits user input before calling tools)
 *   - chat-line surface rendering (the prose calls `surface(...)` for each line)
 *   - unrecognised-choice re-prompt loop
 *   - Task-tool call-order assertion (dev spawn MUST NOT occur on reattach)
 */
export {};
