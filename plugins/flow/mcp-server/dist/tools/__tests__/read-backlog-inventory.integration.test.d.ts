/**
 * Integration tests for `readBacklogInventory` — Story 3.6 HIGH-1 / HIGH-3 fix.
 *
 * These tests verify that the tool:
 *   1. Scans manifests across all four state directories and returns the correct
 *      `backlog_inventory` shape the planner skill prose consumes.
 *   2. Derives `mode: "first-run"` on an empty repo and `mode: "re-open"` when
 *      at least one manifest exists.
 *   3. Includes `withdrawn` flag correctly.
 *   4. On native repos, supplements with `native-source-only` entries for ULID
 *      `.md` files that have no corresponding manifest.
 *   5. Surfaces `MalformedExecutionManifestError` verbatim on a corrupt manifest.
 *   6. Works on a BMad repo (skips native-stories scan).
 *
 * Each test operates against a copy of the committed fixture trees (or a
 * freshly-constructed tmpdir) so the committed fixtures are never mutated.
 */
export {};
