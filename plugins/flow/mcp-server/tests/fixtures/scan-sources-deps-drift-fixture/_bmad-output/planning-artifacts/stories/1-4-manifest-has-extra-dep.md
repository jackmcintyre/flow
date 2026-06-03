# Story 1.4: Manifest has extra dep prose doesn't mention

Status: ready-for-dev

## Story

As a **fixture story**,
I want **the manifest to have more deps than prose declares**,
so that **the symmetric-drift gate fires (manifest superset of prose)**.

Depends on: bmad:1.1

## Acceptance Criteria

**AC1 (integration):**
**Given** this story has "Depends on: bmad:1.1" in prose but ## Dependencies has bmad:1.1 + bmad:1.3,
**When** scanSources is called,
**Then** bmad:1.4 is blocked with blocked_by: deps-drift (manifest is superset of prose).

## Dependencies

- bmad:1.1
- bmad:1.3

## Dev Notes

Fixture story for AC (c): prose refs {bmad:1.1}, manifest refs {bmad:1.1, bmad:1.3} → symmetric drift.
