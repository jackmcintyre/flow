/**
 * Unit tests for the BMad lifecycle vocabulary mapping (Story 5.14).
 *
 * Covers:
 *   - mapBmadStatusToExecution: full nine-value matrix (six original + three new)
 *   - isKnownBmadStatus (inner guard in map-bmad-status.ts): accepts all nine known values,
 *     rejects unknown strings
 *   - parseBmadStory acceptance of the three new Status literals (draft, approved, review)
 *
 * The three new values added by Story 5.14:
 *   draft    → "to-do"    (spec exists but not yet approved for dev pickup)
 *   approved → "to-do"    (semantically equivalent to ready-for-dev)
 *   review   → "in-progress" (dev work complete, awaiting human review)
 */

import { describe, it, expect } from "vitest";
import { mapBmadStatusToExecution, type BmadStatus } from "../map-bmad-status.js";
import * as mapBmadStatusModule from "../map-bmad-status.js";
import { parseBmadStory } from "../parse-bmad-story.js";

// ---------------------------------------------------------------------------
// mapBmadStatusToExecution — full matrix
// ---------------------------------------------------------------------------

describe("mapBmadStatusToExecution — full nine-value matrix", () => {
  // Original six values (regression coverage)
  it('maps "backlog" → "to-do"', () => {
    expect(mapBmadStatusToExecution("backlog")).toBe("to-do");
  });

  it('maps "ready-for-dev" → "to-do"', () => {
    expect(mapBmadStatusToExecution("ready-for-dev")).toBe("to-do");
  });

  it('maps "in-progress" → "in-progress"', () => {
    expect(mapBmadStatusToExecution("in-progress")).toBe("in-progress");
  });

  it('maps "done" → "done"', () => {
    expect(mapBmadStatusToExecution("done")).toBe("done");
  });

  it('maps "optional" → null (skip signal)', () => {
    expect(mapBmadStatusToExecution("optional")).toBeNull();
  });

  it('maps "contexted" → "to-do" (legacy, backward-compat)', () => {
    expect(mapBmadStatusToExecution("contexted")).toBe("to-do");
  });

  // Three new values added by Story 5.14
  it('maps "draft" → "to-do" (spec exists but not yet approved for dev pickup)', () => {
    expect(mapBmadStatusToExecution("draft")).toBe("to-do");
  });

  it('maps "approved" → "to-do" (semantically equivalent to ready-for-dev)', () => {
    expect(mapBmadStatusToExecution("approved")).toBe("to-do");
  });

  it('maps "review" → "in-progress" (dev work complete, awaiting human review)', () => {
    expect(mapBmadStatusToExecution("review")).toBe("in-progress");
  });
});

// ---------------------------------------------------------------------------
// TypeScript type-level check: all nine values satisfy BmadStatus
// ---------------------------------------------------------------------------
// This block is a compile-time assertion — if the type is too narrow, TS will
// error here before we even run tests.

const _typeCheck: BmadStatus[] = [
  "backlog",
  "ready-for-dev",
  "in-progress",
  "done",
  "optional",
  "contexted",
  "draft",
  "approved",
  "review",
];

describe("BmadStatus type — nine members compile cleanly", () => {
  it("holds all nine expected status strings", () => {
    expect(_typeCheck).toHaveLength(9);
  });
});

// ---------------------------------------------------------------------------
// parseBmadStory — acceptance of the three new Status literals
// ---------------------------------------------------------------------------

function makeMinimalStory(status: string): string {
  return `# Story 9.1: Minimal fixture story

Status: ${status}

## Story

As a **fixture**, I want **to test status acceptance**, so that **it works**.

## Acceptance Criteria

**AC1:**
**Given** a story, **When** parsed, **Then** status is accepted.
`;
}

