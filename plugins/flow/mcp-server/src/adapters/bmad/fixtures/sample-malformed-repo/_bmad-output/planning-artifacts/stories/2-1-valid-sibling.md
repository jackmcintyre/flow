# Story 2.1: Valid sibling

Status: ready-for-dev

## Story

As a **fixture story**,
I want **to be valid**,
so that **the malformed repo's `stories_root` discovery still succeeds.**

## Acceptance Criteria

**AC1:**
**Given** a valid sibling,
**When** the adapter walks the malformed repo,
**Then** at least one story parses cleanly.
