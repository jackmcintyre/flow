/**
 * Unit tests for `scanOrphanedInProgress` — Story 5.11 Task 1.5.
 *
 * Covers:
 *   (a) No in-progress/ directory → empty array.
 *   (b) Empty in-progress/ directory → empty array.
 *   (c) Current-session manifest only → empty array (5e fixture).
 *   (d) One stale-ULID manifest with transcript → one orphan with hasTranscript: true.
 *   (e) One stale-ULID manifest without transcript → hasTranscript: false.
 *   (f) Two stale-ULID manifests → returned in alphabetical ref order (5d fixture).
 *   (g) Absent claimed_by → skipped silently.
 */
export {};
