/**
 * Corpus integration test for parseBmadStory (Story 5.14 AC2 + Story 5.17 AC2).
 *
 * Walks every .md file in the real repo's _bmad-output/implementation-artifacts/
 * that matches the parser's expected filename pattern (<epic>-<story>-<slug>.md,
 * where epic and story are pure digits). This mirrors the BMAD_FILENAME_RE used
 * by listSourceStories in the BmadAdapter — retro docs, sprint-status.yaml, and
 * sub-story variants with letter suffixes (1-7a, 3-3b, etc.) are skipped exactly
 * as the real scanner skips them.
 *
 * Story 5.14 AC2 focus: zero Status-vocabulary MalformedBmadStoryError throws.
 * After Story 5.14 widens the vocabulary to include draft/approved/review,
 * no file in this corpus should fail on `unknown Status value '...'`.
 *
 * Story 5.17 AC2 focus: full pipeline parse gate.
 * After Story 5.17 widens the AC-heading regex to accept the descriptive
 * `**AC<n> — <title>:**` shape, every parseable file MUST complete the full
 * parseBmadStory pipeline without throwing AND yield a non-empty
 * acceptance_criteria array. The 17 files that previously failed on AC-heading
 * format (1-1, 1-2, 1-2b, 1-3, 1-4, 1-5, 1-6, 1-7, 1-7a, 1-10, 1-13,
 * 2-4, 2-5, 4-2, 5-10, 5-12, 5-14) must now parse cleanly.
 *
 * Path arithmetic (7 `..` from __dirname to repo root):
 *   __tests__/ → bmad/ → adapters/ → src/ → mcp-server/ → crew/ → plugins/ → repo root
 */
export {};
