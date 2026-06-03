# Story 1.10: Handle tenth story

Status: ready-for-dev

## Story

As a **fixture story**,
I want **a double-digit story number**,
so that **the ordering test confirms `1.10` follows `1.2`, not `1.1`.**

## Acceptance Criteria

**AC1:**
**Given** double-digit numbering,
**When** `listSourceStories` runs,
**Then** stories are sorted numerically.
