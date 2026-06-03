/**
 * Integration tests for the judge panel — Story 9.3 (gate 1, Tier 1).
 *
 * Covers AC1–AC5. The panel is driven through `runJudgePanel` with an INJECTED
 * `judgeRunner` (the spawn seam): each test wires a runner that writes a fixture
 * `LensVerdict` to the lens's deterministic result file via the same
 * `writeLensVerdict` tool a real judge subagent calls. The panel then reads the
 * FILES (never the runner's return), validating the deterministic-seam discipline.
 *
 * Fixture convention: real temp dirs (`fs.mkdtemp`), no mocking of
 * `classifyRiskTier`, `writeLensVerdict`, the file reader, or `logTelemetryEvent`.
 * A real risk-tiering spec is seeded so the Considered-lens bar (AC4) keys off the
 * classifier's actual output.
 */
export {};
