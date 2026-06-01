/**
 * Unit tests for the per-AC `verification` directive — Story 10.1 AC2.
 *
 * `parseNativeStory` extracts the stored marker line (`vitest: <path>` or
 * `artifact: <path>`, immediately following the AC's Given/When/Then body)
 * into `verification: { type, target }`, requiring exactly one such line per
 * AC. It throws `MalformedNativeStoryError` (carrying `{ path, section,
 * reason }`) when the line is absent, when `type` is neither `vitest` nor
 * `artifact`, or when `target` is empty.
 *
 * Scope note: this story checks *presence and shape* of the line. Checking
 * that `target` *resolves to a real file* is Tier-0 check T0-6, added in
 * Story 10.3 — so a non-existent path still parses here.
 */
export {};
