/**
 * Story 8.15 — per-story reviewer-result isolation within a session.
 *
 * A `crew-drain` run shares ONE session ULID across every story it processes.
 * Before 8.15 the reviewer verdict was stored at a single per-session path
 * (`.flow/state/sessions/<sessionUlid>/reviewer-result.json`), so the next
 * story's `runReviewerSession` clobbered the previous story's verdict — making a
 * failed verdict-seam unrecoverable, and corrupting verdicts outright under a
 * future parallel drain.
 *
 * This suite exercises the WRITER (`runReviewerSession`) and the READER
 * (`processReviewerTranscript`, plus its shared `readReviewerResultFile`)
 * end-to-end for two distinct refs in ONE session and asserts that writing
 * ref B leaves ref A's verdict intact and independently readable.
 *
 * AC1 — two stories in one session keep independent reviewer-result files.
 * AC2 — writer and reader agree on a per-ref, deterministic, path-safe path;
 *       the colon in a BMad-style ref is sanitised into a path-safe component.
 */
export {};
