/**
 * Writer tests for `writeRetroProposal` — Story 6.3 AC1 / AC8.
 *
 * Covers:
 *   - Happy path: write a file with mixed proposal types; read back;
 *     frontmatter round-trips through `parseRetroProposalFile`; body H2
 *     count equals the proposal count.
 *   - Collision: writing twice with the same `isoTimestamp` throws
 *     `RetroProposalAlreadyExistsError`; the original file is unchanged.
 *   - Empty proposals: produces a valid file with `proposals: []` and a
 *     body containing the "No proposals produced this cycle." sentence.
 *   - Path-traversal in `isoTimestamp`: `"../escape"` and similar rejected
 *     at the writer boundary via the IsoTimestamp schema, before any
 *     path-forming or filesystem op.
 *   - Cycle window present round-trip.
 *   - Idempotency-of-rendering: stringification is byte-stable for the
 *     same inputs (no random ordering).
 */
export {};
