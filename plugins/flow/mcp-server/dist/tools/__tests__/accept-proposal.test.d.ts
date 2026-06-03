/**
 * `acceptProposal` gate tests — Story 6.4 AC1–AC6.
 *
 * The gate is exercised end-to-end against real proposal files (seeded via the
 * canonical `writeRetroProposal` writer) with a TEST-INJECTED fake handler and
 * a TEST-INJECTED git-commit seam. No real git, no real handler — the gate is
 * proven against doubles (Story 6.4 ships ONLY the gate machinery; the
 * production registry is empty by design).
 *
 * AC mapping:
 *   - AC1: locator resolves an id to the right file/proposal; ProposalNotFound;
 *     AmbiguousProposalId.
 *   - AC2: preview-only no-op (status preview, diff present, tree unchanged, no
 *     commit, no telemetry).
 *   - AC3: confirmed apply (handler file changed; one commit carrying handler
 *     file + proposal file; applied block with all three fields; status applied
 *     with sha).
 *   - AC4: idempotent re-run (already-applied; no second handler call, write,
 *     commit, or telemetry).
 *   - AC5: exactly one retro.proposal.applied telemetry event on apply; none on
 *     preview.
 *   - AC6: unregistered kind → ProposalKindNotApplicableYetError; tree +
 *     telemetry untouched.
 */
export {};
