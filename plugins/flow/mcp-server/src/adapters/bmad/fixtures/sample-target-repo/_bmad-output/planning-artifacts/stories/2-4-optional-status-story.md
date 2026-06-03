# Story 2.4: Optional-status story

Status: optional

## Story

As a **fixture story**,
I want **an `optional` status**,
so that **`listSourceStories` skips this entry.**

## Acceptance Criteria

**AC1:**
**Given** an `optional` source status,
**When** `listSourceStories` runs,
**Then** this story is absent from the result.
