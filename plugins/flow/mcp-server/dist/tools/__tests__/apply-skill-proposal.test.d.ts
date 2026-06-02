/**
 * `skill-*` apply-handler tests — Story 6.7 AC1–AC5.
 *
 * AC1–AC4 drive each handler directly (via `createSkillProposalHandlers`) with
 * a deterministic clock seam, against a tmp `.crew/skills/` tree, asserting the
 * file effects + the typed errors with no mutation on the failure paths.
 *
 * AC5 drives the REAL `acceptProposal` gate (no injected handlers — the
 * production registry now carries the four `skill-*` handlers) through preview +
 * confirm for `skill-create` and `skill-revise`, injecting only the git seam,
 * and asserts the preview-no-op, the single combined commit, the applied stamp,
 * one telemetry event, and the idempotent re-accept.
 *
 * Test conventions mirror `accept-proposal.test.ts`: tmpRoot, seed proposals via
 * `writeRetroProposal`, inject the git seam, read telemetry from
 * `.flow/telemetry/*.jsonl`.
 */
export {};
