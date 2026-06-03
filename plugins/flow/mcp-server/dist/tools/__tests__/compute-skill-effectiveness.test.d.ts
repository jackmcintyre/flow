/**
 * Integration tests for `computeSkillEffectiveness` — Story 6.8 AC2 + AC3.
 *
 * AC2: a known distribution of `skill.invoke` + `reviewer.verdict` events yields
 *      per-skill `invoke_count`, `useful_fire_count`, and `effectiveness_ratio`
 *      that match by hand — including a skill that fired but was never followed
 *      by a READY-FOR-MERGE (ratio 0) and a skill invoked once and followed by
 *      one (ratio 1).
 * AC3: the empty-telemetry result is a documented empty shape (never an error);
 *      malformed JSONL lines are skipped + counted (`malformed_lines`); the
 *      window bounds which invocations are scored, and the result reports the
 *      `window_size` / `sample_size` actually used.
 *
 * The helper reads through injected file/dir seams (like `computeAgreement`), so
 * these tests are deterministic with no real filesystem clock.
 */
export {};
