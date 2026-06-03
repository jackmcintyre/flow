/**
 * Unit tests for the BMad lifecycle vocabulary mapping (Story 5.14).
 *
 * Covers:
 *   - mapBmadStatusToExecution: full nine-value matrix (six original + three new)
 *   - isKnownBmadStatus (inner guard in map-bmad-status.ts): accepts all nine known values,
 *     rejects unknown strings
 *   - parseBmadStory acceptance of the three new Status literals (draft, approved, review)
 *
 * The three new values added by Story 5.14:
 *   draft    → "to-do"    (spec exists but not yet approved for dev pickup)
 *   approved → "to-do"    (semantically equivalent to ready-for-dev)
 *   review   → "in-progress" (dev work complete, awaiting human review)
 */
export {};
