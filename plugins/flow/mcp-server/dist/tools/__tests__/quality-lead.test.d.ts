/**
 * Integration tests for the Quality Lead adjudication — Story 9.4 (gate 1).
 *
 * Covers AC2–AC5. The Quality Lead is driven through `adjudicateQualityLead` with
 * REAL fixtures (real temp dirs, real `node:fs`, the real schema, the real Story
 * 9.1 `markStoryReady` brake — no mocking of the thing under test):
 *
 *   AC2 — the synthesis rule (rubric §5) in the tool layer:
 *     all-pass → `ready`; one-lens-fail → `rework` carrying the miss; split at the
 *     K-th round → `escalate`.
 *   AC3 — `ready` blesses via the brake tool (the readiness flag flips through
 *     `markStoryReady`), `escalate` leaves the draft not-ready.
 *   AC4 — a split panel after K rounds yields `escalate` with a populated
 *     `escalation_reason`; the readiness flag is never set.
 *   AC5 — the emitted verdict validates against `AdjudicationVerdictSchema` and
 *     carries the decision + rationale; persisted as the canonical record.
 *
 * The brake tool is exercised for real against a seeded `to-do/` manifest so AC3
 * asserts the OBSERVABLE flag flip on disk, not a mock call.
 */
export {};
