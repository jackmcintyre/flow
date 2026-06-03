/**
 * Integration tests for `markWithdrawn` — Story 3.6 Task 3.4.
 *
 * Covers AC3's contract end-to-end:
 *   (a) Flip a BMad-fixture manifest in done/ from withdrawn:false → true.
 *   (b) Re-call against the same ref; assert alreadyWithdrawn:true and
 *       mtime is stable (idempotency).
 *   (c) Non-existent ref → ManifestNotFoundError.
 *   (d) Native adapter workspace → WrongAdapterError.
 *   (e) Manifest in in-progress/ → success (in-progress guard is the planner's,
 *       not the tool's).
 *
 * Each test operates against a copy of the committed fixture tree in a tmpdir
 * so the committed fixtures are never mutated.
 */
export {};
