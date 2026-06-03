# Story 1.2: Fixture story B

Status: ready-for-dev

## Story

As a **fixture story**,
I want **to depend on fixture story A**,
so that **the scan-sources integration test can assert depends_on is carried verbatim**.

Depends on: bmad:1.1

## Acceptance Criteria

**AC1 (integration):**
**Given** the scan-sources fixture target repo,
**When** scanSources is called,
**Then** a manifest for bmad:1.2 is created with depends_on containing bmad:1.1.

## Dependencies

- bmad:1.1

## Dev Notes

Minimal fixture story for scan-sources integration tests (Story 3.2).
Declares a dependency on bmad:1.1 to exercise the depends_on field.
