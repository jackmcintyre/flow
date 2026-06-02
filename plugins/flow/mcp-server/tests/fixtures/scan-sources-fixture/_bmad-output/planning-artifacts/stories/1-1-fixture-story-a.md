# Story 1.1: Fixture story A

Status: ready-for-dev

## Story

As a **fixture story**,
I want **to be scanned into an execution manifest**,
so that **the scan-sources integration test can assert AC1 and AC2**.

## Acceptance Criteria

**AC1 (integration):**
**Given** the scan-sources fixture target repo,
**When** scanSources is called,
**Then** a manifest for bmad:1.1 is created under .crew/state/to-do/.

**AC2:**
**Given** the created manifest,
**When** the manifest is parsed,
**Then** it validates against ExecutionManifestSchema with status to-do.

## Dev Notes

Minimal fixture story for scan-sources integration tests (Story 3.2).
Two ACs: one integration, one unit.
