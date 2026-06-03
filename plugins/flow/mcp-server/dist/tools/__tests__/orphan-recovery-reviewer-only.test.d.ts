/**
 * Tests for Story 5.20: orphan-recovery reviewer-only re-spawn when PR exists.
 *
 * AC3 (integration): orphan with hasTranscript: false + open PR → hasOpenPR: true,
 *   reattachOrphan called (claimed_by rewritten), no blocked_by stamp.
 *
 * AC4 (regression): same orphan shape but no open PR → hasOpenPR: false,
 *   blockOrphanNoTranscript called, manifest stamped blocked_by: orphan-no-transcript.
 */
export {};
