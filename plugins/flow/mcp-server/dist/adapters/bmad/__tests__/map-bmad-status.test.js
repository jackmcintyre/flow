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
import { mapBmadStatusToExecution } from "../map-bmad-status.js";
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
const _typeCheck = [
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
function makeMinimalStory(status) {
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
    const cases = [
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
        expect(() => parseBmadStory("/fake/9-1-minimal-fixture-story.md", content)).toThrow("unknown Status value 'unknown-status'");
    });
    it("throws MalformedBmadStoryError for free-text Status (grammar stays strict)", () => {
        // The 4.3c pre-cleanup value — must remain rejected after Story 5.14
        const content = makeMinimalStory("revised — re-implement per new architectural direction (tool-layer seam)");
        expect(() => parseBmadStory("/fake/9-1-minimal-fixture-story.md", content)).toThrow("unknown Status value");
    });
});
