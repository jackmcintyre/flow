# Story 2.1: State-mutating story without integration AC

Status: ready-for-dev

## Story

As a **fixture story**,
I want **to test scan-sources discipline enforcement**,
so that **scan-sources writes a blocked manifest for this story**.

## Acceptance Criteria

**AC1:**
**Given** a state-mutating story with no integration AC,
**When** scan-sources runs,
**Then** a blocked manifest is written to blocked/ (unit-tagged only).

## Dev Notes

This fixture edits scan-sources.ts and writes state to the manifest directory.
It deliberately has only unit-tagged ACs and no integration AC to trigger the
planning-discipline missing-integration-ac violation at scan time.
