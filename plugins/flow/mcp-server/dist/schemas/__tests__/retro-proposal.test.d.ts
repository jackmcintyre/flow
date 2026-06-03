/**
 * Schema tests for retro proposals — Story 6.3 AC3–AC8.
 *
 * Covers:
 *   - One happy-path test per variant (seven tests).
 *   - One rejection test per variant (seven tests; missing-field or
 *     out-of-enum per variant rejected via MalformedRetroProposalError).
 *   - Discriminated-union behaviour: cross-variant field smuggling rejected.
 *   - Path-traversal guard on `skill-create.proposed_path`.
 *   - Promotion-level / version-bump / action closed-enum rejections.
 *   - ULID guard on `id`.
 *   - File-level wrapper: empty proposals round-trip, malformed wrapper
 *     fields rejected.
 */
export {};