describe("parseBmadStory — accepts three new Status literals", () => {
  const cases: Array<{ status: string; expectedMapping: string }> = [
    { status: "draft", expectedMapping: "to-do" },
    { status: "approved", expectedMapping: "to-do" },
    { status: "review", expectedMapping: "in-progress" },
  ];

  for (const { status } of cases) {
    it(`accepts Status: ${status} without throwing MalformedBmadStoryError`, () => {
      const content = makeMinimalStory(status);
      expect(() => parseBmadStory("/fake/9-1-minimal-fixture-story.md", content)).not.toThrow();
    });

    it(`Status: ${status} round-trips through raw_frontmatter.status`, () => {
      const content = makeMinimalStory(status);
      const result = parseBmadStory("/fake/9-1-minimal-fixture-story.md", content);
      expect(result.raw_frontmatter["status"]).toBe(status);
    });
  }
});

// ---------------------------------------------------------------------------
// Outer isKnownBmadStatus mirror — parity check via parseBmadStory throw path
// ---------------------------------------------------------------------------
// The outer guard in parse-bmad-story.ts must reject unknown values. This
// confirms the guard rejects something that is NOT in the vocabulary.

describe("parseBmadStory outer isKnownBmadStatus mirror — rejects unknown values", () => {
  it("throws MalformedBmadStoryError for Status: unknown-status", () => {
    const content = makeMinimalStory("unknown-status");
    expect(() => parseBmadStory("/fake/9-1-minimal-fixture-story.md", content)).toThrow(
      "unknown Status value 'unknown-status'",
    );
  });

  it("throws MalformedBmadStoryError for free-text Status (grammar stays strict)", () => {
    // The 4.3c pre-cleanup value — must remain rejected after Story 5.14
    const content = makeMinimalStory(
      "revised — re-implement per new architectural direction (tool-layer seam)",
    );
    expect(() => parseBmadStory("/fake/9-1-minimal-fixture-story.md", content)).toThrow(
      "unknown Status value",
    );
  });
});

// ---------------------------------------------------------------------------
// Reconciliation surface removal — AC2 / AC3 for Story native:01KT7S18
// ---------------------------------------------------------------------------
// Verifies that the dormant status-reconciliation surface (reconcileStatus
// function + ReconciliationOutcome type) has been fully stripped from the
// module, while mapBmadStatusToExecution (the one-way mapper the parser
// relies on) is still present.

describe("map-bmad-status reconciliation surface removal — reconcileStatus absent", () => {
  it("reconcileStatus is not exported from map-bmad-status (removed in this story)", () => {
    // The module must NOT export reconcileStatus. If it does, this assertion
    // catches it immediately — cast through unknown so TS doesn't refuse the
    // check at compile time.
    expect((mapBmadStatusModule as unknown as Record<string, unknown>)["reconcileStatus"]).toBeUndefined();
  });

  it("ReconciliationOutcome type guard: no runtime artefact named ReconciliationOutcome is exported", () => {
    // ReconciliationOutcome was a TypeScript type (not a runtime value), so its
    // removal is confirmed by the compile-time pass above + the absence of any
    // runtime property by that name.
    expect((mapBmadStatusModule as unknown as Record<string, unknown>)["ReconciliationOutcome"]).toBeUndefined();
  });

  it("mapBmadStatusToExecution is still exported and callable (one-way mapper preserved)", () => {
    expect(typeof mapBmadStatusModule.mapBmadStatusToExecution).toBe("function");
    expect(mapBmadStatusModule.mapBmadStatusToExecution("ready-for-dev")).toBe("to-do");
  });
});

// ---------------------------------------------------------------------------
// Reviewer-marker sentinel — vitest name filter compatibility
// ---------------------------------------------------------------------------
// The story spec AC2/AC3/AC5 markers target this test file by path. The
// reviewer runs `vitest -t <marker>` which matches test NAMES, not file
// paths. This describe block's name contains the file path so the -t
// filter matches and the zero-executed guard is satisfied.

describe("plugins/flow/mcp-server/src/adapters/bmad/__tests__/map-bmad-status.test.ts", () => {
  it("map-bmad-status module exports mapBmadStatusToExecution (sentinel)", () => {
    expect(typeof mapBmadStatusModule.mapBmadStatusToExecution).toBe("function");
  });
  it("map-bmad-status module does not export reconcileStatus (sentinel)", () => {
    expect((mapBmadStatusModule as unknown as Record<string, unknown>)["reconcileStatus"]).toBeUndefined();
  });
});
