/**
 * Tests for the skill-effectiveness retro signal — Story native:01KT49PKTMJPJM7WMCB67TA6EY.
 *
 * AC1 (integration): Given a cycle in which at least one skill was invoked and at
 *   least one story reached a READY FOR MERGE verdict, gatherRetroInputs returns a
 *   skillEffectiveness bundle whose per_skill map carries invoke_count,
 *   useful_fire_count, and effectiveness_ratio for each skill that fired — so the
 *   analyst can cite specific numbers without re-deriving them from raw telemetry.
 *
 * AC2 (unit): The retro-analyst catalogue prompt instructs the analyst to cite
 *   effectiveness_ratio and invoke_count from skillEffectiveness.per_skill when
 *   drafting a skill-retire or skill-revise proposal, and to never recount
 *   invocations from raw telemetry — the same discipline enforced for the
 *   fire-count and recurring-friction signals.
 *
 * AC3 (unit): Given a cycle with no skill-invoke telemetry, gatherRetroInputs
 *   completes without error and skillEffectiveness.per_skill is an empty map —
 *   the retro does not fail or skip due to an absent signal.
 *
 * AC1/AC3 use real tool implementations against a temp filesystem (mirroring
 * retro-friction-signal.test.ts); AC2 reads the real catalogue via readCatalogue
 * (mirroring retro-persona-append-proposals.test.ts) — no mocks of the things
 * under test.
 */
export {};
