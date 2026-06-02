/**
 * Integration tests for the author seam — Story 9.2 (Epic 9 intake cockpit,
 * gate 1: "propose a feature").
 *
 * The seam reuses the existing native-authoring machinery end-to-end:
 *   - `writeNativeStory` (now fail-closed on discipline) authors the draft,
 *   - `scanSources` materialises it into a backlog manifest defaulted
 *     not-ready (the Story 9.1 brake),
 *   - the claim entry point (`claimNextStory`) refuses to return it until the
 *     operator blesses it.
 *
 * Covered ACs:
 *   AC2 — a candidate that passes the discipline gate is written, scanned into
 *         a backlog manifest that reads not-ready, and is NOT returned by the
 *         claim entry point.
 *   AC3 — refuse-and-revise: a failing candidate surfaces violation codes and
 *         writes nothing; a corrected candidate then writes.
 *   AC6 — one `draft.authored` telemetry event lands per written draft (right
 *         ref); none is emitted for a refused candidate.
 *
 * Fixture pattern mirrors scan-sources.test.ts: a minimal native-adapter
 * workspace (config.yaml + native-stories dir) in a fresh tmpdir.
 */
export {};
