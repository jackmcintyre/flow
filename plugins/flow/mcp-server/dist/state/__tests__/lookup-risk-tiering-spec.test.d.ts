/**
 * Integration tests for `lookupRiskTieringSpec` — Story 4.9 Task 6.1–6.2.
 *
 * Covers AC4 cases:
 *   (4b) Shipped-default-loads case — no override present
 *   (4c) Override-wins-when-present case — both files present, override wins
 *   (4d) Malformed-override-errors-clearly case — three sub-cases
 *         (c1) missing frontmatter opener
 *         (c2) invalid change_types enum value
 *         (c3) duplicate rule ids
 *   (4e) Non-AC extras:
 *         shipped default missing → ShippedRiskTieringDefaultMissingError
 *         schema-sharing: same YAML → same parsed tiers (modulo sourcePath)
 *         rule with no signal fields → MalformedRiskTieringSpecError
 *         fallback_tier: low → MalformedRiskTieringSpecError
 *         min > max → MalformedRiskTieringSpecError
 *         empty tiers → MalformedRiskTieringSpecError
 *   (4f) Round-trip against the shipped default's literal content
 *
 * Fixture pattern: `fs.mkdtemp(path.join(os.tmpdir(), "risk-tier-"))` per
 * `beforeEach`; `fs.rm(..., { recursive: true })` in `afterEach`.
 * Files are written via `atomicWriteFile` to comply with the static
 * fs-write guard (canonical-fs-guard.test.ts AC5c). No `pluginRoot`
 * resolution via `import.meta.url`; tests pass it explicitly.
 *
 * Pure deterministic — no LLM invocation, no network.
 */
export {};
