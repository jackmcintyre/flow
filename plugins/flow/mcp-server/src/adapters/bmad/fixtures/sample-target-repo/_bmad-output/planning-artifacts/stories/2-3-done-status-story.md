# Story 2.3: Done-status story

Status: done

## Story

As a **fixture story**,
I want **a `done` status**,
so that **reconciliation tests have a `done` source.**

## Acceptance Criteria

**AC1:**
**Given** the BMad source says `done`,
**When** the reconciler runs against an `in-progress` manifest,
**Then** the outcome is a `block`-severity discrepancy.
