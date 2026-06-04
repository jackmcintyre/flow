/**
 * Tests for the mechanical-failure hardening-story draft — Story
 * native:01KT6RHTE3YME1ZAD5VRQAKDSW.
 *
 * AC1 (integration): Given a retro cycle whose lessons include at least two
 *   entries with the same kind and failure_class, When the retro loop runs,
 *   Then a hardening story appears in the backlog parked not-ready — visible in
 *   /flow:board — proposing a code guard against that failure class.
 *
 * AC2 (unit): Given a retro cycle whose lessons do not contain repeated
 *   mechanical failures, When the retro loop runs, Then no hardening story is
 *   drafted and the backlog is unchanged.
 *
 * AC3 (unit): Given a recurring failure that has already produced a not-ready
 *   hardening story in the backlog, When the retro loop runs again before that
 *   story is built, Then no duplicate hardening story is drafted.
 *
 * All tests use real tool implementations against a temp filesystem (same
 * pattern as retro-friction-signal.test.ts) — no mocks of the things under
 * test.
 */
export {};
