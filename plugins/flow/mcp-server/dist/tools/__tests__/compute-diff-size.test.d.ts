/**
 * Unit tests for `computeDiffSize` / `isGeneratedDiffPath` (Stage-2 fix):
 * the risk-tier diff-size measurement must count authored SOURCE lines only,
 * excluding committed `dist/` build output and dependency lockfiles — otherwise
 * crew's committed dist roughly doubles a source change's line count and
 * defeats the `low.additive-only` size cap.
 */
export {};
