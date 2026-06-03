/**
 * Tests for the retro-analyst's persona-append proposal drafting —
 * Story native:01KT47PSWEBAX6QZB8SR8HDYBQ.
 *
 * This story makes the retro-analyst emit `persona-append` proposals that
 * write a role-attributable lesson into a hired role's Knowledge section,
 * drawn from the cycle's done-manifest lessons and recurring friction. The
 * persona-append schema + apply handler + registry were introduced by the
 * dependency story (native:01KT474NN9F3HWM6HVR07PHZD7); this story's job is
 * the analyst-side: the catalogue prompt discipline plus the deterministic
 * write/round-trip contract those proposals flow through.
 *
 * The acceptance criteria are about the LLM analyst's behaviour, but the
 * load-bearing seam is deterministic (memory `feedback_default_to_deterministic_seams`,
 * `project_reviewer_first_call_enforcement_needed`): a prose-only mandate gets
 * skipped under load, so what makes the behaviour binding is (a) the STRICT
 * discipline section in the catalogue prompt, (b) the `getTeamSnapshot` tool
 * wired into the analyst's allowlist so it can resolve roles, and (c) the
 * `writeRetroProposal` + schema boundary that refuses a malformed or empty-lesson
 * persona-append. These tests pin all three with no LLM invocation.
 *
 * AC1 (integration): Given a cycle with at least one done manifest carrying a
 *   per-role lesson (or a non-empty recurringFriction signal), the produced
 *   proposal file can carry at least one persona-append proposal naming a
 *   specific hired role and a concise lesson drawn from that cycle's data — and
 *   the prompt instructs the analyst to draft exactly that.
 *
 * AC2 (unit): Given a cycle with no per-role lesson signal and no recurring
 *   friction, the proposal file contains zero persona-append proposals — the
 *   prompt instructs the analyst to skip drafting, and an empty proposals file
 *   round-trips cleanly.
 *
 * AC3 (unit): Given a persona-append proposal in the produced file, it names a
 *   real hired role (its persona file exists in the team directory, confirmed
 *   via getTeamSnapshot) and the lesson text is grounded in the cycle's data —
 *   not a generic placeholder.
 */
export {};
