/**
 * Unit + integration tests for `classifyRiskTier` — AC4 sub-cases (4b)–(4f), (4l), (4m).
 *
 * Story 4.9b — FR40a, Pattern §11.
 *
 * Fixture convention: uses `await fs.mkdtemp(path.join(os.tmpdir(), "classify-risk-tier-"))`.
 * No mocking of `lookupRiskTieringSpec`, `picomatch`, or `logTelemetryEvent`.
 * The classifier runs against the real spec parser and real glob matcher.
 */
export {};
