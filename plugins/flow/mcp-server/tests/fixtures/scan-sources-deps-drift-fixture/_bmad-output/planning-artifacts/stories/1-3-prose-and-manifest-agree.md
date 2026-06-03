# Story 1.3: Prose and manifest both declare bmad:1.1

Status: ready-for-dev

## Story

As a **fixture story**,
I want **prose and manifest deps to agree**,
so that **the deps-drift gate does NOT fire**.

Depends on: bmad:1.1

## Acceptance Criteria

**AC1 (integration):**
**Given** this story has "Depends on: bmad:1.1" in prose AND bmad:1.1 in ## Dependencies,
**When** scanSources is called,
**Then** bmad:1.3 is written to to-do/ (no drift).

## Dependencies

- bmad:1.1

## Dev Notes

Fixture story for AC (b): prose and manifest agree on bmad:1.1 — no drift.
