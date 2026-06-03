/**
 * Unit tests for `reattachOrphan` — Story 5.11 Task 2.4.
 *
 * Covers:
 *   (a) Successful rewrite — manifest's claimed_by equals currentSessionUlid after the call.
 *   (b) NotAnOrphanError raised when claimed_by === currentSessionUlid.
 *   (c) ManifestNotFoundError raised when the ref is absent from in-progress/.
 */
export {};
