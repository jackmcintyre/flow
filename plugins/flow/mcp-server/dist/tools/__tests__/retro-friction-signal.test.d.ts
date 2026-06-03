/**
 * Tests for the recurring-friction retro signal — Story native:01KT2RAXBSQ91Y80Z51DD26KPX.
 *
 * AC1 (integration): Given a cycle with >= 2 friction events of the same kind,
 *   gatherRetroInputs returns a recurringFriction entry for that kind with the
 *   correct count — surfacing the seam problem that outcome data alone missed.
 *
 * AC2 (unit): Given valid inputs, recordAgentFriction appends a structured
 *   agent.friction telemetry event to the JSONL file with all structured fields
 *   correct and parseable by TelemetryEventSchema.
 *
 * AC3 (unit): Given exactly 1 friction event of a given kind, gatherRetroInputs
 *   does NOT include that kind in recurringFriction (one-off noise is excluded;
 *   threshold is count >= 2).
 *
 * All tests use real tool implementations against a temp filesystem — no mocks
 * of the things under test.
 */
export {};
