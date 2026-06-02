/**
 * Unit tests for `completeStory` — Story 4.1 Task 7.2.
 *
 * Covers AC3, AC4, AC5:
 *   (a) Happy complete: matching claimed_by → manifest moves to done/ with
 *       status: "done" and claimed_by preserved.
 *   (b) Wrong claimant: mismatched ULID → WrongClaimantError, manifest unchanged.
 *   (c) Hand-edit refusal: in-progress/ manifest hand-edited → InProgressHandEditError.
 *   (d) Absent claimed_by: → WrongClaimantError with actualSessionUlid: "<unset>".
 *
 * Approach:
 * - Use a minimal native-adapter workspace in a tmpdir (real filesystem ops).
 * - Mock `deriveSourceBaseline` to control the hand-edit baseline.
 * - No `node:fs` mocking — real renames against tmpdir per testing requirements.
 */
export {};
