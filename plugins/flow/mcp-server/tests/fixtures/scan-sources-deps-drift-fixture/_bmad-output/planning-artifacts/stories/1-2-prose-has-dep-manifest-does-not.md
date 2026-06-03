# Story 1.2: Prose declares dep that manifest omits

Status: ready-for-dev

## Story

As a **fixture story**,
I want **to have a prose dep that the manifest does not declare**,
so that **the deps-drift gate fires on scan**.

Depends on: bmad:1.1

## Acceptance Criteria

**AC1 (integration):**
**Given** this story has a Depends-on prose line but no Dependencies section,
**When** scanSources is called,
**Then** this story is blocked with deps-drift.

## Dev Notes

Fixture for the deps-drift test: prose-only dep, no section dep.
