/**
 * Tests for the BMad → native ingest seam — Story 10.5.
 *
 * The ingest reads the live BMad backlog (read-only), enriches each story to the
 * §3 native shape via an INJECTED stub enricher (so the gate behaviour is
 * deterministic — no live model call), gates each enriched draft on the
 * completed Tier-0 validator (Story 10.3), writes survivors to
 * `.flow/native-stories/<ULID>.md`, and returns a fix-up report for the rest.
 *
 * Coverage:
 *   AC1 — integration: enrich-or-surface, never silently drop. A signal-carrying
 *         story is written + parses + clears Tier-0; an un-enrichable story is
 *         surfaced in the fix-up report with the failed check id(s); the source
 *         BMad story is untouched; written + needs_fix_up + skipped == input.
 *   AC2 — unit: the ingest writes native files while BMad is still the active
 *         adapter (no WrongAdapterError guard); config.yaml stays adapter: bmad.
 *   AC3 — unit: one-way, non-destructive, re-run-safe. The source backlog is
 *         byte-for-byte unchanged; a re-run dedupes by provenance (skip, not a
 *         fresh ULID).
 *   AC4 — unit: enrichment is LLM-assisted but the accept/reject decision is
 *         deterministic — a hollow draft the stub produces is rejected by the
 *         Tier-0 gate, not written.
 *
 * Fixture pattern mirrors scan-sources.test.ts / write-native-story.test.ts:
 * a minimal BMad-adapter workspace in a fresh tmpdir.
 */
export {};
