# Story 1.1: Base story (no deps)

Status: ready-for-dev

## Story

As a **fixture story**,
I want **to have no dependencies**,
so that **the deps-drift test can use this as a base story with no drift**.

## Acceptance Criteria

**AC1 (integration):**
**Given** the deps-drift fixture,
**When** scanSources is called,
**Then** bmad:1.1 is created in to-do/ with no drift.

## Dev Notes

Base fixture story with no dependencies — prose and manifest both agree on empty deps set.
